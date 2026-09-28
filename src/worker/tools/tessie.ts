import type { Env } from "../types";
import { localeOf } from "../lib/locale.ts";
import type { Tool, ToolContext } from "./registry";
import { carsOf, type CarKey } from "../lib/context.ts";

/**
 * The Tesla, through Tessie.
 *
 * Home Assistant already carries the car's basic state, but only a subset — it
 * cannot push a destination to the car's navigation, which is the thing actually
 * wanted in a car. Going direct also drops the ~8s MCP hop to roughly one second.
 *
 * Every slug below was read from developer.tessie.com/reference/<page>.md rather
 * than derived from a doc page title: `flash-lights` is really `flash`,
 * `front-trunk` is `activate_front_trunk`, `set-temperature` is
 * `set_temperatures`. Three of fifteen differ. Do not guess a new one.
 */

const API = "https://api.tessie.com";
const TIMEOUT_MS = 12_000;

export interface TessieConfig {
  token: string;
  vin: string;
}

export function tessieConfig(env: Env): TessieConfig | null {
  if (!env.TESSIE_TOKEN || !env.TESSIE_VIN) return null;
  return { token: env.TESSIE_TOKEN.trim(), vin: env.TESSIE_VIN.trim() };
}

/**
 * Which car a question is about (lib/context.ts): the one named, among those
 * this person may reach, or their usual one. A string says why there is none.
 */
export function pickCar(env: Env, named?: unknown): { cfg: TessieConfig; car: CarKey | null } | string {
  const cars = carsOf(env);
  const want = typeof named === "string" ? named.trim().toLowerCase() : "";
  if (!cars.length) {
    // No family: the car in the settings, as it always was.
    const cfg = tessieConfig(env);
    return cfg ? { cfg, car: null } : "No car is connected for this person.";
  }
  const car = !want
    ? cars[0]!
    : (cars.find((c) => c.name.toLowerCase() === want) ??
      cars.find((c) => c.name.toLowerCase().includes(want) || want.includes(c.name.toLowerCase())));
  if (!car) return `There is no car called "${String(named)}" that this person can reach. Theirs: ${cars.map((c) => c.name).join(", ")}.`;
  return { cfg: { token: car.token, vin: car.vin }, car };
}

/**
 * The cars a Tessie token can reach, for adding one (routes/hub.ts): each
 * VIN and the name the owner gave it. Throws with Tessie's answer if the
 * token is refused.
 */
export async function tessieVehicles(token: string, signal?: AbortSignal): Promise<{ vin: string; name: string }[]> {
  const body = (await call({ token, vin: "" }, "/vehicles?only_active=true", { signal })) as {
    results?: { vin?: unknown; last_state?: { display_name?: unknown; vehicle_state?: { vehicle_name?: unknown } } }[];
  };
  return (body.results ?? [])
    .filter((v) => typeof v.vin === "string")
    .map((v) => ({
      vin: v.vin as string,
      name: String(v.last_state?.display_name ?? v.last_state?.vehicle_state?.vehicle_name ?? "").trim(),
    }));
}

/** The `car` parameter both tools take. */
const CAR_PARAM = {
  type: ["string", "null"],
  description:
    "Which car, by its name, when the user has more than one they can reach (see CARS in the context) " +
    "or names someone else's: \"Mum's car\". Null for their usual car.",
};

