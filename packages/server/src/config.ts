import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { configPath, dataDir, ensureDir } from './paths.js';

/**
 * 전역 단축키. Electron accelerator 문법을 그대로 쓴다.
 * 빈 문자열이면 그 동작에는 단축키를 걸지 않는다.
 *
 * 데스크톱 앱에서만 의미가 있다 — 브라우저에서는 전역 단축키를 등록할 방법이 없다.
 */
export interface Hotkeys {
  next: string;
  nextAlt: string;
  prev: string;
  prevAlt: string;
  reset: string;
  toggleHide: string;
}

export interface AppConfig {
  /** 기본 포트. 사용 중이면 서버가 다음 번호로 자동 이동한다. */
  port: number;
  /** true 면 0.0.0.0 바인딩 — 같은 네트워크의 다른 PC OBS 에서 받을 수 있다. */
  lan: boolean;
  /** LAN 모드에서 오버레이/WS 접근에 요구되는 토큰 */
  token: string;
  /** 모든 곡에 공통 적용되는 지연 보정(ms) */
  globalOffsetMs: number;
  hotkeys: Hotkeys;
  /** 창을 닫으면 트레이로 내려가고 백그라운드 유지 */
  minimizeToTray: boolean;
}

/**
 * 기본 단축키.
 *
 * 앞으로는 `Ctrl+Space`, 뒤로는 **거기에 Alt 를 더한** `Ctrl+Alt+Space` 다.
 * (`Ctrl+Alt` 만으로는 등록할 수 없다 — 수식키뿐인 조합은 OS 가 단축키로 받지 않는다)
 * 방향키 조합도 함께 걸어둔다.
 */
export const DEFAULT_HOTKEYS: Hotkeys = {
  next: 'CommandOrControl+Space',
  nextAlt: 'CommandOrControl+Right',
  prev: 'CommandOrControl+Alt+Space',
  prevAlt: 'CommandOrControl+Left',
  reset: '',
  toggleHide: '',
};

/**
 * 예전 기본값. 사용자가 손대지 않은 설정만 새 기본값으로 옮기기 위해 남겨둔다.
 * 직접 바꾼 단축키를 업데이트가 멋대로 되돌리면 안 된다.
 */
const LEGACY_DEFAULT_HOTKEYS: Partial<Hotkeys>[] = [
  {
    next: 'CommandOrControl+Space',
    nextAlt: 'CommandOrControl+Right',
    prev: 'CommandOrControl+Left',
  },
];

function migrateHotkeys(stored: Partial<Hotkeys> | undefined): Hotkeys {
  if (!stored) return { ...DEFAULT_HOTKEYS };

  const untouched = LEGACY_DEFAULT_HOTKEYS.some((legacy) =>
    Object.entries(legacy).every(([key, value]) => stored[key as keyof Hotkeys] === value),
  );
  if (untouched) return { ...DEFAULT_HOTKEYS };

  return { ...DEFAULT_HOTKEYS, ...stored };
}

const DEFAULTS: Omit<AppConfig, 'token'> = {
  port: 7788,
  lan: false,
  globalOffsetMs: 0,
  hotkeys: DEFAULT_HOTKEYS,
  minimizeToTray: true,
};

type ConfigListener = (config: AppConfig) => void;
const listeners = new Set<ConfigListener>();

/**
 * 설정 변경 구독.
 * Electron 메인 프로세스가 이걸로 단축키를 다시 등록한다 —
 * 서버와 같은 프로세스에서 도니 폴링할 이유가 없다.
 */
export function onConfigChange(fn: ConfigListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  ensureDir(dataDir());

  let stored: Partial<AppConfig> = {};
  try {
    stored = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<AppConfig>;
  } catch {
    // 최초 실행이거나 파일이 깨졌다. 어느 쪽이든 기본값으로 새로 만든다.
  }

  cached = {
    ...DEFAULTS,
    ...stored,
    hotkeys: migrateHotkeys(stored.hotkeys),
    token: stored.token ?? randomBytes(8).toString('hex').toUpperCase(),
  };

  saveConfig(cached);
  return cached;
}

export function saveConfig(config: AppConfig): void {
  ensureDir(dataDir());
  writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
  cached = config;
  for (const fn of listeners) {
    try {
      fn(config);
    } catch (err) {
      // 구독자 하나가 터져도 나머지에는 알려야 한다
      console.warn('[yulyrics] 설정 변경 처리 실패', err);
    }
  }
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}
