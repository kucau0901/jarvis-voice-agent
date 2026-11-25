import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import type { Principal } from "../lib/auth.ts";
import { siteBack, siteDown, sitesOf } from "../lib/sites.ts";
import { WorkshopError, workshopConfig } from "../lib/workshop.ts";

/**
 * What jobs built and a tap published (lib/sites.ts), in Jobs. Both need
 * `workshop`; a device is shown them and changes none.
 *
 *   GET  /api/v1/sites   {address, sites}; {sites: null} where there is no sites folder
 *   POST /api/v1/sites   {name, op: "back" | "down"}: as it was before, or taken down and kept
 */
export async function handleSites(req: Request, env: Env, url: URL, principal: Principal): Promise<Response | null> {
  if (url.pathname !== "/api/v1/sites") return null;
  const cfg = workshopConfig(env);
  if (req.method === "GET") {
    const all = cfg && (await sitesOf(cfg));
    return json({ address: all?.address ?? null, sites: all?.sites ?? null });
  }
  if (req.method !== "POST") return err(405, "method not allowed");
  if (principal.kind === "device") return err(403, "a site is changed by a person, not a device");
  if (!cfg) return err(503, "the workshop is not set up");
  const b = await readObject(req, 2_000);
  const name = typeof b?.name === "string" ? b.name : "";
  try {
    if (b?.op === "back") return json({ ok: true, ...(await siteBack(cfg, name)) });
    if (b?.op === "down") return await siteDown(cfg, name).then(() => json({ ok: true }));
    return err(400, 'op is "back" or "down"');
  } catch (e) {
    if (!(e instanceof WorkshopError)) throw e;
    return err(e.refused ? 400 : 503, e.message);
  }
}
