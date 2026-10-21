import { draftFirst, draftThenAsk, mailDraftSend, sendDraft, withFooter, type DraftCard } from "../src/worker/lib/mail-draft.ts";
import { baseTools } from "../src/worker/tools/registry.ts";
import { b64urlDecode } from "../src/worker/lib/google.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";
import { SETTINGS } from "../src/worker/lib/settings.ts";
import { mailManage, mailSend } from "../src/worker/tools/gmail.ts";
import { runCalls } from "../src/worker/lib/router.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 220) : "");
  }
}

/** Google as far as these need it: a token, and Gmail's answer to whatever is asked of it, every call written down. */
function google(answer: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method: string; body: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("oauth2")) return Response.json({ access_token: "access", expires_in: 3600 });
    calls.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    return answer(u, init);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

const kv = new Map<string, string>([["google:refresh", "refresh-token"]]);
const CONFIG = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) };
const ENV = { GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "sec", CONFIG };
const CFG = { clientId: "id.apps.googleusercontent.com", clientSecret: "sec", redirectUri: "https://jarvis.example.com/api/google/callback" };

const ctx = (env: Record<string, unknown>, grants: string[], drafted?: (d: DraftCard) => void) =>
  ({ env: { ...ENV, ...env }, grants, signal: new AbortController().signal, memory: {}, progress: () => {}, display: () => {}, drafted }) as never;

const ARGS = { body: "See you at six.", to: "sam@example.com", subject: "Dinner", reply_to: null, draft: false };
const gmail = (url: string) =>
  url.endsWith("/users/me/drafts") ? Response.json({ id: "r-123456789", message: { id: "m1" } }) : Response.json({ id: "m1", threadId: "t1" });
/** The words of the mail Gmail was given: base64url around the message, base64 around its body (buildRaw). */
function wordsOf(request: string): string {
  const b = JSON.parse(request) as { message?: { raw?: string }; raw?: string };
  const mime = b64urlDecode(b.message?.raw ?? b.raw ?? "");
  return b64urlDecode(mime.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""));
}

console.log("the setting and the route");
{
  check("off unless set to 1", !draftFirst({}) && !draftFirst({ MAIL_DRAFT_FIRST: "0" }) && draftFirst({ MAIL_DRAFT_FIRST: "1" }));
  const s = SETTINGS.find((x) => x.name === "MAIL_DRAFT_FIRST");
  check("Draft first is a setting, off by default", !!s && s.default === "0", s);
  check("sending a draft needs the mail scope", requiredScope("/api/google/drafts/send", "POST") === "mail");
  check("the footer is kept apart by the signature line", withFooter("Hi", { MAIL_FOOTER: " Written with Jarvis " }) === "Hi\n\n-- \nWritten with Jarvis");
  check("no footer, the words as they are", withFooter("Hi", {}) === "Hi" && withFooter("Hi", { MAIL_FOOTER: "  " }) === "Hi");
}

console.log("\nmail_send with Draft first on — held for the person's tap");
{
  const g = google(gmail);
  try {
    const cards: DraftCard[] = [];
    const out = String(await mailSend.run(ARGS, ctx({ MAIL_DRAFT_FIRST: "1", MAIL_FOOTER: "Written with Jarvis" }, ["*"], (d) => cards.push(d))));
    check("it went to Drafts", g.calls.length === 1 && g.calls[0]!.url.endsWith("/users/me/drafts") && g.calls[0]!.method === "POST", g.calls);
    check("nothing was sent", !g.calls.some((c) => c.url.includes("/send")), g.calls);
    check("the screen is given its card", cards.length === 1 && cards[0]!.draft === "r-123456789" && cards[0]!.to === "sam@example.com" && cards[0]!.subject === "Dinner" && !cards[0]!.reply, cards);
    check("the card shows the words as they will go, footer and all", cards[0]?.body === "See you at six.\n\n-- \nWritten with Jarvis", cards[0]);
    check("the mail itself carries the footer", wordsOf(g.calls[0]!.body) === "See you at six.\n\n-- \nWritten with Jarvis", wordsOf(g.calls[0]!.body));
    check("the model is told it was not sent, and only a tap sends it", /NOT sent/.test(out) && /tapping Send/.test(out), out);
  } finally {
    g.restore();
  }
}

