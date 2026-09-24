import type { Env } from "../types";
import { err } from "../lib/http";

/**
 * Map and Street View imagery, proxied.
 *
 * The browser never sees the Google key: it asks this Worker, the Worker asks
 * Google. That also means the images inherit the same shared-secret gate as
 * every other /api route, so the browser fetches them with its auth header and
 * hands the blob to an <img>, rather than putting a credential in a URL.
 */

const STATIC_MAP = "https://maps.googleapis.com/maps/api/staticmap";
const STREET_VIEW = "https://maps.googleapis.com/maps/api/streetview";

/**
 * Imagery is stable, so it is worth caching — but a week proved too long during
 * development: a styling fix was invisible in the car because the old image was
 * still in the browser. The client sends a style version in the URL, so a bump
 * invalidates immediately; a day is the backstop for when someone forgets.
 */
const CACHE_SECONDS = 60 * 60 * 24;

/**
 * Note the explicit null check: `Number(null)` is 0, not NaN, so
 * `Number.isFinite` happily accepts a missing parameter and the default is
 * never reached. That turned an absent zoom into the clamp minimum of 3 — a
 * continental view — and every map came back showing half of Asia.
 */
const clampInt = (v: string | null, lo: number, hi: number, dflt: number) => {
  if (v === null || v.trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

/**
 * Static Maps caps `size` at 640 in each dimension; `scale=2` then returns twice
 * that in pixels. Asking for more does not error — it silently clamps, which is
 * why an oversized request came back looking wrong rather than failing.
 */
const MAX_SIZE = 640;

export async function handleMap(req: Request, env: Env): Promise<Response> {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return err(503, "maps is not configured");

  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return err(400, "lat and lng are required");
  }

  const kind = url.searchParams.get("kind") === "streetview" ? "streetview" : "map";
  // scale=2 doubles these, so 640x400 arrives as 1280x800 — plenty for a
  // dashboard, and the most the API will actually honour.
  const w = clampInt(url.searchParams.get("w"), 200, MAX_SIZE, 640);
  const h = clampInt(url.searchParams.get("h"), 150, MAX_SIZE, 400);

  let target: string;
  if (kind === "streetview") {
    const p = new URLSearchParams({
      size: `${w}x${h}`,
      location: `${lat},${lng}`,
      fov: "90",
      pitch: "0",
      return_error_code: "true",
      key,
    });
    const heading = url.searchParams.get("heading");
    if (heading && Number.isFinite(Number(heading))) p.set("heading", heading);
    target = `${STREET_VIEW}?${p}`;
  } else {
    const zoom = clampInt(url.searchParams.get("zoom"), 3, 20, 16);
    const satellite = url.searchParams.get("maptype") === "satellite";
    const p = new URLSearchParams({
      center: `${lat},${lng}`,
      zoom: String(zoom),
      size: `${w}x${h}`,
      scale: "2",
      maptype: satellite ? "satellite" : "roadmap",
      markers: `color:0x4fd1e0|${lat},${lng}`,
      key,
    });

    /*
     * A dark map, to suit the app and not to dazzle at night.
     *
     * Built as layers, because a single "feature:all|element:geometry" rule
     * paints the roads the same colour as the land and the map arrives with
     * nothing on it but floating labels — which is exactly what the first
     * version did. Roads have to be lifted back out of the background
     * explicitly, brightest for the biggest ones.
     */
    if (!satellite) {
      for (const style of [
        "feature:all|element:geometry|color:0x11161f",
        "feature:all|element:labels.text.fill|color:0x9aa6b8",
        "feature:all|element:labels.text.stroke|color:0x0b0f16|weight:2",
        "feature:all|element:labels.icon|visibility:off",
        "feature:administrative|element:geometry.stroke|color:0x24303f",
        "feature:landscape|element:geometry|color:0x0e131b",
        "feature:poi|element:geometry|color:0x141b25",
        "feature:poi|element:labels|visibility:simplified",
        "feature:road|element:geometry|color:0x3c4a5e",
        "feature:road.arterial|element:geometry|color:0x4e6078",
        "feature:road.highway|element:geometry|color:0x6b82a3",
        "feature:road.highway|element:geometry.stroke|color:0x7e97ba",
        "feature:road|element:labels.text.fill|color:0xb6c2d4",
        "feature:transit|element:geometry|color:0x1a2230",
        "feature:water|element:geometry|color:0x0a1826",
        "feature:water|element:labels.text.fill|color:0x3f5f80",
      ]) {
        p.append("style", style);
      }
    }
    target = `${STATIC_MAP}?${p}`;
  }

  const res = await fetch(target, { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return err(502, "maps imagery unavailable", { status: res.status, detail: detail.slice(0, 200) });
  }

  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "image/png",
      "cache-control": `private, max-age=${CACHE_SECONDS}`,
    },
  });
}
