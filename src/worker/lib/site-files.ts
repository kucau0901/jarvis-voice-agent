import { ZipError, readZip, type ZipFile, type ZipLimits } from "./zip.ts";
import { textIn } from "./skill-md.ts";

/**
 * What a job that builds things may publish, out of the zip it made: a site's
 * files, or the files of a change to a repository. Looked through by code
 * before a card is filed, and again, the same way, as its tap is carried out
 * (tools/publish.ts): the zip is the job's, and a program could have put
 * anything in it.
 */

export const SITE: ZipLimits = { files: 300, each: 5_000_000, total: 10_000_000 };
export const CHANGE: ZipLimits = { files: 100, each: 1_000_000, total: 5_000_000 };
const MAX_PATH = 200;
const MAX_DEPTH = 10;
/** What a path in either may be made of: what any disk, and any address, takes as it is. */
const SEGMENT = /^[\p{L}\p{N}_()+@,-][\p{L}\p{N} ._()+@,-]*$/u;

/** Why a path may not be published; null when it may. `hidden`: one that begins with a dot may, which a repository has. */
function badPath(path: string, hidden: boolean): string | null {
  const parts = path.split("/");
  if (path.length > MAX_PATH || parts.length > MAX_DEPTH) return `${path.slice(0, 80)} is too long a path`;
  if (parts.some((p) => !(hidden && /^\.[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(p)) && !SEGMENT.test(p))) return `${path.slice(0, 80)} is a name that cannot be published`;
  return null;
}

/** Two names that one disk would take for the same, or a file that is another's folder. */
const twice = (files: readonly ZipFile[]): string | null => {
  const had = new Set<string>();
  for (const f of files) {
    const k = f.name.normalize("NFC").toLowerCase();
    if (had.has(k)) return `${f.name} is in it twice`;
    had.add(k);
  }
  for (const k of had) {
    const at = [...k.matchAll(/\//g)].map((m) => k.slice(0, m.index)).find((x) => had.has(x));
    if (at) return `${at} is in it both as a file and as a folder`;
  }
  return null;
};

async function opened(zip: Uint8Array, limits: ZipLimits): Promise<ZipFile[] | string> {
  try {
    return await readZip(zip, limits);
  } catch (e) {
    if (e instanceof ZipError) return e.message;
    throw e;
  }
}

/** A site's files, from its root; why it cannot be one, in words. A zip of the site's folder is taken for the site. */
export async function siteFiles(zip: Uint8Array): Promise<ZipFile[] | string> {
  const got = await opened(zip, SITE);
  if (typeof got === "string") return got;
  const top = got[0]?.name.split("/")[0] ?? "";
  const inFolder = !got.some((f) => f.name === "index.html") && got.length > 0 && got.every((f) => f.name.startsWith(`${top}/`));
  const files = inFolder ? got.map((f) => ({ ...f, name: f.name.slice(top.length + 1) })) : got;
  if (!files.some((f) => f.name === "index.html")) return "it has no index.html at its root";
  return files.map((f) => badPath(f.name, false)).find((x) => x) ?? twice(files) ?? files;
}

/**
 * Never Jarvis's to change in a repository: whatever a host or a tool runs or
 * obeys by its name alone. That is nearly all of what is hidden (hooks, checks,
 * an editor's or an agent's settings), so a hidden name may be changed only if
 * it is one of the few that hold plain settings; and the rest by their names.
 * Code its own checks run is still code: the card says that they may run.
 */
const PLAIN = /^\.(?:gitignore|editorconfig|prettierrc(?:\.(?:json|ya?ml|toml))?|prettierignore|eslintrc(?:\.(?:json|ya?ml))?|eslintignore|stylelintrc(?:\.(?:json|ya?ml))?|nvmrc|node-version|python-version|ruby-version|dockerignore|npmignore|nojekyll|env\.example|well-known)$/;
const RUNS = /^(?:codeowners|jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|appveyor\.ya?ml|cloudbuild\.ya?ml|buildspec\.ya?ml|codemagic\.ya?ml|lefthook(?:-local)?\.(?:ya?ml|toml|json))$/;

/** Why a path in a repository is not Jarvis's to change; null when it may be. */
export function notTheirs(path: string): string | null {
  // As a disk that minds neither case nor a letter's other form has it; a folder's name as a file's.
  const parts = path.normalize("NFKC").toLowerCase().split("/");
  return parts.some((p) => RUNS.test(p) || (p.startsWith(".") && !PLAIN.test(p)))
    ? `${path} is one of the names a repository's host or tools run or obey by themselves, which are never changed from here`
    : badPath(path, true);
}

/** The files of a change to a repository, by their paths in it, and those it takes away; why it cannot be made. */
export async function changeFiles(zip: Uint8Array | null, remove: readonly string[]): Promise<{ files: ZipFile[]; remove: string[] } | string> {
  const files = zip ? await opened(zip, CHANGE) : [];
  if (typeof files === "string") return files;
  const gone = [...new Set(remove.map((p) => p.replace(/^\.?\/+/, "").trim()).filter(Boolean))];
  if (gone.length > CHANGE.files) return `it removes more than ${CHANGE.files} files`;
  if (!files.length && !gone.length) return "there is nothing in it to change";
  const both = gone.find((p) => files.some((f) => f.name === p));
  if (both) return `${both} is both changed and removed`;
  return [...files.map((f) => f.name), ...gone].map(notTheirs).find((x) => x) ?? twice(files) ?? { files, remove: gone };
}

/** How many of each, as a card's one line says. */
export const changeSaid = (files: number, gone: number): string =>
  [files ? `${files} ${files === 1 ? "file" : "files"}` : "", gone ? `${gone} removed` : ""].filter(Boolean).join(", ");

const size = (n: number) => (n < 1000 ? `${n} bytes` : n < 1_000_000 ? `${Math.round(n / 1000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`);
const SHOWN = 40;

/** A site's files, as its card lists them: every one of a few, then how many more. */
export function filesSaid(files: readonly ZipFile[]): string {
  const lines = files.map((f) => `${f.name} (${size(f.bytes.length)})`);
  return `${lines.slice(0, SHOWN).join("\n")}${lines.length > SHOWN ? `\n… and ${lines.length - SHOWN} more` : ""}`;
}

/** A change's, every one of them, what it takes away first: a card too long to show them all is not filed (lib/proposals.ts). */
export const changeLines = (files: readonly ZipFile[], remove: readonly string[]): string =>
  [...remove.map((p) => `REMOVES ${p}`), ...files.map((f) => `${f.name} (${size(f.bytes.length)})`)].join("\n");

/** Other places a site's files name, by their addresses' hosts: what its person should know before it is theirs. */
export function elsewhere(files: readonly ZipFile[]): string[] {
  const hosts = new Set<string>();
  for (const f of files) {
    const text = /\.(?:html?|css|m?js|json|svg|xml|txt|md|webmanifest)$/i.test(f.name) ? textIn(f.bytes) : null;
    for (const m of text?.matchAll(/(?:https?:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi) ?? []) hosts.add(m[1]!.toLowerCase());
  }
  return [...hosts].filter((h) => h !== "www.w3.org").sort();
}
