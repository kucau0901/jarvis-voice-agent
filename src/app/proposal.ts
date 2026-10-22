import { api } from "./key";
import { button, el } from "./ui/util";

/**
 * What a background job or a brief proposed (src/worker/lib/proposals.ts), as
 * a card: the call in words, as the server's code wrote them, where it came
 * from, how long it waits, and its verb (Approve when it has none) beside Not
 * now, or, on a brief's card, X: "Don't suggest this again", which the server
 * remembers. Only a tap here does it: nothing a model says can. Every card for
 * the same proposal on this screen (an alert's, the conversation's) shows the
 * same, once one is answered. Archived promotions can be put back for a week.
 */
export interface ProposalView {
  id: string;
  says: string;
  why: string;
  /** What it would send, as the job wrote it (an email's words): shown whole, as text. */
  body?: string;
  risk: "reversible" | "irreversible";
  state: "pending" | "running" | "done" | "failed" | "declined" | "expired" | "withdrawn";
  expires: number;
  action: { tool: string; args: Record<string, unknown> };
  outcome?: { ok: boolean; text: string };
  by?: "tap" | "standing";
  decidedAt?: number;
  /** A reversible kind (car_command:lock), which jobs may then be let do without asking. */
  category?: string;
  /** The button's word ("Lock", "Archive"); absent, Approve. */
  verb?: string;
  /** A brief's card: its X is remembered, and the next brief does not offer it again. */
  about?: string;
  /** Put back: the one it undoes; on that one, this one. */
  undoes?: string;
  undone?: string;
}

/** How long Put back is offered once promotions are archived (lib/proposals.ts UNDO_MS). */
const UNDO_MS = 7 * 86_400_000;

const SAID: Record<ProposalView["state"], string> = {
  pending: "",
  running: "Doing it…",
  done: "✓ Done",
  failed: "Didn't work",
  declined: "Not done: you said not now.",
  expired: "Not done: its time ran out.",
  withdrawn: "Not done: its job was cancelled.",
};

const left = (expires: number) => {
  const h = Math.round((expires - Date.now()) / 3_600_000);
  return h >= 1 ? `${h} h left` : "less than an hour left";
};

/** One proposal's card, as it stands. */
export function proposalCard(key: string, p: ProposalView): HTMLElement {
  const card = el("div", "pagecard proposalcard");
  card.dataset.proposal = p.id;
  draw(key, card, p);
  return card;
}

function draw(key: string, card: HTMLElement, p: ProposalView): void {
  card.dataset.state = p.state;
  card.replaceChildren(
    el("span", "doctag", p.state === "pending" ? `Waiting for your OK${p.risk === "irreversible" ? " · can't be undone" : ""}` : "Proposed"),
    el("b", "doctitle", p.says),
    ...(p.body ? [el("div", "draftbody", p.body)] : []),
    el("small", "pagesaid", p.state === "pending" ? `${p.why} · ${left(p.expires)}` : p.why),
  );
  // Not done, with why (an errand for later not needed, its event cancelled): the why is the whole line.
  const why = (p.state === "expired" || p.state === "withdrawn") && p.outcome?.text;
  const done = why || (p.state === "declined" && p.about ? "Not suggested again." : SAID[p.state]);
  const said = el("small", "pagesaid", done + (p.by === "standing" ? " without asking (you allow it)" : "") + (!why && p.outcome?.text ? `: ${p.outcome.text}` : ""));
  if (p.state !== "pending") {
    card.appendChild(said);
    if (p.state === "running") watch(key, p.id);
    // Put back tapped: its own card says what came of it, and a Put back that did not work is offered again.
    if (p.undone) card.appendChild(el("small", "pagesaid", "Put back: tapped."));
    // Archived promotions: Put back, for a week, once; its own card follows this one, as it is made.
    else if (p.state === "done" && p.by === "tap" && p.action.tool === "mail_archive_many" && Date.now() - (p.decidedAt ?? 0) < UNDO_MS) {
      const back = button("Put back", async () => {
        back.disabled = true;
        try {
          const { proposal } = (await api(key, "POST", "/api/hub/proposals/answer", { id: p.id, answer: "undo" })) as { proposal: ProposalView };
          // Every card for it on this screen says so, not only this one.
          for (const c of document.querySelectorAll<HTMLElement>(`[data-proposal="${CSS.escape(p.id)}"]`)) draw(key, c, { ...p, undone: proposal.id });
          card.after(proposalCard(key, proposal));
        } catch (e) {
          back.disabled = false;
          said.textContent = e instanceof Error ? e.message : String(e);
          void afterPutBack(key, p.id);
        }
      }, "docopen");
      const row = el("div", "mdbtns");
      row.appendChild(back);
      card.appendChild(row);
    }
    // Approved and done, and of a kind that can be put back: jobs may do it without asking from now on.
    if (p.state === "done" && p.by === "tap" && p.risk === "reversible" && p.category) {
      const allow = button("Let jobs do this without asking", async () => {
        allow.disabled = true;
        try {
          await api(key, "POST", "/api/hub/proposals/allow", { id: p.id });
          allow.replaceWith(el("small", "pagesaid", "Jobs now do this without asking. Stop it in Jobs."));
        } catch (e) {
          allow.disabled = false;
          said.textContent = e instanceof Error ? e.message : String(e);
        }
      }, "docopen");
      const row = el("div", "mdbtns");
      row.appendChild(allow);
      card.appendChild(row);
    }
    return;
  }
  const btns = el("div", "mdbtns");
  const answer = (how: "approve" | "decline") => async () => {
    for (const b of btns.querySelectorAll("button")) b.disabled = true;
    said.textContent = how === "approve" ? "Doing it…" : "";
    card.appendChild(said);
    try {
      const { proposal } = (await api(key, "POST", "/api/hub/proposals/answer", { id: p.id, answer: how })) as { proposal: ProposalView };
      settle(key, proposal);
    } catch (e) {
      // Answered elsewhere meanwhile, or gone: as it stands now. Offline, still answerable: a second approve is refused safely.
      said.textContent = e instanceof Error ? e.message : String(e);
      for (const b of btns.querySelectorAll("button")) b.disabled = false;
      void refresh(key, [p.id]);
    }
  };
  btns.append(button(p.verb ?? "Approve", answer("approve"), "docopen primary"), button(p.about ? "Don't suggest this again" : "Not now", answer("decline"), "docopen"));
  card.appendChild(btns);
}

