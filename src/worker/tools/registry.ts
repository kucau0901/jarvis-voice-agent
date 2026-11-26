import { houseWatch } from "./house.ts";
import type { Env } from "../types.ts";
import type { DraftCard } from "../lib/mail-draft.ts";
import type { Weighed } from "../lib/proposals.ts";
import type { MemoryStore } from "../lib/memory.ts";
import type { Procedure } from "../lib/specialties.ts";
import { allows, type Grant, type Scope } from "../lib/scopes.ts";
import * as hermes from "./hermes.ts";
import { memoryTools } from "./memory.ts";
import { lookBackTool } from "./conversation.ts";
import { specialtyTools } from "./specialties.ts";
import { tessieTools } from "./tessie.ts";
import { directionsTools } from "./directions.ts";
import { placeTools } from "./place.ts";
import { placesTools } from "./places.ts";
import { cameraTools } from "./camera.ts";
import { makeImage } from "./image.ts";
import { makePage } from "./page.ts";
import { spotifyTools } from "./spotify.ts";
import { gmailTools } from "./gmail.ts";
import { calendarTools } from "./calendar.ts";
import { sendNote } from "./notes.ts";
import { alertTalk } from "./alerts.ts";
import { openOnGlasses } from "./glasses.ts";
import { timeIn } from "./clock.ts";
import { routineTools } from "./routines.ts";
import { jobTools } from "./jobs.ts";
import { familyTools } from "./family.ts";
import { passTool } from "./pass.ts";
import { panelTools } from "./panels.ts";
import { skillTools } from "./skills.ts";
import { browserTools } from "./browser.ts";
import { siteControl } from "./sites.ts";
import { projectControl } from "./projects.ts";
import { trueNow } from "./true-now.ts";
import { inbox } from "./inbox.ts";
import { ownPart } from "../lib/quote.ts";
import { stateStub } from "../lib/state-client.ts";
import { isTheirs, OWNER, voiceWho } from "../lib/context.ts";
import { researchFor, type Job } from "../lib/jobs.ts";
import type { Attached } from "../lib/photos.ts";

/**
 * The tools the delegation router may call.
 *
 * GPT-Live's delegation event carries no task text — only an id and a timeline
 * offset — so the router reads the transcript and decides what the user actually
 * wants. That decision is what makes third-party MCP servers usable at all.
 */
export interface ToolContext {
  env: Env;
  signal: AbortSignal;
  /** Say something to the driver while slow work is still running. */
  progress(text: string): void;
  /** Loaded once per request, so a write is visible to a read in the same turn. */
  memory: MemoryStore;
  /** Put something on the car's screen. Separate from what Jarvis says aloud. */
  display(payload: Record<string, unknown>): void;
  /**
   * Someone is in front of a screen this call may draw on: the request has one
   * (RunOptions.screenless) and the caller holds `screen`, as a picture Jarvis
   * makes needs. Never a routine or a job, whose grants have no `screen`. Only
   * a component's video asks it (tools/mcp.ts); what other tools display goes
   * out as it always has.
   */
  onScreen?: true;
  /** A background job was started (start_job, ask_hermes): typed chat shows it as a pill until its result comes (src/app/fromRoutine.ts). */
  started?(job: { id: string; title: string; engine: string }): void;
  /** A Gmail draft waiting for the person's tap (lib/mail-draft.ts): the screen shows it as a card with Send (src/app/draft.ts). */
  drafted?(d: DraftCard): void;
  /** A card to make a skill's bot its own address, on the screen that asked (tools/skills.ts skill_address, src/app/botAddress.ts). */
  offerAddress?(skill: { id: string; name: string }): void;
  /**
   * What the caller may reach. A routine made by voice keeps these, so it can
   * never later do more than the person or device that asked for it.
   */
  grants: readonly Grant[];
  /**
   * A routine's run with the browser (routes/routines.ts askForRoutine): the
   * only sites its maker let routines use it on (lib/vault.ts), which
   * tools/browser.ts checks on every call. Absent for everyone else.
   */
  browserSites?: readonly string[];
  /**
   * The tools the router was offered for this question: what a panel's tile
   * may be wired to, its reading only to one that only reads (tools/panels.ts).
   */
  offered?: readonly Pick<Tool, "name" | "reads">[];
  /** The user's latest message, as they said it: what only they can ask for must be in it (tools/specialties.ts). */
  asked?: string;
  /**
   * Words of theirs that may have named what only they may name (ask_hermes): their latest, even where Jarvis has said
   * more since, or a pressed tile's sentence; and what they said before it, where Jarvis's words between were a
   * question. Nothing of a bot's, a routine's or another program's.
   */
  lately?: readonly string[];
  /** What came with it (lib/photos.ts), for a job that makes files to be given (tools/jobs.ts). */
  attached?: Attached;
  /**
   * Something someone else wrote has been read in this turn (mail, a page, a
   * web search): what is kept must then be the user's own (lib/memory-guard.ts),
   * judged by `said`, their own words or, of a routine, its maker's.
   */
  outside?: { said?: string };
  /** The steps the answer before this question offered to save (lib/specialties.ts): all specialty_save may keep. */
  procedure?: Procedure;
  /**
   * Told that the call did what was asked: a tool a job may propose says so
   * on success, since it says failure in words, not by throwing. Only what
   * it told counts as done for an approval (lib/proposals.ts).
   */
  done?(): void;
}

