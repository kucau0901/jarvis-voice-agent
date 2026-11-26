import type { Tool, ToolContext } from "./registry.ts";
import { nearest } from "./args.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER, maySteer } from "../lib/context.ts";
import { wordsOf } from "../lib/jobs.ts";
import { asksSaid, openQuestions } from "../lib/job-tools.ts";
import { UNDO_MS, type Proposal } from "../lib/proposals.ts";
import { LACKS, UNDONE, lacks, notAsShown } from "../lib/approval.ts";
import { sha256Hex } from "../lib/devices.ts";
import { personView } from "../lib/hub-client.ts";
import { whenSaid } from "../lib/later.ts";
import { localeOf } from "../lib/locale.ts";
import { asQuotedData, ownPart } from "../lib/quote.ts";

/**
 * What waits for the person, as the Inbox has it (routes/proposals.ts), by chat
 * or voice: their jobs' questions, the cards waiting for their OK, what will be
 * put to them later, and what can still be put back. A card is read whole here,
 * declined (Not now) or put back in their own words. Only its person's, never a
 * device's: everything under /api/hub/ is a person's.
 *
 * One that can be undone may be approved in words too: read to them whole
 * first, and only by what they say after, in their own words, with the tap's
 * checks; the model can put nothing in their mouth (ownPart). One that cannot be
 * undone (a mail sent, a pull request, the house) needs the tap.
 */

/** How many of each are listed at once: the rest wait in the Inbox. */
const LISTED = 8;
/** How long an answer waits for what came of the call the alarm makes. */
const WAIT_MS = 15_000;
const QUOTED = "JARVIS'S CODE, QUOTING WHAT A JOB, A BRIEF OR A SUGGESTION PUT TO THEM";

const words = (v: unknown): string[] => wordsOf(typeof v === "string" ? v : "");
const left = (p: Proposal, now: number): string => {
  const h = Math.max(0, Math.round((p.expires - now) / 3_600_000));
  return h < 1 ? "under an hour left" : `${h} hour${h === 1 ? "" : "s"} left`;
};
/** One that can still be put back: done by their OK, of a kind that can, within the week. */
const backable = (p: Proposal, now: number): boolean => p.state === "done" && p.by === "tap" && UNDONE.has(p.action.tool) && !p.undone && now - (p.decidedAt ?? p.createdAt) < UNDO_MS;
/** A card as its screen shows it, whole: what it does, and all it would send or change. */
const whole = (p: Proposal): string => `${p.says}${p.body ? `\n\n${p.body}` : ""}`;

/** The one their words name, or why not. */
function oneOf(all: readonly Proposal[], named: unknown, what: string): Proposal | string {
  if (!all.length) return `Nothing ${what}.`;
  const fits = nearest(all, words(named), (p) => `${p.says} ${p.from.title}`, true);
  if (!fits.length) return `None ${what} fits that. ${asQuotedData("cards", all.map((p) => p.says).join("\n"), QUOTED)}`;
  return fits.length > 1 ? `More than one ${what} fits; ask which:\n${asQuotedData("cards", fits.map((p) => p.says).join("\n"), QUOTED)}` : fits[0]!;
}

/** What came of a call the object's alarm makes once claimed, waited for a little. */
async function cameOf(ctx: ToolContext, me: string, id: string): Promise<Proposal | null> {
  const state = stateStub(ctx.env)!;
  for (let waited = 0; waited < WAIT_MS; waited += 1_000) {
    await new Promise((r) => setTimeout(r, 1_000));
    const p = await state.proposalGet(me, id, Date.now());
    if (!p || p.state !== "running") return p;
  }
  return null;
}

