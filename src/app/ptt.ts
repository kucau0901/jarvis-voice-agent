import { authHeaders } from "./key";
import type { VoiceLevels } from "./audio";
import type { Turn } from "./history";
import { photoBlob } from "./photo";

/**
 * Push-to-talk: the cheap way to talk to Jarvis.
 *
 * Tap the orb, ask, and stop talking (or tap again). The recording goes to
 * /api/v1/voice, which transcribes it, runs the same router GPT-Live
 * delegates to, and speaks the answer back — about a fifth of a cent a
 * question, against $0.05 a minute for a live session. Nothing here opens
 * one.
 *
 * Hearing and speaking can instead happen on the device itself, free, when
 * the deployment says "browser" and this browser can.
 */

export interface PttHooks {
  status(text: string, bad?: boolean): void;
  heard(text: string): void;
  answered(text: string, ok: boolean): void;
  display(payload: Record<string, unknown>): void;
  thinking(on: boolean): void;
  history(): Turn[];
  /** A photo waiting to be asked about, handed over once (photo.ts). */
  photo(): string | null;
}

interface VoiceConfig {
  stt: "openai" | "workers-ai" | "browser";
  tts: "openai" | "workers-ai" | "browser";
  language: string;
}

type State = "idle" | "listening" | "thinking" | "speaking";

