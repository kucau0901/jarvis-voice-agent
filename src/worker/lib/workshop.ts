import type { Env } from "../types.ts";

/**
 * The workshop: where a background job runs code and makes files
 * (docker/workshop, docs/DESIGN.md "The workshop"). It has no network and
 * nothing of Jarvis's; this speaks to its door, with their shared token.
 *
 * Only a job ever does, by its own tools (lib/workshop-tools.ts), and its
 * person, for a file it gave them (routes/jobs.ts).
 */
export interface WorkshopConfig {
  base: string;
  token: string;
}

export function workshopConfig(env: Pick<Env, "WORKSHOP_URL" | "WORKSHOP_TOKEN">): WorkshopConfig | null {
  const base = env.WORKSHOP_URL?.trim().replace(/\/+$/, "");
  const token = env.WORKSHOP_TOKEN?.trim();
  return base && token ? { base, token } : null;
}

/** Why the workshop did not do what it was asked, to be said as it is. `refused`: it answered, and would not. */
export class WorkshopError extends Error {
  readonly refused: boolean;
  constructor(why: string, refused = false) {
    super(why);
    this.refused = refused;
  }
}

const OFF = "the workshop is not running";

async function fetched(cfg: WorkshopConfig, path: string, init: RequestInit): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(`${cfg.base}/v1/${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${cfg.token}` } });
  } catch (e) {
    if (init.signal?.aborted) throw new WorkshopError("it took too long, or the job was stopped");
    console.warn("workshop:", e instanceof Error ? e.message : String(e));
    throw new WorkshopError(OFF);
  }
  if (r.ok) return r;
  const said = (await r.json().catch(() => ({}))) as { error?: unknown };
  // Its own words for what was refused (400); a wrong token or a closed door is not the job's to puzzle over.
  if (r.status === 400 && typeof said.error === "string") throw new WorkshopError(said.error, true);
  throw new WorkshopError(r.status === 401 ? "the workshop's token is wrong (Settings → Workshop)" : OFF);
}

export async function workshopAsk<T>(cfg: WorkshopConfig, what: string, body: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  const r = await fetched(cfg, what, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  return (await r.json()) as T;
}

/** A file a job gave its person, as it was when it was given. */
export async function workshopGiven(cfg: WorkshopConfig, job: string, n: number, signal: AbortSignal): Promise<ArrayBuffer> {
  return (await fetched(cfg, `given?${new URLSearchParams({ job, n: String(n) })}`, { signal })).arrayBuffer();
}

/** Bytes put in a job's folder: what its person attached. */
export async function workshopBring(cfg: WorkshopConfig, job: string, path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  await fetched(cfg, `bring?${new URLSearchParams({ job, path })}`, { method: "PUT", body: bytes, signal });
}

/** Whether it answers, for Settings → Test. */
export async function workshopUp(cfg: WorkshopConfig, signal: AbortSignal): Promise<boolean> {
  return (await fetched(cfg, "health", { signal })).ok;
}

/** A file a job made for its person: which, and what to check it by. */
export interface JobFile {
  n: number;
  name: string;
  size: number;
  sha256: string;
  at: number;
}

/** A command a job ran, for its person to see. */
export interface Ran {
  at: number;
  cmd: string;
  /** How it ended; absent while one left running still is. */
  code?: number | string | null;
  ms?: number;
  late?: true;
}

/** How long the workshop keeps what a job made (docker/workshop/runner.mjs KEEP_MS). */
export const KEPT_DAYS = 14;
/** What is kept of what a job ran, newest last. */
export const MAX_RAN = 40;
export const MAX_FILES = 20;

/** A file's name as it will be saved: the last part of its path, and nothing a disk would stumble on. */
export function fileName(path: string): string {
  const last = path.split(/[\\/]/).pop() ?? "";
  return last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/^\.+/, "").trim().slice(0, 80) || "file";
}

/** A file kept for its person: a name given again is the newer of the two. */
export const withFile = (files: readonly JobFile[] | undefined, f: JobFile): JobFile[] => [...(files ?? []).filter((x) => x.name !== f.name), f];

/** The number a file of that name is given under: its own, given before, or the first free; null when there is none left. */
export function freeNumber(files: readonly JobFile[], name: string): number | null {
  const own = files.find((f) => f.name === name)?.n;
  if (own) return own;
  for (let n = 1; n <= MAX_FILES; n += 1) if (!files.some((f) => f.n === n)) return n;
  return null;
}

/** What a browser is told of a file it saves: a file, never a page to open, whatever is in it. */
export function fileHeaders(name: string, size: number): Record<string, string> {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return {
    "content-type": "application/octet-stream",
    "content-length": String(size),
    "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "no-store",
  };
}
