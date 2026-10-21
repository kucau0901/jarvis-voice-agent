import { VoiceChain } from "./loud";
import { authHeaders } from "./key";
import type { VoiceLevels } from "./audio";
import type { Turn } from "./history";
import { originHere } from "./alerts";
import { asDraft, type Draft } from "./draft";

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

interface PttHooks {
  status(text: string, bad?: boolean): void;
  heard(text: string): void;
  answered(text: string, ok: boolean): void;
  display(payload: Record<string, unknown>): void;
  thinking(on: boolean): void;
  history(): Turn[];
  /** A tool call started or finished (lib/router.ts runCalls): Home shows a panel in the making (main.ts panelTool). */
  tool?(name: string, phase: string): void;
  /** Dictation's words, for the chat box: heard, never asked (dictate). */
  dictated?(text: string): void;
  /** A mail written and held for the person's tap (Draft first): its card (draft.ts). */
  drafted?(d: Draft): void;
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
/** Dictating, people pause mid-sentence: a longer silence ends it, and it may run as long as a recording may be (lib/speech.ts). */
const DICTATE_SILENCE_MS = 2500;
const DICTATE_MAX_MS = 120_000;
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
  private playOut: VoiceChain | null = null;
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

  /** Dictating into the chat box rather than asking (dictate). */
  private dictating = false;
  /** Whether the chat box's mic is listening or writing it down now (main.ts marks the mic). */
  get dictatingNow(): boolean {
    return this.dictating && this.state !== "idle";
  }

  /** The chat box's mic: listened to as a question would be, but the words go into the box (main.ts), not to Jarvis. */
  async dictate(): Promise<void> {
    if (this.starting) return;
    if (this.state !== "idle") return this.press();
    this.dictating = true;
    return this.listen();
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

  /** Put down, not finished: what was heard so far is not sent (their end handlers would send it). */
  stop(): void {
    this.abort?.abort();
    if (this.recognition) {
      this.recognition.onend = null;
      this.recognition.stop();
      this.recognition = null;
    }
    if (this.recorder) {
      this.recorder.onstop = null;
      if (this.recorder.state === "recording") this.recorder.stop();
    }
    this.chunks = [];
    this.silence();
    this.release();
    this.state = "idle";
    this.dictating = false;
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
    this.playOut?.dispose();
    this.playOut = null;
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

  /** Between a tap and the mic opening, still idle: a second tap then would open a second mic, its timer left running. */
  private starting = false;

  private async listen(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      await this.open();
    } finally {
      this.starting = false;
    }
  }

  private async open(): Promise<void> {
    const cfg = await this.loadConfig();
    const Recognition = (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike })
      .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (cfg.stt === "browser" && Recognition) return this.listenInBrowser(new Recognition(), cfg);

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      // done(): a dictation that never started is not left on for the next question.
      return this.done(`microphone unavailable: ${e instanceof Error ? e.message : String(e)}`, true);
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
        if (now - quietSince > (this.dictating ? DICTATE_SILENCE_MS : END_SILENCE_MS)) return this.finishListening();
      }
      if (!spoke && now - started > NO_SPEECH_MS) {
        this.chunks = [];
        this.recorder!.onstop = null;
        this.recorder?.stop();
        this.release();
        this.done("didn't hear anything — tap to ask");
        return;
      }
      if (now - started > (this.dictating ? DICTATE_MAX_MS : MAX_MS)) this.finishListening();
    }, 100);
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
    let failed = "";
    rec.onresult = (e) => {
      for (let i = 0; i < e.results.length; i++) text += e.results[i]![0]!.transcript;
    };
    rec.onerror = (e) => {
      failed = e.error;
      this.hooks.status(`speech recognition: ${e.error}`, true);
    };
    rec.onend = () => {
      this.recognition = null;
      if (text.trim()) void (this.dictating ? this.give(text.trim()) : this.ask({ text: text.trim() }));
      // Its reason stays said: "didn't hear anything" over a refused microphone sent people looking for the wrong fault.
      else if (failed) this.done(`speech recognition: ${failed} — tap to ask`, true);
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
    const audio = new Blob(this.chunks, { type: mime.split(";")[0] });
    if (this.dictating) return this.transcribeOnly(audio);
    await this.ask({ audio });
  }

  /** Dictation's recording, only heard (routes/voice.ts transcribe): its words for the box, nothing asked. */
  private async transcribeOnly(audio: Blob): Promise<void> {
    this.state = "thinking";
    this.hooks.status("writing it down…");
    this.abort = new AbortController();
    const form = new FormData();
    form.append("audio", audio, "dictation");
    form.append("options", JSON.stringify({ transcribe: true }));
    const headers = authHeaders(this.key);
    delete headers["Content-Type"];
    delete headers["content-type"];
    try {
      const res = await fetch("/api/v1/voice", { method: "POST", headers, body: form, signal: this.abort.signal });
      const b = (await res.json().catch(() => ({}))) as { transcript?: string; error?: string };
      if (!res.ok) return this.done(`${b.error ?? `server said ${res.status}`} — tap the mic to dictate`, true);
      this.give((b.transcript ?? "").trim());
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      this.done(`couldn't reach Jarvis: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /** What was dictated, into the box; nothing heard said so. */
  private give(text: string): void {
    if (text) this.hooks.dictated?.(text);
    this.done(text ? "" : "didn't hear anything — tap the mic to dictate");
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
    if (q.text) form.append("text", q.text);
    const speakHere = cfg.tts === "browser" && "speechSynthesis" in window;
    form.append("options", JSON.stringify({ context: this.hooks.history(), reply: speakHere ? "text" : "audio", screen: true, origin: originHere() }));

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
          else if (ev.type === "tool" && typeof ev.name === "string") this.hooks.tool?.(ev.name, String(ev.phase ?? ""));
          else if (ev.type === "draft") asDraft(ev, this.hooks.drafted);
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
        // As loud as this screen asks for (loud.ts); straight through at normal.
        this.playOut = new VoiceChain(this.playCtx);
      }
      const src = this.playCtx.createMediaElementSource(el);
      src.connect(this.playDest!);
      src.connect(this.playOut!.input);
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
    this.dictating = false;
    this.recognition = null;
    this.hooks.thinking(false);
    this.hooks.status(text, bad);
  }
}
