import type { Grant } from "./scopes.ts";
import { allows } from "./scopes.ts";
import { callService, entityState, type HaConfig } from "./ha.ts";
import { passService } from "./access.ts";
import { carSnapshot, distanceIn, ensureAwake, sendCarCommand, type CarSnapshot, type TessieConfig } from "../tools/tessie.ts";
import type { CarKey } from "./context.ts";
import { idsOf, noteKey, ticked, type Panel, type PanelItem } from "./panels.ts";
import { controlCall, controlsOf } from "./panel-controls.ts";
import { parseTile, pressTile, readTile, tileIcon, tileKey, type TileButton, type TileSources } from "./panel-tiles.ts";
import type { UsageReport } from "./usage.ts";
import type { PanelIcon, PanelRow, PanelView } from "../../shared/panels.ts";

/**
 * A person's panels, read now (GET /api/hub/panels), and their buttons
 * worked (POST /api/hub/panels/act), with no model call either way.
 *
 * Each thing is read when the panel is shown — Home Assistant as this person
 * (their own token when they gave one), the car from Tessie's last state,
 * which never wakes it — and its buttons follow what it is doing now: a
 * closed gate offers Open, a lit lamp Turn off. A press is checked against the
 * state again before anything is sent, so a button left on screen after the
 * gate moved does nothing it no longer means. What the house then does is
 * Home Assistant's to decide, as everywhere else: these are the guest pass's
 * fixed services (lib/access.ts passService), on things this person put on
 * their own panel, and only with `home` (or `car.control`).
 */

type HouseState = { state: string; attributes: Record<string, unknown> };

/** Where a panel's things are read and worked; the route gives the real ones, the tests fakes. */
export interface PanelSources extends TileSources {
  grants: readonly Grant[];
  units: "metric" | "imperial";
  /** The house as this person reaches it; null when it is not connected. */
  house: HaConfig | null;
  read: (cfg: HaConfig, entity: string) => Promise<HouseState | null>;
  call: (cfg: HaConfig, domain: string, service: string, entity: string, data?: Record<string, unknown>) => Promise<void>;
  /** A car by its id among this person's, or null when it is no longer one of them. */
  car: (id: string) => { cfg: TessieConfig; car: CarKey | null } | null;
  /** A car by the name a tile's button gives it (null: their usual one), or why there is none (tools/tessie.ts pickCar). */
  pick: (named: string | null) => { cfg: TessieConfig; car: CarKey | null } | string;
  snapshot: (cfg: TessieConfig) => Promise<CarSnapshot>;
  wake: (cfg: TessieConfig, signal: AbortSignal, progress: (text: string) => void) => Promise<void>;
  command: (cfg: TessieConfig, name: string, extra: Record<string, string>, signal: AbortSignal) => Promise<boolean>;
  /** This person's usage this month and today. */
  usage: () => Promise<UsageReport | null>;
}

/** The real sources, but for what only a request knows. */
export const LIVE = {
  read: (cfg: HaConfig, entity: string) => entityState(cfg, entity),
  call: (cfg: HaConfig, domain: string, service: string, entity: string, data?: Record<string, unknown>) => callService(cfg, domain, service, entity, data),
  snapshot: (cfg: TessieConfig) => carSnapshot(cfg),
  wake: ensureAwake,
  command: sendCarCommand,
};

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/* ---------- the house -------------------------------------------------------- */

const HOUSE_LABEL: Record<string, string> = {
  open: "Open", close: "Close", stop: "Stop", lock: "Lock", unlock: "Unlock",
  on: "Turn on", off: "Turn off", press: "Press", run: "Run",
};

/** What a thing in the house offers now, from its state now, named as passService takes them. */
export function houseActions(entity: string, state: string): string[] {
  const domain = entity.split(".")[0];
  if (state === "unavailable") return [];
  // A button's or a scene's state is only when it was last used, "unknown" until it has been.
  if (domain === "button" || domain === "input_button") return ["press"];
  if (domain === "scene") return ["run"];
  if (state === "unknown") return [];
  switch (domain) {
    case "cover":
      return state === "closed" ? ["open"] : state === "open" ? ["close"] : state === "opening" || state === "closing" ? ["stop"] : [];
    case "lock":
      return state === "locked" ? ["unlock"] : state === "unlocked" || state === "open" ? ["lock"] : [];
    case "light":
    case "switch":
    case "fan":
    case "input_boolean":
    case "group":
      return state === "on" ? ["off"] : state === "off" ? ["on"] : [];
    case "script":
      return state === "off" ? ["run"] : [];
    default:
      return [];
  }
}