export const inbox: Tool = {
  name: "inbox",
  pace: "fast",
  description:
    "What waits for the user: their jobs' questions, cards waiting for their OK, what will be asked later, what can be put back. " +
    "'list'; 'read' one card whole; 'approve' one that can be undone, when they say to (it is read to them first, and their next yes approves it); " +
    "'not_now' declines one; 'put_back' undoes one done. Never for them: only their own words.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["list", "read", "approve", "not_now", "put_back"] },
      card: { type: ["string", "null"], description: "Words of the card, e.g. 'bake sale site'; null to list, or for the only one." },
    },
    required: ["op", "card"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "This deployment has no state object, so nothing can wait for them.";
    if (ctx.env.JARVIS_DEVICE) return "What waits for a person's OK is theirs to see, signed in, not a device's.";
    const me = ctx.env.JARVIS_PERSON || OWNER;
    const now = Date.now();
    const all = await state.proposalsOf(me, now);
    const pending = all.filter((p) => p.state === "pending");
    const mine = ownPart(ctx.asked ?? "");
    if (args.op === "read" || args.op === "approve") {
      const p = oneOf(pending, args.card, "waits for their OK");
      if (typeof p === "string") return p;
      const card = asQuotedData("approval card", whole(p), QUOTED);
      if (p.risk === "irreversible") return `${card}\nIt cannot be undone, so only their tap on the card approves it, in Chat or the Inbox. ${left(p, now)}. ${args.op === "approve" ? "Not approved: say so." : "Read it to them as it is."}`;
      // Heard whole first, and approved only by what they say after: never in the breath that asked to hear it.
      const asked = await sha256Hex(mine);
      if (args.op === "read" || !mine || !(await state.proposalWasHeard(me, p.id, asked, now))) {
        if (mine) await state.proposalHeard(me, p.id, asked, now);
        return `${card}\nIt can be undone. ${left(p, now)}. ${args.op === "approve" ? "Not approved yet: read" : "Read"} it to them as it is${mine ? `, then ask whether to ${(p.verb ?? "approve").toLowerCase()} it: their yes, in their next message, approves it` : ""}.`;
      }
      // As a tap's: who it is for, and whoever approves, must still have what it needs, and it must run as its card says.
      const view = await personView(ctx.env, me);
      if (view.scopes === undefined) return "Who it is for could not be checked just now: ask again in a moment.";
      if (lacks(p.action.tool, view.scopes, ctx.grants)) return LACKS;
      const unlike = notAsShown(ctx.env, p);
      if (unlike) return `Not approved: ${unlike}`;
      const claimed = await state.proposalApprove(me, p.id, view.scopes, ctx.grants, now);
      if (typeof claimed === "string") return `Not approved: ${claimed}`;
      const came = await cameOf(ctx, me, p.id);
      return came?.outcome ? `${came.outcome.ok ? "Done" : "It did not work"}: ${came.outcome.text}` : "Approved: it is being done now, and the card in the Inbox will say what came of it.";
    }
    if (args.op === "not_now" || args.op === "put_back") {
      if (!mine) return "Not done: only the user can answer a card, in their own words.";
      if (args.op === "not_now") {
        const p = oneOf(pending, args.card, "waits for their OK");
        if (typeof p === "string") return p;
        const r = await state.proposalDecline(me, p.id, now);
        if (typeof r === "string") return `Not done: ${r}`;
        return `Declined${p.about ? ": it is not suggested again for 30 days" : ""}.`;
      }
      const p = oneOf(all.filter((x) => backable(x, now)), args.card, "can be put back");
      if (typeof p === "string") return p;
      // As a tap's Put back: who it is for, and whoever asks, must still have what it needs.
      const view = await personView(ctx.env, me);
      if (view.scopes === undefined) return "Who it is for could not be checked just now: ask again in a moment.";
      if (lacks(p.action.tool, view.scopes, ctx.grants)) return LACKS;
      const back = await state.proposalUndo(me, p.id, view.scopes, ctx.grants, now);
      if (typeof back === "string") return `Not put back: ${back}`;
      const came = await cameOf(ctx, me, back.id);
      return came?.outcome ? `${came.outcome.ok ? "Put back" : "Putting it back did not work"}: ${came.outcome.text}` : "Being put back now; the card in the Inbox will say what came of it.";
    }
    // What waits, as the Inbox lists it.
    const tz = localeOf(ctx.env).timeZone;
    const asking = (await state.jobsAsking(me)).filter((j) => maySteer(j, ctx.env, ctx.grants)).flatMap((j) => openQuestions(j.asked).map((q) => `${j.title}: ${asksSaid([q])}`));
    const later = await state.proposalsLater(me);
    const back = all.filter((p) => backable(p, now));
    const running = all.filter((p) => p.state === "running");
    const parts = [
      asking.length ? `Their jobs ask (their reply goes to the job with job_control):\n${asQuotedData("job questions", asking.slice(0, LISTED).join("\n"), "A BACKGROUND JOB, FROM WHAT IT READ")}` : "",
      pending.length
        ? `Waiting for their OK (a tap on the card in Chat or the Inbox):\n${asQuotedData("cards", pending.slice(0, LISTED).map((p) => `${p.says} (${p.risk === "irreversible" ? "cannot be undone" : "can be undone"}; ${left(p, now)}${p.body ? "; has more to read" : ""})`).join("\n"), QUOTED)}`
        : "",
      running.length ? `Being done now: ${running.length}.` : "",
      later.length ? `To be asked later:\n${asQuotedData("later", later.slice(0, LISTED).map((s) => `${whenSaid(s.release, tz)}: ${s.says}`).join("\n"), QUOTED)}` : "",
      back.length ? `Can still be put back:\n${asQuotedData("done", back.slice(0, LISTED).map((p) => p.says).join("\n"), QUOTED)}` : "",
    ].filter(Boolean);
    const more = Math.max(0, asking.length - LISTED) + Math.max(0, pending.length - LISTED) + Math.max(0, later.length - LISTED) + Math.max(0, back.length - LISTED);
    return parts.length ? `${parts.join("\n\n")}${more ? `\n\n${more} more in the Inbox.` : ""}` : "Nothing waits for them: no job asks anything, and no card waits for their OK.";
  },
};
