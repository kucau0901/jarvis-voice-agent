import {
  HUB_METHODS,
  HubHost,
  INVITE_MS,
  PAIRING_MS,
  ROLE_SCOPES,
  SESSION_IDLE_MS,
  cleanName,
  looksLikeSession,
  scopesOf,
} from "../src/worker/lib/hub.ts";
import { sha256Hex } from "../src/worker/lib/devices.ts";
import type { StoredKey } from "../src/worker/lib/webauthn.ts";

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

const T0 = 1_800_000_000_000;
let keyN = 0;
const key = (): StoredKey => ({ id: `cred${++keyN}`, publicKey: "pk", alg: -7, counter: 0 });
const ok = <T,>(r: T | { error: string }): T => {
  if (r && typeof r === "object" && "error" in r) throw new Error(`unexpected: ${(r as { error: string }).error}`);
  return r as T;
};
const errorOf = (r: unknown) => (r && typeof r === "object" && "error" in r ? (r as { error: string }).error : "");
const lookup = async (h: HubHost, token: string, now = T0) => h.lookupSession(await sha256Hex(token), now);

console.log("claiming the hub");
const storage = fakeStorage();
const hub = new HubHost(storage);
let adminToken = "";
let adminId = "";
let space = "";
{
  const before = await hub.status();
  check("a fresh hub has no family", !before.claimed && before.space === null);
  check("a name is needed", errorOf(await hub.claim({ name: "", spaceName: "The Rahmans", agentName: "Jarvis" }, T0)) !== "");
  const first = ok(await hub.claim({ name: "Adam", spaceName: "The Rahmans", agentName: "Friday" }, T0));
  check("claiming makes the family, with the name chosen for the assistant", first.space.agentName === "Friday" && first.space.name === "The Rahmans");
  check("but nobody is admin until a passkey is made", !(await hub.status()).claimed);
  const again = ok(await hub.claim({ name: "Adam", spaceName: "The Rahman family", agentName: "Jarvis" }, T0 + 1));
  check("asked again before that, it is the same family, renamed", again.space.id === first.space.id && again.space.agentName === "Jarvis");
  space = again.space.id;

  const peek = await hub.peekInvite(again.token, T0 + 2);
  check("the admin's invite says what it is for", peek?.role === "admin" && peek.name === "Adam" && peek.agentName === "Jarvis");
  check("the first, older admin invite is void", (await hub.peekInvite(first.token, T0 + 2)) === null);
  const joined = ok(await hub.redeemInvite(again.token, { name: "Adam", key: { ...key(), id: "cred-admin" }, label: "iPhone" }, T0 + 3));
  adminToken = joined.token;
  adminId = joined.user.id;
  check("making the passkey signs them in", looksLikeSession(adminToken));
  check("and now the hub is claimed", (await hub.status()).claimed);
  check("the first invite, never used, still works? no: claiming again is refused", errorOf(await hub.claim({ name: "Eve", spaceName: "x", agentName: "y" }, T0 + 4)).includes("already has an admin"));
  check("an invite works once", errorOf(await hub.redeemInvite(again.token, { name: "Adam", key: key(), label: "x" }, T0 + 5)).includes("used"));
  const who = await lookup(hub, adminToken);
  check("their session says who they are and that they may do anything", who?.user.name === "Adam" && who.member.role === "admin" && who.scopes.join() === "*");
}