/** A button's words: a group, or a room's lights together, is switched all at once. */
const actionLabel = (entity: string, action: string): string =>
  (entity.startsWith("group.") || entity.includes(",")) && (action === "on" || action === "off") ? (action === "on" ? "All on" : "All off") : HOUSE_LABEL[action]!;

/* ---------- a room's lights together ------------------------------------------- */

/** What may share a row: things that are only on or off. */
export const TOGETHER = new Set(["light", "switch", "fan", "input_boolean"]);

/**
 * A room's lights as one row when the house has no group for them, as Hark
 * shows "Master bedroom lights · 1 of 8 on": which are on, which off, and
 * which cannot be reached now (unavailable, or gone from the house).
 */
export function together(ids: string[], now: (HouseState | null)[]): { on: string[]; off: string[]; out: string[] } {
  const t = { on: [] as string[], off: [] as string[], out: [] as string[] };
  ids.forEach((id, i) => (now[i]?.state === "on" ? t.on : now[i]?.state === "off" ? t.off : t.out).push(id));
  return t;
}

/** All off while any is on, else All on while any can be; one button, as for a group. */
const togetherActions = (t: { on: string[]; off: string[] }): string[] => (t.on.length ? ["off"] : t.off.length ? ["on"] : []);

/** "1 of 8 on · Reading lamp unavailable". */
function togetherValue(ids: string[], now: (HouseState | null)[], t: { on: string[]; out: string[] }): string {
  const nameOf = (id: string) => {
    const n = now[ids.indexOf(id)]?.attributes.friendly_name;
    return typeof n === "string" ? n : id;
  };
  const out = t.out.length === 1 ? `${nameOf(t.out[0]!)} unavailable` : t.out.length ? `${t.out.length} unavailable` : null;
  return [`${t.on.length} of ${ids.length} on`, out].filter(Boolean).join(" · ");
}

/** A binary sensor's on and off, by what it senses. */
const SENSED: Record<string, [on: string, off: string]> = {
  door: ["Open", "Closed"], window: ["Open", "Closed"], garage_door: ["Open", "Closed"], opening: ["Open", "Closed"],
  motion: ["Motion", "Clear"], occupancy: ["Occupied", "Clear"], presence: ["Home", "Away"], moisture: ["Wet", "Dry"],
};

/**
 * What a thing in the house is drawn with: what Home Assistant says it is,
 * else its name, since a gate is often a cover or a button with no class
 * ("Main gate"), and a lamp a switch. Only the picture: what it offers is
 * houseActions's, from its domain and state.
 */
export function houseIcon(entity: string, state: string, a: Record<string, unknown>): PanelIcon {
  const dc = typeof a.device_class === "string" ? a.device_class : "";
  const name = `${entity} ${typeof a.friendly_name === "string" ? a.friendly_name : ""}`.toLowerCase();
  const named = (re: RegExp) => re.test(name);
  switch (entity.split(".")[0]) {
    case "cover":
      if (dc === "gate" || dc === "garage" || dc === "door" || dc === "window") return dc;
      return named(/gate/) ? "gate" : named(/garage/) ? "garage" : named(/door/) ? "door" : "blind";
    case "lock":
      return state === "unlocked" || state === "open" ? "unlock" : "lock";
    case "light":
      return "light";
    case "switch":
    case "input_boolean":
      return named(/light|lamp/) ? "light" : named(/fan/) ? "fan" : dc === "outlet" || named(/plug|socket/) ? "plug" : "power";
    case "group":
      return named(/light|lamp/) || (Array.isArray(a.entity_id) && a.entity_id.every((m) => String(m).startsWith("light."))) ? "light" : "power";
    case "fan":
      return "fan";
    case "climate":
      return "climate";
    case "scene":
      return "scene";
    case "script":
      return "play";
    case "button":
    case "input_button":
      return named(/gate/) ? "gate" : "press";
    case "media_player":
      return "music";
    case "weather":
      return "weather";
    case "alarm_control_panel":
      return state === "triggered" ? "alert" : "alarm";
    case "binary_sensor":
      return dc === "garage_door" ? "garage" : dc === "door" || dc === "opening" ? "door" : dc === "window" ? "window"
        : dc === "motion" || dc === "occupancy" || dc === "presence" ? "motion" : dc === "moisture" ? "drop" : "sensor";
    case "sensor":
    case "number":
    case "input_number":
      return dc === "temperature" ? "temp" : dc === "humidity" || dc === "moisture" ? "drop"
        : dc === "power" || dc === "energy" || dc === "current" || dc === "voltage" || dc === "battery" ? "bolt" : "sensor";
    default:
      return "dot";
  }
}

