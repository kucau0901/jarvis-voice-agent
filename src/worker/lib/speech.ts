import type { Env } from "../types";
import { localeOf } from "./locale.ts";
import type { MemoryDoc } from "./memory.ts";

/**
 * Speech to text and text to speech, for push-to-talk (routes/voice.ts).
 *
 * GPT-Live is the premium voice: a full conversation, billed at $0.05 for
 * every minute a session is open. Push-to-talk is the economy one: one
 * question, transcribed, answered by the same router, spoken back — paid per
 * question, and nothing ever opens a GPT-Live session.
 *
 *                          speech → text                 text → speech
 *   openai (default)       gpt-4o-mini-transcribe        gpt-4o-mini-tts
 *                          ~$0.003 a minute, any         ~$0.015 a minute of speech,
 *                          language, mixed ones too      the same voices as GPT-Live
 *   workers-ai             Whisper large v3 turbo        Deepgram Aura 2 for English;
 *                          ~$0.0005 a minute             MeloTTS for Spanish, French,
 *                          (Cloudflare only: needs the   Chinese, Japanese, Korean
 *                          AI binding)
 *   browser                the device's own recognition  the device's own voice
 *                          — free, done in the app       — free, done in the app
 *
 * Anything unavailable falls back to OpenAI, so an OpenAI key alone always
 * works, including in Docker where Workers AI does not exist.
 */

export const STT_PROVIDERS = ["openai", "workers-ai", "browser"] as const;
export const TTS_PROVIDERS = ["openai", "workers-ai", "browser"] as const;
export type SttProvider = (typeof STT_PROVIDERS)[number];
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

/** OpenAI's text-to-speech voices; cedar and marin are the ones GPT-Live uses. */
export const TTS_VOICES = [
  "cedar", "marin", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
] as const;
export const DEFAULT_VOICE = "cedar";
export const DEFAULT_STYLE =
  "A composed British butler: measured, unhurried, quietly warm. Clear, natural pace; no theatrics.";

export const AUDIO_FORMATS = ["mp3", "wav", "opus", "pcm"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];
export const FORMAT_MIME: Record<AudioFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/ogg",
  // 24 kHz, 16-bit, mono, little-endian: what a microcontroller can play with no decoder.
  pcm: "audio/L16;rate=24000;channels=1",
};

/** About two minutes of compressed speech. Push-to-talk is one question, not a dictation. */
export const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
/** Long enough for a full answer; short enough that nothing reads out an essay. */
export const MAX_SPEAK_CHARS = 1500;

/** Workers AI, where it is bound. Typed loosely so Docker and the tests need nothing. */
interface Ai {
  run(model: string, input: unknown): Promise<unknown>;
}
const aiOf = (env: Env): Ai | null => ((env as unknown as { AI?: Ai }).AI ?? null);

export interface SpeechConfig {
  stt: SttProvider;
  tts: TtsProvider;
  voice: string;
  style: string;
  /** Workers AI is bound on this deployment. */
  workersAi: boolean;
  /** For the browser's own recognition and voice. */
  language: string;
}

export function speechConfig(env: Env): SpeechConfig {
  const pick = <T extends string>(v: string | undefined, all: readonly T[], d: T): T =>
    all.includes(v?.trim().toLowerCase() as T) ? (v!.trim().toLowerCase() as T) : d;
  return {
    stt: pick(env.VOICE_STT, STT_PROVIDERS, "openai"),
    tts: pick(env.VOICE_TTS, TTS_PROVIDERS, "openai"),
    voice: pick(env.VOICE_TTS_VOICE, TTS_VOICES, DEFAULT_VOICE),
    style: env.VOICE_STYLE?.trim() || DEFAULT_STYLE,
    workersAi: !!aiOf(env),
    language: localeOf(env).tag,
  };
}

/**
 * Names the recogniser should expect: people and places the user has saved.
 * "Ayesha" heard as "a shire" is the commonest way a voice assistant gets a
 * request wrong before it has even started.
 */
export function recognitionHints(doc: MemoryDoc | null | undefined): string {
  const names = new Set<string>(["Jarvis"]);
  for (const f of doc?.facts ?? []) {
    if ((f.kind === "person" || f.kind === "place") && f.slug) names.add(f.slug);
    if (names.size >= 40) break;
  }
  return `Names that may come up: ${[...names].join(", ")}.`;
}

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

/** The container a recording is in, from its media type; null for anything that is not audio we take. */
export function audioExtension(mime: string): string | null {
  return EXT[mime.split(";")[0]!.trim().toLowerCase()] ?? null;
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b: string): ArrayBuffer {
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export type Heard = { ok: true; text: string; by: SttProvider } | { ok: false; error: string };

export async function transcribe(env: Env, audio: ArrayBuffer, mime: string, hints: string): Promise<Heard> {
  const ext = audioExtension(mime);
  if (!ext) return { ok: false, error: `cannot transcribe ${mime}` };
  const cfg = speechConfig(env);
  const ai = aiOf(env);

  if (cfg.stt === "workers-ai" && ai) {
    try {
      const out = (await ai.run("@cf/openai/whisper-large-v3-turbo", {
        audio: base64(audio),
        initial_prompt: hints,
        vad_filter: true,
      })) as { text?: string };
      return { ok: true, text: (out.text ?? "").trim(), by: "workers-ai" };
    } catch (e) {
      // Workers AI is the cheap path, not the only one: fall through to OpenAI.
      console.warn("workers-ai transcription failed:", e instanceof Error ? e.message : String(e));
    }
  }

  if (!env.OPENAI_API_KEY) return { ok: false, error: "no OpenAI key is set" };
  const form = new FormData();
  form.append("file", new File([audio], `speech.${ext}`, { type: mime.split(";")[0] }));
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("prompt", hints);
  form.append("response_format", "json");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    return { ok: false, error: `transcription failed (${r.status})${detail ? `: ${detail.slice(0, 160)}` : ""}` };
  }
  return { ok: true, text: (((await r.json()) as { text?: string }).text ?? "").trim(), by: "openai" };
}

