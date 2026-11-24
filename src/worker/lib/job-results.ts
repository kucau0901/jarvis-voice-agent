import type OpenAI from "openai";
import type { Storage } from "./state-host.ts";
import type { Tool } from "../tools/registry.ts";
import { jobRows } from "./job-chain.ts";
import { linksIn, searchedIn } from "./links.ts";
import { asQuotedData, tidy, unquoted } from "./quote.ts";

/**
 * A tool's long answer, in a job. A job sends its whole exchange at every step,
 * so one answer of a hundred thousand characters (a house's every state, a
 * long thread) is paid for at each step after it, and crowds out the rest.
 *
 * So it is cut once, as it arrives, and never edited later: an exchange that
 * changed behind the model would be paid for whole again, and would no longer
 * be what it answered from. All of it is kept beside the exchange
 * (`jobitem:<job>:big:<n>`), gone with the job, and read on with read_result.
 * Every part of it is quoted again, as a cut may have taken the fence's end
 * with it (lib/quote.ts).
 */

/** About ten thousand tokens. */
export const RESULT_MAX = 40_000;
/** As much of one answer as is kept: inside what one row of the object holds. */
export const RESULT_KEPT = 400_000;
/** One reading on, and the passages of one search: inside RESULT_MAX, so neither is cut itself. */
const READ_MAX = 36_000;
const PASSAGE = 700;
const MAX_PASSAGES = 6;

const key = (job: string, n: number) => `${jobRows(job)}big:${n}`;
const countKey = (job: string) => `${jobRows(job)}bigs`;
const WRITER = "WHOEVER WROTE WHAT A TOOL READ";
const chars = (n: number) => n.toLocaleString("en-US");

/** A step's tool outputs, the long ones cut and kept. Pictures, and what read_result itself gives, stay as they are. */
export async function capResults(
  kept: Storage,
  job: string,
  outputs: OpenAI.Responses.ResponseInput,
): Promise<OpenAI.Responses.ResponseInput> {
  const out: OpenAI.Responses.ResponseInput = [];
  for (const o of outputs) {
    if (!("output" in o) || typeof o.output !== "string" || o.output.length <= RESULT_MAX) {
      out.push(o);
      continue;
    }
    const whole = unquoted(o.output);
    const n = ((await kept.get<number>(countKey(job))) ?? 0) + 1;
    await kept.put(countKey(job), n);
    await kept.put(key(job, n), whole.slice(0, RESULT_KEPT));
    const size = Math.min(whole.length, RESULT_KEPT);
    out.push({
      ...o,
      output:
        `${asQuotedData(`result ${n}`, whole.slice(0, RESULT_MAX), WRITER)}\n` +
        `(Cut: the first ${chars(RESULT_MAX)} of ${chars(whole.length)} characters. This is result ${n}; read_result reads on or searches it` +
        `${whole.length > size ? `, as far as ${chars(size)}: ask for less, or more narrowly, to see past that` : ""}.)`,
    } as (typeof outputs)[number]);
  }
  return out;
}

/** Reading on in a long result. Offered to jobs alone (routes/jobs.ts). */
export function readResult(kept: Storage | undefined, job: string): Tool {
  return {
    name: "read_result",
    pace: "fast",
    reads: true,
    description:
      "Read more of a tool's answer that was cut for length, by the number it was given. Give `find` to see the passages " +
      "around a word or phrase (quicker than reading all of it), or `from` to read on from a character.",
    parameters: {
      type: "object",
      properties: {
        result: { type: "integer", description: "The result's number." },
        from: { type: ["integer", "null"], description: "The character to read on from. Null with find." },
        find: { type: ["string", "null"], description: "A word or phrase to find. Null to read on." },
      },
      required: ["result", "from", "find"],
      additionalProperties: false,
    },
    async run(args) {
      const n = Number(args.result);
      const text = kept && Number.isInteger(n) ? await kept.get<string>(key(job, n)) : undefined;
      if (text === undefined) return `There is no result ${String(args.result)} to read on in.`;
      const find = typeof args.find === "string" ? args.find.trim() : "";
      if (find) {
        const low = text.toLowerCase();
        const want = find.toLowerCase();
        const at: number[] = [];
        // Passages that would overlap are one.
        for (let i = low.indexOf(want); i >= 0; i = low.indexOf(want, i + 1)) if (!at.length || i - at.at(-1)! > PASSAGE) at.push(i);
        if (!at.length) return `"${find.slice(0, 80)}" is not in result ${n}.`;
        const shown = at.slice(0, MAX_PASSAGES).map((i) => {
          const start = Math.max(0, i - PASSAGE / 2);
          return `[from ${start}] ${text.slice(start, i + want.length + PASSAGE / 2)}`;
        });
        return `${at.length} ${at.length === 1 ? "place" : "places"} in result ${n}${at.length > shown.length ? `, the first ${shown.length} shown` : ""}.\n${asQuotedData(`result ${n}`, shown.join("\n\n"), WRITER)}`;
      }
      const from = Math.min(Math.max(0, Math.trunc(Number(args.from) || 0)), text.length);
      const to = Math.min(text.length, from + READ_MAX);
      if (from >= to) return `Result ${n} ends at character ${chars(text.length)}.`;
      return `Result ${n}, characters ${chars(from)} to ${chars(to)} of ${chars(text.length)}.\n${asQuotedData(`result ${n}`, text.slice(from, to), WRITER)}`;
    },
  };
}

/* ---------- what its answer says is missing or assumed ------------------------- */

const MAX_FLAGS = 6;
const FLAG = /^[\s*_-]*(MISSING|ASSUMED)[\s*_]*:[\s*_]*(.+?)[\s*_]*$/i;

/** What a job could not do, and what it took for granted: said first, before its result. */
export interface Flags {
  missing: string[];
  assumed: string[];
}

/** The MISSING: and ASSUMED: lines an answer begins with (JOB_WORK), and the rest of it. */
export function flagsOf(text: string): Flags & { rest: string } {
  const out: Flags = { missing: [], assumed: [] };
  const lines = text.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const m = FLAG.exec(lines[i]!);
    if (m) (m[1]!.toUpperCase() === "MISSING" ? out.missing : out.assumed).push(tidy(m[2]!).slice(0, 240));
    else if (lines[i]!.trim()) break;
  }
  return { missing: out.missing.slice(0, MAX_FLAGS), assumed: out.assumed.slice(0, MAX_FLAGS), rest: lines.slice(i).join("\n").trim() };
}

/** The same as words, for a message or a model: at most `most` of each. */
export function flagLines(f: Partial<Flags>, most = MAX_FLAGS): string {
  const part = (head: string, all: readonly string[] | undefined) =>
    all?.length ? `${head}:\n${all.slice(0, most).map((x) => `- ${x}`).join("\n")}${all.length > most ? "\n- …" : ""}` : "";
  return [part("Not done", f.missing), part("Assumed", f.assumed)].filter(Boolean).join("\n\n");
}

/* ---------- the addresses a job has seen --------------------------------------- */

const linksKey = (job: string) => `${jobRows(job)}links`;
const MAX_LINKS = 1_000;

/** Addresses in what a step read: its tools' answers, the pages its searches opened, gave or cited. */
export async function noteLinks(kept: Storage, job: string, output: readonly unknown[], texts: readonly string[]): Promise<Set<string>> {
  const was = (await kept.get<string[]>(linksKey(job))) ?? [];
  const all = new Set([...was, ...searchedIn(output), ...texts.flatMap(linksIn)]);
  if (all.size > was.length) await kept.put(linksKey(job), [...all].slice(0, MAX_LINKS));
  return all;
}
