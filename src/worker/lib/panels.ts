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

/** What a panel can hold: a thing in Home Assistant, a car, the person's usage, a note. */
export type ItemKind = "home" | "car" | "usage" | "note";

export interface PanelItem {
  kind: ItemKind;
  /**
   * The entity id — or a room's lights, several ids joined by commas, shown
   * and switched as one — the car's id ("family" or c_…), "usage", or "" for a note.
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
/** Room for a room's lights side by side (MAX_ITEMS of them). */
const MAX_REF = 800;

/** The things in the house an item is: one, or a room's lights together. */
export const idsOf = (i: PanelItem): string[] => (i.kind === "home" ? i.ref.split(",") : []);

const key = (person: string) => `panels:${person}`;
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

  /** Someone left the family: their panels go with them. */
  async forget(person: string): Promise<void> {
    await this.storage.delete(key(person));
  }
}
