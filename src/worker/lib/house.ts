import type { Storage } from "./state-host.ts";
import { plain, type Section } from "./brief.ts";
import { sha256Hex } from "./devices.ts";

/**
 * Watching the house: Jarvis's own picture of what matters in it, read from
 * Home Assistant in one template call with no model (docs/DESIGN.md
 * "Watching the house").
 *
 * Code chooses what matters, by kind (KINDS): doors, windows and garage
 * doors, locks, lights, covers, presence and motion, people, climate, leaks,
 * smoke and gas, the alarm, batteries and temperatures. The person can add a
 * thing or leave one out (Prefs, tools/house.ts). Home Assistant renders the
 * list itself, so only those things come back, small, and never the whole of
 * /api/states, which took half a minute over a slow link (lib/cameras.ts).
 *
 * Each read is kept (house:last) and compared with the one before: what
 * changed between them, leaving out Home Assistant starting up (unavailable,
 * unknown) and numbers that drift (a temperature is read, not followed).
 *
 * Changes are pushed by Jarvis's component in Home Assistant (the
 * jarvis-home-assistant repository): it asks which things to watch
 * (watching), listens to their changes inside Home Assistant and sends them
 * in batches (apply). Jarvis reads the house itself only when the component
 * has not been heard from, and as a safety net.
 */

/** A thing in the house as one read saw it. `t`: when its state last changed, in seconds. */
export interface Thing {
  id: string;
  name: string;
  area: string;
  /** device_class, where it has one. */
  kind: string;
  state: string;
  unit: string;
  t: number;
}

export interface Prefs {
  /** Watched as well, whatever their kind. */
  add: string[];
  /** Left out, whatever their kind. */
  ignore: string[];
}

export interface Change {
  id: string;
  from: string;
  to: string;
}

/** Things read, at most: a large house's lights and sensors, not every helper it has. */
export const MAX_THINGS = 250;
export const MAX_PREFS = 50;
/** Changes taken in one batch from the component, at most. */
export const MAX_BATCH = 100;
/** The component heard from this lately: the house as kept is the house now, without reading it. */
export const HEARD_MS = 15 * 60_000;
/** A read this recent is the house now. */
export const FRESH_MS = 3 * 60_000;
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;

/** The kinds that matter, by domain: all of the domain, or only these device classes. */
export const KINDS: Readonly<Record<string, "all" | readonly string[]>> = {
  lock: "all",
  light: "all",
  cover: "all",
  person: "all",
  climate: "all",
  alarm_control_panel: "all",
  binary_sensor: ["door", "window", "garage_door", "opening", "motion", "occupancy", "presence", "moisture", "smoke", "gas", "carbon_monoxide"],
  sensor: ["battery", "temperature"],
  switch: ["outlet"],
};

/** Numbers drift: read for what they are, never followed as changes. */
const NUMERIC = new Set(["sensor"]);
/** Home Assistant starting, or a device dropping off: not a change in the house. */
const NOISE = new Set(["unavailable", "unknown", ""]);

/** Quoted for a template: entity ids are checked, but quotes are never trusted. */
const q = (s: string) => `'${s.replace(/[^a-z0-9_.]/gi, "")}'`;

/**
 * The template that reads what matters: each thing as {i, n, a, c, s, u, t}, as JSON. Home Assistant goes through
 * its states itself, so what comes back is only these, at most MAX_THINGS.
 */
export function houseTemplate(prefs: Prefs = { add: [], ignore: [] }): string {
  const kinds = Object.entries(KINDS)
    .map(([d, c]) => (c === "all" ? `s.domain == ${q(d)}` : `(s.domain == ${q(d)} and (s.attributes.device_class | default('')) in [${c.map(q).join(",")}])`))
    .join(" or ");
  const add = `[${prefs.add.map(q).join(",")}]`;
  const ignore = `[${prefs.ignore.map(q).join(",")}]`;
  return (
    "{%- set ns = namespace(out=[]) -%}" +
    "{%- for s in states -%}" +
    `{%- if ns.out | length < ${MAX_THINGS} and s.entity_id not in ${ignore} and ((${kinds}) or s.entity_id in ${add}) -%}` +
    "{%- set ns.out = ns.out + [{'i': s.entity_id, 'n': s.name, 'a': area_name(s.entity_id) or '', 'c': s.attributes.device_class | default(''), " +
    "'s': s.state, 'u': s.attributes.unit_of_measurement | default(''), 't': as_timestamp(s.last_changed) | int(0)}] -%}" +
    "{%- endif -%}" +
    "{%- endfor -%}" +
    "{{ ns.out | tojson }}"
  );
}

