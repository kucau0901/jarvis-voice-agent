import type { Storage } from "./state-host.ts";

/**
 * Panels on a person's Home tab (src/app/ui/Home.ts), made by asking Jarvis
 * (tools/panels.ts): "put the gate and the porch light on a panel", "add my
 * car to it". Each is a titled card of things — something in the house, a
 * car, what they have used, a line of text — kept per person, under a key of
 * their own, and never shown to anyone else.
 *
 * Only what a panel holds is stored here. What each thing is doing is read
 * when the panel is shown (lib/panel-view.ts), so it is never a stale copy.
 */

/** What a panel can hold: a thing in Home Assistant, a car, the person's usage, a note, or a tile wired to any of Jarvis's tools (lib/panel-tiles.ts). */
export type ItemKind = "home" | "car" | "usage" | "note" | "tile";

export interface PanelItem {
  kind: ItemKind;
  /**
   * The entity id — or a room's lights, several ids joined by commas, shown
   * and switched as one — the car's id ("family" or c_…), "usage", "" for a
   * note ("done" once it is ticked off), or a tile's reading and buttons as JSON.
   */
  ref: string;
  /** Its name on the panel; for a note, the note itself. */
  label: string;
}

export interface Panel {
  id: string;
  title: string;
  items: PanelItem[];
  at: number;
}

/** A tile's reading looked up by the model (lib/panel-tiles.ts), kept so it is asked again only when stale. */
export interface Reading {
  text: string;
  figures: { label: string; value: string }[];
  at: number;
}

export const MAX_PANELS = 8;
export const MAX_ITEMS = 20;
/**
 * Things in the house across all of one person's panels. Each is read with a
 * request of its own when the panels are shown, and a Worker on the free plan
 * may make only 50 a request: this leaves room for the cars and the rest.
 */
export const MAX_HOUSE = 30;
const MAX_TITLE = 40;
const MAX_LABEL = 120;
/** Room for a room's lights side by side, or a tile's tools and their arguments. */
const MAX_REF = 2000;

