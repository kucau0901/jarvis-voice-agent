import type { Panel, Reading } from "./panels.ts";
import { tileKey } from "./panels.ts";
import { isAsk, parseTile } from "./panel-tiles.ts";

/**
 * What the sky behind the app is drawn from (src/app/orb/Sky.ts): where home
 * is, for the sun, and the weather, from one Home Assistant template; and the
 * air, from a panel's kept air-quality reading. No model, nothing asked again:
 * only what is already there.
 */

/** Home's place and the first weather entity's state, as JSON. */
export const SKY_TEMPLATE =
  "{% set w = states.weather | list | first %}" +
  "{{ {'lat': state_attr('zone.home','latitude'), 'lng': state_attr('zone.home','longitude'), " +
  "'state': w.state if w else none, 'cloud': (w.attributes.get('cloud_coverage') if w else none)} | tojson }}";

/** The first weather entity's state and temperature, as JSON, for a brief (lib/brief.ts). */
export const WEATHER_TEMPLATE =
  "{% set w = states.weather | list | first %}" +
  "{{ {'state': w.state if w else none, 'temperature': (w.attributes.get('temperature') if w else none), " +
  "'unit': (w.attributes.get('temperature_unit') if w else none)} | tojson }}";

/** Home Assistant's weather states that do not read as words. */
const SAID: Record<string, string> = {
  "clear-night": "clear", partlycloudy: "partly cloudy", lightning: "thunder", "lightning-rainy": "thunderstorms",
  "snowy-rainy": "sleet", "windy-variant": "windy and cloudy", exceptional: "unusual weather",
};

/** WEATHER_TEMPLATE's answer in words ("Partly cloudy, 31 °C"); null when there is no weather to say. */
export function weatherSaid(raw: string): string | null {
  let v: { state?: unknown; temperature?: unknown; unit?: unknown } = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") v = parsed;
  } catch {
    return null;
  }
  if (typeof v.state !== "string" || !(v.state in WEATHER)) return null;
  const words = SAID[v.state] ?? v.state;
  const t = typeof v.temperature === "number" && Number.isFinite(v.temperature) ? Math.round(v.temperature) : null;
  const unit = typeof v.unit === "string" && /^°[CF]$/.test(v.unit) ? ` ${v.unit}` : "°";
  return words.charAt(0).toUpperCase() + words.slice(1) + (t === null ? "" : `, ${t}${unit}`);
}

export interface Sky {
  lat?: number;
  lng?: number;
  /** 0 to 1. */
  cloud: number;
  rain: number;
  haze: number;
}

/** How cloudy and how wet each of Home Assistant's weather states is, 0 to 1. */
const WEATHER: Record<string, [cloud: number, rain: number]> = {
  "clear-night": [0, 0], sunny: [0, 0], partlycloudy: [0.4, 0], cloudy: [0.85, 0], fog: [0.7, 0],
  rainy: [0.9, 0.5], pouring: [1, 1], lightning: [0.95, 0.3], "lightning-rainy": [1, 0.8], hail: [0.95, 0.7],
  snowy: [0.9, 0.4], "snowy-rainy": [0.95, 0.6], windy: [0.3, 0], "windy-variant": [0.5, 0], exceptional: [0.6, 0],
};

const unit = (n: number) => Math.min(1, Math.max(0, n));

/** The template's answer as the sky reads it; nothing it cannot read. */
export function skyOf(raw: string): Omit<Sky, "haze"> {
  let v: { lat?: unknown; lng?: unknown; state?: unknown; cloud?: unknown } = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") v = parsed;
  } catch {
    // not JSON: a sky by the clock
  }
  const [cloud, rain] = typeof v.state === "string" ? WEATHER[v.state] ?? [0, 0] : [0, 0];
  const lat = Number(v.lat);
  const lng = Number(v.lng);
  return {
    ...(Number.isFinite(lat) && Number.isFinite(lng) && v.lat !== null && v.lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : {}),
    // A measured cover beats the word for it.
    cloud: typeof v.cloud === "number" && Number.isFinite(v.cloud) ? unit(v.cloud / 100) : cloud,
    rain,
  };
}

/**
 * The air, 0 (clean) to 1 (hazardous), from the first panel tile that looks
 * up air quality and has a reading kept: AQI or Malaysia's API, the same
 * scale, 0 to 300 and over.
 */
export async function hazeOf(panels: readonly Panel[], kept: (key: string) => Promise<Reading | null>): Promise<number> {
  for (const p of panels) {
    for (const item of p.items) {
      if (item.kind !== "tile") continue;
      const read = parseTile(item.ref)?.read;
      if (!read || !isAsk(read) || !/\b(aqi|api|air[ -]?quality|pollut|haze|jerebu)/i.test(`${read.ask} ${item.label}`)) continue;
      const r = await kept(tileKey(item.ref)).catch(() => null);
      const n = r ? Number(/\b(\d{1,3})\b/.exec([r.figures[0]?.value ?? "", r.text].join(" "))?.[1]) : NaN;
      if (Number.isFinite(n)) return unit((n - 50) / 250);
    }
  }
  return 0;
}
