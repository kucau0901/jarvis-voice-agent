import type { Env } from "../types.ts";
import { accountsOf, asAccount, call, googleConfig, type GoogleAccount } from "./google.ts";

/**
 * A person's several Google accounts, as the mail and calendar tools use
 * them (lib/google.ts keeps the links). With one account every tool does
 * and says exactly what it did before there could be two.
 *
 * A read covers every account, each under its address. An action goes to
 * one: the account named, else the one that has the message or event it
 * acts on, else the first. The addresses are the person's own, given by
 * Google when each was linked, so they are said plainly, not quoted.
 */

/** The `account` every such tool takes. */
export const ACCOUNT_PARAM = {
  type: ["string", "null"],
  description:
    "Which of the user's Google accounts, when they have several: its address, or a distinctive part of it, as a " +
    "listing gave it. Pass it for a message or event that was listed under an account, and when the user names one " +
    "('from my work email'). Null otherwise: a read then covers every account, an action uses their first.",
} as const;

/** The accounts asked for: all of them unasked, the one whose address matches, or a sentence naming those there are. */
export function pickAccounts(list: GoogleAccount[], asked: unknown): GoogleAccount[] | string {
  const want = typeof asked === "string" ? asked.trim().toLowerCase() : "";
  if (!want || list.length === 1) return list;
  const exact = list.filter((a) => a.email === want);
  const found = exact.length ? exact : list.filter((a) => a.email.includes(want));
  if (found.length === 1) return found;
  return `No one linked Google account matches "${want}". Theirs are: ${list.map((a) => a.email || "(their first)").join(", ")}. Pass one of those addresses as account.`;
}

interface Ctx {
  env: Env;
}
const at = <C extends Ctx>(ctx: C, a: GoogleAccount): C => ({ ...ctx, env: asAccount(ctx.env, a.id) });
const named = (a: GoogleAccount) => a.email || "their first";

/** A read, on each of the person's accounts or the one named: what each says, under its address. */
export async function onEach<C extends Ctx>(ctx: C, asked: unknown, fn: (ctx: C) => Promise<string>): Promise<string> {
  const list = pickAccounts(await accountsOf(ctx.env), asked);
  if (typeof list === "string") return list;
  if (list.length === 1) return fn(at(ctx, list[0]!));
  const said = await Promise.all(list.map((a) => fn(at(ctx, a))));
  return list.map((a, i) => `Google account ${named(a)}:\n${said[i]}`).join("\n\n");
}

/**
 * The one account an action is for, as the request to make it with.
 * `has`: a path only the account holding the thing answers (a message, an
 * event), asked of each when none was named.
 */
export async function theAccount<C extends Ctx>(ctx: C, asked: unknown, has?: { path: string; base?: string }): Promise<{ ctx: C; name: string } | string> {
  const all = await accountsOf(ctx.env);
  const list = pickAccounts(all, asked);
  if (typeof list === "string") return list;
  let a = list[0]!;
  const cfg = googleConfig(ctx.env, "https://jarvis.invalid");
  if (list.length > 1 && has && cfg) {
    const there = await Promise.all(
      list.map((x) => call(asAccount(ctx.env, x.id), cfg, has.path, has.base ? { base: has.base } : {}).then((r) => r.status === 200, () => false)),
    );
    a = list[Math.max(0, there.indexOf(true))]!;
  }
  return { ctx: at(ctx, a), name: all.length > 1 ? named(a) : "" };
}

/** An action, on that one account; with several, which it was is said after. */
export async function onOne<C extends Ctx>(ctx: C, asked: unknown, fn: (ctx: C) => Promise<string>, has?: { path: string; base?: string }): Promise<string> {
  const one = await theAccount(ctx, asked, has);
  if (typeof one === "string") return one;
  const said = await fn(one.ctx);
  return one.name ? `${said} (Google account: ${one.name})` : said;
}
