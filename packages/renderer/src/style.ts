import type { FontSpec, Preset, PresetLayer, Shadow, Stroke } from '@yulyrics/core';

/**
 * 렌더러 기본 스타일.
 *
 * 외곽선은 `-webkit-text-stroke` + `paint-order: stroke fill` 로 그린다.
 * paint-order 없이 text-stroke 만 쓰면 선이 글자 안쪽을 파고들어 한글 획이 뭉개진다.
 * OBS 는 Chromium(CEF) 이므로 두 속성 모두 안전하게 쓸 수 있다.
 *
 * text-stroke 는 획을 글자 경계 **중앙**에 그리므로, 바깥으로 W px 를 보이게 하려면
 * 두께를 2W 로 줘야 한다. (안쪽 절반은 fill 이 덮는다)
 */
export const BASE_CSS = `
.yl-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: transparent;
  pointer-events: none;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.yl-canvas {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

.yl-stage {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: var(--yl-block-gap);
}

.yl-slot {
  position: relative; /* 퇴장 중인 블록을 절대 배치로 띄우기 위한 기준 */
  display: flex;
  flex-direction: column;
  gap: var(--yl-line-gap);
  width: 100%;
  align-items: var(--yl-align);
}

/*
 * 퇴장 중인 블록은 레이아웃에서 빼낸다.
 * 좌우 교대 배치에서 N번 줄이 빠지는 슬롯에 곧바로 N+2번 줄이 들어오는데,
 * 퇴장 블록이 자리를 계속 차지하면 두 줄이 잠깐 쌓여 슬롯 높이가 튄다.
 * (실측: 36px → 77px) 줄을 넘길 때마다 자막이 밀렸다 돌아오는 원인이었다.
 */
.yl-block.yl-exiting {
  position: absolute;
  left: 0;
  right: 0;
  width: auto;
  pointer-events: none;
}
.yl-slot[data-align="left"]   { --yl-align: flex-start; text-align: left; }
.yl-slot[data-align="center"] { --yl-align: center;     text-align: center; }
.yl-slot[data-align="right"]  { --yl-align: flex-end;   text-align: right; }

/*
 * width:100% 인 블록이 슬롯의 align-items 를 무력화하므로
 * 정렬을 --yl-align 로 블록까지 내려보낸다. 이게 없으면 2행이 우측 정렬되지 않는다.
 */
.yl-block {
  display: flex;
  flex-direction: column;
  gap: var(--yl-line-gap);
  width: 100%;
  align-items: var(--yl-align);
  will-change: opacity, transform;
}

.yl-row {
  position: relative;
  display: inline-flex;
  max-width: 100%;
}

/* autoFit 축소용. transform 만 건드려 레이아웃을 다시 계산하지 않는다. */
.yl-scale {
  position: relative;
  display: inline-block;
  transform-origin: var(--yl-fit-origin, center bottom);
  will-change: transform;
}

.yl-text {
  display: block;
  white-space: pre;
  margin: 0;
  paint-order: stroke fill;
}

/* 카라오케 '부른 부분' 레이어 — base 위에 정확히 포개고 좌→우로 잘라낸다 */
.yl-text.yl-sung {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  will-change: clip-path;
}

.yl-bg {
  position: absolute;
  inset: 0;
  z-index: -1;
}

/* 단어별 등장 효과를 쓸 때만 켠다 (transform 은 inline 요소에 적용되지 않는다) */
.yl-text.yl-stagger .yl-word {
  display: inline-block;
}

.yl-hidden { display: none !important; }
`;

function cssShadows(shadows: Shadow[]): string {
  if (shadows.length === 0) return 'none';
  return shadows.map((s) => `${s.x}px ${s.y}px ${s.blur}px ${s.color}`).join(', ');
}

function cssStrokeWidth(stroke: Stroke | null): string {
  // 바깥으로 보이는 두께의 2배를 줘야 실제로 그만큼 보인다 (위 주석 참고)
  return stroke ? `${stroke.widthPx * 2}px` : '0px';
}

function fontVars(prefix: string, font: FontSpec): Record<string, string> {
  return {
    [`${prefix}-family`]: font.family,
    [`${prefix}-size`]: `${font.sizePx}px`,
    [`${prefix}-weight`]: String(font.weight),
    [`${prefix}-style`]: font.italic ? 'italic' : 'normal',
    [`${prefix}-spacing`]: `${font.letterSpacing}em`,
    [`${prefix}-line-height`]: String(font.lineHeight),
  };
}

