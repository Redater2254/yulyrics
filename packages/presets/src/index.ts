import type { PartialPreset, Preset } from '@yulyrics/core';
import { normalizePreset } from '@yulyrics/core';

import karaokeClassic from '../builtin/karaoke-classic.ypreset.json' with { type: 'json' };
import translationSub from '../builtin/translation-sub.ypreset.json' with { type: 'json' };

const RAW: PartialPreset[] = [
  karaokeClassic as PartialPreset,
  translationSub as PartialPreset,
];

/** 기본 제공 프리셋. 사용자 프리셋과 완전히 같은 포맷이며, 특별 취급이 없다. */
export const BUILTIN_PRESETS: Preset[] = RAW.map(normalizePreset);

export * from './fonts.js';

export const DEFAULT_PRESET_ID = 'karaoke-classic';

export function getBuiltinPreset(id: string): Preset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}
