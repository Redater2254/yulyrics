import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';

const resolveSrc = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // 반드시 절대 경로여야 한다.
  // './' 로 두면 슬래시 없는 /overlay 에서 ./overlay.js 가 /overlay.js 로 풀려 404 가 난다.
  // OBS 에 넣는 URL 을 짧게(/overlay) 유지하려면 base 를 마운트 경로로 고정한다.
  base: '/overlay/',
  resolve: {
    alias: {
      '@yulyrics/core': resolveSrc('../../packages/core/src/index.ts'),
      '@yulyrics/renderer': resolveSrc('../../packages/renderer/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110', // OBS 30+ 의 CEF 기준
    // 오버레이는 파일 하나로 떨어지는 편이 로딩이 빠르고 디버깅도 쉽다
    rollupOptions: {
      output: {
        entryFileNames: 'overlay.js',
        assetFileNames: 'overlay.[ext]',
      },
    },
  },
});
