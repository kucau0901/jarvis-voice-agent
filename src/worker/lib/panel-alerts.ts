import type { PanelMore } from "../../shared/panels.ts";
import type { HaConfig } from "./ha.ts";
import { idsOf, type Panel, type Reading } from "./panels.ts";
import { isAsk, parseTile, tileKey } from "./panel-tiles.ts";
import type { Routine, RoutineInput } from "./routines.ts";

/**
 * "Alert me" on a panel's tile (routes/panels.ts): for a thing in the house,
 * a watch (lib/routines.ts) — Home Assistant checked every minute, at no cost
 * — with its condition written here from what the thing is, so nobody has to
 * know a template: "when the gate opens", "when Outside is above 35 °C".
 * A tile Jarvis looks up on the web is watched as a page instead.
 */

type Attrs = Record<string, unknown>;
/** What a thing in the house can alert on; words typed are for a reading Jarvis looks up instead. */
export type AlertChoice = Exclude<NonNullable<PanelMore["alert"]>, { kind: "words" }>;

/** The states that count as on, open or unlocked, by domain; anything else counts as off. */
const ACTIVE: Record<string, { on: string[]; words: [on: string, off: string] }> = {
  cover: { on: ["open", "opening"], words: ["opens", "closes"] },
  lock: { on: ["unlocked", "unlocking", "open"], words: ["is unlocked", "is locked"] },
  light: { on: ["on"], words: ["turns on", "turns off"] },
  switch: { on: ["on"], words: ["turns on", "turns off"] },
  fan: { on: ["on"], words: ["turns on", "turns off"] },
  input_boolean: { on: ["on"], words: ["turns on", "turns off"] },
  binary_sensor: { on: ["on"], words: ["turns on", "turns off"] },
  climate: { on: ["cool", "heat", "heat_cool", "auto", "dry", "fan_only"], words: ["turns on", "turns off"] },
  media_player: { on: ["playing"], words: ["starts playing", "stops"] },
  alarm_control_panel: { on: ["triggered"], words: ["goes off", "is quiet again"] },
};

/** A binary sensor's own words: a door opens, motion is seen. */
const SENSED: Record<string, [on: string, off: string]> = {
  door: ["opens", "closes"], window: ["opens", "closes"], garage_door: ["opens", "closes"], opening: ["opens", "closes"],
  motion: ["sees motion", "is clear"], occupancy: ["sees someone", "is clear"], presence: ["says someone is home", "says nobody is home"],
  moisture: ["gets wet", "is dry"], smoke: ["detects smoke", "is clear"], gas: ["detects gas", "is clear"],
};

const isNumber = (state: string) => state.trim() !== "" && Number.isFinite(Number(state));

/** What "Alert me" offers for a thing: its two states in words, or a number to go above or below; null for nothing. */
export function alertChoice(entity: string, state: string, a: Attrs): AlertChoice | null {
  const domain = entity.split(".")[0]!;
  if (state === "unavailable" || state === "unknown") return null;
  if ((domain === "sensor" || domain === "number" || domain === "input_number") && isNumber(state)) {
    return { kind: "number", unit: typeof a.unit_of_measurement === "string" ? a.unit_of_measurement : "", value: Number(state) };
  }
  const active = ACTIVE[domain];
  if (!active) return null;
  const [on, off] = (domain === "binary_sensor" && SENSED[String(a.device_class ?? "")]) || active.words;
  return { kind: "state", on, off };
}

/** Quoted for a Home Assistant template: entity ids are checked, but quotes are never trusted. */
const q = (s: string) => `'${s.replace(/[^a-z0-9_.]/gi, "")}'`;

/**
 * The watch for "Alert me": its condition, what it says and its name. `when`
 * is on or off (for a thing with two states) or above or below `value` (for
 * a number). A string says why not.
 */
export function watchFor(
  entity: string,
  label: string,
  state: string,
  a: Attrs,
  when: string,
  value?: number,
): { condition: string; say: string; name: string } | string {
  const choice = alertChoice(entity, state, a);
  if (!choice) return `${label} has nothing to alert on just now.`;
  if (choice.kind === "number") {
    if (when !== "above" && when !== "below") return "say above or below.";
    if (value === undefined || !Number.isFinite(value)) return "say the number.";
    const unit = choice.unit ? ` ${choice.unit}` : "";
    // A reading the house cannot give is neither above nor below: no alert for an unplugged sensor.
    const condition = `{% set v = states(${q(entity)}) | float(none) %}{{ v is not none and v ${when === "above" ? ">" : "<"} ${value} }}`;
    return { condition, say: `${label} is ${when} ${value}${unit}.`, name: `${label} ${when} ${value}${unit}` };
  }
  if (when !== "on" && when !== "off") return "say on or off.";
  const on = ACTIVE[entity.split(".")[0]!]!.on;
  const list = (xs: string[]) => `[${xs.map((s) => `'${s}'`).join(", ")}]`;
  // Off is neither on nor out of reach: a gate whose sensor dropped did not just close.
  const condition = when === "on" ? `{{ states(${q(entity)}) in ${list(on)} }}` : `{{ states(${q(entity)}) not in ${list([...on, "unavailable", "unknown"])} }}`;
  const words = when === "on" ? choice.on : choice.off;
  return { condition, say: `${label} ${words}.`, name: `${label} ${words}` };
}

