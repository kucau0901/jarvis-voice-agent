import type { Env } from "../types.ts";
import { err } from "../lib/http.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER } from "../lib/context.ts";
import { IMAGE_ID } from "../lib/images.ts";

/**
 * A picture Jarvis made (tools/image.ts), for the screen to show and Download:
 * GET /api/image?id=. Only its maker's: anyone else's id is no such picture.
 * Fetched with the auth header and handed to an <img> as a blob, as map
 * imagery is (routes/map.ts), so no credential goes in a URL.
 */
export async function handleImage(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") return err(405, "GET only");
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!IMAGE_ID.test(id)) return err(400, "not a picture's id");
  const state = stateStub(env);
  if (!state) return err(503, "pictures need the STATE Durable Object");
  const img = await state.imageGet(env.JARVIS_PERSON ?? OWNER, id, Date.now());
  if (!img) return err(404, "no such picture");
  const bin = atob(img.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Not kept by the browser, as a camera's frame is not: clearing the chat, or leaving, must take it off a shared screen too.
  return new Response(bytes, { headers: { "content-type": img.mime, "cache-control": "no-store" } });
}
