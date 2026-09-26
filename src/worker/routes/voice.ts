import type { Env } from "../types";
import type { Principal } from "../lib/auth";
import { err, json } from "../lib/http";
import { SseStream, type EventSink, type SseEvent } from "../lib/sse";
import { Collector, type Collected } from "../lib/collector";
import { buildHistory, type Turn } from "../lib/history";
import { MemoryStore } from "../lib/memory";
import { stateStub } from "../lib/state-client";
import { allows, SCOPES, WILDCARD, type Grant } from "../lib/scopes";
import {
  AUDIO_FORMATS,
  MAX_AUDIO_BYTES,
  audioExtension,
  audioToBase64,
  recognitionHints,
  speechChunks,
  speechConfig,
  synthesize,
  transcribe,
  type AudioFormat,
  type Spoken,
} from "../lib/speech";
import { run } from "./delegate";
import { MAX_PHOTOS, MAX_PHOTO_CHARS, photosFrom } from "../lib/photos";
import { dataUrl } from "../lib/cameras";
import { originOf, type Origin } from "../lib/shared";

/**
 * Push-to-talk: one spoken question in, one spoken answer out, paid per
 * question. It never opens a GPT-Live session (lib/speech.ts has the costs).
 *
 *   GET  /api/v1/voice   how this deployment hears and speaks (for the app)
 *   POST /api/v1/voice   the question, as any of:
 *     - a recording: Content-Type audio/webm, audio/ogg, audio/wav, audio/mpeg,
 *       audio/mp4…; options in the query string
 *     - multipart/form-data: an `audio` file and/or `text`, options as a JSON
 *       `options` field — what the app sends
 *     - JSON: {"text": …} when the device recognised the speech itself
 *
 *   Options: reply ("audio", default, or "text"), format ("mp3", "wav",
 *   "opus", "pcm"), thread (a short id: follow-ups are understood for five
 *   minutes), context (the conversation so far, instead of a thread), screen
 *   (true if there is somewhere to show a map).
 *
 *   The answer: JSON by default — {transcript, text, ok, audio: {format, mime,
 *   data (base64)}} — or, with Accept: text/event-stream, the same as it
 *   happens: transcript, progress, display, result, audio. With Accept: audio/*
 *   just the audio, the words in X-Jarvis-Transcript and X-Jarvis-Text
 *   (URI-encoded): the easiest thing for a microcontroller to play.
 */

interface Options {
  reply: "audio" | "text";
  format: AudioFormat;
  thread?: string;
  context?: unknown;
  screen: boolean;
  /** Which screen asked, for the conversation shared across devices (lib/shared.ts). */
  origin?: unknown;
}

interface Input {
  audio?: { buf: ArrayBuffer; mime: string };
  text?: string;
  /** Photos taken to ask about, as data: URLs (lib/photos.ts). */
  photos?: string[];
  opts: Options;
  /** The asking device, once known (handleVoice). */
  origin?: Origin;
}

const THREAD = /^[A-Za-z0-9_-]{1,40}$/;

function options(raw: Record<string, unknown>): Options {
  const format = String(raw.format ?? "mp3").toLowerCase();
  const thread = typeof raw.thread === "string" && THREAD.test(raw.thread) ? raw.thread : undefined;
  return {
    reply: raw.reply === "text" ? "text" : "audio",
    format: (AUDIO_FORMATS as readonly string[]).includes(format) ? (format as AudioFormat) : "mp3",
    ...(thread ? { thread } : {}),
    ...(raw.context !== undefined ? { context: raw.context } : {}),
    screen: raw.screen === true || raw.screen === "1" || raw.screen === "true",
    ...(raw.origin !== undefined ? { origin: raw.origin } : {}),
  };
}

