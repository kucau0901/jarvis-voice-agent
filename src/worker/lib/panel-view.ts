import type { Grant } from "./scopes.ts";
import { allows } from "./scopes.ts";
import { callService, entityState, type HaConfig } from "./ha.ts";
import { passService } from "./access.ts";
import { carSnapshot, distanceIn, ensureAwake, sendCarCommand, type CarSnapshot, type TessieConfig } from "../tools/tessie.ts";
import type { CarKey } from "./context.ts";
import type { Panel, PanelItem } from "./panels.ts";
import type { UsageReport } from "./usage.ts";
import type { PanelRow, PanelView } from "../../shared/panels.ts";

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
export interface PanelSources {
  grants: readonly Grant[];
  units: "metric" | "imperial";
  /** The house as this person reaches it; null when it is not connected. */
  house: HaConfig | null;
  read: (cfg: HaConfig, entity: string) => Promise<HouseState | null>;
  call: (cfg: HaConfig, domain: string, service: string, entity: string) => Promise<void>;
  /** A car by its id among this person's, or null when it is no longer one of them. */
  car: (id: string) => { cfg: TessieConfig; car: CarKey | null } | null;
  snapshot: (cfg: TessieConfig) => Promise<CarSnapshot>;
  wake: (cfg: TessieConfig, signal: AbortSignal, progress: (text: string) => void) => Promise<void>;
  command: (cfg: TessieConfig, name: string, extra: Record<string, string>, signal: AbortSignal) => Promise<boolean>;
  /** This person's usage this month and today. */
  usage: () => Promise<UsageReport | null>;
}

/** The real sources, but for what only a request knows. */
export const LIVE = {
  read: (cfg: HaConfig, entity: string) => entityState(cfg, entity),
  call: (cfg: HaConfig, domain: string, service: string, entity: string) => callService(cfg, domain, service, entity),
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
      return state === "on" ? ["off"] : state === "off" ? ["on"] : [];
    case "script":
      return state === "off" ? ["run"] : [];
    default:
      return [];
  }
}

/** A binary sensor's on and off, by what it senses. */
const SENSED: Record<string, [on: string, off: string]> = {
  door: ["Open", "Closed"], window: ["Open", "Closed"], garage_door: ["Open", "Closed"], opening: ["Open", "Closed"],
  motion: ["Motion", "Clear"], occupancy: ["Occupied", "Clear"], presence: ["Home", "Away"], moisture: ["Wet", "Dry"],
};

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
  const t = num(domain === "weather" ? a.temperature : domain === "climate" ? a.current_temperature : undefined);
  const tUnit = typeof a.temperature_unit === "string" ? ` ${a.temperature_unit}` : "°";
  return [cap(state.replace(/[_-]/g, " ")), t === undefined ? null : `${t}${tUnit}`].filter(Boolean).join(", ");
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

function carRow(item: PanelItem, s: CarSnapshot, mayWork: boolean, units: "metric" | "imperial"): PanelRow {
  const range = distanceIn(s.rangeMiles, units);
  const charging = s.charging === "Charging" ? "charging" : s.charging === "Complete" ? "charged" : null;
  return {
    key: item.ref,
    kind: "car",
    label: item.label,
    value: [s.locked === true ? "Locked" : s.locked === false ? "Unlocked" : null, s.climateOn ? "climate on" : null, charging]
      .filter(Boolean)
      .join(", "),
    tiles: [
      ...(s.battery === undefined ? [] : [{ label: "Battery", value: `${s.battery}%` }]),
      ...(range ? [{ label: "Range", value: `${range.n} ${range.unit}` }] : []),
      // Tesla reports Celsius, whatever the car shows.
      ...(s.insideTemp === undefined ? [] : [{ label: "Inside", value: units === "imperial" ? `${Math.round((s.insideTemp * 9) / 5 + 32)}°F` : `${Math.round(s.insideTemp)}°C` }]),
    ],
    actions: mayWork ? carActions(s).map((action) => ({ action, label: CAR_LABEL[action]! })) : [],
  };
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

const empty = (item: PanelItem, note: string): PanelRow => ({ key: item.ref, kind: item.kind, label: item.label, value: "", tiles: [], actions: [], note });

/** Every panel with each thing read now. A thing on two panels is read once. */
export async function viewPanels(panels: Panel[], src: PanelSources): Promise<PanelView[]> {
  const houseReads = new Map<string, Promise<HouseState | null>>();
  const carReads = new Map<string, Promise<CarSnapshot>>();
  let usage: Promise<UsageReport | null> | null = null;

  const row = async (item: PanelItem): Promise<PanelRow> => {
    if (item.kind === "note") return { key: item.ref, kind: "note", label: item.label, value: "", tiles: [], actions: [] };
    if (item.kind === "usage") {
      const r = await (usage ??= src.usage().catch(() => null));
      return r ? { key: item.ref, kind: "usage", label: item.label, value: "", tiles: usageTiles(r), actions: [] } : empty(item, "Could not read the usage just now.");
    }
    if (item.kind === "home") {
      if (!allows(src.grants, "home")) return empty(item, "Not shown: the house is not yours to reach here.");
      const house = src.house;
      if (!house) return empty(item, "The house is not connected to Jarvis.");
      let read = houseReads.get(item.ref);
      if (!read) houseReads.set(item.ref, (read = src.read(house, item.ref)));
      try {
        const now = await read;
        if (!now) return empty(item, "It is no longer in the house.");
        const actions = houseActions(item.ref, now.state).map((action) => ({ action, label: HOUSE_LABEL[action]! }));
        return { key: item.ref, kind: "home", label: item.label, value: houseValue(item.ref, now.state, now.attributes), tiles: [], actions };
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
      return carRow(item, await read, mayWork, src.units);
    } catch {
      return empty(item, "Could not reach the car's service just now.");
    }
  };

  return Promise.all(panels.map(async (p) => ({ id: p.id, title: p.title, rows: await Promise.all(p.items.map(row)) })));
}

/* ---------- working ------------------------------------------------------------------ */

/**
 * A button on a panel: the thing must be on this person's panel, its action
 * must be one its state offers now, and the person must still be allowed it.
 * Then the guest pass's fixed service, or the car command. No model.
 */
export async function actOn(
  panel: Panel | undefined,
  key: string,
  action: string,
  src: PanelSources,
  signal: AbortSignal,
): Promise<{ status: number; text: string }> {
  const item = panel?.items.find((i) => i.ref === key && (i.kind === "home" || i.kind === "car"));
  if (!item) return { status: 404, text: "That is not on this panel." };

  if (item.kind === "home") {
    if (!allows(src.grants, "home")) return { status: 403, text: 'Working the house needs "home".' };
    if (!src.house) return { status: 409, text: "The house is not connected to Jarvis." };
    let now: HouseState | null;
    try {
      now = await src.read(src.house, item.ref);
    } catch (e) {
      return { status: 502, text: `Could not reach the house: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!now) return { status: 404, text: `${item.label} is no longer in the house.` };
    if (!houseActions(item.ref, now.state).includes(action)) {
      return { status: 409, text: `${item.label} is ${houseValue(item.ref, now.state, now.attributes).toLowerCase() || now.state} now, so that was not sent.` };
    }
    const svc = passService(item.ref, action);
    if (typeof svc === "string") return { status: 409, text: `Not done: ${svc}.` };
    try {
      await src.call(src.house, svc.domain, svc.service, item.ref);
    } catch (e) {
      return { status: 502, text: `The house did not do it: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { status: 200, text: `${item.label}: ${HOUSE_LABEL[action]}.` };
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
