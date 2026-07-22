import type {
  AnimationType,
  OverlayState,
  PlaybackMode,
  Preset,
  Project,
  ServerMessage,
} from '@yulyrics/core';
import { createProject, parseLrc, romanize } from '@yulyrics/core';

/**
 * 컨트롤 패널.
 *
 * 기본 사용법은 PPT 와 같다 — 가사를 붙여넣고, 스페이스바로 한 줄씩 넘긴다.
 * 미리 싱크를 찍어둘 필요가 없어서 처음 부르는 곡도 바로 방송에 쓸 수 있다.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  obsUrl: $<HTMLElement>('obs-url'),
  copyUrl: $<HTMLButtonElement>('copy-url'),
  connDot: $<HTMLElement>('conn-dot'),
  connText: $<HTMLElement>('conn-text'),

  presetList: $<HTMLUListElement>('preset-list'),
  pinnedUrl: $<HTMLElement>('pinned-url'),
  copyPinned: $<HTMLButtonElement>('copy-pinned'),

  songList: $<HTMLUListElement>('song-list'),
  songEmpty: $<HTMLElement>('song-empty'),
  songSearch: $<HTMLInputElement>('song-search'),
  songTitle: $<HTMLElement>('song-title'),
  counter: $<HTMLElement>('counter'),

  cur: $<HTMLElement>('cur'),
  curSub: $<HTMLElement>('cur-sub'),
  next: $<HTMLElement>('next'),
  lines: $<HTMLElement>('lines'),
  modeLabel: $<HTMLElement>('mode-label'),

  btnNext: $<HTMLButtonElement>('btn-next'),
  btnPrev: $<HTMLButtonElement>('btn-prev'),
  btnReset: $<HTMLButtonElement>('btn-reset'),
  btnHide: $<HTMLButtonElement>('btn-hide'),

  inTitle: $<HTMLInputElement>('in-title'),
  inArtist: $<HTMLInputElement>('in-artist'),
  inLyrics: $<HTMLTextAreaElement>('in-lyrics'),
  btnApply: $<HTMLButtonElement>('btn-apply'),
  btnOpenFile: $<HTMLButtonElement>('btn-open-file'),
  fileInput: $<HTMLInputElement>('file-input'),


  help: $<HTMLElement>('help'),
  btnHelp: $<HTMLButtonElement>('btn-help'),
  helpClose: $<HTMLButtonElement>('help-close'),

  winctl: $<HTMLElement>('winctl'),
  winMin: $<HTMLButtonElement>('win-min'),
  winMax: $<HTMLButtonElement>('win-max'),
  winMaxIcon: document.getElementById('win-max-icon') as unknown as SVGElement,
  winClose: $<HTMLButtonElement>('win-close'),

  preview: $<HTMLIFrameElement>('preview'),
  previewWrap: document.querySelector<HTMLElement>('.preview-wrap')!,
  focusChip: $<HTMLElement>('focus-chip'),

  animIn: $<HTMLSelectElement>('anim-in'),
  animOut: $<HTMLSelectElement>('anim-out'),
  animDur: $<HTMLInputElement>('anim-dur'),
  animDurVal: $<HTMLElement>('anim-dur-val'),
  animStagger: $<HTMLInputElement>('anim-stagger'),
  animStaggerVal: $<HTMLElement>('anim-stagger-val'),
  animTest: $<HTMLButtonElement>('anim-test'),
  animReset: $<HTMLButtonElement>('anim-reset'),
};

interface SongSummary {
  id: string;
  title: string;
  artist: string;
  lineCount: number;
}

let presets: Preset[] = [];
let songs: SongSummary[] = [];
let activePresetId = '';
/** 지금 송출 중인 프리셋 전체. 효과 편집의 원본이 된다. */
let activePreset: Preset | null = null;
let project: Project | null = null;
let cursor = -1;
let mode: PlaybackMode = 'manual';
let hidden = false;

