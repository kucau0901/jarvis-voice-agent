import type { Tool } from "../tools/registry.ts";
import { MESSAGE_ID, type Part } from "../tools/gmail.ts";
import { call, explain, googleConfig, guardTool } from "./google.ts";
import { ACCOUNT_PARAM, onOne } from "./google-accounts.ts";
import { asQuotedData } from "./quote.ts";
import { fromB64u } from "./webauthn.ts";
import { WorkshopError, apart, fileName, workshopBring, type WorkshopConfig } from "./workshop.ts";

/**
 * mail_file: a file attached to one of the user's emails, put in the folder of
 * a job that makes files (lib/workshop.ts). For a private job alone, whose
 * person's mail it may read: offered by routes/jobs.ts, in no conversation.
 * What is in it stays there: nothing of it is opened here.
 */

/** What one attachment may be: it goes whole through this Worker's memory. */
const MAX_BYTES = 15_000_000;

interface Attached {
  name: string;
  size: number;
  id?: string;
  data?: string;
}

/** The files attached to a message, wherever in it they are, each by a name of its own. */
export function attachedIn(part: Part | undefined): Attached[] {
  const found = (p: Part | undefined, depth: number): Attached[] =>
    !p || depth > 8
      ? []
      : [
          ...(p.filename && (p.body?.attachmentId || p.body?.data) ? [{ name: fileName(p.filename), size: p.body.size ?? 0, id: p.body.attachmentId, data: p.body.data }] : []),
          ...(p.parts ?? []).flatMap((x) => found(x, depth + 1)),
        ];
  const named = apart();
  return found(part, 0).map((f) => ({ ...f, name: named(f.name) }));
}

const path = (id: string) => `/users/me/messages/${id}`;

export function mailFile(cfg: WorkshopConfig, job: string, stop?: AbortSignal): Tool {
  return {
    name: "mail_file",
    pace: "fast",
    scope: "mail",
    description: "Put a file attached to one of the user's emails in this job's folder, by the message id mail_search gave. Without a name, lists what is attached to it.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message id." },
        name: { type: ["string", "null"], description: "The file's name, as listed. Null to list." },
        account: ACCOUNT_PARAM,
      },
      required: ["message", "name", "account"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = typeof args.message === "string" ? args.message.trim() : "";
      if (!MESSAGE_ID.test(id)) return "That is not a message id: mail_search gives one.";
      const want = typeof args.name === "string" ? args.name.trim() : "";
      // Its own time, from when its turn comes (lib/workshop-tools.ts).
      const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(stop ? [stop] : [])]);
      return onOne(ctx, args.account, (ctx) => guardTool(async () => {
        const g = googleConfig(ctx.env, "https://jarvis.invalid");
        if (!g) return "Gmail is not set up.";
        const r = await call(ctx.env, g, `${path(id)}?format=full`, { signal });
        const problem = explain(r);
        if (problem) return problem;
        const files = attachedIn((r.body as { payload?: Part } | null)?.payload);
        const listed = () => asQuotedData("attached", files.map((f) => `${f.name} (${f.size.toLocaleString("en-US")} bytes)`).join("\n"));
        if (!files.length) return "Nothing is attached to that message.";
        if (!want) return listed();
        const f = files.find((x) => x.name === want) ?? files.find((x) => x.name.toLowerCase() === want.toLowerCase());
        if (!f) return `No file by that name is attached to it.\n${listed()}`;
        if (f.size > MAX_BYTES) return `That file is over ${MAX_BYTES / 1_000_000} MB, so it was not brought.`;
        let data = f.data;
        if (f.id) {
          const a = await call(ctx.env, g, `${path(id)}/attachments/${encodeURIComponent(f.id)}`, { signal });
          const problem = explain(a);
          if (problem) return problem;
          data = (a.body as { data?: string } | null)?.data;
        }
        if (!data) return "Gmail did not give that file.";
        try {
          const bytes = fromB64u(data.replace(/=+$/, ""));
          // Beside no other message's: a year of statements may all have one name.
          const at = `mail/${id}/${f.name}`;
          await workshopBring(cfg, job, at, bytes, signal);
          return `It is in the folder, ${bytes.length.toLocaleString("en-US")} bytes.\n${asQuotedData("where", at)}`;
        } catch (e) {
          if (e instanceof WorkshopError) return `Not done: ${e.message}.`;
          throw e;
        }
      }, { notLinked: "This person's Gmail is not linked.", prefix: "Gmail error" }), { path: `${path(id)}?format=minimal` });
    },
  };
}
