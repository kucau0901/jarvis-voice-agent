import type { Env } from "../types.ts";
import { err, json, readObjectOrEmpty } from "../lib/http.ts";
import { grantsOf, personOf, type Principal } from "../lib/auth.ts";
import { stateStub } from "../lib/state-client.ts";
import { personView } from "../lib/hub-client.ts";
import { runTool } from "../lib/router.ts";
import { PROPOSAL_ID, runGrants, viewOf, weigh, type Proposal } from "../lib/proposals.ts";
import { baseTools, outputText } from "../tools/registry.ts";
import { mailDraftSend } from "../lib/mail-draft.ts";

/**
 *   GET  /api/hub/proposals            {open, recent}: what the person's jobs proposed (lib/proposals.ts)
 *   POST /api/hub/proposals/answer     {id, answer: "approve" | "decline"}
 *
 * A person's own, never a device's (the gate refuses devices everything
 * under /api/hub/), and only their own: a proposal is looked up under the
 * person who asks, so someone else's is the same 404 as none. What is run
 * is the call as it was stored, never anything the request says.
 */

/** As long as waking the car may take (tools/tessie.ts), and then some. */
const RUN_MS = 120_000;
const RECENT = 20;
/** What only an approval runs: never offered to the router. */
const APPROVED_ONLY = [mailDraftSend];

export async function handleProposals(req: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/hub/proposals" && url.pathname !== "/api/hub/proposals/answer") return null;
  if (principal.kind === "device") return err(403, "proposals are answered by their person, signed in");
  const state = stateStub(env);
  if (!state) return err(503, "proposals need the STATE Durable Object");
  const me = personOf(principal);
  const now = Date.now();

  if (url.pathname === "/api/hub/proposals") {
    if (req.method !== "GET") return err(405, "GET only");
    const all = await state.proposalsOf(me, now);
    return json({
      open: all.filter((p) => p.state === "pending").map(viewOf),
      recent: all.filter((p) => p.state !== "pending").slice(0, RECENT).map(viewOf),
    });
  }

  if (req.method !== "POST") return err(405, "POST only");
  const b = await readObjectOrEmpty(req);
  const id = typeof b.id === "string" && PROPOSAL_ID.test(b.id) ? b.id : "";
  if (!id) return err(404, "No such proposal.");
  if (b.answer === "decline") {
    const p = await state.proposalDecline(me, id, now);
    return typeof p === "string" ? err(p === "No such proposal." ? 404 : 409, p) : json({ proposal: viewOf(p) });
  }
  if (b.answer !== "approve") return err(400, 'answer is "approve" or "decline"');
  const claimed = await state.proposalClaim(me, id, now);
  if (typeof claimed === "string") return err(claimed === "No such proposal." ? 404 : 409, claimed);
  // Carried on if the screen goes away meanwhile: a claimed proposal always ends with what came of it.
  const work = carryOut(env, principal, claimed).then((outcome) => state.proposalFinish(me, id, outcome, Date.now()));
  ctx.waitUntil(work);
  const done = await work;
  return json({ proposal: done ? viewOf(done) : viewOf(claimed) });
}

/** The stored call, run once, as it is now allowed to be; what came of it, in words. */
export async function carryOut(env: Env, approver: Principal, p: Proposal): Promise<{ ok: boolean; text: string }> {
  // Weighed again from what is stored: a call that no longer reads as one that can be proposed is not run.
  const local = [...baseTools(env), ...APPROVED_ONLY].find((t) => t.name === p.action.tool);
  const gone = { ok: false, text: `That can no longer be done: ${p.action.tool} is not set up, or not yours to use now.` };
  if (!local && !p.action.tool.includes("__")) return gone;
  if (!weigh(local ?? { name: p.action.tool }, p.action.args)) return { ok: false, text: "That can no longer be done." };
  const view = await personView(env, p.person);
  if (view.scopes === null) return { ok: false, text: "Whoever it was for is no longer in the family." };
  const grants = runGrants(p.grants, view.scopes, grantsOf(approver));
  if (!grants) return { ok: false, text: "Who it is for could not be checked just now: try again." };
  try {
    const out = await runTool(env, grants, p.action.tool, p.action.args, AbortSignal.timeout(RUN_MS), APPROVED_ONLY);
    if (out === null) return gone;
    return { ok: true, text: outputText(out) };
  } catch (e) {
    return { ok: false, text: `That failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