/**
 * A Put back refused. Put back from another screen meanwhile: every card for
 * it is drawn as it now stands. Its week out, or gone: only the button goes,
 * and the reason stays. One to try again (a blip, offline) keeps its message
 * and its button.
 */
async function afterPutBack(key: string, id: string): Promise<void> {
  const r = (await api(key, "GET", "/api/hub/proposals").catch(() => null)) as { recent: ProposalView[] } | null;
  if (!r) return;
  const q = r.recent.find((x) => x.id === id);
  if (q && !q.undone && Date.now() - (q.decidedAt ?? 0) < UNDO_MS) return;
  // Put back from elsewhere: drawn as it stands. Otherwise (its week out, or gone) only the button goes, and why stays.
  for (const c of document.querySelectorAll<HTMLElement>(`[data-proposal="${CSS.escape(id)}"]`)) {
    if (q?.undone) draw(key, c, q);
    else c.querySelector(".mdbtns")?.remove();
  }
}

/** A proposal decided: every card for it on this screen says so (one already saying so is left as it is: an Allow being tapped). */
export function settle(key: string, p: ProposalView): void {
  for (const card of document.querySelectorAll<HTMLElement>(`[data-proposal="${CSS.escape(p.id)}"]`)) if (card.dataset.state !== p.state) draw(key, card, p);
}

/** Proposals being run whose cards are looked at again, by id: one look for all the cards of one. */
const watched = new Set<string>();

/**
 * An approved call runs on the server's alarm (lib/proposals.ts tick), not in
 * the request that approved it: its cards are looked at again, soon and then
 * less often, while one is on screen, until it is no longer running.
 */
function watch(key: string, id: string): void {
  if (watched.has(id)) return;
  watched.add(id);
  let wait = 2000;
  let misses = 0;
  const again = async (): Promise<void> => {
    const shown = !!document.querySelector(`[data-proposal="${CSS.escape(id)}"]`);
    const r = shown ? ((await api(key, "GET", "/api/hub/proposals").catch(() => null)) as { recent: ProposalView[] } | null) : null;
    const p = r?.recent.find((q) => q.id === id);
    misses = r ? 0 : misses + 1;
    // Still being made, or not answered (offline, a deploy): looked at again, but not after five misses in a row (signed out, locked).
    // No card left, or no longer running (or no longer kept): done looking.
    if (shown && (r ? p?.state === "running" : misses < 5)) {
      wait = Math.min(wait * 1.5, 15_000);
      setTimeout(() => void again(), wait);
      return;
    }
    watched.delete(id);
    if (p) settle(key, p);
    // A Put back that did not work: what it would have undone is offered again, where it was tapped.
    if (p?.undoes && p.state === "failed") void refresh(key, [p.undoes], undefined, true);
  };
  setTimeout(() => void again(), wait);
}