async function readInput(req: Request, url: URL): Promise<Input | Response> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  const len = Number(req.headers.get("content-length") ?? "0");
  // A recording, plus room for a couple of photos alongside it.
  if (Number.isFinite(len) && len > MAX_AUDIO_BYTES + 2 * MAX_PHOTO_CHARS) return err(413, "that is too much for push-to-talk");

  if (type.startsWith("audio/")) {
    if (!audioExtension(type)) return err(415, `${type.split(";")[0]} is not a recording format Jarvis takes`);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_AUDIO_BYTES) return err(413, "that recording is too long for push-to-talk");
    return { audio: { buf, mime: type }, opts: options(Object.fromEntries(url.searchParams)) };
  }

  if (type.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return err(400, "the form could not be read");
    }
    let raw: Record<string, unknown> = {};
    const o = form.get("options");
    if (typeof o === "string" && o) {
      try {
        raw = JSON.parse(o);
      } catch {
        return err(400, "options is not valid JSON");
      }
    }
    const input: Input = { opts: options(raw) };
    const file = form.get("audio");
    if (file && typeof file !== "string") {
      const mime = file.type || "audio/webm";
      if (!audioExtension(mime)) return err(415, `${mime} is not a recording format Jarvis takes`);
      if (file.size > MAX_AUDIO_BYTES) return err(413, "that recording is too long for push-to-talk");
      input.audio = { buf: await file.arrayBuffer(), mime };
    }
    const text = form.get("text");
    if (typeof text === "string" && text.trim()) input.text = text.trim().slice(0, 2000);
    const photos: string[] = [];
    for (const f of form.getAll("image")) {
      if (typeof f === "string" || !/^image\/(jpeg|png|webp)$/.test(f.type) || f.size > MAX_PHOTO_CHARS * 0.75) continue;
      photos.push(dataUrl(await f.arrayBuffer(), f.type));
    }
    if (photos.length) input.photos = photosFrom(photos);
    return input;
  }

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    // The words and a conversation, plus room for a couple of photos.
    if (raw.length > 64 * 1024 + MAX_PHOTOS * MAX_PHOTO_CHARS) return err(413, "body too large");
    body = JSON.parse(raw);
  } catch {
    return err(400, "send a recording (audio/*), a form with an audio file, or JSON with text");
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
  const photos = photosFrom(body.images);
  return { ...(text ? { text } : {}), ...(photos.length ? { photos } : {}), opts: options(body) };
}

function contextTurns(raw: unknown): Turn[] {
  const items = buildHistory(raw);
  if (!items) return [];
  return items.map((i) => ({
    role: i.role === "assistant" ? ("assistant" as const) : ("user" as const),
    text: (i.content as { text: string }[])[0]!.text,
  }));
}

interface Outcome {
  transcript: string;
  heardBy: string;
  reply: Collected;
  audio?: Spoken;
}

/** Whether the caller wants the answer spoken, and how. */
type Speak = "whole" | "pieces" | "none";

/** Hear, think, speak. Everything worth showing along the way goes to `emit`. */
async function pipeline(
  env: Env,
  input: Input,
  grants: readonly Grant[],
  who: string,
  emit: (ev: SseEvent) => void,
  signal: AbortSignal,
  speak: Speak,
): Promise<Outcome> {
  let transcript = input.text ?? "";
  let heardBy = "text";
  if (!transcript && input.audio) {
    const memory = new MemoryStore(env);
    const doc = await memory.load().catch(() => null);
    const heard = await transcribe(env, input.audio.buf, input.audio.mime, recognitionHints(doc));
    if (!heard.ok) {
      console.warn("voice: transcription failed:", heard.error);
      return { transcript: "", heardBy: "none", reply: { ok: false, text: "I couldn't make that out just now.", error: "transcription", tools: [] } };
    }
    transcript = heard.text;
    heardBy = heard.by;
  }
  emit({ type: "transcript", text: transcript });
  if (!transcript) {
    return { transcript, heardBy, reply: { ok: false, text: "I didn't catch that.", error: "silence", tools: [] } };
  }

  const state = stateStub(env);
  const threadKey = input.opts.thread ? `voice:${who}:${input.opts.thread}` : null;
  const prior =
    input.opts.context !== undefined
      ? contextTurns(input.opts.context)
      : threadKey && state
        ? await state.loadThread(threadKey).catch(() => [] as Turn[])
        : [];

  const collector = new Collector();
  const tee: EventSink = {
    send(ev) {
      collector.send(ev);
      if (ev.type !== "result" && ev.type !== "error") emit(ev);
    },
    get isClosed() {
      return collector.isClosed;
    },
  };
  await run(env, [...prior, { role: "user", text: transcript }], tee, signal, grants, {
    surface: "voice",
    assist: true,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.photos?.length ? { images: input.photos } : {}),
  });
  const reply = collector.finish();

  if (threadKey && state) {
    await state
      .appendThread(threadKey, [{ role: "user", text: transcript }, { role: "assistant", text: reply.text }])
      .catch(() => {});
  }

  const out: Outcome = { transcript, heardBy, reply };
  if (input.opts.reply !== "audio" || !reply.text || speak === "none") return out;
  if (speak === "whole") {
    out.audio = await synthesize(env, reply.text, input.opts.format);
    return out;
  }
  // Streamed: the words go first, then each piece of speech in order as soon
  // as it is ready, all of them made at once.
  emitResult(emit, out);
  const pieces = speechChunks(reply.text);
  const t0 = Date.now();
  const jobs = pieces.map((p) => synthesize(env, p, input.opts.format).then((a) => ({ a, ms: Date.now() - t0 })));
  for (let i = 0; i < jobs.length; i++) {
    const { a, ms } = await jobs[i]!;
    emit({ type: "audio", seq: i, last: i === jobs.length - 1, ms, ...audioJson(a) });
  }
  return out;
}

