/**
 * 번들 폰트 매니페스트.
 *
 * 원칙: **OFL(SIL Open Font License) 등 자유 재배포가 명시된 폰트만 넣는다.**
 * 프로그램과 함께 배포되고 OBS 브라우저 소스가 로컬 서버에서 내려받으므로,
 * 재배포 권한이 없는 폰트를 넣으면 그대로 라이선스 위반이 된다.
 *
 * 사용자가 자기 PC의 폰트를 쓰고 싶으면 프리셋의 font.family 에
 * 시스템 폰트명을 직접 적으면 된다 (그건 재배포가 아니므로 문제없다).
 */
export interface BundledFont {
  /** CSS font-family 로 쓰는 이름 */
  family: string;
  /** packages/presets/fonts/ 안의 파일명 */
  file: string;
  weight: number;
  style: 'normal' | 'italic';
  /** UI 에 표시할 설명 */
  label: string;
  license: string;
  source: string;
}

/**
 * 주의: 여기 있는 한글 폰트는 모두 **400 웨이트 하나뿐**이다.
 * 프리셋에서 weight 를 700 이상으로 주면 브라우저가 가짜 볼드를 합성해
 * 획이 뭉뚱그려지고 원본보다 훨씬 굵어진다. 굵은 폰트가 필요하면
 * weight 를 올리지 말고 Black Han Sans 처럼 굵은 폰트를 고를 것.
 */
export const BUNDLED_FONTS: BundledFont[] = [
  {
    family: 'Jua',
    file: 'Jua-Regular.ttf',
    weight: 400,
    style: 'normal',
    label: '주아 (둥근 손글씨체)',
    license: 'SIL OFL 1.1',
    source: 'https://fonts.google.com/specimen/Jua',
  },
  {
    family: 'Do Hyeon',
    file: 'DoHyeon-Regular.ttf',
    weight: 400,
    style: 'normal',
    label: '도현 (각진 굵은 고딕)',
    license: 'SIL OFL 1.1',
    source: 'https://fonts.google.com/specimen/Do+Hyeon',
  },
  {
    family: 'Black Han Sans',
    file: 'BlackHanSans-Regular.ttf',
    weight: 400,
    style: 'normal',
    label: '검은고딕 (초굵은 고딕)',
    license: 'SIL OFL 1.1',
    source: 'https://fonts.google.com/specimen/Black+Han+Sans',
  },
  {
    family: 'Bagel Fat One',
    file: 'BagelFatOne-Regular.ttf',
    weight: 400,
    style: 'normal',
    label: '베이글팻원 (통통한 라운드)',
    license: 'SIL OFL 1.1',
    source: 'https://fonts.google.com/specimen/Bagel+Fat+One',
  },
  {
    family: 'Pretendard',
    file: 'Pretendard-Black.otf',
    weight: 900,
    style: 'normal',
    label: '프리텐다드 Black (범용 고딕)',
    license: 'SIL OFL 1.1',
    source: 'https://github.com/orioncactus/pretendard',
  },
  {
    family: 'Montserrat',
    file: 'Montserrat-Italic.ttf',
    // 가변 폰트 — 100~900 을 한 파일이 모두 커버한다
    weight: 0,
    style: 'italic',
    label: 'Montserrat Italic (영문 가변)',
    license: 'SIL OFL 1.1',
    source: 'https://fonts.google.com/specimen/Montserrat',
  },
];

function formatOf(file: string): string {
  if (file.endsWith('.otf')) return 'opentype';
  if (file.endsWith('.woff2')) return 'woff2';
  return 'truetype';
}

/**
 * @font-face 스타일시트를 생성한다.
 * 오버레이·컨트롤 패널·프리셋 에디터가 같은 CSS 를 쓰므로 규칙이 한 곳에만 존재한다.
 */
export function buildFontFaceCss(urlPrefix = '/fonts/'): string {
  return BUNDLED_FONTS.map((font) => {
    // 가변 폰트는 weight 를 범위로 선언해야 브라우저가 합성 굵기를 쓰지 않는다
    const weight = font.weight === 0 ? '100 900' : String(font.weight);
    return [
      '@font-face {',
      `  font-family: "${font.family}";`,
      `  src: url("${urlPrefix}${font.file}") format("${formatOf(font.file)}");`,
      `  font-weight: ${weight};`,
      `  font-style: ${font.style};`,
      '  font-display: block;',
      '}',
    ].join('\n');
  }).join('\n\n');
}
