import type { Env } from "../types.ts";
import type { ZipFile } from "./zip.ts";
import { b64u } from "./webauthn.ts";
import { nameOf } from "./specialties.ts";

/**
 * The owner's GitHub, for the repositories they listed and no other: their
 * files brought to a job that builds (lib/build-tools.ts), and a pull request
 * opened by a tap (tools/publish.ts). The token is here alone: never in the
 * workshop, a page, or anything a model is told.
 */

const API = "https://api.github.com";
/** What the workshop takes in whole. */
const MAX_ARCHIVE = 20_000_000;

/** The repositories listed (GITHUB_REPOS), each as "owner/name". */
export function reposOf(env: Pick<Env, "GITHUB_PULL_TOKEN" | "GITHUB_REPOS">): string[] {
  if (!env.GITHUB_PULL_TOKEN) return [];
  return [...new Set((env.GITHUB_REPOS ?? "").split(/[\s,]+/).filter((r) => REPO.test(r)))];
}
/** Those that words name: whole ("ana/site"), else by a name of two words or more, or a word said to be a repository's. */
export function repoNamed(repos: readonly string[], words: string): string[] {
  const said = ` ${nameOf(words)} `;
  // Not one whose name is only a part of another's that was said.
  const those = (name: (r: string) => string, is: (n: string) => boolean): string[] => {
    const hit = repos.filter((r) => is(name(r)));
    return hit.filter((r) => !hit.some((x) => name(x) !== name(r) && ` ${name(x)} `.includes(` ${name(r)} `)));
  };
  const whole = those(nameOf, (n) => said.includes(` ${n} `));
  if (whole.length) return whole;
  return those((r) => nameOf(r.split("/")[1]!), (n) => (n.includes(" ") && said.includes(` ${n} `)) || new RegExp(` (?:${n} (?:repo|repository|repositori)|(?:repo|repository|repositori) ${n}) `, "u").test(said));
}
export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** Why GitHub did not do it, to be said as it is. */
export class GitHubError extends Error {}

async function ask(env: Env, method: string, path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${env.GITHUB_PULL_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "jarvis-voice-agent", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  } catch {
    throw new GitHubError(signal.aborted ? "GitHub took too long" : "GitHub could not be reached");
  }
  if (r.ok) return r;
  // Its message is GitHub's own: short, and never with the token in it.
  const said = ((await r.json().catch(() => ({}))) as { message?: unknown }).message;
  const busy = r.status === 429 || (r.status === 403 && (r.headers.get("retry-after") !== null || r.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(String(said))));
  const why = r.status === 401 ? "its token is not taken (Settings → GitHub)" : busy ? "it will take no more from here for now: try again in a few minutes" : r.status === 403 || r.status === 404 ? "its token may not reach that repository, or it is not there" : typeof said === "string" ? said.slice(0, 160) : `it answered ${r.status}`;
  throw new GitHubError(`GitHub: ${why}`);
}
const json = async <T>(r: Promise<Response>): Promise<T> => (await (await r).json()) as T;