function layerVars(prefix: string, layer: PresetLayer): Record<string, string> {
  return {
    ...fontVars(prefix, layer.font),
    [`${prefix}-fill`]: layer.fill,
    [`${prefix}-stroke-color`]: layer.stroke?.color ?? 'transparent',
    [`${prefix}-stroke-width`]: cssStrokeWidth(layer.stroke),
    [`${prefix}-shadow`]: cssShadows(layer.shadows),
    [`${prefix}-opacity`]: String(layer.opacity),
  };
}

/**
 * 프리셋을 CSS 변수 묶음으로 변환한다.
 *
 * 프리셋 변경을 CSS 변수 갱신만으로 처리하는 것이 핵심이다.
 * 그래야 프리셋 에디터에서 슬라이더를 드래그하는 동안
 * DOM 재생성 없이 송출 중인 OBS 화면까지 실시간으로 따라온다.
 */
export function presetToVars(preset: Preset): Record<string, string> {
  const main = preset.layers.find((l) => l.role === 'main')!;
  const sub = preset.layers.find((l) => l.role === 'sub')!;
  const sub2 = preset.layers.find((l) => l.role === 'sub2') ?? sub;

  return {
    ...layerVars('--yl-main', main),
    ...layerVars('--yl-sub', sub),
    ...layerVars('--yl-sub2', sub2),
    '--yl-sung-fill': preset.karaoke.sungFill,
    '--yl-sung-stroke': preset.karaoke.sungStroke ?? main.stroke?.color ?? 'transparent',
    '--yl-line-gap': `${preset.layout.lineGap}px`,
    '--yl-block-gap': `${preset.layout.blockGap}px`,
    '--yl-bg-color': preset.background.color,
    '--yl-bg-radius': `${preset.background.radius}px`,
    // calc() 로 음수화해야 하므로 방향별로 나눠 둔다 (shorthand 는 calc 불가)
    '--yl-bg-pad-t': `${preset.background.padding[0]}px`,
    '--yl-bg-pad-r': `${preset.background.padding[1]}px`,
    '--yl-bg-pad-b': `${preset.background.padding[2]}px`,
    '--yl-bg-pad-l': `${preset.background.padding[3]}px`,
  };
}

/** 프리셋 변수를 실제 텍스트 속성에 연결하는 규칙 (BASE_CSS 뒤에 붙는다) */
export const LAYER_CSS = `
.yl-row[data-role="main"] .yl-text {
  font-family: var(--yl-main-family);
  font-size: var(--yl-main-size);
  font-weight: var(--yl-main-weight);
  font-style: var(--yl-main-style);
  letter-spacing: var(--yl-main-spacing);
  line-height: var(--yl-main-line-height);
  color: var(--yl-main-fill);
  -webkit-text-stroke: var(--yl-main-stroke-width) var(--yl-main-stroke-color);
  text-shadow: var(--yl-main-shadow);
  opacity: var(--yl-main-opacity);
}

.yl-row[data-role="main"] .yl-text.yl-sung {
  color: var(--yl-sung-fill);
  -webkit-text-stroke-color: var(--yl-sung-stroke);
}

.yl-row[data-role="sub"] .yl-text {
  font-family: var(--yl-sub-family);
  font-size: var(--yl-sub-size);
  font-weight: var(--yl-sub-weight);
  font-style: var(--yl-sub-style);
  letter-spacing: var(--yl-sub-spacing);
  line-height: var(--yl-sub-line-height);
  color: var(--yl-sub-fill);
  -webkit-text-stroke: var(--yl-sub-stroke-width) var(--yl-sub-stroke-color);
  text-shadow: var(--yl-sub-shadow);
  opacity: var(--yl-sub-opacity);
}

.yl-row[data-role="sub2"] .yl-text {
  font-family: var(--yl-sub2-family);
  font-size: var(--yl-sub2-size);
  font-weight: var(--yl-sub2-weight);
  font-style: var(--yl-sub2-style);
  letter-spacing: var(--yl-sub2-spacing);
  line-height: var(--yl-sub2-line-height);
  color: var(--yl-sub2-fill);
  -webkit-text-stroke: var(--yl-sub2-stroke-width) var(--yl-sub2-stroke-color);
  text-shadow: var(--yl-sub2-shadow);
  opacity: var(--yl-sub2-opacity);
}

.yl-block[data-bg="solid"] .yl-row::before,
.yl-block[data-bg="bar"] .yl-row::before {
  content: "";
  position: absolute;
  inset: 0;
  margin: calc(-1 * var(--yl-bg-pad-t)) calc(-1 * var(--yl-bg-pad-r))
          calc(-1 * var(--yl-bg-pad-b)) calc(-1 * var(--yl-bg-pad-l));
  background: var(--yl-bg-color);
  border-radius: var(--yl-bg-radius);
  z-index: -1;
}
.yl-block[data-bg="bar"] .yl-row::before {
  left: -50vw;
  right: -50vw;
  border-radius: 0;
}
`;
