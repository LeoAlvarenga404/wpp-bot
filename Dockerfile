# syntax=docker/dockerfile:1.7

# ---- Stage 1: builder ----
# Debian-based image (NOT alpine) because Playwright Chromium requires glibc
# and the bundled .so deps shipped by `npx playwright install --with-deps`
# are not packaged for Alpine.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install build deps first so layer is cacheable when source changes.
COPY package.json package-lock.json* ./
RUN npm ci

# Prisma schema + generated client must exist before TypeScript compile,
# because PrismaService imports `@prisma/client`. Copying the schema in a
# dedicated layer keeps client-generation cached when only src/ changes.
COPY prisma ./prisma
RUN npx prisma generate

# Copy source and compile.
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Strip dev deps from node_modules so the runtime stage can copy them as-is.
# `prisma` (the CLI) is a devDependency in package.json but the runtime
# entrypoint needs it to run `prisma migrate deploy` on boot — reinstall it
# in production scope so it survives the prune.
RUN npm prune --omit=dev && npm install --omit=dev prisma


# ---- Stage 2: runtime ----
# Bookworm-slim runtime + Chromium installed under /ms-playwright so the
# Playwright affiliate adapter can launch a headless browser inside the
# container. PLAYWRIGHT_BROWSERS_PATH pins the cache location used by
# `playwright install` here (otherwise it lands in ~/.cache/ms-playwright,
# which our non-root `node` user can write but isn't visible across stages).
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# wget for HEALTHCHECK + Playwright system deps for Chromium. `--with-deps`
# pulls roughly the same package set as Playwright's official install script
# (fonts, libnss3, libxkbcommon, libdrm, libasound2, etc.).
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled output + production node_modules from builder.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json
# Prisma schema is needed at runtime so `prisma migrate deploy` (run by the
# entrypoint) can find migrations and the datasource block.
COPY --from=builder --chown=node:node /app/prisma ./prisma

# Install Chromium + its system deps. Run as root, then chown the cache so
# the non-root `node` user can read the browser binary.
RUN npx playwright install --with-deps chromium \
    && chown -R node:node /ms-playwright

# Entrypoint runs `prisma migrate deploy` before booting the Nest app so a
# fresh database is migrated automatically on container start.
COPY --chown=node:node scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Persistent data dirs (Baileys auth, posted-log cache). Compose mounts override these.
RUN mkdir -p /app/auth_info /app/data && chown -R node:node /app/auth_info /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --spider -q http://localhost:3000/wa/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/main.js"]
