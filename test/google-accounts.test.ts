// Several Google accounts for one person (lib/google.ts, lib/google-accounts.ts):
// which account a link is, what unlinking leaves, and where the mail tools go.
import { accountsOf, exchangeCode, isLinked, linkedAccounts, unlink, unlinkEveryone } from "../src/worker/lib/google.ts";
import { onEach, pickAccounts, theAccount } from "../src/worker/lib/google-accounts.ts";
import { sendDraft } from "../src/worker/lib/mail-draft.ts";
import { mailCheck, mailManage } from "../src/worker/tools/gmail.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 400) : "");
  }
}

const kv = new Map<string, string>();
const CONFIG = {
  get: async (k: string, type?: string) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)!) : kv.get(k)!) : null),
  put: async (k: string, v: string) => void kv.set(k, v),
  delete: async (k: string) => void kv.delete(k),
  list: async ({ prefix }: { prefix: string }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
};
const env = (person?: string) => ({ CONFIG, GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "secret", JARVIS_PERSON: person }) as never;
const cfg = { clientId: "id", clientSecret: "secret", redirectUri: "https://jarvis.example.com/api/google/callback" };

/**
 * A Google with mailboxes. A code "c-<name>" is exchanged for refresh
 * "r-<name>" and access "a-<name>"; refreshing gives the same access, unless
 * the mailbox is `dead`. Each mailbox answers only for what it holds.
 */
const boxes: Record<string, { email: string; dead?: boolean; messages?: string[]; drafts?: string[] }> = {};
const revoked: string[] = [];
const asked: string[] = [];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
  if (url.includes("/revoke")) return revoked.push(form.get("token") ?? ""), reply({});
  if (url.endsWith("/token")) {
    const name = (form.get("code") ?? form.get("refresh_token") ?? "").slice(2);
    if (!boxes[name] || boxes[name].dead) return reply({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    return reply({ access_token: `a-${name}`, expires_in: 3600, ...(form.get("code") ? { refresh_token: `r-${name}` } : {}) });
  }
  const name = String(new Headers(init?.headers).get("Authorization")).slice("Bearer a-".length);
  const box = boxes[name];
  if (!box) return reply({ error: { message: "Invalid Credentials" } }, 401);
  asked.push(`${name} ${init?.method ?? "GET"} ${new URL(url).pathname}`);
  if (url.includes("/users/me/profile")) return reply({ emailAddress: box.email, messagesTotal: 1 });
  if (url.includes("/users/me/drafts/send")) {
    const id = (JSON.parse(String(init?.body)) as { id: string }).id;
    return box.drafts?.includes(id) ? reply({ id: "sent" }) : reply({ error: { message: "Requested entity was not found." } }, 404);
  }
  if (url.includes("/labels/INBOX")) return reply({ messagesUnread: 0 });
  const message = /\/users\/me\/messages\/([A-Za-z0-9_-]+)/.exec(url)?.[1];
  if (message) return box.messages?.includes(message) ? reply({ id: message }) : reply({ error: { message: "Requested entity was not found." } }, 404);
  if (url.includes("/users/me/messages")) return reply({ messages: [] });
  return reply({ error: { message: "no such stand-in" } }, 500);
}) as typeof fetch;

boxes.home = { email: "Sam@example.com", messages: ["homemsg01"] };
boxes.work = { email: "sam@work.example.org", messages: ["workmsg01"], drafts: ["workdraft1"] };
boxes.club = { email: "sam@club.example.net" };

console.log("before anything is linked");
check("one unnamed first, as there always was", JSON.stringify(await accountsOf(env())) === '[{"id":"","email":""}]');
check("not linked", !(await isLinked(env())));
check("none linked", (await linkedAccounts(env(), cfg)).list.length === 0);

console.log("\nthe first link");
const first = await exchangeCode(env(), cfg, "c-home");
check("says whose it is, lower case", first.ok && first.email === "sam@example.com", first);
check("under the key one account always had", kv.get("google:refresh") === "r-home");
check("and listed", kv.get("google:accounts") === '[{"id":"","email":"sam@example.com"}]', kv.get("google:accounts"));

console.log("\nanother account");
await exchangeCode(env(), cfg, "c-work");
const two = await accountsOf(env());
const workId = two[1]?.id ?? "";
check("is one more, after the first", two.length === 2 && two[0]!.id === "" && two[1]!.email === "sam@work.example.org" && /^[a-f0-9]{8}$/.test(workId), two);
check("with its own token", kv.get(`google:refresh::${workId}`) === "r-work" && kv.get("google:refresh") === "r-home");
await exchangeCode(env(), cfg, "c-work");
check("linked again, it is the same one renewed", (await accountsOf(env())).length === 2);

console.log("\na member's are their own");
await exchangeCode(env("u_abc123"), cfg, "c-club");
await exchangeCode(env("u_abc123"), cfg, "c-work");
const theirs = await accountsOf(env("u_abc123"));
check("two of theirs", theirs.length === 2 && kv.get("google:refresh:u_abc123") === "r-club" && kv.get(`google:refresh:u_abc123:${theirs[1]!.id}`) === "r-work", [...kv.keys()]);
check("the first person's untouched", (await accountsOf(env())).length === 2);

