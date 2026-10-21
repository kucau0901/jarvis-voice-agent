import type { Env } from "../types.ts";
import { call, explain, googleConfig, guardTool } from "./google.ts";
import { tidy } from "./quote.ts";
import { headerOf, hydrate, MESSAGE_ID, senderName } from "../tools/gmail.ts";
import type { Tool } from "../tools/registry.ts";

/**
 * Mail by the inboxful, for a brief (lib/brief.ts): which messages a search
 * matches, as ids, from one list call and nothing fetched for each; and the
 * one bulk change Jarvis makes, archiving old promotions, with Put back.
 *
 * The bulk change is the single exception to mail_manage's one message a
 * call (docs/DESIGN.md, "Mail"): code chooses the messages, from a search
 * fixed here, never a model; the count on the card is what runs; it only
 * takes messages out of the Inbox, never trashes or deletes; and it is made
 * only by a tap (lib/approval.ts APPROVED_ONLY), never offered to the router
 * or to a job.
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

/** What a brief's archive card is about: the kind, not the ids, which change every day. */
export const PROMOTIONS_ABOUT = "inbox:promotions";
/** At most this many archived on one card, the oldest first. */
export const MAX_BATCH = 150;

/** Gmail ids as code listed them: at most MAX_BATCH, each Gmail-shaped, none twice; null otherwise. */
function idsOf(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.length || v.length > MAX_BATCH) return null;
  const ids = v.filter((x): x is string => typeof x === "string" && MESSAGE_ID.test(x));
  return ids.length === v.length && new Set(ids).size === ids.length ? ids : null;
}

const many = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** Who sent a few of them and what about, for the card: the ids alone say nothing. */
export async function sampleOf(env: Env, ids: readonly string[], signal: AbortSignal): Promise<string | null> {
  const cfg = googleConfig(env, "https://jarvis.invalid");
  if (!cfg || !ids.length) return null;
  const got = await hydrate({ env, signal }, cfg, ids.slice(0, 5), "metadata").catch(() => []);
  return got.length ? `Among them:\n${got.map((m) => `${senderName(headerOf(m, "From")).slice(0, 60)}: ${tidy(headerOf(m, "Subject")).slice(0, 100) || "(no subject)"}`).join("\n")}` : null;
}

/** The same messages, labels changed in one call; why not, in words. */
async function relabel(env: Env, ids: readonly string[], change: { addLabelIds?: string[]; removeLabelIds?: string[] }, signal: AbortSignal): Promise<string | null> {
  const cfg = googleConfig(env, "https://jarvis.invalid");
  if (!cfg) return "Gmail is not set up.";
  const res = await call(env, cfg, "/users/me/messages/batchModify", { method: "POST", body: { ids, ...change }, signal });
  return explain(res) ?? (res.status === 200 || res.status === 204 ? null : `Gmail returned ${res.status}.`);
}

const available = (env: Env) => !!googleConfig(env, "https://jarvis.invalid");
const BULK = { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, total: { type: "integer" } }, required: ["ids", "total"], additionalProperties: false };
const guarded = { notLinked: "Link your Gmail in Family → Accounts first.", relink: "Gmail needs linking again: Family → Accounts.", prefix: "Gmail" };

export const mailArchiveMany: Tool = {
  name: "mail_archive_many",
  scope: "mail",
  available,
  description: "Archive old promotions in the Inbox: for an approval only.",
  parameters: BULK,
  // Reversible (Put back), with no kind a standing permission could name: it always waits for a tap.
  propose(args) {
    const ids = idsOf(args.ids);
    const total = typeof args.total === "number" && Number.isInteger(args.total) ? args.total : -1;
    if (!ids || total < ids.length) return null;
    const of = total > ids.length ? ` (the oldest, of ${total} in your Inbox)` : "";
    return { risk: "reversible", says: `Mail: archive ${many(ids.length, "promotion")} older than 2 days${of}; they stay in All Mail`, verb: "Archive", about: PROMOTIONS_ABOUT };
  },
  detail: (args, ctx) => sampleOf(ctx.env, idsOf(args.ids) ?? [], ctx.signal),
  async run(args, ctx) {
    return (await guardTool(async () => {
      const ids = idsOf(args.ids);
      if (!ids) return "Those are not message ids, so nothing was archived.";
      // Only those still promotions in the Inbox: the set shown can only shrink.
      const still = await listMailIds(ctx.env, PROMOTIONS, MAX_IDS, ctx.signal);
      if (typeof still === "string") return `Nothing was archived. ${still}`;
      const go = ids.filter((id) => still.includes(id));
      if (!go.length) return "Nothing was archived: those have left the Inbox already.";
      const why = await relabel(ctx.env, go, { removeLabelIds: ["INBOX"] }, ctx.signal);
      if (why) return `Nothing was archived. ${why}`;
      ctx.done?.();
      return `Archived ${many(go.length, "promotion")}: they are in All Mail, and Put back returns them to the Inbox.`;
    }, guarded));
  },
};

export const mailInboxMany: Tool = {
  name: "mail_inbox_many",
  scope: "mail",
  available,
  description: "Put archived messages back in the Inbox: for an approval only (Put back).",
  parameters: BULK,
  propose(args) {
    const ids = idsOf(args.ids);
    return ids ? { risk: "reversible", says: `Mail: put ${many(ids.length, "message")} back in the Inbox`, verb: "Put back" } : null;
  },
  async run(args, ctx) {
    return (await guardTool(async () => {
      const ids = idsOf(args.ids);
      if (!ids) return "Those are not message ids, so nothing was put back.";
      const why = await relabel(ctx.env, ids, { addLabelIds: ["INBOX"] }, ctx.signal);
      if (why) return `Nothing was put back. ${why}`;
      ctx.done?.();
      return `Put ${many(ids.length, "message")} back in the Inbox.`;
    }, guarded));
  },
};
