/**
 * 한글 → 로마자 변환 (국립국어원 로마자 표기법 기반).
 *
 * 참고 이미지(프리셋 1)처럼 **음절 단위로 띄어쓰고, 어절 사이는 2칸** 띄운다:
 *   전에 자주 비행했었잖아  →  jeo ne  ja ju  bi haeng hae seot jan a
 *
 * 완벽한 발음 변환은 형태소 분석 없이는 불가능하다(예: 맏이→마지, 국물→궁물).
 * 여기서는 실무에서 가장 자주 걸리는 **연음(liaison)** 만 처리하고,
 * 나머지는 사람이 고치도록 둔다. 결과는 항상 편집 가능해야 한다.
 */

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JUNG_COUNT = 21;
const JONG_COUNT = 28;

/** 초성 19개 */
const ONSET = [
  'g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp',
  's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h',
];

/** 중성 21개 */
const NUCLEUS = [
  'a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae',
  'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i',
];

/**
 * 종성 28개.
 *  - `end`  : 뒤에 자음이 오거나 어절이 끝날 때의 표기
 *  - `keep` : 뒤에 모음이 와서 연음될 때, 이 음절에 남는 표기
 *  - `move` : 뒤 음절 초성으로 넘어가는 표기 (null = 연음 없음)
 */
const CODA: { end: string; keep: string; move: string | null }[] = [
  { end: '',   keep: '',  move: null },  //
  { end: 'k',  keep: '',  move: 'g' },   // ㄱ
  { end: 'k',  keep: '',  move: 'kk' },  // ㄲ
  { end: 'k',  keep: 'k', move: 's' },   // ㄳ
  { end: 'n',  keep: '',  move: 'n' },   // ㄴ
  { end: 'n',  keep: 'n', move: 'j' },   // ㄵ
  { end: 'n',  keep: '',  move: 'n' },   // ㄶ  (ㅎ 탈락: 많아→마나)
  { end: 't',  keep: '',  move: 'd' },   // ㄷ
  { end: 'l',  keep: '',  move: 'r' },   // ㄹ
  { end: 'k',  keep: 'l', move: 'g' },   // ㄺ
  { end: 'm',  keep: 'l', move: 'm' },   // ㄻ
  { end: 'l',  keep: 'l', move: 'b' },   // ㄼ
  { end: 'l',  keep: 'l', move: 's' },   // ㄽ
  { end: 'l',  keep: 'l', move: 't' },   // ㄾ
  { end: 'p',  keep: 'l', move: 'p' },   // ㄿ
  { end: 'l',  keep: '',  move: 'r' },   // ㅀ  (ㅎ 탈락: 싫어→시러)
  { end: 'm',  keep: '',  move: 'm' },   // ㅁ
  { end: 'p',  keep: '',  move: 'b' },   // ㅂ
  { end: 'p',  keep: 'p', move: 's' },   // ㅄ
  { end: 't',  keep: '',  move: 's' },   // ㅅ
  { end: 't',  keep: '',  move: 'ss' },  // ㅆ
  { end: 'ng', keep: 'ng', move: null }, // ㅇ  (받침 ㅇ 은 넘어가지 않는다)
  { end: 't',  keep: '',  move: 'j' },   // ㅈ
  { end: 't',  keep: '',  move: 'ch' },  // ㅊ
  { end: 'k',  keep: '',  move: 'k' },   // ㅋ
  { end: 't',  keep: '',  move: 't' },   // ㅌ
  { end: 'p',  keep: '',  move: 'p' },   // ㅍ
  { end: 't',  keep: '',  move: '' },    // ㅎ  (좋아→조아)
];

export interface RomajaToken {
  /** 원본 음절 1글자 (한글이 아니면 원본 그대로) */
  char: string;
  /** 로마자 표기 */
  roman: string;
  /** 이 토큰 뒤가 어절 경계인가 */
  wordBreak: boolean;
}

interface Decomposed {
  onset: number;
  nucleus: number;
  coda: number;
}

function decompose(ch: string): Decomposed | null {
  const code = ch.codePointAt(0);
  if (code === undefined || code < HANGUL_BASE || code > HANGUL_LAST) return null;
  const offset = code - HANGUL_BASE;
  return {
    onset: Math.floor(offset / (JUNG_COUNT * JONG_COUNT)),
    nucleus: Math.floor(offset / JONG_COUNT) % JUNG_COUNT,
    coda: offset % JONG_COUNT,
  };
}

export function isHangulSyllable(ch: string): boolean {
  return decompose(ch) !== null;
}

/**
 * 음절 단위 로마자 토큰 배열을 만든다.
 * 연음 판단을 위해 다음 글자를 미리 보므로 문자열 전체를 한 번에 처리한다.
 */
export function romanizeTokens(text: string): RomajaToken[] {
  const chars = [...text];
  const tokens: RomajaToken[] = [];

  /** 앞 음절에서 넘어온 초성 */
  let carried: string | null = null;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;

    if (/\s/.test(ch)) {
      // 공백은 토큰이 아니라 직전 토큰의 어절 경계 플래그로 표현한다
      const prev = tokens[tokens.length - 1];
      if (prev) prev.wordBreak = true;
      carried = null;
      continue;
    }

    const cur = decompose(ch);
    if (!cur) {
      // 한글이 아닌 글자(영문·숫자·문장부호)는 그대로 통과
      tokens.push({ char: ch, roman: (carried ?? '') + ch, wordBreak: false });
      carried = null;
      continue;
    }

    const next = i + 1 < chars.length ? decompose(chars[i + 1]!) : null;
    // 다음 음절이 'ㅇ' 초성(index 11) 으로 시작해야 연음이 일어난다
    const nextIsVowelOnset = next !== null && next.onset === 11;

    const coda = CODA[cur.coda]!;
    const onset = carried !== null ? carried : ONSET[cur.onset]!;
    const nucleus = NUCLEUS[cur.nucleus]!;

    let tail: string;
    if (nextIsVowelOnset && coda.move !== null) {
      tail = coda.keep;
      carried = coda.move;
    } else {
      tail = coda.end;
      carried = null;
    }

    tokens.push({ char: ch, roman: onset + nucleus + tail, wordBreak: false });
  }

  const last = tokens[tokens.length - 1];
  if (last) last.wordBreak = false;
  return tokens;
}

/**
 * 프리셋 1 스타일의 로마자 문자열.
 * 음절 사이 1칸, 어절 사이 2칸.
 */
export function romanize(text: string): string {
  const tokens = romanizeTokens(text);
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    out += tok.roman;
    if (i < tokens.length - 1) out += tok.wordBreak ? '  ' : ' ';
  }
  return out;
}
