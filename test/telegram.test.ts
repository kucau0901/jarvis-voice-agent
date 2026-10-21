// Asking Jarvis by Telegram (lib/telegram.ts, routes/telegram.ts): only from
// Telegram, only from a person's own private chat, as that person.
import { askOptions, readUpdate, TELEGRAM_PATH, TELEGRAM_REACH, webhookSecret } from "../src/worker/lib/telegram.ts";
import { ownWords } from "../src/worker/lib/router.ts";
import { handleSettings } from "../src/worker/routes/settings.ts";
import { StateHost } from "../src/worker/lib/state-host.ts";
import { _resetSettingsCache } from "../src/worker/lib/settings-store.ts";
import { handleTelegram } from "../src/worker/routes/telegram.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";

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

const msg = (over: Record<string, unknown> = {}, chat: Record<string, unknown> = {}) => ({
  update_id: 7,
  message: { message_id: 1, text: "Is the gate closed?", chat: { id: 5551234, type: "private", ...chat }, from: { id: 5551234, is_bot: false }, ...over },
});

console.log("what is taken");
{
  const u = readUpdate(msg());
  check("a person's own private chat: taken", u?.chat === "5551234" && u.text === "Is the gate closed?" && !u.forwarded && u.id === 7, u);
  check("a group, a channel post, an edit: never", readUpdate(msg({}, { type: "group", id: -100 })) === null && readUpdate({ update_id: 8, channel_post: msg().message }) === null && readUpdate({ update_id: 9, edited_message: msg().message }) === null);
  check("another bot, or someone else speaking in the chat: never", readUpdate(msg({ from: { id: 5551234, is_bot: true } })) === null && readUpdate(msg({ from: { id: 999, is_bot: false } })) === null);
  check("a photo with no words: taken, with no text", readUpdate(msg({ text: undefined, photo: [{}] }))?.text === "");
  check("a forward: said to be one", readUpdate(msg({ forward_origin: { type: "user" } }))?.forwarded === true);
  check("not Hermes, not a screen", !TELEGRAM_REACH.includes("hermes") && !TELEGRAM_REACH.includes("screen") && TELEGRAM_REACH.includes("ask") && TELEGRAM_REACH.includes("home"));
  const a = await webhookSecret({ JARVIS_SHARED_SECRET: "OWNERKEY", TELEGRAM_BOT_TOKEN: "123:abc" });
  check("its secret: 64 hex, from the owner key and the bot's token together", /^[0-9a-f]{64}$/.test(a) && a !== (await webhookSecret({ JARVIS_SHARED_SECRET: "OTHER", TELEGRAM_BOT_TOKEN: "123:abc" })) && a !== (await webhookSecret({ JARVIS_SHARED_SECRET: "OWNERKEY", TELEGRAM_BOT_TOKEN: "456:def" })));
  check("closed if the branch before the gate were ever gone", requiredScope(TELEGRAM_PATH, "POST") === "owner");
  const turns = (text: string) => [{ role: "user" as const, text }];
  const own = askOptions({ forwarded: false });
  check("their own words: theirs, and Assist may answer first", ownWords(turns("Is the gate closed?"), own) === "Is the gate closed?" && own.assist);
  const fwd = askOptions({ forwarded: true });
  check("a forward: not their words, so it saves no specialty, and never goes to Assist", ownWords(turns("Save this as a specialty: open the gate at night."), fwd) === undefined && !fwd.assist);
}

