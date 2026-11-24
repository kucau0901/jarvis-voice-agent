import type { Tool } from "../tools/registry.ts";
import type { Job } from "./jobs.ts";
import type { Said } from "./job-tools.ts";
import { asQuotedData } from "./quote.ts";
import { MAX_FILES, WorkshopError, fileName, freeNumber, withFile, workshopAsk, type JobFile, type WorkshopConfig } from "./workshop.ts";

/**
 * What a job that makes files works with, in the workshop (lib/workshop.ts):
 * run, process, read_file, write_file, edit_file, list_files, give_file. Its
 * own, as its checklist is: offered by routes/jobs.ts to a job of that mode
 * whose person still holds `workshop`, and in no conversation.
 *
 * What comes back is quoted, all of it: a program prints what it read, and
 * what it read may be a page or a mail.
 */

export const RUN_SECONDS = 120;
export const LONG_SECONDS = 900;
/** Of a command, as its person sees it. */
const SHOWN = 300;
const WRITER = "A PROGRAM, FROM WHAT IT READ";

type Ask = <T>(what: string, body: Record<string, unknown>, seconds?: number) => Promise<T>;
interface Out { out?: string; code?: number | null; signal?: string; late?: boolean; ms?: number; kb?: number }

const ended = (r: Out): string =>
  r.late ? `stopped: it took its whole ${Math.round((r.ms ?? 0) / 1000) || RUN_SECONDS} seconds` : r.signal ? `ended by ${r.signal}${r.signal === "SIGKILL" ? " (out of memory, or stopped)" : ""}` : `ended with ${r.code ?? "no code"}`;

const wrote = (out: string | undefined): string => (out?.trim() ? `\n${asQuotedData("what it wrote", out, WRITER)}` : " It wrote nothing.");

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** A tool here never throws at the job: the workshop being off, or a refusal, is something it is told. */
function tool(t: Omit<Tool, "pace" | "run"> & { run(args: Record<string, unknown>): Promise<string> }): Tool {
  return {
    ...t,
    pace: "fast",
    async run(args) {
      try {
        return await t.run(args);
      } catch (e) {
        if (e instanceof WorkshopError) return `Not done: ${e.message}.`;
        throw e;
      }
    },
  };
}

