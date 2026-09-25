import type { Env } from "../types";
import { err } from "../lib/http";
import { camerasConfigured, snapshot } from "../lib/cameras";

/**
 * A camera frame — Home Assistant's, or from a listed snapshot address — proxied.
 *
 * Same reasoning as the map proxy: the browser asks this Worker, the Worker
 * asks Home Assistant with the long-lived token. The token never reaches the
 * page, and the images inherit the shared-secret gate like every other /api
 * route.
 */
export async function handleCamera(req: Request, env: Env): Promise<Response> {
  // "camera.front_gate" (Home Assistant) or "url:front-gate" (a listed snapshot
  // address); lib/cameras.ts pins the shape of both before anything is fetched.
  const id = new URL(req.url).searchParams.get("entity") ?? "";
  if (!camerasConfigured(env)) return err(503, "no cameras are configured");
  const snap = await snapshot(env, id);
  if (!snap.ok) return err(snap.error === "no such camera" || snap.error === "not a camera id" ? 400 : 502, "camera image unavailable", { detail: snap.error });
  return new Response(snap.bytes, {
    headers: {
      "content-type": snap.mime,
      // Never cached: the whole point is that it is current.
      "cache-control": "no-store",
    },
  });
}
