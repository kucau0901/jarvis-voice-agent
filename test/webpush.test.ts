import {
  b64url,
  encrypt,
  fromB64url,
  generateVapid,
  pushEndpointAllowed,
  vapidHeader,
} from "../src/worker/lib/webpush.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 240) : "");
  }
}

const dec = new TextDecoder();
const subtle = crypto.subtle;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** The browser's side of RFC 8291: what a phone does with what Jarvis sends. */
async function decrypt(body: Uint8Array, uaPrivate: CryptoKey, uaPublic: Uint8Array, auth: Uint8Array) {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  const asKey = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256));
  const e = new TextEncoder();
  const info = new Uint8Array([...e.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, e.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, e.encode("Content-Encoding: nonce\0"), 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
  return { plain: plain.slice(0, plain.lastIndexOf(2)), delimiter: plain[plain.length - 1] };
}

console.log("RFC 8291 Appendix A, byte for byte");
{
  const asPublic = fromB64url("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const asPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  const jwk = {
    kty: "EC", crv: "P-256", d: asPrivate,
    x: b64url(asPublic.slice(1, 33)), y: b64url(asPublic.slice(33, 65)),
  };
  const asKeys = {
    privateKey: await subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    publicKey: await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, true, []),
  } as CryptoKeyPair;
  const body = await encrypt(
    fromB64url("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
    fromB64url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
    fromB64url("BTBZMqHH6r4Tts7J_aSIgg"),
    { asKeys, salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw") },
  );
  const header =
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const ciphertext = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";
  check("the 86-octet header matches", b64url(body.slice(0, 86)) === header, b64url(body.slice(0, 86)));
  check("the ciphertext matches", b64url(body.slice(86)) === ciphertext, b64url(body.slice(86)));
}

console.log("\na browser can read what is sent to it");
{
  const ua = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = new Uint8Array((await subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = JSON.stringify({ id: "a1", title: "Jarvis", text: "Leave in ten minutes — Jalan Ampang is slow." });
  const body = await encrypt(new TextEncoder().encode(msg), uaPublic, auth);
  const out = await decrypt(body, ua.privateKey, uaPublic, auth);
  check("round trip, including non-ASCII", dec.decode(out.plain) === msg, dec.decode(out.plain));
  check("marked as the last record", out.delimiter === 2);
  const again = await encrypt(new TextEncoder().encode(msg), uaPublic, auth);
  check("a fresh key and salt every message", b64url(again.slice(0, 16)) !== b64url(body.slice(0, 16)));
}

console.log("\nVAPID");
{
  const v = await generateVapid();
  check("public key is an uncompressed P-256 point", fromB64url(v.publicKey).length === 65 && fromB64url(v.publicKey)[0] === 4);
  check("the private half is not in the public key", !JSON.stringify(v.publicKey).includes(v.privateJwk.d!));
  const now = Date.UTC(2026, 8, 25, 12);
  const h = await vapidHeader("https://fcm.googleapis.com/fcm/send/abc", v, "https://jarvis.example.com", now);
  const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  check("header shape", !!m, h);
  if (m) {
    const claims = JSON.parse(dec.decode(fromB64url(m[2]!)));
    check("audience is the push service's origin", claims.aud === "https://fcm.googleapis.com", claims);
    check("expires within 24 hours", claims.exp - now / 1000 > 0 && claims.exp - now / 1000 <= 24 * 3600, claims);
    check("names the site as the contact", claims.sub === "https://jarvis.example.com");
    check("k is the public key", m[4] === v.publicKey);
    const pub = await subtle.importKey("raw", fromB64url(v.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(m[3]!), new TextEncoder().encode(`${m[1]}.${m[2]}`),
    );
    check("signature verifies with the public key", ok);
  }
}

console.log("\nonly real push services");
{
  for (const u of [
    "https://fcm.googleapis.com/fcm/send/x",
    "https://web.push.apple.com/QGx",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
  ]) check(`allowed: ${new URL(u).hostname}`, pushEndpointAllowed(u));
  for (const u of [
    "http://fcm.googleapis.com/fcm/send/x",
    "https://fcm.googleapis.com.evil.net/x",
    "https://evilpush.apple.com.attacker.io/x",
    "https://169.254.169.254/latest",
    "https://example.com/push",
    "not a url",
  ]) check(`refused: ${u}`, !pushEndpointAllowed(u));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
