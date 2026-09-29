import type { Env } from "../types.ts";
import { err, json, publicOrigin, readObjectOrEmpty } from "../lib/http.ts";
import { grantsOf, isAdmin, personOf, type Principal } from "../lib/auth.ts";
import { TTS_VOICES } from "../lib/speech.ts";
import { tessieVehicles } from "../tools/tessie.ts";
import { usePass } from "../tools/pass.ts";
import { haConfig, haUrl, passThings } from "../lib/ha.ts";
import { passActions } from "../lib/access.ts";
import { burst } from "../lib/limits.ts";
import { SCOPES, allows, type Grant } from "../lib/scopes.ts";
import { ROLES, ROLE_SCOPES, type HubApi, type Prefs } from "../lib/hub.ts";
import { forgetPerson, forgetSessions, hubStub } from "../lib/hub-client.ts";
import * as devices from "../lib/devices.ts";
import { sha256Hex } from "../lib/devices.ts";
import { deviceWho, haTokenFits } from "../lib/context.ts";
import { originOf } from "../lib/mcp-config.ts";
import { stateStub } from "../lib/state-client.ts";
import {
  creationOptions,
  fromB64u,
  newChallenge,
  requestOptions,
  siteOf,
  verifyAuthentication,
  verifyRegistration,
  type AuthenticationJSON,
  type RegistrationJSON,
} from "../lib/webauthn.ts";

/**
 * Signing in, and the family (lib/hub.ts).
 *
 * Before anyone is signed in — reachable without a credential, so each is
 * rate-limited by address and gives away nothing but the assistant's name:
 *
 *   GET  /api/auth/status          is there a family yet; what the assistant is called
 *   POST /api/auth/login/options   a passkey challenge
 *   POST /api/auth/login/verify    {credential, label} → a session
 *   POST /api/auth/invite          {token} → what the invite is for
 *   POST /api/auth/invite/options  {token} → a challenge to make a passkey with
 *   POST /api/auth/invite/verify   {token, name, credential, label} → joined, and a session
 *   POST /api/auth/pair/start      {label} → a code to show, and a token to poll with
 *   POST /api/auth/pair/poll       {poll} → waiting, expired, or a session
 *
 * Signed in (a member, or the owner key):
 *
 *   GET    /api/hub/me                       who this is
 *   PATCH  /api/hub/me                       {name}
 *   POST   /api/hub/signout                  end this screen's session
 *   POST   /api/hub/claim                    owner key: make the family and its admin's invite
 *   GET    /api/hub/members                  the family (and, for admins, pending invites)
 *   PATCH  /api/hub/members                  admin: {user, role?, scopes?}
 *   DELETE /api/hub/members                  admin: {user}
 *   POST   /api/hub/invites                  admin: {role, name} or {user} (a new passkey for them)
 *   DELETE /api/hub/invites                  admin: {id}
 *   PATCH  /api/hub/space                    admin: {name?, agentName?}
 *   POST   /api/hub/pair                     {code, user?}: approve a screen, for yourself or (admin) a member
 *   GET    /api/hub/passkeys                 yours
 *   POST   /api/hub/passkeys/options         add one on this device
 *   POST   /api/hub/passkeys/verify          {credential, label}
 *   DELETE /api/hub/passkeys                 {id}
 *   GET    /api/hub/sessions                 your signed-in screens
 *   DELETE /api/hub/sessions                 {id}
 *
 * Screens several people share (the family car), with a PIN each:
 *
 *   POST   /api/hub/pin                      {pin}: set yours; empty removes it
 *   POST   /api/hub/lock                     put this session aside: it needs the PIN again
 *   POST   /api/hub/unlock                   {pin}: take it back up (the one thing a locked session may do)
 *   PATCH  /api/hub/members                  admin: {user, clearPin: true} for a forgotten PIN
 *
 * Cars (lib/hub.ts): each person's own, shared "see" or "drive".
 *
 *   GET    /api/hub/cars                     the cars this person may reach, and their own's shares
 *   POST   /api/hub/cars                     {name, token, vin?}: add their own (the token is checked with Tessie)
 *   PATCH  /api/hub/cars                     {id, name?, shares?: {person: "see" | "drive" | null}}: its owner
 *   DELETE /api/hub/cars                     {id}: its owner
 */

