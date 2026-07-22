import type {
  FontSpec,
  LayerRole,
  PartialPreset,
  Preset,
  PresetAnimation,
  PresetBackground,
  PresetKaraoke,
  PresetLayer,
  PresetLayout,
  Stroke,
} from './types.js';

export const PRESET_SCHEMA_VERSION = 1;

export const DEFAULT_FONT: FontSpec = {
  family: 'Pretendard, "Malgun Gothic", sans-serif',
  sizePx: 72,
  weight: 700,
  italic: false,
  letterSpacing: 0,
  lineHeight: 1.25,
};

const DEFAULT_LAYOUT: PresetLayout = {
  mode: 'stacked-center',
  anchor: 'bottom',
  offset: { x: 0, y: -80 },
  maxWidthPct: 88,
  lineGap: 10,
  blockGap: 24,
  linesVisible: 1,
  autoFit: true,
  autoFitMinScale: 0.55,
};

const DEFAULT_KARAOKE: PresetKaraoke = {
  enabled: false,
  mode: 'wipe',
  unit: 'word',
  sungFill: '#FFFFFF',
  sungStroke: null,
  leadMs: 0,
};

const DEFAULT_ANIMATION: PresetAnimation = {
  in: { type: 'slideUp', durMs: 220, easing: 'cubic-bezier(.2,.8,.2,1)' },
  out: { type: 'fade', durMs: 180, easing: 'ease-out' },
  staggerMs: 0,
};

const DEFAULT_BACKGROUND: PresetBackground = {
  type: 'none',
  color: '#000000AA',
  padding: [8, 20, 8, 20],
  radius: 8,
};

function normalizeFont(raw: Partial<FontSpec> | undefined): FontSpec {
  return { ...DEFAULT_FONT, ...(raw ?? {}) };
}

function normalizeStroke(raw: Partial<Stroke> | null | undefined): Stroke | null {
  if (raw === null || raw === undefined) return null;
  return { color: raw.color ?? '#000000', widthPx: raw.widthPx ?? 4 };
}

function normalizeLayer(raw: Partial<PresetLayer> | undefined, role: LayerRole): PresetLayer {
  return {
    role,
    source: raw?.source ?? (role === 'main' ? 'text' : 'none'),
    font: normalizeFont(raw?.font),
    fill: raw?.fill ?? '#FFFFFF',
    stroke: normalizeStroke(raw?.stroke),
    shadows: raw?.shadows ?? [],
    opacity: raw?.opacity ?? 1,
  };
}

/**
 * 파일/네트워크에서 온 프리셋을 완전한 Preset 으로 채운다.
 *
 * 관용적으로 동작하는 것이 의도다 — 모르는 필드는 버리고, 없는 필드는 기본값을 넣는다.
 * 사용자가 손으로 편집한 .ypreset 이 필드 하나 빠졌다고 앱이 죽으면 안 된다.
 */
export function normalizePreset(raw: PartialPreset): Preset {
  const rawLayers = Array.isArray(raw.layers) ? raw.layers : [];
  const main = rawLayers.find((l) => l?.role === 'main') ?? rawLayers[0];
  const sub = rawLayers.find((l) => l?.role === 'sub') ?? rawLayers[1];
  // sub2 는 나중에 추가됐다. 예전 프리셋 파일에는 없으므로 기본값(source: 'none')으로 채운다.
  const sub2 = rawLayers.find((l) => l?.role === 'sub2') ?? rawLayers[2];

  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    author: raw.author ?? '',
    version: raw.version ?? PRESET_SCHEMA_VERSION,
    builtin: raw.builtin ?? false,
    canvas: { w: raw.canvas?.w ?? 1920, h: raw.canvas?.h ?? 1080 },
    layout: { ...DEFAULT_LAYOUT, ...(raw.layout ?? {}) },
    layers: [
      normalizeLayer(main, 'main'),
      normalizeLayer(sub, 'sub'),
      normalizeLayer(sub2, 'sub2'),
    ],
    karaoke: { ...DEFAULT_KARAOKE, ...(raw.karaoke ?? {}) },
    animation: {
      in: { ...DEFAULT_ANIMATION.in, ...(raw.animation?.in ?? {}) },
      out: { ...DEFAULT_ANIMATION.out, ...(raw.animation?.out ?? {}) },
      staggerMs: Math.max(0, raw.animation?.staggerMs ?? 0),
    },
    background: { ...DEFAULT_BACKGROUND, ...(raw.background ?? {}) },
    safeArea: {
      top: raw.safeArea?.top ?? 48,
      right: raw.safeArea?.right ?? 64,
      bottom: raw.safeArea?.bottom ?? 48,
      left: raw.safeArea?.left ?? 64,
    },
  };
}

/** 기본 프리셋을 사용자 편집용으로 복제한다. */
export function clonePreset(preset: Preset, newId: string, newName?: string): Preset {
  const copy = structuredClone(preset);
  copy.id = newId;
  copy.name = newName ?? `${preset.name} 복사본`;
  copy.builtin = false;
  return copy;
}

/** 파일명·URL 파라미터로 안전한 ID 생성 */
export function slugifyPresetId(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `preset-${Math.random().toString(36).slice(2, 8)}`;
}
