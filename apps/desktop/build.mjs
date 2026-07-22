import { build } from 'esbuild';

/**
 * Electron 메인/프리로드 번들.
 *
 * 서버 코드(`@yulyrics/*`)와 의존성(fastify, ws)을 **전부 한 파일에 넣는다.**
 * 워크스페이스는 node_modules 를 루트로 끌어올리므로, 외부 참조로 남기면
 * 패키징된 앱에서 모듈을 못 찾는 일이 생긴다. 번들해두면 그 문제가 아예 없다.
 *
 * `electron` 만 외부로 둔다 (런타임이 제공한다).
 */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  // Electron 메인은 CJS 가 가장 말썽이 적다
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
});

await build({
  ...common,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
});
