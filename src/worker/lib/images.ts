import type { Storage } from "./state-host.ts";

/**
 * Pictures Jarvis made when asked (tools/image.ts), kept so the screen can
 * fetch one (GET /api/image) and Download it. Each person's newest
 * KEEP_IMAGES for as long as the conversation is kept, then gone; and gone
 * at once when their chat is cleared or they leave the family.
 *
 * A picture is a JPEG of a few hundred kilobytes, held as the base64 OpenAI
 * sent: well under a stored value's 2 MB. Each under its own key, with a small
 * list per person, so making one never reads the others.
 */

export const KEEP_IMAGES = 20;
/** As long as the conversation is kept (lib/conversation.ts KEEP_MS). */
export const IMAGE_KEEP_MS = 30 * 86_400_000;
export const IMAGE_ID = /^i[0-9a-hjkmnp-tv-z]{9}$/;

export interface StoredImage {
  /** Whose it is (lib/context.ts): only they are given it. */
  who: string;
  at: number;
  mime: string;
  /** Base64, as OpenAI sent it. */
  data: string;
  /** What was asked for. */
  prompt: string;
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const blobKey = (id: string) => `img:${id}`;
const listKey = (person: string) => `images:${person}`;

export class Images {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** One kept, its id returned; the oldest beyond KEEP_IMAGES, or past IMAGE_KEEP_MS, go. */
  async put(person: string, img: Pick<StoredImage, "mime" | "data" | "prompt">, now: number): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    const id = "i" + [...bytes].map((b) => ALPHABET[b % 32]).join("");
    await this.storage.put(blobKey(id), { who: person, at: now, ...img } satisfies StoredImage);
    const list = [...((await this.storage.get<{ id: string; at: number }[]>(listKey(person))) ?? []), { id, at: now }];
    const keep = list.filter((x) => now - x.at <= IMAGE_KEEP_MS).slice(-KEEP_IMAGES);
    for (const x of list) if (!keep.includes(x)) await this.storage.delete(blobKey(x.id));
    await this.storage.put(listKey(person), keep);
    return id;
  }

  /** A picture of theirs, while it is kept; anyone else's, or a gone one, is null. */
  async get(person: string, id: string, now: number): Promise<StoredImage | null> {
    const img = await this.storage.get<StoredImage>(blobKey(id));
    return img && img.who === person && now - img.at <= IMAGE_KEEP_MS ? img : null;
  }

  /** All of theirs gone. */
  async clear(person: string): Promise<void> {
    for (const x of (await this.storage.get<{ id: string; at: number }[]>(listKey(person))) ?? []) await this.storage.delete(blobKey(x.id));
    await this.storage.delete(listKey(person));
  }
}
