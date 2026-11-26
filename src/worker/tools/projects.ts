import type { Tool } from "./registry.ts";
import { nearest } from "./args.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER, mayWork } from "../lib/context.ts";
import { jobFileOf, type Project } from "../lib/projects.ts";
import { wordsOf } from "../lib/jobs.ts";
import { saidIn } from "../lib/specialties.ts";
import { asQuotedData, ownPart } from "../lib/quote.ts";

/**
 * A person's projects (lib/projects.ts) by chat or voice, as Jobs → Projects
 * has them. A project's rules are followed by its jobs as their own words, so a
 * name or a rule is kept only where it is in their latest message, as a
 * specialty's name is (tools/specialties.ts): a page, a mail or a tool's output
 * cannot add one. Nothing is changed for a device, a routine or a bot. A file
 * from the phone is added on the Projects screen; here, only one a job of theirs
 * gave.
 */

const words = (v: unknown): string[] => wordsOf(typeof v === "string" ? v : "");
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The one of theirs its words name, or why not. */
function oneOf(all: readonly Project[], named: unknown): Project | string {
  const fits = nearest(all, words(named), (p) => p.name, true);
  if (!fits.length) return `No project of theirs is called that.${all.length ? ` Theirs: ${all.map((p) => `"${p.name}"`).join(", ")}.` : " They have none."}`;
  return fits.length > 1 ? `More than one is: ${fits.map((p) => `"${p.name}"`).join(", ")}. Ask which.` : fits[0]!;
}

export const projectControl: Tool = {
  name: "project_control",
  scope: "memory.write",
  pace: "fast",
  description:
    "The user's projects, whose rules and files their jobs in them follow: 'list'; 'make' (its name, and a rule if given); 'add_rule'; " +
    "'drop_rule'; 'forget'; 'keep_file' keeps a file a job of theirs made. Changes only in their own words.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["list", "make", "add_rule", "drop_rule", "forget", "keep_file"] },
      project: { type: ["string", "null"], description: "Words of its name; for make, the name they gave." },
      rule: { type: ["string", "null"], description: "The rule in their words (make, add_rule), or words of it (drop_rule)." },
      job: { type: ["string", "null"], description: "keep_file: words of the job's title." },
      file: { type: ["string", "null"], description: "keep_file: words of the file's name; null for its only one." },
    },
    required: ["op", "project", "rule", "job", "file"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Projects cannot be kept on this deployment: it has no state object.";
    const person = ctx.env.JARVIS_PERSON || OWNER;
    const all = await state.projectsOf(person);
    if (args.op === "list") {
      if (!all.length) return "They have no projects.";
      return asQuotedData(
        "their projects",
        all.map((p) => `"${p.name}": ${p.rules.length ? p.rules.map((r) => `\n  - ${r}`).join("") : "no rules"}${p.files.length ? `\n  files: ${p.files.map((f) => f.name).join(", ")}` : ""}`).join("\n"),
        "THE USER, WHO WROTE THESE RULES FOR THEIR JOBS; THE FILES' NAMES MAY BE ANYONE'S",
      );
    }
    if (ctx.env.JARVIS_DEVICE) return "Not done: a project is changed by its person, signed in, not by a device.";
    const asked = ownPart(ctx.asked ?? "");
    if (!asked) return "Not done: only the user can do that, in their own words.";
    const now = Date.now();
    const rule = text(args.rule);
    // Theirs, word for word: what a job will follow as the user's own.
    const theirs = (v: string) => saidIn(asked, v);
    if (args.op === "make") {
      const name = text(args.project);
      if (!name || !theirs(name)) return "Not made: a project's name is the one they give it, in their own words. Ask what to call it.";
      if (rule && !theirs(rule)) return "Not made: a rule is kept only in their own words, as they said it. Ask them to say it.";
      const p = await state.projectSave(person, { name, rules: rule ? [rule] : [] }, now);
      return typeof p === "string" ? `Not made: ${p}.` : `Made the project "${p.name}"${p.rules.length ? ", with its rule" : ""}. A job started in it, by naming it, follows its rules and has its files.`;
    }
    const p = oneOf(all, args.project);
    if (typeof p === "string") return p;
    if (args.op === "forget") return (await state.projectForget(person, p.id)) ? `Forgot the project "${p.name}", with its files. Its jobs stay.` : `"${p.name}" is gone already.`;
    if (args.op === "add_rule") {
      if (!rule || !theirs(rule)) return "Not added: a rule is kept only in their own words, as they said it. Ask them to say it.";
      const r = await state.projectSave(person, { id: p.id, name: p.name, rules: [...p.rules, rule] }, now);
      return typeof r === "string" ? `Not added: ${r}.` : `Added to "${p.name}"'s rules; it has ${r.rules.length}.`;
    }
    if (args.op === "drop_rule") {
      const fits = nearest(p.rules, words(rule), (r) => r, true);
      if (fits.length !== 1) return `${fits.length ? "More than one" : "None"} of "${p.name}"'s rules fits that. Its rules:\n${asQuotedData("project rules", p.rules.join("\n") || "(none)", "THE USER")}`;
      const r = await state.projectSave(person, { id: p.id, name: p.name, rules: p.rules.filter((x) => x !== fits[0]) }, now);
      return typeof r === "string" ? `Not dropped: ${r}.` : `Dropped that rule from "${p.name}"; it has ${r.rules.length} left.`;
    }
    if (args.op !== "keep_file") return "Not done: that is not something done to a project.";
    const made = (await state.listJobs()).filter((j) => mayWork(j, ctx.env, ctx.grants) && j.files?.length);
    const jobs = nearest(made, words(args.job), (j) => j.title, true);
    if (jobs.length !== 1) return jobs.length ? `More than one job of theirs fits: ${jobs.map((j) => `"${j.title}"`).join(", ")}. Ask which.` : `No job of theirs that made files is called that.${made.length ? ` Those that did: ${made.slice(0, 8).map((j) => `"${j.title}"`).join(", ")}.` : ""}`;
    const j = jobs[0]!;
    const files = nearest(j.files ?? [], words(args.file), (f) => f.name.replace(/[._-]/g, " "), true);
    if (files.length !== 1) return `${files.length ? "More than one" : "None"} of its files fits that. It made:\n${asQuotedData("file names", (j.files ?? []).map((f) => f.name).join("\n"), "A BACKGROUND JOB")}`;
    const got = await jobFileOf(ctx.env, (id) => state.getJob(id), person, j.id, files[0]!.n);
    if ("why" in got) return `Not kept: ${got.why}.`;
    const r = await state.projectPut(person, p.id, got.name, got.bytes, now, true);
    return typeof r === "string" ? `Not kept: ${r}.` : `Kept the file in "${p.name}". Its jobs will have it.`;
  },
};
