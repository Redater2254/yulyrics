import { contextBridge, ipcRenderer } from 'electron';

/**
 * 컨트롤 패널은 브라우저에서도, 데스크톱 앱에서도 열린다.
 *
 * 전역 단축키 설정과 창 조작(최소화·최대화·닫기)은 데스크톱에서만 의미가 있으므로,
 * 페이지가 지금 어디서 돌고 있는지 알 수 있어야 한다.
 * 동작하지 않는 UI 를 브라우저에서 보여주는 것보다 아예 숨기는 편이 낫다.
 */
contextBridge.exposeInMainWorld('yulyricsDesktop', {
  version: process.versions.electron,
  platform: process.platform,

  // 기본 타이틀바를 없앴으므로 창 조작 수단을 페이지에 넘겨줘야 한다
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),

  /** 최대화 상태가 바뀌면 알려준다 (버튼 아이콘 전환용) */
  onMaximizeChange: (fn: (maximized: boolean) => void) => {
    ipcRenderer.on('window:maximized', (_event, maximized: boolean) => fn(maximized));
  },
});
