import type { Storage } from "./state-host.ts";
import { b64u } from "./webauthn.ts";
import { sha256Hex } from "./devices.ts";

/**
 * Pages, as Hark's: a small web page Jarvis makes when asked ("make me a
 * page comparing these chargers"), from sections it writes as words, never
 * HTML (lib/page-template.ts draws them, escaped). Each person's newest
 * KEEP_PAGES for PAGE_KEEP_MS, gone at once when their chat is cleared or
 * they leave, as pictures are (lib/images.ts).
 *
 * A page is opened by its address, /api/v1/p/<id>, which is served before
 * any sign-in (routes/page.ts), so it carries its own proof: a view link,
 * good for VIEW_MS and signed with a key that never leaves the Durable
 * Object; or, once an admin taps Share, a public link whose token is kept
 * only as its hash, until Stop sharing. Every refusal looks the same.
 */

export const KEEP_PAGES = 20;
export const PAGE_KEEP_MS = 30 * 86_400_000;
/** How long a view link opens the page: enough to open it, not to pass around. */
export const VIEW_MS = 3_600_000;
export const PAGE_ID = /^p[0-9a-hjkmnp-tv-z]{20}$/;
export const VIEW_TOKEN = /^\d{10,14}\.[A-Za-z0-9_-]{43}$/;
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{32}$/;

export interface PageSection {
  heading: string;
  body: string;
  table: { columns: string[]; rows: string[][] } | null;
}

export interface StoredPage {
  /** Whose it is (lib/context.ts). */
  who: string;
  at: number;
  title: string;
  subtitle?: string;
  sections: PageSection[];
  /** Shared: the public token's hash, and when. */
  share?: { hash: string; at: number };
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const pageKey = (id: string) => `page:${id}`;
const listKey = (person: string) => `pages:${person}`;
const SIGNING = "pagekey";

export class Pages {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** The key view links are signed with, made the first time it is needed; never sent anywhere. */
  private async signing(): Promise<CryptoKey> {
    let raw = await this.storage.get<string>(SIGNING);
    if (!raw) {
      raw = b64u(crypto.getRandomValues(new Uint8Array(32)));
      await this.storage.put(SIGNING, raw);
    }
    const bytes = Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }

  /** One kept, its id returned; the oldest beyond KEEP_PAGES, or past PAGE_KEEP_MS, go. */
  async put(person: string, page: Pick<StoredPage, "title" | "subtitle" | "sections">, now: number): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    const id = "p" + [...bytes].map((b) => ALPHABET[b % 32]).join("");
    await this.storage.put(pageKey(id), { who: person, at: now, ...page } satisfies StoredPage);
    const list = [...((await this.storage.get<{ id: string; at: number }[]>(listKey(person))) ?? []), { id, at: now }];
    const keep = list.filter((x) => now - x.at <= PAGE_KEEP_MS).slice(-KEEP_PAGES);
    for (const x of list) if (!keep.includes(x)) await this.storage.delete(pageKey(x.id));
    await this.storage.put(listKey(person), keep);
    return id;
  }

  /** A page of theirs, while it is kept; anyone else's, or a gone one, is null. */
  async mine(person: string, id: string, now: number): Promise<StoredPage | null> {
    const p = await this.storage.get<StoredPage>(pageKey(id));
    return p && p.who === person && now - p.at <= PAGE_KEEP_MS ? p : null;
  }

  /** A link that opens a page of theirs for VIEW_MS; null for one that is not. */
  async viewToken(person: string, id: string, now: number): Promise<string | null> {
    if (!(await this.mine(person, id, now))) return null;
    const exp = now + VIEW_MS;
    const sig = await crypto.subtle.sign("HMAC", await this.signing(), new TextEncoder().encode(`${id}.${exp}`));
    return `${exp}.${b64u(sig)}`;
  }

  /** Shared for anyone with the link, until stopped: a new token each time, the old one dead. */
  async share(person: string, id: string, now: number): Promise<string | null> {
    const p = await this.mine(person, id, now);
    if (!p) return null;
    const token = b64u(crypto.getRandomValues(new Uint8Array(24)));
    await this.storage.put(pageKey(id), { ...p, share: { hash: await sha256Hex(token), at: now } } satisfies StoredPage);
    return token;
  }

  async unshare(person: string, id: string, now: number): Promise<boolean> {
    const p = await this.mine(person, id, now);
    if (!p?.share) return false;
    const { share: _, ...rest } = p;
    await this.storage.put(pageKey(id), rest);
    return true;
  }

  /** The page a link opens: a view link of its own, unexpired, or its share token; null for anything else. */
  async open(id: string, token: string, now: number): Promise<StoredPage | null> {
    const p = await this.storage.get<StoredPage>(pageKey(id));
    if (!p || now - p.at > PAGE_KEEP_MS) return null;
    if (VIEW_TOKEN.test(token)) {
      const [exp, sig] = token.split(".") as [string, string];
      if (Number(exp) < now) return null;
      const bytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      return (await crypto.subtle.verify("HMAC", await this.signing(), bytes, new TextEncoder().encode(`${id}.${exp}`))) ? p : null;
    }
    if (SHARE_TOKEN.test(token) && p.share) return (await sha256Hex(token)) === p.share.hash ? p : null;
    return null;
  }

  /** All of theirs gone. */
  async clear(person: string): Promise<void> {
    for (const x of (await this.storage.get<{ id: string; at: number }[]>(listKey(person))) ?? []) await this.storage.delete(pageKey(x.id));
    await this.storage.delete(listKey(person));
  }
}
