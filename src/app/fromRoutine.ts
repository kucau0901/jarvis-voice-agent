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
 */

export type RoutineSaid = Pick<Alert, "id" | "at" | "title" | "text"> & { routine: string };

const shown = new Set<string>();

/** When it was said: the time today, the day too before then (a kept one may be weeks old). */
const when = (at: number) =>
  new Date(at).toDateString() === new Date().toDateString()
    ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** The pill naming the routine, or null when this one is in the conversation already. */
export function fromRoutine(a: RoutineSaid, open: (id: string) => void): HTMLElement | null {
  if (shown.has(a.id)) return null;
  shown.add(a.id);
  const row = el("div", "row you from");
  const pill = button("", () => open(a.routine), "frompill");
  pill.append(el("span", "", a.title), el("small", "", when(a.at)));
  pill.setAttribute("aria-label", `${a.title}, a routine: open it`);
  row.append(el("span", "hook"), pill);
  return row;
}