console.log("\ninviting the family");
let memberToken = "";
let memberId = "";
{
  const inv = ok(await hub.createInvite(space, { role: "adult", name: "Sara" }, adminId, T0 + 10));
  check("an invite is a token, kept only as a digest", inv.token.startsWith("jin1_") && ![...storage._m.keys()].some((k) => k.includes(inv.token)));
  check("it is listed until used", (await hub.invites(space, T0 + 11)).length === 1);
  check("an unknown role is refused", errorOf(await hub.createInvite(space, { role: "boss", name: "x" }, adminId, T0)) === "unknown role");
  const joined = ok(await hub.redeemInvite(inv.token, { name: "Sara M", key: { ...key(), id: "cred-sara" }, label: "Pixel" }, T0 + 12));
  memberToken = joined.token;
  memberId = joined.user.id;
  check("the name they give is used", joined.user.name === "Sara M");
  const who = await lookup(hub, memberToken, T0 + 13);
  check("an adult reaches what the role allows", who?.member.role === "adult" && who.scopes.join() === ROLE_SCOPES.adult.join());
  // Cars are reached only as far as their owners share them, so the car scopes are just the ceiling.
  check("their own memory and mail, but not Hermes", who!.scopes.includes("memory.read") && who!.scopes.includes("mail") && !who!.scopes.includes("hermes"));
  check("used invites are no longer listed", (await hub.invites(space, T0 + 14)).length === 0);

  const late = ok(await hub.createInvite(space, { role: "child", name: "Kid" }, adminId, T0));
  check("an expired invite is refused", errorOf(await hub.redeemInvite(late.token, { name: "Kid", key: key(), label: "x" }, T0 + INVITE_MS + 1)).includes("expired"));
  check("a made-up invite is nothing", (await hub.peekInvite("jin1_" + "a".repeat(32), T0)) === null && (await hub.peekInvite("junk", T0)) === null);
  const dup = ok(await hub.createInvite(space, { role: "guest", name: "G" }, adminId, T0 + 20));
  check("a passkey cannot be registered twice", errorOf(await hub.redeemInvite(dup.token, { name: "G", key: { ...key(), id: "cred-admin" }, label: "x" }, T0 + 21)).includes("already registered"));
  const cancelled = ok(await hub.createInvite(space, { role: "guest", name: "H" }, adminId, T0 + 22));
  check("an admin can cancel an invite", await hub.cancelInvite(space, cancelled.invite.id));
  check("and then it does not work", (await hub.peekInvite(cancelled.token, T0 + 23)) === null);
}

console.log("\nsigning in with a passkey");
{
  const pk = await hub.passkey("cred-sara");
  check("a passkey belongs to its person", pk?.user === memberId && pk.label === "Pixel");
  const r = ok(await hub.signIn("cred-sara", 5, "Pixel", T0 + 30));
  check("signing in opens a new session", r.user.id === memberId && r.token !== memberToken);
  check("and records the counter", (await hub.passkey("cred-sara"))?.counter === 5);
  check("an unknown passkey is refused", errorOf(await hub.signIn("nope", 0, "x", T0)) !== "");
  const sessions = await hub.sessionsOf(memberId);
  check("their screens are listed, without the secrets", sessions.length === 2 && sessions.every((s) => !("digest" in s)));
}

console.log("\nsessions");
{
  check("a made-up session is nothing", (await lookup(hub, "jss1_" + "b".repeat(32))) === null);
  const later = await lookup(hub, memberToken, T0 + SESSION_IDLE_MS - 1000);
  check("a session used within six months stays", later !== null);
  check("and using it keeps it going", (await lookup(hub, memberToken, T0 + 2 * SESSION_IDLE_MS - 2000)) !== null);
  const idle = ok(await hub.signIn("cred-sara", 6, "old tablet", T0 + 100));
  check("one idle longer than that is gone", (await lookup(hub, idle.token, T0 + 100 + SESSION_IDLE_MS + 1)) === null);
  const one = (await hub.sessionsOf(memberId))[0]!;
  const ended = await hub.endSession(memberId, one.id);
  check("a person can end one of their sessions", ended !== null && (await hub.sessionsOf(memberId)).every((s) => s.id !== one.id));
  check("but not someone else's", (await hub.endSession(adminId, (await hub.sessionsOf(memberId))[0]!.id)) === null);
}

console.log("\nroles and reach");
{
  const narrowed = ok(await hub.updateMember(space, memberId, { scopes: ["ask", "*", "car.read", "bogus"] }));
  check("an admin can set a member's reach; the wildcard is never given this way", narrowed.scopes?.join() === "ask,car.read");
  check("scopesOf follows it", scopesOf(narrowed).join() === "ask,car.read");
  const reset = ok(await hub.updateMember(space, memberId, { scopes: null }));
  check("and put it back to the role's", reset.scopes === undefined && scopesOf(reset).join() === ROLE_SCOPES.adult.join());
  check("the last admin cannot step down", errorOf(await hub.updateMember(space, adminId, { role: "adult" })).includes("needs an admin"));
  check("nor be removed", errorOf(await hub.removeMember(space, adminId)).includes("cannot be removed"));
  ok(await hub.updateMember(space, memberId, { role: "admin" }));
  check("with a second admin, the first can step down", !("error" in (await hub.updateMember(space, adminId, { role: "adult" }))));
  ok(await hub.updateMember(space, adminId, { role: "admin" }));
  ok(await hub.updateMember(space, memberId, { role: "adult" }));
  check("an unknown role is refused", errorOf(await hub.updateMember(space, memberId, { role: "king" })) === "unknown role");
}

