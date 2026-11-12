import type { Storage } from "./state-host.ts";
import { sanitise } from "./memory.ts";
import { pageUrl } from "./page-look.ts";
import { tidy, wellFormed } from "./quote.ts";
import { hintOf, mintToken, sha256Hex } from "./devices.ts";
import { jobTool } from "./jobs.ts";
import { canonical, classify, MAX_SAYS } from "./proposals.ts";
import { nameOf } from "./skills.ts";
import { makeAlert, type Alert } from "./alerts.ts";

/**
 * Components (docs/components.md): outside systems plugged into Jarvis. A
 * school's timetable, a shop's till, anything with a world of its own. Each
 * is an MCP server (tools Jarvis may call), an address of its own at Jarvis
 * to report what happened (lib/component-reports.ts), and an optional
 * manifest naming the events it reports.
 *
 * An admin adds one by its public https address (Settings → Components) and
 * has Jarvis list what it offers. Nothing is offered to anyone until an admin
 * has seen every tool's name and description and approved them: that list is
 * then pinned, and is what the model is shown, with no call to the component
 * until a tool is used. What it lists later that differs waits (`waiting`)
 * to be approved again, and the pinned list stays in force meanwhile.
 *
 * Who reaches it is a share per person, as a car's is: "see" (its reading
 * tools) or "use" (all of them), whether they are told what it reports, and
 * who they are in the component's own system. An admin needs a share too.
 * The `components` scope is only the ceiling over that.
 *
 * Each tool reads or acts. One that acts asks first when nobody is there (a
 * report's suggestion, a routine, a job), unless the owner set it to run by
 * itself (`alone`), which goes back to asking when the tool's description or
 * arguments change.
 *
 * Its key is typed only in Settings, sent only to its address, and dropped
 * when that address changes; its reporting address is kept only as a digest.
 * One record each, under its own key, in the Durable Object.
 */

export const MAX_COMPONENTS = 20;
export const MAX_TOOLS = 30;
/** A tool's description past this is cut, and the cut text is what is approved and shown to the model. */
export const MAX_DESCRIPTION = 500;
/** A tool whose arguments' schema is larger is left out. */
export const MAX_SCHEMA = 4096;
export const MAX_MANIFEST = 8192;
export const MAX_EVENTS = 16;
/** What an event means, in its manifest's words. */
export const EVENT_SAYS = 100;
/** Things told from its reports in a day; routines still fire past it. */
export const TOLD_PER_DAY = 30;
/** Things done by itself in a day, however they start: where a loop between Jarvis and a component stops. */
export const ALONE_PER_DAY = 20;
const MAX_NAME = 40;

/** Its label goes before its tools' names (`school__get_absent`) and its events' (`school:leave_filed`), and never changes. */
export const LABEL = /^[a-z][a-z0-9-]{1,14}$/;
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const EVENT_TYPE = /^[a-z][a-z0-9_]{0,23}$/;
/** Who a person is in the component's own system: sent as X-Jarvis-Person, so nothing a header cannot carry. */
const AS = /^[A-Za-z0-9._@:-]{1,64}$/;
/**
 * Labels a component may not have: the events a phone sends for places
 * (lib/spots.ts), the house's MCP server, and what Jarvis keeps for itself
 * and for what is built in today. MCP servers added in chat are `skill-…`.
 */
const RESERVED = new Set(["arrived", "left", "home-assistant", "jarvis", "house", "home", "family", "car"]);
/** A reporting address's token (lib/devices.ts mintToken): kept only as its digest, shown once. */
export const INBOX_PREFIX = "jcp1_";

const C = "component:";
/** What it listed last that is not what is pinned: waiting for an admin. Not under "component:", which list() reads. */
const NEW = "componentnew:";
/** A reporting token's digest, to its component. */
const IN = "componentin:";
/** What it was told and did by itself, for one day. */
const DAY = "componentday:";

export interface Share {
  level: "see" | "use";
  /** Told what it reports that is worth telling. */
  tell?: true;
  /** Their id in the component's own system. */
  as?: string;
}

