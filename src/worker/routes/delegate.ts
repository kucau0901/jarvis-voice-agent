import type { Env } from "../types.ts";
import { err } from "../lib/http.ts";
import { SseStream } from "../lib/sse.ts";
import { buildHistory, type Turn } from "../lib/history.ts";
import { originOf } from "../lib/shared.ts";
import type { Principal } from "../lib/auth.ts";
import type { Grant } from "../lib/scopes.ts";
import { photosFrom } from "../lib/photos.ts";
import { run, type RunOptions } from "../lib/router.ts";

export async function handleDelegate(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  grants: readonly Grant[],
  principal: Principal,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method not allowed");
  // No OpenAI key is not refused here: Home Assistant's Assist can still
  // answer a typed house request, and run() says plainly what cannot be.

  let body: { transcript?: unknown; delegationId?: unknown; images?: unknown; surface?: unknown; origin?: unknown };
  try {
    body = await req.json();
  } catch {
    return err(400, "body is not valid JSON");
  }
  // null is JSON too, and the rest reads fields off it.
  if (body === null || typeof body !== "object") return err(400, "body must be a JSON object");

  const turns = normaliseTranscript(body.transcript);
  if (!turns.length) return err(400, "transcript is empty");

  const sse = new SseStream();
  const ac = new AbortController();
  const startedAt = Date.now();

  /*
   * If nothing can receive the answer any more, stop working for it.
   *
   * Note what this does NOT mean. The client keeps this fetch open even while
   * it tears the voice session down — the session is what costs $0.05 a minute;
   * an idle HTTP stream costs nothing. So an abort here is a real departure,
   * not a cost-saving one, and there is no point continuing.
   *
   * Work cannot outlive the request in any case: waitUntil is for cleanup, and
   * the runtime cancels anything still running a short while after the
   * invocation ends. Measured, not assumed.
   */
  req.signal.addEventListener("abort", () => {
    console.warn(`delegate: client gone after ${Date.now() - startedAt}ms`);
    ac.abort();
  });

  // A photo the user took with the phone to ask about, in a live session.
  const images = photosFrom(body.images);
  const origin = originOf(principal, body.origin);
  const opts: RunOptions = {
    ...(images.length ? { images } : {}),
    // Typed chat (src/app/chat.ts): written for reading, not for GPT-Live to say.
    ...(body.surface === "chat" ? { surface: "chat" as const, assist: true } : {}),
    // One conversation across the user's devices (lib/shared.ts).
    ...(origin ? { origin } : {}),
    waitUntil: (p) => ctx.waitUntil(p),
  };
  /*
   * Not awaited — the response must start streaming immediately so the first
   * progress note reaches the driver while the work is still running — but
   * registered with waitUntil. Without it the runtime may tear the Worker down
   * as soon as the client disconnects, and the write that saves memory would be
   * killed half-way: a fact remembered during a drive was gone by the next one.
   * It does not keep the work alive indefinitely (see the note above).
   */
  ctx.waitUntil(run(env, turns, sse, ac.signal, grants, opts).finally(() => sse.close()));

  return sse.response();
}

function normaliseTranscript(raw: unknown): Turn[] {
  // Reuse the validator that already guards the reconnect path, then flatten
  // back to plain turns. Nothing from the car becomes a developer message.
  const items = buildHistory(raw);
  if (!items) return [];
  return items.map((i) => ({
    role: i.role === "assistant" ? ("assistant" as const) : ("user" as const),
    text: (i.content as { text: string }[])[0]!.text,
  }));
}