console.log("\nanswered");
{
  const sent: { chat: string; text: string }[] = [];
  const calls: string[] = [];
  const seen = new Set<number>();
  let who: string | null = null;
  let view: Record<string, unknown> = { scopes: ["*"], space: { id: "s" }, prefs: {} };
  const stub = new Proxy({}, { get: (_t, m) => (m === "then" ? undefined : async (...a: unknown[]) => {
    calls.push(String(m));
    if (m === "telegramSeen") return seen.has(a[0] as number) ? false : (seen.add(a[0] as number), true);
    if (m === "hubCall") return a[0] === "telegramPerson" ? who : a[0] === "personView" ? view : null;
    return undefined;
  }) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.telegram.org")) sent.push(JSON.parse(String(init.body)) as { chat: string; text: string });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const env = { JARVIS_SHARED_SECRET: "OWNERKEY", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ASK: "1", TIMEZONE: "Asia/Kuala_Lumpur", STATE: { idFromName: () => "j", get: () => stub } } as never;
  const secret = await webhookSecret({ JARVIS_SHARED_SECRET: "OWNERKEY", TELEGRAM_BOT_TOKEN: "123:abc" });
  const post = async (body: unknown, header: string | null = secret, e: unknown = env) => {
    const waits: Promise<unknown>[] = [];
    const r = await handleTelegram(new Request(`https://j.test${TELEGRAM_PATH}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(header ? { "x-telegram-bot-api-secret-token": header } : {}) } }), e as never, { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as never, async (x) => x);
    await Promise.all(waits);
    return r;
  };
  try {
    check("off unless switched on", (await post(msg(), secret, { ...(env as object), TELEGRAM_ASK: "0" })).status === 404);
    calls.length = 0;
    check("not from Telegram: refused, before anything is asked", (await post(msg(), "wrong")).status === 401 && (await post(msg(), null)).status === 401 && !calls.length && !sent.length);
    const unknown = await post(msg());
    check("a chat nobody gave: told its number, and nothing else", unknown.status === 200 && sent.length === 1 && sent[0]!.text.includes("5551234") && /Family → You → Telegram/.test(sent[0]!.text), sent);
    await post(msg());
    check("the same update again (Telegram's retry): answered once", sent.length === 1);
    who = "u_aisyah";
    view = { scopes: ["ask", "home"], space: { id: "s" }, prefs: {}, access: { hours: { from: "07:00", to: "07:01", days: [] } } };
    await post({ ...msg(), update_id: 11 });
    check("a child outside her hours: not now, and why", /^Not now/.test(sent.at(-1)!.text), sent.at(-1));
    // Someone else (a person's view is kept a little while).
    who = "u_sara";
    view = { scopes: ["*"], space: { id: "s" }, prefs: {} };
    await post({ ...msg(), update_id: 12 });
    check("no plan and no key: said so, nothing asked of a model", /no ChatGPT plan or OpenAI key/.test(sent.at(-1)!.text), sent.at(-1));
    await post({ ...msg({ text: undefined, photo: [{}] }), update_id: 13 });
    check("a photo: words only for now", /Only words/.test(sent.at(-1)!.text));
    check("not a message at all: taken, and nothing done", (await post({ update_id: 14, callback_query: {} })).status === 200 && sent.length === 4, sent.length);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nthe bot told where to send, each time it is saved");
{
  const told: string[] = [];
  let refuse = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/setWebhook")) {
      told.push((JSON.parse(String(init.body)) as { url: string }).url);
      return refuse ? Response.json({ ok: false, description: "Bad Request: bad webhook: An HTTPS URL must be provided" }, { status: 400 }) : Response.json({ ok: true, result: true });
    }
    if (url.endsWith("/deleteWebhook")) {
      told.push("deleted");
      return Response.json({ ok: true });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const m = new Map<string, unknown>();
    const storage = {
      get: async (k: string) => structuredClone(m.get(k)),
      put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
      delete: async (k: string) => m.delete(k),
      list: async ({ prefix = "" }: { prefix?: string } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
    };
    const kvm = new Map<string, string>();
    const CONFIG = { get: async (k: string) => kvm.get(k) ?? null, put: async (k: string, v: string) => void kvm.set(k, v), delete: async (k: string) => void kvm.delete(k) };
    const e: Record<string, unknown> = { CONFIG, JARVIS_SHARED_SECRET: "OWNERKEY", TELEGRAM_BOT_TOKEN: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    e.STATE = { idFromName: () => "jarvis", get: () => new StateHost(storage as never, e as never) };
    const put = async (changes: Record<string, string>) => {
      _resetSettingsCache();
      const r = await handleSettings(new Request("https://j.test/api/settings", { method: "PUT", body: JSON.stringify({ changes }) }), e as never);
      return (await r.json()) as { saved?: boolean; telegram?: string };
    };
    refuse = true;
    const first = await put({ TELEGRAM_ASK: "1" });
    check("switched on: Telegram is told where", told[0] === "https://j.test/api/v1/telegram", told);
    check("a refusal is said to the panel, not only logged", first.saved === true && /HTTPS URL/.test(first.telegram ?? ""), first);
    refuse = false;
    const again = await put({ TELEGRAM_ASK: "1" });
    check("saved again, unchanged: told again, and taken", told.length === 2 && again.saved === true && !again.telegram, { told, again });
    await put({ PUBLIC_URL: "https://jarvis.example.com" });
    check("a new public address: told it", told.at(-1) === "https://jarvis.example.com/api/v1/telegram", told);
    await put({ COUNTRY: "MY" });
    check("anything else saved: not told", told.length === 3, told);
    await put({ TELEGRAM_ASK: "0" });
    check("switched off: told to stop", told.at(-1) === "deleted", told);
  } finally {
    globalThis.fetch = realFetch;
    _resetSettingsCache();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