export interface PinnedTool {
  /** Its own name, without the label. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Only reads: offered wherever reading tools are. Otherwise it acts. */
  reads: boolean;
  /** An acting tool the owner lets run with nobody there. */
  alone?: true;
  /** Approved as not offered at all. */
  off?: true;
  /** What the component itself says of it (MCP's readOnlyHint), shown beside the admin's choice. */
  hint?: boolean;
}

export interface Catalog {
  /** The address it was listed at: it is offered only while that is still the component's. */
  url: string;
  hash: string;
  at: number;
  version?: string;
  tools: PinnedTool[];
  events: { type: string; says: string }[];
}

export interface Component {
  id: string;
  label: string;
  name: string;
  url: string;
  key?: string;
  pinned?: Catalog;
  /** By person (lib/context.ts): "owner" for the first person, else a member's id. */
  shares: Record<string, Share>;
  inbox?: { digest: string; hint: string; at: number };
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A tool as Settings shows it: its arguments by name, never its whole schema.
 * `looksUp`: its own name reads like a look-up, so classed as acting it is
 * never proposed or run with nobody there (lib/proposals.ts classify).
 */
export type ToolView = Omit<PinnedTool, "inputSchema"> & { args: string[]; looksUp?: true; change?: "new" | "changed" };
export interface CatalogView {
  hash: string;
  at: number;
  version?: string;
  tools: ToolView[];
  events: { type: string; says: string }[];
  /** On what waits: pinned tools it no longer lists. */
  gone?: string[];
}

/** A component as Settings sees it: whether it has a key and an address, never the key or the digest. */
export type ComponentView = Omit<Component, "key" | "inbox" | "pinned"> & {
  hasKey: boolean;
  /** What is approved, and whether it is in force (false once the address changed since). */
  pinned?: CatalogView & { inForce: boolean };
  /** What it listed last that differs, each tool classed as approving it as it stands would. */
  waiting?: CatalogView;
  address?: { hint: string; at: number };
};

/** What a check found at a component's address (tools/mcp.ts listRemote), before any of it is trusted. */
export interface Listed {
  url: string;
  version?: string;
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown>; readOnly?: boolean }[];
  /** The text of its `jarvis://manifest` resource; null when it has none. */
  manifest: string | null;
}

/** A component as it is offered to one person (offeredTo): for the Worker only, which sends its key nowhere but its address. */
export interface Offered {
  id: string;
  label: string;
  name: string;
  url: string;
  key?: string;
  level: Share["level"];
  as?: string;
  tools: PinnedTool[];
  events: { type: string; says: string }[];
}

export type ToolClass = "reads" | "acts" | "off";

interface Counted {
  day: string;
  told: number;
  acted: number;
  /** The ids of events taken that day, the newest last (lib/component-reports.ts). */
  seen?: string[];
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const random = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALPHABET[b % 32]).join("");
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Someone else's words, on one line, cut to fit and left whole (lib/quote.ts). */
const cut = (s: unknown, max: number) => (typeof s === "string" ? wellFormed(tidy(s).slice(0, max)).trim() : "");

/** Whether a tool reads, by its own name alone: lib/jobs.ts jobTool's rule for an MCP tool. */
const readsByName = (name: string) => jobTool({ name: `c__${name}` });

const classOf = (t: PinnedTool): ToolClass => (t.off ? "off" : t.reads ? "reads" : "acts");
const sameTool = (a: PinnedTool, b: PinnedTool) => a.description === b.description && canonical(a.inputSchema) === canonical(b.inputSchema);

/**
 * The events a manifest declares, or why it cannot be read. A manifest is the
 * component's `jarvis://manifest` resource: {"jarvis": 1, "events": [{"type",
 * "says"}]}. Keys it does not know are ignored, so later versions can add to it.
 */
