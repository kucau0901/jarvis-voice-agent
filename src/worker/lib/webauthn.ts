/**
 * Passkeys (WebAuthn), checked with nothing but WebCrypto.
 *
 * A family member signs in with a passkey on their phone: Face ID, a
 * fingerprint or the phone's PIN, and no password for anyone to guess or
 * reuse. The server's side of that is small — decode what the authenticator
 * signed, check it answers our challenge for our site, and verify one
 * signature — so it is done here rather than with a library that brings X.509
 * and ASN.1 schema machinery into the Worker for attestation formats a family
 * hub never asks for (it asks for "none").
 *
 * Supported keys: ES256 (-7, what phones and laptops make), EdDSA (-8) and
 * RS256 (-257, Windows Hello).
 *
 * Plain functions, so Node can test them with a made-up authenticator.
 */

/* ---------- base64url -------------------------------------------------------- */

export function b64u(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh challenge: 32 random bytes. */
export function newChallenge(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(32)));
}

/* ---------- CBOR: the part WebAuthn uses ------------------------------------- */

/**
 * Decode one CBOR item from `bytes` at `at`. Maps come back as Map, so the
 * integer keys COSE uses survive. Indefinite lengths, floats and big numbers
 * are refused: no authenticator sends them in what is read here.
 */
export function decodeCbor(bytes: Uint8Array, at = 0): { value: unknown; end: number } {
  const need = (n: number) => {
    if (at + n > bytes.length) throw new Error("CBOR truncated");
  };
  need(1);
  const head = bytes[at++]!;
  const major = head >> 5;
  const info = head & 31;
  let len: number;
  if (info < 24) len = info;
  else if (info === 24) { need(1); len = bytes[at]!; at += 1; }
  else if (info === 25) { need(2); len = (bytes[at]! << 8) | bytes[at + 1]!; at += 2; }
  else if (info === 26) { need(4); len = ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!; at += 4; }
  else throw new Error("CBOR length not supported");

  switch (major) {
    case 0:
      return { value: len, end: at };
    case 1:
      return { value: -1 - len, end: at };
    case 2:
      need(len);
      return { value: bytes.slice(at, at + len), end: at + len };
    case 3:
      need(len);
      return { value: new TextDecoder().decode(bytes.subarray(at, at + len)), end: at + len };
    case 4: {
      const arr: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const r = decodeCbor(bytes, at);
        arr.push(r.value);
        at = r.end;
      }
      return { value: arr, end: at };
    }
    case 5: {
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < len; i++) {
        const k = decodeCbor(bytes, at);
        const v = decodeCbor(bytes, k.end);
        map.set(k.value, v.value);
        at = v.end;
      }
      return { value: map, end: at };
    }
    case 6:
      // A tag: the item it tags is what matters.
      return decodeCbor(bytes, at);
    case 7:
      if (info === 20) return { value: false, end: at };
      if (info === 21) return { value: true, end: at };
      if (info === 22) return { value: null, end: at };
      throw new Error("CBOR simple value not supported");
    default:
      throw new Error("CBOR major type not supported");
  }
}

/* ---------- authenticator data ------------------------------------------------ */

export interface AuthData {
  rpIdHash: Uint8Array;
  /** User present: someone touched it. */
  up: boolean;
  /** User verified: Face ID, fingerprint or PIN. */
  uv: boolean;
  /** Backed up (synced), e.g. an iCloud Keychain or Google Password Manager passkey. */
  backedUp: boolean;
  counter: number;
  credentialId?: Uint8Array;
  /** The COSE public key, as sent. */
  publicKey?: Uint8Array;
}

export function parseAuthData(d: Uint8Array): AuthData {
  if (d.length < 37) throw new Error("authenticator data too short");
  const flags = d[32]!;
  const counter = ((d[33]! << 24) >>> 0) + (d[34]! << 16) + (d[35]! << 8) + d[36]!;
  const out: AuthData = {
    rpIdHash: d.slice(0, 32),
    up: !!(flags & 0x01),
    uv: !!(flags & 0x04),
    backedUp: !!(flags & 0x10),
    counter,
  };
  if (flags & 0x40) {
    // Attested credential data: AAGUID (16), id length (2), id, COSE key.
    let at = 37 + 16;
    if (d.length < at + 2) throw new Error("credential data truncated");
    const idLen = (d[at]! << 8) | d[at + 1]!;
    at += 2;
    if (d.length < at + idLen) throw new Error("credential id truncated");
    out.credentialId = d.slice(at, at + idLen);
    at += idLen;
    const key = decodeCbor(d, at);
    out.publicKey = d.slice(at, key.end);
  }
  return out;
}

