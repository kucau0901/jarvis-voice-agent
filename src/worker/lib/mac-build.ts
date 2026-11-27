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
 * routes/jobs.ts poll) and waits. The tap starts a session (macBuildStart,
 * lib/approval.ts), which the Jarvis desktop app runs in Claude Code's
 * sandbox, in a folder of its own that stays on the Mac. Claude Code works in
 * rounds: each time it stops, what it said comes back to the job, which
 * answers it (mac_reply) inside the same session and fence, asking its person
 * first what only they can decide; until it brings the files back
 * (mac_finish, routes/computer.ts). Then the job files the usual Publish or
 * pull-request card, or gives the files: nothing is live until that is tapped.
 */

export const MAC_BUILD = "mac_build";
export const MAC_REPLY = "mac_reply";
export const MAC_FINISH = "mac_finish";
export const MAC_TOOLS: ReadonlySet<string> = new Set([MAC_BUILD, MAC_REPLY, MAC_FINISH]);
/** Rounds a session may have: no time of Jarvis's own bounds it, only its person's Claude plan, so this keeps it from going round for ever. */
export const MAX_ROUNDS = 50;
/** A Mac that says nothing for this long while it works has stopped answering: it says it still works every ten minutes. */
export const SILENT_MS = 30 * 60_000;
/** How long its card waits for a tap and then to be run (lib/proposals.ts DECIDE_MS, START_MS): the job waits as long. */
const CARD_MS = 24 * 3_600_000 + 20 * 60_000;
const SLACK_MS = 5 * 60_000;
/** A Mac that waits for the Claude plan's limit to reset says until when: no further ahead than this is believed. */
const MAX_PAUSE_MS = 25 * 3_600_000;
export const MAX_NOTES = 3_500;
export const MAX_REPLY = 4_000;
/** As much of what Claude Code said at the end of a round as the job is given. */
export const MAX_SAID = 6_000;
/** A second hand-off after one that came to nothing, never a third. */
export const MAX_HANDOFFS = 2;
/** The most one of its files may be: the workshop's (docker/workshop runner.mjs MAX_FILE). */
export const MAX_FILE = 20_000_000;
/** Where its files are put in the job's folder. */
export const FROM_MAC = "from-mac";
/** Where its folder is on the Mac (the Jarvis desktop app's rules.ts BUILD_ROOT). */
export const BUILDS_ON_MAC = "/Users/Shared/JarvisBuilds";

const CLAUDE_SAID = "CLAUDE CODE ON THEIR MAC, FROM WHAT IT WAS GIVEN";
const JOB = /^j[a-z0-9]{4,32}$/;
const SUM = /^[0-9a-f]{64}$/;
/** A folder's name: the same on the Mac (rules.ts readBuild). */
export const FOLDER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** How a round ended, as the Mac says: Claude Code stopped by itself; failed; said nothing for too long; met the plan's limit for a day; the Mac was busy with another. */
export type RoundEnd = "turn" | "error" | "stuck" | "limit" | "busy";
const ENDS: ReadonlySet<string> = new Set<RoundEnd>(["turn", "error", "stuck", "limit", "busy"]);
export const isRoundEnd = (v: unknown): v is RoundEnd => typeof v === "string" && ENDS.has(v);

/**
 * A job's hand-off to its Mac, and where it stands:
 * - "card": its card waits for a tap;
 * - "round": Claude Code works on round `round`;
 * - "finish": the Mac brings back what it made;
 * - "turn": a round is over, and the job answers it;
 * - "over": the session is over (`end`).
 * Only the first three are waits; while one lasts, `call` is the job's call that waits on it.
 */
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
  /** Its folder on the Mac, and Claude Code's session there: the same in every round. */
  folder: string;
  session: string;
  phase: "card" | "round" | "finish" | "turn" | "over";
  /** Rounds begun. */
  round: number;
  /** When this wait began, and when the Mac last spoke in it; paused for the Claude plan until about then. */
  since: number;
  heard?: number;
  until?: number;
  /** Started by the tap: the build's id, the Mac it went to, when. */
  sent?: { id: string; who: string; at: number };
  /** A round over: what Claude Code said, and how it ended. */
  said?: { text: string; how: RoundEnd };
  /** The session over: with `files`, what came back to the job's folder, what stayed on the Mac and why, and where; else `why`, Jarvis's words. */
  end?: { at: number; why?: string; files?: string[]; left?: { name: string; why: string }[]; path?: string };
}

/** Whether their words ask for Claude Code: only then is a build job's coding handed to it (tools/jobs.ts). */
export const namesClaudeCode = (words: string): boolean => /\bclaude[\s-]*code\b/i.test(words);

