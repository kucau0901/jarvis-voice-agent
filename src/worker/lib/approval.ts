import type { Env } from "../types.ts";
import { runTool } from "./router.ts";
import { RUN_MS, weigh, type Proposal, type Weighed } from "./proposals.ts";
import { mailDraftSend } from "./mail-draft.ts";
import { mailArchiveMany, mailInboxMany } from "./mail-bulk.ts";
import { calendarRsvp } from "../tools/calendar.ts";
import type { Grant } from "./scopes.ts";
import { baseTools, outputText } from "../tools/registry.ts";

/**
 * What an approval runs (lib/proposals.ts): the stored call, once, with no
 * model, and only as its card says. Checked by the route before a tap claims
 * it (routes/proposals.ts), and again by the object's alarm as it runs it
 * (Proposals.tick, state.ts).
 */

/** What only an approval runs: never offered to the router, nor to a job. */
const APPROVED_ONLY = [mailDraftSend, calendarRsvp, mailArchiveMany, mailInboxMany];

const goneSaid = (tool: string) => `That can no longer be done: ${tool} is not set up, or not yours to use now.`;

/**
 * Why the stored call would not run as its card says, here and now; null when
 * it would. Weighed again from what is stored: a call that no longer reads
 * as it did (another car first in their list, say) is not done.
 */
export function notAsShown(env: Env, p: Proposal): string | null {
  const local = [...baseTools(env), ...APPROVED_ONLY].find((t) => t.name === p.action.tool);
  if (!local && !p.action.tool.includes("__")) return goneSaid(p.action.tool);
  const w = weigh(local ?? { name: p.action.tool }, p.action.args, env);
  if (!w) return "That can no longer be done.";
  // Its button too, once cards have one: one filed before then has none to compare.
  const same = w.says === p.says && (p.verb === undefined || w.verb === p.verb);
  return same ? null : `That has changed since it was proposed (it would now be: ${w.says}), so nothing was done.`;
}

/** Put back: what undoes a done call, made by code from its stored arguments; null for one that has no undo. */
export function inverseOf(env: Env, p: Proposal): { action: Proposal["action"]; weighed: Weighed } | null {
  if (p.action.tool !== mailArchiveMany.name) return null;
  const action = { tool: mailInboxMany.name, args: { ids: p.action.args.ids, total: p.action.args.total } };
  const weighed = weigh(mailInboxMany, action.args, env);
  return weighed ? { action, weighed } : null;
}

/** The stored call, run once with what its tap allowed (Proposals.claim); what came of it, in words. Done only if the tool says it did it. */
export async function carryOut(env: Env, p: Proposal, grants: readonly Grant[]): Promise<{ ok: boolean; text: string }> {
  // Checked before it was claimed too; again here, as it is run.
  const unlike = notAsShown(env, p);
  if (unlike) return { ok: false, text: unlike };
  try {
    let ok = false;
    const out = await runTool(env, grants, p.action.tool, p.action.args, AbortSignal.timeout(RUN_MS), APPROVED_ONLY, () => void (ok = true));
    if (out === null) return { ok: false, text: goneSaid(p.action.tool) };
    return { ok, text: outputText(out) };
  } catch (e) {
    return { ok: false, text: `That failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