const baseUrl = `${location.protocol}//${location.host}`;

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

const post = (path: string, body?: unknown): Promise<unknown> =>
  api(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;

function send(msg: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/ws`);

  socket.addEventListener('open', () => send({ t: 'identify', role: 'control' }));

  socket.addEventListener('message', (event) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data as string) as ServerMessage;
    } catch {
      return;
    }
    if (msg.t === 'hello' || msg.t === 'patch') applyState(msg.state);
    else if (msg.t === 'peers') updateBadge(msg.overlays, msg.obsOverlays);
    else if (msg.t === 'error') console.warn('[yulyrics]', msg.message);
  });

  socket.addEventListener('close', () => {
    socket = null;
    updateBadge(0);
    setTimeout(connect, 1000);
  });
}

function applyState(state: Partial<OverlayState>): void {
  if (state.project !== undefined) {
    project = state.project;
    renderSongHeader();
    renderLineList();
  }
  if (state.preset) {
    activePresetId = state.preset.id;
    activePreset = state.preset;
    renderPresets();
    syncAnimControls();
  }
  if (state.mode !== undefined) {
    mode = state.mode;
    els.modeLabel.textContent = mode === 'manual' ? '' : '자동(타임라인) 모드';
  }
  if (state.cursor !== undefined) {
    cursor = state.cursor;
    renderStage();
    highlightLine();
  }
  if (state.hidden !== undefined) {
    hidden = state.hidden;
    els.btnHide.textContent = hidden ? '가사 보이기' : '가사 숨기기';
  }
}

/**
 * OBS 소스와 그냥 열어둔 브라우저 탭을 구분해서 보여준다.
 * "연결은 됐는데 왜 방송에 안 나오지"의 대부분이 여기서 바로 잡힌다.
 */
function updateBadge(overlays: number, obsOverlays = 0): void {
  if (overlays === 0) {
    els.connText.textContent = '오버레이 없음';
  } else if (obsOverlays === overlays) {
    els.connText.textContent = `OBS ${obsOverlays}`;
  } else if (obsOverlays === 0) {
    els.connText.textContent = `브라우저 ${overlays} · OBS 없음`;
  } else {
    els.connText.textContent = `OBS ${obsOverlays} · 브라우저 ${overlays - obsOverlays}`;
  }
  els.connDot.classList.toggle('on', obsOverlays > 0);
}

// ---------------------------------------------------------------------------
// 화면 그리기
// ---------------------------------------------------------------------------

function lineText(index: number): string | null {
  const line = project?.lines[index];
  return line ? line.text : null;
}

function renderSongHeader(): void {
  if (!project) {
    els.songTitle.textContent = '진행';
    return;
  }
  const { title, artist } = project.meta;
  els.songTitle.textContent = artist ? `${title} — ${artist}` : title;
}

function renderStage(): void {
  const total = project?.lines.length ?? 0;
  els.counter.textContent = total === 0 ? '— / —' : `${Math.max(0, cursor + 1)} / ${total}`;

  const cur = lineText(cursor);
  if (cur === null) {
    els.cur.className = 'cur empty';
    els.cur.textContent =
      cursor >= total && total > 0
        ? '곡 종료 — 화면이 비어 있습니다'
        : '시작 전 — 스페이스바를 누르면 첫 줄이 나옵니다';
    els.curSub.textContent = '';
  } else if (cur === '') {
    els.cur.className = 'cur empty';
    els.cur.textContent = `${project!.lines[cursor]!.note || '--'} — 화면 비어 있음`;
    els.curSub.textContent = '';
  } else {
    els.cur.className = 'cur';
    els.cur.textContent = cur;
    const line = project!.lines[cursor]!;
    els.curSub.textContent = line.translation || romanize(cur);
  }

  const nextLine = lineText(cursor + 1);
  els.next.textContent = nextLine === null ? '—' : nextLine === '' ? '(빈 화면)' : nextLine;

  els.btnPrev.disabled = cursor <= -1;
  els.btnNext.disabled = total === 0 || cursor >= total;
}

function renderLineList(): void {
  els.lines.replaceChildren();
  if (!project) return;

  project.lines.forEach((line, i) => {
    const isBreak = line.text === '';
    const div = document.createElement('div');
    div.className = isBreak ? 'ln break' : 'ln';
    div.dataset.index = String(i);

    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(i + 1);

    const t = document.createElement('span');
    // 사용자가 적은 구분자를 그대로 보여준다 — 목록에서 위치를 잡기 쉽다
    t.textContent = isBreak ? `${line.note || '--'} · 빈 화면` : line.text;

    div.append(n, t);
    div.addEventListener('click', () => send({ t: 'setCursor', index: i }));
    els.lines.append(div);
  });

  highlightLine();
}

function highlightLine(): void {
  for (const el of els.lines.querySelectorAll<HTMLElement>('.ln')) {
    const isActive = Number(el.dataset.index) === cursor;
    el.classList.toggle('active', isActive);
    if (isActive) el.scrollIntoView({ block: 'nearest' });
  }
}

function renderPresets(): void {
  els.presetList.replaceChildren();

  for (const preset of presets) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = preset.id === activePresetId ? 'active' : '';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'preset';
    radio.checked = preset.id === activePresetId;
    radio.addEventListener('change', () => send({ t: 'setPreset', presetId: preset.id }));

    const name = document.createElement('span');
    name.textContent = preset.name;

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = preset.builtin ? '기본' : '내 프리셋';

    label.append(radio, name, tag);
    li.append(label);
    els.presetList.append(li);
  }

  els.pinnedUrl.textContent = `${baseUrl}/overlay?preset=${activePresetId}`;
}

function renderSongs(): void {
  els.songList.replaceChildren();

  const query = els.songSearch.value.trim().toLowerCase();
  const visible = query
    ? songs.filter((s) => `${s.title} ${s.artist}`.toLowerCase().includes(query))
    : songs;

  els.songEmpty.style.display = visible.length === 0 ? '' : 'none';
  els.songEmpty.textContent =
    songs.length === 0 ? '저장된 곡이 없습니다.' : '검색 결과가 없습니다.';

  for (const song of visible) {
    const li = document.createElement('li');
    li.className = song.id === project?.id ? 'song active' : 'song';

    const name = document.createElement('span');
    name.textContent = song.artist ? `${song.title} — ${song.artist}` : song.title;

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `${song.lineCount}줄`;

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '곡 삭제';

    // 두 번 눌러야 지워진다. 방송 중에 한 번의 오클릭으로 곡이 사라지면 안 되는데,
    // window.confirm 은 전체 창을 잠가서 그것대로 위험하다.
    let armed = false;
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!armed) {
        armed = true;
        del.classList.add('confirm');
        del.textContent = '삭제?';
        setTimeout(() => {
          if (!armed) return;
          armed = false;
          del.classList.remove('confirm');
          del.textContent = '×';
        }, 3000);
        return;
      }
      void deleteSong(song.id);
    });

    li.append(name, tag, del);
    li.addEventListener('click', () => void loadSong(song.id));
    els.songList.append(li);
  }
}

async function deleteSong(id: string): Promise<void> {
  await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });

  // 지금 송출 중인 곡을 지웠다면 화면도 비워야 한다.
  // 없는 곡의 가사가 계속 떠 있는 것이 가장 이상한 상태다.
  if (project?.id === id) send({ t: 'setProject', project: null });

  songs = await api<SongSummary[]>('/api/projects');
  renderSongs();
}

// ---------------------------------------------------------------------------
// 동작
// ---------------------------------------------------------------------------

async function loadSong(id: string): Promise<void> {
  const loaded = await api<Project>(`/api/projects/${encodeURIComponent(id)}`);
  send({ t: 'setProject', project: loaded });
  els.inTitle.value = loaded.meta.title;
  els.inArtist.value = loaded.meta.artist;
  els.inLyrics.value = loaded.lines
    .map((l) =>
      l.text === ''
        ? l.note || '--'
        : l.translation
          ? `${l.text} || ${l.translation}`
          : l.text,
    )
    .join('\n');
  renderSongs();
}

async function applyLyrics(): Promise<void> {
  const text = els.inLyrics.value.trim();
  if (!text) return;

  const title = els.inTitle.value.trim() || '제목 없음';
  // 같은 제목이면 같은 곡으로 덮어쓴다 — 오타 하나 고칠 때마다 새 곡이 쌓이면 곤란하다.
  // 지금 열려 있는 곡뿐 아니라 저장된 목록까지 본다. 목록에 있는데 안 열려 있을 때
  // 새 곡이 만들어져 목록이 중복으로 더러워지는 일이 실제로 있었다.
  const existing =
    (project?.meta.title === title ? project.id : null) ??
    songs.find((s) => s.title === title)?.id;
  const id = existing ?? slugId(title);

  const created = createProject({
    id,
    title,
    artist: els.inArtist.value.trim(),
    text,
    mode: 'manual',
    presetId: activePresetId || 'karaoke-classic',
  });

  await api(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(created),
  });
  send({ t: 'setProject', project: created });

  songs = await api<SongSummary[]>('/api/projects');
  renderSongs();
}

/**
 * 가사 파일을 텍스트 영역에 채운다. `.lrc` `.txt` 를 받는다.
 *
 * `.lrc` 의 타임태그는 **떼어낸다.** 지금은 사람이 직접 넘기는 수동 모드가 기본이고,
 * 음원 재생 기능이 없어서 타이밍을 살려둬도 쓸 데가 없다.
 * 오디오가 붙으면(M5) 그때 타이밍을 보존하도록 바꾸면 된다.
 */
function fillFromFile(name: string, content: string): void {
  const looksLikeLrc = /\[\d{1,3}:\d{2}/.test(content);

  const lines = looksLikeLrc
    ? parseLrc(content).map((l) => l.text)
    : content.split(/\r?\n/).map((s) => s.trim());

  const text = lines.filter((s) => s.length > 0).join('\n');
  if (!text) return;

  els.inLyrics.value = text;
  if (!els.inTitle.value.trim()) {
    els.inTitle.value = name.replace(/\.(lrc|txt|srt)$/i, '');
  }
  // 파일만 읽고 끝나면 "그래서 어떻게 하라는 거지"가 된다. 다음 행동을 눈에 띄게 둔다.
  els.btnApply.focus();
}

async function readFiles(files: FileList | null): Promise<void> {
  const file = files?.[0];
  if (!file) return;
  fillFromFile(file.name, await file.text());
}

function slugId(title: string): string {
  const base = title.replace(/[^a-zA-Z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base || 'song'}-${Date.now().toString(36)}`;
}

async function copy(text: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = '복사됨!';
  } catch {
    button.textContent = '복사 실패';
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

// ---------------------------------------------------------------------------
// 화면 전환 효과
// ---------------------------------------------------------------------------

const ANIM_LABELS: Record<AnimationType, string> = {
  none: '없음',
  fade: '페이드',
  slideUp: '아래에서 위로',
  slideDown: '위에서 아래로',
  slideLeft: '오른쪽에서',
  slideRight: '왼쪽에서',
  scaleIn: '작게 → 제자리',
  pop: '통 튀어나오기',
  blurIn: '흐림 → 또렷',
  flipIn: '눕혔다 세우기',
  // 예전 이름 — 목록에는 안 띄운다
  fadeUp: '아래에서 위로',
  fadeDown: '위에서 아래로',
};

const ANIM_CHOICES: AnimationType[] = [
  'none',
  'fade',
  'slideUp',
  'slideDown',
  'slideLeft',
  'slideRight',
  'scaleIn',
  'pop',
  'blurIn',
  'flipIn',
];

function fillAnimSelect(select: HTMLSelectElement): void {
  for (const type of ANIM_CHOICES) {
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = ANIM_LABELS[type];
    select.append(opt);
  }
}

/** 서버가 알려준 프리셋 값으로 컨트롤들을 맞춘다 (사용자 조작 중에는 건드리지 않는다) */
let editingAnim = false;
function syncAnimControls(): void {
  if (!activePreset || editingAnim) return;
  const a = activePreset.animation;
  // 예전 이름은 현재 이름으로 바꿔서 표시한다
  const normalize = (t: AnimationType): AnimationType =>
    t === 'fadeUp' ? 'slideUp' : t === 'fadeDown' ? 'slideDown' : t;

  els.animIn.value = normalize(a.in.type);
  els.animOut.value = normalize(a.out.type);
  els.animDur.value = String(a.in.durMs);
  els.animStagger.value = String(a.staggerMs);
  renderAnimLabels();
}

function renderAnimLabels(): void {
  els.animDurVal.textContent = `${els.animDur.value}ms`;
  const stagger = Number(els.animStagger.value);
  els.animStaggerVal.textContent = stagger === 0 ? '끄기' : `${stagger}ms`;
}

/** 편집한 프리셋을 즉시 송출에 반영하고, 잠시 뒤 저장한다 */
let saveTimer: number | null = null;
function applyAnimChange(): void {
  if (!activePreset) return;

  const durMs = Number(els.animDur.value);
  const next: Preset = {
    ...activePreset,
    animation: {
      in: { ...activePreset.animation.in, type: els.animIn.value as AnimationType, durMs },
      out: {
        ...activePreset.animation.out,
        type: els.animOut.value as AnimationType,
        // 퇴장은 등장보다 짧아야 다음 줄이 늦게 들어오는 느낌이 안 난다
        durMs: Math.round(durMs * 0.8),
      },
      staggerMs: Number(els.animStagger.value),
    },
  };
  activePreset = next;
  renderAnimLabels();

  // 슬라이더를 드래그하는 동안은 화면만 갱신하고, 멈춘 뒤에 한 번 저장한다
  send({ t: 'previewPreset', preset: next });

  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    editingAnim = false;
    // 기본 프리셋을 고쳐도 같은 ID로 사용자 사본이 저장된다.
    // 목록에서 사용자 것이 우선되므로 덮어쓴 것처럼 동작하고,
    // [기본값] 으로 사본을 지우면 원본이 되살아난다.
    void api(`/api/presets/${encodeURIComponent(next.id)}`, {
      method: 'PUT',
      body: JSON.stringify(next),
    }).then(() => refreshPresets());
  }, 600);
}