/** A picture for the router to look at, as a data: URL. */
interface ToolImage {
  url: string;
  detail?: "low" | "high" | "auto";
}

/**
 * What a tool hands back: words, or words and pictures. A picture goes to the
 * router model itself, which looks at it and answers in the same loop — no
 * second model call — and can still use other tools on what it saw.
 */
export type ToolOutput = string | { text: string; images: ToolImage[] };

export const outputText = (o: ToolOutput): string => (typeof o === "string" ? o : o.text);

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Whether this tool can work at all on this deployment. Absent means always.
   * Keeping the gate next to the tool is what stopped an unconfigured Hermes
   * from disabling every other local tool.
   */
  available?(env: Env): boolean;
  /** Answers within seconds, as every tool here does: what takes minutes is a background job. */
  pace?: "fast";
  /**
   * What a caller must hold to be offered this tool. Absent means the `ask`
   * baseline suffices. The router is only ever SHOWN the tools a grant allows —
   * filtering here rather than instructing the model is what makes the boundary
   * real, because a tool that was never offered cannot be talked into existence.
   */
  scope?: Scope;
  /**
   * Strict schema adherence. True for tools defined here, where the schema is
   * ours to guarantee. False for MCP tools: strict mode demands
   * `additionalProperties: false` and a full `required` list on every nested
   * object, and rewriting a third-party server's schema to satisfy that risks
   * changing what it means. The MCP server validates its own arguments anyway.
   */
  strict?: boolean;
  /**
   * How a background job may propose this call for the user's tap
   * (lib/proposals.ts): how risky it is, worked out from its arguments, and
   * what it does in words; null when these arguments cannot be proposed.
   * Without it, a job is never handed the tool. Not sent to the model.
   */
  propose?(args: Record<string, unknown>, env: Env): Weighed | null;
  /**
   * Whether it only reads, where its name does not decide it (lib/jobs.ts
   * readsOnly). True on Jarvis's own tools that only look something up: only
   * a tool that reads may be a Home tile's reading, which is run with nobody
   * pressing anything (lib/panel-tiles.ts); what a job is handed is still
   * READ_TOOLS's to say (lib/jobs.ts). A component's tool is what an admin
   * classed it as (lib/components.ts): true, it is a reading tool wherever
   * those are offered (jobTool); false, it acts, and with nobody there it is
   * proposed, never run. Never false on one of Jarvis's own: a routine is not
   * offered a tool that says it acts. Not sent to the model.
   */
  reads?: boolean;
  /**
   * An acting tool the owner lets run with nobody there (a routine, a job),
   * counted and told by code each time it does (tools/components.ts). Not
   * sent to the model.
   */
  alone?: true;
  /** What the card shows of the thing the call acts on, looked up when it is filed (an email's sender and subject). Shown only. */
  detail?(args: Record<string, unknown>, ctx: ToolContext): Promise<string | null>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" && v.trim() ? v.trim() : fallback;

/** How long after Hermes answered their next words may be to it, without its name; and after it was too long to, when it may report by an alert (docs/hermes.md). */
const HERMES_ANSWER_MS = 2 * 3_600_000;
const HERMES_LATE_MS = 12 * 3_600_000;

