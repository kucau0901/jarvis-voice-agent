import type { Env } from "../types";
import { looksLikeToken, lookup, touch, type Device } from "./devices.ts";
import type { Grant } from "./scopes";

const enc = new TextEncoder();

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/**
 * Compare via SHA-256 digests in a constant-time loop.
 *
 * Digests are fixed-length, so the loop cannot leak the secret's length, and an
 * attacker cannot steer a digest toward a partial match the way they could with
 * a raw string prefix compare.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * Who is calling.
 *
 * The owner holds JARVIS_SHARED_SECRET and is bounded by nothing. A device holds
 * its own token and is bounded by its grants. Everything downstream branches on
 * this rather than re-deriving it.
 */
export type Principal =
  | { kind: "owner" }
  | { kind: "device"; id: string; name: string; scopes: Grant[] };

export type AuthResult = { ok: true; principal: Principal } | { ok: false; response: Response };

const deny = (status: number, error: string): AuthResult => ({
  ok: false,
  response: new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  }),
});

/**
 * The app sits on the public internet and, once Hermes is wired up, reaches a box
 * whose API server exposes terminal commands. The gate is the perimeter — it is
 * not optional, and an unset secret fails closed rather than open.
 *
 * Two credential shapes, told apart by prefix BEFORE any normalising. That
 * ordering is load-bearing: the owner's key is normalised (the car's keyboard
 * capitalises, and a key that fails on a stray space is indistinguishable from a
 * wrong one from the driver's seat), but a device token must not be — stripping
 * punctuation and case from it would quietly throw away most of its entropy.
 * Since the shared secret is uppercase base32 it can never contain a lowercase
 * letter or an underscore, so the two shapes cannot collide.
 */
export async function authorize(
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<AuthResult> {
  const raw = (
    req.headers.get("x-jarvis-key") ??
    req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ??
    ""
  ).trim();

  // --- device tokens: exact bytes, never normalised -------------------------
  if (looksLikeToken(raw)) {
    const found = await lookup(env, raw);
    // Unknown, revoked and expired are one answer to the caller. Which it was is
    // the owner's business, not the holder's.
    if (!found.ok) return deny(401, "unauthorized");

    const device: Device = found.device;
    ctx?.waitUntil(touch(env, device).catch(() => {}));
    return {
      ok: true,
      principal: { kind: "device", id: device.id, name: device.name, scopes: device.scopes },
    };
  }

  // --- the owner's key: byte-for-byte the behaviour that shipped ------------
  const expected = env.JARVIS_SHARED_SECRET;
  if (!expected) {
    return deny(503, "JARVIS_SHARED_SECRET is not configured on the Worker");
  }

  const norm = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const presented = norm(raw);

  if (!presented || !(await safeEqual(presented, norm(expected)))) {
    return deny(401, "unauthorized");
  }
  return { ok: true, principal: { kind: "owner" } };
}