async function refreshPresets(): Promise<void> {
  presets = await api<Preset[]>('/api/presets');
  renderPresets();
}

/** 같은 줄을 지웠다 다시 띄워 효과를 눈으로 확인시킨다 */
async function testAnimation(): Promise<void> {
  const at = cursor;
  await post('/api/cursor', { index: -1 });
  setTimeout(() => void post('/api/cursor', { index: at < 0 ? 0 : at }), 220);
}

// ---------------------------------------------------------------------------
// 전역 단축키 (데스크톱 전용)
// ---------------------------------------------------------------------------

interface HotkeyStatus {
  action: string;
  accelerator: string;
  registered: boolean;
}
type Hotkeys = Record<string, string>;

const HOTKEY_FIELDS: { key: string; label: string }[] = [
  { key: 'next', label: '다음 줄' },
  { key: 'nextAlt', label: '다음 줄(보조)' },
  { key: 'prev', label: '이전 줄' },
  { key: 'prevAlt', label: '이전 줄(보조)' },
  { key: 'reset', label: '처음으로' },
  { key: 'toggleHide', label: '가사 숨김' },
];

interface DesktopBridge {
  version: string;
  platform: string;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  onMaximizeChange: (fn: (maximized: boolean) => void) => void;
}

const desktop = (window as unknown as { yulyricsDesktop?: DesktopBridge }).yulyricsDesktop;
const isDesktop = desktop !== undefined;
let hotkeys: Hotkeys = {};
let hotkeyStatus: HotkeyStatus[] = [];