console.log("\nDraft first on, no screen (Telegram, a car) — Drafts, no tap to point at");
{
  const g = google(gmail);
  try {
    // As a routine or the family room runs: the card hook given, but `screen` taken out of the grants.
    const out = String(await mailSend.run(ARGS, ctx({ MAIL_DRAFT_FIRST: "1" }, ["mail"], () => {})));
    check("held as a draft", g.calls.length === 1 && g.calls[0]!.url.endsWith("/users/me/drafts"), g.calls);
    check("told it is in Drafts, with no Send to tap", /NOT sent/.test(out) && /Drafts/.test(out) && !/tap/i.test(out), out);
  } finally {
    g.restore();
  }
}

console.log("\nDraft first on, the owner's every scope, but no screen this time (/api/v1/ask)");
{
  const g = google(gmail);
  try {
    const out = String(await mailSend.run(ARGS, ctx({ MAIL_DRAFT_FIRST: "1" }, ["*"])));
    check("no card to draw: told it is in Drafts, not to tap", /NOT sent/.test(out) && /Drafts/.test(out) && !/tap/i.test(out), out);
  } finally {
    g.restore();
  }
  // The router hands a tool the card only where a screen will draw it.
  const seen: string[] = [];
  const probe = { name: "probe", description: "", parameters: {}, run: async (_a: unknown, c: { drafted?: unknown }) => (seen.push(typeof c.drafted), "ok") };
  const call = [{ type: "function_call", call_id: "c1", name: "probe", arguments: "{}" }] as never;
  const sink = { send: () => {}, isClosed: false } as never;
  const base = { env: {} as never, signal: new AbortController().signal, memory: {} as never, grants: ["*"] };
  await runCalls(call, new Map([["probe", probe]]) as never, base, sink);
  await runCalls(call, new Map([["probe", probe]]) as never, { ...base, screenless: true }, sink);
  check("a card where there is a screen, none where there is not", seen.join() === "function,undefined", seen);
}

console.log("\nDraft first off — as before");
{
  const g = google(gmail);
  try {
    const cards: DraftCard[] = [];
    const out = String(await mailSend.run(ARGS, ctx({}, ["*"], (d) => cards.push(d))));
    check("sent straight away", g.calls.length === 1 && g.calls[0]!.url.endsWith("/users/me/messages/send"), g.calls);
    check("no card", cards.length === 0, cards);
    check("no footer unless one is set", wordsOf(g.calls[0]!.body) === "See you at six.", wordsOf(g.calls[0]!.body));
    check("says it was sent", /^Sent/.test(out), out);
  } finally {
    g.restore();
  }
}

console.log("\nasked for a draft — kept, with its card to send it from");
{
  const g = google(gmail);
  try {
    const cards: DraftCard[] = [];
    const out = String(await mailSend.run({ ...ARGS, draft: true }, ctx({}, ["*"], (d) => cards.push(d))));
    check("saved to Drafts", g.calls.length === 1 && g.calls[0]!.url.endsWith("/users/me/drafts"), g.calls);
    check("its card", cards.length === 1, cards);
    check("told as a draft asked for", /^Saved a draft/.test(out), out);
  } finally {
    g.restore();
  }
}