/** Whether the job waits on its Mac now. */
export const macWaits = (w: MacWait): boolean => w.phase === "card" || w.phase === "round" || w.phase === "finish";
/** Whether a session was begun on the Mac and is not over: what Jarvis stops there when the job ends. */
export const macOpen = (w: MacWait): boolean => !!w.sent && w.phase !== "over" && w.phase !== "card";

/** When a job waiting on its Mac stops waiting, whatever has come back: a day for the tap; then half an hour from the Mac's last word, or from when it said its plan resets. */
export function macUntil(w: MacWait): number {
  if (w.phase === "card") return w.since + CARD_MS + SLACK_MS;
  const last = w.heard ?? w.since;
  const paused = w.until ? Math.min(w.until, last + MAX_PAUSE_MS) : 0;
  return Math.max(last, paused) + SILENT_MS;
}

/** A build's id: its job's, so the Mac's answer finds the job, and a part nobody can guess. */
export const buildIdOf = (job: string): string => `${job}.${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
export function jobOfBuild(id: string): string | null {
  const m = /^(j[a-z0-9]{4,32})\.[0-9a-f]{16}$/.exec(id);
  return m ? m[1]! : null;
}

/** A name as a folder's: plain letters and digits, joined by dashes. */
function slug(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
}
const tail = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6) || "x";

/** Its folder on the Mac: its project's, which a later job of that project goes on in; else its own. */
export function folderOf(job: Pick<Job, "id" | "title" | "project">): string {
  return job.project ? `${slug(job.project.name) || "project"}-${tail(job.project.id)}` : `${slug(job.title) || "build"}-${tail(job.id)}`;
}

const strict = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
/** Answered by routes/jobs.ts poll, once what it waits on is over; never run as the others are. */
const answeredLater = async () => "Answered once the Mac has done it.";

/** What the job calls to hand its coding over. */
export function macBuildTool(): Tool {
  return {
    name: MAC_BUILD,
    pace: "fast",
    description:
      "Hand the coding to Claude Code on the user's Mac, as they asked, once your research is done: instead of writing it " +
      "yourself. It puts a card to them with what they asked and your notes, and nothing runs until they tap it. Claude Code then " +
      "works on it there, in rounds: each time it stops, you are told what it said, and answer it with mac_reply. Alone, not beside other calls.",
    parameters: strict({
      notes: { type: "string", description: `All it needs of what you found, ${MAX_NOTES.toLocaleString("en-US")} characters at most: facts, wording, sections, colours, what it should do. Given as reference, not instructions.` },
    }),
    run: answeredLater,
  };
}

/** The job's answer to Claude Code, at the end of a round: it goes on in the same session. */
export function macReplyTool(): Tool {
  return {
    name: MAC_REPLY,
    pace: "fast",
    description:
      "Answer Claude Code on the user's Mac, once a round is over, and let it go on: what it asked, from what the user asked and what " +
      "you found (what only the user can decide, ask them first with ask_person); what to fix; or to carry on. Not for when it is " +
      `done: then mac_finish. At most ${MAX_ROUNDS} rounds. Alone, not beside other calls.`,
    parameters: strict({ text: { type: "string", description: `What to tell it, ${MAX_REPLY.toLocaleString("en-US")} characters at most.` } }),
    run: answeredLater,
  };
}

/** The job's end of the session: what Claude Code made comes back to its folder. */
export function macFinishTool(): Tool {
  return {
    name: MAC_FINISH,
    pace: "fast",
    description:
      `Once Claude Code says it is done and has checked it, bring what it made to your folder, under ${FROM_MAC}/: what the user ` +
      "installs (its out folder), the site, and the source. The project stays on their Mac. Alone, not beside other calls.",
    parameters: strict({}),
    run: answeredLater,
  };
}

/** The card's words beside its call: what they asked, the notes, and what the build can do. Written by code. */
export function macCardBody(task: string, notes: string, mac: string, folder: string, repo: string | null): string {
  return [
    `What you asked:\n${task}`,
    `What the job found, given to Claude Code as reference, not instructions:\n${notes}`,
    `Claude Code builds it on ${mac}, in the folder ${folder} in ${BUILDS_ON_MAC}, which stays on the Mac: it goes on from what is ` +
      `there. Jarvis answers it as it works, up to ${MAX_ROUNDS} rounds, and asks you what only you can decide; no time limit but ` +
      "your Claude plan's. It writes only in that folder, reads nothing else of your home folder but the Android SDK, and reaches only " +
      "the package registries (npm, GitHub, Maven, Gradle, crates.io, PyPI), with no web." +
      (repo ? ` It starts from the files of ${repo}: a package it installs could send them elsewhere.` : ""),
    "What it makes comes back to the job: a website to a Publish card, a change to a repository to a pull request card, anything " +
      "else as files in Jobs. Nothing is published until you approve that card too.",
  ].join("\n\n");
}

/** The call a tap makes (lib/approval.ts): the session started on that Mac, for the job that waits on it. */
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
    return `Claude Code is building it on ${str(args.name)}; the job answers it as it goes.`;
  },
};

/**
 * The job's mac_build call: its card filed, and what it waits on; or why not,
 * which answers the call. `mac`: the one of its person's it goes to. `base`:
 * on a repository, the commit its files were brought at (lib/build-tools.ts
 * repo_bring), which Claude Code starts from; none yet, none is filed.
 */
export async function handOff(
  env: Env,
  job: Pick<Job, "id" | "title" | "task" | "createdBy" | "macs" | "repo" | "project">,
  call: { call_id: string; arguments: string },
  mac: { id: string; name: string },
  base: string | null,
  now: number,
): Promise<MacWait | string> {
  if ((job.macs ?? 0) >= MAX_HANDOFFS) return "Not put to them: Claude Code has been asked twice in this job. Finish with what you have, saying so.";
  if (job.repo && !base) return `Not put to them: bring the files of ${job.repo} first with repo_bring, so Claude Code starts from them.`;
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
  const folder = folderOf(job);
  const p = await state.proposalAdd(
    { who: job.createdBy, person: personOfWho(job.createdBy), from: { kind: "job", id: job.id, title: job.title }, action: { tool: macBuildStart.name, args }, weighed, body: macCardBody(job.task, notes, mac.name, folder, job.repo ?? null), grants: ["ask"] },
    now,
  );
  if (typeof p === "string" || p.state !== "pending") return filed(p);
  return { call: call.call_id, notes, sum, mac: mac.id, name: mac.name, card: p.id, says: p.says, folder, session: crypto.randomUUID(), phase: "card", round: 0, since: now };
}

/** What a round's end means, in Jarvis's words. */
const ENDED: Record<Exclude<RoundEnd, "turn">, string> = {
  error: "Claude Code stopped with an error",
  stuck: "Claude Code said nothing for half an hour, and was stopped",
  limit: "the user's Claude plan reached its limit, and did not reset within a day",
  busy: "the Mac was busy with another build",
};

/** What the job does with what came back: by what it is. */
function routing(repo: boolean): string {
  return (
    `A website: unzip ${FROM_MAC}/site.zip, check it as you would your own, and file it with publish_site. ` +
    (repo
      ? `This job's repository: compare ${FROM_MAC}/source.zip with the files repo_bring gave, zip the changed files alone, and put them with propose_pull. `
      : "") +
    `Anything else: give the user each file of ${FROM_MAC}/out, and ${FROM_MAC}/source.zip, with give_file.`
  );
}

