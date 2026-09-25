import type { Env } from "../types";

/**
 * Cameras Jarvis can look at, from wherever they are.
 *
 * Home Assistant's cameras, when the Home section is set up. And, for anyone
 * without Home Assistant, plain snapshot addresses listed in the CAMERAS
 * setting — most IP cameras, NVRs, Frigate and go2rtc serve a JPEG at some
 * URL:
 *
 *   Front gate = https://cam.example.com/snapshot.jpg; Driveway = http://user:pass@192.168.1.20/snap.jpg
 *
 * A LAN address only works where Jarvis can reach it — in Docker at home, not
 * on Cloudflare. User and password in the address are sent as HTTP Basic
 * authentication (a fetch cannot carry them in the URL). Cameras that only
 * speak Digest authentication need a proxy such as go2rtc in front.
 *
 * Kept free of Cloudflare imports so Node tests it.
 */

export interface Camera {
  /** "camera.front_gate" for Home Assistant, "url:front-gate" for a listed address. */
  id: string;
  name: string;
  source: "ha" | "url";
}

interface UrlCamera {
  name: string;
  slug: string;
  url: string;
}

export const slugOf = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** The CAMERAS setting, parsed; a string says what is wrong with it. */
export function parseCameraList(v: string | undefined): UrlCamera[] | string {
  const out: UrlCamera[] = [];
  for (const raw of (v ?? "").split(/[;\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 1) return `"${entry.slice(0, 40)}" should be: Name = https://…`;
    const name = entry.slice(0, eq).trim();
    const url = entry.slice(eq + 1).trim();
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") return `the address for ${name} must start with http:// or https://`;
    } catch {
      return `the address for ${name} is not a URL`;
    }
    const slug = slugOf(name);
    if (!slug) return `"${name}" needs some letters or digits in it`;
    if (out.some((c) => c.slug === slug)) return `two cameras are called ${name}`;
    out.push({ name, slug, url });
  }
  return out;
}

export function validateCameraList(v: string): string | null {
  const r = parseCameraList(v);
  if (typeof r === "string") return r;
  return r.length ? null : "list at least one camera as Name = address";
}

const urlCameras = (env: Env): UrlCamera[] => {
  const r = parseCameraList(env.CAMERAS);
  return typeof r === "string" ? [] : r;
};

/** Cached briefly in KV: the camera list changes far less often than it is asked for. */
const CACHE_KEY = "cams:v1";
const CACHE_TTL_S = 900;

async function haCameras(env: Env): Promise<Camera[]> {
  const base = env.HA_BASE_URL?.replace(/\/+$/, "");
  const token = env.HA_TOKEN;
  if (!base || !token) return [];
  try {
    const hit = (await env.CONFIG.get(CACHE_KEY, "json")) as { entity: string; name: string }[] | null;
    if (hit?.length) return hit.map((c) => ({ id: c.entity, name: c.name, source: "ha" as const }));
  } catch {
    // a cache miss is not a failure
  }
  const res = await fetch(`${base}/api/states`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (!res?.ok) return [];
  const states = (await res.json()) as { entity_id: string; attributes?: { friendly_name?: string } }[];
  const list = states
    .filter((s) => s.entity_id.startsWith("camera."))
    .map((s) => ({
      entity: s.entity_id,
      name: s.attributes?.friendly_name ?? s.entity_id.replace("camera.", "").replace(/_/g, " "),
    }));
  if (list.length) {
    await env.CONFIG.put(CACHE_KEY, JSON.stringify(list), { expirationTtl: CACHE_TTL_S }).catch(() => {});
  }
  return list.map((c) => ({ id: c.entity, name: c.name, source: "ha" as const }));
}

export async function listCameras(env: Env): Promise<Camera[]> {
  const listed = urlCameras(env).map((c) => ({ id: `url:${c.slug}`, name: c.name, source: "url" as const }));
  return [...listed, ...(await haCameras(env))];
}

export const camerasConfigured = (env: Env): boolean => !!((env.HA_BASE_URL && env.HA_TOKEN) || env.CAMERAS);

/** Spoken names are loose — "the gate", "front door" — so match generously. */
export function pickCamera(list: Camera[], want: string): Camera | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const q = norm(want);
  if (!q) return undefined;
  const exact = list.find((c) => norm(c.name) === q || norm(c.id) === q);
  if (exact) return exact;
  const words = q.split(" ").filter((w) => w.length > 2 && w !== "the" && w !== "camera");
  let best: { cam: Camera; score: number } | undefined;
  for (const c of list) {
    const hay = norm(`${c.name} ${c.id}`);
    const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    if (score && (!best || score > best.score)) best = { cam: c, score };
  }
  return best?.cam;
}

/** A picture's worth, and no more: a page or a stream by mistake must not be read into memory. */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const IMAGE = /^image\/(jpeg|png|webp|gif)/;

export type Snapshot = { ok: true; bytes: ArrayBuffer; mime: string } | { ok: false; error: string };

/**
 * One frame, now. `width` asks Home Assistant to scale it down first: a
 * 640-pixel frame is plenty to tell whether a gate is open, and costs a
 * fraction of a 4K one to look at.
 */
export async function snapshot(env: Env, id: string, width?: number): Promise<Snapshot> {
  let url: string;
  const headers: Record<string, string> = {};
  if (id.startsWith("url:")) {
    const cam = urlCameras(env).find((c) => `url:${c.slug}` === id);
    if (!cam) return { ok: false, error: "no such camera" };
    const u = new URL(cam.url);
    if (u.username || u.password) {
      headers.Authorization = `Basic ${btoa(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`)}`;
      u.username = "";
      u.password = "";
    }
    url = u.toString();
  } else {
    // An entity id is all this ever needs; pinning the shape stops a crafted
    // value reaching other paths on the Home Assistant host.
    if (!/^camera\.[a-z0-9_]{1,64}$/.test(id)) return { ok: false, error: "not a camera id" };
    const base = env.HA_BASE_URL?.replace(/\/+$/, "");
    if (!base || !env.HA_TOKEN) return { ok: false, error: "the cameras at home are not configured" };
    url = `${base}/api/camera_proxy/${id}${width ? `?width=${width}` : ""}`;
    headers.Authorization = `Bearer ${env.HA_TOKEN}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  } catch (e) {
    return { ok: false, error: `the camera did not answer (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, error: `the camera answered ${res.status}${res.status === 401 ? " — wrong user or password" : ""}` };
  }
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!IMAGE.test(mime)) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, error: `the camera sent ${mime || "something"} rather than a picture` };
  }
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_SNAPSHOT_BYTES) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, error: "the picture is too large" };
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) return { ok: false, error: "the picture is too large" };
  return { ok: true, bytes, mime };
}

export function dataUrl(bytes: ArrayBuffer, mime: string): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}
