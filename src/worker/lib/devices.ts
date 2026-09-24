import type { Env } from "../types";
import { saneGrants, type Grant } from "./scopes.ts";

/**
 * Credentials for things that are not the car.
 *
 * The shared secret stays what it is — the owner's key, and the only thing that
 * can mint or revoke. Devices get their own tokens so that a microcontroller
 * taped to a gate can be killed on its own, without rotating the credential the
 * car depends on.
 *
 * Tokens are stored only as a SHA-256 digest, and that digest IS the KV key. A
 * lookup is therefore one `get` with no scan and no string comparison, which
 * makes the hot path constant-time by construction rather than by remembering to
 * be careful. A leaked copy of KV yields no working credential.
 *
 * Two records per device: `dev:tok:<digest>` is what auth reads, and `dev:index`
 * is what the owner lists. The index carries the digest so a rename or a
 * revocation can reach the credential record — which costs nothing, since every
 * digest is already visible as a key name to anyone who can read KV at all.
 */

/** Marks the format, so a future change is detectable rather than ambiguous. */
export const TOKEN_PREFIX = "jdv1_";

/** Lowercase, no l/o/0/1 — survives being read aloud or retyped off a screen. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const TOKEN_BODY = 32; // 32 symbols x 5 bits = 160 bits

const TOK_KEY = (digest: string) => `dev:tok:${digest}`;
const INDEX_KEY = "dev:index";
/** Last-seen lives on its own, so recording it never rewrites a shared record. */
const SEEN_KEY = (id: string) => `dev:seen:${id}`;

/** Long enough that a stale token is not a puzzle; short enough to stay cheap. */
const READ_CACHE_S = 60;
/** KV tolerates ~1 write/sec/key, so last-seen is coarse on purpose. */
const LAST_SEEN_INTERVAL_MS = 60 * 60 * 1000;

/** What the owner is shown. Deliberately carries no digest. */
export interface Device {
  id: string;
  name: string;
  scopes: Grant[];
  /** First and last few characters, so a list is readable without the secret. */
  hint: string;
  createdAt: number;
  expiresAt?: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

/** The index entry. `digest` never leaves the Worker. */
interface StoredDevice extends Device {
  digest: string;
}

const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  let out = "";
  for (const b of d) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * A new token.
 *
 * 32 divides 256 exactly, so masking a random byte with 31 picks a symbol with
 * no modulo bias — no rejection sampling needed.
 */
export function mintToken(): string {
  const bytes = new Uint8Array(TOKEN_BODY);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const b of bytes) body += ALPHABET[b & 31];
  return TOKEN_PREFIX + body;
}

const SHAPE = new RegExp(`^${TOKEN_PREFIX}[${ALPHABET}]{${TOKEN_BODY}}$`);

/** Is this a device token at all? Keeps malformed input from ever reaching KV. */
export function looksLikeToken(raw: string): boolean {
  return SHAPE.test(raw);
}

export function hintOf(token: string): string {
  return `${token.slice(0, TOKEN_PREFIX.length + 4)}…${token.slice(-4)}`;
}

const newId = () => "d_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);

const strip = (d: StoredDevice): Device => {
  const { digest: _digest, ...rest } = d;
  return rest;
};

/** Untrusted input from KV must never throw on the auth path. */
function saneDevice(raw: unknown): StoredDevice | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Partial<StoredDevice>;
  if (typeof d.id !== "string" || typeof d.name !== "string") return undefined;
  return {
    id: d.id,
    name: d.name,
    scopes: saneGrants(d.scopes),
    hint: typeof d.hint === "string" ? d.hint : "",
    digest: typeof d.digest === "string" ? d.digest : "",
    createdAt: typeof d.createdAt === "number" ? d.createdAt : 0,
    expiresAt: typeof d.expiresAt === "number" ? d.expiresAt : undefined,
    lastSeenAt: typeof d.lastSeenAt === "number" ? d.lastSeenAt : undefined,
    revokedAt: typeof d.revokedAt === "number" ? d.revokedAt : undefined,
  };
}

/** Why a token did not authenticate. Never surfaced — a 401 is a 401. */
export type LookupFailure = "unknown" | "revoked" | "expired";

export async function lookup(
  env: Env,
  token: string,
): Promise<{ ok: true; device: Device } | { ok: false; why: LookupFailure }> {
  if (!looksLikeToken(token)) return { ok: false, why: "unknown" };

  const digest = await sha256Hex(token);
  const raw = await env.CONFIG.get(TOK_KEY(digest), {
    type: "json",
    cacheTtl: READ_CACHE_S,
  }).catch(() => null);

  const device = saneDevice(raw);
  if (!device) return { ok: false, why: "unknown" };
  if (device.revokedAt) return { ok: false, why: "revoked" };
  if (device.expiresAt && device.expiresAt < Date.now()) return { ok: false, why: "expired" };
  return { ok: true, device: strip(device) };
}

