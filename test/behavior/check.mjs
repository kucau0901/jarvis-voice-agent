#!/usr/bin/env node
// Behavior checks for the refactor (CLAUDE.md, REFACTOR_PLAN.md): a build of
// the app runs locally against stand-ins for OpenAI and Home Assistant
// (fakes.mjs), with a fresh local store and made-up keys — nothing real — and
// is driven through its API (scenario.ts) and its screens (ui.mjs). What it
// answered is saved with the values that change on every run (times, ids,
// tokens) replaced, so two runs of the same code compare equal.
//
//   node test/behavior/check.mjs record <source dir> <out dir>   run that checkout's code, save what it did
//   node test/behavior/check.mjs compare <dir a> <dir b>         what differs between two recordings
//   node test/behavior/check.mjs verify                          record this checkout and compare with .refactor-baseline/
//
// Needs the repository's own node_modules (wrangler, vite) and Google Chrome
// for the screens (CHROME=<path> to use another). Ports 8791, 8792, 8798 and
// 9333 must be free.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(HERE, "../..");
const BASE = "http://127.0.0.1:8798";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- what changes on every run, replaced ---------- */

const VOLATILE_KEYS = /^(at|ts|ms|token|poll|code|challenge|digest|ticket|requestId|clientRef|sessionId|session|expiresAt|expiresIn|until|createdAt|updatedAt|addedAt|lastSeenAt|lastUsedAt|sentAt|answeredAt|nextAt|nextCheck|okAt|checkedAt|finishedAt|heldUntil|after|seconds|medianMs|p256dh|auth|endpoint|fingerprint|hint|credential|rawId|slowest)$/;
/** The scenario's people: lists of them whose order comes from random ids are put in order. */
const NAMES = "Adam|Sara|Aisyah|Nenek|Siti";

/**
 * One recording's tidier. Every id becomes <id>: numbering them would follow
 * whatever order they came in, and some lists come in the order of the random
 * ids themselves. A record keyed by ids (usage by person, a car's shares)
 * becomes the sorted list of its values.
 */
function tidier() {
  const idOf = () => "<id>";
  const text = (s) => {
    // A path: decoded, so ids in it are found like any other.
    if (s.startsWith("/api/")) {
      try {
        s = decodeURIComponent(s);
      } catch {
        /* as it is */
      }
    }
    let t = s
      .replace(/jss1_[a-z0-9]{32}|jin1_[a-z0-9]{32}|jpp1_[a-z0-9]{32}|jdv1_[A-Za-z0-9_-]{20,}/g, "<token>")
      .replace(/jdv1_[a-z0-9]{2,}…[a-z0-9]{2,}/g, "<hint>")
      .replace(/\b(u|s|i|x|r|m|c|d|dev|job|rt|p|g)_[a-z0-9]{6,}\b/g, idOf)
      .replace(/\b[0-9a-f]{16,}\b/g, "<hex>")
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<iso>")
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
      .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "<date>")
      .replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? \d{1,2} [A-Z][a-z]{2,8}\b/g, "<date>")
      .replace(/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/g, "<date>")
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "<hh:mm>")
      .replace(/\b(just now|\d+ ?(s|m|h|d|seconds?|minutes?|hours?|days?) ago|in \d+ ?(s|m|h|d|seconds?|minutes?|hours?|days?))\b/g, "<ago>")
      .replace(/\b\d+(\.\d+)? ?ms\b/g, "<ms>");
    // "Sara, Nenek, Aisyah": the family in storage order, which follows random ids.
    t = t.replace(new RegExp(`\\b(?:${NAMES})(?:(?:, | and )(?:${NAMES}))+\\b`, "g"), (m) => m.split(/, | and /).sort().join(", "));
    // Lines each about one of them ("Sara: …", "for Sara"), in the same order for the same reason.
    // The slowest questions (Settings → Usage) are a matter of timing: left out.
    const lines = t.split("\n").filter((l) => !/^\d+(\.\d+)? s · /.test(l));
    const named = (l) => new RegExp(`^(?:for )?(?:${NAMES})\\b`).test(l);
    for (let i = 0; i < lines.length; ) {
      let j = i;
      while (j < lines.length && named(lines[j])) j++;
      if (j - i > 1) lines.splice(i, j - i, ...lines.slice(i, j).sort());
      i = Math.max(j, i + 1);
    }
    return lines.join("\n");
  };
  const walk = (v) => {
    if (Array.isArray(v)) {
      const out = v.map(walk);
      // Records in a list: ordered by content, since equal times leave storage order to chance.
      return out.every((x) => x && typeof x === "object") ? out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : out;
    }
    if (v && typeof v === "object") {
      const groups = new Map();
      for (const k of Object.keys(v)) {
        const x = v[k];
        const value =
          VOLATILE_KEYS.test(k) && x !== null && typeof x !== "boolean"
            ? `<${k}>`
            : k === "id" && typeof x === "string" && !text(x).startsWith("<")
              ? idOf(x)
              : walk(x);
        const tk = text(k);
        groups.set(tk, [...(groups.get(tk) ?? []), value]);
      }
      const out = {};
      for (const k of [...groups.keys()].sort()) {
        const vals = groups.get(k);
        out[k] = vals.length === 1 ? vals[0] : vals.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      return out;
    }
    if (typeof v === "number") return v > 1e11 ? "<time>" : v;
    if (typeof v === "string") return text(v);
    return v;
  };
  return { walk };
}