export function manifestEvents(text: string | null): { type: string; says: string }[] | string {
  if (text === null) return [];
  if (new TextEncoder().encode(text).length > MAX_MANIFEST) return `it is over ${MAX_MANIFEST / 1024} KB`;
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return "it is not JSON";
  }
  if (!plain(m)) return "it must be a JSON object";
  if (m.jarvis !== 1) return 'it must say "jarvis": 1';
  const raw = m.events ?? [];
  if (!Array.isArray(raw)) return "events must be a list";
  if (raw.length > MAX_EVENTS) return `at most ${MAX_EVENTS} events`;
  const out: { type: string; says: string }[] = [];
  for (const e of raw) {
    const type = plain(e) && typeof e.type === "string" ? e.type : "";
    if (!EVENT_TYPE.test(type)) return `an event's type is lower-case letters, digits and _, at most 24 (${cut(plain(e) ? String(e.type) : String(e), 40)})`;
    if (out.some((o) => o.type === type)) return `the event ${type} is declared twice`;
    const says = cut(plain(e) ? e.says : "", EVENT_SAYS);
    if (!says) return `the event ${type} needs says: a few words on what it means`;
    out.push({ type, says });
  }
  return out.sort((a, b) => (a.type < b.type ? -1 : 1));
}

/**
 * A call of one of its tools, in words code writes from the call itself
 * (lib/proposals.ts classify): what its card says, and what is told when it
 * is done by itself. Null for one that cannot be said whole, or whose own
 * name reads like a look-up, which is never proposed.
 */
export function saysOf(label: string, tool: string, args: Record<string, unknown>): string | null {
  const w = classify(`${label}__${tool}`, args);
  return w && w.says.length <= MAX_SAYS ? w.says : null;
}

/**
 * What it did with nobody there, as an alert for `person`: under its name, in
 * words written here from the call, never a model's account of it. Shown, not
 * spoken: whatever started it says its own piece.
 */
export function didAlert(c: Pick<Component, "id" | "name" | "label">, tool: string, args: Record<string, unknown>, ok: boolean, now: number, person: string): Alert | null {
  const says = saysOf(c.label, tool, args);
  const a = says ? makeAlert({ title: c.name, text: `${ok ? "Done by itself" : "Tried by itself, and it did not work"}: ${says}`, speak: false }, "api", now, person) : null;
  return a && { ...a, skill: { id: c.id, name: c.name } };
}

/** What an approval covers: the address, every tool's name, description and arguments, and the events. Not how each is classed. */
const hashOf = (url: string, tools: readonly PinnedTool[], events: Catalog["events"]) =>
  sha256Hex(canonical({ url, tools: tools.map((t) => [t.name, t.description, t.inputSchema]), events }));

/**
 * What was listed, as a catalog to approve, with the tools left out and why;
 * or why none of it can be used. A tool's first class is "reads" only if its
 * own name reads and it does not say otherwise itself: anything else acts.
 */
export async function catalogOf(listed: Listed, at: number): Promise<{ catalog: Catalog; skipped: { name: string; why: string }[] } | string> {
  const events = manifestEvents(listed.manifest);
  if (typeof events === "string") return `its manifest cannot be used: ${events}`;
  const tools: PinnedTool[] = [];
  const skipped: { name: string; why: string }[] = [];
  for (const t of Array.isArray(listed.tools) ? listed.tools : []) {
    const name = plain(t) && typeof t.name === "string" ? t.name : "";
    const skip = (why: string) => void skipped.push({ name: cut(name, 60) || "(no name)", why });
    if (!TOOL_NAME.test(name)) skip("its name must be lower-case letters, digits and _, at most 40");
    else if (tools.some((x) => x.name === name)) skip("it is listed twice");
    else {
      const inputSchema = plain(t.inputSchema) ? t.inputSchema : { type: "object", properties: {} };
      if (JSON.stringify(inputSchema).length > MAX_SCHEMA) skip(`its arguments' schema is over ${MAX_SCHEMA / 1024} KB`);
      else if (tools.length >= MAX_TOOLS) skip(`more than ${MAX_TOOLS} tools`);
      else {
        const hint = typeof t.readOnly === "boolean" ? t.readOnly : undefined;
        tools.push({ name, description: cut(t.description, MAX_DESCRIPTION) || name, inputSchema, reads: readsByName(name) && hint !== false, ...(hint !== undefined ? { hint } : {}) });
      }
    }
  }
  if (!tools.length && !events.length) return "it offers nothing Jarvis can use: no tool, and no event in a manifest";
  tools.sort((a, b) => (a.name < b.name ? -1 : 1));
  const version = cut(listed.version, 40);
  return { catalog: { url: listed.url, hash: await hashOf(listed.url, tools, events), at, ...(version ? { version } : {}), tools, events }, skipped };
}

