import type { Tool, ToolContext } from "./registry";
import { localeOf } from "../lib/locale.ts";

/**
 * Put a place on the screen.
 *
 * The tool's return value is what Jarvis says; the picture travels separately as
 * a `display` SSE event, so the spoken answer stays short while the screen shows
 * the detail. Nothing here carries the Google key — the browser asks the Worker
 * for imagery, and the Worker asks Google.
 */

const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const SV_META = "https://maps.googleapis.com/maps/api/streetview/metadata";

interface Located {
  lat: number;
  lng: number;
  label: string;
}

async function locate(query: string, ctx: ToolContext): Promise<Located | string> {
  // A saved place already has an address, and the user's own name for it is a
  // better label than whatever Google formats. But a query that is already a
  // full address is not a nickname, so it goes straight to Google — otherwise a
  // weak token overlap can silently redirect it somewhere else entirely.
  const looksLikeAddress = query.split(/\s+/).length > 5 || /\d{4,}/.test(query);
  const saved = looksLikeAddress ? undefined : ctx.memory.resolvePlace(query);
  const address = saved?.address ?? query;

  const key = ctx.env.GOOGLE_MAPS_API_KEY!;
  // A region bias only when the settings panel names a country; was always "my".
  const country = localeOf(ctx.env).country;
  const region = country ? `&region=${country.toLowerCase()}` : "";
  const res = await fetch(`${GEOCODE}?address=${encodeURIComponent(address)}${region}&key=${key}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return `Could not look that place up (${res.status}).`;

  const j = (await res.json()) as {
    status?: string;
    results?: { formatted_address?: string; geometry?: { location?: { lat: number; lng: number } } }[];
  };
  const hit = j.results?.[0];
  const loc = hit?.geometry?.location;
  if (!loc) {
    return (
      `I could not find "${query}" on the map. If it is somewhere the user knows, ` +
      `ask for the full address.`
    );
  }
  return {
    lat: loc.lat,
    lng: loc.lng,
    label: saved?.slug ? saved.slug : (hit?.formatted_address ?? query),
  };
}

export const showPlace: Tool = {
  name: "show_place",
  scope: "screen",
  pace: "fast",
  available: (env) => !!env.GOOGLE_MAPS_API_KEY,
  description:
    "Put a place on the screen, as a map or a street-level photo. Use when the " +
    "user asks to SEE somewhere — 'show me X', 'what does it look like there', 'put it " +
    "on the map'. Do not use it to answer a question that only needs words. Keep your " +
    "spoken reply to one short sentence, because the screen is carrying the detail.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The place: a saved name like 'home', a landmark, or a full address.",
      },
      view: {
        type: "string",
        enum: ["map", "satellite", "streetview"],
        description: "streetview for 'what does it look like'; map otherwise.",
      },
    },
    required: ["query", "view"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) return "No place was supplied.";
    const want = String(args.view ?? "map");

    const found = await locate(query, ctx);
    if (typeof found === "string") return found;

    let view = want;
    let note = "";
    if (want === "streetview") {
      // Ask first whether imagery exists, rather than displaying Google's grey
      // "no imagery" placeholder and letting Jarvis claim he has shown something.
      try {
        const m = await fetch(
          `${SV_META}?location=${found.lat},${found.lng}&key=${ctx.env.GOOGLE_MAPS_API_KEY}`,
          { signal: AbortSignal.timeout(6000) },
        );
        const meta = (await m.json()) as { status?: string };
        if (meta.status !== "OK") {
          view = "map";
          note = " There is no street-level photo there, so this is the map instead.";
        }
      } catch {
        /* if the check fails, try the photo anyway */
      }
    }

    /*
     * When an embed key is configured, hand the browser an interactive URL —
     * a real pannable Street View rather than a photograph of one.
     *
     * The key rides on this authenticated stream instead of being baked into
     * the JS bundle, because the bundle is served to anyone who loads the page:
     * only /api/* sits behind the shared secret. It still wants a referrer
     * restriction of its own, since anything reaching a browser should be
     * assumed public.
     *
     * It cannot be the same key as the server-side one. A referrer restriction
     * is what makes a browser key safe, and a Worker sends no referrer — so the
     * restriction that protects this one would break that one.
     */
    const embedKey = ctx.env.GOOGLE_MAPS_EMBED_KEY;
    let embedUrl: string | undefined;
    if (embedKey) {
      const p = new URLSearchParams({ key: embedKey });
      if (view === "streetview") {
        p.set("location", `${found.lat},${found.lng}`);
        p.set("fov", "90");
        embedUrl = `https://www.google.com/maps/embed/v1/streetview?${p}`;
      } else {
        p.set("q", `${found.lat},${found.lng}`);
        p.set("zoom", "16");
        p.set("maptype", view === "satellite" ? "satellite" : "roadmap");
        embedUrl = `https://www.google.com/maps/embed/v1/place?${p}`;
      }
    }

    ctx.display({
      kind: view === "streetview" ? "streetview" : "map",
      lat: found.lat,
      lng: found.lng,
      label: found.label,
      maptype: view === "satellite" ? "satellite" : "roadmap",
      ...(embedUrl ? { embedUrl } : {}),
    });

    return `Showing ${found.label} on screen.${note}`;
  },
};

/**
 * Clear the screen by voice.
 *
 * Reaching across to a Close button while driving is exactly what this whole
 * panel should not require, so the driver can simply say so instead.
 */
export const hideDisplay: Tool = {
  name: "hide_display",
  scope: "screen",
  pace: "fast",
  description:
    "Clear whatever is on the screen — a map, a photo, a camera. Use when the " +
    "user says they are done with it: 'close that', 'hide the map', 'I'm done looking'. " +
    "Acknowledge in two or three words.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(_args, ctx) {
    ctx.display({ kind: "close" });
    return "Screen cleared.";
  },
};

export const placeTools: Tool[] = [showPlace, hideDisplay];
