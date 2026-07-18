import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev proxy: the SPA is served by Vite on :5173 but talks to the NestJS API.
// VITE_API_PROXY overrides the target (e.g. http://localhost:3001 when the
// bot runs in Docker with the remapped host port). In production there is no
// proxy — Nest serves the built SPA from the same origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/approval': process.env.VITE_API_PROXY ?? 'http://localhost:3333',
    },
  },
});
