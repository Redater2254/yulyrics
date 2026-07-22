import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * 경로는 **import 시점에 고정하지 않는다.**
 *
 * 개발 중에는 리포지토리 안에서 돌지만, Electron 으로 패키징하면
 * 리소스가 전혀 다른 위치로 간다. 모듈 로드 시점에 상수로 굳혀두면
 * 셸이 위치를 알려줄 기회 자체가 없어진다.
 * (esbuild 로 CJS 번들하면 `import.meta.url` 이 비어버리는 문제도 함께 피한다)
 */

let rootOverride: string | null = null;
let dataOverride: string | null = null;

/** Electron 셸이 시작할 때 실제 위치를 알려준다 */
export function setAppRoot(dir: string): void {
  rootOverride = resolve(dir);
}

export function setDataDir(dir: string): void {
  dataOverride = resolve(dir);
}

/** 정적 리소스(오버레이·컨트롤 빌드, 번들 폰트)가 놓인 최상위 경로 */
export function appRoot(): string {
  if (rootOverride) return rootOverride;
  if (process.env.YULYRICS_ROOT) return resolve(process.env.YULYRICS_ROOT);

  // 개발 실행: 이 파일은 packages/server/src/ 에 있다
  const here = currentDir();
  return here ? resolve(here, '..', '..', '..') : process.cwd();
}

/** ESM(개발)과 CJS 번들(Electron) 양쪽에서 동작하는 현재 디렉터리 */
function currentDir(): string | null {
  // CJS 번들이면 __dirname 이 있다
  if (typeof __dirname === 'string') return __dirname;
  try {
    return dirname(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } catch {
    return null;
  }
}

/**
 * 사용자 데이터 위치.
 *  - 개발 중        : <repo>/userdata      (.gitignore 처리됨)
 *  - Electron       : 셸이 app.getPath('userData') 로 지정
 *  - 그 외 production: %APPDATA%/yulyrics
 */
export function dataDir(): string {
  if (dataOverride) return dataOverride;
  if (process.env.YULYRICS_DATA) return resolve(process.env.YULYRICS_DATA);

  if (process.env.NODE_ENV === 'production') {
    const appData =
      process.env.APPDATA ??
      (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : join(homedir(), '.config'));
    return join(appData, 'yulyrics');
  }

  return join(appRoot(), 'userdata');
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export const presetsDir = (): string => join(dataDir(), 'presets');
export const projectsDir = (): string => join(dataDir(), 'projects');
export const configPath = (): string => join(dataDir(), 'config.json');

/** 빌드된 프런트엔드 */
export const overlayDist = (): string => join(appRoot(), 'apps', 'overlay', 'dist');
export const controlDist = (): string => join(appRoot(), 'apps', 'control', 'dist');

/** 번들 폰트 (OFL 만 들어간다 — packages/presets/src/fonts.ts 참고) */
export const bundledFontsDir = (): string => join(appRoot(), 'packages', 'presets', 'fonts');
