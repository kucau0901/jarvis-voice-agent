import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { grantsOf, personOf, type Principal } from "../lib/auth.ts";
import { allows } from "../lib/scopes.ts";
import { stateStub } from "../lib/state-client.ts";
import { haConfig } from "../lib/ha.ts";
import { localeOf } from "../lib/locale.ts";
import { dayOf } from "../lib/usage.ts";
import { carById, pickCar } from "../tools/tessie.ts";
import { actOn, LIVE, viewPanels, type PanelSources } from "../lib/panel-view.ts";
import type { PanelsReply } from "../../shared/panels.ts";

/**
 * A person's panels on their Home tab (lib/panels.ts, lib/panel-view.ts),
 * made by asking Jarvis (tools/panels.ts). For people with `screen`, which a
 * guest does not have; never a device.
 *
 *   GET  /api/hub/panels       your panels, each thing read now, with the buttons its state offers
 *   POST /api/hub/panels/act   {panel, key, action}: press one of them
 *   POST /api/hub/panels/remove {panel}: take that panel off (its … menu)
 */
export async function handlePanels(req: Request, env: Env, principal: Principal): Promise<Response | null> {
  const p = new URL(req.url).pathname;
  if (p !== "/api/hub/panels" && p !== "/api/hub/panels/act" && p !== "/api/hub/panels/remove") return null;
  if (principal.kind === "device") return err(403, "that is for a person, not a device");
  const grants = grantsOf(principal);
  if (!allows(grants, "screen")) return err(403, 'panels need "screen"', { need: "screen" });
  const state = stateStub(env);
  if (!state) return err(503, "panels need the STATE Durable Object");
  const me = personOf(principal);
  const { timeZone, units } = localeOf(env);
  const src: PanelSources = {
    ...LIVE,
    grants,
    units,
    house: haConfig(env),
    car: (id) => carById(env, id),
    usage: () => state.usageReport(dayOf(Date.now(), timeZone), me),
  };

  if (p === "/api/hub/panels" && req.method === "GET") {
    const reply: PanelsReply = {
      panels: await viewPanels(await state.panelsOf(me), src),
      can: { home: !!src.house && allows(grants, "home"), car: allows(grants, "car.read") && typeof pickCar(env) !== "string" },
    };
    return json(reply);
  }
  if (p === "/api/hub/panels/act" && req.method === "POST") {
    const b = await readObject(req, 2_000);
    if (!b) return err(400, "send {panel, key, action}");
    const panel = (await state.panelsOf(me)).find((x) => x.id === b.panel);
    const r = await actOn(panel, String(b.key ?? ""), String(b.action ?? ""), src, req.signal);
    return r.status === 200 ? json({ text: r.text }) : err(r.status, r.text);
  }
  if (p === "/api/hub/panels/remove" && req.method === "POST") {
    const b = await readObject(req, 2_000);
    if (!b) return err(400, "send {panel}");
    const panel = (await state.panelsOf(me)).find((x) => x.id === b.panel);
    if (!panel) return err(404, "you have no such panel");
    const left = await state.panelRemove(me, panel.title, null);
    return typeof left === "string" ? err(409, left) : json({ removed: panel.title });
  }
  return err(405, "GET your panels, or POST to /api/hub/panels/act or /remove");
}
