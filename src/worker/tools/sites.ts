import type { Tool } from "./registry.ts";
import { nearest } from "./args.ts";
import { said, where } from "./publish.ts";
import { siteBack, siteDown, sitesOf } from "../lib/sites.ts";
import { workshopConfig } from "../lib/workshop.ts";
import { wordsOf } from "../lib/jobs.ts";
import { whenSaid } from "../lib/routines.ts";
import { localeOf } from "../lib/locale.ts";
import { ownPart } from "../lib/quote.ts";

/**
 * The sites jobs built and a tap published (lib/sites.ts), by chat or voice,
 * as Jobs → Sites has them: the family's, for whoever may use the workshop.
 * Taking one down or putting one back is a person's, in their own words: never
 * a device's, a routine's or a bot's, where nobody said anything. Publishing
 * stays the card's (tools/publish.ts).
 */
export const siteControl: Tool = {
  name: "site_control",
  scope: "workshop",
  pace: "fast",
  description:
    "The sites background jobs built and a tap published: 'list' them, with their address; 'down' takes one down, kept to put back; " +
    "'back' puts one as it was before (one taken down comes back up). Down and back only when the user asks, in their own words.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["list", "down", "back"] },
      site: { type: ["string", "null"], description: "Words of its name, e.g. 'bake sale'; null to list, or for the only one." },
    },
    required: ["op", "site"],
    additionalProperties: false,
  },
  available: (env) => workshopConfig(env) !== null,
  run: said(async (args, ctx) => {
    const cfg = workshopConfig(ctx.env);
    if (!cfg) return "The workshop is not set up here (Settings → Workshop).";
    const op = args.op === "down" || args.op === "back" ? args.op : "list";
    if (op !== "list") {
      if (ctx.env.JARVIS_DEVICE) return "Not done: a site is changed by a person, signed in, not by a device.";
      if (!ownPart(ctx.asked ?? "")) return "Not done: only the user can do that, in their own words.";
    }
    const all = await sitesOf(cfg, ctx.signal);
    if (!all) return "There is no sites folder: Sites is not turned on where the workshop runs.";
    if (op === "list") {
      if (!all.sites.length) return "No site is published.";
      const tz = localeOf(ctx.env).timeZone;
      return (
        `${all.address ? `Sites are seen at ${all.address}/<name>/.` : "Sites have no address set."}\n` +
        all.sites
          .map((s) => `- "${s.name}": ${s.down ? `taken down (last put there ${whenSaid(s.at, tz)})` : `up at ${where(s.name, all.address)}, put there ${whenSaid(s.at, tz)}`}, ${s.files} file${s.files === 1 ? "" : "s"}${s.before ? "; an earlier version is kept" : ""}`)
          .join("\n")
      );
    }
    const pool = op === "down" ? all.sites.filter((s) => !s.down) : all.sites;
    const fits = nearest(pool, wordsOf(typeof args.site === "string" ? args.site : ""), (s) => s.name.replace(/-/g, " "), true);
    if (!fits.length) return `No site ${op === "down" ? "that is up " : ""}is called that.${pool.length ? ` There are: ${pool.map((s) => `"${s.name}"`).join(", ")}.` : ""}`;
    if (fits.length > 1) return `More than one is: ${fits.map((s) => `"${s.name}"`).join(", ")}. Ask which.`;
    const s = fits[0]!;
    if (op === "down") {
      await siteDown(cfg, s.name);
      return `Taken down: "${s.name}" no longer answers at ${where(s.name, all.address)}. Its last version is kept, to put back.`;
    }
    const r = await siteBack(cfg, s.name);
    if (s.down) return `"${s.name}" is back up, at ${where(s.name, r.address)}.`;
    return r.down
      ? `"${s.name}" had no earlier version, so it is taken down now, kept to put back.`
      : `"${s.name}" is as it was before, at ${where(s.name, r.address)}. The version it replaced is kept, so this can be put back too.`;
  }),
};
