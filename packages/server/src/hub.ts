import type {
  ClientMessage,
  OverlayLayer,
  OverlayState,
  PlaybackMode,
  Preset,
  Project,
  ServerMessage,
} from '@yulyrics/core';
import { clampCursor } from '@yulyrics/core';
import type { WebSocket } from 'ws';

import { loadConfig } from './config.js';
import { DEMO_LOOP_MS, DEMO_PROJECT } from './demo.js';
import { getPreset, listPresets } from './store.js';

/** 시계 보정용 하트비트 주기 */
const TICK_INTERVAL_MS = 200;

/**
 * 죽은 연결 회수 주기.
 *
 * 탭이 강제 종료되거나 OBS가 죽으면 close 이벤트가 오지 않아 소켓이 그대로 남는다.
 * 그러면 "OBS 1개 연결됨" 배지가 거짓말을 하게 되는데,
 * 진단하려고 만든 표시가 거짓말을 하면 없느니만 못하다.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

interface Client {
  socket: WebSocket;
  id: string;
  role: 'overlay' | 'control' | 'preview' | 'unknown';
  layer: OverlayLayer;
  /** 오버레이가 URL 로 프리셋을 고정했다면 그 ID */
  pinnedPresetId: string | null;
  /** OBS 브라우저 소스에서 열렸는가 */
  inObs: boolean;
  /** 직전 하트비트에 응답했는가 */
  alive: boolean;
  /** 진단용 — 왜 OBS 로 잡혔는지/안 잡혔는지 확인할 때 쓴다 */
  userAgent: string;
}

export interface ConnectedOverlay {
  id: string;
  inObs: boolean;
  layer: OverlayLayer;
  presetId: string | null;
  /** 앞부분만 (전체는 길고 쓸모없다) */
  userAgent: string;
}

/**
 * 서버 상태 허브.
 *
 * 컨트롤 패널이 진실의 원천(재생 위치)이고, 허브는 그것을 모든 오버레이에 퍼뜨린다.
 * 오버레이는 절대 상태를 바꾸지 않는다 — 읽기 전용 구독자다.
 */
export class Hub {
  private clients = new Map<string, Client>();
  private nextId = 1;
  private tickTimer: NodeJS.Timeout | null = null;

  /** 데모 자체 재생용. 실제 곡은 컨트롤 패널이 시간을 보고한다. */
  private demoStartedAt: number | null = null;

  private state: OverlayState;
  /** 프리셋 에디터가 밀어넣은 미저장 프리셋 (있으면 이게 이긴다) */
  private previewPreset: Preset | null = null;

  private heartbeatTimer: NodeJS.Timeout;

  constructor() {
    this.heartbeatTimer = setInterval(() => this.reapDeadClients(), HEARTBEAT_INTERVAL_MS);
    const presets = listPresets();
    const fallback = presets[0]!;
    this.state = {
      project: DEMO_PROJECT,
      preset: getPreset(DEMO_PROJECT.presetId) ?? fallback,
      mode: DEMO_PROJECT.mode,
      cursor: -1,
      playing: false,
      mediaTimeMs: 0,
      serverTs: Date.now(),
      rate: 1,
      hidden: false,
    };
  }

  // -------------------------------------------------------------------------
  // 연결 관리
  // -------------------------------------------------------------------------

