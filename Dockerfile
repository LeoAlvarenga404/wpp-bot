# syntax=docker/dockerfile:1.7

# ---- Stage 1: builder ----
# Installs all deps (dev + prod), compiles TypeScript -> /app/dist.
FROM node:22-alpine AS builder
WORKDIR /app

# Install build deps first so layer is cacheable when source changes.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and compile.
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Strip dev deps from node_modules so the runtime stage can copy them as-is.
RUN npm prune --omit=dev


# ---- Stage 2: runtime ----
# Minimal image: only dist + pruned node_modules. Runs as non-root `node`.
FROM node:22-alpine AS runtime
WORKDIR /app

# wget is preinstalled in alpine (busybox); used by HEALTHCHECK below.
ENV NODE_ENV=production \
    PORT=3000

# Copy compiled output + production node_modules from builder.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

# Persistent data dirs (Baileys auth, posted-log cache). Compose mounts override these.
RUN mkdir -p /app/auth_info /app/data && chown -R node:node /app/auth_info /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --spider -q http://localhost:3000/wa/health || exit 1

CMD ["node", "dist/main.js"]
