/**
 * Passkeys in the browser: turning the server's options into what
 * navigator.credentials wants, and its answer back into JSON.
 *
 * The server side is src/worker/lib/webauthn.ts. Written out by hand rather
 * than with PublicKeyCredential.parseCreationOptionsFromJSON(), which older
 * browsers (the car's among them) do not have.
 */

const toBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const toB64u = (b: ArrayBuffer | null): string => {
  if (!b) return "";
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials?.create;
}

interface CreationJSON {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout: number;
  attestation: AttestationConveyancePreference;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  excludeCredentials: { type: "public-key"; id: string }[];
}

interface RequestJSON {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: UserVerificationRequirement;
}

/** Why a passkey prompt ended without one, in words for the person holding the phone. */
export function passkeyError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError") return "The passkey prompt was closed, or timed out. Try again.";
  if (name === "InvalidStateError") return "This device already has a passkey for you here.";
  if (name === "SecurityError") return "Passkeys need this page's own address over https.";
  return e instanceof Error ? e.message : String(e);
}

/** Make a passkey: Face ID, a fingerprint or the phone's PIN. */
export async function createPasskey(o: CreationJSON): Promise<unknown> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: toBytes(o.challenge),
      user: { ...o.user, id: toBytes(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ type: c.type, id: toBytes(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was made.");
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      attestationObject: toB64u(r.attestationObject),
      transports: typeof r.getTransports === "function" ? r.getTransports() : [],
    },
  };
}

/** Use a passkey: whichever of theirs the person picks. */
export async function usePasskey(o: RequestJSON): Promise<unknown> {
  const cred = (await navigator.credentials.get({
    publicKey: { ...o, challenge: toBytes(o.challenge), allowCredentials: [] },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was chosen.");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature),
      userHandle: toB64u(r.userHandle),
    },
  };
}
