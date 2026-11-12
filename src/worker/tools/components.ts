import { SdkHttpError } from "@modelcontextprotocol/client";
import { redact } from "../lib/http.ts";
import { asQuotedData } from "../lib/quote.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER } from "../lib/context.ts";
import type { Offered } from "../lib/components.ts";
import type { Suggested } from "../lib/component-reports.ts";
import { memoryFor } from "../lib/memory.ts";
import { RUN_MS } from "../lib/proposals.ts";
import type { Env } from "../types.ts";
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
            if (byItself) await state?.componentDid(part.id, t.name, args, ok, [ctx.env.JARVIS_PERSON || OWNER], Date.now()).catch(() => {});
          }
        },
      };
    });
  });
}

/**
 * What a report suggested that the owner lets run by itself (lib/component-reports.ts),
 * made once the component has its answer: by code, with no model, nobody
 * named to it, and told to the people its report was for in words written
 * from the call. Each was counted against its day when the report was taken.
 */
export async function runSuggested(env: Env, calls: readonly Suggested[]): Promise<void> {
  const state = stateStub(env);
  for (const c of calls) {
    let ok = false;
    const ctx = { env, signal: AbortSignal.timeout(RUN_MS), progress() {}, display() {}, memory: memoryFor(env, []), grants: [], done: () => void (ok = true) };
    await remoteTool(remoteOf(c.part), c.tool).run(c.args, ctx).catch((e: unknown) => console.warn(`component ${c.part.label}: ${failureOf(e, c.part.key)}`));
    await state?.componentDid(c.part.id, c.tool.name, c.args, ok, c.tell, Date.now()).catch(() => {});
  }
}

/**
 * The events a person's components report, for the router, so a routine can
 * be made on one by asking ("when the school says a teacher is on leave,
 * …"): each named exactly, with what it means in the component's approved
 * words, quoted as data.
 */
export function eventsSaid(parts: readonly Offered[]): string {
  const lines = parts.flatMap((p) => p.events.map((e) => `${p.label}:${e.type} (${p.name}): ${e.says}`));
  if (!lines.length) return "";
  return (
    "COMPONENTS SHARED WITH THE USER report the events below. For a routine that runs when one arrives, use routine_add " +
    "with when=event and event set to its name, exactly as written.\n" +
    asQuotedData("component events", lines.join("\n"), "THE COMPONENTS")
  );
}

/**
 * What a routine may do with these components when nobody is there, said
 * truthfully to whoever is making one, so nobody is promised an act that
 * will only be described. `only`: the label of the component whose event
 * starts it, whose tools are then all it has.
 */
export function unattendedSaid(parts: readonly Offered[], only?: string): string {
  const said = (only ? parts.filter((p) => p.label === only) : parts).flatMap((p) => {
    const acts = p.tools.filter((t) => !t.reads);
    if (!acts.length && !only) return [];
    const alone = acts.filter((t) => t.alone).map((t) => t.name);
    const asks = acts.filter((t) => !t.alone).map((t) => t.name);
    return [
      (only ? `It runs with ${p.name}'s tools and nothing else: no memory, mail, calendar, house or web. ` : "") +
        `With nobody there it reads with ${p.name}'s tools` +
        (alone.length ? `, and does by itself only what the owner set so: ${alone.join(", ")}` : acts.length ? ", and does nothing of theirs by itself" : "") +
        (asks.length ? `. It is not given ${asks.join(", ")}: ${asks.length === 1 ? "that needs" : "those need"} someone's OK, so it can only say what it would do (the owner can let a tool run by itself in Settings → Components)` : "") +
        ".",
    ];
  });
  return said.length ? ` ${said.join(" ")}` : "";
}
