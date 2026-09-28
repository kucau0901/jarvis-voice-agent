// What the Gmail and Calendar tools say when they cannot work, word for word:
// not set up, not linked, needing linking again, and any other failure.
// Written before their guards were shared (lib/google.ts guardTool), so the
// sharing can be seen to change none of it. Spotify's are pinned in
// family-spotify-tools.test.ts.
import { mailCheck } from "../src/worker/tools/gmail.ts";
import { calendarCheck } from "../src/worker/tools/calendar.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : "");
  }
}

const kv = new Map<string, string>();
const CONFIG = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) };
const ctx = (env: Record<string, unknown>) => ({ env: { CONFIG, ...env }, signal: new AbortController().signal, progress() {}, display() {}, memory: {}, grants: ["*"] }) as never;
const KEYS = { GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "secret" };
const mail = async (env: Record<string, unknown>) => String(await mailCheck.run({ unread_only: true, limit: null }, ctx(env)));
const cal = async (env: Record<string, unknown>) => String(await calendarCheck.run({ range: "today", limit: null }, ctx(env)));

console.log("not set up");
check("Gmail", (await mail({})) === "Gmail error: Gmail is not configured");
check("Calendar", (await cal({})) === "Calendar error: Google is not configured");

console.log("\nnot linked");
check(
  "Gmail",
  (await mail(KEYS)) ===
    "This person's Gmail is not linked yet. They link it once from a phone or laptop: in Family → Accounts, or before a family is set up, Settings → Google. Tell them that plainly; do not retry.",
);
check(
  "Calendar",
  (await cal(KEYS)) ===
    "This person's Google account is not linked yet. They link it once from a phone or laptop: in Family → Accounts, or before a family is set up, Settings → Google. Tell them that plainly; do not retry.",
);

const realFetch = globalThis.fetch;
kv.set("google:refresh", "refresh-token");
try {
  console.log("\nthe link has lapsed (Google says invalid_grant)");
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 })) as typeof fetch;
  check(
    "Gmail",
    (await mail(KEYS)) === "Gmail's authorisation has expired and needs linking again from a phone: Family → Accounts (or Settings → Google). Say that plainly; retrying will not help.",
  );
  check(
    "Calendar",
    (await cal(KEYS)) ===
      "The Google authorisation has expired and needs linking again from a phone: Family → Accounts (or Settings → Google). Say that plainly; retrying will not help.",
  );

  console.log("\nany other failure");
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  check("Gmail", (await mail(KEYS)) === "Gmail error: could not refresh Google access (503)", await mail(KEYS));
  check("Calendar", (await cal(KEYS)) === "Calendar error: could not refresh Google access (503)", await cal(KEYS));
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