/** The repository's own main branch, and the commit it is at. */
async function head(env: Env, repo: string, signal: AbortSignal): Promise<{ branch: string; sha: string }> {
  const { default_branch: branch } = await json<{ default_branch: string }>(ask(env, "GET", `/repos/${repo}`, signal));
  const { object } = await json<{ object: { sha: string } }>(ask(env, "GET", `/repos/${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, signal));
  return { branch, sha: object.sha };
}

/** Whether the token reaches a repository, for Settings → Test. */
export async function repoSeen(env: Env, repo: string, signal: AbortSignal): Promise<void> {
  await head(env, repo, signal);
}

/** A repository as a .tar.gz of its files, as it stood at a commit, and which; as it stands, without one. */
export async function archive(env: Env, repo: string, signal: AbortSignal, commit?: string): Promise<{ bytes: Uint8Array; sha: string }> {
  const sha = commit ?? (await head(env, repo, signal)).sha;
  const r = await ask(env, "GET", `/repos/${repo}/tarball/${sha}`, signal);
  const reader = r.body?.getReader();
  if (!reader) throw new GitHubError("GitHub: it sent nothing");
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_ARCHIVE) {
      await reader.cancel().catch(() => {});
      throw new GitHubError(`that repository is over ${MAX_ARCHIVE / 1_000_000} MB, which is more than a job can be given`);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, sha };
}

export interface Change {
  repo: string;
  /** The commit its files were made from: the change is made on that, so it undoes nothing merged since. */
  base: string;
  /** The branch it is put on, new, and never the main one. */
  branch: string;
  title: string;
  body: string;
  files: readonly ZipFile[];
  remove: readonly string[];
}

/** Standard base64, as GitHub takes a file's bytes. */
const b64 = (bytes: Uint8Array) => {
  const s = b64u(bytes).replace(/-/g, "+").replace(/_/g, "/");
  return s + "=".repeat((4 - (s.length % 4)) % 4);
};

/** A file's bytes as the words they are, if they are words through and through; else null. */
function words(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  // Put back into bytes it must be the same bytes: what it is not is sent as it is.
  const again = new TextEncoder().encode(text);
  return again.length === bytes.length && again.every((x, i) => x === bytes[i]) ? text : null;
}

/** What a plain file is there. Anything else (a folder, a link, another repository) is never written over or removed. */
const FILE = new Set(["100644", "100755"]);

/**
 * A pull request with the change, on a branch of its own: every file as it was
 * approved, with the permissions it has in the repository, made on the commit
 * the job was given. Only a file is written over or removed, and only under a
 * folder: what stands in the place of a link may be somewhere else, and a
 * folder removed would be every file in it.
 */
export async function openPull(env: Env, c: Change, signal: AbortSignal): Promise<{ url: string; number: number }> {
  const { branch } = await head(env, c.repo, signal);
  const { tree } = await json<{ tree: { sha: string } }>(ask(env, "GET", `/repos/${c.repo}/git/commits/${c.base}`, signal));
  const now = await json<{ tree: { path: string; mode: string }[]; truncated?: boolean }>(ask(env, "GET", `/repos/${c.repo}/git/trees/${tree.sha}?recursive=1`, signal));
  if (now.truncated) throw new GitHubError("that repository has too many files to be changed from here");
  const modes = new Map(now.tree.map((t) => [t.path, t.mode]));
  for (const p of [...c.files.map((f) => f.name), ...c.remove]) {
    const own = modes.get(p);
    if (own !== undefined && !FILE.has(own)) throw new GitHubError(`${p} is ${own === "040000" ? "a folder" : "a link, or another repository,"} there: it is not written over, nor removed`);
    const parts = p.split("/");
    const under = parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/")).find((x) => (modes.get(x) ?? "040000") !== "040000");
    if (under) throw new GitHubError(`${under} is not a folder there, so ${p} cannot be in it`);
  }
  const missing = c.remove.find((p) => !modes.has(p));
  if (missing) throw new GitHubError(`${missing} is not there to remove`);
  const entries: { path: string; mode: string; type: "blob"; sha?: string | null; content?: string }[] = [];
  for (const f of c.files) {
    const content = words(f.bytes);
    // Words go with the list itself; what is not, one at a time: GitHub takes only so many of those a minute.
    const made = content === null ? { sha: (await json<{ sha: string }>(ask(env, "POST", `/repos/${c.repo}/git/blobs`, signal, { content: b64(f.bytes), encoding: "base64" }))).sha } : { content };
    entries.push({ path: f.name, mode: modes.get(f.name) ?? "100644", type: "blob", ...made });
  }
  for (const path of c.remove) entries.push({ path, mode: modes.get(path)!, type: "blob", sha: null });
  const made = await json<{ sha: string }>(ask(env, "POST", `/repos/${c.repo}/git/trees`, signal, { base_tree: tree.sha, tree: entries }));
  const commit = await json<{ sha: string }>(ask(env, "POST", `/repos/${c.repo}/git/commits`, signal, { message: c.title, tree: made.sha, parents: [c.base] }));
  await ask(env, "POST", `/repos/${c.repo}/git/refs`, signal, { ref: `refs/heads/${c.branch}`, sha: commit.sha });
  try {
    const pr = await json<{ html_url: string; number: number }>(ask(env, "POST", `/repos/${c.repo}/pulls`, signal, { title: c.title, body: c.body, head: c.branch, base: branch }));
    return { url: pr.html_url, number: pr.number };
  } catch (e) {
    throw new GitHubError(`${e instanceof Error ? e.message : String(e)}. The branch ${c.branch} was made, with the change on it, and no pull request`);
  }
}