/**
 * 브라우저 키 이벤트를 Electron accelerator 문자열로 바꾼다.
 * 두 쪽의 키 이름 체계가 달라서(예: ' ' vs 'Space') 변환이 필요하다.
 */
function toAccelerator(event: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const named: Record<string, string> = {
    ' ': 'Space',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Enter: 'Return',
    Escape: 'Escape',
    Tab: 'Tab',
    Backspace: 'Backspace',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Home: 'Home',
    End: 'End',
  };

  const key = named[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  // 수식키만 눌린 상태는 아직 확정된 조합이 아니다
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;
  // 수식키 없는 단일 키를 전역으로 잡으면 다른 프로그램에서 타이핑이 안 된다
  if (parts.length === 0 && !/^F\d{1,2}$/.test(key)) return null;

  parts.push(key);
  return parts.join('+');
}

/** 화면 표시용 — CommandOrControl 은 너무 길다 */
const prettyAccelerator = (a: string): string =>
  a ? a.replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ') : '없음';

function renderHotkeys(): void {
  const list = document.getElementById('hotkey-list');
  if (!list) return;
  list.replaceChildren();

  for (const field of HOTKEY_FIELDS) {
    const row = document.createElement('div');
    row.className = 'hk';

    const label = document.createElement('span');
    label.textContent = field.label;

    const button = document.createElement('button');
    button.className = 'hk-key';
    const accel = hotkeys[field.key] ?? '';
    button.textContent = prettyAccelerator(accel);

    // 등록 실패는 조용히 일어난다 — 다른 프로그램이 그 조합을 이미 쓰고 있으면
    // 눌러도 아무 일이 없다. 방송 중에 그걸 겪지 않도록 여기서 미리 알린다.
    const failed = hotkeyStatus.some((s) => s.accelerator === accel && !s.registered && accel);
    if (failed) {
      button.classList.add('failed');
      button.title = '다른 프로그램이 이미 쓰고 있어 등록되지 않았습니다';
      button.textContent += ' (사용 중)';
    }

    button.addEventListener('click', () => captureHotkey(field.key, button));

    const clear = document.createElement('button');
    clear.className = 'hk-clear';
    clear.textContent = '×';
    clear.title = '단축키 없애기';
    clear.addEventListener('click', () => void saveHotkeys({ ...hotkeys, [field.key]: '' }));

    row.append(label, button, clear);
    list.append(row);
  }
}

function captureHotkey(key: string, button: HTMLButtonElement): void {
  button.classList.add('capturing');
  button.textContent = '키를 누르세요…';

  const onKey = (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      stop();
      renderHotkeys();
      return;
    }
    const accel = toAccelerator(event);
    if (!accel) return; // 아직 수식키만 눌린 상태
    stop();
    void saveHotkeys({ ...hotkeys, [key]: accel });
  };

  const stop = (): void => {
    window.removeEventListener('keydown', onKey, true);
    button.classList.remove('capturing');
  };

  // 캡처 단계에서 가로채야 스페이스바 진행 단축키가 먼저 먹지 않는다
  window.addEventListener('keydown', onKey, true);
}

