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
  risk: "reversible" | "irreversible";
  state: "pending" | "running" | "done" | "failed" | "declined" | "expired" | "withdrawn";
  expires: number;
  action: { tool: string; args: Record<string, unknown> };
  outcome?: { ok: boolean; text: string };
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
    el("small", "pagesaid", p.state === "pending" ? `${p.why} · ${left(p.expires)}` : p.why),
  );
  const said = el("small", "pagesaid", SAID[p.state] + (p.outcome?.text ? `: ${p.outcome.text}` : ""));
  if (p.state !== "pending") return void card.appendChild(said);
  const btns = el("div", "mdbtns");
  const answer = (how: "approve" | "decline") => async () => {
    for (const b of btns.querySelectorAll("button")) b.disabled = true;
    said.textContent = how === "approve" ? "Doing it…" : "";
    card.appendChild(said);
    try {
      const { proposal } = (await api(key, "POST", "/api/hub/proposals/answer", { id: p.id, answer: how })) as { proposal: ProposalView };
      settle(key, proposal);
    } catch (e) {
      // Answered elsewhere meanwhile, or gone: as it stands now.
      said.textContent = e instanceof Error ? e.message : String(e);
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