console.log("\npasskeys");
{
  check("the only passkey cannot be removed", errorOf(await hub.removePasskey(memberId, "cred-sara")).includes("only passkey"));
  ok(await hub.addPasskey(memberId, { ...key(), id: "cred-laptop" }, "Laptop", T0 + 200));
  check("with two, one can go", (await hub.removePasskey(memberId, "cred-sara")) === true);
  check("nobody removes another's", errorOf(await hub.removePasskey(adminId, "cred-laptop")).includes("not your"));
  const lost = ok(await hub.createInvite(space, { role: "adult", name: "", user: memberId }, adminId, T0 + 210));
  const peek = await hub.peekInvite(lost.token, T0 + 211);
  check("a lost phone: an invite for an existing member", peek?.existing === true && peek.name === "Sara M");
  const back = ok(await hub.redeemInvite(lost.token, { name: "ignored", key: { ...key(), id: "cred-new-phone" }, label: "New phone" }, T0 + 212));
  check("adds a passkey to them, not a new person", back.user.id === memberId && (await hub.passkeysOf(memberId)).length === 2 && (await hub.members(space)).length === 2);
}

console.log("\npairing a screen");
{
  const start = ok(await hub.startPairing("Tesla browser", T0 + 300));
  check("a screen gets a short code and a token to poll with", /^[A-HJ-NP-Z2-9]{6}$/.test(start.code) && start.poll.startsWith("jpp1_"));
  check("until approved, it waits", (await hub.pollPairing(start.poll, T0 + 301)).status === "waiting");
  check("a wrong code is refused", errorOf(await hub.approvePairing("ZZZZZZ", { user: memberId, space }, memberId, T0 + 302)).includes("no screen"));
  const approved = ok(await hub.approvePairing(start.code.toLowerCase().replace(/(...)/, "$1-"), { user: memberId, space }, memberId, T0 + 303));
  check("typed in lower case, with a dash, it still matches", approved.label === "Tesla browser");
  check("it cannot be approved twice", errorOf(await hub.approvePairing(start.code, { user: adminId, space }, adminId, T0 + 304)).includes("already"));
  const done = await hub.pollPairing(start.poll, T0 + 305);
  check("the screen gets a session for whoever approved it", done.status === "approved" && done.user.id === memberId);
  if (done.status === "approved") {
    const who = await lookup(hub, done.token, T0 + 306);
    check("which works, labelled as the screen said", who?.user.id === memberId && who.session.label === "Tesla browser" && who.session.via === "pairing");
  }
  check("and the poll is spent", (await hub.pollPairing(start.poll, T0 + 307)).status === "expired");
  const slow = ok(await hub.startPairing("tablet", T0 + 400));
  check("a code nobody approves expires", (await hub.pollPairing(slow.poll, T0 + 400 + PAIRING_MS + 1)).status === "expired");
  check("a made-up poll token is nothing", (await hub.pollPairing("jpp1_" + "c".repeat(32), T0)).status === "expired");
  const later = ok(await hub.startPairing("x", T0 + 400 + PAIRING_MS + 2));
  check("expired pairings are tidied when the next starts", ![...storage._m.keys()].some((k) => k.includes(slow.code)) && later.code.length === 6);
}