async function saveHotkeys(next: Hotkeys): Promise<void> {
  hotkeys = next;
  renderHotkeys();
  await post('/api/config', { hotkeys: next });
  // 셸이 다시 등록할 시간을 준 뒤 결과를 받아 온다
  setTimeout(() => void refreshStatus(), 250);
}

async function refreshStatus(): Promise<void> {
  const status = await api<{
    overlays: number;
    obsOverlays: number;
    hotkeys: Hotkeys;
    minimizeToTray: boolean;
    desktop: { present: boolean; hotkeys: HotkeyStatus[] };
  }>('/api/status');

  updateBadge(status.overlays, status.obsOverlays);
  hotkeys = status.hotkeys;
  hotkeyStatus = status.desktop.hotkeys;

  const section = document.getElementById('hotkey-section');
  if (section) section.style.display = isDesktop && status.desktop.present ? '' : 'none';

  const tray = document.getElementById('tray-toggle') as HTMLInputElement | null;
  if (tray) tray.checked = status.minimizeToTray;

  renderHotkeys();
}

// ---------------------------------------------------------------------------
// 미리보기 · 포커스 표시
// ---------------------------------------------------------------------------

/** 1920×1080 오버레이를 미리보기 상자 폭에 맞춰 축소한다 */
function fitPreview(): void {
  const width = els.previewWrap.clientWidth;
  if (width === 0) return;
  els.preview.style.transform = `scale(${width / 1920})`;
}

