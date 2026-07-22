import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  shell,
} from 'electron';

import type { ServerHandle } from '@yulyrics/server';
import { startServer } from '@yulyrics/server';
import type { AppConfig, Hotkeys } from '@yulyrics/server/config';
import { loadConfig, onConfigChange } from '@yulyrics/server/config';
import type { HotkeyStatus } from '@yulyrics/server/desktop';
import { setDesktopStatus } from '@yulyrics/server/desktop';
import { setAppRoot, setDataDir } from '@yulyrics/server/paths';

/**
 * yulyrics 데스크톱 셸.
 *
 * 하는 일은 세 가지뿐이다.
 *   1. 기존 로컬 서버를 그대로 띄운다 (서버 코드는 손대지 않는다)
 *   2. 컨트롤 패널을 창으로 띄우고, 닫아도 트레이에 상주시킨다
 *   3. 전역 단축키를 걸어 **OBS를 보고 있어도** 줄을 넘길 수 있게 한다
 *
 * 3번이 이 셸의 존재 이유다. 브라우저 안에서는 전역 단축키를 만들 방법이 없다.
 */

/**
 * 앱 리소스 경로.
 * `import.meta.url` 은 CJS 로 번들되면 사라지므로 Electron 이 주는 경로를 쓴다.
 * 개발 실행과 asar 패키징 양쪽에서 같은 값을 준다.
 */
const resource = (...parts: string[]): string => join(app.getAppPath(), ...parts);

let server: ServerHandle | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 트레이에서 「종료」를 눌렀는가 — 창 닫기와 진짜 종료를 구분한다 */
let quitting = false;

/*
 * 앱 이름과 저장 경로를 먼저 못 박는다.
 *
 * Electron 은 package.json 의 `name` 으로 저장 폴더를 정하는데,
 * 이 패키지 이름이 `@yulyrics/desktop` 이라 슬래시가 경로로 해석되어
 * `%APPDATA%\@yulyrics\desktop\` 같은 중첩 폴더가 만들어졌다.
 * 사용자가 찾을 수도 없고 지우기도 애매한 자리다.
 *
 * whenReady 전에 해야 Chromium 캐시까지 같은 폴더 아래로 들어간다.
 */
app.setName('yulyrics');
app.setPath('userData', join(app.getPath('appData'), 'yulyrics'));

// 두 번 실행되면 서버 포트가 어긋나 조용히 이상해진다. 한 번만 돌게 막는다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => showWindow());

// ---------------------------------------------------------------------------
// 창
// ---------------------------------------------------------------------------

