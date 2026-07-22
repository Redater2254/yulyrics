import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PartialPreset, Preset, Project } from '@yulyrics/core';
import { normalizePreset } from '@yulyrics/core';
import { BUILTIN_PRESETS } from '@yulyrics/presets';

import { ensureDir, presetsDir, projectsDir } from './paths.js';

const PRESET_EXT = '.ypreset.json';
const PROJECT_EXT = '.ylrc.json';

function safeFileName(id: string): string {
  // 사용자가 만든 ID 가 경로 탈출에 쓰이지 않게 막는다
  return id.replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
}

// ---------------------------------------------------------------------------
// 프리셋
// ---------------------------------------------------------------------------

export function listUserPresets(): Preset[] {
  ensureDir(presetsDir());
  const out: Preset[] = [];

  for (const name of readdirSync(presetsDir())) {
    if (!name.endsWith(PRESET_EXT)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(presetsDir(), name), 'utf8')) as PartialPreset;
      out.push(normalizePreset({ ...raw, builtin: false }));
    } catch (err) {
      // 프리셋 하나가 깨졌다고 앱이 시작조차 못 하면 안 된다
      console.warn(`[yulyrics] 프리셋 로드 실패: ${name}`, err);
    }
  }
  return out;
}

/** 기본 프리셋 + 사용자 프리셋. 같은 ID 면 사용자 것이 이긴다. */
export function listPresets(): Preset[] {
  const user = listUserPresets();
  const userIds = new Set(user.map((p) => p.id));
  return [...BUILTIN_PRESETS.filter((p) => !userIds.has(p.id)), ...user];
}

export function getPreset(id: string): Preset | undefined {
  return listPresets().find((p) => p.id === id);
}

export function savePreset(preset: Preset): Preset {
  ensureDir(presetsDir());
  const normalized = normalizePreset({ ...preset, builtin: false });
  const path = join(presetsDir(), safeFileName(normalized.id) + PRESET_EXT);
  writeFileSync(path, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

export function deletePreset(id: string): boolean {
  const path = join(presetsDir(), safeFileName(id) + PRESET_EXT);
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 곡 프로젝트
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  title: string;
  artist: string;
  lineCount: number;
}

export function listProjects(): ProjectSummary[] {
  ensureDir(projectsDir());
  const out: ProjectSummary[] = [];

  for (const name of readdirSync(projectsDir())) {
    if (!name.endsWith(PROJECT_EXT)) continue;
    try {
      const p = JSON.parse(readFileSync(join(projectsDir(), name), 'utf8')) as Project;
      out.push({
        id: p.id,
        title: p.meta?.title ?? p.id,
        artist: p.meta?.artist ?? '',
        lineCount: p.lines?.length ?? 0,
      });
    } catch (err) {
      console.warn(`[yulyrics] 프로젝트 로드 실패: ${name}`, err);
    }
  }
  return out;
}

export function getProject(id: string): Project | undefined {
  try {
    const path = join(projectsDir(), safeFileName(id) + PROJECT_EXT);
    return JSON.parse(readFileSync(path, 'utf8')) as Project;
  } catch {
    return undefined;
  }
}

export function saveProject(project: Project): Project {
  ensureDir(projectsDir());
  const path = join(projectsDir(), safeFileName(project.id) + PROJECT_EXT);
  writeFileSync(path, JSON.stringify(project, null, 2), 'utf8');
  return project;
}

export function deleteProject(id: string): boolean {
  try {
    rmSync(join(projectsDir(), safeFileName(id) + PROJECT_EXT));
    return true;
  } catch {
    return false;
  }
}
