import type { Env } from "../types.ts";
import { err, json, readObject } from "../lib/http.ts";
import { grantsOf, personOf, type Principal } from "../lib/auth.ts";
import { allows } from "../lib/scopes.ts";
import { stateStub } from "../lib/state-client.ts";
import { haConfig } from "../lib/ha.ts";
import { localeOf } from "../lib/locale.ts";
import { dayOf } from "../lib/usage.ts";
import { carById, pickCar } from "../tools/tessie.ts";
import { actOn, LIVE, readTileOf, viewPanels, type PanelSources } from "../lib/panel-view.ts";
import { baseTools, outputText } from "../tools/registry.ts";
import { mcpSessions, mcpTools } from "../tools/mcp.ts";
import { memoryFor } from "../lib/memory.ts";
import { Collector } from "../lib/collector.ts";
import { run } from "../lib/router.ts";
import type { PanelsReply } from "../../shared/panels.ts";

/**
 * A person's panels on their Home tab (lib/panels.ts, lib/panel-view.ts),
 * made by asking Jarvis (tools/panels.ts). For people with `screen`, which a
 * guest does not have; never a device.
 *
 *   GET  /api/hub/panels       your panels, each thing read now, with the buttons its state offers
 *   GET  /api/hub/panels/read?panel=&key=[&cached=1]   a tile's reading: one of your tools, run now, or
 *        its question's kept answer, looked up again when stale (cached=1: what was kept, at once)
 *   POST /api/hub/panels/act   {panel, key, action, member?, code?}: press one of them
 *   POST /api/hub/panels/remove {panel}: take that panel off (its … menu)
 *   POST /api/hub/panels/note  {panel, add?, tick?, clear?}: a to-do typed onto it, one ticked
 *        off or back on (by its key), or the ticked ones cleared; no model
 *
 * A tile's tool runs as when you ask (lib/panel-tiles.ts): only from the
 * tools your grants offer, MCP ones only with `home`.
 */
export async function handlePanels(req: Request, env: Env, principal: Principal): Promise<Response | null> {
  const p = new URL(req.url).pathname;
  if (!["/api/hub/panels", "/api/hub/panels/read", "/api/hub/panels/act", "/api/hub/panels/remove", "/api/hub/panels/note"].includes(p)) return null;
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
    pick: (named) => pickCar(env, named),
    usage: () => state.usageReport(dayOf(Date.now(), timeZone), me),
    // One of this person's tools, as the router would offer it to them now.
    async tool(name, args) {
      let tool = baseTools(env, grants).find((t) => t.name === name);
      const sessions = mcpSessions();
      try {
        if (!tool && name.includes("__") && allows(grants, "home")) tool = (await mcpTools(env, sessions)).find((t) => t.name === name);
        if (!tool) return null;
        // As the router does: a tool that needs no memory still runs when it cannot be loaded.
        const memory = memoryFor(env, grants);
        await memory.load().catch((e) => console.warn("panel tile: memory unavailable:", e instanceof Error ? e.message : String(e)));
        const out = await tool.run(args, { env, signal: req.signal, progress: () => {}, display: () => {}, memory, grants });
        await memory.save().catch((e) => console.warn("panel tile: memory not saved:", e instanceof Error ? e.message : String(e)));
        return { text: outputText(out), ...(typeof out !== "string" && out.images[0] ? { image: out.images[0].url } : {}) };
      } finally {
        await sessions.close();
      }
    },
    // A tile's looked-up readings, kept in the state object (lib/panels.ts).
    kept: (tile) => state.panelReading(me, tile),
    claim: (tile, every) => state.panelClaimReading(me, tile, every, Date.now()),
    keep: (tile, reading) => state.panelKeepReading(me, tile, reading),
    // A sentence asked of Jarvis, as if typed in Chat.
    async ask(text) {
      const sink = new Collector();
      await run(env, [{ role: "user", text }], sink, AbortSignal.any([req.signal, AbortSignal.timeout(90_000)]), grants, { surface: "chat", assist: true });
      return sink.finish().text;
    },
  };

  if (p === "/api/hub/panels" && req.method === "GET") {
    const reply: PanelsReply = {
      panels: await viewPanels(await state.panelsOf(me), src),
      can: { home: !!src.house && allows(grants, "home"), car: allows(grants, "car.read") && typeof pickCar(env) !== "string" },
    };
    return json(reply);
  }
  if (p === "/api/hub/panels/read" && req.method === "GET") {
    const q = new URL(req.url).searchParams;
    const panel = (await state.panelsOf(me)).find((x) => x.id === q.get("panel"));
    const r = await readTileOf(panel, q.get("key") ?? "", src, q.get("cached") === "1");
    if (r.status !== 200) return err(r.status, r.text);
    const { status: _, ...shown } = r;
    return json(shown);
  }
  if (p === "/api/hub/panels/act" && req.method === "POST") {
    const b = await readObject(req, 2_000);
    if (!b) return err(400, "send {panel, key, action}");
    const panel = (await state.panelsOf(me)).find((x) => x.id === b.panel);
    // An alarm's code goes on to Home Assistant and is kept nowhere.
    const extra = {
      ...(typeof b.member === "string" ? { member: b.member } : {}),
      ...(typeof b.code === "string" && b.code ? { code: b.code.slice(0, 32) } : {}),
    };
    const r = await actOn(panel, String(b.key ?? ""), String(b.action ?? ""), src, req.signal, extra);
    return r.status === 200 ? json({ text: r.text }) : err(r.status, r.text);
  }
  if (p === "/api/hub/panels/note" && req.method === "POST") {
    const b = await readObject(req, 2_000);
    if (!b || typeof b.panel !== "string") return err(400, "send {panel, add | tick | clear}");
    const r =
      typeof b.add === "string" ? await state.panelAddNote(me, b.panel, b.add)
      : typeof b.tick === "string" ? await state.panelTick(me, b.panel, b.tick)
      : b.clear === true ? await state.panelClearTicked(me, b.panel)
      : "send add, tick or clear";
    return typeof r === "string" ? err(409, r) : json({ ok: true });
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
