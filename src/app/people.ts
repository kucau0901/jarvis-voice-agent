import { authHeaders } from "./key";

/**
 * The people signed in on this screen.
 *
 * A phone is one person's. The family car is everyone's: each person is added
 * once (paired from their phone) and the screen keeps each one's sign-in, one
 * of them in use. Switching puts the one in use aside — locked on the server
 * if they have a PIN, so their profile does nothing until it is given again —
 * and takes up another (src/worker/lib/hub.ts).
 *
 * The one in use is also kept where the key always was (key.ts), so
 * everything else in the app is unchanged.
 */

export interface Person {
  id: string;
  name: string;
  token: string;
  hasPin: boolean;
}

const STORE = "jarvis.people";

export function loadPeople(): Person[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as Person[]).filter((p) => p && typeof p.token === "string" && typeof p.id === "string") : [];
  } catch {
    return [];
  }
}

function save(list: Person[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    // Private mode: this screen holds one person at a time.
  }
}

/** Add or refresh someone; one entry per person. Returns the token it replaced, if any. */
export function keepPerson(p: Person): string | null {
  const list = loadPeople();
  const at = list.findIndex((x) => x.id === p.id);
  const old = at >= 0 && list[at]!.token !== p.token ? list[at]!.token : null;
  if (at >= 0) list[at] = p;
  else list.push(p);
  save(list);
  return old;
}

export function dropPerson(token: string): void {
  save(loadPeople().filter((p) => p.token !== token));
}

async function post(token: string, path: string, body: unknown = {}): Promise<Response> {
  return fetch(path, { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) });
}

/** Who a sign-in belongs to, and whether it is locked; "gone" if it no longer works. */
export async function describe(token: string): Promise<(Omit<Person, "token"> & { locked: boolean }) | "gone" | null> {
  try {
    const res = await fetch("/api/hub/me", { headers: authHeaders(token) });
    if (res.status === 401) return "gone";
    if (!res.ok) return null;
    const me = (await res.json()) as { user: { id: string; name: string } | null; hasPin?: boolean; locked?: boolean };
    if (!me.user) return null;
    return { id: me.user.id, name: me.user.name, hasPin: !!me.hasPin, locked: !!me.locked };
  } catch {
    return null;
  }
}

/** Put someone aside. True if they are now locked (they have a PIN). */
export async function lockPerson(token: string): Promise<boolean> {
  try {
    const res = await post(token, "/api/hub/lock");
    return res.ok && ((await res.json()) as { locked?: boolean }).locked === true;
  } catch {
    return false;
  }
}

/** Take someone back up with their PIN; throws with the reason if not. */
export async function unlockPerson(token: string, pin: string): Promise<void> {
  const res = await post(token, "/api/hub/unlock", { pin });
  if (res.ok) return;
  const b = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(b.error ?? `the server said ${res.status}`);
}

/** End a sign-in for good (signing someone out of this screen). */
export async function endSignIn(token: string): Promise<void> {
  await post(token, "/api/hub/signout").catch(() => {});
}
