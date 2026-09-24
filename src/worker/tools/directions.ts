import type { Tool, ToolContext } from "./registry";
import { localeOf } from "../lib/locale.ts";
import { tessieConfig } from "./tessie";

/**
 * Travel time and traffic, via the Google Routes API.
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
const FIELD_MASK =
  "routes.duration,routes.staticDuration,routes.distanceMeters,routes.description";

interface Waypoint {
  location?: { latLng: { latitude: number; longitude: number } };
  address?: string;
}

/** Where the car is now. Tessie knows precisely; the browser was never asked. */
async function carPosition(ctx: ToolContext): Promise<Waypoint | null> {
  const cfg = tessieConfig(ctx.env);
  if (!cfg) return null;
  try {
    const res = await fetch(`https://api.tessie.com/${cfg.vin}/location`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const loc = (await res.json()) as { latitude?: number; longitude?: number };
    if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return null;
    return {
      location: { latLng: { latitude: loc.latitude!, longitude: loc.longitude! } },
    };
  } catch {
    return null;
  }
}

/**
 * Only a resolved place or something that actually looks like an address goes to
 * Google. Handed a bare "the office", Google will happily geocode *an* office
 * somewhere and the model will report that travel time as fact.
 */
function looksLikeAddress(v: string): boolean {
  const s = v.trim();
  if (/^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/.test(s)) return true;
  return /\d/.test(s) || s.split(/\s+/).length >= 3 || s.includes(",");
}

const minutes = (iso: string | undefined): number =>
  Math.round(Number(String(iso ?? "0s").replace("s", "")) / 60);

export const directions: Tool = {
  name: "directions",
  scope: "car.read",
  pace: "fast",
  available: (env) => !!env.GOOGLE_MAPS_API_KEY,
  description:
    "How long it takes to drive somewhere, with live traffic. Use for 'how long to get " +
    "home', 'traffic to the office', 'how far is X'. If the user names a place they have " +
    "saved, pass its full address from the profile block rather than the nickname. This " +
    "only reports the journey — it does not send anything to the car; use car_command " +
    "navigate_to for that.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Destination: a full street address, or 'lat,lng'.",
      },
      to_name: {
        type: ["string", "null"],
        description:
          "What the user called it, e.g. 'home'. Used to look up a saved address when " +
          "`to` is not already a full address.",
      },
      from: {
        type: ["string", "null"],
        description: "Starting point. Defaults to where the car is now.",
      },
    },
    required: ["to", "to_name", "from"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const key = ctx.env.GOOGLE_MAPS_API_KEY;
    if (!key) return "Maps is not connected to me.";

    const resolve = (raw: string): { wp: Waypoint; label: string } | string => {
      const v = raw.trim();
      if (!v) return "No destination was supplied.";
      const saved = ctx.memory.resolvePlace(v);
      if (saved?.address) return { wp: { address: saved.address }, label: saved.slug ?? v };
      if (looksLikeAddress(v)) return { wp: { address: v }, label: v };
      // Turn the failure into the moment that teaches it, rather than guessing.
      return (
        `I don't have an address for "${v}". Ask the user for it, then save it with ` +
        `remember so it works next time.`
      );
    };

    // Prefer the nickname when it resolves to something saved: "home" is a
    // better key than whatever address the model guessed alongside it.
    const nameHint = typeof args.to_name === "string" ? args.to_name.trim() : "";
    const target = nameHint && ctx.memory.resolvePlace(nameHint) ? nameHint : String(args.to ?? "");
    const dest = resolve(target);
    if (typeof dest === "string") return dest;

    let origin: Waypoint | null = null;
    let originLabel = "where you are";
    if (typeof args.from === "string" && args.from.trim()) {
      const o = resolve(args.from);
      if (typeof o === "string") return o;
      origin = o.wp;
      originLabel = o.label;
    } else {
      origin = await carPosition(ctx);
      if (!origin) {
        return "I could not work out where the car is, so ask the user where they are setting off from.";
      }
    }

    ctx.progress("checking the route");

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        origin,
        destination: dest.wp,
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        // From the settings panel (lib/locale.ts); was "MY" and METRIC always.
        ...(localeOf(ctx.env).country ? { regionCode: localeOf(ctx.env).country } : {}),
        units: localeOf(ctx.env).units === "imperial" ? "IMPERIAL" : "METRIC",
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
    if (!route) return `No driving route was found to ${dest.label}.`;

    const withTraffic = minutes(route.duration);
    const without = minutes(route.staticDuration);
    const imperial = localeOf(ctx.env).units === "imperial";
    const distance = imperial
      ? ((route.distanceMeters ?? 0) / 1609.344).toFixed(1)
      : ((route.distanceMeters ?? 0) / 1000).toFixed(1);
    const delay = withTraffic - without;

    return [
      `${dest.label}: ${distance} ${imperial ? "miles" : "km"}, ${withTraffic} minutes from ${originLabel}.`,
      delay >= 3 ? `About ${delay} of that is traffic.` : "Traffic is light.",
      route.description ? `Via ${route.description}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
  },
};

export const directionsTools: Tool[] = [directions];
