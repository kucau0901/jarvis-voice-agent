import type { Env } from "../types.ts";
import { call, explain, googleConfig, guardTool } from "./google.ts";
import { MESSAGE_ID } from "../tools/gmail.ts";

/**
 * Mail by the inboxful, for a brief (lib/brief.ts): which messages a search
 * matches, as ids, from one list call and nothing fetched for each. What
 * they say is never read here.
 */

/** Promotions still in the inbox after two days, none starred or marked important. */
export const PROMOTIONS = "in:inbox category:promotions older_than:2d -is:starred -is:important";
/** As many as Gmail lists in one call. */
export const MAX_IDS = 500;

export async function listMailIds(env: Env, query: string, max: number, signal: AbortSignal): Promise<string[] | string> {
  return guardTool(async () => {
    const cfg = googleConfig(env, "https://jarvis.invalid");
    if (!cfg) return "Gmail is not set up.";
    const n = Math.min(MAX_IDS, Math.max(1, Math.floor(max)));
    const list = await call(env, cfg, `/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${n}`, { signal });
    const problem = explain(list);
    if (problem) return problem;
    return ((list.body as { messages?: { id: string }[] } | null)?.messages ?? []).map((m) => m.id).filter((id) => MESSAGE_ID.test(id));
  }, { notLinked: "Link your Gmail in Family → Accounts to see it here.", relink: "Gmail needs linking again: Family → Accounts.", prefix: "Gmail" });
}