/** What the template gave, as things; anything malformed is left out. Throws when it is not a list at all. */
/** A batch the component sent, as changes; anything malformed is left out. Null when it is not one. */
export function parseBatch(body: unknown): Change[] | null {
  const list = body && typeof body === "object" ? (body as { changes?: unknown }).changes : undefined;
  if (!Array.isArray(list)) return null;
  return list.slice(0, MAX_BATCH).flatMap((c): Change[] => {
    if (!c || typeof c !== "object") return [];
    const { id, from, to } = c as Record<string, unknown>;
    return typeof id === "string" && ENTITY.test(id) && typeof to === "string" ? [{ id, from: typeof from === "string" ? from.slice(0, 60) : "", to: to.slice(0, 60) }] : [];
  });
}

/** What the component watches, and a version that changes with it, so it knows to ask again. */
export async function watchList(things: readonly Thing[]): Promise<{ version: string; entities: string[] }> {
  const entities = things.map((t) => t.id).sort();
  return { version: (await sha256Hex(entities.join(","))).slice(0, 12), entities };
}

export function parseThings(rendered: string): Thing[] {
  const v: unknown = JSON.parse(rendered);
  if (!Array.isArray(v)) throw new Error("Home Assistant did not give a list");
  const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
  return v.flatMap((o): Thing[] => {
    if (!o || typeof o !== "object") return [];
    const r = o as Record<string, unknown>;
    const id = str(r.i, 100);
    if (!ENTITY.test(id)) return [];
    return [{ id, name: str(r.n, 80) || id, area: str(r.a, 60), kind: str(r.c, 40), state: str(r.s, 60), unit: str(r.u, 12), t: typeof r.t === "number" && Number.isFinite(r.t) ? r.t : 0 }];
  }).slice(0, MAX_THINGS);
}

/** What changed from one read to the next: not a number drifting, not Home Assistant starting, not a thing first seen. */
export function changes(before: readonly Thing[], now: readonly Thing[]): Change[] {
  const was = new Map(before.map((t) => [t.id, t.state]));
  return now.flatMap((t): Change[] => {
    const from = was.get(t.id);
    if (from === undefined || from === t.state || NOISE.has(t.state) || NOISE.has(from) || NUMERIC.has(t.id.split(".")[0]!)) return [];
    return [{ id: t.id, from, to: t.state }];
  });
}

/** Whether a thing is on, open, unlocked, seeing someone or sounding: what someone glancing round would notice. */
export function active(t: Thing): boolean {
  const d = t.id.split(".")[0]!;
  if (d === "lock") return ["unlocked", "unlocking", "open", "jammed"].includes(t.state);
  if (d === "cover") return ["open", "opening"].includes(t.state);
  if (d === "alarm_control_panel") return ["triggered", "pending", "arming"].includes(t.state);
  if (d === "climate") return t.state !== "off" && !NOISE.has(t.state);
  return t.state === "on";
}

const hhmm = (s: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(s * 1000));
const LOW_BATTERY = 15;
const MAX_LINES = 14;

/**
 * The house at a glance, for a look (lib/notice.ts): who is home, what is open, unlocked or on and since when, by
 * room, what is sounding, and batteries running low. Names and rooms are written by people: the look fences it all.
 */
export function houseSection(things: readonly Thing[], timeZone: string): Section | null {
  if (!things.length) return null;
  const where = (t: Thing) => (t.area ? ` (${plain(t.area, 30)})` : "");
  const since = (t: Thing) => (t.t ? ` since ${hhmm(t.t, timeZone)}` : "");
  const lines: string[] = [];
  const people = things.filter((t) => t.id.startsWith("person."));
  if (people.length) lines.push(`People: ${people.map((p) => `${plain(p.name, 30)} ${p.state === "home" ? "home" : p.state === "not_home" ? "away" : plain(p.state, 20)}`).join(", ")}`);
  for (const t of things) {
    const d = t.id.split(".")[0]!;
    if (d === "person" || d === "sensor") continue;
    if (active(t)) lines.push(`- ${plain(t.name, 40)}${where(t)}: ${plain(t.state, 20)}${since(t)}`);
  }
  for (const t of things.filter((x) => x.kind === "battery" && Number(x.state) < LOW_BATTERY && x.state !== "")) {
    lines.push(`- ${plain(t.name, 40)}${where(t)}: battery ${plain(t.state, 6)}%`);
  }
  if (lines.length > MAX_LINES) lines.splice(MAX_LINES, lines.length, `- and ${lines.length - MAX_LINES} more`);
  return lines.length ? { head: "The house", lines } : { head: "The house", lines: ["Everything watched is shut, off and quiet."] };
}

