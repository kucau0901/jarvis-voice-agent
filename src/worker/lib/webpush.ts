/**
 * Web Push, from nothing but WebCrypto.
 *
 * A notification on a phone whose Jarvis app is closed is the one way to reach
 * someone who has no other channel set up, so it is built in rather than a
 * plug-in. The usual library (`web-push`) is written against Node's crypto
 * module; this is the same two standards on WebCrypto, so it runs unchanged on
 * Cloudflare, in the Docker image, and under the Node tests:
 *
 * - RFC 8292 (VAPID): the push service is told who is sending, with a short
 *   ES256-signed token. The key pair is made once and kept in the Durable
 *   Object, so nobody has to generate or paste one.
 * - RFC 8291 (message encryption): the payload is encrypted to the browser's
 *   own key, so the push service (Google, Apple, Mozilla) carries it without
 *   being able to read it.
 *
 * test/webpush.test.ts checks the encryption byte for byte against the worked
 * example in RFC 8291 Appendix A.
 */

const enc = new TextEncoder();

/* ---------- bytes ----------------------------------------------------------- */

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/* ---------- VAPID (RFC 8292) ------------------------------------------------ */

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url: what a browser's `applicationServerKey` takes. */
  publicKey: string;
  privateJwk: JsonWebKey;
}

export async function generateVapid(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { publicKey: b64url(raw), privateJwk };
}

/**
 * The Authorization header for one push service.
 *
 * `subject` is a contact for the push service's operators. Apple rejects a
 * token without one, and only accepts `mailto:` or `https:`, so it is the
 * site's own address.
 */
export async function vapidHeader(
  endpoint: string,
  vapid: VapidKeys,
  subject: string,
  now = Date.now(),
): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        // Twelve hours: well inside the 24 the spec allows, and a clock that is
        // a little off cannot push it over.
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    vapid.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto signs ECDSA as raw r||s, which is exactly the JWS ES256 form.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`)),
  );
  return `vapid t=${head}.${body}.${b64url(sig)}, k=${vapid.publicKey}`;
}

/* ---------- message encryption (RFC 8291, aes128gcm) ------------------------ */

/** One record holds the whole message; the payload limit keeps it well inside. */
const RECORD_SIZE = 4096;
/** What the push services promise to carry, less the header and the tag. */
export const MAX_PAYLOAD = 3_000;

/**
 * Encrypt a payload to a browser subscription.
 *
 * `fixed` exists only so the test can reproduce RFC 8291's worked example;
 * normally a fresh key pair and salt are made for every message, as they must be.
 */
export async function encrypt(
  payload: Uint8Array,
  uaPublic: Uint8Array<ArrayBuffer>,
  authSecret: Uint8Array<ArrayBuffer>,
  fixed?: { asKeys: CryptoKeyPair; salt: Uint8Array<ArrayBuffer> },
): Promise<Uint8Array<ArrayBuffer>> {
  const asKeys =
    fixed?.asKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as EcdhKeyDeriveParams, asKeys.privateKey, 256),
  );

  // Combine the ECDH secret with the subscription's auth secret…
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  // …then derive this message's key and nonce from it and the salt.
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (here, only) record, with no padding after it.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, concat(payload, Uint8Array.of(2))),
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

/* ---------- sending --------------------------------------------------------- */

export interface Subscription {
  endpoint: string;
  /** The browser's P-256 key, base64url. */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

export interface PushOutcome {
  ok: boolean;
  status: number;
  /** The subscription no longer exists (unsubscribed, app removed): stop sending to it. */
  gone: boolean;
}

/**
 * Only the push services browsers actually use. A subscription is supplied by a
 * client, and without this a device token could make Jarvis POST to any URL it
 * liked — an open relay from Cloudflare's addresses.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function pushEndpointAllowed(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

export async function sendPush(
  sub: Subscription,
  payload: string,
  vapid: VapidKeys,
  subject: string,
  opts: { ttl?: number; urgency?: "normal" | "high"; signal?: AbortSignal } = {},
): Promise<PushOutcome> {
  if (!pushEndpointAllowed(sub.endpoint)) return { ok: false, status: 0, gone: true };
  const body = await encrypt(enc.encode(payload), fromB64url(sub.p256dh), fromB64url(sub.auth));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidHeader(sub.endpoint, vapid, subject),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      // How long the push service may hold it for a phone that is off. An
      // alert about leaving in ten minutes is worthless tomorrow.
      ttl: String(opts.ttl ?? 3600),
      urgency: opts.urgency ?? "normal",
    },
    body,
    signal: opts.signal ?? AbortSignal.timeout(10_000),
  });
  await res.body?.cancel().catch(() => {});
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