/**
 * 스페이스바는 이 창에 포커스가 있을 때만 동작한다.
 * "왜 안 넘어가지"의 원인이 포커스인지 아닌지를 눈으로 알 수 있게 한다.
 * (Electron 전역 단축키가 붙으면 이 제약 자체가 사라진다)
 */
function updateFocusChip(): void {
  const ready = document.hasFocus();
  els.focusChip.classList.toggle('ready', ready);
  els.focusChip.textContent = ready ? '⌨ 스페이스바 준비됨' : '창을 클릭하면 키 입력 가능';
}

window.addEventListener('resize', fitPreview);
window.addEventListener('focus', updateFocusChip);
window.addEventListener('blur', updateFocusChip);

// ---------------------------------------------------------------------------
// 키보드
// ---------------------------------------------------------------------------

/** 글자를 입력하는 중이면 단축키를 가로채면 안 된다 */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

window.addEventListener('keydown', (event) => {
  if (isTyping(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;

  switch (event.key) {
    case ' ':
    case 'ArrowRight':
    case 'PageDown':
    case 'Enter':
      // 버튼에 포커스가 남아 있으면 스페이스가 그 버튼을 다시 누른다 — 반드시 막는다
      event.preventDefault();
      send({ t: 'moveCursor', delta: 1 });
      break;
    case 'ArrowLeft':
    case 'PageUp':
    case 'Backspace':
      event.preventDefault();
      send({ t: 'moveCursor', delta: -1 });
      break;
    case 'Escape':
      event.preventDefault();
      // 도움말이 열려 있으면 그것부터 닫는다 — Esc 로 가사가 초기화되면 당황스럽다
      if (!els.help.hidden) {
        setHelp(false);
        break;
      }
      send({ t: 'setCursor', index: -1 });
      break;
    default:
      break;
  }
});

els.btnNext.addEventListener('click', () => send({ t: 'moveCursor', delta: 1 }));
els.btnPrev.addEventListener('click', () => send({ t: 'moveCursor', delta: -1 }));
els.btnReset.addEventListener('click', () => send({ t: 'setCursor', index: -1 }));
els.btnHide.addEventListener('click', () => {
  hidden = !hidden;
  send({ t: 'setHidden', hidden });
  els.btnHide.textContent = hidden ? '가사 보이기' : '가사 숨기기';
});

els.btnApply.addEventListener('click', () => void applyLyrics());
els.songSearch.addEventListener('input', () => renderSongs());

// --- 창 조작 (기본 타이틀바를 없앤 대신) ---
if (desktop) {
  els.winctl.hidden = false;
  els.winMin.addEventListener('click', () => desktop.minimize());
  els.winMax.addEventListener('click', () => desktop.toggleMaximize());
  els.winClose.addEventListener('click', () => desktop.close());

  // 헤더 빈 곳을 더블클릭하면 최대화 — 타이틀바의 기본 동작을 그대로 흉내낸다
  document.querySelector('header')?.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('button, code, input, .badge')) return;
    desktop.toggleMaximize();
  });

  desktop.onMaximizeChange((maximized) => {
    els.winMax.title = maximized ? '이전 크기로' : '최대화';
    // 최대화 상태에서는 '겹친 사각형'으로 바꿔 복원임을 알린다
    els.winMaxIcon.innerHTML = maximized
      ? '<rect x="2" y="4" width="6" height="6"/><path d="M4 4V2h6v6H8"/>'
      : '<rect x="2.5" y="2.5" width="7" height="7"/>';
  });
}

