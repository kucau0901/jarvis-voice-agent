import type { Env } from "../types";
import { err, json, publicOrigin } from "../lib/http.ts";
import { grantsOf, isAdmin, type Principal } from "../lib/auth.ts";
import { burst } from "../lib/limits.ts";
import { SCOPES, type Grant } from "../lib/scopes.ts";
import { ROLES, ROLE_SCOPES, type HubApi } from "../lib/hub.ts";
import { forgetSessions, hubStub } from "../lib/hub-client.ts";
import { sha256Hex } from "../lib/devices.ts";
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
 */

/** The digest of the session this request came with. */
async function sessionDigest(req: Request): Promise<string> {
  const raw = (req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? req.headers.get("x-jarvis-key") ?? "").trim();
  return sha256Hex(raw);
}

const body = async (req: Request): Promise<Record<string, unknown>> => {
  const b = (await req.json().catch(() => null)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};

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
  const b = await body(req);

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
  const b = m === "GET" ? {} : await body(req);
  const space = await spaceOf(hub, principal);

  if (p === "/api/hub/me") {
    if (m === "PATCH") {
      if (!me) return err(400, "the owner key is not a person; sign in with a passkey to have a name");
      const u = await hub.renameUser(me.id, b.name);
      return "error" in u ? err(400, u.error) : json({ name: u.name });
    }
    const status = await hub.status();
    const s = space ? await hub.space(space) : null;
    return json({
      owner: principal.kind === "owner",
      claimed: status.claimed,
      space: s ? { name: s.name, agentName: s.agentName } : null,
      user: me ? { id: me.id, name: me.name } : null,
      role: me ? me.role : "admin",
      // What this person may reach, so the app offers only that.
      scopes: me?.locked ? [] : grantsOf(principal),
      session: me ? me.session : null,
      hasPin: !!me?.hasPin,
      locked: !!me?.locked,
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

  if (p === "/api/hub/signout" && m === "POST") {
    if (!me) return json({ ok: true });
    const d = await hub.endSession(me.id, me.session);
    if (d) forgetSessions([d]);
    return json({ ok: true });
  }

  if (p === "/api/hub/claim" && m === "POST") {
    if (principal.kind !== "owner") return err(403, "setting up the family needs the owner key");
    const r = await hub.claim({ name: b.name, spaceName: b.spaceName, agentName: b.agentName }, now);
    return "error" in r ? err(409, r.error) : json({ token: r.token, space: { name: r.space.name, agentName: r.space.agentName } });
  }

  if (!space) return err(409, "there is no family yet: set one up with the owner key first");

  if (p === "/api/hub/members") {
    if (m === "GET") {
      const members = (await hub.members(space)).map((x) => ({
        id: x.user,
        name: x.name,
        role: x.role,
        you: me?.id === x.user,
        ...(admin ? { scopes: x.scopesNow, custom: !!x.scopes, passkeys: x.passkeys, hasPin: x.hasPin, lastSeenAt: x.lastSeenAt, addedAt: x.addedAt } : {}),
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
    if (m === "PATCH" && b.clearPin === true) {
      // A forgotten PIN: the admin takes it off, and the member sets a new one.
      if (!(await hub.member(space, user))) return err(400, "not a member");
      const r = await hub.setPin(user, null);
      return r === true ? json({ ok: true }) : err(400, r.error);
    }
    if (m === "PATCH") {
      const r = await hub.updateMember(space, user, { role: b.role, scopes: b.scopes as Grant[] | null | undefined });
      // Felt within half a minute: that is how long a sign-in is cached (lib/hub-client.ts).
      return "error" in r ? err(400, r.error) : json({ ok: true });
    }
    if (m === "DELETE") {
      const r = await hub.removeMember(space, user);
      if ("error" in r) return err(400, r.error);
      forgetSessions(r.ended);
      // A screen of theirs still open stops hearing alerts, and their phones stop being sent them.
      await stateStub(env)?.forgetDevice(user).catch(() => {});
      return json({ ok: true });
    }
    return err(405, "method not allowed");
  }

  if (p === "/api/hub/invites") {
    if (!admin) return err(403, "only an admin can invite");
    if (m === "POST") {
      const by = me?.id ?? "owner";
      const r = await hub.createInvite(space, { role: b.role, name: b.name, user: str(b.user) || undefined }, by, now);
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
    // For yourself; an admin (or the owner key) may pair a screen for any member.
    const forUser = str(b.user) || me?.id;
    if (!forUser) return err(400, "whose screen is it?");
    if (forUser !== me?.id && !admin) return err(403, "only an admin can pair a screen for someone else");
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
      return json({ ok: !!d });
    }
    return err(405, "method not allowed");
  }

  return err(404, `no route for ${p}`);
}
