/**
 * Loudness for the two voices in the conversation.
 *
 * GPT-Live is full duplex, so the driver and Jarvis genuinely overlap. The orb
 * is therefore driven by two continuous levels rather than one enum state —
 * "listening" and "speaking" are not mutually exclusive.
 */
export class VoiceLevels {
  private ctx: AudioContext | null = null;
  private analysers = new Map<"user" | "agent", AnalyserNode>();
  private buffers = new Map<"user" | "agent", Uint8Array<ArrayBuffer>>();
  private smoothed = { user: 0, agent: 0 };

  /** Lazily created so it is born inside the tap that starts the session. */
  private context(): AudioContext {
    this.ctx ??= new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  attach(which: "user" | "agent", stream: MediaStream): void {
    try {
      const ctx = this.context();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      // Some smoothing in the node, the rest in software, so a quiet syllable
      // does not make the orb flicker.
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      this.analysers.set(which, analyser);
      this.buffers.set(which, new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)));
    } catch {
      // Without levels the orb still animates, just without voice reactivity.
    }
  }

  detach(which: "user" | "agent"): void {
    this.analysers.delete(which);
    this.buffers.delete(which);
    this.smoothed[which] = 0;
  }

  /** 0..1, weighted toward speech frequencies and asymmetrically smoothed. */
  read(which: "user" | "agent"): number {
    const analyser = this.analysers.get(which);
    const buf = this.buffers.get(which);
    if (!analyser || !buf) {
      this.smoothed[which] *= 0.9;
      return this.smoothed[which];
    }

    analyser.getByteFrequencyData(buf);
    // Ignore the top of the spectrum: it is mostly hiss and road noise, and
    // including it makes a moving car look like constant speech.
    const bins = Math.floor(buf.length * 0.55);
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += buf[i]!;
    const raw = Math.min(1, sum / bins / 140);

    // Rise fast so a sound registers immediately; fall slowly so the orb does
    // not strobe between syllables.
    const prev = this.smoothed[which];
    this.smoothed[which] = raw > prev ? prev + (raw - prev) * 0.5 : prev + (raw - prev) * 0.12;
    return this.smoothed[which];
  }

  close(): void {
    this.analysers.clear();
    this.buffers.clear();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
