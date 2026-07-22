/**
 * CLI 진입점 — `npm start` 로 서버만 띄울 때 쓴다.
 *
 * Electron 셸은 이 파일을 거치지 않고 `startServer()` 를 직접 부른다.
 */
import { startServer } from './server.js';

export { startServer } from './server.js';
export type { ServerHandle } from './server.js';

const handle = await startServer();

console.log('');
console.log('  yulyrics 실행 중');
console.log(`  컨트롤 패널   ${handle.urls.control}`);
console.log(`  OBS 오버레이  ${handle.urls.overlay}`);
if (handle.urls.lan) console.log(`  LAN 오버레이  ${handle.urls.lan}`);
console.log('');
console.log('  OBS → 소스 추가 → 브라우저 → 위 오버레이 URL, 너비 1920 / 높이 1080');
console.log('');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void handle.close().then(() => process.exit(0));
  });
}
