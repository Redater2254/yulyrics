# 번들 폰트

여기 있는 폰트는 **전부 SIL Open Font License 1.1** 이며, 프로그램과 함께 재배포할 수 있다.
라이선스 원문은 `licenses/` 에 폰트별로 동봉되어 있다 (OFL 의 의무 조항).

| 파일 | 패밀리 | 저작권 | 출처 |
|---|---|---|---|
| `Jua-Regular.ttf` | Jua | The Jua Project Authors | https://fonts.google.com/specimen/Jua |
| `DoHyeon-Regular.ttf` | Do Hyeon | The Do Hyeon Project Authors | https://fonts.google.com/specimen/Do+Hyeon |
| `BlackHanSans-Regular.ttf` | Black Han Sans | The Black Han Sans Project Authors | https://fonts.google.com/specimen/Black+Han+Sans |
| `BagelFatOne-Regular.ttf` | Bagel Fat One | The Bagel Fat Project Authors | https://fonts.google.com/specimen/Bagel+Fat+One |
| `Pretendard-Black.otf` | Pretendard | Kil Hyung-jin | https://github.com/orioncactus/pretendard |
| `Montserrat-Italic.ttf` | Montserrat | The Montserrat Project Authors | https://fonts.google.com/specimen/Montserrat |

## 폰트를 추가할 때

1. **라이선스를 먼저 확인한다.** 이 폰트들은 로컬 서버가 OBS 로 내려보내므로 명백한 재배포다.
   "무료 사용 가능"과 "재배포 가능"은 다르다. 재배포가 허용되지 않으면 넣지 말 것.
2. 파일을 이 폴더에 넣고 `licenses/` 에 라이선스 원문을 동봉한다.
3. `packages/presets/src/fonts.ts` 의 `BUNDLED_FONTS` 에 항목을 추가한다.
4. 서버를 재시작하면 `/fonts/fonts.css` 에 `@font-face` 가 자동 생성된다.

사용자가 자기 PC에 설치된 폰트를 쓰고 싶다면 프리셋의 `font.family` 에 시스템 폰트명을
직접 적으면 된다. 그건 재배포가 아니므로 라이선스 문제가 없다.

## 웨이트 주의

여기 있는 한글 폰트는 **웨이트가 하나뿐**이다 (Pretendard 제외).
프리셋에서 `weight` 를 700 이상으로 주면 브라우저가 **가짜 볼드를 합성**해
획이 뭉개지고 원본보다 훨씬 굵어진다. 굵게 만들고 싶으면 웨이트를 올리지 말고
Black Han Sans 처럼 원래 굵은 폰트를 고를 것.