/** Silence after speech that ends a question. */
const END_SILENCE_MS = 1300;
/** Nothing said this long after the tap: give up quietly. */
const NO_SPEECH_MS = 7000;
const MAX_MS = 30_000;
/** RMS of a 0–1 signal above which someone is talking. Low: car cabins are quiet, phones are held close. */
const SPEECH_RMS = 0.02;

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export class PushToTalk {
  private key: string;
  private hooks: PttHooks;
  private levels: VoiceLevels;
  private state: State = "idle";
  private config: VoiceConfig | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private vadTimer = 0;
  private audio: HTMLAudioElement | null = null;
  /** Pieces of the spoken answer, in order, waiting their turn. */
  private clips: { data: string; mime: string }[] = [];
  private playing = false;
  private streamDone = false;
  private playCtx: AudioContext | null = null;
  private playDest: MediaStreamAudioDestinationNode | null = null;
  private abort: AbortController | null = null;
  private recognition: SpeechRecognitionLike | null = null;

  constructor(key: string, levels: VoiceLevels, hooks: PttHooks) {
    this.key = key;
    this.levels = levels;
    this.hooks = hooks;
  }

  /** Levels are live: the orb should follow the mic or the answer. */
  get active(): boolean {
    return this.state === "listening" || this.state === "speaking";
  }

  get busy(): boolean {
    return this.state !== "idle";
  }

  setKey(key: string): void {
    this.key = key;
  }

  /** One control, like the live orb: each tap does the obvious next thing. */
  async press(): Promise<void> {
    switch (this.state) {
      case "idle":
        return this.listen();
      case "listening":
        return this.finishListening();
      case "thinking":
        this.abort?.abort();
        this.done("cancelled — tap to ask");
        return;
      case "speaking":
        this.abort?.abort();
        this.silence();
        this.done("tap to ask");
        return;
    }
  }

  stop(): void {
    this.abort?.abort();
    this.recognition?.stop();
    this.recorder?.state === "recording" && this.recorder.stop();
    this.silence();
    this.release();
    this.state = "idle";
  }

  /** Stop speaking, and forget anything still queued to say. */
  private silence(): void {
    this.clips = [];
    this.playing = false;
    this.audio?.pause();
    this.audio = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.levels.detach("agent");
    void this.playCtx?.close().catch(() => {});
    this.playCtx = null;
    this.playDest = null;
  }

  private async loadConfig(): Promise<VoiceConfig> {
    if (this.config) return this.config;
    try {
      const r = await fetch("/api/v1/voice", { headers: authHeaders(this.key) });
      if (r.ok) this.config = (await r.json()) as VoiceConfig;
    } catch {
      // defaults below
    }
    return (this.config ??= { stt: "openai", tts: "openai", language: navigator.language || "en" });
  }

  /* ---------- hearing -------------------------------------------------------- */

  private async listen(): Promise<void> {
    const cfg = await this.loadConfig();
    const Recognition = (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike })
      .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (cfg.stt === "browser" && Recognition) return this.listenInBrowser(new Recognition(), cfg);

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.hooks.status(`microphone unavailable: ${e instanceof Error ? e.message : String(e)}`, true);
      return;
    }
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find(
      (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
    );
    this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.onstop = () => void this.send();
    this.recorder.start(250);
    this.state = "listening";
    this.levels.attach("user", this.stream);
    this.hooks.status("listening — tap when you're done");
    this.watchForSilence(this.stream);
  }

  /**
   * End the question when the speaker stops, rather than making them tap
   * again — which matters most while driving.
   */
  private watchForSilence(stream: MediaStream): void {
    this.ctx = new AudioContext();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const started = Date.now();
    let spoke = false;
    let quietSince = 0;
    this.vadTimer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      if (rms > SPEECH_RMS) {
        spoke = true;
        quietSince = 0;
      } else if (spoke) {
        quietSince ||= now;
        if (now - quietSince > END_SILENCE_MS) return this.finishListening();
      }
      if (!spoke && now - started > NO_SPEECH_MS) {
        this.chunks = [];
        this.recorder!.onstop = null;
        this.recorder?.stop();
        this.release();
        this.done("didn't hear anything — tap to ask");
        return;
      }
      if (now - started > MAX_MS) this.finishListening();
    }, 100) as unknown as number;
  }

  private finishListening(): void {
    if (this.state !== "listening") return;
    clearInterval(this.vadTimer);
    if (this.recognition) {
      this.recognition.stop();
      return;
    }
    if (this.recorder?.state === "recording") this.recorder.stop();
  }

  private listenInBrowser(rec: SpeechRecognitionLike, cfg: VoiceConfig): void {
    this.recognition = rec;
    rec.lang = cfg.language;
    rec.interimResults = false;
    rec.continuous = false;
    let text = "";
    rec.onresult = (e) => {
      for (let i = 0; i < e.results.length; i++) text += e.results[i]![0]!.transcript;
    };
    rec.onerror = (e) => this.hooks.status(`speech recognition: ${e.error}`, true);
    rec.onend = () => {
      this.recognition = null;
      if (text.trim()) void this.ask({ text: text.trim() });
      else this.done("didn't hear anything — tap to ask");
    };
    rec.start();
    this.state = "listening";
    this.hooks.status("listening — tap when you're done");
  }

  private release(): void {
    clearInterval(this.vadTimer);
    this.levels.detach("user");
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private async send(): Promise<void> {
    const mime = this.recorder?.mimeType || "audio/webm";
    this.release();
    if (!this.chunks.length) return this.done("didn't hear anything — tap to ask");
    await this.ask({ audio: new Blob(this.chunks, { type: mime.split(";")[0] }) });
  }

  /* ---------- asking and answering --------------------------------------------- */

  private async ask(q: { audio?: Blob; text?: string }): Promise<void> {
    const cfg = await this.loadConfig();
    this.state = "thinking";
    this.hooks.thinking(true);
    this.hooks.status("thinking…");
    if (q.text) this.hooks.heard(q.text);

    const form = new FormData();
    if (q.audio) form.append("audio", q.audio, "question");
    const snap = this.hooks.photo();
    if (snap) form.append("image", photoBlob(snap), "photo.jpg");
    if (q.text) form.append("text", q.text);
    const speakHere = cfg.tts === "browser" && "speechSynthesis" in window;
    form.append("options", JSON.stringify({ context: this.hooks.history(), reply: speakHere ? "text" : "audio", screen: true }));

    this.abort = new AbortController();
    const headers = authHeaders(this.key);
    delete headers["Content-Type"];
    delete headers["content-type"];
    let answer = "";
    this.clips = [];
    this.playing = false;
    this.streamDone = false;
    try {
      const res = await fetch("/api/v1/voice", {
        method: "POST",
        headers: { ...headers, Accept: "text/event-stream" },
        body: form,
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) {
        const why = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        return this.done(why ?? `server said ${res.status}`, true);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          if (!line) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (ev.type === "transcript" && !q.text) this.hooks.heard(String(ev.text ?? ""));
          else if (ev.type === "progress" && ev.text) this.hooks.status(`${String(ev.text)}…`);
          else if (ev.type === "display") this.hooks.display(ev);
          else if (ev.type === "result" || ev.type === "error") {
            answer = String(ev.text ?? "");
            this.hooks.answered(answer, ev.type === "result");
          } else if (ev.type === "audio") {
            // Pieces arrive in order; the first plays while the rest are made.
            const a = ev.audio as { data?: string; mime?: string } | undefined;
            if (a?.data) {
              this.clips.push({ data: a.data, mime: a.mime ?? "audio/mpeg" });
              if (!this.playing) this.playNext();
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      return this.done(`couldn't reach Jarvis: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      this.hooks.thinking(false);
    }

    this.streamDone = true;
    if (this.playing || this.clips.length) return; // the last piece finishing ends it
    // Chosen, or the only way left: speaking failed on the server.
    if (answer && "speechSynthesis" in window) return this.speakHere(answer, cfg.language);
    this.done("tap to ask");
  }

  private playNext(): void {
    const a = this.clips.shift();
    if (!a) {
      this.playing = false;
      if (this.streamDone) {
        this.silence();
        this.done("tap to ask");
      }
      return;
    }
    this.playing = true;
    const bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: a.mime }));
    const el = new Audio(url);
    this.audio = el;
    this.state = "speaking";
    this.hooks.status("speaking — tap to stop");
    // Feed the orb the answer's level, as it does for a live session: one
    // context for the whole answer, each piece connected as it plays.
    try {
      if (!this.playCtx) {
        this.playCtx = new AudioContext();
        this.playDest = this.playCtx.createMediaStreamDestination();
        this.levels.attach("agent", this.playDest.stream);
      }
      const src = this.playCtx.createMediaElementSource(el);
      src.connect(this.playDest!);
      src.connect(this.playCtx.destination);
    } catch {
      // the answer still plays; the orb just sits still
    }
    el.onended = () => {
      URL.revokeObjectURL(url);
      if (this.audio === el) this.playNext();
    };
    el.play().catch(() => {
      // No tap on this page yet (a background tab): say so rather than stay silent.
      this.silence();
      this.done("tap to hear answers aloud", true);
    });
  }

  private speakHere(text: string, lang: string): void {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    this.state = "speaking";
    this.hooks.status("speaking — tap to stop");
    u.onend = () => this.done("tap to ask");
    u.onerror = () => this.done("tap to ask");
    speechSynthesis.speak(u);
  }

  private done(text: string, bad = false): void {
    this.state = "idle";
    this.recognition = null;
    this.hooks.thinking(false);
    this.hooks.status(text, bad);
  }
}
