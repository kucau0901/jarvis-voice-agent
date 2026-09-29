/*
 * When a Live session has been quiet long enough to let go (main.ts).
 *
 * GPT-Live bills every second a session is open, silence included, so a quiet
 * session is closed after QUIET_MS. Quiet means nobody spoke: not the driver
 * and not Jarvis, whose voice keeps playing after its words have arrived.
 *
 * Whatever is said, the session never stays open longer than WORKING_MS after
 * the driver last spoke or a request was answered. While Jarvis works on a
 * request, that is the only limit: its "still working on it" is not counted,
 * or a long wait would keep the meter running forever. Nor are alerts and
 * family messages said into the session. The work survives the session
 * closing: its answer is held and said on the next tap.
 */
export const QUIET_MS = 30_000;
export const WORKING_MS = 120_000;
/**
 * How long after Jarvis's last words a sound from its side still counts as
 * its voice. Past that it is not speech, and must not hold the session open.
 */
export const VOICE_TAIL_MS = 60_000;

export type Quiet = {
  /** When the driver last spoke, or the session went live. */
  spokeAt: number;
  /** When Jarvis last had words to say: they arrived, or were handed to it. */
  saidAt: number;
  /** When Jarvis was last heard. */
  heardAt: number;
  /** When the request being answered was answered. */
  doneAt: number;
  /** A request is being worked on. */
  working: boolean;
};

/** Milliseconds until the session should close; 0 means now. */
export function closeIn(now: number, q: Quiet): number {
  if (q.working) return Math.max(0, q.spokeAt + WORKING_MS - now);
  const heard = Math.min(q.heardAt, q.saidAt + VOICE_TAIL_MS);
  const quiet = Math.max(q.spokeAt, q.saidAt, heard) + QUIET_MS;
  return Math.max(0, Math.min(quiet, Math.max(q.spokeAt, q.doneAt) + WORKING_MS) - now);
}
