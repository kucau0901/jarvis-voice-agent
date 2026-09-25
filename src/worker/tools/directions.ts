import type { Tool } from "./registry";
import { localeOf } from "../lib/locale.ts";
import { carWaypoint, drive, type Waypoint } from "../lib/travel.ts";

/**
 * Travel time and traffic. The Routes API call and the car's position live in
 * lib/travel.ts, shared with "leave now" routines.
 */

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
      origin = await carWaypoint(ctx.env);
      if (!origin) {
        return "I could not work out where the car is, so ask the user where they are setting off from.";
      }
    }

    ctx.progress("checking the route");

    const route = await drive(ctx.env, origin, dest.wp);
    if (typeof route === "string") {
      return route.startsWith("No driving route") ? `No driving route was found to ${dest.label}.` : route;
    }

    const withTraffic = route.withTraffic;
    const without = route.without;
    const imperial = localeOf(ctx.env).units === "imperial";
    const distance = imperial
      ? (route.distanceMeters / 1609.344).toFixed(1)
      : (route.distanceMeters / 1000).toFixed(1);
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
