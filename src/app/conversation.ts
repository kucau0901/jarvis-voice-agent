import { api, authHeaders } from "./key";
import type { History } from "./history";
import { Reply } from "./reply";
import { Attachments } from "./attach";
import type { JobSaid, RoutineSaid } from "./fromRoutine";
import { isApart, type Page } from "./madePages";

/**
 * Your conversation with Jarvis, kept on the server (lib/conversation.ts) so
 * it is here again when the app opens, as Hark's chat is: the last 200
 * messages of the past 30 days. Each question and answer is sent as it is
 * finished, typed (main.ts sendTyped) or spoken, Live or push-to-talk (as
 * each row settles); what your routines said the server keeps itself. Clear
 * chat empties it, here and on every other screen of yours.
 *
 * What the model is told with a question is only the recent part of it
 * (history.ts); it reads further back only when asked to (look_back).
 */

export interface Said {
  id: string;
  at: number;
  role: "user" | "assistant";
  text: string;
  /** What was attached, by name: the files themselves are kept nowhere (attach.ts). */
  files?: string[];
  /** The answer this question replied to (reply.ts). */
  replyTo?: string;
  routine?: { id: string; name: string };
  job?: { id: string; name: string };
  /** An answer's cited pages, drawn as cards under it (ui/rich.ts). */
  links?: { url: string; title: string }[];
  /** A page the answer made, as a card under it (pageCard.ts). */
  page?: { id: string; title: string };
}

const PATH = "/api/hub/conversation";

let n = 0;
/** A message's id, made here so that a reply can name the answer it is to. */
export const saidId = (): string => `c_${Date.now().toString(36)}${(n++ % 1296).toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Kept; when it cannot be, the conversation goes on all the same.
 * keepalive, so a row that ends as the page closes still arrives.
 */
export function keep(key: string, said: Omit<Said, "at" | "routine" | "job">): void {
  if (!key) return;
  void fetch(PATH, { method: "POST", headers: authHeaders(key), body: JSON.stringify({ said: [said] }), keepalive: true }).catch(() => {});
}

export const kept = async (key: string): Promise<Said[]> => ((await api(key, "GET", PATH)) as { said: Said[] }).said;

export const clearKept = (key: string): Promise<unknown> => api(key, "DELETE", PATH);

/** A question as the model reads it: the answer it replies to, its words, the names of what was attached. */
export const asked = (to: { text: string } | null, text: string, files: string[]): string =>
  Reply.said(to, text) + (files.length ? `\n(Attached: ${files.join(", ")})` : "");

/** How the chat is drawn (main.ts): a finished row; a routine's or a job's words under its name, false when shown already. */
export interface Rows {
  row(who: "you" | "jarvis", text: string, links?: { url: string; title: string }[], page?: { id: string; title: string }): HTMLElement;
  routine(s: RoutineSaid): boolean;
  job(s: JobSaid): boolean;
  /** A page set apart from any answer (madePages.ts): its card alone. */
  apart(page: Page): HTMLElement;
}

/** The kept conversation, drawn as it was, and told to the model as it would have been. */
export function restore(all: Said[], rows: Rows, history: History): void {
  const shown = new Map<string, { row: HTMLElement; text: string }>();
  for (const s of all) {
    if (s.routine) {
      if (rows.routine({ id: s.id, at: s.at, title: s.routine.name, text: s.text, routine: s.routine.id })) history.add("assistant", `${s.routine.name}: ${s.text}`, s.at);
      continue;
    }
    if (s.job) {
      if (rows.job({ id: s.id, at: s.at, title: s.job.name, text: s.text, job: s.job.id })) history.add("assistant", `${s.job.name}: ${s.text}`, s.at);
      continue;
    }
    if (s.page && isApart(s)) {
      rows.apart(s.page).dataset.said = s.id;
      continue;
    }
    const row = rows.row(s.role === "user" ? "you" : "jarvis", s.text, s.links, s.page);
    row.dataset.said = s.id;
    shown.set(s.id, { row, text: s.text });
    if (s.role === "assistant") {
      history.add("assistant", s.text, s.at);
      continue;
    }
    const to = (s.replyTo && shown.get(s.replyTo)) || null;
    if (s.files?.length) row.insertBefore(Attachments.named(s.files), row.querySelector(".txt"));
    if (to) Reply.hook(row, to.row);
    history.add("user", asked(to, s.text, s.files ?? []), s.at);
  }
}
