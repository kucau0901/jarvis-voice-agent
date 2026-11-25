import type { Tool } from "../tools/registry.ts";
import type { Job } from "./jobs.ts";
import type { Said } from "./job-tools.ts";
import { asQuotedData } from "./quote.ts";
import { helperId } from "./job-helpers.ts";
import { WorkshopError, fileName, workshopAsk, workshopBring, workshopGiven, type WorkshopConfig } from "./workshop.ts";

/**
 * Files between a job and its helpers (lib/job-helpers.ts) in the workshop. A
 * helper has a user and a folder of its own there, as any job does, so neither
 * can open the other's: a file goes across as a copy, by the ways a file is
 * given to a person and brought in from Chat. What a helper makes is a copy
 * beside the job's own work (`from-1/`), for the job to look at, use or leave:
 * its person gets only what the job gives them.
 */

/** Files one helper may hand over. */
const MAX_HANDED = 20;
const SECONDS = 60_000;

/** A copy of a file of `from`'s folder, put in `to`'s; its size. */
async function across(cfg: WorkshopConfig, from: string, path: string, to: string, at: string, stop?: AbortSignal): Promise<number> {
  const signal = AbortSignal.any([AbortSignal.timeout(SECONDS), ...(stop ? [stop] : [])]);
  const { sha256 } = await workshopAsk<{ sha256: string }>(cfg, "give", { job: from, path }, signal);
  const bytes = new Uint8Array(await workshopGiven(cfg, from, sha256, signal));
  await workshopBring(cfg, to, at, bytes, signal);
  return bytes.byteLength;
}

/** The copies a helper starts with, of the job's files it was said to need; what it is told of them. */
export async function bringNeeds(cfg: WorkshopConfig, job: string, t: number, needs: readonly string[], stop?: AbortSignal): Promise<string> {
  const has: string[] = [];
  const not: string[] = [];
  for (const path of needs) {
    try {
      await across(cfg, job, path, helperId(job, t), path, stop);
      has.push(path);
    } catch (e) {
      if (!(e instanceof WorkshopError)) throw e;
      not.push(`${path}: ${e.message}`);
    }
  }
  return [
    has.length ? `In your folder, copies from the job:\n${asQuotedData("files", has.join("\n"), "THE JOB")}` : "",
    not.length ? `Not given to you:\n${asQuotedData("files", not.join("\n"), "THE JOB")}` : "",
  ].filter(Boolean).join("\n\n");
}

/** A helper's way to give the job a file. */
export function handFile(cfg: WorkshopConfig, job: Pick<Job, "id" | "help">, t: number, say: (s: Said) => Promise<void>, stop?: AbortSignal): Tool {
  const handed = new Set((job.help?.chains[t]?.handed ?? []).map((f) => f.path));
  return {
    name: "hand_file",
    pace: "fast",
    description: `Give the job a copy of a file from your folder, as it is now, for it to use. The same name again replaces it. ${MAX_HANDED} at most.`,
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async run(args) {
      const path = typeof args.path === "string" ? args.path : "";
      const at = `from-${t + 1}/${fileName(path)}`;
      if (!handed.has(at) && handed.size >= MAX_HANDED) return `Not handed over: ${MAX_HANDED} files at most. Put several in one zip.`;
      try {
        const size = await across(cfg, helperId(job.id, t), path, job.id, at, stop);
        handed.add(at);
        await say({ handed: { path: at, size } });
        return `Handed to the job: ${size.toLocaleString("en-US")} bytes.`;
      } catch (e) {
        if (e instanceof WorkshopError) return `Not handed over: ${e.message}.`;
        throw e;
      }
    },
  };
}
