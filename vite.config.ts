import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Three.js alone is ~550 kB, so the default 500 kB warning always fires.
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
