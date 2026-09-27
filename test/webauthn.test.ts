import {
  EDDSA,
  ES256,
  b64u,
  creationOptions,
  decodeCbor,
  derToRaw,
  fromB64u,
  parseAuthData,
  siteOf,
  verifyAuthentication,
  verifyRegistration,
  type Expected,
  type StoredKey,
} from "../src/worker/lib/webauthn.ts";
import { cbor, makeFake, rawToDer, register as registerAt, signIn as signInAt, type Fake } from "./fake-authenticator.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : "");
  }
}

const WANT: Expected = { challenge: b64u(crypto.getRandomValues(new Uint8Array(32))), origin: "https://jarvis.example.com", rpId: "jarvis.example.com" };
const register = (f: Fake, o: Parameters<typeof registerAt>[2] = {}) => registerAt(f, WANT, o);
const signIn = (f: Fake, o: Parameters<typeof signInAt>[2] = {}) => signInAt(f, WANT, o);

/* ---------- the tests -------------------------------------------------------- */

console.log("encoding");
{
  const bytes = crypto.getRandomValues(new Uint8Array(33));
  check("base64url round-trips", b64u(fromB64u(b64u(bytes))) === b64u(bytes) && !/[+/=]/.test(b64u(bytes)));
  const m = decodeCbor(cbor(new Map<unknown, unknown>([[1, 2], [-7, "x"], ["k", new Uint8Array([1, 2])]]))).value as Map<unknown, unknown>;
  check("CBOR maps keep integer and text keys", m.get(1) === 2 && m.get(-7) === "x" && (m.get("k") as Uint8Array)[1] === 2);
  let threw = false;
  try {
    decodeCbor(new Uint8Array([0x5f]));
  } catch {
    threw = true;
  }
  check("indefinite lengths are refused", threw);
  const raw = crypto.getRandomValues(new Uint8Array(64));
  raw[0] = 0x80; // needs a leading zero in DER
  raw[32] = 0;
  raw[33] = 5; // a short integer in DER
  check("DER signatures convert back to r||s", b64u(derToRaw(rawToDer(raw))) === b64u(raw));
}

console.log("\nregistering a passkey");
let stored: StoredKey;
const fake = await makeFake();
{
  const r = await verifyRegistration(await register(fake), WANT);
  check("a good registration is accepted", r.ok, r);
  stored = (r as { ok: true; value: StoredKey }).value;
  check("its key and algorithm are kept", stored.alg === ES256 && stored.id === b64u(fake.id) && parseAuthData(new Uint8Array(37)).counter === 0);
  check("transports are kept", stored.transports?.join() === "internal,hybrid");

  const bad = async (name: string, o: Parameters<typeof register>[1], why: RegExp) => {
    const x = await verifyRegistration(await register(fake, o), WANT);
    check(name, !x.ok && why.test((x as { error: string }).error), x);
  };
  await bad("another challenge is refused", { challenge: "abc" }, /challenge/);
  await bad("another site's page is refused", { origin: "https://evil.example" }, /another site/);
  await bad("a key for another site is refused", { rpId: "evil.example" }, /another site/);
  await bad("without Face ID, fingerprint or PIN it is refused", { flags: 0x41 }, /check it was you/);
  await bad("a sign-in passed off as a registration is refused", { type: "webauthn.get" }, /expected webauthn.create/);
}

console.log("\nsigning in");
{
  const ok = await verifyAuthentication(await signIn(fake), stored, WANT);
  check("a good sign-in is accepted", ok.ok, ok);
  const tampered = await verifyAuthentication(await signIn(fake, { tamper: true }), stored, WANT);
  check("a wrong signature is refused", !tampered.ok);
  const other = await makeFake();
  const forged = await verifyAuthentication({ ...(await signIn(other)), id: stored.id }, stored, WANT);
  check("another key's signature is refused", !forged.ok);
  check("an old challenge is refused", !(await verifyAuthentication(await signIn(fake, { challenge: "old" }), stored, WANT)).ok);
  check("another site's page is refused", !(await verifyAuthentication(await signIn(fake, { origin: "https://evil.example" }), stored, WANT)).ok);
  check("no user verification is refused", !(await verifyAuthentication(await signIn(fake, { flags: 0x01 }), stored, WANT)).ok);

  const counted = await makeFake("es256", 7);
  const reg = (await verifyRegistration(await register(counted), WANT)) as { ok: true; value: StoredKey };
  const next = await verifyAuthentication(await signIn(counted, { counter: 8 }), reg.value, WANT);
  check("a counter that goes up is accepted and returned", next.ok && next.value.counter === 8, next);
  const back = await verifyAuthentication(await signIn(counted, { counter: 7 }), reg.value, WANT);
  check("a counter that does not go up means a copied key: refused", !back.ok && /copied/.test((back as { error: string }).error));
}

console.log("\nEd25519 keys");
{
  const ed = await makeFake("ed25519");
  const r = await verifyRegistration(await register(ed), WANT);
  check("registered", r.ok && r.value.alg === EDDSA, r);
  if (r.ok) check("and signs in", (await verifyAuthentication(await signIn(ed), r.value, WANT)).ok);
}

console.log("\noptions and the site");
{
  const o = creationOptions({ challenge: "c", rpId: "x.example", rpName: "Jarvis", userId: "u_1", userName: "Aisha", exclude: ["k1"] });
  check("asks for a discoverable passkey and user verification", o.authenticatorSelection.residentKey === "required" && o.authenticatorSelection.userVerification === "required");
  check("does not ask for attestation", o.attestation === "none" && o.excludeCredentials[0]!.id === "k1");
  const req = (origin?: string) => new Request("https://worker.internal/api/auth/login/verify", { method: "POST", headers: origin ? { origin } : {} });
  check("the page's own origin is used", siteOf(req("https://worker.internal")).rpId === "worker.internal");
  check("behind a proxy, PUBLIC_URL's origin is accepted", siteOf(req("https://jarvis.example.com"), "https://jarvis.example.com/").origin === "https://jarvis.example.com");
  check("any other origin is not", siteOf(req("https://evil.example"), "https://jarvis.example.com").origin === "https://jarvis.example.com");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
