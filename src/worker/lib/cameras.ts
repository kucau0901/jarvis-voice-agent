import type { Env } from "../types.ts";

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

const slugOf = (name: string): string =>
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

/**
 * Cached in KV for an hour: cameras are added about as often as walls are.
 * v2 since the list began coming from a template (below).
 *
 * The address it was listed at goes with it, in the entry's metadata, and a
 * list from any other address is not used. For some seconds after a new
 * address is saved, a Worker still on the old settings (lib/settings-store.ts)
 * can list the old house and write it back; the Settings panel's Test lists an
 * address not yet saved. Neither is offered to the house in use.
 */
const CACHE_KEY = "cams:v2";
const CACHE_TTL_S = 3600;

/**
 * Only the cameras, as "entity|name" lines, rendered by Home Assistant
 * itself. Listing them used to fetch /api/states — the state of every device
 * in the house — which over a slow link into the house took most of half a
 * minute; this is a few hundred bytes.
 */
const CAMERA_TEMPLATE = "{% for s in states.camera %}{{ s.entity_id }}|{{ s.name }}\n{% endfor %}";

async function haCameras(env: Env): Promise<Camera[]> {
  const base = env.HA_BASE_URL?.replace(/\/+$/, "");
  const token = env.HA_TOKEN;
  if (!base || !token) return [];
  try {
    const hit = await env.CONFIG.getWithMetadata<{ entity: string; name: string }[], { base?: string }>(CACHE_KEY, "json");
    if (hit.value?.length && hit.metadata?.base === base) {
      return hit.value.map((c) => ({ id: c.entity, name: c.name, source: "ha" as const }));
    }
  } catch {
    // a cache miss is not a failure
  }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let list: { entity: string; name: string }[] = [];
  const t = await fetch(`${base}/api/template`, {
    method: "POST",
    headers,
    body: JSON.stringify({ template: CAMERA_TEMPLATE }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (t?.ok) {
    list = (await t.text())
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^camera\.[a-z0-9_]+\|/.test(l))
      .map((l) => {
        const [entity, ...name] = l.split("|");
        return { entity: entity!, name: name.join("|").trim() || entity!.replace("camera.", "").replace(/_/g, " ") };
      });
  } else {
    // A token without template access: every state, filtered here, as before.
    await t?.body?.cancel().catch(() => {});
    const res = await fetch(`${base}/api/states`, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res?.ok) return [];
    const states = (await res.json()) as { entity_id: string; attributes?: { friendly_name?: string } }[];
    list = states
      .filter((s) => s.entity_id.startsWith("camera."))
      .map((s) => ({
        entity: s.entity_id,
        name: s.attributes?.friendly_name ?? s.entity_id.replace("camera.", "").replace(/_/g, " "),
      }));
  }
  if (list.length) {
    await env.CONFIG.put(CACHE_KEY, JSON.stringify(list), { expirationTtl: CACHE_TTL_S, metadata: { base } }).catch(() => {});
  }
  return list.map((c) => ({ id: c.entity, name: c.name, source: "ha" as const }));
}

/**
 * A new Home Assistant token (routes/settings.ts): the same address may now
 * lead to another house. A new address needs nothing, as the list says where
 * it was made. A Worker still on the old token cannot list another house, so
 * nothing stale is written back after this.
 */
export const forgetCameras = (env: Env): Promise<void> => env.CONFIG.delete(CACHE_KEY);

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
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const IMAGE = /^image\/(jpeg|png|webp|gif)/;

export type Snapshot = { ok: true; bytes: ArrayBuffer; mime: string } | { ok: false; error: string };

/**
 * A frame fetched in the last moment, or on its way, per camera.
 *
 * Cameras behind Home Assistant are slow and get slower when asked in
 * parallel — measured in September 2026: 2.1 s for one frame, 5.4 s for the
 * fifth in a row, and 12-second timeouts once the screen's refresh and Jarvis
 * looking were both asking. So a request for a camera that already has a
 * frame on its way, or one under FRESH_MS old, gets that frame instead of
 * asking the camera again. In this isolate only; that covers the screen and
 * the router asking at the same moment, which is the case that jammed.
 */
const FRESH_MS = 2_000;
const recent = new Map<string, { at: number; frame: Promise<Snapshot> }>();

/**
 * One frame, now. `height` asks Home Assistant to scale it down first.
 *
 * Home Assistant only scales when given BOTH a width and a height — sent
 * width alone, it returned full-size frames. That mattered in September 2026,
 * when the link into the house ran at about 50 KB/s: Frigate's 1080p frames
 * (240–660 KB) took 5–20 s and often missed the timeout, while a 27 KB
 * doorbell frame took under a second. Asked for 540 pixels, Home Assistant
 * halves a 1080p frame to 960×540, about 85 KB, in 2–3 s — still plenty to
 * count cars, see a door or read a gate. (Asked for 720 it kept 170–210 KB,
 * and at 360 detail starts to go.)
 */
export function snapshot(env: Env, id: string, height?: number, now = Date.now()): Promise<Snapshot> {
  const hit = recent.get(id);
  if (hit && now - hit.at < FRESH_MS) return hit.frame;
  const frame = fetchFrame(env, id, height);
  recent.set(id, { at: now, frame });
  // A failure is not kept: the next ask should really ask.
  void frame.then((f) => {
    if (!f.ok && recent.get(id)?.frame === frame) recent.delete(id);
  });
  return frame;
}

/** For tests: forget recent frames. */
export function _forgetFrames(): void {
  recent.clear();
}

/*
 * Watching rather than looking: whether someone is arriving or leaving, a car
 * pulling in or out. One frame after another, never together (cameras slow
 * down when asked in parallel, above), each asked for at least WATCH_GAP_MS
 * after the one before was: past FRESH_MS, so never the previous frame handed
 * back, and about what a 540p frame takes over the link anyway. It stops at
 * the first failure (what came is still worth looking at), and asks for no
 * more once WATCH_SPAN_MS has passed since the first: frames further apart no
 * longer show one movement, and a camera that slow would only add another
 * twenty-second wait. Three frames give two steps, so a direction is seen
 * twice rather than guessed from one pair.
 */
const WATCH_FRAMES = 3;
const WATCH_GAP_MS = 2_500;
const WATCH_SPAN_MS = 8_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The same bytes again: two captures seconds apart never are, sensor noise alone differs. */
function samePicture(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** The frames after the first, oldest first, each with when it was asked for. */
export async function laterFrames(
  env: Env,
  id: string,
  height: number,
  first: { bytes: ArrayBuffer; at: number },
  signal?: AbortSignal,
  wait = sleep,
  clock = Date.now,
): Promise<{ bytes: ArrayBuffer; mime: string; at: number }[]> {
  const out: { bytes: ArrayBuffer; mime: string; at: number }[] = [];
  let last = first.at;
  let prev = first.bytes;
  while (out.length < WATCH_FRAMES - 1) {
    await wait(Math.max(0, last + WATCH_GAP_MS - clock()));
    last = clock();
    // No longer wanted (a newer question, the asker gone): the link is better left to what comes next.
    if (signal?.aborted || last - first.at > WATCH_SPAN_MS) break;
    const s = await snapshot(env, id, height, last);
    // The same picture again is a camera serving a stored still (Blink's cache,
    // Ring's last event): watching it longer shows nothing, and calling it
    // several pictures would have Jarvis say that nothing moved.
    if (!s.ok || samePicture(s.bytes, prev)) break;
    prev = s.bytes;
    out.push({ bytes: s.bytes, mime: s.mime, at: last });
  }
  return out;
}

/**
 * user:password for Basic auth, from a URL's (percent-encoded) parts. A stray
 * "%" is taken as written, and the pair goes as UTF-8, so a password with
 * "%zz" or "€" in it neither throws nor fails: btoa() alone takes Latin-1 only.
 * For plain ASCII it is what btoa() gives.
 */
export function basicCredentials(user: string, password: string): string {
  // Each run of escapes on its own, so one stray "%" does not keep the rest encoded.
  const decode = (s: string) =>
    s.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  let bin = "";
  for (const b of new TextEncoder().encode(`${decode(user)}:${decode(password)}`)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Long enough for a full frame over a slow link; a stall beyond it is reported, not waited out. */
const FRAME_TIMEOUT_MS = 20_000;

async function fetchFrame(env: Env, id: string, height?: number): Promise<Snapshot> {
  let url: string;
  const headers: Record<string, string> = {};
  if (id.startsWith("url:")) {
    const cam = urlCameras(env).find((c) => `url:${c.slug}` === id);
    if (!cam) return { ok: false, error: "no such camera" };
    const u = new URL(cam.url);
    if (u.username || u.password) {
      headers.Authorization = `Basic ${basicCredentials(u.username, u.password)}`;
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
    const h = height ? Math.round(height) : 0;
    url = `${base}/api/camera_proxy/${id}${h ? `?width=${Math.round((h * 16) / 9)}&height=${h}` : ""}`;
    headers.Authorization = `Bearer ${env.HA_TOKEN}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(FRAME_TIMEOUT_MS) });
  } catch (e) {
    const slow = e instanceof Error && (e.name === "TimeoutError" || /timeout|aborted/i.test(e.message));
    return { ok: false, error: slow ? "the camera took too long to answer" : `the camera did not answer (${e instanceof Error ? e.message : String(e)})` };
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
  // The timeout covers the body too: a camera can answer at once and then
  // trickle the picture. That used to throw out of here as an unexplained failure.
  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch {
    return { ok: false, error: "the camera took too long to send the picture" };
  }
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) return { ok: false, error: "the picture is too large" };
  return { ok: true, bytes, mime };
}

export function dataUrl(bytes: ArrayBuffer, mime: string): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}
