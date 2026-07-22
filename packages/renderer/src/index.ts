import type {
  AnimationType,
  LayerSource,
  LyricLine,
  PlaybackMode,
  Preset,
  Project,
} from '@yulyrics/core';
import {
  clampCursor,
  findActiveLineIndex,
  karaokeProgress,
  resolveLineEnd,
  romanize,
} from '@yulyrics/core';

import { BASE_CSS, LAYER_CSS, presetToVars } from './style.js';

export { presetToVars } from './style.js';

/** 다음 줄이 이 시간 안에 시작하면 미리 띄운다 (간주 중 계속 떠 있는 것 방지) */
const PREROLL_MS = 4000;

const STYLE_ELEMENT_ID = 'yulyrics-renderer-style';

interface BlockHandle {
  lineIndex: number;
  lineId: string;
  el: HTMLDivElement;
  /** 카라오케 비활성이면 null */
  sungEl: HTMLElement | null;
  /** base 레이어의 단어 span 들 (공백 제외) */
  wordEls: HTMLElement[];
  /** 측정된 단어 위치. 측정 전에는 비어 있다. */
  wordRects: { left: number; width: number }[];
  mainTextWidth: number;
  /** 마지막으로 적용한 clip 경계(px). 같은 값이면 DOM 을 건드리지 않는다. */
  lastClipPx: number;
  exiting: boolean;
}

export class LyricsRenderer {
  private readonly root: HTMLElement;
  private readonly canvasEl: HTMLDivElement;
  private readonly stageEl: HTMLDivElement;
  private slotEls: HTMLDivElement[] = [];

  private preset: Preset;
  private project: Project | null = null;
  private hidden = false;
  private mode: PlaybackMode = 'manual';
  /** manual 모드의 현재 줄. -1 = 시작 전, lines.length = 종료 */
  private cursor = -1;

  private blocks = new Map<string, BlockHandle>();
  private romajaCache = new Map<string, string>();

  private resizeObserver: ResizeObserver | null = null;
  private fontsReady = false;
  /** 다음 프레임에 폭 재측정이 필요한가 */
  private needsMeasure = false;

  constructor(root: HTMLElement, preset: Preset) {
    this.root = root;
    this.preset = preset;

    ensureStyle(root.ownerDocument ?? document);

    this.root.classList.add('yl-root');
    this.canvasEl = el('div', 'yl-canvas');
    this.stageEl = el('div', 'yl-stage');
    this.canvasEl.appendChild(this.stageEl);
    this.root.appendChild(this.canvasEl);

    this.applyPreset();
    this.observeResize();

    const fonts = (root.ownerDocument ?? document).fonts;
    if (fonts) {
      fonts.ready.then(() => {
        this.fontsReady = true;
        this.needsMeasure = true;
      });
      // @font-face 는 실제로 쓰이는 순간에야 로드된다.
      // 그래서 fonts.ready 는 웹폰트가 요청되기도 전에 resolve 될 수 있고,
      // 그 시점에 측정하면 대체 폰트 기준 좌표가 잡혀 카라오케 와이프가 어긋난다.
      // 폰트가 새로 도착할 때마다 다시 재는 것이 유일하게 확실한 방법이다.
      fonts.addEventListener('loadingdone', () => {
        this.needsMeasure = true;
      });
    } else {
      this.fontsReady = true;
    }
  }

  // -------------------------------------------------------------------------
  // 외부 API
  // -------------------------------------------------------------------------

  setPreset(preset: Preset): void {
    const layoutChanged =
      preset.layout.mode !== this.preset.layout.mode ||
      preset.karaoke.enabled !== this.preset.karaoke.enabled ||
      // stagger 여부에 따라 단어 span 의 display 가 달라진다 → DOM 을 다시 만들어야 한다
      preset.animation.staggerMs > 0 !== this.preset.animation.staggerMs > 0 ||
      preset.layers.some((l, i) => l.source !== this.preset.layers[i]?.source);

    this.preset = preset;
    this.applyPreset();

    if (layoutChanged) {
      // 구조가 바뀌었으니 블록을 즉시 버리고 다음 프레임에 다시 만든다
      this.clearBlocks(true);
    }
    this.needsMeasure = true;
  }