/** The answer to the job's call, once what it waited on is over: what Claude Code said, quoted; its files; or why there are none. */
export function macReport(w: MacWait, repo: boolean): string {
  const said = w.said ? asQuotedData("claude_code", w.said.text.slice(0, MAX_SAID), CLAUDE_SAID) : "";
  const where = `${BUILDS_ON_MAC}/${w.folder}`;
  if (w.phase === "turn" && w.said?.how === "turn") {
    return (
      `Claude Code on ${w.name} ended round ${w.round} of at most ${MAX_ROUNDS}. What it said:\n${said}\n` +
      "Answer it with mac_reply: what it asks, from what the user asked and what you found; what only the user can decide, ask them " +
      "with ask_person first and pass on their answer. If something failed, tell it what to fix. Once it says DONE and has checked " +
      "it, and you are satisfied, call mac_finish to bring its files."
    );
  }
  if (w.phase === "turn" && w.said) {
    return (
      `Round ${w.round} on ${w.name} ended without finishing: ${ENDED[w.said.how as Exclude<RoundEnd, "turn">]}.${said ? ` What it said:\n${said}` : ""}\n` +
      "You may answer it with mac_reply, and it goes on where it was, or bring what there is with mac_finish."
    );
  }
  const end = w.end;
  if (end?.files) {
    const left = (end.left ?? []).map((l) => `${l.name} (${tidy(l.why)})`).join("; ");
    return (
      `Claude Code's work came back from ${w.name}. In your folder: ${end.files.map((f) => `${FROM_MAC}/${f}`).join(", ") || "nothing"}.` +
      `${left ? ` Left on the Mac: ${left}.` : ""} The project stays on the Mac in ${end.path ?? where}: say so in your answer.\n${routing(repo)}`
    );
  }
  return (
    `It was not built: ${tidy(end?.why ?? "the session ended")}.${said ? `\nWhat Claude Code said last:\n${said}` : ""}\n` +
    `Do not write it yourself unless the user tells you to: finish, saying what happened${w.sent ? `, and that what there is stays on the Mac in ${where}` : ""}.`
  );
}