/** A recording, tidied: its requests stay in the order they were made. */
function tidied(dir) {
  const t = tidier();
  const api = JSON.parse(readFileSync(join(dir, "api.raw.json"), "utf8"));
  return {
    records: api.records.map((r) => t.walk(r)),
    model: api.model.map((m) => t.walk(m)),
    house: api.house.map((h) => t.walk(h)),
    ui: t.walk(JSON.parse(readFileSync(join(dir, "ui.raw.json"), "utf8"))),
  };
}

/* ---------- running one checkout ---------- */

function start(cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  return { p, log: () => log };
}

async function waitFor(url, ms = 60_000) {
  for (let t = 0; t < ms; t += 500) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up */
    }
    await sleep(500);
  }
  throw new Error(`${url} did not come up`);
}

async function record(src, out) {
  src = resolve(src);
  out = resolve(out);
  // A worktree has no node_modules or deployment config of its own: borrow the repository's.
  if (!existsSync(join(src, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(src, "node_modules"));
  if (!existsSync(join(src, "wrangler.jsonc"))) cpSync(join(src, "wrangler.example.jsonc"), join(src, "wrangler.jsonc"));
  execFileSync("npx", ["vite", "build"], { cwd: src, stdio: "ignore" });

  const work = mkdtempSync(join(tmpdir(), "jarvis-behavior-"));
  cpSync(join(src, "dist"), join(work, "dist"), { recursive: true });
  const workerDir = readdirSync(join(work, "dist")).find((d) => d !== "client" && existsSync(join(work, "dist", d, "wrangler.json")));
  const cfgPath = join(work, "dist", workerDir, "wrangler.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  delete cfg.routes;
  cfg.name = "jarvis-behavior";
  writeFileSync(cfgPath, JSON.stringify(cfg));
  writeFileSync(join(work, "dist", workerDir, ".dev.vars"), [
    "JARVIS_SHARED_SECRET=BEHAVIORKEY234567",
    "OPENAI_API_KEY=sk-behavior-check",
    "OPENAI_BASE_URL=http://127.0.0.1:8791/v1",
    "HA_BASE_URL=http://127.0.0.1:8792",
    "HA_TOKEN=fake-ha-token",
    "TIMEZONE=Asia/Kuala_Lumpur",
    "TESSIE_TOKEN=fake-tessie-token",
    "TESSIE_VIN=5YJTEST0000000001",
  ].join("\n") + "\n");

  const fakes = start("node", [join(HERE, "fakes.mjs")]);
  const worker = start("npx", ["wrangler", "dev", "-c", cfgPath, "--port", "8798", "--ip", "127.0.0.1", "--persist-to", join(work, "state"), "--local"], { cwd: ROOT });
  try {
    await waitFor("http://127.0.0.1:8791/__log");
    await waitFor(`${BASE}/api/auth/status`);
    mkdirSync(out, { recursive: true });
    const tokens = join(work, "tokens.json");
    execFileSync("node", [join(HERE, "scenario.ts"), BASE, join(out, "api.raw.json"), tokens], { stdio: "inherit" });
    execFileSync("node", [join(HERE, "ui.mjs"), BASE, tokens, out], { stdio: "inherit" });
    // Also kept tidied, for reading: what is compared (compare() tidies the raw files afresh).
    writeFileSync(join(out, "tidied.json"), JSON.stringify(tidied(out), null, 1));
  } catch (e) {
    console.error(worker.log().slice(-3000));
    throw e;
  } finally {
    worker.p.kill();
    fakes.p.kill();
    await sleep(500);
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`recorded ${src} into ${out}`);
}

/* ---------- comparing two recordings ---------- */

function diff(a, b, path, out) {
  if (out.length >= 40) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff(a[k], b[k], `${path}${Array.isArray(a) ? `[${k}]` : `.${k}`}`, out);
    return;
  }
  // Long text: the first line that differs, not the start of both.
  if (typeof a === "string" && typeof b === "string" && (a.includes("\n") || b.includes("\n"))) {
    const la = a.split("\n");
    const lb = b.split("\n");
    let i = 0;
    while (i < la.length && la[i] === lb[i]) i++;
    out.push(`${path}, line ${i + 1}\n    was: ${JSON.stringify(la[i] ?? "(no line)").slice(0, 300)}\n    now: ${JSON.stringify(lb[i] ?? "(no line)").slice(0, 300)}`);
    return;
  }
  const show = (v) => (v === undefined ? "(absent)" : JSON.stringify(v).slice(0, 300));
  out.push(`${path}\n    was: ${show(a)}\n    now: ${show(b)}`);
}

function compare(dirA, dirB) {
  const out = [];
  const a = tidied(dirA);
  const b = tidied(dirB);
  // Requests are compared by position, and labelled by what they were, so a difference says which.
  const label = (r) => `${r.as} ${r.method} ${r.path}`;
  if (a.records.length !== b.records.length) out.push(`api: ${a.records.length} requests before, ${b.records.length} now`);
  a.records.forEach((r, i) => diff(r, b.records[i], `api #${i + 1} (${label(r)})`, out));
  diff(a.model, b.model, "model saw", out);
  diff(a.house, b.house, "house calls", out);
  diff(a.ui, b.ui, "ui", out);
  return out;
}

/* ---------- main ---------- */

const [cmd, x, y] = process.argv.slice(2);
if (cmd === "record" && x && y) {
  await record(x, y);
} else if (cmd === "compare" && x && y) {
  const d = compare(x, y);
  console.log(d.length ? `DIFFERENT (${d.length}${d.length >= 40 ? "+" : ""}):\n${d.join("\n")}` : "same behavior");
  process.exit(d.length ? 1 : 0);
} else if (cmd === "verify") {
  const baseline = join(ROOT, ".refactor-baseline");
  if (!existsSync(join(baseline, "api.raw.json"))) {
    console.error("no baseline: record one from main first (see CLAUDE.md)");
    process.exit(2);
  }
  const now = mkdtempSync(join(tmpdir(), "jarvis-now-"));
  await record(ROOT, now);
  const d = compare(baseline, now);
  console.log(d.length ? `DIFFERENT from the baseline (${d.length}${d.length >= 40 ? "+" : ""}):\n${d.join("\n")}\n\nThis run is in ${now}` : "same behavior as the baseline");
  if (!d.length) rmSync(now, { recursive: true, force: true });
  process.exit(d.length ? 1 : 0);
} else {
  console.error("usage: check.mjs record <source dir> <out dir> | compare <dir a> <dir b> | verify");
  process.exit(2);
}