/** Whether it is doing its thing now — lit, open, unlocked, running, armed — for its tile to be drawn in colour. */
export function houseActive(entity: string, state: string): boolean {
  switch (entity.split(".")[0]) {
    case "cover":
      return state === "open" || state === "opening" || state === "closing";
    case "lock":
      return state === "unlocked" || state === "unlocking" || state === "open" || state === "opening";
    case "climate":
      return state !== "off" && state !== "unavailable" && state !== "unknown";
    case "media_player":
      return state === "playing";
    case "alarm_control_panel":
      return state.startsWith("armed") || state === "arming" || state === "pending" || state === "triggered";
    default:
      return state === "on";
  }
}

/** What a thing in the house is doing, in words: "Closed", "On", "31 °C", "Sunny, 31 °C". */
export function houseValue(entity: string, state: string, a: Record<string, unknown>): string {
  const domain = entity.split(".")[0];
  // A button's or a scene's state is when it was last pressed: nothing to say.
  if (state !== "unavailable" && (domain === "button" || domain === "input_button" || domain === "scene")) return "";
  if (state === "unavailable" || state === "unknown") return cap(state);
  const unit = typeof a.unit_of_measurement === "string" ? a.unit_of_measurement : "";
  if (domain === "sensor" || domain === "number" || domain === "input_number") return unit ? `${state} ${unit}` : cap(state);
  if (domain === "binary_sensor") {
    const said = SENSED[String(a.device_class ?? "")];
    return state === "on" ? (said?.[0] ?? "On") : state === "off" ? (said?.[1] ?? "Off") : cap(state);
  }
  if (domain === "group" && Array.isArray(a.entity_id)) {
    const members = a.entity_id.filter((m): m is string => typeof m === "string");
    const lights = members.every((m) => m.startsWith("light.") || m.startsWith("switch."));
    return `${cap(state)}, ${members.length} ${lights ? "lights" : "things"}`;
  }
  const t = num(domain === "weather" ? a.temperature : domain === "climate" ? a.current_temperature : undefined);
  const tUnit = typeof a.temperature_unit === "string" ? ` ${a.temperature_unit}` : "°";
  return [cap(state.replace(/[_-]/g, " ")), t === undefined ? null : `${t}${tUnit}`].filter(Boolean).join(", ");
}

/** One thing in the house as its tile shows it, with the buttons and the opened controls its state offers. */
function houseRow(key: string, label: string, entity: string, now: HouseState): PanelRow {
  const ctl = controlsOf(entity, now.state, now.attributes);
  return {
    key,
    kind: "home",
    label,
    value: houseValue(entity, now.state, now.attributes),
    icon: houseIcon(entity, now.state, now.attributes),
    active: houseActive(entity, now.state),
    tiles: [],
    actions: ctl?.actions ?? houseActions(entity, now.state).map((action) => ({ action, label: actionLabel(entity, action) })),
    ...(ctl?.more ? { more: ctl.more } : {}),
  };
}

/* ---------- the car -------------------------------------------------------------- */

const CAR_LABEL: Record<string, string> = {
  unlock: "Unlock", lock: "Lock", start_climate: "Climate on", stop_climate: "Climate off",
  start_charging: "Start charging", stop_charging: "Stop charging",
};