function emitResult(emit: (ev: SseEvent) => void, o: Outcome): void {
  const r = o.reply;
  emit({
    type: r.ok ? "result" : "error",
    text: r.text,
    tools: r.tools,
    ...(r.model ? { model: r.model } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    heardBy: o.heardBy,
  });
}

const audioJson = (a: Spoken | undefined) =>
  a?.ok ? { audio: { format: a.format, mime: a.mime, by: a.by, data: audioToBase64(a.audio) } } : a ? { audioError: a.error } : {};

export async function handleVoice(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
  grants: readonly Grant[],
): Promise<Response> {
  if (req.method === "GET") return json(speechConfig(env));
  if (req.method !== "POST") return err(405, "method not allowed");
  // Asking is what this does; voice alone is not enough.
  if (!allows(grants, "ask")) return err(403, 'this device is not granted "ask"', { need: "ask" });
  if (!env.OPENAI_API_KEY) return err(503, "OPENAI_API_KEY is not configured");

  const url = new URL(req.url);
  const input = await readInput(req, url);
  if (input instanceof Response) return input;
  if (!input.audio && !input.text) return err(400, "nothing to answer: send a recording or text");
  input.origin = originOf(principal, input.opts.origin) ?? undefined;

  // A screen only when the caller has one to show a map on, and may use it.
  const scoped: readonly Grant[] = input.opts.screen
    ? grants
    : grants.includes(WILDCARD)
      ? SCOPES.filter((s) => s !== "screen")
      : grants.filter((g) => g !== "screen");
  const who = principal.kind === "owner" ? "owner" : principal.id;
  const accept = (req.headers.get("accept") ?? "").toLowerCase();
  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort());

  if (accept.includes("text/event-stream")) {
    const sse = new SseStream();
    const work = (async () => {
      let resulted = false;
      const emit = (ev: SseEvent) => {
        if (ev.type === "result" || ev.type === "error") resulted = true;
        sse.send(ev);
      };
      try {
        const o = await pipeline(env, input, scoped, who, emit, ac.signal, "pieces");
        if (!resulted) emitResult(emit, o);
      } catch (e) {
        sse.send({ type: "error", text: "Something went wrong on the way to an answer.", detail: e instanceof Error ? e.message : String(e) });
      } finally {
        sse.close();
      }
    })();
    ctx.waitUntil(work);
    return sse.response();
  }

  const o = await pipeline(env, input, scoped, who, () => {}, ac.signal, "whole");

  if (accept.startsWith("audio/") && o.audio?.ok) {
    return new Response(o.audio.audio, {
      headers: {
        "content-type": o.audio.mime,
        "cache-control": "no-store",
        "x-jarvis-transcript": encodeURIComponent(o.transcript),
        "x-jarvis-text": encodeURIComponent(o.reply.text),
        "x-jarvis-ok": o.reply.ok ? "1" : "0",
      },
    });
  }

  return json({
    ok: o.reply.ok,
    transcript: o.transcript,
    text: o.reply.text,
    tools: o.reply.tools,
    heardBy: o.heardBy,
    ...(o.reply.usage ? { usage: o.reply.usage } : {}),
    ...audioJson(o.audio),
  });
}
