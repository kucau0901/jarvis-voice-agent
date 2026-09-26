import {
  DEFAULT_ORDER,
  deliver,
  makeAlert,
  PUSH_TTL_S,
  parseOrder,
  pushTtl,
  pushPayload,
  summarise,
  validateOrder,
  type Alert,
  type AlertState,
  type Delivery,
  type PushTarget,
} from "../src/worker/lib/alerts.ts";
import { LiveHub, cleanLabel, type LiveClient, type LiveSocket } from "../src/worker/lib/live.ts";
import { MAX_PAYLOAD, b64url, generateVapid } from "../src/worker/lib/webpush.ts";
import { StateHost, DELIVERY_LOG_MAX, MAX_PUSH_SUBS, TICKET_MS } from "../src/worker/lib/state-host.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";
import { validateChanges } from "../src/worker/lib/settings.ts";

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

/* ---------- fakes ---------------------------------------------------------- */

type Call = { url: string; init: RequestInit & { headers?: Record<string, string> } };
let calls: Call[] = [];
let answer: (url: string) => Response = () => new Response("{}", { status: 200 });
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  calls.push({ url, init: init as Call["init"] });
  return answer(url);
}) as typeof fetch;

function fakeState(opts: { live?: { open: number; visible: number; acked: string | null }; subs?: PushTarget[] } = {}) {
  const logged: Delivery[] = [];
  const results: { id: string; ok: boolean; gone: boolean }[][] = [];
  const broadcasts: number[] = [];
  let vapid: Awaited<ReturnType<typeof generateVapid>> | null = null;
  const state: AlertState = {
    async broadcast(_a, waitMs) {
      broadcasts.push(waitMs);
      return opts.live ?? { open: 0, visible: 0, acked: null };
    },
    async pushTargets() {
      vapid ??= await generateVapid();
      return { vapid, subs: opts.subs ?? [] };
    },
    async pushResults(r) {
      results.push(r);
    },
    async logDelivery(d) {
      logged.push(d);
    },
  };
  return { state, logged, results, broadcasts };
}

async function browserSub(id: string, label: string, endpoint = `https://fcm.googleapis.com/fcm/send/${id}`): Promise<PushTarget> {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  return { id, label, endpoint, p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))), subject: "https://jarvis.example.com" };
}

const alert = (over: Partial<Alert> = {}): Alert => ({ ...makeAlert({ text: "Leave in ten minutes." }, "api")!, ...over });
const env = (e: Record<string, string> = {}) => e as never;

/* ---------- the list ------------------------------------------------------- */

console.log("the order");
{
  check("default is every channel", parseOrder(undefined).join(",") === DEFAULT_ORDER);
  check("keeps the given order", parseOrder("telegram, push").join(",") === "telegram,push");
  check("drops unknowns and repeats", parseOrder("push,fax,push,LIVE").join(",") === "push,live");
  check("nothing usable falls back to all", parseOrder("fax").length === 6);
  check("the panel refuses a typo", validateOrder("live,pushh") !== null);
  check("the panel accepts a subset", validateOrder("push, telegram") === null);
  const v = validateChanges({ ALERT_ORDER: "live,carrier-pigeon" });
  check("saving a bad order is refused with a reason", !v.ok && /carrier-pigeon/.test(JSON.stringify(v)), v);
}

console.log("\nan alert from outside");
{
  check("text is required", makeAlert({ text: "  " }, "api") === null);
  const a = makeAlert({ text: "x".repeat(5000), title: "y".repeat(500), speak: false, urgent: true }, "api")!;
  check("text is capped", a.text.length === 1500);
  check("title is capped", a.title.length === 80);
  check("flags carried", a.speak === false && a.urgent === true);
  check("speaks unless told not to; urgent only when told", makeAlert({ text: "x", urgent: "yes" }, "api")!.speak && !makeAlert({ text: "x", urgent: "yes" }, "api")!.urgent);
  check("ids are unguessable and distinct", a.id.length === 12 && a.id !== makeAlert({ text: "x" }, "api")!.id);
}

/* ---------- delivery -------------------------------------------------------- */