/** The house as last read (`at`), kept up to date by the component (`heardAt`: when it was last heard from). */
interface Kept {
  at: number;
  things: Thing[];
  heardAt?: number;
}

/** The house as last read, and what the person added or left out: under house:*, the household's. */
export class House {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  async prefs(): Promise<Prefs> {
    return (await this.storage.get<Prefs>("house:prefs")) ?? { add: [], ignore: [] };
  }

  /** Watch a thing whatever its kind, leave it out, or go back to its kind deciding. A string says why not. */
  async setPref(entity: string, choice: "watch" | "ignore" | "default"): Promise<Prefs | string> {
    if (!ENTITY.test(entity)) return "that is not an entity id, like light.study";
    const p = await this.prefs();
    const add = p.add.filter((e) => e !== entity);
    const ignore = p.ignore.filter((e) => e !== entity);
    if (choice === "watch") add.push(entity);
    if (choice === "ignore") ignore.push(entity);
    if (add.length > MAX_PREFS || ignore.length > MAX_PREFS) return `at most ${MAX_PREFS} each`;
    const next = { add, ignore };
    await this.storage.put("house:prefs", next);
    // What is watched moved: the next read is now (`at` 0: never read), and with it the watch list's version.
    const last = await this.last();
    if (last) await this.storage.put("house:last", { ...last, at: 0 });
    return next;
  }

  async last(): Promise<Kept | null> {
    return (await this.storage.get<Kept>("house:last")) ?? null;
  }

  /**
   * What the component sent: kept as the house now, and what it changes, as from what Jarvis last knew. A thing not
   * watched, Home Assistant starting, or a number drifting changes nothing said; a number is still kept as read.
   */
  async apply(batch: readonly Change[], now: number): Promise<Change[]> {
    const last = await this.last();
    if (!last) return [];
    const byId = new Map(last.things.map((t) => [t.id, t]));
    const out: Change[] = [];
    for (const c of batch) {
      const t = byId.get(c.id);
      if (!t || NOISE.has(c.to) || t.state === c.to) continue;
      if (!NUMERIC.has(c.id.split(".")[0]!) && !NOISE.has(t.state)) out.push({ id: c.id, from: t.state, to: c.to });
      t.state = c.to;
      t.t = Math.floor(now / 1000);
    }
    await this.storage.put("house:last", { ...last, heardAt: now });
    return out;
  }

  /** The component asked what to watch: the house as kept, read again if it is older than a safety net's while. */
  async watching(render: (template: string) => Promise<string>, now: number): Promise<{ things: Thing[]; changed: Change[] }> {
    const last = await this.last();
    if (last && last.at > 0 && now - last.at < HEARD_MS) {
      await this.storage.put("house:last", { ...last, heardAt: now });
      return { things: last.things, changed: [] };
    }
    const g = await this.glance(render, now);
    const kept = await this.last();
    if (kept) await this.storage.put("house:last", { ...kept, heardAt: now });
    return g;
  }

  /**
   * The house for a look (lib/notice.ts): the last read if it is fresh (the watch reads it each minute), else one
   * read now, not kept, so what changed is still the watch's to find.
   */
  async now(render: (template: string) => Promise<string>, now: number): Promise<Thing[]> {
    const last = await this.last();
    if (last && last.at > 0 && (now - last.at < FRESH_MS || (last.heardAt !== undefined && now - last.heardAt < HEARD_MS))) return last.things;
    return parseThings(await render(houseTemplate(await this.prefs())));
  }

  /** Read the house now (render: the template rendered by Home Assistant), keep it, and say what changed since the last read. */
  async glance(render: (template: string) => Promise<string>, now: number): Promise<{ things: Thing[]; changed: Change[] }> {
    const things = parseThings(await render(houseTemplate(await this.prefs())));
    const before = await this.last();
    await this.storage.put("house:last", { at: now, things });
    return { things, changed: before ? changes(before.things, things) : [] };
  }
}
