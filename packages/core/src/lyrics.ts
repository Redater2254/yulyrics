import type { LyricLine, PlaybackMode, Project, WordTiming } from './types.js';

/** endMs 가 비어 있으면 다음 줄 시작까지로 본다. 마지막 줄은 fallback 만큼 유지. */
export function resolveLineEnd(lines: LyricLine[], index: number, fallbackMs = 4000): number {
  const line = lines[index];
  if (!line) return 0;
  if (line.endMs !== null) return line.endMs;
  const next = lines[index + 1];
  if (next) return next.startMs;
  return line.startMs + fallbackMs;
}

/** 현재 재생 위치에 해당하는 줄 인덱스. 없으면 -1. */
export function findActiveLineIndex(lines: LyricLine[], timeMs: number): number {
  // 이진 탐색 — 5분 곡이면 100줄 남짓이라 선형도 되지만, 매 프레임 도는 코드다.
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.startMs <= timeMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return -1;
  // 줄이 이미 끝났고 다음 줄도 아직이면 표시하지 않는다
  if (timeMs > resolveLineEnd(lines, found)) return -1;
  return found;
}

/**
 * 워드 타이밍을 확정한다.
 * 사용자가 워드 싱크를 찍지 않았으면 **글자 수에 비례해 균등 분배**한다.
 * 정확하진 않지만 줄 단위로 뭉텅이 색이 바뀌는 것보단 훨씬 자연스럽다.
 */
export function deriveWords(line: LyricLine, endMs: number): WordTiming[] {
  if (line.words && line.words.length > 0) return line.words;

  const chunks = line.text.split(/(\s+)/).filter((s) => s.length > 0);
  const words = chunks.filter((c) => !/^\s+$/.test(c));
  if (words.length === 0) return [];

  const totalChars = words.reduce((sum, w) => sum + w.length, 0);
  const duration = Math.max(0, endMs - line.startMs);

  const out: WordTiming[] = [];
  let cursorMs = line.startMs;
  for (const w of words) {
    const span = totalChars > 0 ? (duration * w.length) / totalChars : 0;
    out.push({ text: w, startMs: cursorMs, endMs: cursorMs + span });
    cursorMs += span;
  }
  return out;
}

export interface KaraokeProgress {
  /** 줄 전체 대비 진행률 (0..1). 글자 수 기준 근사 — 렌더러의 최후 fallback */
  ratio: number;
  /** 진행 중인 단어 인덱스. -1 = 아직 시작 전 */
  wordIndex: number;
  /** 그 단어 내부 진행률 (0..1) */
  wordRatio: number;
}

/**
 * 카라오케 와이프 진행 상태.
 * 렌더러는 wordIndex/wordRatio 로 DOM 을 실측해 픽셀 경계를 잡고,
 * 실측이 불가능할 때만 ratio 를 쓴다.
 */
export function karaokeProgress(
  line: LyricLine,
  endMs: number,
  timeMs: number,
  leadMs = 0,
): KaraokeProgress {
  const t = timeMs + leadMs;
  const words = deriveWords(line, endMs);

  if (words.length === 0) return { ratio: 0, wordIndex: -1, wordRatio: 0 };
  if (t <= line.startMs) return { ratio: 0, wordIndex: -1, wordRatio: 0 };
  if (t >= endMs) return { ratio: 1, wordIndex: words.length - 1, wordRatio: 1 };

  const totalChars = words.reduce((sum, w) => sum + w.text.length, 0);
  let charsBefore = 0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (t < w.endMs) {
      const span = Math.max(1, w.endMs - w.startMs);
      const wordRatio = Math.min(1, Math.max(0, (t - w.startMs) / span));
      const ratio = totalChars > 0 ? (charsBefore + w.text.length * wordRatio) / totalChars : 0;
      return { ratio, wordIndex: i, wordRatio };
    }
    charsBefore += w.text.length;
  }

  return { ratio: 1, wordIndex: words.length - 1, wordRatio: 1 };
}

// ---------------------------------------------------------------------------
// LRC 임포트 / 익스포트
// ---------------------------------------------------------------------------

const LINE_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;

function toMs(min: string, sec: string, frac: string | undefined): number {
  const f = frac === undefined ? 0 : Number(frac.padEnd(3, '0'));
  return Number(min) * 60_000 + Number(sec) * 1000 + f;
}

function fmtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const min = Math.floor(clamped / 60_000);
  const sec = Math.floor((clamped % 60_000) / 1000);
  const cs = Math.floor((clamped % 1000) / 10);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

