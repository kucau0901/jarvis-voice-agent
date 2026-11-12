import type { Env } from "../types.ts";
import { err, json, publicOrigin, readObjectOrEmpty } from "../lib/http.ts";
import { personOf, type Principal } from "../lib/auth.ts";
import { stateStub } from "../lib/state-client.ts";
import { hubStub } from "../lib/hub-client.ts";
import { readServersForUi } from "../lib/config-store.ts";
import { OWNER } from "../lib/context.ts";
import { localeOf } from "../lib/locale.ts";
import { dayOf } from "../lib/usage.ts";
import { listRemote } from "../tools/mcp.ts";
import { failureOf, remoteOf } from "../tools/components.ts";

/**
 * Settings → Components (lib/components.ts), for the owner key and admins:
 *
 *   GET    /api/components       {components, people, owner}: each as Settings shows it, never a key or a digest;
 *                                the family, as shares name them; whether this caller may set "by itself"
 *   POST   /api/components       {name, url, label?}: added by its public https address. With the label of one
 *                                already here, that one is renamed and moved there: its key and its reporting
 *                                address are dropped, and what it offers is checked and approved again
 *   PUT    /api/components       {id, key}: its key, never shown again
 *   PATCH  /api/components       {id, check: true}: ask it what it offers; what differs from what is approved waits
 *                                {id, approve: hash, classes?}: approve what waits, as it was shown
 *                                {id, classes}: {tool: "reads" | "acts" | "off"} for approved tools
 *                                {id, alone}: {tool: true | false}, an acting tool run with nobody there. Only the
 *                                owner key or the person who set Jarvis up
 *                                {id, shares}: {person: {level: "see" | "use", tell?, as?} | null}
 *                                {id, enabled} · {id, name}
 *                                {id, address: true}: a reporting address of its own, its token shown once;
 *                                {id, address: false}: stopped
 *   DELETE /api/components?id=   one removed, with its key and its reporting address
 *
 * Nothing a component lists is offered to anyone until an admin has approved
 * it here, and nothing it says changes who may reach it.
 */

/**
 * Whether this caller says what may run with nobody there: the owner key, or
 * the person who set Jarvis up, as routes/hub.ts keeps that person's
 * sign-ins from other admins. Jarvis then acts in the owner's name with
 * nobody watching, which one admin does not decide for the household.
 */
const isOwner = async (env: Env, p: Principal): Promise<boolean> =>
  p.kind === "owner" || (p.kind === "member" && p.id === (await hubStub(env)?.firstPerson().catch(() => null)));

/** The family, as shares name them ("owner" for the first person). Before there is one, the first person alone. */
async function peopleOf(env: Env): Promise<{ person: string; name: string; role: string }[]> {
  const family = (await hubStub(env)?.familyPeople().catch(() => null)) ?? [];
  return family.length ? family.map((p) => ({ person: p.person, name: p.name, role: p.role })) : [{ person: OWNER, name: "", role: "admin" }];
}

export async function handleComponents(req: Request, env: Env, principal: Principal): Promise<Response> {
  const state = stateStub(env);
  if (!state) return err(503, "components need the STATE Durable Object");
  const now = Date.now();
  const said = <T>(r: T | string, status = 200) => (typeof r === "string" ? err(r === "no such component" ? 404 : 400, r) : json({ component: r }, { status }));

  if (req.method === "GET") {
    return json({ components: await state.componentsList(dayOf(now, localeOf(env).timeZone)), people: await peopleOf(env), owner: await isOwner(env, principal) });
  }
  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    return (await state.componentRemove(id)) ? json({ ok: true }) : err(404, "no such component");
  }
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") return err(405, "method not allowed");
  const b = await readObjectOrEmpty(req);

  if (req.method === "POST") {
    // Its tools are named by its label, so never one an MCP server has, on or off.
    const taken = (await readServersForUi(env)).servers.map((s) => s.label);
    return said(await state.componentAdd({ name: b.name, url: b.url, label: b.label }, personOf(principal), taken, now), 201);
  }
  if (typeof b.id !== "string") return err(400, "id is required");
  if (req.method === "PUT") return said(await state.componentKey(b.id, b.key, now));

  if (b.check === true) {
    const at = await state.componentTarget(b.id);
    if (!at) return err(404, "no such component");
    try {
      const r = await state.componentListed(b.id, await listRemote(remoteOf(at)), now);
      return typeof r === "string" ? err(400, r) : json(r);
    } catch (e) {
      // What it answered, shown to the admin who asked: never its key.
      return err(502, `It could not be checked: ${failureOf(e, at.key)}`);
    }
  }
  if (b.approve !== undefined) return said(await state.componentApprove(b.id, b.approve, b.classes, now));
  if (b.alone !== undefined) {
    if (!(await isOwner(env, principal))) return err(403, "only the owner key, or the person who set Jarvis up, decides what runs by itself");
    return said(await state.componentAlone(b.id, b.alone, now));
  }
  if (b.classes !== undefined) return said(await state.componentClasses(b.id, b.classes, now));
  if (b.shares !== undefined) return said(await state.componentShares(b.id, b.shares, (await peopleOf(env)).map((p) => p.person), now));
  if (b.enabled !== undefined) return said(await state.componentEnabled(b.id, b.enabled, now));
  if (b.name !== undefined) return said(await state.componentRename(b.id, b.name, now));
  if (b.address === true) {
    const made = await state.componentNewAddress(b.id, now);
    if (typeof made === "string") return said(made);
    // Shown this once: where it posts, and the token it posts with.
    return json({ ...made, url: `${publicOrigin(env, new URL(req.url).origin)}/api/v1/component/events` }, { status: 201 });
  }
  if (b.address === false) return said(await state.componentDropAddress(b.id, now));
  return err(400, "nothing to change");
}