/** What is wrong with a person's choices, or null. An empty value clears one. */
function prefsProblem(p: Record<string, unknown>): string | null {
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string).trim() : p[k] == null ? "" : null);
  const voice = s("voice");
  const language = s("language");
  const telegram = s("telegram");
  const style = s("style");
  const presence = s("presence");
  if (voice === null || language === null || telegram === null || style === null || presence === null) return "each choice is text";
  if (presence && !/^(person|device_tracker)\.[a-z0-9_]+$/.test(presence)) return "the Home Assistant person is an entity id such as person.aisyah";
  if (voice && !(TTS_VOICES as readonly string[]).includes(voice)) return `voice must be one of ${TTS_VOICES.join(", ")}`;
  if (language && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) return "language is a tag such as en, ms or en-GB";
  if (telegram && !/^(-?\d{3,20}|@[A-Za-z0-9_]{4,32})$/.test(telegram)) return "the Telegram chat is a number (or @channel); the bot tells you yours";
  return null;
}

/** The digest of the session this request came with. */
async function sessionDigest(req: Request): Promise<string> {
  const raw = (req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? req.headers.get("x-jarvis-key") ?? "").trim();
  return sha256Hex(raw);
}


const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The challenge a browser signed, read back out of what it signed. */
function challengeIn(credential: unknown): string {
  try {
    const c = (credential as { response?: { clientDataJSON?: unknown } })?.response?.clientDataJSON;
    const parsed = JSON.parse(new TextDecoder().decode(fromB64u(str(c)))) as { challenge?: unknown };
    return str(parsed.challenge);
  } catch {
    return "";
  }
}

const noHub = () => err(503, "signing in needs the STATE Durable Object");

/* ---------- before signing in ---------------------------------------------------- */

export async function handleAuth(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const hub = hubStub(env);
  if (!hub) return noHub();

  // Strangers can reach these, so each address gets a few a minute. Polling
  // has its own allowance: a car waiting for its code is approved polls often.
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  if (!(await burst(env, `${p === "/api/auth/pair/poll" ? "poll" : "auth"}:${ip}`))) {
    return err(429, "too many tries; wait a minute");
  }

  const now = Date.now();
  const site = siteOf(req, env.PUBLIC_URL);

  if (p === "/api/auth/status" && req.method === "GET") {
    const s = await hub.status();
    return json({ claimed: s.claimed, agentName: s.agentName });
  }
  if (req.method !== "POST") return err(405, "POST only");
  const b = await readObjectOrEmpty(req);

  switch (p) {
    case "/api/auth/login/options": {
      const challenge = newChallenge();
      const put = await hub.putChallenge({ challenge, purpose: "login" }, now);
      if (put !== true) return err(429, put.error);
      return json({ options: requestOptions({ challenge, rpId: site.rpId }) });
    }

    case "/api/auth/login/verify": {
      const credential = b.credential as AuthenticationJSON;
      const ch = await hub.takeChallenge(challengeIn(credential), now);
      if (!ch || ch.purpose !== "login") return err(400, "that sign-in took too long; try again");
      const key = await hub.passkey(str(credential?.id));
      if (!key) return err(401, "this passkey is not registered here: it may have been removed, or be for another Jarvis");
      const v = await verifyAuthentication(credential, key, { challenge: ch.challenge, ...site });
      if (!v.ok) return err(401, `the passkey was not accepted: ${v.error}`);
      const r = await hub.signIn(key.id, v.value.counter, b.label, now);
      if ("error" in r) return err(403, r.error);
      return json({ token: r.token, name: r.user.name });
    }

    case "/api/auth/invite": {
      const inv = await hub.peekInvite(str(b.token), now);
      if (!inv) return err(404, "this invite has been used or has expired; ask for a new one");
      const { digest: _, ...shown } = inv;
      return json(shown);
    }

    case "/api/auth/invite/options": {
      const inv = await hub.peekInvite(str(b.token), now);
      if (!inv) return err(404, "this invite has been used or has expired; ask for a new one");
      const challenge = newChallenge();
      const put = await hub.putChallenge({ challenge, purpose: "register", invite: inv.digest }, now);
      if (put !== true) return err(429, put.error);
      const name = str(b.name).trim().slice(0, 40) || inv.name || "Member";
      return json({
        options: creationOptions({
          challenge,
          rpId: site.rpId,
          rpName: inv.agentName,
          // The handle only has to be unique per person; the passkey's own id is what is looked up.
          userId: crypto.randomUUID(),
          userName: `${name} · ${inv.spaceName}`.slice(0, 64),
          exclude: [],
        }),
      });
    }

    case "/api/auth/invite/verify": {
      const token = str(b.token);
      const inv = await hub.peekInvite(token, now);
      if (!inv) return err(404, "this invite has been used or has expired; ask for a new one");
      const credential = b.credential as RegistrationJSON;
      const ch = await hub.takeChallenge(challengeIn(credential), now);
      if (!ch || ch.purpose !== "register" || ch.invite !== inv.digest) return err(400, "that took too long; try again");
      const v = await verifyRegistration(credential, { challenge: ch.challenge, ...site });
      if (!v.ok) return err(400, `the passkey was not accepted: ${v.error}`);
      const r = await hub.redeemInvite(token, { name: b.name, key: v.value, label: b.label }, now);
      if ("error" in r) return err(409, r.error);
      return json({ token: r.token, name: r.user.name, agentName: r.space.agentName });
    }

    case "/api/auth/pair/start": {
      const r = await hub.startPairing(b.label, now);
      if ("error" in r) return err(429, r.error);
      return json(r);
    }

    case "/api/auth/pair/poll": {
      const r = await hub.pollPairing(str(b.poll), now);
      return r.status === "approved" ? json({ status: r.status, token: r.token, name: r.user.name }) : json(r);
    }
  }
  return err(404, `no route for ${p}`);
}