/**
 * A listed catalog as approving it would pin it, given what is pinned now and
 * the classes chosen: a tool unchanged keeps its class, and its leave to run
 * by itself; a new or changed one starts from its own (catalogOf) and asks
 * first. At another address than the pinned one, every tool is new.
 */
function settle(listed: Catalog, pinned: Catalog | undefined, chosen: Record<string, ToolClass> = {}): PinnedTool[] {
  const had = new Map((pinned?.url === listed.url ? pinned.tools : []).map((t) => [t.name, t]));
  return listed.tools.map((t): PinnedTool => {
    const was = had.get(t.name);
    const kept = was && sameTool(was, t) ? was : undefined;
    const cls = chosen[t.name] ?? classOf(kept ?? t);
    // Switched off, it keeps the class it would have, for when it is switched on again.
    const reads = cls === "off" ? (kept ?? t).reads : cls === "reads";
    return { ...t, reads, ...(cls === "off" ? { off: true as const } : {}), ...(cls === "acts" && kept?.alone ? { alone: true as const } : {}) };
  });
}

/** The classes a request names, for these tools; or why not. */
function classesOf(raw: unknown, tools: readonly PinnedTool[]): Record<string, ToolClass> | string {
  if (raw === undefined || raw === null) return {};
  if (!plain(raw)) return "classes must name each tool as reads, acts or off";
  const out: Record<string, ToolClass> = {};
  for (const [name, cls] of Object.entries(raw)) {
    if (!tools.some((t) => t.name === name)) return `it has no tool called ${cut(name, 60)}`;
    if (cls !== "reads" && cls !== "acts" && cls !== "off") return `${name} must be reads, acts or off`;
    out[name] = cls;
  }
  return out;
}

const argsOf = (schema: Record<string, unknown>): string[] => (plain(schema.properties) ? Object.keys(schema.properties).slice(0, 12).map((k) => cut(k, 40)) : []);
const toolView = ({ inputSchema, ...t }: PinnedTool): ToolView => ({ ...t, args: argsOf(inputSchema), ...(readsByName(t.name) ? { looksUp: true as const } : {}) });
const catalogView = (c: Catalog, tools: readonly PinnedTool[] = c.tools): CatalogView => ({ hash: c.hash, at: c.at, ...(c.version ? { version: c.version } : {}), tools: tools.map(toolView), events: c.events });

