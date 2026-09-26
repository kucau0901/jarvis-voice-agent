/**
 * How loud Jarvis speaks on this screen.
 *
 * In the car, GPT-Live's voice came out much quieter than music. The volume
 * that made Jarvis clear was far too loud for Spotify, which picks up again the
 * moment a live session ends. An audio element stops at 100%, so the voice is
 * made louder here instead, in Web Audio: a compressor that lifts the quiet
 * syllables, a fixed make-up gain, and a soft clipper that never lets a peak
 * reach full scale. Set the car's volume for the music, then choose the level
 * at which Jarvis is clear.
 *
 * Measured on a speech-like signal (26 Sep 2026): "louder" is about 6 dB up
 * with nothing clipped; "loudest" about 8 dB, with the loudest peaks gently
 * rounded. Beyond that the clipper did audible work, so there is no third step.
 *
 * Per screen, in localStorage: the car needs it, a phone may not. "normal"
 * leaves every sound exactly as it was, not through this at all.
 */

export type Loudness = "normal" | "louder" | "loudest";
export const LOUDNESS: readonly Loudness[] = ["normal", "louder", "loudest"];

interface Shape {
  threshold: number;
  ratio: number;
  knee: number;
  makeupDb: number;
}
const SHAPES: Record<Exclude<Loudness, "normal">, Shape> = {
  louder: { threshold: -30, ratio: 8, knee: 10, makeupDb: 9 },
  loudest: { threshold: -36, ratio: 10, knee: 12, makeupDb: 14 },
};

const KEY = "jarvis.voiceLoudness";

export function loudness(): Loudness {
  try {
    const v = localStorage.getItem(KEY);
    return v === "louder" || v === "loudest" ? v : "normal";
  } catch {
    return "normal";
  }
}

const listeners = new Set<() => void>();

export function setLoudness(v: Loudness): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // private mode: this page keeps it until it closes
  }
  for (const f of listeners) f();
}

/**
 * tanh over four times full scale, after a quarter-gain in front of it: unity
 * for ordinary levels, rounding off anything hot, never reaching 1.
 */
const CURVE = (() => {
  const n = 4096;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) c[i] = Math.tanh(4 * ((i / (n - 1)) * 2 - 1));
  return c;
})();

/** Gain, limiter and soft clip in front of `dest`. Connect what should be louder to `input`. */
export class VoiceChain {
  readonly input: GainNode;
  private comp: DynamicsCompressorNode;
  private makeup: GainNode;
  private clip: WaveShaperNode;
  private dest: AudioNode;
  private update = () => this.apply();

  constructor(ctx: BaseAudioContext, dest: AudioNode = ctx.destination) {
    this.dest = dest;
    this.input = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.attack.value = 0.002;
    this.comp.release.value = 0.2;
    this.makeup = ctx.createGain();
    this.clip = ctx.createWaveShaper();
    this.clip.curve = CURVE;
    this.clip.oversample = "4x";
    this.comp.connect(this.makeup).connect(this.clip).connect(dest);
    this.apply();
    listeners.add(this.update);
  }

  /** Follow the setting: straight through at normal, shaped otherwise. */
  apply(level = loudness()): void {
    this.input.disconnect();
    if (level === "normal") {
      this.input.connect(this.dest);
      return;
    }
    const s = SHAPES[level];
    this.comp.threshold.value = s.threshold;
    this.comp.ratio.value = s.ratio;
    this.comp.knee.value = s.knee;
    this.makeup.gain.value = Math.pow(10, s.makeupDb / 20) * 0.25;
    this.input.connect(this.comp);
  }

  dispose(): void {
    listeners.delete(this.update);
    this.input.disconnect();
  }
}

/* ---------- one context for the live voice and alerts ------------------- */

let shared: { ctx: AudioContext; chain: VoiceChain } | null = null;

/**
 * The shared context, running, or null if the browser will not start one yet
 * (no tap on this page so far). Created only when something is to be made
 * louder, so at "normal" no context exists at all.
 */
async function sharedOut(): Promise<{ ctx: AudioContext; chain: VoiceChain } | null> {
  if (loudness() === "normal") return null;
  try {
    if (!shared) {
      const ctx = new AudioContext();
      shared = { ctx, chain: new VoiceChain(ctx) };
    }
    if (shared.ctx.state !== "running") {
      await Promise.race([shared.ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    }
    return shared.ctx.state === "running" ? shared : null;
  } catch {
    return null;
  }
}

/** Start the context inside a tap, where the browser allows it. */
export function wakeVoice(): void {
  if (loudness() !== "normal") void sharedOut();
}

/**
 * Play a clip through the chain if it should be louder. Returns whether it was
 * routed; if not, it plays as it always did.
 */
export async function routeElement(el: HTMLMediaElement): Promise<boolean> {
  const out = await sharedOut();
  if (!out) return false;
  try {
    out.ctx.createMediaElementSource(el).connect(out.chain.input);
    return true;
  } catch {
    return false;
  }
}

/**
 * The live session's voice. The stream stays on its audio element, muted
 * rather than detached: Chrome only delivers a remote WebRTC stream to Web
 * Audio while an element is also playing it. At "normal", the element plays it
 * unmuted, exactly as before, and none of this is involved.
 */
export class LiveVoice {
  private stream: MediaStream | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private el: HTMLAudioElement;

  constructor(el: HTMLAudioElement) {
    this.el = el;
    listeners.add(() => void this.apply());
  }

  async attach(stream: MediaStream): Promise<void> {
    this.stream = stream;
    await this.apply();
  }

  detach(): void {
    this.stream = null;
    this.src?.disconnect();
    this.src = null;
    this.el.muted = false;
  }

  private async apply(): Promise<void> {
    this.src?.disconnect();
    this.src = null;
    const stream = this.stream;
    const out = stream ? await sharedOut() : null;
    if (!stream || !out || stream !== this.stream) {
      this.el.muted = false;
      return;
    }
    this.src = out.ctx.createMediaStreamSource(stream);
    this.src.connect(out.chain.input);
    this.el.muted = true;
  }
}