async function call(
  cfg: TessieConfig,
  path: string,
  opts: { method?: string; signal?: AbortSignal } = {},
): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? "GET",
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: opts.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Rate limits are undocumented, so anything non-2xx is reported as-is
    // rather than being mapped to a confident explanation.
    throw new Error(`Tessie returned ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
  }
  return res.json();
}

/**
 * Commands may or may not wake a sleeping car — third-party wrappers claim they
 * do, Tessie's own reference does not say. So check, and wake explicitly if
 * needed. That also gives the driver "waking your car" instead of 90 seconds of
 * apparently nothing.
 */
async function ensureAwake(cfg: TessieConfig, ctx: ToolContext): Promise<void> {
  const status = (await call(cfg, `/${cfg.vin}/status`, { signal: ctx.signal })) as {
    status?: string;
  };
  if (status.status === "awake") return;
  ctx.progress("waking the car");
  const woke = (await call(cfg, `/${cfg.vin}/wake`, {
    method: "POST",
    // Tessie returns false after its own 90s timeout, so allow for that.
    signal: AbortSignal.timeout(100_000),
  })) as { result?: boolean };
  if (woke.result === false) throw new Error("the car did not wake within 90 seconds");
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** A clause only when its reading is there: a missing one is left out, never said as "undefined". */
const said = (v: unknown, say: (n: number) => string): string | null => {
  const n = num(v);
  return n === undefined ? null : say(n);
};
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- units --------------------------------------------------------- */

/*
 * Tesla's API reports distance in MILES and speed in MPH, whatever the car's
 * own display is set to, and Tessie passes both through unchanged: neither
 * /{vin}/battery nor /{vin}/state takes a units parameter (only the
 * historical /{vin}/states does). This file used to label the raw figure
 * "km", so a car at 69% with 283 km in hand was reported as having 176 —
 * wrong by the whole mile-to-kilometre ratio, on every answer about range.
 *
 * Always kilometres out: the user is in Malaysia, and everything else Jarvis
 * says — directions, distances, the prompt's own examples — is metric.
 */
export const KM_PER_MILE = 1.609344;

/** Miles to whole kilometres, or undefined when there is no reading to convert. */
export function milesToKm(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n * KM_PER_MILE);
}

/**
 * Every imperial field in the state document, and the name it takes once
 * converted. Renamed rather than converted in place, so a figure in the
 * `everything` dump carries its unit in its name and cannot be read in the
 * wrong one. Fields already named for their unit (`current_limit_mph`) say so
 * themselves and are left alone.
 */
const IMPERIAL: Record<string, string> = {
  battery_range: "battery_range_km",
  est_battery_range: "est_battery_range_km",
  ideal_battery_range: "ideal_battery_range_km",
  odometer: "odometer_km",
  active_route_miles_to_arrival: "active_route_km_to_arrival",
  charge_miles_added_ideal: "charge_km_added_ideal",
  charge_miles_added_rated: "charge_km_added_rated",
  // Range added per hour of charging, not power: that is charger_power, in kW.
  charge_rate: "charge_rate_km_per_hour",
  speed: "speed_kmh",
};

/** A deep copy of a Tessie state with every imperial figure converted and renamed. */
export function metricState(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(metricState);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const renamed = IMPERIAL[k];
    if (renamed && typeof val === "number") {
      out[renamed] = Math.round(val * KM_PER_MILE * 10) / 10;
    } else {
      out[k] = metricState(val);
    }
  }
  return out;
}

/**
 * A distance in the user's units (settings panel, lib/locale.ts): kilometres
 * converted, or miles as Tesla reports them. Undefined for a missing reading.
 */
export function distanceIn(
  miles: unknown,
  units: "metric" | "imperial",
): { n: number; unit: string } | undefined {
  if (units === "imperial") {
    const n = num(miles);
    return n === undefined ? undefined : { n: Math.round(n), unit: "miles" };
  }
  const km = milesToKm(miles);
  return km === undefined ? undefined : { n: km, unit: "km" };
}

/** Under imperial, the dump keeps Tesla's miles but says so in every key name. */
const IMPERIAL_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(IMPERIAL).map(([k, metric]) => [
    k,
    k === "speed" ? "speed_mph" : k === "charge_rate" ? "charge_rate_mi_per_hour" : metric.replace(/km/g, "mi"),
  ]),
);

export function imperialState(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(imperialState);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const renamed = IMPERIAL_LABELS[k];
    out[renamed && typeof val === "number" ? renamed : k] = renamed && typeof val === "number" ? val : imperialState(val);
  }
  return out;
}

/** "range 283 km", or nothing at all — never "0 km" for a reading that is missing. */
function rangeClause(
  miles: unknown,
  units: "metric" | "imperial",
  phrase: (d: { n: number; unit: string }) => string,
): string | null {
  const d = distanceIn(miles, units);
  return d === undefined ? null : phrase(d);
}

/* ---------- reading ------------------------------------------------------- */

export const carState: Tool = {
  name: "car_state",
  scope: "car.read",
  pace: "fast",
  available: (env) => !!tessieConfig(env),
  description:
    "Read the user's Tesla: battery, range, charging, climate, where it is, whether it " +
    "is locked, odometer. Fast, and does not wake the car. Prefer this over Home " +
    "Assistant for anything about the car.",
  parameters: {
    type: "object",
    properties: {
      what: {
        type: "string",
        enum: ["summary", "battery", "location", "climate", "charge", "odometer", "everything"],
        description:
          "summary covers battery, range, charging, whether it is locked and what gear " +
          "it is in — not where it is; that is location. odometer is the total " +
          "distance driven. Use everything only if you genuinely need the full state.",
      },
      car: CAR_PARAM,
    },
    required: ["what", "car"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const picked = pickCar(ctx.env, args.car);
    if (typeof picked === "string") return picked;
    const cfg = picked.cfg;
    const what = String(args.what ?? "summary");
    const units = localeOf(ctx.env).units;

    // Location is worth its own call: it comes back reverse-geocoded, so Jarvis
    // can say "you're at Work" instead of reciting coordinates.
    if (what === "location") {
      const loc = (await call(cfg, `/${cfg.vin}/location`, { signal: ctx.signal })) as {
        address?: string;
        saved_location?: string;
        latitude?: number;
        longitude?: number;
      };
      const coords = num(loc.latitude) !== undefined && num(loc.longitude) !== undefined ? `${loc.latitude}, ${loc.longitude}` : null;
      const parts = [loc.saved_location ? `At ${loc.saved_location}.` : null, loc.address ?? coords].filter(Boolean);
      return parts.length ? parts.join(" ") : "The car did not say where it is.";
    }

    if (what === "battery") {
      const b = (await call(cfg, `/${cfg.vin}/battery`, { signal: ctx.signal })) as Record<
        string,
        unknown
      >;
      const parts = [said(b.battery_level, (n) => `Battery ${n}%`), rangeClause(b.battery_range, units, (d) => `range ${d.n} ${d.unit}`)].filter(Boolean);
      return parts.length ? cap(parts.join(", ")) + "." : "The car did not report its battery.";
    }

    const state = (await call(cfg, `/${cfg.vin}/state?use_cache=true`, {
      signal: ctx.signal,
    })) as Record<string, Record<string, unknown>>;
    if (what === "everything") {
      const labelled = units === "imperial" ? imperialState(state) : metricState(state);
      return JSON.stringify(labelled).slice(0, 4000);
    }

    const charge = state.charge_state ?? {};
    const climate = state.climate_state ?? {};
    const drive = state.drive_state ?? {};
    const vehicle = state.vehicle_state ?? {};

    /*
     * Its own option because `everything` could not deliver it: that dump is
     * cut at 4,000 characters and the odometer sits in vehicle_state, past the
     * cut. Asked for the odometer, the router called `everything` twice, found
     * nothing, and went to the house's Tesla sensor instead.
     */
    if (what === "odometer") {
      const d = distanceIn(vehicle.odometer, units);
      return d === undefined ? "The car did not report an odometer reading." : `Odometer ${d.n} ${d.unit}.`;
    }

    if (what === "climate") {
      const temps = [said(climate.inside_temp, (n) => `Inside ${n}°C`), said(climate.outside_temp, (n) => `outside ${n}°C`)].filter(Boolean);
      const parts = [
        temps.length ? cap(temps.join(", ")) + "." : null,
        climate.is_climate_on === true ? "Climate is on." : climate.is_climate_on === false ? "Climate is off." : null,
        said(climate.driver_temp_setting, (n) => `Set to ${n}°C.`),
      ].filter(Boolean);
      return parts.length ? parts.join(" ") : "The car did not report its climate.";
    }

    if (what === "charge") {
      const levels = [said(charge.battery_level, (n) => `Battery ${n}%`), said(charge.charge_limit_soc, (n) => `limit ${n}%`)].filter(Boolean);
      const parts = [
        levels.length ? cap(levels.join(", ")) + "." : null,
        typeof charge.charging_state === "string" ? `Charging state: ${charge.charging_state}.` : null,
        num(charge.minutes_to_full_charge)
          ? `${num(charge.minutes_to_full_charge)} minutes to full.`
          : null,
      ].filter(Boolean);
      return parts.length ? parts.join(" ") : "The car did not report its charge.";
    }

    const first = [said(charge.battery_level, (n) => `Battery ${n}%`), rangeClause(charge.battery_range, units, (d) => `about ${d.n} ${d.unit} of range`)].filter(Boolean);
    return [
      first.length ? cap(first.join(", ")) + "." : null,
      charge.charging_state === "Charging" ? "It is charging." : null,
      // Not said at all when the car did not say: "It is locked" is a claim someone may walk away on.
      vehicle.locked === false ? "It is unlocked." : vehicle.locked === true ? "It is locked." : null,
      drive.shift_state ? `Shift state ${drive.shift_state}.` : "It is parked.",
      drive.active_route_destination ? `Navigating to ${drive.active_route_destination}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
  },
};