let lineCounter = 0;
function nextLineId(): string {
  lineCounter += 1;
  return `l${lineCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 표준 LRC + A2 확장(단어 태그) 파싱 */
export function parseLrc(content: string): LyricLine[] {
  const lines: LyricLine[] = [];

  for (const raw of content.split(/\r?\n/)) {
    LINE_TAG.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    let bodyStart = 0;

    while ((match = LINE_TAG.exec(raw)) !== null) {
      // 태그는 줄 앞쪽에 연속으로만 온다. 본문 중간의 것은 무시.
      if (match.index !== bodyStart) break;
      stamps.push(toMs(match[1]!, match[2]!, match[3]));
      bodyStart = match.index + match[0].length;
    }
    if (stamps.length === 0) continue;

    const body = raw.slice(bodyStart);

    // 단어 태그 추출
    const words: WordTiming[] = [];
    WORD_TAG.lastIndex = 0;
    let plain = body;
    if (WORD_TAG.test(body)) {
      WORD_TAG.lastIndex = 0;
      const parts: { ms: number; text: string }[] = [];
      let cursor = 0;
      let m: RegExpExecArray | null;
      let pendingMs: number | null = null;

      while ((m = WORD_TAG.exec(body)) !== null) {
        if (pendingMs !== null) {
          parts.push({ ms: pendingMs, text: body.slice(cursor, m.index) });
        }
        pendingMs = toMs(m[1]!, m[2]!, m[3]);
        cursor = m.index + m[0].length;
      }
      if (pendingMs !== null) parts.push({ ms: pendingMs, text: body.slice(cursor) });

      plain = parts.map((p) => p.text).join('');
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        const text = p.text.trim();
        if (!text) continue;
        words.push({
          text,
          startMs: p.ms,
          endMs: parts[i + 1]?.ms ?? p.ms + 500,
        });
      }
    }

    const text = plain.trim();
    if (!text) continue;

    for (const startMs of stamps) {
      lines.push({
        id: nextLineId(),
        startMs,
        endMs: null,
        text,
        romaja: '',
        translation: '',
        words: words.length > 0 ? words : null,
      });
    }
  }

  lines.sort((a, b) => a.startMs - b.startMs);
  return lines;
}

export interface LrcExportOptions {
  title?: string;
  artist?: string;
  /** 단어 타이밍을 A2 확장 태그로 내보낼지 */
  includeWords?: boolean;
}

export function serializeLrc(lines: LyricLine[], opts: LrcExportOptions = {}): string {
  const out: string[] = [];
  if (opts.title) out.push(`[ti:${opts.title}]`);
  if (opts.artist) out.push(`[ar:${opts.artist}]`);
  out.push('[re:yulyrics]');
  out.push('');

  for (const line of lines) {
    if (opts.includeWords && line.words && line.words.length > 0) {
      const body = line.words.map((w) => `<${fmtTime(w.startMs)}>${w.text}`).join(' ');
      out.push(`[${fmtTime(line.startMs)}]${body}`);
    } else {
      out.push(`[${fmtTime(line.startMs)}]${line.text}`);
    }
  }

  return out.join('\n');
}

/**
 * 화면을 비우는 구분자인가.
 *
 * `--` 뿐 아니라 사람이 자연스럽게 적는 `(간주중)` 같은 표기도 받아들인다.
 * 규칙을 외우게 하는 것보다, 이미 쓰던 대로 적어도 통하는 편이 낫다.
 * 단, **괄호로 감싼 줄 전체**가 이 목록에 해당할 때만 구분자로 본다 —
 * 가사 안의 `(백보컬)` 같은 괄호까지 지워버리면 곤란하다.
 */
const BREAK_KEYWORDS = /^(간주|간주\s*중|전주|후주|반주|instrumental|interlude|break)$/i;

export function isBreakMarker(line: string): boolean {
  const s = line.trim();
  if (/^[-–—]{2,}$/.test(s)) return true;
  const inner = s.match(/^[([{]\s*(.+?)\s*[)\]}]$/);
  return inner !== null && BREAK_KEYWORDS.test(inner[1]!);
}

/**
 * 붙여넣은 순수 텍스트를 줄 목록으로.
 *
 * manual 모드에서는 이게 곧 완성이다 — 타이밍을 찍을 필요가 없다.
 * `가사 || 번역` 처럼 `||` 로 구분하면 번역까지 한 번에 넣을 수 있다.
 */
export function linesFromPlainText(text: string): LyricLine[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((raw) => {
      const [main = '', translation = ''] = raw.split('||').map((s) => s.trim());
      const isBreak = isBreakMarker(main);
      return {
        id: nextLineId(),
        startMs: 0,
        endMs: null,
        text: isBreak ? '' : main,
        romaja: '',
        translation: isBreak ? '' : translation,
        note: isBreak ? main : '',
        words: null,
      };
    });
}

export interface CreateProjectOptions {
  id: string;
  title: string;
  artist?: string;
  /** 줄바꿈으로 구분된 가사 */
  text: string;
  mode?: PlaybackMode;
  presetId?: string;
}

/** 붙여넣은 가사로 곡 하나를 즉시 만든다 */
export function createProject(opts: CreateProjectOptions): Project {
  return {
    version: 1,
    id: opts.id,
    meta: {
      title: opts.title,
      artist: opts.artist ?? '',
      album: '',
      coverPath: '',
      durationMs: 0,
    },
    audio: { type: 'none', src: '', offsetMs: 0 },
    presetId: opts.presetId ?? 'karaoke-classic',
    mode: opts.mode ?? 'manual',
    lines: linesFromPlainText(opts.text),
  };
}

/** cursor 를 유효 범위(-1 ~ lines.length)로 자른다 */
export function clampCursor(cursor: number, lineCount: number): number {
  if (!Number.isFinite(cursor)) return -1;
  return Math.max(-1, Math.min(Math.round(cursor), lineCount));
}
