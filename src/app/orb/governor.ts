/**
 * Whether a drawing should do less, or may do more, from what its frames
 * cost (the orb, the sky): the median of 90 frames, looked at no more often
 * than every 4 seconds, with wide hysteresis so it settles instead of
 * oscillating. Down (-1) above `high` milliseconds, up (1) below `low`.
 */
export class Governor {
  private frames: number[] = [];
  private last = 0;
  private high: number;
  private low: number;

  constructor(high: number, low: number) {
    this.high = high;
    this.low = low;
  }

  push(cost: number, now = performance.now()): -1 | 0 | 1 {
    this.frames.push(cost);
    if (this.frames.length < 90) return 0;
    if (now - this.last < 4000) {
      this.frames.length = 0;
      return 0;
    }
    this.last = now;
    const sorted = this.frames.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    this.frames.length = 0;
    return median > this.high ? -1 : median < this.low ? 1 : 0;
  }
}