/* ---------- keys ---------------------------------------------------------------- */

export const ES256 = -7;
export const EDDSA = -8;
const RS256 = -257;
const ALGORITHMS = [ES256, EDDSA, RS256];

interface Imported {
  key: CryptoKey;
  alg: number;
  verify: AlgorithmIdentifier | EcdsaParams;
}

/** A COSE public key made usable by WebCrypto. */
async function importCose(cose: Uint8Array): Promise<Imported> {
  const m = decodeCbor(cose).value;
  if (!(m instanceof Map)) throw new Error("public key is not a COSE map");
  const kty = m.get(1);
  const alg = m.get(3);
  const bytes = (k: number): string => {
    const v = m.get(k);
    if (!(v instanceof Uint8Array)) throw new Error(`public key is missing ${k}`);
    return b64u(v);
  };
  if (kty === 2 && alg === ES256 && m.get(-1) === 1) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3), ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return { key, alg, verify: { name: "ECDSA", hash: "SHA-256" } };
  }
  if (kty === 1 && alg === EDDSA && m.get(-1) === 6) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: bytes(-2), ext: true },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return { key, alg, verify: { name: "Ed25519" } };
  }
  if (kty === 3 && alg === RS256) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: bytes(-1), e: bytes(-2), alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return { key, alg, verify: { name: "RSASSA-PKCS1-v1_5" } };
  }
  throw new Error(`a key of type ${String(kty)}, algorithm ${String(alg)} is not supported`);
}

/**
 * ECDSA signatures arrive DER-encoded; WebCrypto wants r and s side by side,
 * 32 bytes each.
 */
