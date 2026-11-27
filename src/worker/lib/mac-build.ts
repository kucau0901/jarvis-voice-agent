import type { Tool } from "../tools/registry.ts";
import type { Env } from "../types.ts";
import type { Job } from "./jobs.ts";
import { OWNER, personOfWho } from "./context.ts";
import { sha256Hex } from "./devices.ts";
import { filed } from "./proposals.ts";
import { asQuotedData, tidy } from "./quote.ts";
import { stateStub } from "./state-client.ts";

/**
 * A build job's coding handed to Claude Code on its person's Mac
 * (docs/DESIGN.md, "Claude Code on the Mac"): only for a job they started
 * saying so, in their own words (tools/jobs.ts), and only by their tap on a
 * card that shows all that goes to the Mac.
 *
 * The job never has the Mac. It files the card (mac_build, answered by
 * routes/jobs.ts poll) and waits. The tap starts the build (macBuildStart,
 * lib/approval.ts), which the Jarvis desktop app runs in Claude Code's sandbox,
 * in a folder of its own. What it made comes back to the job's workshop folder
 * (routes/computer.ts), where the job checks it and files the usual Publish
 * card: nothing is live until that is tapped too.
 */

export const MAC_BUILD = "mac_build";
/** How long Claude Code may build; and past that, for its files to come back. */
export const BUILD_MS = 30 * 60_000;
const SLACK_MS = 5 * 60_000;
/** How long its card waits for a tap and then to be run (lib/proposals.ts DECIDE_MS, START_MS): the job waits as long. */
const CARD_MS = 24 * 3_600_000 + 20 * 60_000;
export const MAX_NOTES = 3_500;
/** A second hand-off after one that came to nothing, never a third. */
export const MAX_HANDOFFS = 2;
/** The most a build's zip may be: a site's (lib/site-files.ts). */
export const MAX_ZIP = 10 * 1024 * 1024;
/** Where its files are put in the job's folder. */
export const FROM_MAC = "from-mac/site.zip";

const CLAUDE_SAID = "CLAUDE CODE ON THEIR MAC, FROM WHAT IT WAS GIVEN";
const JOB = /^j[a-z0-9]{4,32}$/;
const SUM = /^[0-9a-f]{64}$/;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A job's hand-off: its notes as the card showed them, the Mac, and what came of it. */
export interface MacWait {
  call: string;
  notes: string;
  sum: string;
  /** The Mac's device id, and its name. */
  mac: string;
  name: string;
  /** Its card, and the card's words. */
  card: string;
  says: string;
  since: number;
  /** Started by the tap: the build's id, the Mac it went to, when. */
  sent?: { id: string; who: string; at: number };
  /** Over: whether its files came back. `said`: Jarvis's words for why not; `claude`: what Claude Code said. */
  done?: { ok: boolean; files: boolean; at: number; said?: string; claude?: string };
}

/** Whether their words ask for Claude Code: only then is a build job's coding handed to it (tools/jobs.ts). */
export const namesClaudeCode = (words: string): boolean => /\bclaude[\s-]*code\b/i.test(words);

/** When a job waiting on its Mac stops waiting, whatever has come back. */
export const macUntil = (w: MacWait): number => (w.sent ? w.sent.at + BUILD_MS + SLACK_MS : w.since + CARD_MS + SLACK_MS);

