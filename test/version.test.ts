import { readFileSync } from "node:fs";
import { isNewer, latestRelease, parseVersion, repoOf, updateRepo, versionInfo, type Store } from "../src/worker/lib/version.ts";
// @ts-expect-error: plain JavaScript, used by `npm run release`
import { bump, cut, latestVersion, needsAction, notesFor, sections, unreleased } from "../scripts/changelog.mjs";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 240) : "");
  }
}

console.log("version numbers");
{
  check("read with or without a v", JSON.stringify(parseVersion("v1.2.3")) === "[1,2,3]" && JSON.stringify(parseVersion("1.2.3")) === "[1,2,3]");
  check("anything else is not one", parseVersion("1.2") === null && parseVersion("latest") === null);
  check("a later patch is newer", isNewer("1.0.1", "1.0.0"));
  check("compared as numbers, not text", isNewer("1.10.0", "1.9.0") && !isNewer("1.9.0", "1.10.0"));
  check("a later major beats any minor", isNewer("2.0.0", "1.99.99"));
  check("the same is not newer", !isNewer("1.0.0", "v1.0.0"));
  check("nothing unreadable is newer", !isNewer("banana", "1.0.0") && !isNewer("1.0.0", "banana"));
  check("bump patch, minor, major", bump("1.2.3", "patch") === "1.2.4" && bump("1.2.3", "minor") === "1.3.0" && bump("1.2.3", "major") === "2.0.0");
}

console.log("\nwhere releases are looked for");
{
  check("from the package's repository URL", repoOf("https://github.com/owner/jarvis") === "owner/jarvis");
  check("with .git or git+", repoOf("git+https://github.com/owner/jarvis.git") === "owner/jarvis");
  check("or owner/name itself", repoOf("someone/fork") === "someone/fork");
  check("not another host", repoOf("https://gitlab.com/owner/jarvis") === null);
  check("empty setting: the upstream", updateRepo("", "https://github.com/owner/jarvis") === "owner/jarvis");
  check("a fork names its own", updateRepo("someone/fork", "https://github.com/owner/jarvis") === "someone/fork");
  check("off: never", updateRepo("off", "https://github.com/owner/jarvis") === null && updateRepo("OFF ", "x/y") === null);
}

/** GitHub's release page: a redirect to the latest tag, or to the list when there is none. */
function github(location: string | null, status = 302) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status, headers: location ? { location } : {} });
  }) as unknown as typeof fetch;
  return { f, calls };
}

console.log("\nasking GitHub");
{
  const { f, calls } = github("https://github.com/owner/jarvis/releases/tag/v1.4.0");
  const r = await latestRelease("owner/jarvis", f);
  check("the latest tag, from the redirect", r?.version === "1.4.0" && r.url === "https://github.com/owner/jarvis/releases/tag/v1.4.0", r);
  check("asks the page, not the rate-limited API", calls[0]!.url === "https://github.com/owner/jarvis/releases/latest", calls[0]!.url);
  check("without following the redirect", calls[0]!.init.redirect === "manual");

  const none = await latestRelease("owner/jarvis", github("https://github.com/owner/jarvis/releases").f);
  check("no release yet: none", none === null);

  let threw = false;
  await latestRelease("owner/gone", github(null, 404).f).catch(() => { threw = true; });
  check("a missing repository is an error, not 'no release'", threw);
}

/** KV, as a Map. */
function store(): Store & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => (m.has(k) ? JSON.parse(m.get(k)!) : null),
    put: async (k: string, v: string) => void m.set(k, v),
  };
}

console.log("\nwhat Settings is told");
{
  const kv = store();
  const newer = github("https://github.com/owner/jarvis/releases/tag/v1.1.0");
  const a = await versionInfo(kv, "1.0.0", "owner/jarvis", newer.f, 1_000);
  check("a newer release is an update", a.update && a.latest?.version === "1.1.0" && a.version === "1.0.0", a);
  await versionInfo(kv, "1.0.0", "owner/jarvis", newer.f, 1_000 + 3_600_000);
  check("and GitHub is asked at most twice a day", newer.calls.length === 1, newer.calls.length);
  await versionInfo(kv, "1.0.0", "owner/jarvis", newer.f, 1_000 + 13 * 3_600_000);
  check("again after twelve hours", newer.calls.length === 2, newer.calls.length);

  const same = await versionInfo(store(), "1.1.0", "owner/jarvis", newer.f, 0);
  check("the same version is not an update", !same.update && same.latest?.version === "1.1.0", same);

  const off = await versionInfo(store(), "1.0.0", null, newer.f, 0);
  check("checking off: nothing asked", off.repo === null && !off.update && newer.calls.length === 3, off);

  // A good answer, then GitHub fails: the good answer stands, and it tries again sooner.
  const kv2 = store();
  await versionInfo(kv2, "1.0.0", "owner/jarvis", newer.f, 0);
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const b = await versionInfo(kv2, "1.0.0", "owner/jarvis", down, 13 * 3_600_000);
  check("a failed check keeps the last answer", b.update && b.latest?.version === "1.1.0" && b.error === "fetch failed", b);

  const fork = await versionInfo(kv2, "1.0.0", "someone/fork", github("https://github.com/someone/fork/releases/tag/v1.0.0").f, 13 * 3_600_000 + 1);
  check("a different repository is asked afresh", !fork.update && fork.latest?.version === "1.0.0", fork);
}

const SAMPLE = `# Changelog

Intro.

## [Unreleased]

### Added
- A thing.

## [1.0.0] - 2026-09-26

First.

[Unreleased]: https://github.com/o/r/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/o/r/releases/tag/v1.0.0
`;

console.log("\nthe changelog");
{
  check("sections in order", sections(SAMPLE).map((s: { name: string }) => s.name).join(",") === "Unreleased,1.0.0");
  check("the latest released version", latestVersion(SAMPLE) === "1.0.0");
  check("what is waiting", unreleased(SAMPLE) === "### Added\n- A thing.");
  check("a version's notes stop before the links", notesFor(SAMPLE, "1.0.0") === "First.");
  check("no notes for a version it does not have", notesFor(SAMPLE, "9.9.9") === null);

  const next = cut(SAMPLE, "1.1.0", "2026-10-01", "o/r");
  check("releasing dates what was waiting", notesFor(next, "1.1.0") === "### Added\n- A thing." && latestVersion(next) === "1.1.0");
  check("and leaves an empty Unreleased above it", unreleased(next) === "" && next.indexOf("## [Unreleased]") < next.indexOf("## [1.1.0] - 2026-10-01"));
  check("the links compare each version with the last",
    next.includes("[Unreleased]: https://github.com/o/r/compare/v1.1.0...HEAD\n[1.1.0]: https://github.com/o/r/compare/v1.0.0...v1.1.0\n[1.0.0]:"), next.slice(-220));
  check("'Action needed' marks a major release", needsAction("### Action needed\n- Add a secret.") && !needsAction("### Added\n- x"));
}

console.log("\nthis repository");
{
  const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  check("the changelog's latest version is package.json's", latestVersion(md) === pkg.version, { changelog: latestVersion(md), pkg: pkg.version });
  check("package-lock.json agrees", lock.version === pkg.version && lock.packages[""].version === pkg.version);
  check("there is an Unreleased section to add to", sections(md).some((s: { name: string }) => s.name === "Unreleased"));
  check("the repository is where releases are looked for", updateRepo("", pkg.repository?.url) !== null);
  check("every release has a date", sections(md).every((s: { name: string; date: string | null }) => s.name === "Unreleased" || !!s.date));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
