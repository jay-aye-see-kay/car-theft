import { readdirSync } from 'node:fs';
import { defineConfig } from 'vite';

// The gallery plus one page per lab: every folder in labs/ with an index.html.
const labs = readdirSync('labs', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => [d.name, `labs/${d.name}/index.html`]);

export default defineConfig({
  base: './',
  // Three.js alone is ~550 kB, so the default 500 kB warning always fires.
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { index: 'index.html', ...Object.fromEntries(labs) } },
  },
});
