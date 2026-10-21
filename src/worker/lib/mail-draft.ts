import type { Env } from "../types.ts";
import { call, explain, type GoogleConfig } from "./google.ts";

/**
 * Mail written in your name, sent only by you (Settings → Google → Draft
 * first): mail_send saves a draft instead of sending (tools/gmail.ts), the
 * screen shows it as a card with Send (src/app/draft.ts), and only that tap
 * sends it (POST /api/google/drafts/send), from the person's own mailbox,
 * where alone the draft is. Gmail's Drafts are the waiting list: nothing is
 * kept here. There is no Discard: deleting a draft is for ever, and this
 * app never deletes for ever (docs/DESIGN.md "Mail").
 */

export const DRAFT_ID = /^[A-Za-z0-9_-]{5,64}$/;

/** A draft waiting for the person's tap, as the screen is told of it (lib/sse.ts "draft"). */
export interface DraftCard {
  draft: string;
  to: string;
  subject: string;
  body: string;
  reply: boolean;
}

export const draftFirst = (env: Pick<Env, "MAIL_DRAFT_FIRST">): boolean => env.MAIL_DRAFT_FIRST === "1";

/** The body with the household's footer, when it has one ("Written with Jarvis, my AI assistant"). */
export const withFooter = (body: string, env: Pick<Env, "MAIL_FOOTER">): string =>
  env.MAIL_FOOTER?.trim() ? `${body}\n\n-- \n${env.MAIL_FOOTER.trim()}` : body;

/** A draft of theirs sent, as Gmail has it now; why not, in words, when it was not. */
export async function sendDraft(env: Env, cfg: GoogleConfig, id: string, signal?: AbortSignal): Promise<string | null> {
  if (!DRAFT_ID.test(id)) return "That is not a draft's id.";
  const res = await call(env, cfg, "/users/me/drafts/send", { method: "POST", body: { id }, ...(signal ? { signal } : {}) });
  if (res.status === 404) return "That draft is no longer in Drafts: sent already, or deleted.";
  return explain(res) ?? (res.status === 200 ? null : `Gmail returned ${res.status}.`);
}
