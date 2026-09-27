import type { Env } from "../types";
import { looksLikeToken, lookup, touch, type Device } from "./devices.ts";
import { WILDCARD, type Grant } from "./scopes.ts";
import { looksLikeSession, type Role } from "./hub.ts";
import { sessionFor } from "./hub-client.ts";

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
 * its own token and is bounded by its grants. A member of the family signed in
 * with a passkey or a paired screen (lib/hub.ts): an admin is bounded by
 * nothing, as the owner is; anyone else by what their role allows.
 * Everything downstream branches on this, through the helpers below, rather
 * than re-deriving it.
 */
export type Principal =
  | { kind: "owner" }
  | { kind: "device"; id: string; name: string; scopes: Grant[] }
  | { kind: "member"; id: string; name: string; scopes: Grant[]; role: Role; space: string; session: string };

/** Bounded by nothing: the owner key, or a family admin. */
export const isAdmin = (p: Principal): boolean => p.kind === "owner" || (p.kind === "member" && p.role === "admin");

export const grantsOf = (p: Principal): Grant[] => (isAdmin(p) ? [WILDCARD] : (p as { scopes: Grant[] }).scopes);

/**
 * Whose a thread, a job or a routine is. An admin's are the owner's: until
 * memory, mail and alerts are each person's own, what the admin has is what
 * the owner had. Anyone else's are their own.
 */
export const whoOf = (p: Principal): string => (isAdmin(p) ? "owner" : (p as { id: string }).id);

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

  // --- a family member's session: exact bytes, never normalised -------------
  if (looksLikeSession(raw)) {
    const who = await sessionFor(env, raw).catch((e) => {
      console.warn("sessions unavailable:", e instanceof Error ? e.message : String(e));
      return null;
    });
    if (!who) return deny(401, "unauthorized");
    return {
      ok: true,
      principal: {
        kind: "member",
        id: who.user.id,
        name: who.user.name,
        scopes: who.scopes,
        role: who.member.role,
        space: who.member.space,
        session: who.session.id,
      },
    };
  }

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
