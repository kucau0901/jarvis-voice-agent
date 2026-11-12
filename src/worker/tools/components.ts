import { SdkHttpError } from "@modelcontextprotocol/client";
import { redact } from "../lib/http.ts";
import { asQuotedData } from "../lib/quote.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER } from "../lib/context.ts";
import type { Offered } from "../lib/components.ts";
import type { Tool } from "./registry.ts";
import { remoteTool, type mcpSessions, type Remote } from "./mcp.ts";

/**
 * A component's MCP server, as Jarvis reaches it (lib/components.ts,
 * tools/mcp.ts): by the address an admin gave, with its key as a Bearer
 * credential and, when a person is asking, who they are in its own system.
 * Neither goes along a redirect, and nothing else of Jarvis goes at all: not
 * a name, not a Jarvis id.
 */
export const remoteOf = (c: { label: string; name: string; url: string; key?: string }, as?: string): Remote => ({
  label: c.label,
  url: c.url,
  spokenAs: c.name,
  component: true,
  headers: { ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}), ...(as ? { "X-Jarvis-Person": as } : {}) },
});

/** As much of a failure as is shown or told. */
const MAX_FAILURE = 200;

/**
 * Why reaching a component failed, in words fit to show: an error page or a
 * transport error can quote its key back, so the key is taken out first,
 * then anything else that looks like a credential (lib/http.ts redact).
 */
export function failureOf(e: unknown, key?: string): string {
  if (e instanceof SdkHttpError && e.status >= 300 && e.status < 400) {
    return "it answered with a redirect, which is not followed with its key. Its address may have moved: add it again with the new one.";
  }
  const said = e instanceof Error ? e.message : String(e);
  return redact(key ? said.split(key).join("***") : said).slice(0, MAX_FAILURE);
}

/**
 * What a person is offered of the components shared with them (lib/components.ts
 * offeredTo), as tools: each as an admin approved it, with no call to the
 * component until one is used. The pinned description is what the model
 * reads; what a call returns, or says as it fails, is the component's own
 * words, quoted as data.
 *
 * `attended`: someone is asking, now. Then who they are in the component's
 * own system goes with each call (X-Jarvis-Person), and its acting tools are
 * theirs to use. With nobody there (a routine, a job) nobody is named to it,
 * and an acting tool runs only by the owner's leave (`alone`): checked again
 * as it runs, counted against the component's day, and told to whose work it
 * was in words code writes from the call (state.ts componentDid).
 */
export function componentTools(parts: readonly Offered[], attended: boolean, sessions?: ReturnType<typeof mcpSessions>): Tool[] {
  return parts.flatMap((part) => {
    const remote = remoteOf(part, attended ? part.as : undefined);
    return part.tools.map((t): Tool => {
      const tool = remoteTool(remote, t, sessions);
      return {
        ...tool,
        scope: "components",
        reads: t.reads,
        ...(t.alone ? { alone: true as const } : {}),
        async run(args, ctx) {
          const byItself = !attended && !t.reads;
          const state = byItself ? stateStub(ctx.env) : null;
          if (byItself) {
            const why = state ? await state.componentActs(part.id, t.name, args, Date.now()) : "Not done: nothing here can count what Jarvis does by itself.";
            if (why) return why;
          }
          let ok = false;
          try {
            const out = await tool.run(args, { ...ctx, done: () => void ((ok = true), ctx.done?.()) });
            // Its own key, quoted back in what it returned, goes no further.
            return typeof out === "string" && part.key ? out.split(part.key).join("***") : out;
          } catch (e) {
            // What its failure says is its own words too (an error page, a message), and may quote its key back.
            const said = asQuotedData(`${part.label} error`, failureOf(e, part.key), `THE ${part.label.toUpperCase()} COMPONENT`);
            return `That failed: ${part.label} could not be reached, or answered with an error.\n${said}`;
          } finally {
            if (byItself) await state?.componentDid(part.id, t.name, args, ok, ctx.env.JARVIS_PERSON || OWNER, Date.now()).catch(() => {});
          }
        },
      };
    });
  });
}
