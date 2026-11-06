import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 1500, sourcemap: false },
  server: { host: '127.0.0.1', port: 5173 },
  esbuild: { target: 'es2022' },
});