const askHermes: Tool = {
  name: "ask_hermes",
  scope: "hermes",
  available: (env) => !!hermes.hermesConfig(env),
  pace: "fast",
  description:
    "The user's own Hermes agent, on their computer at home, which can run commands there; one to " +
    "four minutes. ONLY when the user names Hermes in their latest message, or answers what Hermes " +
    "asked them: never your own idea, nor a way round something that failed. A site to build or code " +
    "to change is start_job's 'build'; a tool, a bot, a webhook or an MCP server for Jarvis itself is skill_add. " +
    "The question goes to Hermes as a background job and this returns at once: its answer reaches " +
    "the user as a message when it is ready, even if the screen is closed — tell them that, and do " +
    "not wait for it or guess it. Asked later whether it has answered, read it with job_results; never " +
    "ask Hermes again to find out. It does NOT have the user's saved facts; those are in the profile " +
    "block and in recall.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "A single self-contained question. Hermes does not see the car " +
          "conversation, so resolve pronouns and include any needed context. For code, " +
          "say what to change and in which site, app or project, by the name the user " +
          "used, and ask Hermes to say when it is done or deployed. When " +
          "handing over research, say exactly what Hermes should do with it, e.g. " +
          "'build a first version of the site with Claude Code in a new project " +
          "folder, and tell me when it is done', and nothing more: never the " +
          "report, its summary or its findings, since the whole report goes with " +
          "it, quoted.",
      },
      research: {
        type: ["string", "null"],
        description:
          "Only when the user asks to pass research on to Hermes: words from the " +
          "finished research job's title, or 'latest'. Null otherwise.",
      },
    },
    required: ["question", "research"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const question = str(args.question);
    if (!question) return "No question was supplied.";
    const state = stateStub(ctx.env);
    // It runs commands where it lives: by name, in their own latest words, and never on a model's own idea. Without its
    // name, in answer to Jarvis's question about it, or to what it came back with (HERMES_ANSWER_MS): never in a turn that
    // has read what someone else wrote, which could have put the words. A tile's tap is a person's, with no model to have one.
    const [own = "", before = ""] = (ctx.lately ?? []).map(ownPart);
    if (ctx.offered && !hermes.hermesNamed(own)) {
      const person = ctx.env.JARVIS_PERSON || OWNER;
      const came = async () => (state ? await state.listJobs() : []).some((j) => j.engine === "hermes" && isTheirs(j.createdBy, person) && ((j.status === "done" && Date.now() - (j.finishedAt ?? 0) < HERMES_ANSWER_MS) || (j.status === "failed" && Date.now() - (j.finishedAt ?? 0) < HERMES_LATE_MS)));
      if (!own || ctx.outside || !(hermes.hermesNamed(before) || (await came()))) return "Not asked: Hermes is asked only when the user names it, in their own words. If it would help, say so: they can say \"ask Hermes\".";
    }
    // Research handed over, only when asked for: the caller's own finished research, whole and quoted (lib/jobs.ts).
    let from: Job | undefined;
    const research = str(args.research);
    if (research) {
      const found = researchFor(state ? await state.listJobs() : [], voiceWho(ctx.env), research);
      if (typeof found === "string") return `${found} Nothing was sent to Hermes.`;
      from = found;
    }
    /*
     * A job, not a wait: Hermes takes minutes, and waiting meant the car's tab
     * had to stay open for the answer — close it and the answer was gone. As a
     * job it runs from the Durable Object and arrives as an alert: spoken on
     * the screen if one is open, a notification if not.
     */
    if (!state) {
      ctx.progress("asking home");
      return hermes.ask(ctx.env, question, { signal: ctx.signal });
    }
    const j = await state.createJob(
      { title: `Hermes: ${question.slice(0, 60)}`, task: question, engine: "hermes", ...(from ? { from: from.id } : {}) },
      { who: voiceWho(ctx.env), grants: ctx.grants },
    );
    if (typeof j === "string") return `Hermes was not asked: ${j}.`;
    ctx.started?.({ id: j.id, title: j.title, engine: j.engine });
    const what = from ? `Asked Hermes, with the whole report "${from.title}".` : "Asked Hermes.";
    return `${what} It usually takes one to four minutes; the answer will reach the user as a message when it is ready. Tell them so, briefly.`;
  },
};

/** Every local tool. MCP tools are appended separately at request time. */
const ALL: Tool[] = [
  ...memoryTools,
  ...specialtyTools,
  trueNow,
  lookBackTool,
  ...tessieTools,
  ...directionsTools,
  ...placeTools,
  ...placesTools,
  ...cameraTools,
  makeImage,
  makePage,
  ...spotifyTools,
  ...gmailTools,
  ...calendarTools,
  sendNote,
  alertTalk,
  openOnGlasses,
  timeIn,
  ...routineTools,
  ...jobTools,
  inbox,
  projectControl,
  siteControl,
  ...familyTools,
  passTool,
  ...panelTools,
  houseWatch,
  ...skillTools,
  ...browserTools,
  askHermes,
];

/** Everything, for the owner and for any caller that has not been narrowed. */
const EVERYTHING: Grant[] = ["*"];

export function baseTools(env: Env, granted: readonly Grant[] = EVERYTHING): Tool[] {
  return ALL.filter(
    (t) => (!t.available || t.available(env)) && (!t.scope || allows(granted, t.scope)),
  );
}

/** For /api/diag: which local tools are live, and which are not, and why not. */
export function toolAvailability(
  env: Env,
): { name: string; available: boolean; scope: Scope | "ask" }[] {
  // The scope is reported too, because "why will my device not read the car"
  // is otherwise only answerable by reading the source.
  return ALL.map((t) => ({
    name: t.name,
    available: !t.available || t.available(env),
    scope: t.scope ?? "ask",
  }));
}

/** Shape the Responses API expects for a function tool. */
export function toToolSchema(t: Tool) {
  return {
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: t.strict !== false,
  };
}
