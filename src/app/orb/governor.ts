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

/**
 * Whether a frame drawn every `every` milliseconds is due at `t` (a
 * requestAnimationFrame time), and if so how late it is: the time past
 * `every`, which counts against the screen as drawing does. Half a 60 Hz
 * frame early is due, so the display rounding to its own frames is not taken
 * for lateness. Null when not due.
 */
export function frameDue(t: number, last: number, every: number): number | null {
  if (last && t - last < every - 8) return null;
  return last ? Math.max(0, t - last - every) : 0;
}
