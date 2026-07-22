import type { LyricLine, Project } from '@yulyrics/core';

/**
 * 데모 곡.
 *
 * 목적은 단 하나 — 프로그램을 처음 켠 사람이 아무것도 준비하지 않고도
 * OBS 브라우저 소스에 URL 만 넣어서 "가사가 나온다"를 확인하게 하는 것.
 * 음원 없이 서버 내부 타이머만으로 재생된다.
 */

function line(
  id: string,
  startMs: number,
  endMs: number,
  text: string,
  translation: string,
): LyricLine {
  return { id, startMs, endMs, text, romaja: '', translation, words: null };
}

export const DEMO_PROJECT: Project = {
  version: 1,
  id: 'demo',
  meta: {
    title: '데모 트랙',
    artist: 'yulyrics',
    album: '',
    coverPath: '',
    durationMs: 24_000,
  },
  audio: { type: 'none', src: '', offsetMs: 0 },
  presetId: 'karaoke-classic',
  mode: 'timeline',
  lines: [
    line('d1', 1_000, 5_000, '전에 자주 비행했었잖아', 'We used to fly a lot back then'),
    line('d2', 5_000, 9_000, '친구들과 말썽쟁이', 'Troublemakers with my friends'),
    line('d3', 9_000, 13_000, '난 그냥 내 삶을 지탱해 줄', 'I just need someone in my life'),
    line('d4', 13_000, 17_000, '누군가가 있었으면 해', 'to give it structure'),
    line('d5', 17_000, 21_000, '이 줄이 끝나면 처음으로 돌아갑니다', 'This demo loops from the top'),
  ],
};

export const DEMO_LOOP_MS = 24_000;