export type Spoken = { ok: true; audio: ArrayBuffer; format: AudioFormat; mime: string; by: TtsProvider } | { ok: false; error: string };

/** MeloTTS's languages besides English. Anything else goes to OpenAI rather than being mispronounced. */
const MELO: Record<string, string> = { es: "es", fr: "fr", zh: "zh", ja: "jp", ko: "kr" };

/**
 * Workers AI's voices. English is Deepgram Aura 2: in September 2026 MeloTTS
 * answered every request with "3043: Internal server error" while Aura
 * worked, and Aura sounds better anyway. MeloTTS remains for its other
 * languages; if it fails, OpenAI speaks instead.
 */
async function workersSpeech(ai: Ai, text: string, language: string): Promise<ArrayBuffer | null> {
  const out =
    language === "en"
      ? await ai.run("@cf/deepgram/aura-2-en", { text })
      : await ai.run("@cf/myshell-ai/melotts", { prompt: text, lang: MELO[language] });
  return bytesOf(out);
}

/** Workers AI answers with the MP3 bytes, as a stream or a buffer, or JSON with base64; take any. */
async function bytesOf(out: unknown): Promise<ArrayBuffer | null> {
  if (out instanceof ArrayBuffer) return out;
  if (out instanceof Uint8Array) return out.slice().buffer as ArrayBuffer;
  if (out instanceof ReadableStream) return new Response(out).arrayBuffer();
  const b64 = (out as { audio?: unknown } | null)?.audio;
  return typeof b64 === "string" && b64 ? fromBase64(b64) : null;
}

export async function synthesize(env: Env, text: string, format: AudioFormat = "mp3"): Promise<Spoken> {
  const cfg = speechConfig(env);
  const said = speakable(text);
  const input = said.length > MAX_SPEAK_CHARS ? said.slice(0, MAX_SPEAK_CHARS) : said;
  if (!input) return { ok: false, error: "nothing speakable in the answer" };
  const ai = aiOf(env);
  const language = localeOf(env).language;

  if (cfg.tts === "workers-ai" && ai && format === "mp3" && (language === "en" || MELO[language])) {
    try {
      const audio = await workersSpeech(ai, input, language);
      if (audio?.byteLength) return { ok: true, audio, format: "mp3", mime: FORMAT_MIME.mp3, by: "workers-ai" };
      console.warn("workers-ai speech: nothing came back");
    } catch (e) {
      console.warn("workers-ai speech failed:", e instanceof Error ? e.message : String(e));
    }
  }

  if (!env.OPENAI_API_KEY) return { ok: false, error: "no OpenAI key is set" };
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: cfg.voice,
      input,
      instructions: cfg.style,
      response_format: format,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    return { ok: false, error: `speech failed (${r.status})${detail ? `: ${detail.slice(0, 160)}` : ""}` };
  }
  return { ok: true, audio: await r.arrayBuffer(), format, mime: FORMAT_MIME[format], by: "openai" };
}

/**
 * What the voice should actually say. Web search answers arrive with
 * citations — "([nhtsa.gov](https://…))" — and a router asked not to use
 * markdown sometimes does anyway. Read aloud, either is gibberish.
 */
export function speakable(text: string): string {
  return text
    .replace(/\(\s*\[[^\]]*\]\([^)]*\)\s*\)/g, "") // a citation in brackets
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // a link: keep its words
    .replace(/https?:\/\/\S+/g, "") // a bare address
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2") // emphasis and code
    .replace(/^\s*(#+|[-*•]|\d+\.)\s+/gm, "") // headings, bullets, numbered lines
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * An answer cut into pieces to speak one after another.
 *
 * Text-to-speech takes about as long as the audio it makes, and nothing plays
 * until a clip is finished — measured at six seconds of silence before a
 * five-second answer. Spoken sentence by sentence, all made at once, the first
 * is ready in about one and a half. Splits only at sentence ends followed by a
 * space, so "3.5 km" stays whole; very short sentences ride with a neighbour,
 * so the voice does not stop after every "Yes.".
 */
export function speechChunks(text: string, max = 4): string[] {
  const sentences = text.trim().split(/(?<=[.!?。！？])\s+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    const last = out.length - 1;
    if (last >= 0 && (out[last]!.length < 25 || out.length >= max)) out[last] += ` ${s}`;
    else out.push(s);
  }
  return out.length ? out : [text];
}

export { base64 as audioToBase64 };
