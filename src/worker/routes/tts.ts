import type { Env } from "../types";
import { err } from "../lib/http";

/**
 * Text to speech, used only to test the voice loop without a human.
 *
 * Injecting text through commentary.append proved useless for testing: it hands
 * the model something to *say*, not a request to act on, so it never triggers a
 * delegation. Feeding real audio into the peer connection exercises the actual
 * path — transcription, intent, delegation — end to end.
 */
export async function handleTts(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return err(405, "method not allowed");
  if (!env.OPENAI_API_KEY) return err(503, "OPENAI_API_KEY is not configured");

  let body: { text?: unknown; voice?: unknown };
  try {
    body = await req.json();
  } catch {
    return err(400, "body is not valid JSON");
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 1000) : "";
  if (!text) return err(400, "text is required");

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: typeof body.voice === "string" ? body.voice : "alloy",
      input: text,
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return err(502, "tts failed", { status: res.status, detail: detail.slice(0, 300) });
  }
  return new Response(res.body, {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}
