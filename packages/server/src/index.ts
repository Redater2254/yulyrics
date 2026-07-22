/**
 * 라이브러리 진입점 — **부수효과가 없어야 한다.**
 *
 * Electron 셸이 이 모듈을 import 하므로, 여기서 서버를 자동으로 띄우면
 * 셸이 포트를 알기도 전에 서버가 시작돼 버린다.
 * 실제로 띄우는 것은 `cli.ts`(CLI) 와 Electron 메인의 몫이다.
 */
export { startServer } from './server.js';
export type { ServerHandle } from './server.js';
export { Hub } from './hub.js';