async function writeToken(env: Env, d: StoredDevice): Promise<void> {
  const opts: KVNamespacePutOptions = {};
  // Let KV expire the record itself, so a lapsed token cannot linger.
  if (d.expiresAt) {
    const ttl = Math.floor((d.expiresAt - Date.now()) / 1000);
    if (ttl > 60) opts.expirationTtl = ttl;
  }
  await env.CONFIG.put(TOK_KEY(d.digest), JSON.stringify(d), opts);
}

async function readIndex(env: Env): Promise<StoredDevice[]> {
  const raw = await env.CONFIG.get(INDEX_KEY, "json").catch(() => null);
  if (!Array.isArray(raw)) return [];
  return raw.map(saneDevice).filter((d): d is StoredDevice => !!d);
}

async function writeIndex(env: Env, list: StoredDevice[]): Promise<void> {
  await env.CONFIG.put(INDEX_KEY, JSON.stringify(list));
}

/**
 * Record that a device was seen, at most hourly.
 *
 * Writing this per request would push one KV key past its ~1 write/sec ceiling,
 * and bill for it, to record something nobody reads more precisely than
 * "recently". Called inside ctx.waitUntil, so it never delays a response.
 *
 * Writes ONLY its own `dev:seen:<id>` key. It used to rewrite the whole index
 * and the token record from a read with no compare-and-swap, so a request
 * racing the owner could drop a just-minted device from the list (its token
 * still working, but unrevocable from the panel) or write a just-revoked
 * token back without its revocation.
 */
export async function touch(env: Env, device: Device): Promise<void> {
  const now = Date.now();
  const last = Number(
    await env.CONFIG.get(SEEN_KEY(device.id), { cacheTtl: READ_CACHE_S }).catch(() => null),
  );
  if (last > 0 && now - last < LAST_SEEN_INTERVAL_MS) return;
  await env.CONFIG.put(SEEN_KEY(device.id), String(now));
}

/* ---------- what the owner can do ---------------------------------------- */

export async function list(env: Env): Promise<Device[]> {
  const devices = await readIndex(env);
  const seen = await Promise.all(
    devices.map((d) => env.CONFIG.get(SEEN_KEY(d.id)).catch(() => null)),
  );
  return devices
    .map((d, i) => {
      // Older records carry lastSeenAt in the index; the seen key supersedes it.
      const at = Number(seen[i]);
      return at > 0 ? { ...d, lastSeenAt: at } : d;
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(strip);
}

/**
 * Mint one. The returned token is the ONLY time it exists in readable form;
 * everything stored is a digest, so it genuinely cannot be recovered later.
 */
export async function create(
  env: Env,
  name: string,
  scopes: Grant[],
  expiresAt?: number,
): Promise<{ device: Device; token: string }> {
  const token = mintToken();
  const stored: StoredDevice = {
    id: newId(),
    name: name.slice(0, 64),
    scopes,
    hint: hintOf(token),
    digest: await sha256Hex(token),
    createdAt: Date.now(),
    expiresAt,
  };

  const list = await readIndex(env);
  list.push(stored);
  await Promise.all([writeToken(env, stored), writeIndex(env, list)]);
  return { device: strip(stored), token };
}

/**
 * Change a device without re-issuing its token: rename, re-scope, or revoke.
 *
 * Revoking deletes the credential record but keeps the index entry, so the owner
 * can still see that the thing existed and when it was killed. Note that a
 * revocation takes up to READ_CACHE_S to be felt everywhere — see docs/api.md.
 */
export async function update(
  env: Env,
  deviceId: string,
  patch: { name?: string; scopes?: Grant[]; revoked?: boolean },
): Promise<Device | undefined> {
  const list = await readIndex(env);
  const at = list.findIndex((d) => d.id === deviceId);
  if (at === -1) return undefined;

  const before = list[at]!;
  const after: StoredDevice = {
    ...before,
    name: patch.name !== undefined ? patch.name.slice(0, 64) : before.name,
    scopes: patch.scopes !== undefined ? patch.scopes : before.scopes,
    revokedAt: patch.revoked ? (before.revokedAt ?? Date.now()) : before.revokedAt,
  };
  // Un-revoking is deliberately impossible: the credential record is gone, and
  // resurrecting a token someone was told to stop trusting is not a favour.
  if (patch.revoked === false && before.revokedAt) return strip(before);

  list[at] = after;

  if (patch.revoked) {
    await Promise.all([env.CONFIG.delete(TOK_KEY(after.digest)), writeIndex(env, list)]);
  } else {
    await Promise.all([writeToken(env, after), writeIndex(env, list)]);
  }
  return strip(after);
}

/** Permanent: the credential record and the index entry both go. */
export async function remove(env: Env, deviceId: string): Promise<boolean> {
  const list = await readIndex(env);
  const at = list.findIndex((d) => d.id === deviceId);
  if (at === -1) return false;
  const [gone] = list.splice(at, 1);
  await Promise.all([
    env.CONFIG.delete(TOK_KEY(gone!.digest)),
    env.CONFIG.delete(SEEN_KEY(gone!.id)),
    writeIndex(env, list),
  ]);
  return true;
}