  setProject(project: Project | null): void {
    this.project = project;
    this.cursor = clampCursor(this.cursor, project?.lines.length ?? 0);
    this.romajaCache.clear();
    this.clearBlocks(true);
    this.needsMeasure = true;
  }

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.canvasEl.classList.toggle('yl-hidden', hidden);
  }

  setMode(mode: PlaybackMode): void {
    this.mode = mode;
  }

  setCursor(index: number): void {
    this.cursor = clampCursor(index, this.project?.lines.length ?? 0);
  }

  /** 매 rAF 호출. 여기서는 되도록 DOM 을 건드리지 않는다. */
  frame(timeMs: number): void {
    if (this.hidden || !this.project) {
      if (this.blocks.size > 0) this.syncBlocks([], timeMs);
      return;
    }

    const visible = this.computeVisible(timeMs);
    this.syncBlocks(visible, timeMs);

    if (this.needsMeasure && this.fontsReady) {
      this.measureAll();
      this.needsMeasure = false;
    }

    if (this.preset.karaoke.enabled) {
      this.updateKaraoke(timeMs);
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvasEl.remove();
    this.blocks.clear();
    this.root.classList.remove('yl-root');
  }

  // -------------------------------------------------------------------------
  // 프리셋 적용
  // -------------------------------------------------------------------------

  private applyPreset(): void {
    const p = this.preset;

    for (const [key, value] of Object.entries(presetToVars(p))) {
      this.canvasEl.style.setProperty(key, value);
    }

    this.canvasEl.style.width = `${p.canvas.w}px`;
    this.canvasEl.style.height = `${p.canvas.h}px`;

    // 스테이지 폭: maxWidthPct 와 safeArea 중 좁은 쪽을 따른다
    const byPct = (p.canvas.w * p.layout.maxWidthPct) / 100;
    const bySafe = p.canvas.w - p.safeArea.left - p.safeArea.right;
    const width = Math.min(byPct, bySafe);

    this.stageEl.style.width = `${width}px`;
    this.stageEl.style.left = '50%';

    const tx = `calc(-50% + ${p.layout.offset.x}px)`;
    switch (p.layout.anchor) {
      case 'top':
        this.stageEl.style.top = `${p.safeArea.top}px`;
        this.stageEl.style.bottom = '';
        this.stageEl.style.transform = `translate(${tx}, ${p.layout.offset.y}px)`;
        break;
      case 'center':
        this.stageEl.style.top = '50%';
        this.stageEl.style.bottom = '';
        this.stageEl.style.transform = `translate(${tx}, calc(-50% + ${p.layout.offset.y}px))`;
        break;
      case 'bottom':
      default:
        this.stageEl.style.top = '';
        this.stageEl.style.bottom = `${p.safeArea.bottom}px`;
        // offset.y 음수 = 위로. bottom 기준이므로 translateY 를 그대로 쓴다.
        this.stageEl.style.transform = `translate(${tx}, ${p.layout.offset.y}px)`;
        break;
    }

    this.rebuildSlots();
    this.updateCanvasScale();
  }

  private rebuildSlots(): void {
    const mode = this.preset.layout.mode;
    const slotCount = mode === 'dual-alternate' ? 2 : 1;

    if (this.slotEls.length !== slotCount) {
      this.stageEl.replaceChildren();
      this.slotEls = [];
      for (let i = 0; i < slotCount; i++) {
        const slot = el('div', 'yl-slot');
        this.stageEl.appendChild(slot);
        this.slotEls.push(slot);
      }
      this.blocks.clear();
    }

    for (let i = 0; i < this.slotEls.length; i++) {
      const align = mode === 'dual-alternate' ? (i === 0 ? 'left' : 'right') : 'center';
      this.slotEls[i]!.dataset.align = align;
    }
  }

  private observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => this.updateCanvasScale());
    this.resizeObserver.observe(this.root);
  }

  /**
   * 프리셋 캔버스(기본 1920×1080)를 실제 뷰포트에 맞춘다.
   * OBS 브라우저 소스를 1920×1080 으로 두면 배율 1 이 되어 픽셀이 그대로 산다.
   */
  private updateCanvasScale(): void {
    const { w, h } = this.preset.canvas;
    const vw = this.root.clientWidth || w;
    const vh = this.root.clientHeight || h;
    const scale = Math.min(vw / w, vh / h);
    const offsetX = (vw - w * scale) / 2;
    const offsetY = (vh - h * scale) / 2;
    this.canvasEl.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  }

  // -------------------------------------------------------------------------
  // 표시할 줄 계산
  // -------------------------------------------------------------------------

  /**
   * 지금 화면에 있어야 할 줄 번호.
   *
   * manual 모드는 시간을 전혀 보지 않고 cursor 만 따른다.
   * 노래방 레이아웃(dual-alternate)은 "현재 줄 + 다음 줄" 두 줄을 함께 띄운다 —
   * 다음에 뭘 부를지 미리 보여야 노래를 할 수 있다.
   */
  private computeVisible(timeMs: number): number[] {
    const lines = this.project!.lines;
    if (lines.length === 0) return [];

    const layoutMode = this.preset.layout.mode;

    if (this.mode === 'manual') {
      if (this.cursor < 0 || this.cursor >= lines.length) return [];
      // 구분자('--') 줄은 화면을 통째로 비운다. 간주에 쓰라고 만든 것이므로
      // 다음 줄 미리보기까지 지워야 이름값을 한다.
      if (lines[this.cursor]!.text === '') return [];
      if (layoutMode === 'dual-alternate') {
        return [this.cursor, this.cursor + 1].filter((i) => i < lines.length);
      }
      const count = Math.max(1, this.preset.layout.linesVisible);
      const out: number[] = [];
      for (let i = 0; i < count && this.cursor + i < lines.length; i++) out.push(this.cursor + i);
      return out;
    }

    const active = findActiveLineIndex(lines, timeMs);
    const mode = layoutMode;

    if (mode === 'dual-alternate') {
      // 노래방은 '현재 줄 + 다음 줄' 두 줄을 항상 함께 보여준다
      let base = active;
      if (base < 0) {
        const next = findNextLineIndex(lines, timeMs);
        if (next < 0 || lines[next]!.startMs - timeMs > PREROLL_MS) return [];
        base = next;
      }
      // 항상 슬롯 0(좌) 이 먼저 오도록 짝을 맞춘다
      const pair = [base, base + 1].filter((i) => i < lines.length);
      return pair;
    }

    if (active < 0) return [];
    const count = Math.max(1, this.preset.layout.linesVisible);
    const out: number[] = [];
    for (let i = 0; i < count && active + i < lines.length; i++) out.push(active + i);
    return out;
  }

  // -------------------------------------------------------------------------
  // 블록 DOM 동기화
  // -------------------------------------------------------------------------

  private syncBlocks(visibleIndices: number[], _timeMs: number): void {
    const lines = this.project?.lines ?? [];
    const wanted = new Map<string, number>();
    for (const idx of visibleIndices) {
      const line = lines[idx];
      if (line) wanted.set(line.id, idx);
    }

    // 사라진 줄 제거
    for (const [id, handle] of this.blocks) {
      if (!wanted.has(id) && !handle.exiting) {
        this.removeBlock(handle);
      }
    }

    // 새로 등장한 줄 추가
    let added = false;
    for (const [id, idx] of wanted) {
      const existing = this.blocks.get(id);
      if (existing && !existing.exiting) continue;
      if (existing?.exiting) {
        // 되감기 등으로 방금 지운 줄이 다시 필요해진 경우
        existing.el.remove();
        this.blocks.delete(id);
      }
      this.createBlock(lines[idx]!, idx);
      added = true;
    }

    if (added) {
      this.reorderSlots();
      this.needsMeasure = true;
    }
  }

  private createBlock(line: LyricLine, lineIndex: number): void {
    const p = this.preset;
    const slotIndex = p.layout.mode === 'dual-alternate' ? lineIndex % 2 : 0;
    const slot = this.slotEls[slotIndex] ?? this.slotEls[0]!;
    const align = slot.dataset.align ?? 'center';

    const block = el('div', 'yl-block');
    block.dataset.lineId = line.id;
    block.dataset.lineIndex = String(lineIndex);
    block.dataset.bg = p.background.type;
    block.style.setProperty(
      '--yl-fit-origin',
      align === 'left' ? 'left bottom' : align === 'right' ? 'right bottom' : 'center bottom',
    );

    // --- 메인 줄 ---
    const mainSource = p.layers[0]!.source;
    const mainText = this.resolveText(line, mainSource);
    const wordEls: HTMLElement[] = [];
    const sungWordEls: HTMLElement[] = [];
    const stagger = p.animation.staggerMs;
    let sungEl: HTMLElement | null = null;

    // 빈 줄(간주 구분자)은 아무것도 그리지 않는다
    if (mainText.length > 0) {
      const mainRow = el('div', 'yl-row');
      mainRow.dataset.role = 'main';
      const mainScale = el('div', 'yl-scale');

      const base = el('div', 'yl-text yl-base');
      fillTokens(base, mainText, wordEls);
      mainScale.appendChild(base);

      if (p.karaoke.enabled) {
        sungEl = el('div', 'yl-text yl-sung');
        fillTokens(sungEl, mainText, sungWordEls);
        sungEl.style.clipPath = 'inset(0 100% 0 0)';
        mainScale.appendChild(sungEl);
      }

      if (stagger > 0) {
        // transform 은 inline 요소에 먹지 않는다. 단어별 효과를 쓸 때만 켠다 —
        // 항상 inline-block 으로 두면 평소 텍스트 렌더링에 괜한 변수가 생긴다.
        base.classList.add('yl-stagger');
        sungEl?.classList.add('yl-stagger');
      }

      mainRow.appendChild(mainScale);
      block.appendChild(mainRow);
    }

    // --- 보조 줄 (sub, sub2) ---
    // 내용이 비면 줄 자체를 만들지 않는다. 번역이 없는 곡에서 빈 줄만큼 자리가 떠 있으면
    // 가사 위치가 곡마다 달라 보인다.
    for (const role of ['sub', 'sub2'] as const) {
      const layer = p.layers.find((l) => l.role === role);
      if (!layer || layer.source === 'none') continue;

      const text = this.resolveText(line, layer.source);
      if (text.trim().length === 0) continue;

      const row = el('div', 'yl-row');
      row.dataset.role = role;
      const scale = el('div', 'yl-scale');
      const base = el('div', 'yl-text yl-base');
      base.textContent = text;
      scale.appendChild(base);
      row.appendChild(scale);
      block.appendChild(row);
    }

    slot.appendChild(block);

    const { type, durMs, easing } = p.animation.in;
    if (stagger > 0 && wordEls.length > 0) {
      // 단어가 순서대로 등장한다.
      // base 와 sung 은 픽셀 단위로 겹쳐 있어야 하므로 **같은 지연으로 함께** 움직여야 한다.
      // 한쪽만 움직이면 카라오케 와이프 경계가 어긋난 채로 보인다.
      wordEls.forEach((w, i) => animate(w, type, 'in', durMs, easing, i * stagger));
      sungWordEls.forEach((w, i) => animate(w, type, 'in', durMs, easing, i * stagger));

      // 보조 줄(로마자·번역)은 단어를 쪼개지 않는다. 메인이 절반쯤 흘렀을 때 통째로 따라온다.
      const subDelay = (wordEls.length * stagger) / 2;
      for (const row of block.querySelectorAll<HTMLElement>('.yl-row:not([data-role="main"])')) {
        animate(row, type, 'in', durMs, easing, subDelay);
      }
    } else {
      animate(block, type, 'in', durMs, easing);
    }

    this.blocks.set(line.id, {
      lineIndex,
      lineId: line.id,
      el: block,
      sungEl,
      wordEls,
      wordRects: [],
      mainTextWidth: 0,
      lastClipPx: -1,
      exiting: false,
    });
  }

  private removeBlock(handle: BlockHandle): void {
    handle.exiting = true;

    // 사라지는 동안 자기 자리를 그대로 유지하되, 남는 블록들의 배치에는 영향을 주지 않게 한다.
    // offsetTop 을 먼저 읽고 나서 absolute 로 바꿔야 위치가 어긋나지 않는다.
    const top = handle.el.offsetTop;
    handle.el.style.top = `${top}px`;
    handle.el.classList.add('yl-exiting');

    const { type, durMs, easing } = this.preset.animation.out;
    const anim = animate(handle.el, type, 'out', durMs, easing);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      handle.el.remove();
      if (this.blocks.get(handle.lineId) === handle) this.blocks.delete(handle.lineId);
    };

    if (!anim) {
      finish();
      return;
    }

    anim.addEventListener('finish', finish, { once: true });
    anim.addEventListener('cancel', finish, { once: true });

    // 노드 수명을 애니메이션 이벤트에만 맡기면 안 된다.
    // 백그라운드 탭이나 숨겨진 OBS 소스에서는 WAAPI 가 멈춰 'finish' 가 영원히 오지 않고,
    // 그 사이 지나간 가사가 화면에 그대로 남는다. 타이머로 반드시 회수한다.
    setTimeout(finish, durMs + 100);
  }

  private clearBlocks(immediate: boolean): void {
    for (const handle of this.blocks.values()) {
      if (immediate) handle.el.remove();
      else this.removeBlock(handle);
    }
    if (immediate) this.blocks.clear();
  }

  /** 한 슬롯에 여러 줄이 들어가는 모드에서 DOM 순서를 줄 번호 순으로 맞춘다 */
  private reorderSlots(): void {
    if (this.preset.layout.mode === 'dual-alternate') return;
    const slot = this.slotEls[0];
    if (!slot) return;
    const children = [...slot.children] as HTMLElement[];
    children.sort((a, b) => Number(a.dataset.lineIndex) - Number(b.dataset.lineIndex));
    for (const child of children) slot.appendChild(child);
  }

  private resolveText(line: LyricLine, source: LayerSource): string {
    switch (source) {
      case 'text':
        return line.text;
      case 'translation':
        return line.translation;
      case 'romaja': {
        if (line.romaja) return line.romaja;
        let cached = this.romajaCache.get(line.id);
        if (cached === undefined) {
          cached = romanize(line.text);
          this.romajaCache.set(line.id, cached);
        }
        return cached;
      }
      case 'none':
      default:
        return '';
    }
  }

  // -------------------------------------------------------------------------
  // 측정 (autoFit + 와이프 경계)
  // -------------------------------------------------------------------------

  private measureAll(): void {
    const p = this.preset;
    const stageWidth = this.stageEl.clientWidth;
    if (stageWidth === 0) {
      this.needsMeasure = true;
      return;
    }

    for (const handle of this.blocks.values()) {
      if (handle.exiting) continue;

      for (const row of handle.el.querySelectorAll<HTMLElement>('.yl-row')) {
        const scale = row.querySelector<HTMLElement>('.yl-scale');
        const base = row.querySelector<HTMLElement>('.yl-base');
        if (!scale || !base) continue;

        // 축소 상태에서 재측정하면 값이 누적 왜곡되므로 반드시 원래 크기로 되돌린다
        scale.style.transform = 'none';
        const natural = base.getBoundingClientRect().width / this.currentCanvasScale();

        let fit = 1;
        if (p.layout.autoFit && natural > stageWidth && natural > 0) {
          fit = Math.max(p.layout.autoFitMinScale, stageWidth / natural);
        }
        scale.style.transform = fit === 1 ? 'none' : `scale(${fit})`;

        if (row.dataset.role === 'main') {
          handle.mainTextWidth = natural;
          handle.wordRects = handle.wordEls.map((w) => ({
            left: w.offsetLeft,
            width: w.offsetWidth,
          }));
        }
      }

      handle.lastClipPx = -1; // 다음 프레임에 강제로 다시 그린다
    }
  }

  private currentCanvasScale(): number {
    const { w } = this.preset.canvas;
    const vw = this.root.clientWidth || w;
    const vh = this.root.clientHeight || this.preset.canvas.h;
    return Math.min(vw / w, vh / this.preset.canvas.h) || 1;
  }

  // -------------------------------------------------------------------------
  // 카라오케 와이프
  // -------------------------------------------------------------------------

  private updateKaraoke(timeMs: number): void {
    const lines = this.project!.lines;

    // manual 모드에는 줄 안쪽 진행률이라는 개념이 없다.
    // 현재 줄은 통째로 '부른 색', 다음 줄은 '안 부른 색' — 어디를 부르는지가 한눈에 보인다.
    if (this.mode === 'manual') {
      for (const handle of this.blocks.values()) {
        if (!handle.sungEl || handle.exiting) continue;
        const clipPx = handle.lineIndex === this.cursor ? handle.mainTextWidth : 0;
        if (Math.abs(clipPx - handle.lastClipPx) < 0.5) continue;
        handle.lastClipPx = clipPx;
        const right = Math.max(0, handle.mainTextWidth - clipPx);
        handle.sungEl.style.clipPath = `inset(0 ${right}px 0 0)`;
      }
      return;
    }

    const active = findActiveLineIndex(lines, timeMs);

    for (const handle of this.blocks.values()) {
      if (!handle.sungEl || handle.exiting) continue;

      let clipPx: number;

      if (handle.lineIndex < active) {
        clipPx = handle.mainTextWidth; // 이미 지나간 줄 — 전부 부른 상태
      } else if (handle.lineIndex > active || active < 0) {
        clipPx = 0; // 아직 오지 않은 줄
      } else {
        const line = lines[handle.lineIndex]!;
        const endMs = resolveLineEnd(lines, handle.lineIndex);
        const prog = karaokeProgress(line, endMs, timeMs, this.preset.karaoke.leadMs);

        const rect = prog.wordIndex >= 0 ? handle.wordRects[prog.wordIndex] : undefined;
        clipPx = rect
          ? rect.left + rect.width * prog.wordRatio
          : prog.ratio * handle.mainTextWidth; // 실측 실패 시 글자 수 비례 근사
      }

      // 0.5px 미만 변화는 화면에 보이지 않는다 — 불필요한 스타일 무효화를 막는다
      if (Math.abs(clipPx - handle.lastClipPx) < 0.5) continue;
      handle.lastClipPx = clipPx;

      const right = Math.max(0, handle.mainTextWidth - clipPx);
      handle.sungEl.style.clipPath = `inset(0 ${right}px 0 0)`;
    }
  }
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** 텍스트를 단어/공백 span 으로 쪼개 넣는다. 공백을 별도 노드로 둬야 폭 측정이 정확하다. */
function fillTokens(target: HTMLElement, text: string, collectWords: HTMLElement[]): void {
  target.replaceChildren();
  const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
  for (const token of tokens) {
    const span = document.createElement('span');
    span.textContent = token;
    if (/^\s+$/.test(token)) {
      span.className = 'yl-gap';
    } else {
      span.className = 'yl-word';
      collectWords.push(span);
    }
    target.appendChild(span);
  }
}

