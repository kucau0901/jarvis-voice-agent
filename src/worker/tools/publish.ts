import type { Tool } from "./registry.ts";
import { GitHubError, openPull, reposOf } from "../lib/github.ts";
import { changeFiles, changeSaid, siteFiles } from "../lib/site-files.ts";
import { SITE_NAME, siteBack, sitePublish } from "../lib/sites.ts";
import { WorkshopError, givenBytes, workshopConfig, type WorkshopConfig } from "../lib/workshop.ts";
import type { Env } from "../types.ts";

/**
 * Publishing what a job built (lib/build-tools.ts), by its person's tap on the
 * card that lists it (lib/approval.ts): offered to no conversation and no job.
 * The files are the ones the card was made from, by their sum, looked through
 * again as it is done: nothing the job does after filing it changes them.
 */

const SUM = /^[0-9a-f]{64}$/;
const JOB = /^j[a-z0-9]{4,32}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const none = { type: "object", properties: {}, required: [], additionalProperties: false } as const;

/** A card's zip, as it was when the card was made. */
async function zipOf(env: Env, args: Record<string, unknown>): Promise<{ cfg: WorkshopConfig; bytes: Uint8Array } | string> {
  const cfg = workshopConfig(env);
  if (!cfg) return "The workshop it is in is not set up.";
  const got = await givenBytes(cfg, str(args.job), { sha256: str(args.sha256) });
  return got ? { cfg, bytes: new Uint8Array(got) } : "Its files are not as the card showed them, so nothing was published.";
}

/** A tap's call: what went wrong there is said, and never a program's own words. */
export const said = (run: Tool["run"]): Tool["run"] => async (args, ctx) => {
  try {
    return await run(args, ctx);
  } catch (e) {
    if (e instanceof WorkshopError || e instanceof GitHubError) return `Not done: ${e.message}.`;
    throw e;
  }
};

export const where = (name: string, address: string | null) => (address ? `${address.replace(/\/+$/, "")}/${name}/` : `"${name}", in the sites folder`);

export const sitePublishTool: Tool = {
  name: "site_publish",
  pace: "fast",
  description: "Publish a site.",
  parameters: none,
  propose(args, env) {
    const name = str(args.name);
    if (!workshopConfig(env) || !SITE_NAME.test(name) || !JOB.test(str(args.job)) || !SUM.test(str(args.sha256))) return null;
    return { risk: "reversible", says: `Publish the site “${name}” (${changeSaid(Number(args.files), 0)})`, verb: "Publish" };
  },
  run: said(async (args, ctx) => {
    const name = str(args.name);
    const zip = await zipOf(ctx.env, args);
    if (typeof zip === "string") return zip;
    const files = await siteFiles(zip.bytes);
    if (typeof files === "string" || files.length !== args.files) return "Its files are not as the card showed them, so nothing was published.";
    const { address } = await sitePublish(zip.cfg, name, files, str(args.sha256));
    ctx.done?.();
    return `Published: ${where(name, address)}. What was there before, if anything was, is kept to put back.`;
  }),
};

/** What undoes it, made by code (lib/approval.ts inverseOf): that card's publishing, while it is still what is there. */
export const sitePutBack: Tool = {
  name: "site_put_back",
  pace: "fast",
  description: "Put a site back as it was.",
  parameters: none,
  propose(args, env) {
    const name = str(args.name);
    return workshopConfig(env) && SITE_NAME.test(name) && SUM.test(str(args.sha256)) ? { risk: "reversible", says: `Put the site “${name}” back as it was`, verb: "Put back" } : null;
  },
  run: said(async (args, ctx) => {
    const cfg = workshopConfig(ctx.env);
    if (!cfg) return "The workshop is not set up.";
    const { address, down } = await siteBack(cfg, str(args.name), str(args.sha256));
    ctx.done?.();
    return down ? `“${str(args.name)}” is taken down: it was not there before.` : `Put back: ${where(str(args.name), address)}.`;
  }),
};

export const repoPull: Tool = {
  name: "repo_pull",
  pace: "fast",
  description: "Open a pull request.",
  parameters: none,
  propose(args, env) {
    const repo = str(args.repo);
    const title = str(args.title);
    // Only one listed now, whatever was listed when it was filed.
    if (!reposOf(env).includes(repo) || !title || !SHA.test(str(args.base)) || !JOB.test(str(args.job)) || (args.sha256 !== null && (!SUM.test(str(args.sha256)) || !workshopConfig(env)))) return null;
    return { risk: "irreversible", says: `Open a pull request in ${repo} (${changeSaid(Number(args.files), Array.isArray(args.remove) ? args.remove.length : 0)}): ${title}`, verb: "Open it" };
  },
  run: said(async (args, ctx) => {
    const zip = args.sha256 === null ? null : await zipOf(ctx.env, args);
    if (typeof zip === "string") return zip;
    const change = await changeFiles(zip?.bytes ?? null, Array.isArray(args.remove) ? args.remove.map(str) : []);
    if (typeof change === "string" || change.files.length !== args.files) return "Its files are not as the card showed them, so nothing was sent.";
    const job = str(args.job);
    const pr = await openPull(ctx.env, { repo: str(args.repo), base: str(args.base), branch: `jarvis/${job}-${str(args.sha256 ?? "").slice(0, 7) || "remove"}`, title: str(args.title), body: `${str(args.body)}\n\nMade by a Jarvis background job and opened by its person's tap.`, ...change }, ctx.signal);
    ctx.done?.();
    return `Opened: ${pr.url}. Nothing is merged until someone merges it there.`;
  }),
};

export const PUBLISHING: readonly Tool[] = [sitePublishTool, sitePutBack, repoPull];
