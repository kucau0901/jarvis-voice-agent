import type { Env } from "../types";
import { err } from "../lib/http";
import { speechConfig, synthesize } from "../lib/speech";

/**
 * Text to speech for what Jarvis says by itself, outside a live session:
 * alerts (reminders, routines, watches, finished jobs), Settings' Hear it.
 *
 * It follows Settings → Voice, as push-to-talk's answers do (lib/speech.ts):
 * the same service, voice and "how it sounds". It used to call OpenAI with a
 * fixed voice whatever was chosen there. With the device's own voice chosen,
 * it answers 204 and the screen speaks the text itself.
 *
 * `audio: true` insists on audio, for feeding speech into a live session to
 * test the voice loop without a human (src/app/session.ts): the device's own
 * voice cannot be fed in, so OpenAI's is used then.
 */
export async function handleTts(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return err(405, "method not allowed");

  let body: { text?: unknown; audio?: unknown };
  try {
    body = await req.json();
  } catch {
    return err(400, "body is not valid JSON");
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 1000) : "";
  if (!text) return err(400, "text is required");

  const cfg = speechConfig(env);
  if (cfg.tts === "browser" && body.audio !== true) {
    // The screen speaks it, in the language push-to-talk would use.
    return new Response(null, { status: 204, headers: { "x-jarvis-voice": "browser", "x-jarvis-language": cfg.language } });
  }
  const spoken = await synthesize(env, text, "mp3");
  if (!spoken.ok) return err(502, "speech failed", { detail: spoken.error.slice(0, 300) });
  return new Response(spoken.audio, {
    headers: { "content-type": spoken.mime, "cache-control": "no-store", "x-jarvis-voice": spoken.by },
  });
}
