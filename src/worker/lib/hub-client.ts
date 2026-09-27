import type { Env } from "../types";
import { sha256Hex } from "./devices.ts";
import type { HubApi, PersonView, SignedIn } from "./hub.ts";

/**
 * Reaching lib/hub.ts in the Durable Object from the Worker.
 *
 * The object has one method for all of it, `hubCall(name, args)`; this makes
 * that look like the HubHost it wraps. Null without the STATE binding: a
 * family hub needs it, and without it Jarvis runs as before, on the owner key.
 */
export function hubStub(env: Env): HubApi | null {
  const ns = env.STATE;
  if (!ns) return null;
  const stub = ns.get(ns.idFromName("jarvis")) as unknown as { hubCall(m: string, a: unknown[]): Promise<unknown> };
  return new Proxy({} as HubApi, {
    get: (_, method) =>
      // Not a thenable: an awaited proxy must not look like a promise.
      method === "then" || typeof method !== "string" ? undefined : (...args: unknown[]) => stub.hubCall(method, args),
  });
}

/*
 * Every request from a signed-in screen asks who it is. The answer is kept a
 * little while per isolate, so a busy screen costs one Durable Object call a
 * minute, not one a request. Removing someone or signing out takes at most
 * that long to be felt by other isolates; this one forgets at once.
 */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; who: SignedIn | null }>();

export async function sessionFor(env: Env, token: string): Promise<SignedIn | null> {
  const hub = hubStub(env);
  if (!hub) return null;
  const digest = await sha256Hex(token);
  const hit = cache.get(digest);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.who;
  const who = await hub.lookupSession(digest, now);
  if (cache.size > 500) cache.clear();
  // A locked profile is asked about every time, so its PIN takes effect at once.
  if (!who?.session.locked) cache.set(digest, { at: now, who });
  return who;
}

/** After signing out or removing someone: this isolate stops trusting those at once. */
export function forgetSessions(digests: string[]): void {
  for (const d of digests) cache.delete(d);
}

export function _clearSessionCache(): void {
  cache.clear();
  views.clear();
}

/** A person's name, family and choices (hub.ts personView), kept a little while per isolate like a sign-in. */
const views = new Map<string, { at: number; view: PersonView }>();

export async function personView(env: Env, person: string): Promise<PersonView> {
  const hit = views.get(person);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.view;
  const hub = hubStub(env);
  const view = hub ? await hub.personView(person).catch(() => null) : null;
  const v: PersonView = view ?? { space: null, name: null, prefs: {}, cars: [] };
  if (views.size > 200) views.clear();
  views.set(person, { at: Date.now(), view: v });
  return v;
}

/** A person's choices changed: this isolate reads them afresh. */
export function forgetPerson(person: string): void {
  views.delete(person);
}
