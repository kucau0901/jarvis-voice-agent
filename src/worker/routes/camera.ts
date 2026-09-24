import type { Env } from "../types";
import { err } from "../lib/http";

/**
 * A camera frame from Home Assistant, proxied.
 *
 * Same reasoning as the map proxy: the browser asks this Worker, the Worker
 * asks Home Assistant with the long-lived token. The token never reaches the
 * page, and the images inherit the shared-secret gate like every other /api
 * route.
 */
export async function handleCamera(req: Request, env: Env): Promise<Response> {
  const base = env.HA_BASE_URL?.replace(/\/+$/, "");
  const token = env.HA_TOKEN;
  if (!base || !token) return err(503, "the cameras at home are not configured");

  const entity = new URL(req.url).searchParams.get("entity") ?? "";
  // An entity id is all this ever needs, and pinning the shape stops a crafted
  // value reaching arbitrary paths on the Home Assistant host.
  if (!/^camera\.[a-z0-9_]{1,64}$/.test(entity)) {
    return err(400, "entity must look like camera.some_name");
  }

  const res = await fetch(`${base}/api/camera_proxy/${entity}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    return err(502, "camera image unavailable", { status: res.status });
  }

  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "image/jpeg",
      // Never cached: the whole point is that it is current.
      "cache-control": "no-store",
    },
  });
}
