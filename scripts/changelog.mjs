/**
 * CHANGELOG.md, read and written (docs/RELEASING.md).
 *
 * Plain functions of the text, so test/version.test.ts can check them against
 * the real file as well as made-up ones.
 */

const HEADING = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*$/;
const LINK = /^\[[^\]]+\]: /;

/** Every `## [x]` section in order: its name, its date if released, and what it says. */
export function sections(md) {
  const lines = md.split("\n");
  const out = [];
  let cur = null;
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      cur = { name: h[1], date: h[2] ?? null, body: [] };
      out.push(cur);
    } else if (LINK.test(line)) {
      cur = null;
    } else if (cur) {
      cur.body.push(line);
    }
  }
  return out.map((s) => ({ name: s.name, date: s.date, body: s.body.join("\n").trim() }));
}

/** The newest released version, or null before the first. */
export function latestVersion(md) {
  return sections(md).find((s) => s.name !== "Unreleased")?.name ?? null;
}

/** What is waiting to be released, or "" when nothing is. */
export function unreleased(md) {
  return sections(md).find((s) => s.name === "Unreleased")?.body ?? "";
}

/** One version's notes, for its GitHub release. Null when there is no such section. */
export function notesFor(md, version) {
  const s = sections(md).find((x) => x.name === version);
  return s ? s.body : null;
}

/** Whether a change list says updating needs something doing, which makes it a major release. */
export const needsAction = (body) => /^### Action needed\b/m.test(body);

/**
 * The changelog with [Unreleased] released as `version` on `date`, a fresh
 * empty [Unreleased] above it, and the comparison links at the foot updated.
 */
export function cut(md, version, date, repo) {
  const previous = latestVersion(md);
  const base = `https://github.com/${repo}`;
  let out = md.replace(/^## \[Unreleased\][ \t]*$/m, `## [Unreleased]\n\n## [${version}] - ${date}`);
  const links =
    `[Unreleased]: ${base}/compare/v${version}...HEAD\n` +
    `[${version}]: ${previous ? `${base}/compare/v${previous}...v${version}` : `${base}/releases/tag/v${version}`}`;
  out = /^\[Unreleased\]: .*$/m.test(out)
    ? out.replace(/^\[Unreleased\]: .*$/m, links)
    : `${out.trimEnd()}\n\n${links}\n`;
  return out;
}

/** The next version after `current`. */
export function bump(current, part) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`not a version: ${current}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (part === "major") return `${maj + 1}.0.0`;
  if (part === "minor") return `${maj}.${min + 1}.0`;
  if (part === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`not major, minor or patch: ${part}`);
}

/** Said at the foot of every release, so nobody has to go looking for how. */
export const HOW_TO_UPDATE = `---

**Updating.** Read the notes above first: anything under *Action needed* has to be done as part of the update.

- Cloudflare: \`git pull\`, then \`npm ci && npm run deploy\`.
- Docker: \`git pull\`, then \`docker compose up -d --build\`.

To stay on this version rather than the newest, \`git checkout\` its tag instead of pulling. The version you are running is at the foot of the menu in Settings, which also says when a newer one is out.`;