/* ---------- signed in ---------------------------------------------------------------- */

/** The family, by the names cars are shared under: "owner" for the first person, else member ids. */
async function peopleOf(hub: HubApi, space: string | null): Promise<{ id: string; name: string }[]> {
  if (!space) return [];
  const first = await hub.firstPerson();
  return (await hub.members(space)).map((m) => ({ id: m.user === first ? "owner" : m.user, name: m.name }));
}

/** Which family a request acts on: a member's own, or for the owner key, the first. */
async function spaceOf(hub: HubApi, p: Principal): Promise<string | null> {
  if (p.kind === "member") return p.space;
  return (await hub.status()).space;
}

export async function handleHub(req: Request, env: Env, principal: Principal): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const hub = hubStub(env);
  if (!hub) return noHub();
  if (principal.kind === "device") return err(403, "a device cannot manage the family");
  const now = Date.now();
  const admin = isAdmin(principal);
  const me = principal.kind === "member" ? principal : null;
  const b = m === "GET" ? {} : await readObjectOrEmpty(req);
  const space = await spaceOf(hub, principal);

  if (p === "/api/hub/me") {
    if (m === "PATCH") {
      if (!me) return err(400, "the owner key is not a person; sign in with a passkey to have a name");
      // A locked profile may say who it is (index.ts LOCKED_MAY), not change anything: not where its messages go, nor its token.
      if (me.locked) return err(423, "locked: enter this person's PIN", { locked: true });
      // Everything sent is kept, not only the first thing: so choices are checked before anything is.
      const rawPrefs = b.prefs === undefined ? undefined : ((b.prefs && typeof b.prefs === "object" ? b.prefs : {}) as Record<string, unknown>);
      const badPrefs = rawPrefs && prefsProblem(rawPrefs);
      if (badPrefs) return err(400, badPrefs);
      if (b.haToken !== undefined) {
        // Their own Home Assistant user: checked with the house before it is kept, and kept for that address (lib/context.ts).
        const token = str(b.haToken).trim();
        const base = env.HA_BASE_URL ?? "";
        if (token) {
          if (!base) return err(400, "the family's Home Assistant address is not set up yet");
          if (!allows(grantsOf(principal), "home")) return err(403, "your own Home Assistant token is for those who may use the house");
          // Sent only to where they were shown (haAddress below): an admin may have changed it since.
          if (b.haBase !== originOf(base)) return err(409, "Home Assistant's address has changed: check it, then save again", { haAddress: originOf(base) });
          const ok = await fetch(haUrl(base, "/api/"), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
            .then((r) => r.ok)
            .catch(() => false);
          if (!ok) return err(400, "Home Assistant did not accept that token");
        }
        const r = await hub.setHaToken(me.id, token ? { token, base } : null);
        if (r !== true) return err(400, r.error);
        forgetPerson(personOf(principal));
        if (rawPrefs === undefined && b.name === undefined) return json({ ok: true, haToken: !!token });
      }
      if (rawPrefs !== undefined) {
        // Their own voice, language and Telegram chat (lib/context.ts), checked above.
        const r = await hub.setPrefs(me.id, rawPrefs as Prefs);
        if ("error" in r) return err(400, r.error);
        forgetSessions([await sessionDigest(req)]);
        forgetPerson(personOf(principal));
        if (b.name === undefined) return json({ prefs: r });
      }
      const u = await hub.renameUser(me.id, b.name);
      return "error" in u ? err(400, u.error) : json({ name: u.name });
    }
    const status = await hub.status();
    const s = space ? await hub.space(space) : null;
    // Locked on a shared screen: only what choosing who is using it and unlocking need
    // (who this is, whether they have a PIN), nothing of their choices, pass or reach.
    const locked = !!me?.locked;
    const haFor = me && !locked ? await hub.haTokenFor(me.id) : null;
    return json({
      owner: principal.kind === "owner",
      claimed: status.claimed,
      space: s ? { name: s.name, agentName: s.agentName } : null,
      user: me ? { id: me.id, name: me.name } : null,
      role: me ? me.role : "admin",
      prefs: locked ? {} : (me?.place?.prefs ?? {}),
      // A guest's limits: until when, which hours, and the pass's things with what each can do.
      access: !locked && me?.place?.access
        ? { ...me.place.access, allow: me.place.access.allow?.map((a) => ({ ...a, actions: passActions(a.entity) })) }
        : null,
      // Their own Home Assistant token: in use, or given for an address the house no longer has (enter it again).
      haToken: haTokenFits(haFor, env),
      haTokenStale: haFor !== null && !haTokenFits(haFor, env),
      // Where their own token is checked and sent, to see before giving it: for those who may use the house.
      // Its origin, as fetch reaches it, so a look-alike name shows as the xn-- one it is.
      haAddress: me && !locked && allows(grantsOf(principal), "home") ? originOf(env.HA_BASE_URL) : null,
      // What this person may reach, so the app offers only that.
      scopes: locked ? [] : grantsOf(principal),
      session: me ? me.session : null,
      hasPin: !!me?.hasPin,
      locked,
    });
  }

  if (p === "/api/hub/lock" && m === "POST") {
    if (!me) return json({ locked: false });
    const d = await sessionDigest(req);
    const locked = await hub.lockSession(d);
    forgetSessions([d]);
    return json({ locked });
  }

  if (p === "/api/hub/unlock" && m === "POST") {
    if (!me) return json({ ok: true });
    const d = await sessionDigest(req);
    const r = await hub.unlockSession(d, b.pin, now);
    forgetSessions([d]);
    return r === true ? json({ ok: true }) : err(403, r.error);
  }

  if (p === "/api/hub/pin" && m === "POST") {
    if (!me) return err(400, "the owner key is not a person; sign in with a passkey to have a PIN");
    const r = await hub.setPin(me.id, b.pin ?? null);
    // This screen sees the change at once; their others within half a minute.
    forgetSessions([await sessionDigest(req)]);
    return r === true ? json({ ok: true }) : err(400, r.error);
  }

  if (p === "/api/hub/cars") {
    const person = personOf(principal);
    if (m === "GET") return json({ cars: await hub.carsView(person), people: await peopleOf(hub, space) });
    if (m === "POST") {
      const token = str(b.token).trim();
      if (!token) return err(400, "the Tessie token is needed: dash.tessie.com → Settings → API");
      let found: { vin: string; name: string }[];
      try {
        found = await tessieVehicles(token, AbortSignal.timeout(12_000));
      } catch (e) {
        return err(400, `Tessie did not accept that token: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
      }
      if (!found.length) return err(400, "Tessie knows no active car for that token");
      const vin = str(b.vin).trim();
      const pick = vin ? found.find((v) => v.vin === vin) : found.length === 1 ? found[0] : null;
      if (!pick) return json({ choose: found.map((v) => ({ vin: v.vin, name: v.name })) }, { status: 409 });
      const r = await hub.addCar(person, { name: str(b.name).trim() || pick.name, vin: pick.vin, token }, now);
      forgetPerson(person);
      return "error" in r ? err(400, r.error) : json({ car: r }, { status: 201 });
    }
    if (m === "PATCH") {
      const shares = b.shares && typeof b.shares === "object" ? (b.shares as Record<string, unknown>) : undefined;
      const r = await hub.updateCar(person, str(b.id), { name: b.name, shares });
      if (r !== true) return err(400, r.error);
      // Whoever it is now shared with, or not, sees it at their next request here; elsewhere within half a minute.
      for (const who of [person, ...Object.keys(shares ?? {})]) forgetPerson(who);
      return json({ ok: true });
    }
    if (m === "DELETE") {
      const r = await hub.removeCar(person, str(b.id));
      forgetPerson(person);
      return r === true ? json({ ok: true }) : err(400, r.error);
    }
    return err(405, "method not allowed");
  }

  if (p === "/api/hub/house" && m === "GET") {
    // For an admin choosing a guest's pass: the things in the house it could work, by name.
    if (!admin) return err(403, "only an admin chooses what a pass may work");
    const ha = haConfig(env);
    if (!ha) return err(409, "the house is not connected: set Home Assistant up in Settings");
    try {
      return json({ things: await passThings(ha) });
    } catch (e) {
      return err(502, `the house did not answer: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    }
  }

  if (p === "/api/hub/pass" && m === "POST") {
    // A guest's button: one thing on their pass (tools/pass.ts), nothing else.
    return json({ text: await usePass(env, str(b.entity), str(b.action)) });
  }

  if (p === "/api/hub/signout" && m === "POST") {
    if (!me) return json({ ok: true });
    const d = await hub.endSession(me.id, me.session);
    if (d) forgetSessions([d]);
    await stateStub(env)?.closeSession(me.session).catch(() => {});
    return json({ ok: true });
  }

  if (p === "/api/hub/claim" && m === "POST") {
    if (principal.kind !== "owner") return err(403, "setting up the family needs the owner key");
    const r = await hub.claim({ name: b.name, spaceName: b.spaceName, agentName: b.agentName }, now);
    return "error" in r ? err(409, r.error) : json({ token: r.token, space: { name: r.space.name, agentName: r.space.agentName } });
  }

  if (!space) return err(409, "there is no family yet: set one up with the owner key first");

  // The first person is who the owner key acts as (lib/auth.ts): a way in as them (a screen, a
  // passkey, a cleared PIN) comes from the owner key or from them, never from another admin.
  const ownerKeyOnly = async (user: string) => principal.kind !== "owner" && user !== me?.id && user === (await hub.firstPerson());

  if (p === "/api/hub/members") {
    if (m === "GET") {
      const first = await hub.firstPerson();
      const members = (await hub.members(space)).map((x) => ({
        id: x.user,
        name: x.name,
        role: x.role,
        you: me?.id === x.user,
        // What Jarvis kept before the family is theirs, recorded as "owner" (lib/context.ts).
        first: x.user === first,
        ...(admin ? { scopes: x.scopesNow, custom: !!x.scopes, passkeys: x.passkeys, hasPin: x.hasPin, presence: x.presence, access: x.access ?? null, lastSeenAt: x.lastSeenAt, addedAt: x.addedAt } : {}),
      }));
      return json({
        members,
        ...(admin
          ? { invites: await hub.invites(space, now), roles: ROLES, roleScopes: ROLE_SCOPES, scopes: SCOPES }
          : {}),
      });
    }
    if (!admin) return err(403, "only an admin can change the family");
    const user = str(b.user);
    if (m === "PATCH" && b.presence !== undefined) {
      // Their Home Assistant person, for "when she gets home": an admin may set it for someone, a child say.
      if (!(await hub.member(space, user))) return err(400, "not a member");
      const bad = prefsProblem({ presence: b.presence });
      if (bad) return err(400, bad);
      const r = await hub.setPrefs(user, { presence: str(b.presence) });
      return "error" in r ? err(400, r.error) : json({ ok: true });
    }
    if (m === "PATCH" && b.clearPin === true) {
      // A forgotten PIN: the admin takes it off, and the member sets a new one.
      if (!(await hub.member(space, user))) return err(400, "not a member");
      if (await ownerKeyOnly(user)) return err(403, "only the owner key can clear the PIN of the person who set up the family");
      const r = await hub.setPin(user, null);
      return r === true ? json({ ok: true }) : err(400, r.error);
    }
    if (m === "PATCH") {
      const r = await hub.updateMember(space, user, { role: b.role, scopes: b.scopes as Grant[] | null | undefined, access: b.access });
      // Felt within half a minute: that is how long a sign-in is cached (lib/hub-client.ts).
      return "error" in r ? err(400, r.error) : json({ ok: true });
    }
    if (m === "DELETE") {
      const r = await hub.removeMember(space, user);
      if ("error" in r) return err(400, r.error);
      forgetSessions(r.ended);
      // A screen of theirs still open stops hearing alerts, and their phones stop being sent them.
      await stateStub(env)?.forgetDevice(user).catch(() => {});
      // What they set going stops: their routines, their turns in a rota, messages waiting on them.
      await stateStub(env)?.forgetMember(user).catch(() => {});
      // Their glasses and ESP32s are revoked, and theirs close too.
      for (const d of await devices.list(env)) {
        if (d.owner !== user || d.revokedAt) continue;
        await devices.update(env, d.id, { revoked: true });
        await stateStub(env)?.forgetDevice(deviceWho(d.id, user)).catch(() => {});
      }
      return json({ ok: true });
    }
    return err(405, "method not allowed");
  }

  if (p === "/api/hub/invites") {
    if (!admin) return err(403, "only an admin can invite");
    if (m === "POST") {
      const by = me?.id ?? "owner";
      if (str(b.user) && (await ownerKeyOnly(str(b.user)))) return err(403, "only the owner key can make a passkey link for the person who set up the family");
      const r = await hub.createInvite(space, { role: b.role, name: b.name, user: str(b.user) || undefined, access: b.access }, by, now);
      if ("error" in r) return err(400, r.error);
      const origin = publicOrigin(env, url.origin);
      return json({ token: r.token, url: `${origin}/#invite=${r.token}`, invite: r.invite });
    }
    if (m === "DELETE") return json({ ok: await hub.cancelInvite(space, str(b.id)) });
    return err(405, "method not allowed");
  }

  if (p === "/api/hub/space" && m === "PATCH") {
    if (!admin) return err(403, "only an admin can rename the family");
    const r = await hub.renameSpace(space, { name: b.name, agentName: b.agentName });
    return "error" in r ? err(400, r.error) : json({ name: r.name, agentName: r.agentName });
  }

  if (p === "/api/hub/pair" && m === "POST") {
    // For yourself; an admin (or the owner key) may pair a screen for any member but the first person.
    const forUser = str(b.user) || me?.id;
    if (!forUser) return err(400, "whose screen is it?");
    if (forUser !== me?.id && !admin) return err(403, "only an admin can pair a screen for someone else");
    if (await ownerKeyOnly(forUser)) return err(403, "only the owner key can pair a screen for the person who set up the family");
    const r = await hub.approvePairing(b.code, { user: forUser, space }, me?.id ?? "owner", now);
    return "error" in r ? err(400, r.error) : json(r);
  }

  // Passkeys and sessions are a person's own: the owner key has none.
  if (!me) return err(400, "the owner key is not a person; sign in with a passkey for this");
  const site = siteOf(req, env.PUBLIC_URL);

  if (p === "/api/hub/passkeys") {
    if (m === "GET") {
      const keys = (await hub.passkeysOf(me.id)).map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, synced: !!k.backedUp }));
      return json({ passkeys: keys });
    }
    if (m === "DELETE") {
      const r = await hub.removePasskey(me.id, str(b.id));
      return r === true ? json({ ok: true }) : err(400, r.error);
    }
    return err(405, "method not allowed");
  }
  if (p === "/api/hub/passkeys/options" && m === "POST") {
    const challenge = newChallenge();
    const put = await hub.putChallenge({ challenge, purpose: "register", user: me.id }, now);
    if (put !== true) return err(429, put.error);
    const s = await hub.space(space);
    const exclude = (await hub.passkeysOf(me.id)).map((k) => k.id);
    return json({
      options: creationOptions({
        challenge,
        rpId: site.rpId,
        rpName: s?.agentName ?? "Jarvis",
        userId: crypto.randomUUID(),
        userName: `${me.name} · ${s?.name ?? ""}`.slice(0, 64),
        exclude,
      }),
    });
  }
  if (p === "/api/hub/passkeys/verify" && m === "POST") {
    const credential = b.credential as RegistrationJSON;
    const ch = await hub.takeChallenge(challengeIn(credential), now);
    if (!ch || ch.purpose !== "register" || ch.user !== me.id) return err(400, "that took too long; try again");
    const v = await verifyRegistration(credential, { challenge: ch.challenge, ...site });
    if (!v.ok) return err(400, `the passkey was not accepted: ${v.error}`);
    const r = await hub.addPasskey(me.id, v.value, b.label, now);
    return "error" in r ? err(409, r.error) : json({ ok: true });
  }

  if (p === "/api/hub/sessions") {
    if (m === "GET") {
      const list = (await hub.sessionsOf(me.id)).map((s) => ({ ...s, current: s.id === me.session }));
      return json({ sessions: list });
    }
    if (m === "DELETE") {
      const d = await hub.endSession(me.id, str(b.id));
      if (d) forgetSessions([d]);
      if (d) await stateStub(env)?.closeSession(str(b.id)).catch(() => {});
      return json({ ok: !!d });
    }
    return err(405, "method not allowed");
  }

  return err(404, `no route for ${p}`);
}