/** What a car offers now, from its last state, named as car_command takes them. */
export function carActions(s: CarSnapshot): string[] {
  const out: string[] = [];
  if (s.locked === true) out.push("unlock");
  else if (s.locked === false) out.push("lock");
  if (s.climateOn === true) out.push("stop_climate");
  else if (s.climateOn === false) out.push("start_climate");
  // Plugged in and stopped can start; charging can stop. Complete or unplugged offers neither.
  if (s.charging === "Charging") out.push("stop_charging");
  else if (s.charging === "Stopped") out.push("start_charging");
  return out;
}

/** Tesla's charging_state, as the car's tile says it. */
const CHARGING: Record<string, string> = { Charging: "Charging", Complete: "Charged", Stopped: "Not charging", Disconnected: "Unplugged" };

/**
 * A car as Hark shows one: a tile with its battery, range and charging, then
 * a tile for each thing it can be asked to do — its locks, its climate, and
 * its charging while plugged in — each with its state and the button that
 * state offers. Every one presses as the car (its key), so actOn checks them
 * all the same way.
 */
function carRows(item: PanelItem, s: CarSnapshot, mayWork: boolean, units: "metric" | "imperial"): PanelRow[] {
  const range = distanceIn(s.rangeMiles, units);
  const charging = s.charging === null ? null : (CHARGING[s.charging] ?? cap(s.charging.toLowerCase()));
  // Tesla reports Celsius, whatever the car shows.
  const inside = s.insideTemp === undefined ? null : units === "imperial" ? `${Math.round((s.insideTemp * 9) / 5 + 32)}°F` : `${Math.round(s.insideTemp)}°C`;
  const offers = mayWork ? carActions(s) : [];
  const control = (label: string, icon: PanelIcon, value: string, active: boolean, mine: string[]): PanelRow => ({
    key: item.ref,
    kind: "car",
    label,
    value,
    icon,
    active,
    tiles: [],
    actions: offers.filter((a) => mine.includes(a)).map((action) => ({ action, label: CAR_LABEL[action]! })),
  });
  return [
    {
      key: item.ref,
      kind: "car",
      label: item.label,
      value: [range ? `${range.n} ${range.unit} range` : null, charging].filter(Boolean).join(" · "),
      icon: "car",
      active: s.charging === "Charging",
      ...(s.battery === undefined ? {} : { level: s.battery }),
      tiles: [],
      actions: [],
    },
    ...(s.locked === null ? [] : [control("Locks", s.locked ? "lock" : "unlock", s.locked ? "Locked" : "Unlocked", !s.locked, ["lock", "unlock"])]),
    ...(s.climateOn === null
      ? []
      : [control("Climate", "climate", [s.climateOn ? "On" : "Off", inside && `${inside} inside`].filter(Boolean).join(" · "), s.climateOn, ["start_climate", "stop_climate"])]),
    ...(s.charging === "Charging" || s.charging === "Stopped" ? [control("Charging", "bolt", charging!, s.charging === "Charging", ["start_charging", "stop_charging"])] : []),
  ];
}

/**
 * A tile's button that sends one of the car's paired commands — lock or
 * unlock, climate on or off, charging on or off — and to which car (null:
 * their usual one). Only these follow the car's state; open_frunk or honk
 * always fit.
 */
function pairedCarCommand(b: TileButton): { command: string; car: string | null } | null {
  const args = b.tool?.tool === "car_command" ? b.tool.args : null;
  if (!args || typeof args.command !== "string" || !Object.hasOwn(CAR_LABEL, args.command)) return null;
  return { command: args.command, car: typeof args.car === "string" && args.car.trim() ? args.car : null };
}

/**
 * What a car's state offers now (carActions), from Tessie's last state as
 * for its own tiles, which never wakes it; null when that cannot be known
 * (not theirs to check, no such car, Tessie not answering), and the button
 * is then left as it is.
 */
async function carOffers(named: string | null, src: PanelSources, reads: Map<string, Promise<CarSnapshot>>): Promise<string[] | null> {
  if (!allows(src.grants, "car.read")) return null;
  const picked = src.pick(named);
  if (typeof picked === "string") return null;
  let read = reads.get(picked.cfg.vin);
  if (!read) reads.set(picked.cfg.vin, (read = src.snapshot(picked.cfg)));
  try {
    return carActions(await read);
  } catch {
    return null;
  }
}

