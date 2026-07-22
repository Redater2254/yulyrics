/**
 * yulyrics 데이터 계약.
 *
 * 이 파일이 서버 · 오버레이 · 컨트롤 패널 · 프리셋 에디터의 공통 언어다.
 * 여기 없는 필드는 어디에도 존재해선 안 된다.
 */

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

/** `#RRGGBB` 또는 `#RRGGBBAA` */
export type Color = string;

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  color: Color;
}

export interface Stroke {
  color: Color;
  /** 글자 바깥으로 보이는 두께(px). 렌더러가 내부적으로 2배로 그린다. */
  widthPx: number;
}

export interface FontSpec {
  family: string;
  sizePx: number;
  weight: number;
  italic: boolean;
  /** em 단위 자간 */
  letterSpacing: number;
  /** 배수 (1.2 = 폰트 크기의 120%) */
  lineHeight: number;
}

// ---------------------------------------------------------------------------
// 프리셋
// ---------------------------------------------------------------------------

export type LayoutMode =
  /** 2줄 교차: 홀수줄 좌측, 짝수줄 우측 (노래방 스타일) */
  | 'dual-alternate'
  /** 하단 중앙 스택 (번역 자막 스타일) */
  | 'stacked-center'
  /** 현재 줄 하나만 */
  | 'single-line';

export type Anchor = 'top' | 'center' | 'bottom';
export type Align = 'left' | 'center' | 'right';

export interface PresetLayout {
  mode: LayoutMode;
  anchor: Anchor;
  /** 앵커 기준 픽셀 오프셋. y 음수 = 위로 */
  offset: { x: number; y: number };
  /** 캔버스 너비 대비 텍스트 최대 폭(%) */
  maxWidthPct: number;
  /** 메인 ↔ 보조 줄 간격(px) */
  lineGap: number;
  /** 가사 줄 블록 사이 간격(px) */
  blockGap: number;
  /** 동시에 보이는 가사 줄 수 */
  linesVisible: number;
  /**
   * maxWidthPct 를 넘으면 줄바꿈 대신 폰트를 줄여 한 줄에 맞춘다.
   * 카라오케 와이프는 한 줄을 전제로 하므로 karaoke.enabled 시 사실상 필수.
   */
  autoFit: boolean;
  /** autoFit 축소 하한 (원본 크기 대비 비율) */
  autoFitMinScale: number;
}

/** 각 줄이 무엇을 표시할지 */
export type LayerSource = 'text' | 'romaja' | 'translation' | 'none';

/**
 * 한 가사 블록의 세 줄.
 * 위에서부터 `main` → `sub` → `sub2` 순으로 그린다.
 * 쓰지 않는 줄은 `source: 'none'` 으로 두면 아예 렌더링되지 않는다.
 */
export type LayerRole = 'main' | 'sub' | 'sub2';

export interface PresetLayer {
  role: LayerRole;
  source: LayerSource;
  font: FontSpec;
  fill: Color;
  stroke: Stroke | null;
  shadows: Shadow[];
  opacity: number;
}

export type KaraokeMode = 'wipe' | 'jump' | 'glow';

export interface PresetKaraoke {
  enabled: boolean;
  mode: KaraokeMode;
  /** 워드 타이밍이 없으면 렌더러가 글자 수 비례로 균등 분배한다. */
  unit: 'word' | 'syllable';
  sungFill: Color;
  sungStroke: Color | null;
  /** 진행을 이만큼 앞당긴다(ms). 사람이 부르기 직전에 색이 바뀌는 편이 자연스럽다. */
  leadMs: number;
}

export type AnimationType =
  | 'none'
  | 'fade'
  /** 아래에서 위로 올라오며 등장 */
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  /** 작게 시작해 제자리 크기로 */
  | 'scaleIn'
  /** 살짝 커졌다가 제자리로 — 탄성 */
  | 'pop'
  /** 흐릿하게 시작해 또렷해짐 */
  | 'blurIn'
  /** 세로축 회전 */
  | 'flipIn'
  /** 예전 이름. slideUp / slideDown 과 같다 */
  | 'fadeUp'
  | 'fadeDown';

export interface AnimationStep {
  type: AnimationType;
  durMs: number;
  easing: string;
}

export interface PresetAnimation {
  in: AnimationStep;
  out: AnimationStep;
  /**
   * 단어별 등장 지연(ms). 0이면 줄 전체가 한 번에 나타난다.
   * 값을 주면 단어가 순서대로 흘러나오듯 등장한다.
   */
  staggerMs: number;
}

export type BackgroundType = 'none' | 'solid' | 'bar';

export interface PresetBackground {
  type: BackgroundType;
  color: Color;
  /** [상, 우, 하, 좌] px */
  padding: [number, number, number, number];
  radius: number;
}

export interface Preset {
  id: string;
  name: string;
  author: string;
  /** 스키마 버전. 마이그레이션 판단용 */
  version: number;
  /** 기본 제공 프리셋은 편집 시 자동 복제된다 */
  builtin?: boolean;
  canvas: { w: number; h: number };
  layout: PresetLayout;
  layers: PresetLayer[];
  karaoke: PresetKaraoke;
  animation: PresetAnimation;
  background: PresetBackground;
  safeArea: { top: number; right: number; bottom: number; left: number };
}

/** 파일에서 읽은 미검증 프리셋. normalizePreset() 을 반드시 통과시킬 것. */
export type PartialPreset = Partial<Preset> & { id: string };

// ---------------------------------------------------------------------------
// 곡 프로젝트
// ---------------------------------------------------------------------------

export interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
}

