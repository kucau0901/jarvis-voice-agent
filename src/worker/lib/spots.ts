/**
 * A person's places, each with a position: where their phone tells Jarvis
 * they have arrived or left (docs/DESIGN.md, "Where they are").
 *
 * The phone does the watching. It is given this short list, asks its own
 * system to wake it at each one, and sends only "arrived:<slug>" or
 * "left:<slug>" to /api/v1/trigger, which sets off the person's routines
 * for that event as any other does (lib/routines.ts). Jarvis is never told
 * where anyone is between those, and keeps no trail: what is stored here is
 * the places a person chose to save, as an address is in their memory.
 *
 * A place saved for memory ("home", by its address) is another thing: that
 * one is for a maps service, and has no position. They meet only by name.
 */
import type { Storage } from "./state-host.ts";

export interface Spot {
  /** What its events are named by: arrived:<slug>, left:<slug>. */
  slug: string;
  name: string;
  lat: number;
  lng: number;
  /** How near counts as there, in metres. */
  radius: number;
  at: number;
}

const KEY = (person: string) => `spot:${person}`;
/** A person's, at most: a phone watches a hundred places at most, and each is a routine's worth of meaning. */
export const SPOTS_MAX = 20;
const NAME_MAX = 60;
/** With "arrived:" before it, a slug stays inside a routine's event name (lib/routines.ts EVENT_NAME, 40). */
const SLUG_MAX = 30;
/** Smaller, and a phone is "there" and "gone" by turns as its fix wanders; larger is a neighbourhood. */
export const RADIUS_MIN = 100;
export const RADIUS_MAX = 1000;
export const RADIUS_DEFAULT = 150;

/** A name as its events spell it: lower case, letters and digits, the rest as one underscore. Empty when it has none. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/_+$/, "");
}

/** The events a place sends, and what "anywhere" sends beside them when the person asked for that. */
export const placeEvent = (slug: string | null, arrive: boolean): string => (arrive ? "arrived" : "left") + (slug ? `:${slug}` : "");

/** The one a person means by a name they said: its slug, its name, or the only one whose name holds those words. */
export function findSpot(spots: readonly Spot[], said: string): Spot | null {
  const want = said.trim().toLowerCase();
  if (!want) return null;
  const exact = spots.find((s) => s.slug === slugOf(want) || s.name.toLowerCase() === want);
  if (exact) return exact;
  const holding = spots.filter((s) => s.name.toLowerCase().includes(want) || want.includes(s.name.toLowerCase()));
  return holding.length === 1 ? holding[0]! : null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export class Spots {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  async list(person: string): Promise<Spot[]> {
    return (await this.storage.get<Spot[]>(KEY(person))) ?? [];
  }

  /** Keep one; the same name again moves it. A string says why not. */
  async save(person: string, input: { name?: unknown; lat?: unknown; lng?: unknown; radius?: unknown }, now = Date.now()): Promise<Spot | string> {
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
    if (!name || name.length > NAME_MAX) return `A place needs a name, of at most ${NAME_MAX} characters.`;
    const { lat, lng } = input;
    if (!finite(lat) || !finite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return "A place needs its position: lat and lng, in degrees.";
    const radius = Math.round(Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, finite(input.radius) ? input.radius : RADIUS_DEFAULT)));
    const all = await this.list(person);
    const same = all.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const rest = all.filter((s) => s !== same);
    if (rest.length >= SPOTS_MAX) return `There are already ${SPOTS_MAX} places; remove one first.`;
    // Its events keep their name when it is moved; a new one whose name spells as another's does gets a number.
    let slug = same?.slug ?? (slugOf(name) || "place");
    for (let n = 2; !same && rest.some((s) => s.slug === slug); n++) slug = `${(slugOf(name) || "place").slice(0, SLUG_MAX - 3)}_${n}`;
    // Six decimal places is a tenth of a metre: nothing a phone gives is finer.
    const kept: Spot = { slug, name, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, radius, at: now };
    await this.storage.put(KEY(person), [...rest, kept]);
    return kept;
  }

  async remove(person: string, slug: string): Promise<boolean> {
    const all = await this.list(person);
    const left = all.filter((s) => s.slug !== slug);
    if (left.length === all.length) return false;
    await (left.length ? this.storage.put(KEY(person), left) : this.storage.delete(KEY(person)));
    return true;
  }

  /** Someone who has left the family: theirs go with them. */
  async forget(person: string): Promise<void> {
    await this.storage.delete(KEY(person));
  }
}