/** The cards for a job's proposals, by id, as they stand now (one request). */
export function proposalCards(key: string, ids: readonly string[]): HTMLElement {
  const box = el("div", "proposals");
  void refresh(key, ids, box);
  return box;
}

async function refresh(key: string, ids: readonly string[], box?: HTMLElement, again = false): Promise<void> {
  const r = (await api(key, "GET", "/api/hub/proposals").catch(() => null)) as { open: ProposalView[]; recent: ProposalView[] } | null;
  if (!r) return;
  const known = new Map([...r.open, ...r.recent].map((p) => [p.id, p]));
  for (const id of ids) {
    const p = known.get(id);
    if (!p) continue;
    if (box) box.appendChild(proposalCard(key, p));
    // Drawn again as it stands, whatever its state (`again`: a Put back that did not work).
    else if (again) for (const c of document.querySelectorAll<HTMLElement>(`[data-proposal="${CSS.escape(id)}"]`)) draw(key, c, p);
    // After an answer that failed: redrawn only if it has moved on, so a "try again" stays to be read.
    else if (p.state !== "pending") settle(key, p);
  }
}

/** A kind of call, as the person reads it. */
export function labelOf(category: string): string {
  const [tool, what = ""] = category.split(":");
  const words = what.replace(/_/g, " ");
  return tool === "car_command" ? `Car: ${words}` : tool === "mail_manage" ? `Mail: ${words}` : tool === "calendar_add" ? "Calendar: add an event" : category;
}

/** An errand for later (src/worker/lib/later.ts), as GET /api/hub/proposals lists it: no card yet, put to them then. */
interface LaterView {
  id: string;
  says: string;
  why: string;
  when: string;
  risk: ProposalView["risk"];
  body?: string;
}

/** One errand for later: what it is, when it will be asked, and X, not wanted after all. */
function laterCard(key: string, s: LaterView, reload: () => Promise<void>): HTMLElement {
  const card = el("div", "pagecard proposalcard");
  card.append(
    el("span", "doctag", `Later · ${s.when}${s.risk === "irreversible" ? " · can't be undone" : ""}`),
    el("b", "doctitle", s.says),
    ...(s.body ? [el("div", "draftbody", s.body)] : []),
    el("small", "pagesaid", `${s.why} · Jarvis asks you then`),
  );
  const btns = el("div", "mdbtns");
  const said = el("small", "pagesaid", "");
  btns.appendChild(button("Don't do this", async () => {
    for (const b of btns.querySelectorAll("button")) b.disabled = true;
    try {
      await api(key, "POST", "/api/hub/proposals/answer", { id: s.id, answer: "decline" });
      await reload();
    } catch (e) {
      for (const b of btns.querySelectorAll("button")) b.disabled = false;
      said.textContent = e instanceof Error ? e.message : String(e);
      card.appendChild(said);
    }
  }, "docopen"));
  card.appendChild(btns);
  return card;
}

/**
 * The Jobs panel's part (ui/Jobs.ts): what is waiting for an OK, what waits
 * for later (with X), the kinds of thing allowed without asking (with Stop),
 * and what was decided lately, each only when there is something to show.
 */
export function proposalsBox(key: string): { el: HTMLElement; load(): Promise<void> } {
  const box = el("div", "proposals");
  const load = async (): Promise<void> => {
    const r = (await api(key, "GET", "/api/hub/proposals").catch(() => null)) as { open: ProposalView[]; recent: ProposalView[]; allowed: string[]; later?: LaterView[] } | null;
    box.replaceChildren();
    if (!r) return;
    if (r.open.length) box.append(el("h3", "", "Waiting for your OK"), ...r.open.map((p) => proposalCard(key, p)));
    if (r.later?.length) box.append(el("h3", "", "Later"), ...r.later.map((s) => laterCard(key, s, load)));
    if (r.allowed.length) {
      box.appendChild(el("h3", "", "Allowed without asking"));
      for (const c of r.allowed) {
        const row = el("div", "pagecard");
        row.append(el("b", "doctitle", labelOf(c)), el("small", "pagesaid", "Jobs do this without asking you first."));
        const btns = el("div", "mdbtns");
        btns.appendChild(button("Stop", async () => {
          await api(key, "DELETE", `/api/hub/proposals/allow?category=${encodeURIComponent(c)}`).catch(() => {});
          await load();
        }, "docopen"));
        row.appendChild(btns);
        box.appendChild(row);
      }
    }
    if (r.recent.length) box.append(el("h3", "", "Decided lately"), ...r.recent.slice(0, 5).map((p) => proposalCard(key, p)));
  };
  return { el: box, load };
}