export interface LyricLine {
  id: string;
  startMs: number;
  /** 다음 줄 시작까지 유지하려면 null */
  endMs: number | null;
  text: string;
  romaja: string;
  translation: string;
  /**
   * 화면에는 안 나오고 컨트롤 패널 줄 목록에만 보이는 메모.
   * 사용자가 적은 `(간주중)` 같은 구분자를 그대로 담아둬서,
   * 오퍼레이터가 목록에서 지금 어디쯤인지 알아볼 수 있게 한다.
   */
  note?: string;
  /** 워드 싱크(선택). 없으면 카라오케는 글자 수 비례 추정으로 동작 */
  words: WordTiming[] | null;
}

export type AudioSourceType = 'local' | 'youtube' | 'none';

export interface AudioSource {
  type: AudioSourceType;
  /** local: 절대 경로 / youtube: 영상 URL 또는 ID */
  src: string;
  /** 이 곡 전용 지연 보정(ms). 전역 오프셋과 합산된다. */
  offsetMs: number;
}

/**
 * 재생 방식.
 *
 * - `manual`   : PPT 슬라이드처럼 사람이 스페이스바로 한 줄씩 넘긴다. 타이밍 데이터가 필요 없다.
 *                라이브 노래방송의 기본값 — 곡마다 미리 싱크를 찍어둘 필요가 없다.
 * - `timeline` : 줄마다 찍어둔 시각(startMs)에 맞춰 자동으로 흘러간다. 카라오케 와이프가 가능하다.
 */
export type PlaybackMode = 'manual' | 'timeline';

export interface SongMeta {
  title: string;
  artist: string;
  album: string;
  coverPath: string;
  durationMs: number;
}

export interface Project {
  version: number;
  id: string;
  meta: SongMeta;
  audio: AudioSource;
  presetId: string;
  /** manual 모드면 lines 의 startMs/endMs 는 무시된다 */
  mode: PlaybackMode;
  lines: LyricLine[];
}

// ---------------------------------------------------------------------------
// 실시간 상태 (서버 → 오버레이)
// ---------------------------------------------------------------------------

/** 오버레이가 렌더링에 필요한 전부 */
export interface OverlayState {
  /** 곡이 로드되지 않았으면 null */
  project: Project | null;
  preset: Preset;
  mode: PlaybackMode;
  /**
   * manual 모드에서 현재 줄 번호.
   *  -1          = 아직 시작 전 (빈 화면)
   *  lines.length = 곡 종료 (빈 화면)
   * timeline 모드에서는 무시된다.
   */
  cursor: number;
  playing: boolean;
  /** 재생 위치(ms). 전역+곡별 오프셋이 이미 반영된 값 */
  mediaTimeMs: number;
  /** mediaTimeMs 를 측정한 서버 시각 (Date.now) — 드리프트 보정용 */
  serverTs: number;
  /** 재생 속도 배율 */
  rate: number;
  /** 가사 전체 숨김 */
  hidden: boolean;
}

export type OverlayLayer = 'lyrics' | 'nowplaying' | 'progress';

// ---------------------------------------------------------------------------
// WebSocket 프로토콜
// ---------------------------------------------------------------------------

/** 서버 → 클라이언트 */
export type ServerMessage =
  /** 접속 직후 1회. 전체 상태 */
  | { t: 'hello'; state: OverlayState; clientId: string }
  /** 상태 변화 시. 바뀐 필드만 */
  | { t: 'patch'; state: Partial<OverlayState> }
  /** 200ms 주기. 시계 보정 전용 (경량) */
  | { t: 'tick'; mediaTimeMs: number; serverTs: number; playing: boolean }
  /**
   * 접속 중인 오버레이 수가 바뀜 (컨트롤 패널 배지용).
   * `obsOverlays` 는 그중 실제 OBS 브라우저 소스인 것의 수 —
   * "브라우저 탭으로만 열어놓고 OBS에는 안 넣었다"를 바로 구분할 수 있다.
   */
  | { t: 'peers'; overlays: number; controls: number; obsOverlays: number }
  | { t: 'error'; message: string };

/** 클라이언트 → 서버 */
export type ClientMessage =
  /** 접속 시 역할 신고 */
  | {
      t: 'identify';
      /**
       * `preview` 는 컨트롤 패널 안에 끼워 넣은 미리보기용 오버레이다.
       * 렌더링은 실제 오버레이와 완전히 같지만 연결 수에는 잡히지 않는다 —
       * 미리보기가 카운트되면 "OBS가 붙었나" 배지가 쓸모없어진다.
       */
      role: 'overlay' | 'control' | 'preview';
      layer?: OverlayLayer;
      presetId?: string;
      /** OBS 브라우저 소스 안에서 실행 중인가 (`window.obsstudio` 존재 여부) */
      inObs?: boolean;
    }
  /** 컨트롤 패널의 재생 상태 보고 */
  | { t: 'transport'; playing: boolean; mediaTimeMs: number; rate?: number }
  | { t: 'setProject'; project: Project | null }
  | { t: 'setPreset'; presetId: string }
  /** manual 모드: 특정 줄로 이동 */
  | { t: 'setCursor'; index: number }
  /** manual 모드: 상대 이동. delta +1 = 다음 줄 (스페이스바) */
  | { t: 'moveCursor'; delta: number }
  | { t: 'setMode'; mode: PlaybackMode }
  /** 에디터 실시간 미리보기: 저장하지 않고 프리셋을 통째로 밀어넣는다 */
  | { t: 'previewPreset'; preset: Preset }
  | { t: 'setHidden'; hidden: boolean }
  | { t: 'ping' };