/* ---------- setting one, from a tile (POST /api/hub/panels/alert) ------------------- */

export interface AlertDeps {
  /** Whether the person may reach the house (`home`). */
  home: boolean;
  house: HaConfig | null;
  read: (cfg: HaConfig, entity: string) => Promise<{ state: string; attributes: Attrs } | null>;
  /** A sentence asked of Jarvis, with its web search: to find a page, once. */
  ask: (text: string) => Promise<string>;
  /** A tile's kept reading, whose source page may already be known. */
  kept: (tile: string) => Promise<Reading | null>;
  /** The routine made, as its maker could (lib/scheduler.ts tries a page once first); a string says why not. */
  addRoutine: (input: RoutineInput) => Promise<Routine | string>;
}

/** Asked once, when the alert is set: the one web search a page watch ever costs. */
const FIND = (question: string) =>
  `Find one public web page, or a JSON API, whose own text plainly shows ${question}. Prefer the official source, and a ` +
  "page that has the figures in the page itself rather than drawn by scripts. Reply with only its https address, nothing else.";

/** The first https address in a reply, without the full stop of the sentence it ends. */
const urlIn = (text: string): string | null => /https:\/\/[^\s)>\]"'`]+/.exec(text)?.[0].replace(/[.,;:!?]+$/, "") ?? null;

/**
 * "Alert me" on a tile, made into a routine of its maker's. A thing in the
 * house becomes a watch (free, every minute); a reading Jarvis looks up
 * becomes a page watch on the page it came from, found once with a search
 * when it is not known, or when the one known cannot be read without scripts.
 */
export async function setAlert(
  panel: Panel | undefined,
  key: string,
  body: { when?: unknown; value?: unknown; condition?: unknown },
  d: AlertDeps,
): Promise<{ status: number; text: string }> {
  const item = panel?.items.find((i) => (i.kind === "home" && i.ref === key && idsOf(i).length === 1) || (i.kind === "tile" && tileKey(i.ref) === key));
  if (!item) return { status: 404, text: "That is not on this panel." };

  if (item.kind === "home") {
    if (!d.home) return { status: 403, text: 'The house needs "home".' };
    if (!d.house) return { status: 409, text: "The house is not connected to Jarvis." };
    const now = await d.read(d.house, item.ref).catch(() => null);
    if (!now) return { status: 502, text: `Could not read ${item.label} just now.` };
    const w = watchFor(item.ref, item.label, now.state, now.attributes, String(body.when ?? ""), body.value === undefined ? undefined : Number(body.value));
    if (typeof w === "string") return { status: 400, text: w };
    const made = await d.addRoutine({ name: w.name, when: "watch", condition: w.condition, forMinutes: 0, say: w.say });
    if (typeof made === "string") return { status: 409, text: `No alert: ${made}.` };
    return { status: 200, text: `You will be told when ${w.say.replace(/\.$/, "")}. It is in Routines, to change or remove.` };
  }

  const spec = parseTile(item.ref);
  if (!spec?.read || !isAsk(spec.read)) return { status: 409, text: "Only a reading Jarvis looks up can alert from here." };
  const condition = typeof body.condition === "string" ? body.condition.trim().slice(0, 200) : "";
  if (condition.length < 3) return { status: 400, text: "Say when to alert you, e.g. the API is above 150." };
  const read = spec.read;
  const known = (await d.kept(key).catch(() => null))?.source;
  const tried = new Set<string>();
  // The known source first; then, once, one found for the purpose.
  for (const step of [known, "find"] as const) {
    const url = step === "find" ? urlIn(await d.ask(FIND(read.ask)).catch(() => "")) : step;
    if (!url || tried.has(url)) continue;
    tried.add(url);
    const made = await d.addRoutine({
      name: `${item.label}: ${condition}`,
      when: "page",
      url,
      question: read.ask,
      condition,
      everyMinutes: read.every,
      say: `${item.label}: ${condition}.`,
    });
    if (typeof made !== "string") {
      const every = read.every === 60 ? "hour" : read.every % 60 ? `${read.every} minutes` : `${read.every / 60} hours`;
      return { status: 200, text: `You will be told when ${condition}: ${new URL(url).hostname} is read every ${every}, about a tenth of a cent a look. It is in Routines.` };
    }
    if (!made.startsWith("that page cannot be watched")) return { status: 409, text: `No alert: ${made}.` };
  }
  return { status: 409, text: "No page could be found that shows it plainly enough to watch cheaply; ask Jarvis in Chat instead." };
}
