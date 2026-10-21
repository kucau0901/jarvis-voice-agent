import type { Env } from "../types.ts";
import { call, explain, googleConfig, type GoogleConfig } from "./google.ts";
import { filed, PROPOSE_ONLY, weigh, type File } from "./proposals.ts";
import type { Tool } from "../tools/registry.ts";

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

/**
 * Sending one of the person's drafts, for an approval only (lib/proposals.ts):
 * never offered to the router, which would let a model send what Draft first
 * holds. What a background job writes is proposed as this (draftThenAsk), so
 * mail has one way out whoever wrote it: Send on the person's own tap.
 */
export const mailDraftSend: Tool = {
  name: "mail_draft_send",
  scope: "mail",
  available: (env) => !!googleConfig(env, "https://jarvis.invalid"),
  description: "Send a draft from the user's Gmail Drafts.",
  parameters: {
    type: "object",
    properties: { draft: { type: "string" }, to: { type: "string" }, subject: { type: "string" } },
    required: ["draft", "to", "subject"],
    additionalProperties: false,
  },
  propose: (args) =>
    typeof args.draft === "string" && DRAFT_ID.test(args.draft)
      ? { risk: "irreversible", says: `Send the email to ${String(args.to ?? "").slice(0, 120)}: “${String(args.subject ?? "").slice(0, 120)}”` }
      : null,
  async run(args, ctx) {
    const cfg = googleConfig(ctx.env, "https://jarvis.invalid");
    if (!cfg) return "Gmail is not configured.";
    return (await sendDraft(ctx.env, cfg, String(args.draft ?? ""), ctx.signal)) ?? `Sent the email to ${String(args.to ?? "")}.`;
  },
};

/** mail_send as a background job has it: the mail only ever drafted, in the person's Drafts, and sending it proposed. */
export function draftThenAsk(send: Tool, file: File): Tool {
  return {
    ...send,
    description: `${PROPOSE_ONLY}The email is saved to the user's Gmail Drafts, and sending it waits for their tap. ${send.description}`,
    async run(args, ctx) {
      const got: { card?: DraftCard } = {};
      const out = await send.run({ ...args, draft: true }, { ...ctx, drafted: (d) => void (got.card = d) });
      const said = typeof out === "string" ? out : out.text;
      if (!got.card) return said;
      const action = { tool: mailDraftSend.name, args: { draft: got.card.draft, to: got.card.to, subject: got.card.subject } };
      return `${said}\n${filed(await file(action, weigh(mailDraftSend, action.args)!, ctx))}`;
    },
  };
}