  addClient(
    socket: WebSocket,
    pinnedPresetId: string | null,
    layer: OverlayLayer,
    /** 서버가 User-Agent 로 판단한 값. 페이지 스크립트보다 신뢰할 수 있다. */
    inObsByUserAgent = false,
    userAgent = '',
  ): string {
    const id = `c${this.nextId++}`;
    this.clients.set(id, {
      socket,
      id,
      role: 'unknown',
      layer,
      pinnedPresetId,
      inObs: inObsByUserAgent,
      alive: true,
      userAgent,
    });

    socket.on('pong', () => {
      const client = this.clients.get(id);
      if (client) client.alive = true;
    });

    this.send(socket, { t: 'hello', state: this.stateFor(pinnedPresetId), clientId: id });

    socket.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return; // 깨진 메시지는 조용히 버린다
      }
      this.handleMessage(id, msg);
    });

    socket.on('close', () => {
      this.clients.delete(id);
      this.broadcastPeers();
    });

    socket.on('error', () => {
      this.clients.delete(id);
      this.broadcastPeers();
    });

    this.broadcastPeers();
    return id;
  }

  get peerCounts(): { overlays: number; controls: number; obsOverlays: number } {
    let overlays = 0;
    let controls = 0;
    let obsOverlays = 0;
    for (const c of this.clients.values()) {
      if (c.role === 'overlay') {
        overlays++;
        if (c.inObs) obsOverlays++;
      } else if (c.role === 'control') {
        controls++;
      }
    }
    return { overlays, controls, obsOverlays };
  }

  /** "왜 OBS 로 안 잡히지"를 눈으로 확인하기 위한 목록 */
  get connectedOverlays(): ConnectedOverlay[] {
    const out: ConnectedOverlay[] = [];
    for (const c of this.clients.values()) {
      if (c.role !== 'overlay') continue;
      out.push({
        id: c.id,
        inObs: c.inObs,
        layer: c.layer,
        presetId: c.pinnedPresetId,
        userAgent: c.userAgent.slice(0, 120),
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 메시지 처리
  // -------------------------------------------------------------------------

  private handleMessage(clientId: string, msg: ClientMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (msg.t) {
      case 'identify': {
        client.role = msg.role;
        if (msg.layer) client.layer = msg.layer;
        if (msg.presetId) client.pinnedPresetId = msg.presetId;
        // 둘 중 하나라도 OBS 라고 하면 OBS 다.
        // User-Agent 판정은 캐시된 옛 번들에도 통하고,
        // window.obsstudio 판정은 UA 를 바꾼 환경에도 통한다. 서로를 보완한다.
        client.inObs = client.inObs || msg.inObs === true;
        this.broadcastPeers();
        break;
      }

      case 'transport': {
        // 컨트롤 패널만 재생을 제어할 수 있다
        if (client.role !== 'control') break;
        this.demoStartedAt = null;
        this.setTransport(msg.playing, msg.mediaTimeMs, msg.rate ?? 1);
        break;
      }

      case 'setProject': {
        if (client.role !== 'control') break;
        this.setProject(msg.project);
        break;
      }

      case 'setCursor': {
        if (client.role !== 'control') break;
        this.setCursor(msg.index);
        break;
      }

      case 'moveCursor': {
        if (client.role !== 'control') break;
        this.setCursor(this.state.cursor + msg.delta);
        break;
      }

      case 'setMode': {
        if (client.role !== 'control') break;
        this.setMode(msg.mode);
        break;
      }

      case 'setPreset': {
        if (client.role !== 'control') break;
        const preset = getPreset(msg.presetId);
        if (!preset) {
          this.send(client.socket, { t: 'error', message: `프리셋 없음: ${msg.presetId}` });
          break;
        }
        this.previewPreset = null;
        this.state.preset = preset;
        this.broadcastState({ preset });
        break;
      }

      case 'previewPreset': {
        if (client.role !== 'control') break;
        // 저장하지 않고 화면에만 반영 — 에디터 슬라이더를 드래그하는 동안 쓰인다
        this.previewPreset = msg.preset;
        this.broadcastState({ preset: msg.preset });
        break;
      }

      case 'setHidden': {
        if (client.role !== 'control') break;
        this.state.hidden = msg.hidden;
        this.broadcastState({ hidden: msg.hidden });
        break;
      }

      case 'ping':
        break;
    }
  }

  // -------------------------------------------------------------------------
  // 상태 변경 (HTTP 라우트에서도 호출)
  // -------------------------------------------------------------------------

  setTransport(playing: boolean, mediaTimeMs: number, rate = 1): void {
    this.state.playing = playing;
    this.state.mediaTimeMs = mediaTimeMs;
    this.state.serverTs = Date.now();
    this.state.rate = rate;

    this.broadcastState({
      playing,
      mediaTimeMs,
      serverTs: this.state.serverTs,
      rate,
    });
    this.ensureTicking();
  }

  setProject(project: Project | null): void {
    const previous = this.state.project;
    this.state.project = project;
    this.demoStartedAt = null;

    /*
     * 곡을 바꾸면 시작 전(빈 화면)으로 돌아간다.
     * 이전 곡의 줄 번호가 남아 엉뚱한 가사가 송출되는 것이 최악의 실패다.
     *
     * 단, **같은 곡을 줄 수 그대로 다시 올린 경우**에는 위치를 유지한다.
     * 방송 중에 오타 하나 고쳐서 다시 적용했는데 처음으로 돌아가면 곤란하다.
     */
    const sameShape =
      project !== null &&
      previous !== null &&
      previous.id === project.id &&
      previous.lines.length === project.lines.length;

    this.state.cursor = sameShape ? clampCursor(this.state.cursor, project.lines.length) : -1;

    const patch: Partial<OverlayState> = { project, cursor: this.state.cursor };

    if (project) {
      this.state.mode = project.mode;
      patch.mode = project.mode;
      this.state.hidden = false; // 숨김 상태로 곡을 바꿔 "왜 안 나오지"가 되는 걸 막는다
      patch.hidden = false;
      const preset = getPreset(project.presetId);
      if (preset) {
        this.state.preset = preset;
        patch.preset = preset;
      }
    }

    this.broadcastState(patch);
  }

  setCursor(index: number): number {
    const lineCount = this.state.project?.lines.length ?? 0;
    const next = clampCursor(index, lineCount);
    if (next === this.state.cursor) return next;
    this.state.cursor = next;
    this.broadcastState({ cursor: next });
    return next;
  }

  setMode(mode: PlaybackMode): void {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    this.broadcastState({ mode });
  }

  setHidden(hidden: boolean): void {
    if (this.state.hidden === hidden) return;
    this.state.hidden = hidden;
    this.broadcastState({ hidden });
  }

  toggleHidden(): boolean {
    this.setHidden(!this.state.hidden);
    return this.state.hidden;
  }

  get cursor(): number {
    return this.state.cursor;
  }

  setPresetById(id: string): boolean {
    const preset = getPreset(id);
    if (!preset) return false;
    this.previewPreset = null;
    this.state.preset = preset;
    this.broadcastState({ preset });
    return true;
  }

  /** 저장된 프리셋이 바뀌었을 때 현재 사용 중이면 갱신 */
  refreshPresetIfActive(id: string): void {
    if (this.state.preset.id !== id) return;
    const preset = getPreset(id);
    if (preset) {
      // 저장됐으니 미리보기 임시본은 버린다.
      // 안 그러면 새로 접속한 오버레이만 저장 전 값을 받는 어긋남이 생긴다.
      this.previewPreset = null;
      this.state.preset = preset;
      this.broadcastState({ preset });
    }
  }

  /** 음원 없이 데모 곡을 서버 타이머로 재생 */
  startDemo(): void {
    this.state.project = DEMO_PROJECT;
    const preset = getPreset(DEMO_PROJECT.presetId);
    if (preset) this.state.preset = preset;
    this.demoStartedAt = Date.now();
    this.state.mode = 'timeline'; // 데모는 자동 재생을 보여주는 것이 목적이다
    this.state.playing = true;
    this.state.rate = 1;
    this.state.mediaTimeMs = 0;
    this.state.serverTs = Date.now();

    this.broadcastState({
      project: this.state.project,
      preset: this.state.preset,
      mode: 'timeline',
      playing: true,
      mediaTimeMs: 0,
      serverTs: this.state.serverTs,
    });
    this.ensureTicking();
  }

  stopDemo(): void {
    this.demoStartedAt = null;
    this.setTransport(false, this.state.mediaTimeMs);
  }

  get snapshot(): OverlayState {
    return this.stateFor(null);
  }

  // -------------------------------------------------------------------------
  // 브로드캐스트
  // -------------------------------------------------------------------------

  /** 오버레이가 URL 로 프리셋을 지정했으면 그것을 우선한다 */
  private stateFor(pinnedPresetId: string | null): OverlayState {
    const preset =
      (pinnedPresetId ? getPreset(pinnedPresetId) : null) ??
      this.previewPreset ??
      this.state.preset;
    return { ...this.state, preset };
  }

  private broadcastState(patch: Partial<OverlayState>): void {
    for (const client of this.clients.values()) {
      // 프리셋을 고정한 오버레이에는 프리셋 변경을 전달하지 않는다
      const scoped = { ...patch };
      if (client.pinnedPresetId && 'preset' in scoped) {
        const pinned = getPreset(client.pinnedPresetId);
        if (pinned) scoped.preset = pinned;
      }
      this.send(client.socket, { t: 'patch', state: scoped });
    }
  }

  private broadcastPeers(): void {
    const { overlays, controls, obsOverlays } = this.peerCounts;
    const msg: ServerMessage = { t: 'peers', overlays, controls, obsOverlays };
    for (const client of this.clients.values()) this.send(client.socket, msg);
  }

  private send(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState !== 1 /* OPEN */) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // 끊긴 소켓 — close 핸들러가 정리한다
    }
  }

  // -------------------------------------------------------------------------
  // 하트비트
  // -------------------------------------------------------------------------

  private ensureTicking(): void {
    if (this.state.playing && !this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    } else if (!this.state.playing && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
      this.tick(); // 정지 위치를 확정적으로 한 번 더 알린다
    }
  }

  private tick(): void {
    if (this.demoStartedAt !== null) {
      const elapsed = Date.now() - this.demoStartedAt;
      this.state.mediaTimeMs = elapsed % DEMO_LOOP_MS;
      this.state.serverTs = Date.now();
    } else if (this.state.playing) {
      // 컨트롤 패널이 보고한 시각을 기준으로 서버도 함께 흘려보낸다.
      // 다음 transport 보고가 오면 덮어써진다.
      const now = Date.now();
      this.state.mediaTimeMs += (now - this.state.serverTs) * this.state.rate;
      this.state.serverTs = now;
    }

    const msg: ServerMessage = {
      t: 'tick',
      mediaTimeMs: this.state.mediaTimeMs,
      serverTs: this.state.serverTs,
      playing: this.state.playing,
    };
    for (const client of this.clients.values()) this.send(client.socket, msg);
  }

  /** ping 에 응답하지 않은 연결을 끊는다 */
  private reapDeadClients(): void {
    let removed = false;

    for (const [id, client] of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        this.clients.delete(id);
        removed = true;
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        this.clients.delete(id);
        removed = true;
      }
    }

    if (removed) this.broadcastPeers();
  }

  dispose(): void {
    clearInterval(this.heartbeatTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const client of this.clients.values()) client.socket.close();
    this.clients.clear();
  }
}

export function globalOffsetMs(): number {
  return loadConfig().globalOffsetMs;
}
