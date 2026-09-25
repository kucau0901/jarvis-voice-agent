/**
 * Cutting a release (docs/RELEASING.md).
 *
 *   npm run release -- patch|minor|major   number it, date the changelog, commit, tag
 *   npm run release -- notes 1.2.0          print that version's release notes
 *
 * It does not push. `git push origin main --follow-tags` publishes: the tag
 * starts .github/workflows/release.yml, which tests the tagged code and creates
 * the GitHub release from CHANGELOG.md.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { HOW_TO_UPDATE, bump, cut, needsAction, notesFor, unreleased } from "./changelog.mjs";

const [what, arg] = process.argv.slice(2);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");

if (what === "notes") {
  const notes = notesFor(readFileSync("CHANGELOG.md", "utf8"), arg ?? "");
  if (notes === null) die(`CHANGELOG.md has no section for ${arg}.`);
  process.stdout.write(`${notes}\n\n${HOW_TO_UPDATE}\n`);
  process.exit(0);
}

if (!["patch", "minor", "major"].includes(what)) {
  die("usage: npm run release -- patch|minor|major\n       npm run release -- notes <version>");
}
if (git("status", "--porcelain")) die("Commit or stash your changes first.");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") die("Release from main.");

const md = readFileSync("CHANGELOG.md", "utf8");
const pending = unreleased(md);
if (!pending) die("Nothing under [Unreleased] in CHANGELOG.md: say what changed first.");
// The one rule the numbers carry for people running a copy: a major version
// is the only kind that asks them to do something.
if (needsAction(pending) && what !== "major") {
  die(`[Unreleased] has "Action needed", so this is a major release: npm run release -- major`);
}
if (what === "major" && !needsAction(pending)) {
  die(`A major release says what to do under "### Action needed". Add it, or release as minor.`);
}

const pkg = readJson("package.json");
const next = bump(pkg.version, what);
const repo = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(pkg.repository?.url ?? "")?.[1];
if (!repo) die("package.json needs repository.url on github.com.");
// The releaser's own date, not UTC's: a morning release in Asia is still yesterday in UTC.
const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

writeFileSync("CHANGELOG.md", cut(md, next, today, repo));
pkg.version = next;
writeJson("package.json", pkg);
const lock = readJson("package-lock.json");
lock.version = next;
if (lock.packages?.[""]) lock.packages[""].version = next;
writeJson("package-lock.json", lock);

git("add", "CHANGELOG.md", "package.json", "package-lock.json");
git("commit", "-m", `Release v${next}`);
git("tag", "-a", `v${next}`, "-m", `Jarvis v${next}`);
console.log(`Tagged v${next}. To publish it:\n\n  git push origin main --follow-tags\n`);