/* ---------- commanding ---------------------------------------------------- */

/** Verified slugs only. See the file header before adding to this map. */
const COMMANDS: Record<string, { slug: string; param?: "temperature" | "percent" | "value" }> = {
  lock: { slug: "lock" },
  unlock: { slug: "unlock" },
  start_climate: { slug: "start_climate" },
  stop_climate: { slug: "stop_climate" },
  set_temperature: { slug: "set_temperatures", param: "temperature" },
  start_charging: { slug: "start_charging" },
  stop_charging: { slug: "stop_charging" },
  set_charge_limit: { slug: "set_charge_limit", param: "percent" },
  open_frunk: { slug: "activate_front_trunk" },
  open_trunk: { slug: "activate_rear_trunk" },
  vent_windows: { slug: "vent_windows" },
  close_windows: { slug: "close_windows" },
  honk: { slug: "honk" },
  flash_lights: { slug: "flash" },
  navigate_to: { slug: "share", param: "value" },
};

/**
 * `share` also accepts a video URL, so anything that can write text the user
 * later asks about could otherwise put arbitrary content on the car's screen.
 * That is prompt injection into the vehicle rather than a misheard word, so it
 * is guarded regardless of the owner's choice to allow every command.
 */
function looksLikeDestination(v: string): boolean {
  if (/^https?:\/\//i.test(v)) return false;
  if (/^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/.test(v.trim())) return true;
  const words = v.trim().split(/\s+/).length;
  return v.length >= 4 && v.length <= 200 && (words >= 2 || /\d/.test(v));
}

export const carCommand: Tool = {
  name: "car_command",
  scope: "car.control",
  pace: "fast",
  available: (env) => !!tessieConfig(env),
  description:
    "Operate the user's Tesla. navigate_to sends a destination to the car's screen — " +
    "pass a full street address, resolving it from the user's saved places first if " +
    "they named one. The car is woken automatically if asleep.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: Object.keys(COMMANDS),
        description: "Which command to run.",
      },
      value: {
        type: ["string", "null"],
        description: "navigate_to only: a full street address, or 'lat,lng'.",
      },
      temperature: {
        type: ["number", "null"],
        description: "set_temperature only: degrees Celsius, 15 to 28.",
      },
      percent: {
        type: ["integer", "null"],
        description: "set_charge_limit only: 50 to 100.",
      },
      car: CAR_PARAM,
    },
    required: ["command", "value", "temperature", "percent", "car"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const picked = pickCar(ctx.env, args.car);
    if (typeof picked === "string") return picked;
    // Shared to see is not shared to drive: the owner chose (hub.ts cars).
    if (picked.car?.level === "see") {
      return `${picked.car.name} is shared with this person to see, not to operate. Its owner can share it for driving in Family.`;
    }
    const cfg = picked.cfg;

    const name = String(args.command ?? "");
    const spec = COMMANDS[name];
    if (!spec) return `I do not have a "${name}" command for the car.`;

    const params = new URLSearchParams({ wait_for_completion: "true", max_attempts: "3" });

    if (spec.param === "value") {
      const value = String(args.value ?? "").trim();
      if (!value) return "No destination was supplied.";
      if (!looksLikeDestination(value)) {
        return (
          "That does not look like an address, so it was not sent to the car. " +
          "Ask the user for a street address."
        );
      }
      params.set("value", value);
      // Tessie wants language AND country ("en-MY"); with no country set in
      // the panel it is left out and Tessie falls back to its default, en-US.
      const tag = localeOf(ctx.env).tag;
      if (tag.includes("-")) params.set("locale", tag);
    } else if (spec.param === "temperature") {
      const t = Number(args.temperature);
      if (!Number.isFinite(t) || t < 15 || t > 28) return "Temperature must be between 15 and 28.";
      params.set("temperature", String(t));
    } else if (spec.param === "percent") {
      const p = Math.round(Number(args.percent));
      if (!Number.isFinite(p) || p < 50 || p > 100) return "Charge limit must be between 50 and 100.";
      params.set("percent", String(p));
    }

    try {
      await ensureAwake(cfg, ctx);
    } catch (e) {
      return `Could not wake the car: ${e instanceof Error ? e.message : String(e)}`;
    }

    ctx.progress(name === "navigate_to" ? "sending it to the car" : "sending that to the car");
    const out = (await call(cfg, `/${cfg.vin}/command/${spec.slug}?${params}`, {
      method: "POST",
      signal: ctx.signal,
    })) as { result?: boolean };

    if (out.result !== true) return `The car did not accept ${name}.`;

    /*
     * Do NOT read the route back to confirm.
     *
     * result:true is Tesla accepting the command. The car then takes far longer
     * than a spoken turn to report the new destination — measured at more than
     * sixteen seconds, and the next command's destination showed up only on a
     * later poll. An earlier version read active_route_destination straight
     * afterwards and announced whatever came back, which meant it confidently
     * reported the OLD destination and told the user navigation had failed when
     * it had in fact worked.
     *
     * Reporting a stale read as current is exactly the failure the router prompt
     * forbids everywhere else. So say what is true: it was sent and accepted.
     */
    if (name === "navigate_to") {
      const sent = params.get("value");
      return `Sent ${sent} to the car. It takes a few seconds to appear on the screen.`;
    }

    return `Done: ${name.replace(/_/g, " ")}.`;
  },
};

export const tessieTools: Tool[] = [carState, carCommand];
