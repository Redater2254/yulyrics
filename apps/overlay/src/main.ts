import type { OverlayLayer, OverlayState, Preset, ServerMessage } from '@yulyrics/core';
import { MediaClock, normalizePreset } from '@yulyrics/core';
import { LyricsRenderer } from '@yulyrics/renderer';

/**
 * OBS 브라우저 소스가 로드하는 페이지.
 *
 * 이 페이지는 상태를 만들지 않는다 — 서버가 보내주는 것을 그리기만 한다.
 * 끊기면 알아서 다시 붙고, 붙는 동안에도 마지막 상태를 계속 렌더링한다.
 * (방송 중에 재연결 때문에 가사가 사라지면 안 된다)
 */

const params = new URLSearchParams(location.search);

/**
 * OBS 브라우저 소스는 페이지에 `window.obsstudio` 를 주입한다.
 *
 * 함수로 둔 이유: 주입 시점이 스크립트 실행보다 늦을 수 있다.
 * 모듈 최상단에서 한 번 읽고 끝내면 그 순간에 아직 없을 때 영영 false 로 굳는다.
 */
const detectObs = (): boolean =>
  typeof (window as unknown as { obsstudio?: unknown }).obsstudio !== 'undefined';

const inObs = detectObs();

/** 컨트롤 패널이 iframe 으로 끼워 넣은 미리보기인가 */
const isPreview = params.get('preview') === '1';

const options = {
  presetId: params.get('preset'),
  layer: (params.get('layer') ?? 'lyrics') as OverlayLayer,
  token: params.get('token') ?? '',
  /** 가사를 이만큼 앞당긴다(ms). 양수 = 더 빨리 나온다. */
  offsetMs: Number(params.get('offset') ?? '0') || 0,
  /**
   * 배경 체커보드 + 상태 표시.
   *
   * OBS 안에서는 URL 에 ?debug=1 이 붙어 있어도 **무조건 끈다.**
   * 이건 개발자가 브라우저에서 투명 여부를 눈으로 확인하려고 만든 것이라,
   * 실수로 방송에 나가면 회색 격자가 그대로 송출된다.
   * 디버그 파라미터가 붙은 URL을 복사해 쓰는 일은 충분히 흔하다.
   */
  // 미리보기는 항상 체커보드를 깔아 "여기는 투명하다"를 보여준다
  debug: (params.get('debug') === '1' || isPreview) && !inObs,
};

if (options.debug) document.body.classList.add('yl-debug');

const rootEl = document.getElementById('yl-root')!;
const statusEl = document.getElementById('yl-status')!;

const clock = new MediaClock();
let renderer: LyricsRenderer | null = null;
let currentPresetId: string | null = null;

// ---------------------------------------------------------------------------
// 상태 반영
// ---------------------------------------------------------------------------

function applyPreset(raw: Preset): void {
  const preset = normalizePreset(raw);
  if (!renderer) {
    renderer = new LyricsRenderer(rootEl, preset);
    currentPresetId = preset.id;
    return;
  }
  // 같은 프리셋의 값 변경(에디터 미리보기)도 setPreset 으로 흘려보낸다
  renderer.setPreset(preset);
  currentPresetId = preset.id;
}

function applyState(state: Partial<OverlayState>): void {
  if (state.preset) applyPreset(state.preset);
  if (renderer) {
    // 순서가 중요하다: 모드/프로젝트를 먼저 반영해야 cursor 가 올바른 범위로 잘린다
    if (state.mode !== undefined) renderer.setMode(state.mode);
    if (state.project !== undefined) renderer.setProject(state.project);
    if (state.cursor !== undefined) renderer.setCursor(state.cursor);
    if (state.hidden !== undefined) renderer.setHidden(state.hidden);
  }
  if (state.mediaTimeMs !== undefined && state.serverTs !== undefined) {
    clock.sync(state.mediaTimeMs, state.serverTs, state.playing ?? false, state.rate ?? 1);
  }
  render();
}

/**
 * 한 프레임 그린다.
 *
 * rAF 루프와 WS 수신 양쪽에서 호출한다.
 * 브라우저는 백그라운드 탭의 rAF 를 멈추므로 rAF 에만 의존하면
 * (OBS 가 아닌) 일반 브라우저 탭에서 미리 볼 때 화면이 굳는다.
 * 서버 틱(200ms)으로도 그려 두면 최소한의 갱신은 항상 보장된다.
 */
function render(): void {
  if (renderer) renderer.frame(clock.now() + options.offsetMs);
}

// ---------------------------------------------------------------------------
// WebSocket (자동 재연결)
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let reconnectDelay = 500;
let reconnectTimer: number | null = null;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ layer: options.layer });
  if (options.presetId) qs.set('preset', options.presetId);
  if (options.token) qs.set('token', options.token);
  return `${proto}//${location.host}/ws?${qs.toString()}`;
}

function showStatus(message: string | null): void {
  if (message === null) {
    statusEl.style.display = 'none';
    return;
  }
  // 방송 화면을 가리지 않도록, 문제 상황에서만 그것도 작게 띄운다
  statusEl.textContent = message;
  statusEl.style.display = options.debug ? 'block' : 'none';
}

function connect(): void {
  socket = new WebSocket(wsUrl());

  socket.addEventListener('open', () => {
    reconnectDelay = 500;
    showStatus(null);
    socket?.send(
      JSON.stringify({
        t: 'identify',
        role: isPreview ? 'preview' : 'overlay',
        layer: options.layer,
        // 접속 시점에 다시 본다 (로드 직후엔 아직 주입 전일 수 있다)
        inObs: inObs || detectObs(),
        ...(options.presetId ? { presetId: options.presetId } : {}),
      }),
    );
  });

  socket.addEventListener('message', (event) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data as string) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.t) {
      case 'hello':
        applyState(msg.state);
        break;
      case 'patch':
        applyState(msg.state);
        break;
      case 'tick':
        clock.sync(msg.mediaTimeMs, msg.serverTs, msg.playing);
        render();
        break;
      case 'error':
        showStatus(msg.message);
        break;
      case 'peers':
        break;
    }
  });

  socket.addEventListener('close', () => {
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    showStatus('서버 연결 끊김 — 재연결 중');
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  showStatus(`서버 연결 끊김 — ${Math.round(reconnectDelay / 100) / 10}초 후 재시도`);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.6, 5000);
}

// ---------------------------------------------------------------------------
// 렌더 루프
// ---------------------------------------------------------------------------

function loop(): void {
  render();
  requestAnimationFrame(loop);
}

connect();
requestAnimationFrame(loop);

// 디버그용 — 콘솔에서 현재 프리셋 확인
Object.assign(window, {
  yulyrics: {
    get presetId() {
      return currentPresetId;
    },
    get time() {
      return clock.now();
    },
  },
});