console.log("\na background job's mail: drafted, and its sending proposed (draftThenAsk)");
{
  const g = google(gmail);
  try {
    const filedCalls: { action: { tool: string; args: Record<string, unknown> }; risk: string; says: string; body?: string }[] = [];
    const kept: Record<string, unknown>[] = [];
    const job = draftThenAsk(
      mailSend,
      async (action, w, _ctx, body) => {
        const p = { id: "a0123456789abcdefghjk", state: "pending", says: w.says, action };
        kept.push(p);
        filedCalls.push({ action, risk: w.risk, says: w.says, body });
        return p as never;
      },
      async (asked) => (kept.find((p) => (p.action as { args: { asked?: string } }).args.asked === asked) as never) ?? null,
    );
    check("a job's mail_send says it only proposes", job.name === "mail_send" && job.description.startsWith("PROPOSE ONLY") && job.parameters === mailSend.parameters);
    const out = String(await job.run(ARGS, ctx({}, ["*"])));
    check("drafted, never sent, whatever Draft first says", g.calls.length === 1 && g.calls[0]!.url.endsWith("/users/me/drafts") && !g.calls.some((c) => c.url.includes("/send")), g.calls);
    check("its sending filed, by the draft's id, always to be asked", filedCalls.length === 1 && filedCalls[0]!.action.tool === "mail_draft_send" && filedCalls[0]!.action.args.draft === "r-123456789" && filedCalls[0]!.risk === "irreversible" && filedCalls[0]!.says === "Send the email to sam@example.com", filedCalls);
    check("and the job told both", /draft/i.test(out) && /NOT done: filed/.test(out), out);
    check("its subject and words go with it, to be read before Send", filedCalls[0]?.body === "Subject: Dinner\n\nSee you at six.", filedCalls[0]);
    const twice = await Promise.all([job.run({ ...ARGS, subject: "Lunch" }, ctx({}, ["*"])), job.run({ ...ARGS, subject: "Lunch" }, ctx({}, ["*"]))]);
    check("the same mail twice in one step: drafted and filed once", g.calls.length === 2 && filedCalls.length === 2 && /NOT done: filed/.test(String(twice[1])), { calls: g.calls.length, filed: filedCalls.length });
    const again = String(await job.run(ARGS, ctx({}, ["*"])));
    check("the same mail asked for again (a step tried again): not drafted, nor filed, a second time", g.calls.length === 2 && filedCalls.length === 2 && /NOT done: filed/.test(again), { calls: g.calls.length, filed: filedCalls.length, again });
  } finally {
    g.restore();
  }
  check("sending a draft is never offered to the router", !baseTools({ ...ENV } as never, ["*"]).some((t) => t.name === "mail_draft_send"));
  const sendIt = google(() => Response.json({ id: "m1" }));
  try {
    const said = await mailDraftSend.run({ draft: "r-123456789", to: "sam@example.com", subject: "Dinner" }, ctx({}, ["mail"]));
    check("approved, it sends that draft, by Gmail's drafts.send", said === "Sent the email to sam@example.com." && sendIt.calls[0]?.url.endsWith("/users/me/drafts/send") === true, { said, calls: sendIt.calls });
  } finally {
    sendIt.restore();
  }
  check("a draft id of the wrong shape cannot be proposed", mailDraftSend.propose!({ draft: "../x", to: "a", subject: "b" }, {} as never) === null);
}

console.log("\nmail_manage proposed: which email, for its card");
{
  const g = google(() => Response.json({ id: "199a2b3c4d5e6f70", payload: { headers: [{ name: "From", value: "Sam <sam@example.com>" }, { name: "Subject", value: "Dinner" }, { name: "Date", value: "Wed, 21 Oct 2026 09:00" }] } }));
  try {
    const shown = await mailManage.detail!({ message_id: "199a2b3c4d5e6f70", action: "archive" }, ctx({}, ["mail"]));
    check("its sender, subject and date, from Gmail", shown === "From: Sam <sam@example.com>\nSubject: Dinner\nDate: Wed, 21 Oct 2026 09:00" && g.calls[0]?.url.includes("format=metadata") === true, shown);
    check("an id of the wrong shape: nothing looked up", (await mailManage.detail!({ message_id: "../x", action: "archive" }, ctx({}, ["mail"]))) === null && g.calls.length === 1);
  } finally {
    g.restore();
  }
}

console.log("\nsendDraft — the tap");
{
  let g = google(() => Response.json({ id: "m1" }));
  try {
    check("a bad id never reaches Gmail", (await sendDraft(ENV as never, CFG, "../../profile")) === "That is not a draft's id." && g.calls.length === 0, g.calls);
    check("a good one is sent", (await sendDraft(ENV as never, CFG, "r-123456789")) === null);
    check("by Gmail's own drafts.send", g.calls[0]?.url.endsWith("/users/me/drafts/send") === true && JSON.parse(g.calls[0]!.body).id === "r-123456789", g.calls);
  } finally {
    g.restore();
  }
  g = google(() => Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 }));
  try {
    check("one already sent or deleted says so", /no longer in Drafts/.test(String(await sendDraft(ENV as never, CFG, "r-123456789"))));
  } finally {
    g.restore();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
