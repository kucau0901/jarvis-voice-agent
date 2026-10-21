import type { Env } from "../types.ts";
import { err, json, readObjectOrEmpty } from "../lib/http.ts";
import { grantsOf, personOf, type Principal } from "../lib/auth.ts";
import { stateStub } from "../lib/state-client.ts";
import { personView } from "../lib/hub-client.ts";
import { PROPOSAL_ID, UNDO_MS, viewOf, weigh } from "../lib/proposals.ts";
import { notAsShown } from "../lib/approval.ts";
import { baseTools } from "../tools/registry.ts";

/**
 *   GET    /api/hub/proposals            {open, recent, allowed}: what the person's jobs proposed (lib/proposals.ts)
 *   POST   /api/hub/proposals/answer     {id, answer: "approve" | "decline" | "undo"}: approved, it comes back running,
 *                                         and the object's alarm makes the call (Proposals.tick); GET says what came of it.
 *                                         Declined, a brief's card is not offered again for a while. "undo" is Put back on
 *                                         one done (archived promotions): its undo, made by code, comes back running
 *   POST   /api/hub/proposals/allow      {id}: let jobs make that kind of call without asking
 *   DELETE /api/hub/proposals/allow?category=   ask again for that kind
 *
 * A person's own, never a device's (the gate refuses devices everything
 * under /api/hub/), and only their own: a proposal is looked up under the
 * person who asks, so someone else's is the same 404 as none. What is run
 * is the call as it was stored, never anything the request says.
 */

const RECENT = 20;

export async function handleProposals(req: Request, env: Env, principal: Principal): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/hub/proposals" && url.pathname !== "/api/hub/proposals/answer" && url.pathname !== "/api/hub/proposals/allow") return null;
  if (principal.kind === "device") return err(403, "proposals are answered by their person, signed in");
  const state = stateStub(env);
  if (!state) return err(503, "proposals need the STATE Durable Object");
  const me = personOf(principal);
  const now = Date.now();

  if (url.pathname === "/api/hub/proposals") {
    if (req.method !== "GET") return err(405, "GET only");
    const [all, allowed] = await Promise.all([state.proposalsOf(me, now), state.proposalAllowed(me)]);
    // Newest decided first: one just approved is listed while its call is made, however long it waited (src/app/proposal.ts watch).
    const decided = all.filter((p) => p.state !== "pending").sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt));
    const newest = decided.slice(0, RECENT);
    // And whatever can still be put back, however far down: its card offers Put back all week.
    const back = decided.slice(RECENT).filter((p) => p.state === "done" && p.by === "tap" && p.action.tool === "mail_archive_many" && !p.undone && now - (p.decidedAt ?? p.createdAt) < UNDO_MS);
    return json({ open: all.filter((p) => p.state === "pending").map(viewOf), recent: [...newest, ...back].map(viewOf), allowed });
  }

  if (url.pathname === "/api/hub/proposals/allow") {
    if (req.method === "DELETE") {
      const category = url.searchParams.get("category") ?? "";
      return (await state.proposalDisallow(me, category)) ? json({ ok: true }) : err(404, "That kind is not allowed without asking.");
    }
    if (req.method !== "POST") return err(405, "POST or DELETE");
    const b = await readObjectOrEmpty(req);
    const id = typeof b.id === "string" && PROPOSAL_ID.test(b.id) ? b.id : "";
    const p = id ? await state.proposalGet(me, id, now) : null;
    if (!p) return err(404, "No such proposal.");
    // Weighed again from what is stored: only a call that still reads as reversible, of the kind it was filed as.
    const local = baseTools(env).find((t) => t.name === p.action.tool);
    // The kind, weighed without which car it named (a car since unshared or renamed must not stop it being allowed).
    const w = local ? weigh(local, "car" in p.action.args ? { ...p.action.args, car: null } : p.action.args, env) : null;
    // The kind, not this one call: which car it was does not matter to what is allowed.
    if (!w || w.risk !== "reversible" || w.category !== p.category) return err(409, "Only a reversible kind of thing can be allowed without asking.");
    const why = await state.proposalAllow(me, id, now);
    return why ? err(409, why) : json({ ok: true, allowed: await state.proposalAllowed(me) });
  }

  if (req.method !== "POST") return err(405, "POST only");
  const b = await readObjectOrEmpty(req);
  const id = typeof b.id === "string" && PROPOSAL_ID.test(b.id) ? b.id : "";
  if (!id) return err(404, "No such proposal.");
  if (b.answer === "decline") {
    const p = await state.proposalDecline(me, id, now);
    return typeof p === "string" ? err(p === "No such proposal." ? 404 : 409, p) : json({ proposal: viewOf(p) });
  }
  if (b.answer !== "approve" && b.answer !== "undo") return err(400, 'answer is "approve", "decline" or "undo"');
  // Who it is for, before it is claimed: a lookup that failed leaves it waiting, to be tapped again.
  const view = await personView(env, me);
  if (view.scopes === undefined) return err(503, "Who it is for could not be checked just now: try again.");
  if (b.answer === "undo") {
    const back = await state.proposalUndo(me, id, view.scopes, grantsOf(principal), now);
    return typeof back === "string" ? err(back === "No such proposal." ? 404 : 409, back) : json({ proposal: viewOf(back) });
  }
  // Not claimed unless it would run as its card says: otherwise it stays waiting (a passing blip can be tapped again).
  const waiting = await state.proposalGet(me, id, now);
  const unlike = waiting?.state === "pending" ? notAsShown(env, waiting) : null;
  if (unlike) return err(409, unlike);
  // Run by the object's alarm, not here: a slow call (waking the car) finishes even if this screen goes away.
  const claimed = await state.proposalApprove(me, id, view.scopes, grantsOf(principal), now);
  if (typeof claimed === "string") return err(claimed === "No such proposal." ? 404 : 409, claimed);
  return json({ proposal: viewOf(claimed) });
}