export function derToRaw(der: Uint8Array): Uint8Array {
  let at = 0;
  const expect = (b: number) => {
    if (der[at++] !== b) throw new Error("signature is not DER");
  };
  expect(0x30);
  // The sequence length: short form here, since it is under 128 bytes.
  if (der[at++]! & 0x80) throw new Error("signature is not DER");
  const int = (): Uint8Array => {
    expect(0x02);
    const len = der[at++]!;
    let v = der.subarray(at, at + len);
    at += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new Error("signature integer too long");
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(int(), 0);
  raw.set(int(), 32);
  return raw;
}

/* ---------- what the browser sends --------------------------------------------- */

export interface RegistrationJSON {
  id: string;
  rawId?: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

export interface AuthenticationJSON {
  id: string;
  rawId?: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

export interface Expected {
  challenge: string;
  /** The page's origin, e.g. "https://jarvis.example.com". */
  origin: string;
  /** The site's host name, e.g. "jarvis.example.com". */
  rpId: string;
}

/** A stored passkey's public part. */
export interface StoredKey {
  id: string;
  /** COSE, base64url. */
  publicKey: string;
  alg: number;
  counter: number;
  transports?: string[];
  backedUp?: boolean;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const enc = new TextEncoder();
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function checkClient(raw: Uint8Array, type: string, want: Expected): string | null {
  let c: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    c = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return "client data is not JSON";
  }
  if (c.type !== type) return `expected ${type}`;
  if (c.challenge !== want.challenge) return "the challenge does not match";
  if (c.origin !== want.origin) return "it was made for another site";
  if (c.crossOrigin === true) return "it was made inside another site's frame";
  return null;
}

async function checkAuthData(a: AuthData, want: Expected): Promise<string | null> {
  if (!same(a.rpIdHash, await sha256(enc.encode(want.rpId)))) return "it belongs to another site";
  if (!a.up) return "nobody touched the authenticator";
  if (!a.uv) return "the phone did not check it was you (Face ID, fingerprint or PIN)";
  return null;
}

/** A new passkey: checked, and what to keep of it. */
export async function verifyRegistration(r: RegistrationJSON, want: Expected): Promise<Result<StoredKey>> {
  try {
    if (r.type !== "public-key") return { ok: false, error: "not a public-key credential" };
    const bad = checkClient(fromB64u(r.response.clientDataJSON), "webauthn.create", want);
    if (bad) return { ok: false, error: bad };
    const att = decodeCbor(fromB64u(r.response.attestationObject)).value;
    if (!(att instanceof Map) || !(att.get("authData") instanceof Uint8Array)) {
      return { ok: false, error: "attestation is malformed" };
    }
    const a = parseAuthData(att.get("authData") as Uint8Array);
    const bad2 = await checkAuthData(a, want);
    if (bad2) return { ok: false, error: bad2 };
    if (!a.credentialId || !a.publicKey) return { ok: false, error: "no credential in it" };
    if (b64u(a.credentialId) !== r.id) return { ok: false, error: "the credential id does not match" };
    const { alg } = await importCose(a.publicKey);
    const transports = (r.response.transports ?? []).filter((t) => typeof t === "string" && t.length < 20).slice(0, 6);
    return {
      ok: true,
      value: { id: r.id, publicKey: b64u(a.publicKey), alg, counter: a.counter, transports, backedUp: a.backedUp },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A sign-in: checked against the stored key; the new counter comes back. */
export async function verifyAuthentication(
  r: AuthenticationJSON,
  key: StoredKey,
  want: Expected,
): Promise<Result<{ counter: number }>> {
  try {
    if (r.type !== "public-key" || r.id !== key.id) return { ok: false, error: "not this passkey" };
    const client = fromB64u(r.response.clientDataJSON);
    const bad = checkClient(client, "webauthn.get", want);
    if (bad) return { ok: false, error: bad };
    const authData = fromB64u(r.response.authenticatorData);
    const a = parseAuthData(authData);
    const bad2 = await checkAuthData(a, want);
    if (bad2) return { ok: false, error: bad2 };

    const signed = new Uint8Array(authData.length + 32);
    signed.set(authData, 0);
    signed.set(await sha256(client), authData.length);
    const imported = await importCose(fromB64u(key.publicKey));
    let sig = fromB64u(r.response.signature);
    if (imported.alg === ES256) sig = derToRaw(sig);
    const good = await crypto.subtle.verify(imported.verify, imported.key, sig as Uint8Array<ArrayBuffer>, signed);
    if (!good) return { ok: false, error: "the signature is wrong" };

    // A counter that goes backwards means two copies of one key: refuse it.
    // Synced passkeys always send 0, which is fine.
    if ((a.counter !== 0 || key.counter !== 0) && a.counter <= key.counter) {
      return { ok: false, error: "this passkey's counter went backwards; it may have been copied" };
    }
    return { ok: true, value: { counter: a.counter } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------- options for the browser --------------------------------------------- */

export function creationOptions(o: {
  challenge: string;
  rpId: string;
  rpName: string;
  userId: string;
  userName: string;
  exclude: string[];
}) {
  return {
    challenge: o.challenge,
    rp: { id: o.rpId, name: o.rpName },
    user: { id: b64u(enc.encode(o.userId)), name: o.userName, displayName: o.userName },
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
    timeout: 120_000,
    attestation: "none",
    // A discoverable passkey: signing in needs no user name typed first.
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    excludeCredentials: o.exclude.map((id) => ({ type: "public-key", id })),
  };
}

export function requestOptions(o: { challenge: string; rpId: string }) {
  return { challenge: o.challenge, rpId: o.rpId, timeout: 120_000, userVerification: "required", allowCredentials: [] };
}

/**
 * The site a passkey belongs to: the page's origin, as the browser states it,
 * when it is this Worker's own address or the one set as PUBLIC_URL (behind a
 * proxy, as in Docker, the request's own URL may not be what the browser
 * used). Anything else falls back to our own, and the check then fails.
 */
export function siteOf(req: Request, publicUrl?: string): { origin: string; rpId: string } {
  const own = new URL(req.url).origin;
  let pub: string | null = null;
  try {
    pub = publicUrl ? new URL(publicUrl).origin : null;
  } catch {
    pub = null;
  }
  const said = req.headers.get("origin");
  const origin = said && (said === own || said === pub) ? said : (pub ?? own);
  return { origin, rpId: new URL(origin).hostname };
}
