/**
 * A made-up passkey authenticator, for tests: it makes keys and signs what a
 * phone would, so the server's checks run against the real format.
 */
import { EDDSA, ES256, b64u, fromB64u, type Expected } from "../src/worker/lib/webauthn.ts";

/* ---------- a made-up authenticator ------------------------------------------ */

const enc = new TextEncoder();

/** Just enough CBOR encoding for attestation objects and COSE keys. */
export function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
    return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  if (typeof v === "number") return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") {
    const b = enc.encode(v);
    return new Uint8Array([...head(3, b.length), ...b]);
  }
  if (v instanceof Uint8Array) return new Uint8Array([...head(2, v.length), ...v]);
  if (v instanceof Map) {
    const parts: number[] = head(5, v.size);
    for (const [k, x] of v) parts.push(...cbor(k), ...cbor(x));
    return new Uint8Array(parts);
  }
  throw new Error("unsupported");
}

const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const cat = (...xs: Uint8Array[]) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of xs) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};

/** r||s to DER, as an authenticator sends it. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0]! & 0x80) v = cat(new Uint8Array([0]), v);
    return cat(new Uint8Array([0x02, v.length]), v);
  };
  const body = cat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

export interface Fake {
  id: Uint8Array;
  cose: Uint8Array;
  sign(data: Uint8Array): Promise<Uint8Array>;
  counter: number;
}

export async function makeFake(kind: "es256" | "ed25519" = "es256", counter = 0): Promise<Fake> {
  const id = crypto.getRandomValues(new Uint8Array(16));
  if (kind === "es256") {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const cose = cbor(new Map<unknown, unknown>([[1, 2], [3, ES256], [-1, 1], [-2, fromB64u(jwk.x!)], [-3, fromB64u(jwk.y!)]]));
    return {
      id,
      cose,
      counter,
      sign: async (d) => rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, d))),
    };
  }
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = cbor(new Map<unknown, unknown>([[1, 1], [3, EDDSA], [-1, 6], [-2, fromB64u(jwk.x!)]]));
  return { id, cose, counter, sign: async (d) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, d)) };
}


const counterBytes = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

export async function register(f: Fake, WANT: Expected, o: { challenge?: string; origin?: string; rpId?: string; flags?: number; type?: string } = {}) {
  const client = enc.encode(JSON.stringify({ type: o.type ?? "webauthn.create", challenge: o.challenge ?? WANT.challenge, origin: o.origin ?? WANT.origin }));
  const authData = cat(
    await sha(enc.encode(o.rpId ?? WANT.rpId)),
    new Uint8Array([o.flags ?? 0x45]),
    counterBytes(f.counter),
    new Uint8Array(16),
    new Uint8Array([f.id.length >> 8, f.id.length & 255]),
    f.id,
    f.cose,
  );
  const att = cbor(new Map<unknown, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
  return { id: b64u(f.id), rawId: b64u(f.id), type: "public-key", response: { clientDataJSON: b64u(client), attestationObject: b64u(att), transports: ["internal", "hybrid"] } };
}

export async function signIn(f: Fake, WANT: Expected, o: { challenge?: string; origin?: string; rpId?: string; flags?: number; counter?: number; tamper?: boolean } = {}) {
  const client = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: o.challenge ?? WANT.challenge, origin: o.origin ?? WANT.origin }));
  const authData = cat(await sha(enc.encode(o.rpId ?? WANT.rpId)), new Uint8Array([o.flags ?? 0x05]), counterBytes(o.counter ?? f.counter));
  const sig = await f.sign(cat(authData, await sha(client)));
  if (o.tamper) sig[sig.length - 3] ^= 1;
  return { id: b64u(f.id), type: "public-key", response: { clientDataJSON: b64u(client), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: null } };
}