/** Whether a tile's button fits the car's state now: Lock only when it is unlocked, as the car's own tiles. */
async function fitsTheCar(b: TileButton, src: PanelSources, reads: Map<string, Promise<CarSnapshot>>): Promise<boolean> {
  const c = pairedCarCommand(b);
  if (!c) return true;
  const offers = await carOffers(c.car, src, reads);
  return !offers || offers.includes(c.command);
}

/* ---------- reading ---------------------------------------------------------------- */

const money = (n: number) => `$${n.toFixed(2)}`;

function usageTiles(r: UsageReport): { label: string; value: string }[] {
  const spent = r.total.cost.router + r.total.cost.live + r.total.cost.jobs;
  return [
    { label: "Today", value: `${r.today.questions} asked` },
    { label: "This month", value: `${r.total.questions} asked` },
    { label: "Spent this month", value: money(spent) },
    { label: "Live this month", value: `${Math.round(r.total.liveSeconds / 60)} min` },
  ];
}

const ICON: Record<"car" | "usage" | "note" | "tile", PanelIcon> = { car: "car", usage: "usage", note: "note", tile: "dot" };

/** A thing's key on its panel, for a press: its ref, or a tile's or a note's short key. */
export const keyOf = (i: PanelItem): string => (i.kind === "tile" ? tileKey(i.ref) : i.kind === "note" ? noteKey(i.label) : i.ref);
const iconOf = (item: PanelItem): PanelIcon => (item.kind === "home" ? houseIcon(item.ref, "", { friendly_name: item.label }) : ICON[item.kind]);
const empty = (item: PanelItem, note: string): PanelRow[] => [
  { key: keyOf(item), kind: item.kind, label: item.label, value: "", icon: iconOf(item), active: false, tiles: [], actions: [], note },
];

/** Every panel with each thing read now. A thing on two panels is read once. */
export async function viewPanels(panels: Panel[], src: PanelSources): Promise<PanelView[]> {
  const houseReads = new Map<string, Promise<HouseState | null>>();
  const carReads = new Map<string, Promise<CarSnapshot>>();
  let usage: Promise<UsageReport | null> | null = null;

  // One row a thing, but a car is its tile and one for each of its controls.
  const rows = async (item: PanelItem): Promise<PanelRow[]> => {
    if (item.kind === "note") {
      return [{ key: keyOf(item), kind: "note", label: item.label, value: "", icon: "note", active: false, tiles: [], actions: [], ...(ticked(item) ? { done: true } : {}) }];
    }
    if (item.kind === "tile") {
      // Its reading is fetched on its own (readTileOf), so a slow tool never holds up the house.
      const spec = parseTile(item.ref);
      if (!spec) return empty(item, "This tile no longer reads back: ask Jarvis to make it again.");
      // A car button shows only when the car's state offers it; each keeps its own number, for the press.
      const fits = await Promise.all(spec.buttons.map((b) => fitsTheCar(b, src, carReads)));
      return [{
        key: keyOf(item), kind: "tile", label: item.label, value: "", icon: tileIcon(spec), active: false, tiles: [],
        actions: spec.buttons.flatMap((b, i) => {
          if (!fits[i]) return [];
          const input = b.input ? (({ arg: _, ...shown }) => shown)(b.input) : undefined;
          return [{ action: `b${i}`, label: b.label, ...(input ? { input } : {}) }];
        }),
        ...(spec.read ? { read: true } : {}),
      }];
    }
    if (item.kind === "usage") {
      const r = await (usage ??= src.usage().catch(() => null));
      return r
        ? [{ key: item.ref, kind: "usage", label: item.label, value: "", icon: "usage", active: false, tiles: usageTiles(r), actions: [] }]
        : empty(item, "Could not read the usage just now.");
    }
    if (item.kind === "home") {
      if (!allows(src.grants, "home")) return empty(item, "Not shown: the house is not yours to reach here.");
      const house = src.house;
      if (!house) return empty(item, "The house is not connected to Jarvis.");
      const readOf = (id: string) => {
        let r = houseReads.get(id);
        if (!r) houseReads.set(id, (r = src.read(house, id)));
        return r;
      };
      const ids = idsOf(item);
      if (ids.length > 1) {
        try {
          const now = await Promise.all(ids.map(readOf));
          const t = together(ids, now);
          return [
            {
              key: item.ref,
              kind: "home",
              label: item.label,
              value: togetherValue(ids, now, t),
              // A room's row always has a light in it (lib/panel-arrange.ts); its switches are mostly lights too.
              icon: ids.some((id, i) => houseIcon(id, "", now[i]?.attributes ?? {}) === "light") ? "light" : "power",
              active: t.on.length > 0,
              tiles: [],
              actions: togetherActions(t).map((action) => ({ action, label: actionLabel(item.ref, action) })),
              // Opened, each light of the room with its own button, as the house names it.
              more: {
                members: ids.map((id, i) => {
                  const s = now[i];
                  const name = typeof s?.attributes.friendly_name === "string" ? s.attributes.friendly_name : id;
                  return s ? houseRow(id, name, id, s) : { key: id, kind: "home", label: id, value: "", icon: houseIcon(id, "", {}), active: false, tiles: [], actions: [], note: "It is no longer in the house." };
                }),
              },
            },
          ];
        } catch {
          return empty(item, "Could not reach the house just now.");
        }
      }
      const read = readOf(item.ref);
      try {
        const now = await read;
        if (!now) return empty(item, "It is no longer in the house.");
        return [houseRow(item.ref, item.label, item.ref, now)];
      } catch {
        return empty(item, "Could not reach the house just now.");
      }
    }
    if (!allows(src.grants, "car.read")) return empty(item, "Not shown: cars are not yours to check here.");
    const picked = src.car(item.ref);
    if (!picked) return empty(item, "It is no longer one of your cars.");
    let read = carReads.get(picked.cfg.vin);
    if (!read) carReads.set(picked.cfg.vin, (read = src.snapshot(picked.cfg)));
    try {
      const mayWork = allows(src.grants, "car.control") && picked.car?.level !== "see";
      return carRows(item, await read, mayWork, src.units);
    } catch {
      return empty(item, "Could not reach the car's service just now.");
    }
  };

  return Promise.all(panels.map(async (p) => ({ id: p.id, title: p.title, rows: (await Promise.all(p.items.map(rows))).flat() })));
}

