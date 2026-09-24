import OpenAI from "openai";
import type { Env } from "../types";
import { json, err } from "../lib/http";
import { isClientKind, jarvisPrompt } from "../lib/prompt";
import { buildHistory } from "../lib/history";

/** Confirmed against openai@7 `BuiltInVoice`. Default is `marin`. */
export const VOICES = [
  "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral",
  "delta", "echo", "gleam", "marin", "meridian", "quartz", "ripple", "sage",
  "shimmer", "stone", "tempo", "verse", "vesper", "willow",
] as const;

const DEFAULT_VOICE = "cedar";

/**
 * Relay the browser's SDP offer to GPT-Live and hand back the answer.
 *
 * GPT-Live has no ephemeral client secret: the server creates the session with
 * the offer inline, so the OpenAI key never reaches the car.
 */
export async function handleSession(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return err(405, "method not allowed");
  if (!env.OPENAI_API_KEY) return err(503, "OPENAI_API_KEY is not configured");

  let body: { sdp?: unknown; voice?: unknown; history?: unknown; client?: unknown };
  try {
    body = await req.json();
  } catch {
    return err(400, "body is not valid JSON");
  }
  if (typeof body.sdp !== "string" || !body.sdp.includes("v=0")) {
    return err(400, "missing or malformed sdp offer");
  }

  const voice =
    typeof body.voice === "string" && (VOICES as readonly string[]).includes(body.voice)
      ? body.voice
      : DEFAULT_VOICE;

  // Where this session is running. The car is the default because it is the
  // one place Jarvis is used without a spare hand to correct it.
  const clientKind = isClientKind(body.client) ? body.client : "car";

  const input = buildHistory(body.history);
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  try {
    const result = await client.live.create({
      session: {
        model: "gpt-live-1",
        instructions: jarvisPrompt(clientKind),
        audio: { output: { voice } },
        // Client delegation: this app handles tool work, which is what lets the
        // Worker run MCP and speak progress during a slow Hermes call.
        delegation: { type: "client" },
        // Present only on a reconnect. GPT-Live has no resume endpoint, so a
        // dropped session is replaced by a new one carrying the transcript.
        ...(input ? { input } : {}),
        // The car browser is an untrusted frontend on a public URL, so allow it
        // only the events it actually needs. Server events stay open for now
        // because Phase 1 exists to observe the raw event stream.
        client: {
          data_channel: {
            allowed_client_events: [
              "session.commentary.append",
              "session.thinking.append",
              "session.input_audio.mute",
              "session.input_audio.unmute",
              "session.close",
            ],
            allowed_server_events: "all",
          },
        },
        store: false,
      },
      transport: { type: "webrtc", sdp: body.sdp },
    });

    return json({
      sdp: result.transport.sdp,
      sessionId: result.session.id,
      voice,
      restoredTurns: input?.length ?? 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("live.create failed:", msg);
    // Surface the reason — this is the call most likely to fail in the car, and
    // a bare 500 would leave nothing to debug from the driver's seat.
    return err(502, "could not start the Live session", { detail: msg.slice(0, 400) });
  }
}