/** A build's id: its job's, so the Mac's answer finds the job, and a part nobody can guess. */
export const buildIdOf = (job: string): string => `${job}.${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
export function jobOfBuild(id: string): string | null {
  const m = /^(j[a-z0-9]{4,32})\.[0-9a-f]{16}$/.exec(id);
  return m ? m[1]! : null;
}

/** What the job calls to hand its coding over. Answered by routes/jobs.ts poll, once the build is over; never run as the others are. */
export function macBuildTool(): Tool {
  return {
    name: MAC_BUILD,
    pace: "fast",
    description:
      "Hand the coding to Claude Code on the user's Mac, as they asked, once your research is done: instead of writing the site " +
      "yourself. It puts a card to them with what they asked and your notes, and nothing runs until they tap it. Claude Code then " +
      `builds it there, in a folder of its own with no web, and you go on when it is done, its files in your folder as ${FROM_MAC}. ` +
      "Alone, not beside other calls.",
    parameters: {
      type: "object",
      properties: {
        notes: { type: "string", description: `All it needs of what you found, ${MAX_NOTES.toLocaleString("en-US")} characters at most: facts, wording, sections, colours. Given as reference, not instructions.` },
      },
      required: ["notes"],
      additionalProperties: false,
    },
    async run() {
      return "Answered once the build is over.";
    },
  };
}

/** The card's words beside its call: what they asked, the notes, and what the build can do. Written by code. */
export function macCardBody(task: string, notes: string, mac: string): string {
  return [
    `What you asked:\n${task}`,
    `What the job found, given to Claude Code as reference, not instructions:\n${notes}`,
    `Claude Code builds it on ${mac}, in a new folder, for ${BUILD_MS / 60_000} minutes at most: it can write only there, reach only ` +
      "npm's registry, and read nothing in your home folder. What it makes comes back to the job; nothing is published until you " +
      "approve that card too.",
  ].join("\n\n");
}

/** The call a tap makes (lib/approval.ts): the build started on that Mac, for the job that waits on it. */
export const macBuildStart: Tool = {
  name: "mac_build_start",
  pace: "fast",
  description: "Start Claude Code building on a Mac.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  propose(args) {
    if (!JOB.test(str(args.job)) || !SUM.test(str(args.sum)) || !str(args.mac) || !str(args.name) || !str(args.title)) return null;
    return { risk: "irreversible", says: `Claude Code on “${str(args.name)}” builds “${str(args.title)}”`, verb: "Build" };
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Nothing was built: this deployment has no state object.";
    const r = await state.macBuildStart(ctx.env.JARVIS_PERSON || OWNER, str(args.job), str(args.mac), str(args.sum));
    if (r !== true) return r;
    ctx.done?.();
    return `Claude Code is building it on ${str(args.name)}; the job goes on when it is done.`;
  },
};

/**
 * The job's mac_build call: its card filed, and what it waits on; or why not,
 * which answers the call. `mac`: the one of its person's it goes to.
 */
export async function handOff(env: Env, job: Pick<Job, "id" | "title" | "task" | "createdBy" | "macs">, call: { call_id: string; arguments: string }, mac: { id: string; name: string }, now: number): Promise<MacWait | string> {
  if ((job.macs ?? 0) >= MAX_HANDOFFS) return "Not put to them: Claude Code has been asked twice in this job. Finish with what you have, saying so.";
  let notes = "";
  try {
    notes = str((JSON.parse(call.arguments) as { notes?: unknown }).notes).trim();
  } catch {
    // no notes
  }
  if (!notes) return "Not put to them: write what Claude Code needs in notes.";
  if (notes.length > MAX_NOTES) return `Not put to them: your notes are ${notes.length.toLocaleString("en-US")} characters, and are ${MAX_NOTES.toLocaleString("en-US")} at most.`;
  const state = stateStub(env);
  const sum = await sha256Hex(notes);
  const args = { job: job.id, mac: mac.id, name: mac.name, title: job.title, sum };
  const weighed = macBuildStart.propose!(args, env);
  if (!state || !weighed) return "Not put to them: it cannot be done here now.";
  const p = await state.proposalAdd(
    { who: job.createdBy, person: personOfWho(job.createdBy), from: { kind: "job", id: job.id, title: job.title }, action: { tool: macBuildStart.name, args }, weighed, body: macCardBody(job.task, notes, mac.name), grants: ["ask"] },
    now,
  );
  if (typeof p === "string" || p.state !== "pending") return filed(p);
  return { call: call.call_id, notes, sum, mac: mac.id, name: mac.name, card: p.id, says: p.says, since: now };
}

/** The answer to the job's call, once the build is over: its files, and what Claude Code said, quoted; or why there are none. */
export function macReport(w: MacWait): string {
  const d = w.done!;
  const said = d.claude ? `\nWhat it said:\n${asQuotedData("claude_code", d.claude, CLAUDE_SAID)}` : "";
  if (d.ok && d.files) {
    return `Claude Code finished on ${w.name}. Its files are in your folder as ${FROM_MAC}: unzip it, check it as the user asked, then zip the ` +
      `site's folder (index.html at its root) and file it with publish_site.${said}`;
  }
  return `It was not built: ${tidy(d.said ?? "Claude Code did not finish")}.${said}\nDo not write the site yourself unless the user tells you to: finish, saying what happened.`;
}