console.log("\nan open screen that is looked at is enough");
{
  calls = [];
  const f = fakeState({ live: { open: 2, visible: 1, acked: "car" }, subs: [await browserSub("a", "Pixel")] });
  const d = await deliver(env({ TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1" }), f.state, alert());
  check("delivered live", d.deliveredBy === "live", d);
  check("says which screen", d.attempts[0]!.detail === "shown on car");
  check("nothing else was tried", d.attempts.length === 1 && calls.length === 0, calls.map((c) => c.url));
  check("logged", f.logged.length === 1 && f.logged[0]!.alert.id === d.alert.id);
}

console.log("\nno one looking: the phone gets a notification");
{
  calls = [];
  answer = () => new Response(null, { status: 201 });
  const f = fakeState({ live: { open: 1, visible: 0, acked: null }, subs: [await browserSub("a", "Pixel")] });
  const d = await deliver(env(), f.state, alert());
  check("live tried and failed, honestly", d.attempts[0]!.channel === "live" && !d.attempts[0]!.ok && /none in front/.test(d.attempts[0]!.detail), d.attempts[0]);
  check("push delivered it", d.deliveredBy === "push" && d.attempts[1]!.detail.startsWith("1 of 1"), d.attempts[1]);
  check("sent encrypted to the push service", calls[0]?.init.headers?.["content-encoding"] === "aes128gcm" && calls[0]!.url.startsWith("https://fcm.googleapis.com/"));
  check("VAPID signed", /^vapid t=.+, k=.+/.test(calls[0]?.init.headers?.authorization ?? ""));
  // High for everything: at normal, Android holds pushes for an idle phone.
  check("high urgency, a day to live", calls[0]?.init.headers?.urgency === "high" && calls[0]?.init.headers?.ttl === String(24 * 3600), calls[0]?.init.headers);
  check("the result was recorded", f.results[0]?.[0]?.ok === true);
}

console.log("\nhow long a push service may hold one");
{
  const now = 1_000_000_000;
  const a = makeAlert({ text: "Call the office" }, "routine", now)!;
  check("a day, by default", pushTtl(a, now) === PUSH_TTL_S && PUSH_TTL_S === 86_400);
  const leave = makeAlert({ title: "Time to leave", text: "Dentist at 13:00", expiresAt: now + 35 * 60_000 }, "routine", now)!;
  check("until it expires, when it does", leave.expiresAt === now + 35 * 60_000 && pushTtl(leave, now) === 35 * 60);
  check("never less than a minute, even when already due", pushTtl(leave, now + 60 * 60_000) === 60);
  check("never more than a day", pushTtl(makeAlert({ text: "x", expiresAt: now + 9e9 }, "api", now)!, now) === PUSH_TTL_S);
  check("a nonsense expiry is ignored", makeAlert({ text: "x", expiresAt: "soon" }, "api", now)!.expiresAt === undefined);
}

console.log("\na subscription that has gone is reported and dropped");
{
  calls = [];
  answer = (u) => new Response(null, { status: u.includes("/old") ? 410 : 201 });
  const f = fakeState({ subs: [await browserSub("old", "Old phone", "https://fcm.googleapis.com/fcm/send/old"), await browserSub("new", "Pixel")] });
  const d = await deliver(env(), f.state, alert());
  check("still delivered by the other", d.deliveredBy === "push");
  check("says so", /1 of 2 devices accepted; 1 no longer subscribed/.test(d.attempts[0]!.detail), d.attempts[0]);
  check("told the store it is gone", f.results[0]!.find((r) => r.id === "old")?.gone === true);
}

console.log("\nnothing set up: nothing pretended");
{
  calls = [];
  const d = await deliver(env(), fakeState().state, alert());
  check("no attempts, not delivered", d.attempts.length === 0 && d.deliveredBy === null);
  check("the summary says why", /Nothing is set up/.test(summarise(d)));
}

console.log("\nfalls through a failing channel to the next");
{
  calls = [];
  answer = (u) => (u.includes("telegram") ? Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }) : new Response("ok"));
  const d = await deliver(
    env({ ALERT_ORDER: "telegram,ntfy", TELEGRAM_BOT_TOKEN: "123456:SECRETSECRETSECRETSECRETSECRETSECRET", TELEGRAM_CHAT_ID: "42", NTFY_URL: "https://ntfy.sh/jarvis-abc" }),
    fakeState().state,
    alert(),
  );
  check("telegram failed with its reason", !d.attempts[0]!.ok && /401: Unauthorized/.test(d.attempts[0]!.detail), d.attempts[0]);
  check("ntfy delivered it", d.deliveredBy === "ntfy");
  check("the token is never in a report", !JSON.stringify(d).includes("SECRETSECRET"));
}

console.log("\nurgent, and the panel's Test, go everywhere");
{
  calls = [];
  answer = () => new Response("ok");
  const e = env({ ALERT_ORDER: "live,telegram,ntfy", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1", NTFY_URL: "https://ntfy.sh/t" });
  const f = fakeState({ live: { open: 1, visible: 1, acked: "desk" } });
  const d = await deliver(e, f.state, alert({ urgent: true }));
  check("every channel tried", d.attempts.map((a) => a.channel).join() === "live,telegram,ntfy", d.attempts);
  check("the first success is still named", d.deliveredBy === "live");
  calls = [];
  const t = await deliver(e, fakeState({ live: { open: 1, visible: 1, acked: "desk" } }).state, alert(), { every: true });
  check("Test: every channel", t.attempts.length === 3);
}

console.log("\n'send it to my phone' skips the screen you are looking at");
{
  const f = fakeState({ live: { open: 1, visible: 1, acked: "car" }, subs: [await browserSub("a", "Pixel")] });
  answer = () => new Response(null, { status: 201 });
  const d = await deliver(env(), f.state, alert(), { skipLive: true });
  check("live never asked", f.broadcasts.length === 0);
  check("went by push", d.deliveredBy === "push");
}

console.log("\na channel that throws does not stop the rest");
{
  answer = (u) => {
    if (u.includes("telegram")) throw new Error("connect failed to https://api.telegram.org/bot123:SECRET/sendMessage");
    return new Response("ok");
  };
  const d = await deliver(
    env({ ALERT_ORDER: "telegram,webhook", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1", ALERT_WEBHOOK_URL: "https://hook.example.com/x" }),
    fakeState().state,
    alert(),
  );
  check("recorded as failed", d.attempts[0]!.ok === false && d.attempts[0]!.detail.startsWith("failed"));
  check("the URL in the error is not repeated", !d.attempts[0]!.detail.includes("SECRET"), d.attempts[0]);
  check("webhook still delivered it", d.deliveredBy === "webhook");
}

/* ---------- each channel's request ----------------------------------------- */

console.log("\nwhat each channel sends");
{
  answer = () => new Response("ok");
  const a = alert({ title: "Car", text: "Charging stopped at 62%.", speak: true });
  const one = async (e: Record<string, string>) => {
    calls = [];
    await deliver(env(e), fakeState().state, a);
    return calls[0]!;
  };

  const tg = await one({ ALERT_ORDER: "telegram", TELEGRAM_BOT_TOKEN: "1:tok", TELEGRAM_CHAT_ID: "-100" });
  const tgBody = JSON.parse(String(tg.init.body));
  check("telegram: bot API, chat and text", tg.url === "https://api.telegram.org/bot1:tok/sendMessage" && tgBody.chat_id === "-100" && tgBody.text === "Car\n\nCharging stopped at 62%.", tgBody);

  const nt = await one({ ALERT_ORDER: "ntfy", NTFY_URL: "https://ntfy.example.com/jarvis-7f3", NTFY_TOKEN: "tk_abc" });
  const ntBody = JSON.parse(String(nt.init.body));
  check("ntfy: JSON to the root, topic inside", nt.url === "https://ntfy.example.com/" && ntBody.topic === "jarvis-7f3" && ntBody.title === "Car", { url: nt.url, ntBody });
  check("ntfy: token as bearer", nt.init.headers?.authorization === "Bearer tk_abc");

  const wh = await one({ ALERT_ORDER: "webhook", ALERT_WEBHOOK_URL: "https://n8n.example.com/hook/1", ALERT_WEBHOOK_SECRET: "a-long-signing-secret" });
  const raw = String(wh.init.body);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("a-long-signing-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expect = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  check("webhook: signed over the exact body", wh.init.headers?.["x-jarvis-signature"] === `sha256=${expect}`);
  check("webhook: the whole alert", JSON.parse(raw).event === "alert" && JSON.parse(raw).text === a.text);

  const ha = await one({ ALERT_ORDER: "homeassistant", HA_NOTIFY_SERVICE: "mobile_app_pixel_9", HA_BASE_URL: "https://ha.example.com", HA_TOKEN: "t" });
  check("HA: the notify service", ha.url === "https://ha.example.com/api/services/notify/mobile_app_pixel_9");
  check("HA: shown, not spoken, unless asked", JSON.parse(String(ha.init.body)).message === a.text);
  const hs = await one({ ALERT_ORDER: "homeassistant", HA_NOTIFY_SERVICE: "mobile_app_pixel_9", HA_BASE_URL: "https://ha.example.com", HA_TOKEN: "t", HA_NOTIFY_SPEAK: "1" });
  const hsBody = JSON.parse(String(hs.init.body));
  check("HA: read aloud by the Companion app when asked", hsBody.message === "TTS" && hsBody.data.tts_text === a.text, hsBody);
  calls = [];
  await deliver(env({ ALERT_ORDER: "homeassistant", HA_NOTIFY_SERVICE: "x" }), fakeState().state, a);
  check("HA: without the Home section's URL and token it is not set up", calls.length === 0);
}

console.log("\na notification's payload always fits");
{
  const long = makeAlert({ text: "東京駅まで渋滞しています。".repeat(200) }, "api")!; // 3 bytes a character
  const p = pushPayload(long);
  check("under the limit in bytes", new TextEncoder().encode(p).length <= MAX_PAYLOAD, new TextEncoder().encode(p).length);
  check("still parseable, and marked as cut", JSON.parse(p).text.endsWith("…"));
  check("a short one is untouched", JSON.parse(pushPayload(alert())).text === "Leave in ten minutes.");
}

/* ---------- open screens ---------------------------------------------------- */

function sock(c: LiveClient | null, sink: string[] = []) {
  let cur = c;
  const s: LiveSocket & { sent: string[]; cur(): LiveClient | null } = {
    sent: sink,
    send: (d) => void sink.push(d),
    client: () => cur,
    update: (n) => void (cur = n),
    cur: () => cur,
  };
  return s;
}
const client = (label: string, visible: boolean): LiveClient => ({ who: "owner", label, visible, since: 1 });

console.log("\nopen screens");
{
  const hub = new LiveHub();
  const car = sock(client("car", true));
  const desk = sock(client("desk", false));
  const a = alert();
  const p = hub.broadcast([car, desk], a, 2000);
  check("every open screen is sent it", car.sent.length === 1 && desk.sent.length === 1 && JSON.parse(car.sent[0]!).alert.id === a.id);
  hub.receive(desk, JSON.stringify({ type: "ack", id: a.id, visible: false }));
  hub.receive(car, JSON.stringify({ type: "ack", id: a.id, visible: true }));
  const r = await p;
  check("a visible screen's confirmation counts", r.acked === "car" && r.open === 2 && r.visible === 1, r);

  const hidden = await hub.broadcast([sock(client("desk", false))], alert(), 2000);
  check("nobody looking: no wait at all", hidden.acked === null && hidden.visible === 0);

  const t0 = Date.now();
  const silent = await hub.broadcast([sock(client("car", true))], alert(), 150);
  check("a visible screen that never confirms times out", silent.acked === null && Date.now() - t0 >= 140);

  const s = sock(client("phone", false));
  hub.receive(s, JSON.stringify({ type: "presence", visible: true }));
  check("presence is remembered", s.cur()!.visible === true);
  hub.receive(s, "not json");
  hub.receive(s, JSON.stringify({ type: "presence", visible: "yes" }));
  check("junk is ignored", s.cur()!.visible === true);
  check("a socket with no identity is skipped", (await hub.broadcast([sock(null)], alert(), 0)).open === 0);
  check("labels are cleaned", cleanLabel("<b>car</b>\n", "x") === "bcar/b" && cleanLabel("", "a screen") === "a screen" && cleanLabel("x".repeat(99), "") .length === 40);
}

/* ---------- the object's storage ------------------------------------------- */

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) =>
      new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
    _m: m,
  };
}

console.log("\nstorage: notifications");
{
  const store = fakeStorage();
  const host = new StateHost(store, {} as never);
  const k1 = await host.vapid();
  check("one key pair, kept", (await host.vapid()).publicKey === k1.publicKey && (await host.vapidPublicKey()) === k1.publicKey);

  const s = await browserSub("x", "Pixel");
  const base = { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, subject: s.subject, who: "owner", label: "Pixel" };
  const a = await host.addPushSub(base, 1);
  const b = await host.addPushSub({ ...base, label: "Pixel 9" }, 2);
  check("the same browser again replaces, not adds", a.id === b.id && (await host.listPushSubs()).length === 1 && (await host.listPushSubs())[0]!.label === "Pixel 9");

  for (let i = 0; i < MAX_PUSH_SUBS + 2; i++) {
    await host.addPushSub({ ...base, endpoint: `https://fcm.googleapis.com/fcm/send/n${i}` }, 10 + i);
  }
  const all = await host.listPushSubs();
  check("capped", all.length === MAX_PUSH_SUBS, all.length);
  check("the stalest went first", !all.some((x) => x.id === a.id));

  const t = await host.pushTargets();
  check("targets carry what sending needs, and the key", t.subs.length === MAX_PUSH_SUBS && !!t.vapid.privateJwk.d && !("who" in t.subs[0]!));

  const victim = all[0]!.id;
  await host.pushResults([{ id: victim, ok: false, gone: true }]);
  check("gone is removed", !(await host.listPushSubs()).some((x) => x.id === victim));
  const flaky = all[1]!.id;
  for (let i = 0; i < 9; i++) await host.pushResults([{ id: flaky, ok: false, gone: false }]);
  check("nine refusals are tolerated", (await host.listPushSubs()).find((x) => x.id === flaky)?.failures === 9);
  await host.pushResults([{ id: flaky, ok: true, gone: false }], 99);
  const healed = (await host.listPushSubs()).find((x) => x.id === flaky)!;
  check("one success resets the count", healed.failures === 0 && healed.okAt === 99);
  for (let i = 0; i < 10; i++) await host.pushResults([{ id: flaky, ok: false, gone: false }]);
  check("ten in a row and it is dropped", !(await host.listPushSubs()).some((x) => x.id === flaky));

  await host.addPushSub({ ...base, endpoint: "https://fcm.googleapis.com/fcm/send/dev", who: "dev_1" });
  check("a revoked device's notifications go", (await host.forgetPushFor("dev_1")) === 1);
  check("by endpoint, for the browser that owns it", await host.removePushSub(all[2]!.endpoint));
}

console.log("\nstorage: tickets");
{
  const store = fakeStorage();
  const host = new StateHost(store, {} as never);
  const t = await host.mintTicket({ who: "owner", label: "car" }, 1000);
  check("shape", /^[0-9a-hjkmnp-tv-z]{32}$/.test(t));
  check("works once", (await host.takeTicket(t, 1001))?.label === "car" && (await host.takeTicket(t, 1002)) === null);
  const late = await host.mintTicket({ who: "owner", label: "car" }, 1000);
  check("not after it expires", (await host.takeTicket(late, 1000 + TICKET_MS + 1)) === null);
  check("a malformed ticket is not even looked up", (await host.takeTicket("ticket:../x")) === null);
  await host.mintTicket({ who: "owner", label: "a" }, 1000);
  await host.mintTicket({ who: "owner", label: "b" }, 1000 + TICKET_MS * 2);
  check("expired tickets are swept", [...store._m.keys()].filter((k) => k.startsWith("ticket:")).length === 1);
}

console.log("\nstorage: the log");
{
  const host = new StateHost(fakeStorage(), {} as never);
  const first = alert();
  await host.logDelivery({ alert: first, attempts: [], deliveredBy: null });
  for (let i = 0; i < DELIVERY_LOG_MAX + 5; i++) await host.logDelivery({ alert: alert(), attempts: [], deliveredBy: null });
  check("capped, newest first", (await host.deliveries()).length === DELIVERY_LOG_MAX);
  check("an old one ages out", (await host.findAlert(first.id)) === null);
  const last = (await host.deliveries())[0]!.alert;
  check("a recent one is found by id", (await host.findAlert(last.id))?.text === last.text);
}

/* ---------- who may reach it ----------------------------------------------- */

console.log("\nscopes");
{
  for (const p of ["/api/v1/events", "/api/v1/events/ticket", "/api/v1/push", "/api/v1/notify", "/api/v1/alerts"]) {
    check(`${p} needs alerts`, requiredScope(p, "POST") === "alerts");
  }
  check("the overview is the owner's", requiredScope("/api/alerts", "GET") === "owner");
  check("so is removing a subscription", requiredScope("/api/alerts", "DELETE") === "owner");
  check("a lookalike path is the owner's", requiredScope("/api/v1/notifyx", "POST") === "owner");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
