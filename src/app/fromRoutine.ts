import type { Alert } from "./alerts";
import { button, el } from "./ui/util";

/**
 * What a routine said, in the conversation, as Hark's chat shows what its
 * checks found: the routine's name in a pill on the asking side, tied by a
 * hook to the words under it, and pressed, that routine opens in Routines.
 * Said while this screen is open, it comes with the alert (main.ts onAlert),
 * whichever tab is up; said while it was closed, it is in the conversation
 * kept for you (conversation.ts), which the server adds it to. Each is shown
 * once.
 *
 * A background job asked for in typed chat (start_job, ask_hermes) gets the
 * same pill at once, "On it — " and its title, still working. When its result
 * comes, that pill moves down to it and takes the result's name; pressed, the
 * job opens in Jobs.
 */

export type RoutineSaid = Pick<Alert, "id" | "at" | "title" | "text"> & { routine: string };
export type JobSaid = Pick<Alert, "id" | "at" | "title" | "text"> & { job: string };

const shown = new Set<string>();
/** Jobs started from this screen and not back yet: their pills, by job id. */
const working = new Map<string, HTMLElement>();

/** When it was said: the time today, the day too before then (a kept one may be weeks old). */
const when = (at: number) =>
  new Date(at).toDateString() === new Date().toDateString()
    ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** A pill on the asking side, hooked to what is under it. */
function pillRow(label: string, small: string, onPress: () => void, cls: string, aria: string): HTMLElement {
  const row = el("div", "row you from");
  const pill = button("", onPress, cls);
  pill.append(el("span", "", label), el("small", "", small));
  pill.setAttribute("aria-label", aria);
  row.append(el("span", "hook"), pill);
  return row;
}

/** The pill naming the routine, or null when this one is in the conversation already. */
export function fromRoutine(a: RoutineSaid, open: (id: string) => void): HTMLElement | null {
  if (shown.has(a.id)) return null;
  shown.add(a.id);
  return pillRow(a.title, when(a.at), () => open(a.routine), "frompill", `${a.title}, a routine: open it`);
}

/** A job just started from this screen: its pill, working, until the result comes (fromJob). */
export function jobStarted(j: { id: string; title: string }, open: (id: string) => void): HTMLElement {
  const row = pillRow(`On it — ${j.title}`, "working", () => open(j.id), "frompill job working", `${j.title}, a job still working: open it in Jobs`);
  working.set(j.id, row);
  return row;
}

/** What a job came back with: its pill, taken from where it was started if it was here, named by the result; null when shown already. */
export function fromJob(a: JobSaid, open: (id: string) => void): HTMLElement | null {
  if (shown.has(a.id)) return null;
  shown.add(a.id);
  const row = working.get(a.job);
  working.delete(a.job);
  if (!row) return pillRow(a.title, when(a.at), () => open(a.job), "frompill job", `${a.title}, a job: open it in Jobs`);
  const pill = row.querySelector<HTMLElement>(".frompill")!;
  pill.classList.remove("working");
  pill.querySelector("span")!.textContent = a.title;
  pill.querySelector("small")!.textContent = when(a.at);
  pill.setAttribute("aria-label", `${a.title}, a job: open it in Jobs`);
  return row;
}
