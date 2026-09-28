import { createPasskey, usePasskey } from "./passkey";
import { screenLabel } from "./alerts";
import { authHeaders } from "./key";

/**
 * Signing in, joining a family and pairing a screen, as the app does them
 * (src/worker/routes/hub.ts is the other side). Each ends with a session
 * token, which the app keeps where it kept the owner key.
 */

async function post<T>(path: string, body: unknown, key?: string): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: key ? authHeaders(key) : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `the server said ${res.status}`);
  return data;
}

interface HubStatus {
  claimed: boolean;
  agentName: string | null;
}

export async function hubStatus(): Promise<HubStatus> {
  try {
    const res = await fetch("/api/auth/status");
    if (res.ok) return (await res.json()) as HubStatus;
  } catch {
    // Offline, or a Jarvis older than families: behave as before.
  }
  return { claimed: false, agentName: null };
}

export async function signInWithPasskey(): Promise<{ token: string; name: string }> {
  const { options } = await post<{ options: Parameters<typeof usePasskey>[0] }>("/api/auth/login/options", {});
  const credential = await usePasskey(options);
  return post("/api/auth/login/verify", { credential, label: screenLabel() });
}

interface InviteInfo {
  spaceName: string;
  agentName: string;
  role: string;
  name: string;
  existing: boolean;
}

export const inviteInfo = (token: string) => post<InviteInfo>("/api/auth/invite", { token });

/** Use an invite: make a passkey on this device, and be signed in with it. */
export async function joinWithInvite(token: string, name: string): Promise<{ token: string; name: string; agentName: string }> {
  const { options } = await post<{ options: Parameters<typeof createPasskey>[0] }>("/api/auth/invite/options", { token, name });
  const credential = await createPasskey(options);
  return post("/api/auth/invite/verify", { token, name, credential, label: screenLabel() });
}

/** Another passkey for whoever is signed in: a second phone, a laptop. */
export async function addPasskeyHere(key: string): Promise<void> {
  const { options } = await post<{ options: Parameters<typeof createPasskey>[0] }>("/api/hub/passkeys/options", {}, key);
  const credential = await createPasskey(options);
  await post("/api/hub/passkeys/verify", { credential, label: screenLabel() }, key);
}

/**
 * Show a code until someone signed in approves it on their phone. `onCode`
 * is told the code to show; the promise ends with a session, or throws when
 * the code expires or `signal` is aborted.
 */
export async function pairThisScreen(onCode: (code: string, expiresAt: number) => void, signal: AbortSignal): Promise<{ token: string; name: string }> {
  const start = await post<{ code: string; poll: string; expiresAt: number }>("/api/auth/pair/start", { label: screenLabel() });
  onCode(start.code, start.expiresAt);
  while (!signal.aborted) {
    await new Promise((r) => setTimeout(r, 4000));
    if (signal.aborted) break;
    const r = await post<{ status: string; token?: string; name?: string }>("/api/auth/pair/poll", { poll: start.poll }).catch(() => ({ status: "waiting" }) as { status: string; token?: string; name?: string });
    if (r.status === "approved" && r.token) return { token: r.token, name: r.name ?? "" };
    if (r.status === "expired") throw new Error("The code expired. Start again for a new one.");
  }
  throw new Error("Cancelled.");
}