// --- 도움말 ---
const setHelp = (open: boolean): void => {
  els.help.hidden = !open;
};
els.btnHelp.addEventListener('click', () => setHelp(true));
els.helpClose.addEventListener('click', () => setHelp(false));
// 바깥을 눌러도 닫힌다 (안쪽 클릭은 통과시키지 않는다)
els.help.addEventListener('click', (event) => {
  if (event.target === els.help) setHelp(false);
});

els.btnOpenFile.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  void readFiles(els.fileInput.files);
  els.fileInput.value = ''; // 같은 파일을 다시 골라도 change 가 뜨게 한다
});

// 창 아무 데나 끌어다 놓아도 받는다 — 파일 고르는 버튼을 찾게 만들 이유가 없다
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  void readFiles(event.dataTransfer?.files ?? null);
});

for (const el of [els.animIn, els.animOut, els.animDur, els.animStagger]) {
  el.addEventListener('input', () => {
    editingAnim = true;
    applyAnimChange();
  });
}
els.animTest.addEventListener('click', () => void testAnimation());
els.animReset.addEventListener('click', async () => {
  if (!activePreset) return;
  // 사용자 사본을 지우면 코드에 들어 있는 기본 프리셋이 그대로 되살아난다
  await fetch(`/api/presets/${encodeURIComponent(activePreset.id)}`, { method: 'DELETE' });
  editingAnim = false;
  await refreshPresets();
  send({ t: 'setPreset', presetId: activePreset.id });
});
els.copyUrl.addEventListener('click', () => void copy(`${baseUrl}/overlay`, els.copyUrl));
els.copyPinned.addEventListener('click', () =>
  void copy(els.pinnedUrl.textContent ?? '', els.copyPinned),
);

