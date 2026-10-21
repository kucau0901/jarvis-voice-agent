// The one bulk change Jarvis makes to mail (lib/mail-bulk.ts): a brief's card
// to archive old promotions, made only by a tap, only to what still matches
// when it is made, only out of the Inbox; and Put back.
import { MAX_BATCH, mailArchiveMany, mailInboxMany, PROMOTIONS, PROMOTIONS_ABOUT, sampleOf } from "../src/worker/lib/mail-bulk.ts";
import { baseTools } from "../src/worker/tools/registry.ts";

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

const kv = new Map<string, string>([["google:refresh", "refresh-token"]]);
const CONFIG = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) };
const env = { GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "sec", CONFIG } as never;
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `promo${String(i + from).padStart(3, "0")}x`);

/** Gmail as far as these need it, every call written down. */
function gmail(listed: string[], status = 204) {
  const calls: { url: string; method: string; body: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("oauth2")) return Response.json({ access_token: "access", expires_in: 3600 });
    calls.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (u.includes("/messages?")) return Response.json({ messages: listed.map((id) => ({ id })) });
    if (u.includes("/messages/batchModify")) return new Response(null, { status });
    const id = /\/messages\/([^?]+)/.exec(u)?.[1] ?? "";
    return Response.json({ id, payload: { headers: [{ name: "From", value: `Shop ${id} <shop@example.com>` }, { name: "Subject", value: `Sale on ${id}` }] } });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}
const ctx = (done: () => void = () => {}) => ({ env, signal: new AbortController().signal, memory: {}, progress: () => {}, display: () => {}, grants: ["*"], done }) as never;

console.log("the card, from its arguments alone");
{
  const w = mailArchiveMany.propose!({ ids: ids(150), total: 212 }, env);
  check("reversible, with no kind a standing permission could name, its button and its subject",
    w?.risk === "reversible" && !w.category && w.verb === "Archive" && w.about === PROMOTIONS_ABOUT, w);
  check("says how many, of how many, and where they stay", w?.says === "Mail: archive 150 promotions older than 2 days (the oldest, of 212 in your Inbox); they stay in All Mail", w?.says);
  check("all of them: no 'of'", mailArchiveMany.propose!({ ids: ids(25), total: 25 }, env)?.says === "Mail: archive 25 promotions older than 2 days; they stay in All Mail");
  const bad = [
    { ids: [], total: 0 },
    { ids: ids(MAX_BATCH + 1), total: 500 },
    { ids: ["../../drafts"], total: 1 },
    { ids: ["promo001x", "promo001x"], total: 2 },
    { ids: ids(3), total: 2 },
    { ids: "promo001x", total: 1 },
    { ids: ids(3), total: "3" },
  ];
  check("not proposed: none, too many, a bad id, one twice, more than the total, not a list", bad.every((a) => mailArchiveMany.propose!(a, env) === null));
  const back = mailInboxMany.propose!({ ids: ids(2), total: 2 }, env);
  check("Put back: reversible, its own button, no subject", back?.risk === "reversible" && back.verb === "Put back" && !back.about && back.says === "Mail: put 2 messages back in the Inbox", back);
}

console.log("\nonly for a tap: never offered to the router or a job");
{
  const offered = baseTools(env, ["*"]).map((t) => t.name);
  check("not among the tools the router or a job is given", !offered.includes("mail_archive_many") && !offered.includes("mail_inbox_many") && offered.includes("mail_manage"));
}

console.log("\narchiving: only what still matches, only out of the Inbox");
{
  const g = gmail([...ids(10, 0), ...ids(5, 100)]);
  try {
    let done = false;
    const out = await mailArchiveMany.run({ ids: [...ids(10, 0), ...ids(3, 200)], total: 13 }, ctx(() => (done = true)));
    const listed = g.calls.filter((c) => c.url.includes("/messages?"));
    check("the search is listed again, as code fixed it", listed.length === 1 && new URL(listed[0]!.url).searchParams.get("q") === PROMOTIONS, listed);
    const batch = g.calls.filter((c) => c.url.endsWith("/messages/batchModify"));
    const body = JSON.parse(batch[0]?.body ?? "{}") as { ids?: string[]; removeLabelIds?: string[]; addLabelIds?: string[] };
    check("one batch, of those on the card still there: the set only shrinks", batch.length === 1 && batch[0]!.method === "POST" && JSON.stringify(body.ids) === JSON.stringify(ids(10, 0)), body);
    check("only the Inbox label is taken off: nothing added, nothing trashed or deleted",
      JSON.stringify(body.removeLabelIds) === '["INBOX"]' && !body.addLabelIds && !g.calls.some((c) => /trash|delete/i.test(c.url) || c.method === "DELETE"), g.calls);
    check("done, and said so", done && /Archived 10 promotions/.test(String(out)), out);
  } finally {
    g.restore();
  }
  const empty = gmail(ids(3, 300));
  try {
    let done = false;
    const out = await mailArchiveMany.run({ ids: ids(3, 0), total: 3 }, ctx(() => (done = true)));
    check("none left to archive: nothing changed, and not done, so there is nothing to put back", !done && /left the Inbox already/.test(String(out)) && !empty.calls.some((c) => c.url.includes("batchModify")), out);
  } finally {
    empty.restore();
  }
  const refused = gmail(ids(3, 0), 403);
  try {
    let done = false;
    const out = await mailArchiveMany.run({ ids: ids(3, 0), total: 3 }, ctx(() => (done = true)));
    check("Gmail refuses: not done, with why", !done && /Nothing was archived/.test(String(out)), out);
  } finally {
    refused.restore();
  }
}

console.log("\nPut back");
{
  const g = gmail([]);
  try {
    let done = false;
    const out = await mailInboxMany.run({ ids: ids(3, 0), total: 3 }, ctx(() => (done = true)));
    const body = JSON.parse(g.calls.find((c) => c.url.endsWith("batchModify"))?.body ?? "{}") as { ids?: string[]; addLabelIds?: string[]; removeLabelIds?: string[] };
    check("the same messages, the Inbox label put back, nothing else", JSON.stringify(body.ids) === JSON.stringify(ids(3, 0)) && JSON.stringify(body.addLabelIds) === '["INBOX"]' && !body.removeLabelIds && done, { body, out });
  } finally {
    g.restore();
  }
}

console.log("\nwho sent a few of them, for the card");
{
  const g = gmail([]);
  try {
    const shown = await sampleOf(env, ids(8, 0), new AbortController().signal);
    const fetched = g.calls.filter((c) => /\/messages\/promo/.test(c.url));
    check("five read, headers only", fetched.length === 5 && fetched.every((c) => c.url.includes("format=metadata")), fetched.map((c) => c.url));
    check("as sender and subject", shown?.startsWith("Among them:\nShop promo000x: Sale on promo000x") === true, shown);
  } finally {
    g.restore();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
