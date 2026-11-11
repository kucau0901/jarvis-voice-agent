/**
 * Sign-ins a person saved for the browser Jarvis drives (lib/browser.ts).
 *
 * Some sites sign you out by the clock, whatever the browser keeps: an older
 * HR system, a bank. For those a person may save their sign-in, once, and
 * Jarvis signs back in when it is asked to work there.
 *
 * What keeps that safe is in code, not in what a model is told:
 *
 * - A sign-in is saved for one site (its origin), and is only ever typed
 *   into a page of that origin. A page elsewhere that asks for it gets
 *   nothing, however it asks.
 * - The model never has the password. It asks for "sign in here"; this code
 *   finds the saved one and types it. Nothing a tool gives back holds it.
 * - It is each person's own: one person's is never used for another.
 * - It is kept sealed (AES-GCM) under a key made from the owner key, which is
 *   not in what is stored: a copy of the data alone does not give them up.
 *   The seal also names the person and the site, so one cannot be moved onto
 *   another. It is never sent to the app, and is not in an export.
 *
 * A one-time code and an "are you human" check are still the person's.
 */
import type { Storage } from "./state-host.ts";

/** One saved sign-in, as stored: the password sealed. */
export interface SavedLogin {
  id: string;
  /** The one site it is for, e.g. https://hr.example.com. */
  origin: string;
  user: string;
  /** The password, sealed: base64 of a nonce and the ciphertext. */
  sealed: string;
  at: number;
}

/** What the app is shown of one: never the password. */
export type LoginView = Pick<SavedLogin, "id" | "origin" | "user" | "at">;

const KEY = (person: string) => `vault:${person}`;
/** A person's, at most. */
export const LOGINS_MAX = 40;
const USER_MAX = 200;
const PASSWORD_MAX = 500;

/** The site a typed address names, as the origin a sign-in is kept for; a string says why not. */
export function siteOf(address: string): string {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(address.trim()) ? address.trim() : `https://${address.trim()}`);
  } catch {
    return "";
  }
  return u.protocol === "https:" || u.protocol === "http:" ? u.origin : "";
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const text = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(s));

/** The key sign-ins are sealed under: from the owner key, and for nothing else. */
async function keyFrom(ownerKey: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", text(`jarvis vault v1\n${ownerKey}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** What a seal is bound to: whose it is and which site, so it opens for no other. */
const bound = (person: string, origin: string) => text(`${person}\n${origin}`);

export async function seal(ownerKey: string, person: string, origin: string, password: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: bound(person, origin) }, await keyFrom(ownerKey), text(password)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

/** The password again; null when it does not open: another owner key, another person's, or another site's. */
export async function unseal(ownerKey: string, person: string, origin: string, sealed: string): Promise<string | null> {
  try {
    const all = unb64(sealed);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12), additionalData: bound(person, origin) }, await keyFrom(ownerKey), all.slice(12));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

let n = 0;
const newId = () => `v_${Date.now().toString(36)}${(n++ % 1296).toString(36).padStart(2, "0")}`;

export class Vault {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** As stored, the passwords sealed: for the code that signs in (tools/browser.ts), never for a reply. */
  async all(person: string): Promise<SavedLogin[]> {
    return (await this.storage.get<SavedLogin[]>(KEY(person))) ?? [];
  }

  async list(person: string): Promise<LoginView[]> {
    return (await this.all(person)).map(({ id, origin, user, at }) => ({ id, origin, user, at }));
  }

  /** Keep one, already sealed; the same login name on the same site replaces what was kept. A string says why not. */
  async save(person: string, login: Pick<SavedLogin, "origin" | "user" | "sealed">, now = Date.now()): Promise<LoginView | string> {
    const user = login.user.trim();
    if (!siteOf(login.origin) || siteOf(login.origin) !== login.origin) return "A sign-in is saved for one site, by its address.";
    if (!user || user.length > USER_MAX) return "A sign-in needs its login name.";
    if (!login.sealed) return "A sign-in needs its password.";
    const all = await this.all(person);
    const rest = all.filter((l) => !(l.origin === login.origin && l.user === user));
    if (rest.length >= LOGINS_MAX) return `There are already ${LOGINS_MAX} saved sign-ins; remove one first.`;
    const kept: SavedLogin = { id: newId(), origin: login.origin, user, sealed: login.sealed, at: now };
    await this.storage.put(KEY(person), [...rest, kept]);
    return { id: kept.id, origin: kept.origin, user: kept.user, at: kept.at };
  }

  async remove(person: string, id: string): Promise<boolean> {
    const all = await this.all(person);
    const left = all.filter((l) => l.id !== id);
    if (left.length === all.length) return false;
    await (left.length ? this.storage.put(KEY(person), left) : this.storage.delete(KEY(person)));
    return true;
  }

  /** Someone who has left the family: theirs go with them. */
  async forget(person: string): Promise<void> {
    await this.storage.delete(KEY(person));
  }
}

/** A password as it may be saved; a string says why not. */
export const passwordOk = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= PASSWORD_MAX;