function findNextLineIndex(lines: { startMs: number }[], timeMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.startMs > timeMs) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

type Keyframes = Record<string, string[]> | null;

function keyframesFor(type: AnimationType, dir: 'in' | 'out'): Keyframes {
  const fwd = dir === 'in';
  /** in 이면 [시작, 끝], out 이면 뒤집어서 [끝, 시작] */
  const pick = (from: string, to: string): string[] => (fwd ? [from, to] : [to, from]);
  const fade = pick('0', '1');

  switch (type) {
    case 'fade':
      return { opacity: fade };
    case 'slideUp':
    case 'fadeUp':
      return { opacity: fade, transform: pick('translateY(18px)', 'translateY(0)') };
    case 'slideDown':
    case 'fadeDown':
      return { opacity: fade, transform: pick('translateY(-18px)', 'translateY(0)') };
    case 'slideLeft':
      return { opacity: fade, transform: pick('translateX(32px)', 'translateX(0)') };
    case 'slideRight':
      return { opacity: fade, transform: pick('translateX(-32px)', 'translateX(0)') };
    case 'scaleIn':
      return { opacity: fade, transform: pick('scale(0.88)', 'scale(1)') };
    case 'pop':
      // 살짝 넘어갔다 돌아오는 탄성. 중간 키프레임이 있어야 '통' 하는 느낌이 난다.
      return fwd
        ? { opacity: ['0', '1', '1'], transform: ['scale(0.7)', 'scale(1.08)', 'scale(1)'] }
        : { opacity: ['1', '0'], transform: ['scale(1)', 'scale(0.8)'] };
    case 'blurIn':
      return { opacity: fade, filter: pick('blur(10px)', 'blur(0px)') };
    case 'flipIn':
      return {
        opacity: fade,
        transform: pick('perspective(600px) rotateX(-75deg)', 'perspective(600px) rotateX(0deg)'),
      };
    case 'none':
    default:
      return null;
  }
}

function animate(
  target: HTMLElement,
  type: AnimationType,
  dir: 'in' | 'out',
  durMs: number,
  easing: string,
  delayMs = 0,
): Animation | null {
  const kf = keyframesFor(type, dir);
  if (!kf || durMs <= 0 || typeof target.animate !== 'function') return null;
  return target.animate(kf as Keyframe[] | PropertyIndexedKeyframes, {
    duration: durMs,
    easing,
    delay: delayMs,
    fill: 'both',
  });
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ELEMENT_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = BASE_CSS + LAYER_CSS;
  doc.head.appendChild(style);
}