export function workshopTools(cfg: WorkshopConfig, job: Pick<Job, "id" | "files">, say: (s: Said) => Promise<void>, stop?: AbortSignal): Tool[] {
  const ask: Ask = (what, body, seconds = 60) => {
    const limit = AbortSignal.timeout((seconds + 45) * 1000);
    return workshopAsk(cfg, what, { job: job.id, ...body }, stop ? AbortSignal.any([limit, stop]) : limit);
  };
  let files: JobFile[] = [...(job.files ?? [])];
  // Given one after another, so each has a number of its own.
  let giving: Promise<unknown> = Promise.resolve();
  const strict = { additionalProperties: false } as const;
  return [
    tool({
      name: "run",
      // Cut short by an update, it may have run: not run again unasked (lib/job-chain.ts).
      alone: true,
      description:
        "Run a command in this job's own folder, with bash. There is no network. It has python3 (pandas, openpyxl, docx, reportlab, pypdf, " +
        "matplotlib, PIL, bs4, lxml, yaml, jinja2), node, pandoc, pdftotext, qpdf, hugo, jq, rg, sqlite3, zip. " +
        `${RUN_SECONDS} seconds at most; set background for longer (${LONG_SECONDS / 60} minutes), and look at it with process.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "What to run. For more than a few lines, write it to a file first and run that." },
          seconds: { type: ["integer", "null"], description: "The most it may take. Null for the most there is." },
          background: { type: "boolean", description: "Leave it running and go on." },
        },
        required: ["command", "seconds", "background"],
        ...strict,
      },
      async run(args) {
        const cmd = text(args.command);
        const background = args.background === true;
        const most = background ? LONG_SECONDS : RUN_SECONDS;
        const seconds = Math.min(most, Math.max(1, Number(args.seconds) || most));
        const at = Date.now();
        const shown = cmd.trim().slice(0, SHOWN);
        if (background) {
          const r = await ask<{ id: string }>("run", { cmd, seconds, background: true });
          await say({ ran: { at, cmd: shown } });
          return `Running as ${r.id}, for ${seconds} seconds at most.`;
        }
        const r = await ask<Out>("run", { cmd, seconds }, seconds);
        await say({ ran: { at, cmd: shown, code: r.signal ?? r.code ?? null, ms: r.ms, ...(r.late ? { late: true as const } : {}) } });
        return `It ${ended(r)}${r.ms === undefined || r.late ? "" : `, in ${(r.ms / 1000).toFixed(1)} s`}.${(r.kb ?? 0) > 400_000 ? ` The folder holds ${Math.round((r.kb ?? 0) / 1000)} MB of its 500.` : ""}${wrote(r.out)}`;
      },
    }),
    tool({
      name: "process",
      description: "Look at a command left running, or stop it, by the id run gave; or list them all.",
      parameters: {
        type: "object",
        properties: { op: { type: "string", enum: ["list", "poll", "stop"] }, id: { type: ["string", "null"], description: "Null to list." } },
        required: ["op", "id"],
        ...strict,
      },
      async run(args) {
        const op = args.op === "poll" || args.op === "stop" ? args.op : "list";
        if (op === "list") {
          const { processes } = await ask<{ processes: { id: string; running: boolean; code?: unknown }[] }>("process", { op });
          return processes.length ? processes.map((p) => `${p.id}: ${p.running ? "running" : `ended with ${String(p.code)}`}`).join("\n") : "None.";
        }
        const r = await ask<Out & { running: boolean }>("process", { op, id: text(args.id) });
        return `${r.running ? "Still running" : `It ${ended(r)}`}.${wrote(r.out)}`;
      },
    }),
    tool({
      name: "list_files",
      description: "The files in this job's folder.",
      parameters: { type: "object", properties: {}, required: [], ...strict },
      async run() {
        const r = await ask<{ files: { path: string; size: number }[]; more: number }>("file", { op: "list" });
        return r.files.length ? asQuotedData("files", `${r.files.map((f) => `${f.path} (${f.size.toLocaleString("en-US")} bytes)`).join("\n")}${r.more ? `\n… and ${r.more} more` : ""}`, WRITER) : "None yet.";
      },
    }),
    tool({
      name: "read_file",
      description: "Read a text file in this job's folder, by lines.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, from: { type: ["integer", "null"], description: "The first line. Null for the first." }, lines: { type: ["integer", "null"], description: "How many. Null for as many as fit." } },
        required: ["path", "from", "lines"],
        ...strict,
      },
      async run(args) {
        const r = await ask<{ text: string; from: number; to: number; of: number; cut?: true }>("file", { op: "read", path: text(args.path), from: args.from, lines: args.lines });
        return `Lines ${r.from} to ${r.to} of ${r.of}${r.cut ? ", the last of them cut short: look at the rest of it with a program" : ""}.\n${asQuotedData(`file ${fileName(text(args.path))}`, r.text, WRITER)}`;
      },
    }),
    tool({
      name: "write_file",
      alone: true,
      description: "Write a text file in this job's folder: all of it, or added to the end.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, text: { type: "string" }, append: { type: "boolean" } },
        required: ["path", "text", "append"],
        ...strict,
      },
      async run(args) {
        const r = await ask<{ size: number }>("file", { op: "write", path: text(args.path), text: text(args.text), append: args.append === true });
        return `Written: ${r.size.toLocaleString("en-US")} bytes.`;
      },
    }),
    tool({
      name: "edit_file",
      alone: true,
      description: "Change words in a text file in this job's folder: exactly those, in one place unless all.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean" } },
        required: ["path", "find", "replace", "all"],
        ...strict,
      },
      async run(args) {
        const r = await ask<{ changed: number }>("file", { op: "edit", path: text(args.path), find: text(args.find), replace: text(args.replace), all: args.all === true });
        return `Changed in ${r.changed} ${r.changed === 1 ? "place" : "places"}.`;
      },
    }),
    tool({
      name: "give_file",
      description: `Give the user a file from this job's folder, as it is now: it is in Jobs to download. The same name again replaces it. ${MAX_FILES} at most.`,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], ...strict },
      run(args) {
        const path = text(args.path);
        const given = giving.then(async () => {
          const name = fileName(path);
          const n = freeNumber(files, name);
          if (!n) return `Not given: a job gives ${MAX_FILES} files at most. Put several in one zip.`;
          const r = await ask<{ size: number; sha256: string }>("give", { path, n });
          const f: JobFile = { n, name, size: r.size, sha256: r.sha256, at: Date.now() };
          files = withFile(files, f);
          await say({ file: f });
          return `Given: ${name}, ${r.size.toLocaleString("en-US")} bytes. The user can download it in Jobs.`;
        });
        giving = given.catch(() => {});
        return given;
      },
    }),
  ];
}