console.log("\nchallenges");
{
  ok(await hub.putChallenge({ challenge: "abc", purpose: "login" }, T0));
  const c = await hub.takeChallenge("abc", T0 + 1000);
  check("a challenge is taken once", c?.purpose === "login" && (await hub.takeChallenge("abc", T0 + 1001)) === null);
  ok(await hub.putChallenge({ challenge: "late", purpose: "login" }, T0));
  check("a stale one is refused", (await hub.takeChallenge("late", T0 + 6 * 60_000)) === null);
  const h2 = new HubHost(fakeStorage());
  for (let i = 0; i < 200; i++) await h2.putChallenge({ challenge: `c${i}`, purpose: "login" }, T0);
  check("strangers cannot pile up challenges without end", errorOf(await h2.putChallenge({ challenge: "one-more", purpose: "login" }, T0)).includes("too many"));
  check("once they expire, there is room again", (await h2.putChallenge({ challenge: "later", purpose: "login" }, T0 + 6 * 60_000)) === true);
}

console.log("\nthe first person, and what each person chooses");
{
  check("the first person is whoever the owner key invited as admin", (await hub.firstPerson()) === adminId);
  const view = await hub.personView("owner");
  check("the owner key acts as them", view.name === "Adam" && view.space?.id === space);
  check("anyone else is themselves", (await hub.personView("u_nobody")).space === null);
  const who = await lookup(hub, adminToken, T0 + 900);
  check("their session says so", who?.place.first === true && who.place.space.agentName === "Jarvis");
  const prefs = await hub.setPrefs(adminId, { voice: "marin", language: "ms", telegram: " 12345 ", style: "" });
  check("a person's choices are kept, trimmed", !("error" in prefs) && prefs.voice === "marin" && prefs.telegram === "12345" && !("style" in prefs));
  check("and ride along with their session", (await lookup(hub, adminToken, T0 + 901))?.place.prefs.language === "ms");
  const cleared = await hub.setPrefs(adminId, { language: "" });
  check("an empty value clears one", !("error" in cleared) && cleared.language === undefined && cleared.voice === "marin");
}

console.log("\ncars, each with an owner, shared see or drive");
{
  const inv = ok(await hub.createInvite(space, { role: "adult", name: "Mia" }, adminId, T0 + 1000));
  const mia = ok(await hub.redeemInvite(inv.token, { name: "Mia", key: { ...key(), id: "cred-mia" }, label: "phone" }, T0 + 1001));
  const miaId = mia.user.id;
  check("the first person has the family car, whole", (await hub.carsFor("owner")).some((c) => c.id === "family" && c.level === "own"));
  check("nobody else reaches it until it is shared", (await hub.carsFor(miaId)).length === 0);
  check("only its owner shares the family car", errorOf(await hub.updateCar(miaId, "family", { shares: { [miaId]: "drive" } })).includes("only its owner"));
  check("the owner shares it to see", (await hub.updateCar("owner", "family", { name: "Adam's Model Y", shares: { [miaId]: "see" } })) === true);
  const seen = await hub.carsFor(miaId);
  check("and Mia may see it, by its name, without its key", seen.length === 1 && seen[0]!.level === "see" && seen[0]!.name === "Adam's Model Y" && !seen[0]!.token);
  check("a share to someone outside the family is ignored", (await hub.updateCar("owner", "family", { shares: { u_stranger: "drive" } })) === true && !(await hub.carsFor("u_stranger")).length);
  const added = ok(await hub.addCar(miaId, { name: "Mia's car", vin: "5YJ3000000000001", token: "tessie-mia" }, T0 + 1002));
  check("Mia adds her own car", added.level === "own" && added.vinHint === "…0001");
  check("its key is hers, for her requests", (await hub.carsFor(miaId)).some((c) => c.id === added.id && c.token === "tessie-mia"));
  check("the same car cannot be added twice", errorOf(await hub.addCar(adminId, { name: "x", vin: "5YJ3000000000001", token: "t" }, T0)).includes("already here"));
  check("she shares it with Adam to drive", (await hub.updateCar(miaId, added.id, { shares: { owner: "drive" } })) === true);
  check("Adam reaches both, his own first", (await hub.carsFor("owner")).map((c) => `${c.id === "family" ? "family" : "mia"}:${c.level}`).join() === "family:own,mia:drive");
  check("Adam cannot change Mia's car", errorOf(await hub.updateCar("owner", added.id, { name: "mine now" })).includes("only its owner"));
  const view = await hub.carsView(miaId);
  check("the app is never given a key", !JSON.stringify(view).includes("tessie-mia") && view.find((c) => c.id === added.id)?.shares?.owner === "drive");
  check("and names who owns what", view.find((c) => c.id === "family")?.ownerName === "Adam");
  ok(await hub.removeMember(space, miaId));
  check("when Mia leaves, her car goes, and so does her share of Adam's", (await hub.carsFor("owner")).length === 1 && !(await hub.carsView("owner"))[0]!.shares?.[miaId]);
}