// 클릭 후에도 스페이스바가 바로 먹도록, 버튼이 포커스를 붙들지 않게 한다
for (const btn of [els.btnNext, els.btnPrev, els.btnReset]) {
  btn.addEventListener('mouseup', () => btn.blur());
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  els.obsUrl.textContent = `${baseUrl}/overlay`;

  // 도움말의 주소는 실제로 열린 포트를 반영해야 한다 (7788이 아닐 수 있다)
  for (const [id, path] of [
    ['help-next', '/api/cursor/next'],
    ['help-prev', '/api/cursor/prev'],
    ['help-reset', '/api/cursor/reset'],
    ['help-hide', '/api/state/hidden/toggle'],
  ] as const) {
    const el = document.getElementById(id);
    if (el) el.textContent = baseUrl + path;
  }

  fillAnimSelect(els.animIn);
  fillAnimSelect(els.animOut);

  presets = await api<Preset[]>('/api/presets');
  songs = await api<SongSummary[]>('/api/projects');
  await refreshStatus();

  document.getElementById('tray-toggle')?.addEventListener('change', (event) => {
    void post('/api/config', { minimizeToTray: (event.target as HTMLInputElement).checked });
  });

  renderPresets();
  renderSongs();
  renderStage();
  fitPreview();
  updateFocusChip();
  connect();
}

void boot();