function createWindow(url: string): BrowserWindow {
  const window = new BrowserWindow({
    // 좌측 설정 열과 우측 작업 열이 동시에 다 보여야 하는 크기.
    // 이보다 작아지면 열마다 따로 스크롤된다 (페이지 전체가 스크롤되지는 않는다)
    width: 1520,
    height: 1000,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#14161a',
    title: 'yulyrics',
    icon: resource('assets', 'icon.png'),
    autoHideMenuBar: true,
    // 기본 타이틀바를 없애고 앱 헤더를 그대로 타이틀바로 쓴다.
    // (창 조작 버튼은 페이지가 그리고, IPC 로 넘어온다)
    frame: false,
    webPreferences: {
      preload: resource('dist', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void window.loadURL(url);

  // 외부 링크는 앱 안에서 열지 않는다
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  // 최대화 여부를 페이지에 알려 버튼 아이콘을 맞춘다
  const reportMaximized = (): void =>
    window.webContents.send('window:maximized', window.isMaximized());
  window.on('maximize', reportMaximized);
  window.on('unmaximize', reportMaximized);
  window.webContents.on('did-finish-load', reportMaximized);

  window.on('close', (event) => {
    // 닫기 = 종료가 아니다. 방송 중에 창을 정리했다고 단축키까지 죽으면 곤란하다.
    if (quitting || !loadConfig().minimizeToTray) return;
    event.preventDefault();
    window.hide();
  });

  return window;
}

// 기본 타이틀바가 없으므로 창 조작은 페이지가 요청한다
ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', () => win?.close());

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------------------
// 트레이
// ---------------------------------------------------------------------------

/** 아이콘이 없어도 트레이는 떠야 한다 — 없으면 OS 기본 아이콘이 붙는다 */
function trayIcon() {
  const icon = nativeImage.createFromPath(resource('assets', 'tray.png'));
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

function buildTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip('yulyrics — 가사 오버레이');
  refreshTrayMenu();
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const keys = loadConfig().hotkeys;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'yulyrics 열기', click: () => showWindow() },
      { type: 'separator' },
      { label: `다음 줄  ${keys.next || '(없음)'}`, click: () => trigger('/api/cursor/next') },
      { label: `이전 줄  ${keys.prev || '(없음)'}`, click: () => trigger('/api/cursor/prev') },
      { label: '처음으로', click: () => trigger('/api/cursor/reset') },
      { type: 'separator' },
      {
        label: '종료',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// 전역 단축키
// ---------------------------------------------------------------------------

/**
 * 단축키가 눌리면 HTTP 로 자기 자신을 호출한다.
 *
 * hub 를 직접 부를 수도 있지만, 그러면 조작 경로가 둘로 갈라진다.
 * 스트림덱·컨트롤 패널·단축키가 **모두 같은 엔드포인트**를 지나가야
 * "단축키로는 되는데 버튼으로는 안 된다" 같은 문제가 생기지 않는다.
 */
function trigger(path: string): void {
  if (!server) return;
  fetch(`http://127.0.0.1:${server.port}${path}`).catch((err) => {
    console.warn('[yulyrics] 단축키 처리 실패', path, err);
  });
}

const HOTKEY_ACTIONS: { key: keyof Hotkeys; label: string; path: string }[] = [
  { key: 'next', label: '다음 줄', path: '/api/cursor/next' },
  { key: 'nextAlt', label: '다음 줄(보조)', path: '/api/cursor/next' },
  { key: 'prev', label: '이전 줄', path: '/api/cursor/prev' },
  { key: 'prevAlt', label: '이전 줄(보조)', path: '/api/cursor/prev' },
  { key: 'reset', label: '처음으로', path: '/api/cursor/reset' },
  { key: 'toggleHide', label: '가사 숨김 전환', path: '/api/state/hidden/toggle' },
];

function registerHotkeys(config: AppConfig): void {
  globalShortcut.unregisterAll();

  const results: HotkeyStatus[] = [];
  const used = new Set<string>();

  for (const action of HOTKEY_ACTIONS) {
    const accelerator = (config.hotkeys[action.key] ?? '').trim();
    if (!accelerator) continue;

    // 같은 조합을 두 동작에 걸면 나중 것이 조용히 무시된다. 먼저 걸린 쪽을 남긴다.
    if (used.has(accelerator)) {
      results.push({ action: action.label, accelerator, registered: false });
      continue;
    }

    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => trigger(action.path));
    } catch {
      // 문법이 틀린 accelerator 는 예외를 던진다
      ok = false;
    }
    if (ok) used.add(accelerator);
    results.push({ action: action.label, accelerator, registered: ok });
  }

  // 등록은 조용히 실패한다. 결과를 서버에 넘겨 컨트롤 패널이 알려주게 한다.
  setDesktopStatus({ present: true, hotkeys: results });
  refreshTrayMenu();
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

/** exe 옆 저장을 켤 때 사용자가 직접 만드는 폴더 이름 */
const PORTABLE_DATA_DIR = 'yulyrics-data';

/**
 * 곡·프리셋·설정을 어디에 둘지 정한다.
 *
 * 기본은 **OS 표준 위치**(`%APPDATA%/yulyrics`)다.
 * 포터블 exe 라고 해서 exe 옆에 폴더를 만들면 안 된다 —
 * 바탕화면에서 실행하면 바탕화면에 폴더가 생기고, OneDrive 동기화 폴더라면
 * 설정 파일이 클라우드로 올라가 버린다. 사용자가 원한 적 없는 부작용이다.
 *
 * exe 옆에 두고 싶은 사람(USB 등)은 exe 옆에 `yulyrics-data` 폴더를
 * **직접 만들어두면** 그때만 그쪽을 쓴다. 없는 폴더를 앱이 알아서 만들지는 않는다.
 */
function resolveDataDir(root: string): string {
  if (!app.isPackaged) {
    // 개발 중에는 리포지토리의 userdata/ 를 그대로 쓴다.
    // 안 그러면 `npm start` 로 만든 곡이 데스크톱 앱에서 안 보여 혼란스럽다.
    return join(root, 'userdata');
  }

  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    const candidate = join(portableDir, PORTABLE_DATA_DIR);
    try {
      // 이미 있을 때만 쓴다. 만들지 않는다.
      if (statSync(candidate).isDirectory()) {
        accessSync(candidate, constants.W_OK);
        return candidate;
      }
    } catch {
      // 폴더가 없거나 쓸 수 없다 — 표준 위치를 쓴다
    }
  }

  return app.getPath('userData');
}

app.whenReady().then(async () => {
  // 서버가 리소스를 어디서 찾아야 하는지 알려준다.
  // 패키징하면 오버레이·컨트롤 빌드와 폰트가 resources/app 아래로 들어간다.
  /*
   * 오버레이·컨트롤 빌드와 폰트는 resources/web 아래로 들어간다 (package.json 의 extraResources).
   *
   * 폴더 이름을 'app' 으로 바꾸면 안 된다 —
   * Electron 은 resources/app 폴더가 있으면 app.asar 보다 **그쪽을 먼저** 앱 소스로 로드한다.
   * 정적 파일만 든 폴더를 앱으로 실행하려다 패키징본이 통째로 죽는다.
   */
  const root = app.isPackaged ? join(process.resourcesPath, 'web') : resource('..', '..');
  setAppRoot(root);
  setDataDir(resolveDataDir(root));

  try {
    server = await startServer();
  } catch (err) {
    dialog.showErrorBox(
      'yulyrics 시작 실패',
      `로컬 서버를 띄우지 못했습니다.\n\n${String(err)}`,
    );
    app.quit();
    return;
  }

  buildTray();
  registerHotkeys(loadConfig());
  onConfigChange((config) => registerHotkeys(config));

  win = createWindow(server.urls.control);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) {
      win = createWindow(server.urls.control);
    } else {
      showWindow();
    }
  });
});

// 트레이 상주가 목적이므로 창이 다 닫혀도 종료하지 않는다 (macOS 기본 동작과 같다)
app.on('window-all-closed', () => {
  if (!loadConfig().minimizeToTray) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  void server?.close();
});
