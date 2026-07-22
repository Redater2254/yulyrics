import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';

const resolveSrc = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: '/',
  resolve: {
    alias: {
      '@yulyrics/core': resolveSrc('../../packages/core/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
  },
});