/* ---------- working ------------------------------------------------------------------ */

/**
 * All off (or on) for a room's lights together: read now, and only those
 * not already so are sent, in one call to Home Assistant's own
 * homeassistant.turn_off (or _on), as a group is switched — each a light or
 * a switch the pass's table may turn on and off.
 */
async function switchTogether(item: PanelItem, ids: string[], action: string, src: PanelSources, house: HaConfig): Promise<{ status: number; text: string }> {
  let now: (HouseState | null)[];
  try {
    now = await Promise.all(ids.map((id) => src.read(house, id)));
  } catch (e) {
    return { status: 502, text: `Could not reach the house: ${e instanceof Error ? e.message : String(e)}` };
  }
  const t = together(ids, now);
  if (!togetherActions(t).includes(action)) {
    return { status: 409, text: `${item.label}: ${togetherValue(ids, now, t)} now, so that was not sent.` };
  }
  const which = action === "off" ? t.on : t.off;
  for (const id of which) {
    const svc = passService(id, action);
    if (typeof svc === "string") return { status: 409, text: `Not done: ${svc}.` };
  }
  try {
    await src.call(house, "homeassistant", action === "off" ? "turn_off" : "turn_on", which.join(","));
  } catch (e) {
    return { status: 502, text: `The house did not do it: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { status: 200, text: `${item.label}: ${actionLabel(item.ref, action)}.` };
}

/**
 * One thing in the house pressed: read again, then an aircond's or an
 * alarm's service (lib/panel-controls.ts) or the guest pass's fixed one, if
 * its state offers that now.
 */
async function pressThing(label: string, entity: string, action: string, code: string | undefined, src: PanelSources, house: HaConfig): Promise<{ status: number; text: string }> {
  let now: HouseState | null;
  try {
    now = await src.read(house, entity);
  } catch (e) {
    return { status: 502, text: `Could not reach the house: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!now) return { status: 404, text: `${label} is no longer in the house.` };
  const ctl = controlCall(entity, now.state, now.attributes, action, code);
  if (typeof ctl === "string") return { status: 409, text: `${label}: ${ctl}.` };
  let call: { domain: string; service: string; data: Record<string, unknown>; said: string };
  if (ctl) call = ctl;
  else {
    if (!houseActions(entity, now.state).includes(action)) {
      return { status: 409, text: `${label} is ${houseValue(entity, now.state, now.attributes).toLowerCase() || now.state} now, so that was not sent.` };
    }
    const svc = passService(entity, action);
    if (typeof svc === "string") return { status: 409, text: `Not done: ${svc}.` };
    call = { ...svc, data: {}, said: actionLabel(entity, action) };
  }
  try {
    await src.call(house, call.domain, call.service, entity, call.data);
  } catch (e) {
    return { status: 502, text: `The house did not do it: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { status: 200, text: `${label}: ${call.said}.` };
}

/**
 * A button on a panel: the thing must be on this person's panel (or, with
 * `member`, in one of its rooms), its action must be one its state offers
 * now, and the person must still be allowed it. Then the service, or the
 * car command. No model. An alarm's code is passed to Home Assistant and
 * kept nowhere.
 */
export async function actOn(
  panel: Panel | undefined,
  key: string,
  action: string,
  src: PanelSources,
  signal: AbortSignal,
  extra: { member?: string; code?: string; value?: string } = {},
): Promise<{ status: number; text: string }> {
  const item = panel?.items.find((i) => keyOf(i) === key && (i.kind === "home" || i.kind === "car" || i.kind === "tile"));
  if (!item) return { status: 404, text: "That is not on this panel." };

  if (item.kind === "tile") {
    const spec = parseTile(item.ref);
    if (!spec) return { status: 409, text: "This tile no longer reads back: ask Jarvis to make it again." };
    // A car button pressed after the car changed (Lock, and it was locked meanwhile) sends nothing, as on the car's own tiles.
    const b = spec.buttons[Number(/^b(\d)$/.exec(action)?.[1] ?? -1)];
    if (b && !(await fitsTheCar(b, src, new Map()))) return { status: 409, text: `${item.label}: the car has changed since this was shown, so that was not sent.` };
    return pressTile(item.label, spec, action, src, extra.value);
  }

  if (item.kind === "home") {
    if (!allows(src.grants, "home")) return { status: 403, text: 'Working the house needs "home".' };
    if (!src.house) return { status: 409, text: "The house is not connected to Jarvis." };
    const ids = idsOf(item);
    if (extra.member !== undefined) {
      if (ids.length < 2 || !ids.includes(extra.member)) return { status: 404, text: `That is not in ${item.label}.` };
      return pressThing(extra.member, extra.member, action, undefined, src, src.house).then((r) => ({ ...r, text: r.text.replace(extra.member!, "That") }));
    }
    if (ids.length > 1) return switchTogether(item, ids, action, src, src.house);
    return pressThing(item.label, item.ref, action, extra.code, src, src.house);
  }

  if (!allows(src.grants, "car.control")) return { status: 403, text: 'Working the car needs "car.control".' };
  const picked = src.car(item.ref);
  if (!picked) return { status: 404, text: `${item.label} is no longer one of your cars.` };
  // Shared to see is not shared to drive: the owner chose (hub.ts cars).
  if (picked.car?.level === "see") return { status: 403, text: `${item.label} is shared with you to see, not to operate.` };
  try {
    if (!carActions(await src.snapshot(picked.cfg)).includes(action)) {
      return { status: 409, text: `${item.label} has changed since this was shown, so that was not sent.` };
    }
    await src.wake(picked.cfg, signal, () => {});
    if (!(await src.command(picked.cfg, action, {}, signal))) return { status: 502, text: `${item.label} did not accept that.` };
  } catch (e) {
    return { status: 502, text: `Could not reach the car: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { status: 200, text: `${item.label}: ${CAR_LABEL[action]}.` };
}

/** A tile's reading (GET /api/hub/panels/read): the thing must be a tile on this person's panel. `cached` answers with what was kept. */
export async function readTileOf(panel: Panel | undefined, key: string, src: PanelSources, cached = false) {
  const item = panel?.items.find((i) => i.kind === "tile" && keyOf(i) === key);
  const spec = item ? parseTile(item.ref) : null;
  if (!spec) return { status: 404, text: "That is not a tile on this panel." };
  return readTile(spec, src, key, cached);
}