console.log("\nPINs, for a screen several people share");
{
  const inv = ok(await hub.createInvite(space, { role: "adult", name: "Dan" }, adminId, T0 + 600));
  const dan = ok(await hub.redeemInvite(inv.token, { name: "Dan", key: { ...key(), id: "cred-dan" }, label: "car" }, T0 + 601));
  const d = await sha256Hex(dan.token);
  check("without a PIN, locking does nothing", (await hub.lockSession(d)) === false && (await hub.lookupSession(d, T0 + 602))?.session.locked === false);
  check("a PIN is 4 to 8 digits", errorOf(await hub.setPin(dan.user.id, "12a4")).includes("4 to 8") && errorOf(await hub.setPin(dan.user.id, "123")).includes("4 to 8"));
  check("a good one is set", (await hub.setPin(dan.user.id, "4821")) === true);
  check("and kept only as a hash", !JSON.stringify([...storage._m.values()]).includes("4821"));
  check("the session says there is a PIN", (await hub.lookupSession(d, T0 + 603))?.user.hasPin === true);
  check("nor does a user record handed out carry it", !("pin" in ((await hub.user(dan.user.id)) as object)));
  check("with a PIN, locking takes", (await hub.lockSession(d)) === true && (await hub.lookupSession(d, T0 + 604))?.session.locked === true);
  check("a wrong PIN does not unlock", errorOf(await hub.unlockSession(d, "0000", T0 + 605)).includes("not right") && (await hub.lookupSession(d, T0 + 606))?.session.locked === true);
  check("the right one does", (await hub.unlockSession(d, "4821", T0 + 607)) === true && (await hub.lookupSession(d, T0 + 608))?.session.locked === false);
  await hub.lockSession(d);
  for (let i = 0; i < 4; i++) await hub.unlockSession(d, "1111", T0 + 700 + i);
  const fifth = await hub.unlockSession(d, "1111", T0 + 710);
  check("five wrong in a row wait fifteen minutes", errorOf(fifth).includes("15 minutes"));
  check("even the right PIN, during the wait", errorOf(await hub.unlockSession(d, "4821", T0 + 720)).includes("try again"));
  check("after it, the right PIN works", (await hub.unlockSession(d, "4821", T0 + 710 + 15 * 60_000 + 1)) === true);
  await hub.lockSession(d);
  check("removing the PIN leaves nothing locked", (await hub.setPin(dan.user.id, null)) === true && (await hub.lookupSession(d, T0 + 800))?.session.locked === false);
  check("a gone session cannot be unlocked", errorOf(await hub.unlockSession("nope", "1234", T0)).includes("ended"));
  ok(await hub.removeMember(space, dan.user.id));
}

console.log("\nremoving someone");
{
  const before = await hub.sessionsOf(memberId);
  const r = ok(await hub.removeMember(space, memberId));
  check("their sessions end", r.ended.length === before.length && (await hub.sessionsOf(memberId)).length === 0);
  check("their passkeys go", (await hub.passkeysOf(memberId)).length === 0);
  check("and so do they", (await hub.members(space)).length === 1 && (await hub.user(memberId)) === null);
  check("a session made just before cannot come back", (await lookup(hub, memberToken, T0 + 500)) === null);
}

console.log("\nnames and the method list");
{
  check("names are one clean line", cleanName("  <b>Sara</b>\n\u0000 M ") === "b Sara /b M");
  check("and short", cleanName("x".repeat(100)).length === 40);
  check("the Worker may call only the listed methods, none of the private ones", !(HUB_METHODS as readonly string[]).includes("newSession") && HUB_METHODS.every((m) => typeof (hub as unknown as Record<string, unknown>)[m] === "function"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