export class Components {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }

  private async all(): Promise<Component[]> {
    return [...(await this.storage.list<Component>({ prefix: C })).values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  private get(id: string): Promise<Component | undefined> {
    return this.storage.get<Component>(C + id);
  }

  private async view(c: Component): Promise<ComponentView> {
    const { key, inbox, pinned, ...rest } = c;
    const waiting = await this.storage.get<Catalog>(NEW + c.id);
    let waits: CatalogView | undefined;
    if (waiting && waiting.url === c.url) {
      const had = new Map((pinned?.url === waiting.url ? pinned.tools : []).map((t) => [t.name, t]));
      const tools = settle(waiting, pinned).map((t): ToolView => {
        const was = had.get(t.name);
        return { ...toolView(t), ...(!was ? { change: "new" as const } : sameTool(was, t) ? {} : { change: "changed" as const }) };
      });
      const gone = [...had.keys()].filter((n) => !waiting.tools.some((t) => t.name === n));
      waits = { ...catalogView(waiting), tools, ...(gone.length ? { gone } : {}) };
    }
    return {
      ...rest,
      hasKey: !!key,
      ...(pinned ? { pinned: { ...catalogView(pinned), inForce: pinned.url === c.url } } : {}),
      ...(waits ? { waiting: waits } : {}),
      ...(inbox ? { address: { hint: inbox.hint, at: inbox.at } } : {}),
    };
  }

  /** Every component, for Settings, with what each was told and did by itself on `day`: today (lib/usage.ts dayOf). */
  async list(day: string): Promise<(ComponentView & { today: { told: number; acted: number } })[]> {
    return Promise.all((await this.all()).map(async (c) => {
      const counted = await this.storage.get<Counted>(DAY + c.id);
      return { ...(await this.view(c)), today: counted?.day === day ? { told: counted.told, acted: counted.acted } : { told: 0, acted: 0 } };
    }));
  }

  private async change(id: string, now: number, how: (c: Component) => Component | string | Promise<Component | string>): Promise<ComponentView | string> {
    const c = await this.get(id);
    if (!c) return "no such component";
    const next = await how(c);
    if (typeof next === "string") return next;
    await this.storage.put(C + id, { ...next, updatedAt: now });
    return this.view({ ...next, updatedAt: now });
  }

  /** A name as given: one line, short, and not Jarvis's own, since what it reports shows under it. Or why not. */
  private named(raw: unknown, others: readonly Component[]): { name: string } | string {
    const given = sanitise(raw);
    if (!given.ok) return `its name: ${given.why}`;
    const name = given.text.slice(0, MAX_NAME).trim();
    if (!nameOf(name)) return "its name needs a letter or a digit";
    if (nameOf(name) === "jarvis") return "a component cannot be called Jarvis";
    if (others.some((c) => nameOf(c.name) === nameOf(name))) return `another component is called ${name}`;
    return { name };
  }

  /**
   * Added by its address; or, given the label of one already here, that one
   * renamed and moved to the address given. A new address drops its key and
   * its reporting address, both of which whoever was at the old one holds,
   * and what is pinned is no longer offered until it is checked and approved
   * there. `taken`: the labels MCP servers in force have (lib/config-store.ts).
   */
  async add(input: { name: unknown; url: unknown; label?: unknown }, by: string, taken: readonly string[], now: number): Promise<ComponentView | string> {
    const all = await this.all();
    const url = typeof input.url === "string" ? pageUrl(input.url) : null;
    if (!url) return "its address must be https, and not one on the home network";
    const given = typeof input.label === "string" ? input.label.trim() : "";
    const same = given ? all.find((c) => c.label === given) : undefined;
    const named = this.named(input.name, all.filter((c) => c !== same));
    if (typeof named === "string") return named;
    const { name } = named;
    if (same) {
      const moved = same.url !== url.href;
      const { key: _k, inbox, ...kept } = same;
      if (moved) {
        await this.storage.delete(NEW + same.id);
        if (inbox) await this.storage.delete(IN + inbox.digest);
      }
      const next: Component = moved ? { ...kept, name, url: url.href, updatedAt: now } : { ...same, name, updatedAt: now };
      await this.storage.put(C + next.id, next);
      return this.view(next);
    }
    const label = given || nameOf(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 15).replace(/-+$/, "");
    if (!LABEL.test(label)) return "its label must be 2 to 15 lower-case letters, digits and -, starting with a letter: it goes before its tools' names";
    if (RESERVED.has(label) || label.startsWith("skill-") || taken.includes(label)) return `the label "${label}" is taken: give it another`;
    if (all.some((c) => c.label === label)) return `another component has the label "${label}": give it another`;
    if (all.length >= MAX_COMPONENTS) return `that is ${MAX_COMPONENTS} components already: remove one first`;
    const c: Component = { id: "cp" + random(8), label, name, url: url.href, shares: {}, enabled: true, createdBy: by, createdAt: now, updatedAt: now };
    await this.storage.put(C + c.id, c);
    return this.view(c);
  }

  /** Its key, from Settings → Components; why not, in words. */
  async setKey(id: string, key: unknown, now: number): Promise<ComponentView | string> {
    // What a header can carry: it is sent as a Bearer credential.
    if (typeof key !== "string" || !/^[\x21-\x7e]{8,512}$/.test(key)) return "a key is 8 to 512 letters, digits and symbols, without spaces";
    return this.change(id, now, (c) => ({ ...c, key }));
  }

  /** Where to list what it offers, with its key: for the Worker's check only (routes/components.ts). */
  async target(id: string): Promise<{ label: string; name: string; url: string; key?: string } | null> {
    const c = await this.get(id);
    return c ? { label: c.label, name: c.name, url: c.url, ...(c.key ? { key: c.key } : {}) } : null;
  }

  /**
   * What a check found at its address, kept to be approved unless it is
   * exactly what is pinned; the tools left out, and why. Nothing is offered
   * from it until then.
   */
  async listed(id: string, listed: Listed, now: number): Promise<{ component: ComponentView; skipped: { name: string; why: string }[] } | string> {
    const c = await this.get(id);
    if (!c) return "no such component";
    if (listed.url !== c.url) return "its address changed while it was being checked: check it again";
    const made = await catalogOf(listed, now);
    if (typeof made === "string") return made;
    if (c.pinned?.url === c.url && c.pinned.hash === made.catalog.hash) await this.storage.delete(NEW + id);
    else await this.storage.put(NEW + id, made.catalog);
    return { component: await this.view(c), skipped: made.skipped };
  }

  /**
   * What waits, approved: by its hash, so what is pinned is what the admin was
   * shown and nothing listed since. `classes`: any tool's class chosen
   * otherwise (reads, acts or off).
   */
  async approve(id: string, hash: unknown, classes: unknown, now: number): Promise<ComponentView | string> {
    const c = await this.get(id);
    if (!c) return "no such component";
    const waiting = await this.storage.get<Catalog>(NEW + id);
    if (!waiting || waiting.url !== c.url) return "nothing waits to be approved: check it first";
    if (waiting.hash !== hash) return "what it offers changed since you looked: look again";
    const chosen = classesOf(classes, waiting.tools);
    if (typeof chosen === "string") return chosen;
    const next: Component = { ...c, pinned: { ...waiting, at: now, tools: settle(waiting, c.pinned, chosen) }, updatedAt: now };
    await this.storage.put(C + id, next);
    await this.storage.delete(NEW + id);
    return this.view(next);
  }

  /** A pinned tool's class changed. One that no longer acts keeps no leave to run by itself. */
  setClasses(id: string, classes: unknown, now: number): Promise<ComponentView | string> {
    return this.change(id, now, (c) => {
      if (!c.pinned) return "it has nothing approved yet";
      const chosen = classesOf(classes, c.pinned.tools);
      if (typeof chosen === "string") return chosen;
      const tools = c.pinned.tools.map((t): PinnedTool => {
        const cls = chosen[t.name];
        if (!cls) return t;
        const { alone, off: _o, ...base } = t;
        return { ...base, reads: cls === "off" ? t.reads : cls === "reads", ...(cls === "off" ? { off: true as const } : {}), ...(cls === "acts" && alone ? { alone } : {}) };
      });
      return { ...c, pinned: { ...c.pinned, tools } };
    });
  }

  /**
   * Which acting tools run with nobody there, by name: the owner's choice
   * alone (routes/components.ts checks who asks). Only for a tool approved as
   * acting, at the address it was approved at.
   */
  setAlone(id: string, alone: unknown, now: number): Promise<ComponentView | string> {
    return this.change(id, now, (c) => {
      if (!plain(alone)) return "alone must name each tool as true or false";
      if (!c.pinned || c.pinned.url !== c.url) return "check and approve what it offers first";
      const tools = [...c.pinned.tools];
      for (const [name, on] of Object.entries(alone)) {
        const i = tools.findIndex((t) => t.name === name);
        const t = tools[i];
        if (!t) return `it has no tool called ${cut(name, 60)}`;
        if (typeof on !== "boolean") return `${name} must be true or false`;
        if (on && (t.off || t.reads)) return t.off ? `${name} is switched off` : `${name} only reads: it asks nobody already`;
        // Named like a look-up, it is never proposed (lib/proposals.ts classify), so there are no words to tell it in.
        if (on && readsByName(name)) return `${name} is named like a look-up, so Jarvis never runs it with nobody there: have the component rename it`;
        const { alone: _a, ...base } = t;
        tools[i] = on ? { ...base, alone: true } : base;
      }
      return { ...c, pinned: { ...c.pinned, tools } };
    });
  }

  /**
   * Who it is shared with: {person: {level, tell?, as?}}, or null to take a
   * share away. Only the people named change. `people`: who is in the family
   * now, as they are named everywhere ("owner" for the first person).
   */
  setShares(id: string, shares: unknown, people: readonly string[], now: number): Promise<ComponentView | string> {
    return this.change(id, now, (c) => {
      if (!plain(shares)) return "shares must name each person";
      const next = { ...c.shares };
      for (const [person, s] of Object.entries(shares)) {
        if (!people.includes(person)) return "one of those people is not in the family";
        if (s === null) {
          delete next[person];
          continue;
        }
        if (!plain(s) || (s.level !== "see" && s.level !== "use")) return 'a share is "see" or "use"';
        const as = typeof s.as === "string" ? s.as.trim() : "";
        if (as && !AS.test(as)) return "their id there is up to 64 letters, digits and . _ @ : -";
        next[person] = { level: s.level, ...(s.tell === true ? { tell: true as const } : {}), ...(as ? { as } : {}) };
      }
      return { ...c, shares: next };
    });
  }

  /** Switched off, it is offered to nobody and its reports are refused; on again, it is as it was. */
  async setEnabled(id: string, enabled: unknown, now: number): Promise<ComponentView | string> {
    if (typeof enabled !== "boolean") return "enabled must be true or false";
    return this.change(id, now, (c) => ({ ...c, enabled }));
  }

  async rename(id: string, name: unknown, now: number): Promise<ComponentView | string> {
    const named = this.named(name, (await this.all()).filter((c) => c.id !== id));
    if (typeof named === "string") return named;
    return this.change(id, now, (c) => ({ ...c, name: named.name }));
  }

  /** A new reporting address: the token, to be shown once, and the component. One it had before stops. */
  async newAddress(id: string, now: number): Promise<{ component: ComponentView; token: string } | string> {
    const c = await this.get(id);
    if (!c) return "no such component";
    if (c.inbox) await this.storage.delete(IN + c.inbox.digest);
    const token = mintToken(INBOX_PREFIX);
    const inbox = { digest: await sha256Hex(token), hint: hintOf(token), at: now };
    const next = { ...c, inbox, updatedAt: now };
    await this.storage.put(IN + inbox.digest, { id });
    await this.storage.put(C + id, next);
    return { component: await this.view(next), token };
  }

  /** Its reporting address stopped. */
  async dropAddress(id: string, now: number): Promise<ComponentView | string> {
    const had = (await this.get(id))?.inbox;
    if (had) await this.storage.delete(IN + had.digest);
    return this.change(id, now, ({ inbox: _gone, ...c }) => c);
  }

  /** Removed, with its key, what waited, its reporting address and its counts. */
  async remove(id: string): Promise<boolean> {
    const c = await this.get(id);
    if (!c) return false;
    if (c.inbox) await this.storage.delete(IN + c.inbox.digest);
    for (const k of [C, NEW, DAY]) await this.storage.delete(k + id);
    return true;
  }

  /** Someone left the family: nothing stays shared with them. */
  async forget(person: string): Promise<void> {
    for (const c of await this.all()) {
      if (!c.shares[person]) continue;
      const { [person]: _gone, ...shares } = c.shares;
      await this.storage.put(C + c.id, { ...c, shares });
    }
  }

  /**
   * What `person` is offered: of each component switched on and shared with
   * them, the approved tools that are not off (the reading ones only, for
   * "see"), while it is still at the address they were approved at.
   */
  async offeredTo(person: string): Promise<Offered[]> {
    return (await this.all()).flatMap((c): Offered[] => {
      const share = c.shares[person];
      if (!c.enabled || !share || !c.pinned || c.pinned.url !== c.url) return [];
      const tools = c.pinned.tools.filter((t) => !t.off && (share.level === "use" || t.reads));
      return [{ id: c.id, label: c.label, name: c.name, url: c.url, ...(c.key ? { key: c.key } : {}), level: share.level, ...(share.as ? { as: share.as } : {}), tools, events: c.pinned.events }];
    });
  }

  /** The component whose reporting address this is (by its token's digest), while it is switched on. */
  async byToken(digest: string): Promise<Component | null> {
    const ref = await this.storage.get<{ id: string }>(IN + digest);
    const c = ref ? await this.get(ref.id) : undefined;
    return c && c.enabled && c.inbox?.digest === digest ? c : null;
  }

  /** One by its id, as stored: for the object's own work on it (state.ts). */
  async stored(id: string): Promise<Component | null> {
    return (await this.get(id)) ?? null;
  }

  /**
   * Whether one of its tools may run now with nobody there (a routine, a job:
   * tools/components.ts): only an acting tool the owner lets run by itself,
   * as it is approved now, whose call can be told whole, and within the day's
   * limit, against which it is counted. Null to go ahead; else why not, for
   * the model whose step it was.
   */
  async acts(id: string, tool: string, args: Record<string, unknown>, day: string): Promise<string | null> {
    const c = await this.get(id);
    const t = c?.enabled && c.pinned?.url === c.url ? c.pinned.tools.find((x) => x.name === tool) : undefined;
    if (!c || !t || t.off || t.reads || !t.alone) return "Not done: that is not something Jarvis does with nobody there. Say in your answer what you would do.";
    if (!saysOf(c.label, tool, args)) return "Not done: that call is too long to tell the user whole, so it is not made with nobody there. Say in your answer what you would do.";
    if (!(await this.count(id, day, "acted", ALONE_PER_DAY))) return `Not done: ${c.name} has done ${ALONE_PER_DAY} things by itself today, which is its limit. Say in your answer that this was not done.`;
    return null;
  }

  private async today(id: string, day: string): Promise<Counted> {
    const had = await this.storage.get<Counted>(DAY + id);
    return had?.day === day ? had : { day, told: 0, acted: 0 };
  }

  /** One more thing told, or done by itself, today: false at the day's limit, and then not counted. */
  async count(id: string, day: string, what: "told" | "acted", limit: number): Promise<boolean> {
    const today = await this.today(id, day);
    if (today[what] >= limit) return false;
    await this.storage.put(DAY + id, { ...today, [what]: today[what] + 1 });
    return true;
  }

  /** How many more of them today's limit allows. */
  async left(id: string, day: string, what: "told" | "acted", limit: number): Promise<number> {
    return Math.max(0, limit - (await this.today(id, day))[what]);
  }

  /** Whether an event of this id was taken today already: one sent again is taken once. */
  async seen(id: string, day: string, event: string): Promise<boolean> {
    return (await this.today(id, day)).seen?.includes(event) === true;
  }

  /** An event's id, remembered for the day: the newest `max` of them. */
  async saw(id: string, day: string, event: string, max: number): Promise<void> {
    const today = await this.today(id, day);
    await this.storage.put(DAY + id, { ...today, seen: [...(today.seen ?? []), event].slice(-max) });
  }

  /** The component an event's name is for (`label:type`), if its label is one's: only that component sends it. */
  async ofEvent(event: string): Promise<Component | null> {
    const i = event.indexOf(":");
    return i > 0 ? ((await this.all()).find((c) => c.label === event.slice(0, i)) ?? null) : null;
  }

  /**
   * Why a routine cannot be made for this event by `person`, when it is a
   * component's: it must be shared with them, they must hold `components`
   * (`holds`), and it must be an event its approved manifest declares. Null
   * when it can, and for any event that is no component's.
   */
  async eventFor(event: string, person: string, holds: boolean): Promise<string | null> {
    const c = await this.ofEvent(event);
    if (!c) return null;
    if (!holds || !c.shares[person] || !c.enabled) return `"${event}" is an event of ${c.name}, which is not shared with whoever is asking: an admin shares it in Settings → Components`;
    const declared = c.pinned?.url === c.url ? c.pinned.events : [];
    if (declared.some((e) => `${c.label}:${e.type}` === event)) return null;
    return `${c.name} reports no event called "${event}"${declared.length ? `; it reports ${declared.map((e) => `${c.label}:${e.type}`).join(", ")}` : ""}`;
  }
}
