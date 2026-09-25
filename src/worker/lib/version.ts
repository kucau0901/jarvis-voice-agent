/**
 * Which version this is, and whether a newer one has been released.
 *
 * Versions follow semantic versioning, read from the side of someone running
 * their own copy (docs/RELEASING.md): a new major version means updating needs
 * you to do something, a minor one adds features and needs nothing, a patch
 * only fixes. The settings panel shows the running version and, when there is
 * one, the newer release with a link to what changed.
 *
 * The check asks GitHub's release page, not its API: the API allows 60
 * requests an hour per address without a token, and a Worker shares its
 * address with a great many other Workers. The page answers with a redirect to
 * the latest release's tag, which is all that is needed. The answer is kept
 * for twelve hours, so a copy asks at most twice a day, and only when someone
 * opens the settings.
 *
 * Kept free of Worker globals beyond fetch, so Node can test it.
 */

export type Version = readonly [number, number, number];

export function parseVersion(s: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `a` is a later version than `b`. Anything unreadable is not. */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** "owner/name" from a GitHub URL or the shorthand itself, else null. */
export function repoOf(s: string | undefined): string | null {
  const m = /^(?:(?:git\+)?https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec((s ?? "").trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Where to look for releases. UPDATE_REPO names another repository (a fork's
 * own), "off" stops the check, and empty means the one this copy came from.
 */
export function updateRepo(setting: string | undefined, upstream: string | undefined): string | null {
  const s = setting?.trim() ?? "";
  if (/^off$/i.test(s)) return null;
  return repoOf(s) ?? repoOf(upstream);
}

export interface Release {
  version: string;
  url: string;
}

/**
 * The latest release, from where github.com/<repo>/releases/latest redirects.
 * Null when the repository has no release yet; throws when GitHub cannot say.
 */
export async function latestRelease(repo: string, fetchImpl: typeof fetch = fetch): Promise<Release | null> {
  const res = await fetchImpl(`https://github.com/${repo}/releases/latest`, {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": "jarvis-voice-agent update check" },
    signal: AbortSignal.timeout(5000),
  });
  const to = res.headers.get("location") ?? "";
  const tag = /\/releases\/tag\/(v?\d+\.\d+\.\d+)$/.exec(to)?.[1];
  if (tag) {
    return { version: tag.replace(/^v/, ""), url: to.startsWith("http") ? to : `https://github.com${to}` };
  }
  // With no release yet, the page redirects to the list of releases instead.
  if (res.status >= 300 && res.status < 400) return null;
  throw new Error(`GitHub said ${res.status}`);
}

export interface VersionInfo {
  /** This copy's version. */
  version: string;
  /** Where releases are looked for; null when checking is off. */
  repo: string | null;
  /** The latest release, or null when there is none (or none could be found yet). */
  latest: Release | null;
  /** Whether the latest release is newer than this copy. */
  update: boolean;
  checkedAt?: number;
  /** Why the last check failed, if it did. The last good answer is still given. */
  error?: string;
}

/** What versionInfo needs of KV, so a test can hand it a Map. */
export interface Store {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

const CACHE_KEY = "update:latest";
const CHECK_EVERY_MS = 12 * 3_600_000;
/** After a failed check: soon enough to notice a release, not so soon as to lean on GitHub. */
const RETRY_AFTER_MS = 3_600_000;

interface Checked {
  repo: string;
  at: number;
  latest: Release | null;
  error?: string;
}

export async function versionInfo(
  store: Store,
  current: string,
  repo: string | null,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<VersionInfo> {
  if (!repo) return { version: current, repo: null, latest: null, update: false };

  let c = (await store.get(CACHE_KEY, "json").catch(() => null)) as Checked | null;
  if (c && c.repo !== repo) c = null;
  if (!c || now - c.at > (c.error ? RETRY_AFTER_MS : CHECK_EVERY_MS)) {
    try {
      c = { repo, at: now, latest: await latestRelease(repo, fetchImpl) };
    } catch (e) {
      c = { repo, at: now, latest: c?.latest ?? null, error: e instanceof Error ? e.message : String(e) };
    }
    // A cache: a failed write only means asking again next time.
    await store.put(CACHE_KEY, JSON.stringify(c)).catch(() => {});
  }
  return {
    version: current,
    repo,
    latest: c.latest,
    update: !!c.latest && isNewer(c.latest.version, current),
    checkedAt: c.at,
    ...(c.error ? { error: c.error } : {}),
  };
}
