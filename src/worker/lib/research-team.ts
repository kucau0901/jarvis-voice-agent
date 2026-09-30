import { asQuotedData } from "./quote.ts";
import { TEAMS, sharesLeft, withSources, type Job, type TeamAngle, type TeamRun } from "./jobs.ts";
import type { Tool } from "../tools/registry.ts";

/**
 * Research as a team (lib/jobs.ts): what the teams, the merge and the Jobs
 * panel are shown. The state machine is in lib/jobs.ts; the calls to OpenAI
 * in routes/jobs.ts.
 *
 * Everything the teams found was read on strangers' pages, so it goes back to
 * a model only inside asQuotedData, in a tool's output or a user message,
 * never a developer message. The angles come from the user's own brief,
 * planned by a call that cannot search, and reach each team as a user message.
 */

/**
 * How a team tells the others what it found, and hears what they did. Offered
 * to the teams' chains alone: never in ALL or READ_TOOLS. A web search runs
 * inside one response, so this call is the moment a team comes back to the
 * Durable Object while it works.
 */
export const SHARE = {
  name: "share_findings",
  description:
    "Tell the other research teams something you have found, and hear what they have found since you last asked. " +
    "For a key fact or figure, a source that settles a question, or a dead end not worth repeating.",
  parameters: {
    type: "object",
    properties: {
      findings: {
        type: "string",
        description: "One to three sentences: what you found, with figures, dates and the site it came from; or what turned out to be a dead end.",
      },
    },
    required: ["findings"],
    additionalProperties: false,
  },
};

const CAPPED = "You have shared as often as a team may: this was not passed on. Keep to your angle, and write your report when you are ready.";

/** The share tool for one hop: what it is told goes into `into`; the first call hears `reply`, a later one whether it fitted the `room` the team had left. */
export function shareTool(reply: string, into: string[], room: number): Tool {
  let told = false;
  return {
    ...SHARE,
    pace: "fast",
    async run(args) {
      if (typeof args.findings === "string") into.push(args.findings);
      if (!told) {
        told = true;
        return reply;
      }
      return into.length > room ? CAPPED : "Posted for the other teams.";
    },
  };
}

const nameOf = (team: TeamRun, i: number) => team.angles?.[i]?.name ?? "";
const lines = (team: TeamRun, board: TeamRun["board"]) => board.map((b) => `Team ${b.team + 1} (${nameOf(team, b.team)}): ${b.text}`).join("\n");

/** What team `t` hears when it shares: whether it was posted, and what the others shared since it last asked, never its own. */
export function shareReply(j: Job, t: number): string {
  const team = j.team!;
  const head = sharesLeft(j, t) <= 0 ? CAPPED : "Posted for the other teams.";
  const news = team.board.slice(team.chains[t]?.seen ?? 0).filter((b) => b.team !== t);
  if (!news.length) return `${head} Nothing new from the other teams yet.`;
  return `${head} New from the other teams since you last asked:\n\n${asQuotedData("shared", lines(team, news), "THE OTHER RESEARCH TEAMS, FROM WHAT THEY READ ON THE WEB")}`;
}

/** What the merge is given, as a user message: each team's report with its pages, or why it has none, and the board. */
export function mergeMaterial(j: Job): string {
  const team = j.team!;
  const parts = ["The research teams' work on this brief:"];
  team.chains.forEach((c, i) => {
    const who = `Team ${i + 1} (${nameOf(team, i)})`;
    const shared = team.board.some((b) => b.team === i);
    parts.push(
      c.state === "reported" && c.report
        ? `${who}:\n${asQuotedData(`team${i + 1}`, withSources(c.report, c.cited ?? []), `RESEARCH TEAM ${i + 1}, FROM WHAT IT READ ON THE WEB`)}`
        : `${who} did not finish (${c.why ?? "it was stopped"})${shared ? "; what it shared is below" : " and shared nothing"}.`,
    );
  });
  if (team.board.length) {
    parts.push(`What the teams shared as they went:\n${asQuotedData("shared", lines(team, team.board), "THE RESEARCH TEAMS, FROM WHAT THEY READ ON THE WEB")}`);
  }
  return parts.join("\n\n");
}

/** A team's angle, as the user message that starts its chain. */
export const angleMessage = (angle: TeamAngle): string => `Your angle: ${angle.name}. ${angle.brief}`;

/** What the Jobs panel is told of a research team: how many reported and, while it runs, which part it is in. */
export function teamView(j: Job): { of: number; reported: number; phase?: "planning" | "teams" | "merging" | "checking" } {
  const team = j.team!;
  const view = { of: TEAMS, reported: team.chains.filter((c) => c.state === "reported").length };
  if (j.status !== "running") return view;
  const phase = !team.angles ? "planning" : team.chains.some((c) => c.state === "working") ? "teams" : j.draft ? "checking" : "merging";
  return { ...view, phase };
}