console.log("\na link older than the list");
kv.delete("google:accounts:u_abc123");
kv.delete(`google:refresh:u_abc123:${theirs[1]!.id}`);
kv.delete(`google:access:u_abc123:${theirs[1]!.id}`);
check("is the first, its address learned and kept", JSON.stringify((await linkedAccounts(env("u_abc123"), cfg)).list) === '[{"id":"","email":"sam@club.example.net"}]');
check("kept", kv.get("google:accounts:u_abc123") === '[{"id":"","email":"sam@club.example.net"}]');
kv.delete("google:accounts:u_abc123");
kv.delete("google:access:u_abc123");
boxes.club.dead = true;
await exchangeCode(env("u_abc123"), cfg, "c-work");
check("one whose link is dead is replaced, not kept beside the new", kv.get("google:refresh:u_abc123") === "r-work" && kv.get("google:accounts:u_abc123") === '[{"id":"","email":"sam@work.example.org"}]', kv.get("google:accounts:u_abc123"));
boxes.club.dead = false;

console.log("\nwhich account a tool means");
const list = await accountsOf(env());
check("unasked, all of them", pickAccounts(list, null) === list);
check("by its address", (pickAccounts(list, "Sam@Work.example.org") as { id: string }[])[0]?.id === workId);
check("by a distinctive part", (pickAccounts(list, "work") as { id: string }[])[0]?.id === workId);
check("a part both have is neither", typeof pickAccounts(list, "sam@") === "string");
check("no match names those there are", String(pickAccounts(list, "office")).includes("sam@example.com, sam@work.example.org"));
check("with one account, whatever was asked is it", (pickAccounts([list[0]!], "work") as unknown[]).length === 1);

console.log("\nreads cover each, actions go to one");
const ctx = { env: env(), signal: new AbortController().signal, progress() {}, display() {}, memory: {}, grants: ["*"] } as never;
const said = await onEach(ctx, null, async (c: { env: { GOOGLE_ACCOUNT?: string } }) => `account ${c.env.GOOGLE_ACCOUNT ?? "first"}`);
check("each under its address", said === `Google account sam@example.com:\naccount first\n\nGoogle account sam@work.example.org:\naccount ${workId}`, said);
check("the one named alone, as it says it", (await onEach(ctx, "work", async () => "x")) === "x");
const inbox = String(await mailCheck.run({ unread_only: true, limit: null, account: null }, ctx));
check("mail_check reads both inboxes", inbox === "Google account sam@example.com:\nNo unread mail in the inbox.\n\nGoogle account sam@work.example.org:\nNo unread mail in the inbox.", inbox);
const found = await theAccount(ctx as { env: never }, null, { path: "/users/me/messages/workmsg01?format=minimal" });
check("a message's account is the one that has it", typeof found !== "string" && (found.ctx.env as { GOOGLE_ACCOUNT?: string }).GOOGLE_ACCOUNT === workId && found.name === "sam@work.example.org");
const nowhere = await theAccount(ctx as { env: never }, null, { path: "/users/me/messages/nosuchmsg1?format=minimal" });
check("one nobody has goes to the first", typeof nowhere !== "string" && (nowhere.ctx.env as { GOOGLE_ACCOUNT?: string }).GOOGLE_ACCOUNT === undefined);
asked.length = 0;
const starred = String(await mailManage.run({ message_id: "workmsg01", action: "star", account: null }, ctx));
check("mail_manage acts in the account holding the message", asked.includes("work POST /gmail/v1/users/me/messages/workmsg01/modify") && !asked.some((a) => a.startsWith("home POST")), asked);
check("and says which", starred === "Done — starred. (Google account: sam@work.example.org)", starred);
check("a draft is sent from the account that wrote it", (await sendDraft(env(), cfg, "workdraft1")) === null);
check("one in neither is gone", (await sendDraft(env(), cfg, "nosuchdraft")) === "That draft is no longer in Drafts: sent already, or deleted.");

console.log("\nunlinking");
await unlink(env(), "");
check("the first gone, the next is the first", kv.get("google:refresh") === "r-work" && !kv.has(`google:refresh::${workId}`) && kv.get("google:accounts") === '[{"id":"","email":"sam@work.example.org"}]', [...kv.entries()]);
check("Google told", revoked.includes("r-home"));
check("still linked", await isLinked(env()));
check("its calls go to the account that is left", (await linkedAccounts(env(), cfg)).list[0]?.email === "sam@work.example.org");
await exchangeCode(env(), cfg, "c-home");
const again = await accountsOf(env());
await unlink(env(), again[1]!.id);
check("another unlinked leaves the first", kv.get("google:refresh") === "r-work" && (await accountsOf(env())).length === 1 && !kv.has(`google:refresh::${again[1]!.id}`));
await unlink(env(), "");
check("the last gone, nothing is kept", !kv.has("google:refresh") && !kv.has("google:accounts") && !(await isLinked(env())));

console.log("\na change of client unlinks everyone's, every one");
await exchangeCode(env(), cfg, "c-home");
await exchangeCode(env(), cfg, "c-work");
revoked.length = 0;
await unlinkEveryone(env());
check("no token or list left", ![...kv.keys()].some((k) => k.startsWith("google:refresh") || k.startsWith("google:accounts") || k.startsWith("google:access")), [...kv.keys()]);
check("each revoked", revoked.filter((t) => t === "r-work").length === 2 && revoked.includes("r-home"), revoked);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
