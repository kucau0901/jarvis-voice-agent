import type { Env } from "../types";
import { localeOf } from "./locale.ts";

/**
 * Drive times, via the Google Routes API, and where the car is, via Tessie.
 * Shared by the `directions` tool and by "leave now" routines (lib/leave.ts).
 *
 * Routes rather than the legacy Directions API, because it returns `duration`
 * (with traffic) and `staticDuration` (without) in the same response — which is
 * the difference between "twenty-four minutes" and "twenty-four minutes, about
 * five of that traffic". It also geocodes a free-text address inline, so a saved
 * address needs no separate lookup call.
 */

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const TIMEOUT_MS = 8_000;

/**
 * The Routes API bills by requested fields, so this mask is a cost decision as
 * much as a size one. Adding routes.polyline for debugging moves the call to a
 * materially more expensive SKU.
 */
const FIELD_MASK = "routes.duration,routes.staticDuration,routes.distanceMeters,routes.description";

export interface Waypoint {
  location?: { latLng: { latitude: number; longitude: number } };
  address?: string;
}

/** Where the car is now. Tessie knows precisely; the browser was never asked. */
export async function carWaypoint(env: Env): Promise<Waypoint | null> {
  if (!env.TESSIE_TOKEN || !env.TESSIE_VIN) return null;
  try {
    const res = await fetch(`https://api.tessie.com/${env.TESSIE_VIN.trim()}/location`, {
      headers: { Authorization: `Bearer ${env.TESSIE_TOKEN.trim()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const loc = (await res.json()) as { latitude?: number; longitude?: number };
    if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return null;
    return { location: { latLng: { latitude: loc.latitude!, longitude: loc.longitude! } } };
  } catch {
    return null;
  }
}

export interface Drive {
  /** Minutes, with live traffic. */
  withTraffic: number;
  /** Minutes, without. */
  without: number;
  distanceMeters: number;
  description?: string;
}

const minutes = (iso: string | undefined): number => Math.round(Number(String(iso ?? "0s").replace("s", "")) / 60);

/** One route, or a sentence saying why not. */
export async function drive(env: Env, origin: Waypoint, destination: Waypoint): Promise<Drive | string> {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return "Maps is not connected to me.";
  const l = localeOf(env);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      origin,
      destination,
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      // From the settings panel (lib/locale.ts); was "MY" and METRIC always.
      ...(l.country ? { regionCode: l.country } : {}),
      units: l.units === "imperial" ? "IMPERIAL" : "METRIC",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `Maps returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
  }
  const j = (await res.json()) as {
    routes?: { duration?: string; staticDuration?: string; distanceMeters?: number; description?: string }[];
  };
  const route = j.routes?.[0];
  if (!route) return "No driving route was found.";
  return {
    withTraffic: minutes(route.duration),
    without: minutes(route.staticDuration),
    distanceMeters: route.distanceMeters ?? 0,
    ...(route.description ? { description: route.description } : {}),
  };
}
