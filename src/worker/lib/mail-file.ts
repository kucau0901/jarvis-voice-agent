import type { Tool } from "../tools/registry.ts";
import { MESSAGE_ID, type Part } from "../tools/gmail.ts";
import { call, explain, googleConfig, guardTool } from "./google.ts";
import { ACCOUNT_PARAM, onOne } from "./google-accounts.ts";
import { asQuotedData } from "./quote.ts";
import { fromB64u } from "./webauthn.ts";
import { WorkshopError, fileName, workshopBring, type WorkshopConfig } from "./workshop.ts";

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

/** The files attached to a message, wherever in it they are. */
export function attachedIn(part: Part | undefined, depth = 0): Attached[] {
  if (!part || depth > 8) return [];
  const own = part.filename && (part.body?.attachmentId || part.body?.data) ? [{ name: fileName(part.filename), size: part.body.size ?? 0, id: part.body.attachmentId, data: part.body.data }] : [];
  return [...own, ...(part.parts ?? []).flatMap((p) => attachedIn(p, depth + 1))];
}

const path = (id: string) => `/users/me/messages/${id}`;

export function mailFile(cfg: WorkshopConfig, job: string): Tool {
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
      return onOne(ctx, args.account, (ctx) => guardTool(async () => {
        const g = googleConfig(ctx.env, "https://jarvis.invalid");
        if (!g) return "Gmail is not set up.";
        const r = await call(ctx.env, g, `${path(id)}?format=full`, { signal: ctx.signal });
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
          const a = await call(ctx.env, g, `${path(id)}/attachments/${encodeURIComponent(f.id)}`, { signal: ctx.signal });
          const problem = explain(a);
          if (problem) return problem;
          data = (a.body as { data?: string } | null)?.data;
        }
        if (!data) return "Gmail did not give that file.";
        try {
          const bytes = fromB64u(data.replace(/=+$/, ""));
          await workshopBring(cfg, job, f.name, bytes, ctx.signal);
          return `It is in the folder, ${bytes.length.toLocaleString("en-US")} bytes.\n${asQuotedData("its name", f.name)}`;
        } catch (e) {
          if (e instanceof WorkshopError) return `Not done: ${e.message}.`;
          throw e;
        }
      }, { notLinked: "This person's Gmail is not linked.", prefix: "Gmail error" }), { path: `${path(id)}?format=minimal` });
    },
  };
}
