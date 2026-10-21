import { api } from "./key";
import { button, el } from "./ui/util";

/**
 * What a background job proposed (src/worker/lib/proposals.ts), as a card:
 * the call in words, as the server's code wrote them, where it came from, how
 * long it waits, and Approve and Not now. Only a tap here does it: nothing a
 * model says can. Every card for the same proposal on this screen (an
 * alert's, the conversation's) shows the same, once one is answered.
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
  /** A reversible kind (car_command:lock), which jobs may then be let do without asking. */
  category?: string;
}

const SAID: Record<ProposalView["state"], string> = {
  pending: "",
  running: "Doing it…",
  done: "✓ Done",
  failed: "Didn't work",
  declined: "Not done: you said not now.",
  expired: "Not done: it waited a day.",
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
  card.replaceChildren(
    el("span", "doctag", p.state === "pending" ? `Waiting for your OK${p.risk === "irreversible" ? " · can't be undone" : ""}` : "Proposed"),
    el("b", "doctitle", p.says),
    ...(p.body ? [el("div", "draftbody", p.body)] : []),
    el("small", "pagesaid", p.state === "pending" ? `${p.why} · ${left(p.expires)}` : p.why),
  );
  const said = el("small", "pagesaid", SAID[p.state] + (p.by === "standing" ? " without asking (you allow it)" : "") + (p.outcome?.text ? `: ${p.outcome.text}` : ""));
  if (p.state !== "pending") {
    card.appendChild(said);
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
  btns.append(button("Approve", answer("approve"), "docopen primary"), button("Not now", answer("decline"), "docopen"));
  card.appendChild(btns);
}

/** A proposal decided: every card for it on this screen says so. */
export function settle(key: string, p: ProposalView): void {
  for (const card of document.querySelectorAll<HTMLElement>(`[data-proposal="${CSS.escape(p.id)}"]`)) draw(key, card, p);
}

/** The cards for a job's proposals, by id, as they stand now (one request). */
export function proposalCards(key: string, ids: readonly string[]): HTMLElement {
  const box = el("div", "proposals");
  void refresh(key, ids, box);
  return box;
}

async function refresh(key: string, ids: readonly string[], box?: HTMLElement): Promise<void> {
  const r = (await api(key, "GET", "/api/hub/proposals").catch(() => null)) as { open: ProposalView[]; recent: ProposalView[] } | null;
  if (!r) return;
  const known = new Map([...r.open, ...r.recent].map((p) => [p.id, p]));
  for (const id of ids) {
    const p = known.get(id);
    if (!p) continue;
    if (box) box.appendChild(proposalCard(key, p));
    else settle(key, p);
  }
}

/** A kind of call, as the person reads it. */
export function labelOf(category: string): string {
  const [tool, what = ""] = category.split(":");
  const words = what.replace(/_/g, " ");
  return tool === "car_command" ? `Car: ${words}` : tool === "mail_manage" ? `Mail: ${words}` : tool === "calendar_add" ? "Calendar: add an event" : category;
}

/**
 * The Jobs panel's part (ui/Jobs.ts): what is waiting for an OK, the kinds
 * of thing allowed without asking (with Stop), and what was decided lately,
 * each only when there is something to show.
 */
export function proposalsBox(key: string): { el: HTMLElement; load(): Promise<void> } {
  const box = el("div", "proposals");
  const load = async (): Promise<void> => {
    const r = (await api(key, "GET", "/api/hub/proposals").catch(() => null)) as { open: ProposalView[]; recent: ProposalView[]; allowed: string[] } | null;
    box.replaceChildren();
    if (!r) return;
    if (r.open.length) box.append(el("h3", "", "Waiting for your OK"), ...r.open.map((p) => proposalCard(key, p)));
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