/** A short, stable key from a longer text: a tile's JSON, a note's words (FNV-1a). */
export function shortKey(prefix: string, text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${prefix}${(h >>> 0).toString(36)}`;
}

/** A note's key on its panel, by its words: a note has no id of its own. */
export const noteKey = (label: string): string => shortKey("n_", label.trim().toLowerCase());

/** Whether a note has been ticked off. */
export const ticked = (i: PanelItem): boolean => i.kind === "note" && i.ref === "done";

/** The things in the house an item is: one, or a room's lights together. */
export const idsOf = (i: PanelItem): string[] => (i.kind === "home" ? i.ref.split(",") : []);

const key = (person: string) => `panels:${person}`;
/** The readings Jarvis looked up for a person's tiles, by tile key: a key of their own, as the free plan's KV is never used for this. */
const readsKey = (person: string) => `panelreads:${person}`;
/** Someone already asking for a reading holds it this long, so a second screen does not pay for the same answer. */
const ASKING_MS = 120_000;
/** Readings kept per person; the oldest go first, so a removed tile's is not kept for ever. */
const MAX_READINGS = 40;
type Reads = Record<string, { reading?: Reading; asking?: number }>;
const clean = (s: string, max: number): string =>
  s.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const sameItem = (a: PanelItem, b: PanelItem) => a.kind === b.kind && (a.kind === "note" ? same(a.label, b.label) : a.ref === b.ref);

let n = 0;
const newId = () => `p_${Date.now().toString(36)}${(n++ % 1296).toString(36).padStart(2, "0")}`;

export class Panels {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  async list(person: string): Promise<Panel[]> {
    return (await this.storage.get<Panel[]>(key(person))) ?? [];
  }

  /**
   * Make a panel, or change the one already called `title`: `add` puts the
   * items after what it has (a thing already there is not doubled), `replace`
   * makes them all it holds. A string says why not.
   */
  async set(person: string, title: string, items: PanelItem[], mode: "add" | "replace", now = Date.now()): Promise<Panel | string> {
    const name = clean(title, MAX_TITLE);
    if (!name) return "A panel needs a name.";
    const given = items.map((i) => ({ kind: i.kind, ref: clean(i.ref, MAX_REF), label: clean(i.label, MAX_LABEL) })).filter((i) => i.label);
    const all = await this.list(person);
    const old = all.find((p) => same(p.title, name));
    if (!old && all.length >= MAX_PANELS) return `There are already ${MAX_PANELS} panels; remove one first.`;
    const kept = mode === "add" && old ? [...old.items] : [];
    for (const i of given) if (!kept.some((k) => sameItem(k, i))) kept.push(i);
    if (kept.length > MAX_ITEMS) {
      return `A panel holds at most ${MAX_ITEMS} things; this would have ${kept.length}. Put the rest on a second panel, with a title of its own, or a room's lights as its light group.`;
    }
    const house = new Set([...all.filter((p) => p !== old).flatMap((p) => p.items), ...kept].flatMap(idsOf));
    if (house.size > MAX_HOUSE) return `Panels can show at most ${MAX_HOUSE} things in the house altogether; remove some first.`;
    const panel: Panel = { id: old?.id ?? newId(), title: old && mode === "add" ? old.title : name, items: kept, at: now };
    await this.storage.put(key(person), old ? all.map((p) => (p.id === old.id ? panel : p)) : [...all, panel]);
    return panel;
  }

  /** Remove a panel, or one thing from it (by its name or id). What is left, or why nothing was removed. */
  async remove(person: string, title: string, item: string | null): Promise<Panel[] | string> {
    const all = await this.list(person);
    // Cleaned as set() cleaned what it kept, or a name it changed could never be matched.
    const panel = all.find((p) => same(p.title, clean(title, MAX_TITLE)));
    if (!panel) return `There is no panel called "${title}". There are: ${all.map((p) => p.title).join(", ") || "none"}.`;
    let left: Panel[];
    if (item !== null) {
      const what = clean(item, MAX_LABEL);
      // A note's ref is "", so an empty name must match nothing rather than every note.
      const items = what ? panel.items.filter((i) => !same(i.label, what) && !same(i.ref, what)) : panel.items;
      if (items.length === panel.items.length) {
        return `"${panel.title}" has nothing called "${item}". It holds: ${panel.items.map((i) => i.label).join(", ") || "nothing"}.`;
      }
      left = all.map((p) => (p.id === panel.id ? { ...p, items } : p));
    } else {
      left = all.filter((p) => p.id !== panel.id);
    }
    await this.storage.put(key(person), left);
    return left;
  }

  /**
   * A to-do typed straight onto a panel (no model): after the open ones,
   * before those already ticked. A string says why not.
   */
  async addNote(person: string, panelId: string, text: string): Promise<Panel | string> {
    const words = clean(text, MAX_LABEL);
    if (!words) return "A to-do needs its words.";
    return this.change(person, panelId, (items) => {
      if (items.some((i) => i.kind === "note" && same(i.label, words))) return "That is on the list already.";
      if (items.length >= MAX_ITEMS) return `A panel holds at most ${MAX_ITEMS} things.`;
      const at = items.findIndex(ticked);
      const note: PanelItem = { kind: "note", ref: "", label: words };
      return at < 0 ? [...items, note] : [...items.slice(0, at), note, ...items.slice(at)];
    });
  }

  /** A to-do ticked off, or back on: ticked ones go to the bottom, struck through, until cleared. */
  async tick(person: string, panelId: string, key: string): Promise<Panel | string> {
    return this.change(person, panelId, (items) => {
      const note = items.find((i) => i.kind === "note" && noteKey(i.label) === key);
      if (!note) return "That to-do is not on this panel.";
      const rest = items.filter((i) => i !== note);
      if (ticked(note)) {
        const at = rest.findIndex(ticked);
        const open = { ...note, ref: "" };
        return at < 0 ? [...rest, open] : [...rest.slice(0, at), open, ...rest.slice(at)];
      }
      return [...rest, { ...note, ref: "done" }];
    });
  }

  /** The ticked to-dos taken off a panel. */
  async clearTicked(person: string, panelId: string): Promise<Panel | string> {
    return this.change(person, panelId, (items) => items.filter((i) => !ticked(i)));
  }

  /** One panel's things changed in place; the change returns them, or why not. */
  private async change(person: string, panelId: string, f: (items: PanelItem[]) => PanelItem[] | string): Promise<Panel | string> {
    const all = await this.list(person);
    const panel = all.find((p) => p.id === panelId);
    if (!panel) return "There is no such panel.";
    const items = f(panel.items);
    if (typeof items === "string") return items;
    const next = { ...panel, items };
    await this.storage.put(key(person), all.map((p) => (p.id === panelId ? next : p)));
    return next;
  }

  /** A tile's kept reading, as it is. */
  async reading(person: string, tile: string): Promise<Reading | null> {
    return (await this.storage.get<Reads>(readsKey(person)))?.[tile]?.reading ?? null;
  }

  /**
   * A tile's kept reading, and whether this caller should ask for it again:
   * when it is older than `every` and nobody else is asking now. Saying yes
   * marks it as being asked, so only one screen pays for it.
   */
  async claimReading(person: string, tile: string, every: number, now = Date.now()): Promise<{ reading: Reading | null; go: boolean }> {
    const all = (await this.storage.get<Reads>(readsKey(person))) ?? {};
    const had = all[tile];
    const reading = had?.reading ?? null;
    if ((reading && now - reading.at < every) || (had?.asking && now - had.asking < ASKING_MS)) return { reading, go: false };
    all[tile] = { ...had, asking: now };
    await this.storage.put(readsKey(person), all);
    return { reading, go: true };
  }

  /** A tile's reading as just looked up, or null when the asking failed: either way it is no longer being asked. */
  async keepReading(person: string, tile: string, reading: Reading | null): Promise<void> {
    const all = (await this.storage.get<Reads>(readsKey(person))) ?? {};
    all[tile] = reading ? { reading } : { ...(all[tile]?.reading ? { reading: all[tile]!.reading } : {}) };
    const keys = Object.keys(all);
    if (keys.length > MAX_READINGS) {
      keys.sort((a, b) => (all[a]?.reading?.at ?? 0) - (all[b]?.reading?.at ?? 0));
      for (const k of keys.slice(0, keys.length - MAX_READINGS)) delete all[k];
    }
    await this.storage.put(readsKey(person), all);
  }

  /** Someone left the family: their panels go with them. */
  async forget(person: string): Promise<void> {
    await this.storage.delete(key(person));
    await this.storage.delete(readsKey(person));
  }
}
