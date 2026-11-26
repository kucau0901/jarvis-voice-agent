import type { Env } from "../types.ts";
import { runTool } from "./router.ts";
import { RUN_MS, weigh, type Proposal, type Weighed } from "./proposals.ts";
import { mailDraftSend } from "./mail-draft.ts";
import { mailArchiveMany, mailInboxMany } from "./mail-bulk.ts";
import { calendarRsvp } from "../tools/calendar.ts";
import { routineMake } from "../tools/routines.ts";
import { houseDo } from "../tools/house.ts";
import { specialtyKeep } from "../tools/specialties.ts";
import { PUBLISHING, repoPull, sitePublishTool, sitePutBack } from "../tools/publish.ts";
import { WILDCARD, covers, type Grant } from "./scopes.ts";
import { baseTools, outputText } from "../tools/registry.ts";

/**
 * What an approval runs (lib/proposals.ts): the stored call, once, with no
 * model, and only as its card says. Checked by the route before a tap claims
 * it (routes/proposals.ts), and again by the object's alarm as it runs it
 * (Proposals.tick, state.ts).
 */

/** What only an approval runs: never offered to the router, nor to a job (the router may approve a card, as its person says, never make its call). */
export const APPROVED_ONLY = [mailDraftSend, calendarRsvp, mailArchiveMany, mailInboxMany, routineMake, houseDo, specialtyKeep, ...PUBLISHING];

/**
 * What a tap's person, and whoever taps, must still have for a call that
 * carries none of it (an approval's grants never hold `workshop`, lib/proposals.ts
 * runGrants): a card outlives the role it was filed under.
 */
const NEEDS: ReadonlyMap<string, Grant> = new Map<string, Grant>([[sitePublishTool.name, "workshop"], [sitePutBack.name, "workshop"], [repoPull.name, WILDCARD]]);
/** Whether any of them no longer has it. */
export function lacks(tool: string, ...have: (readonly Grant[] | null | undefined)[]): boolean {
  const need = NEEDS.get(tool);
  return !!need && have.some((g) => !covers(g ?? [], [need]));
}
export const LACKS = "That is not yours to do any more, so nothing was done.";

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
  const [undo, args] =
    p.action.tool === mailArchiveMany.name ? [mailInboxMany, { ids: p.action.args.ids, total: p.action.args.total }]
      : p.action.tool === sitePublishTool.name ? [sitePutBack, { name: p.action.args.name, sha256: p.action.args.sha256 }]
        : [null, {}];
  const weighed = undo && weigh(undo, args, env);
  return weighed ? { action: { tool: undo.name, args }, weighed } : null;
}

/** Those whose card offers Put back (src/app/proposal.ts). */
export const UNDONE: ReadonlySet<string> = new Set([mailArchiveMany.name, sitePublishTool.name]);

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
