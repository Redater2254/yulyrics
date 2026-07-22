/**
 * 오버레이용 로컬 재생 시계.
 *
 * 서버는 200ms 주기로만 시각을 보낸다. 그 사이를 이 시계가 메꾸지 않으면
 * 카라오케 와이프가 초당 5번 계단처럼 튄다.
 *
 * 보정 정책:
 *   - 오차 > SNAP_THRESHOLD_MS : 다른 지점으로 점프한 것 → 즉시 스냅
 *   - 오차 ≤ SNAP_THRESHOLD_MS : 네트워크 지터 → 매 프레임 조금씩 끌어당김
 */

const SNAP_THRESHOLD_MS = 80;
/** 프레임당 오차를 몇 % 흡수할지. 60fps 에서 80ms 오차가 약 0.6초에 걸쳐 사라진다. */
const DRIFT_CORRECTION_RATE = 0.06;

export class MediaClock {
  private baseMediaMs = 0;
  private baseLocalTs = 0;
  private playing = false;
  private rate = 1;
  /** 서버 시각 - 로컬 시각. 시계가 다른 PC에서도 동작하게 한다. */
  private serverSkew = 0;
  private skewInitialized = false;

  /** 서버 tick/hello 수신 시 호출 */
  sync(mediaTimeMs: number, serverTs: number, playing: boolean, rate = 1): void {
    const localNow = performance.timeOrigin + performance.now();

    if (!this.skewInitialized) {
      this.serverSkew = serverTs - localNow;
      this.skewInitialized = true;
    } else {
      // 스큐 자체도 천천히 따라간다 (급변 방지)
      this.serverSkew += (serverTs - localNow - this.serverSkew) * 0.1;
    }

    // 서버가 측정한 이후 흘러간 시간만큼 보정한 "지금의" 서버 기준 재생 위치
    const elapsedSinceMeasure = localNow + this.serverSkew - serverTs;
    const trueMediaMs = mediaTimeMs + (playing ? elapsedSinceMeasure * rate : 0);

    const predicted = this.now();
    const error = trueMediaMs - predicted;

    this.rate = rate;

    if (!this.playing || playing !== this.playing || Math.abs(error) > SNAP_THRESHOLD_MS) {
      this.baseMediaMs = trueMediaMs;
      this.baseLocalTs = localNow;
    } else {
      this.baseMediaMs = predicted + error * DRIFT_CORRECTION_RATE;
      this.baseLocalTs = localNow;
    }

    this.playing = playing;
  }

  /** 현재 재생 위치(ms) */
  now(): number {
    if (!this.playing) return this.baseMediaMs;
    const localNow = performance.timeOrigin + performance.now();
    return this.baseMediaMs + (localNow - this.baseLocalTs) * this.rate;
  }

  isPlaying(): boolean {
    return this.playing;
  }
}
