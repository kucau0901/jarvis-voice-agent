import { api } from "../key";
import { el } from "./util";
import { proposalCard, type ProposalView } from "../proposal";

/**
 * Home's Now strip: what background jobs proposed that waits for an OK
 * (src/app/proposal.ts), above the panels, as Hark's Now card is. Hidden when
 * nothing waits. Its own section, so Home drawing its panels afresh leaves it
 * be; drawn again only when what waits has changed, so a card being answered
 * is not swept away under the finger.
 */
const MOST = 3;

export class Now {
  private key: string;
  private root: HTMLElement;
  private seq = 0;
  private shown = "";

  constructor(key: string) {
    this.key = key;
    this.root = document.getElementById("now")!;
  }

  async load(): Promise<void> {
    const n = ++this.seq;
    const r = (await api(this.key, "GET", "/api/hub/proposals").catch(() => null)) as { open: ProposalView[] } | null;
    if (n !== this.seq || !r) return;
    const open = r.open;
    const ids = new Set(open.map((p) => p.id));
    // Not while a card here is being answered: its outcome is drawn into it first (proposal.ts settle).
    if (this.root.querySelector(".proposalcard button:disabled")) return;
    // Answered here since: kept for one more read, so what came of it is seen, then gone.
    const answered = [...this.root.querySelectorAll<HTMLElement>(".proposalcard")].filter((c) => !ids.has(c.dataset.proposal ?? ""));
    const now = [...ids].join();
    if (now === this.shown && !answered.length) return;
    this.shown = now;
    const kept = answered.filter((c) => c.dataset.kept !== "1");
    for (const c of kept) c.dataset.kept = "1";
    this.root.hidden = !open.length && !kept.length;
    this.root.replaceChildren(
      ...(open.length || kept.length
        ? [el("h3", "", "Now"), ...kept, ...open.slice(0, MOST).map((p) => proposalCard(this.key, p)), ...(open.length > MOST ? [el("p", "note", `${open.length - MOST} more in Jobs.`)] : [])]
        : []),
    );
  }

  /** Its person was put aside: nothing of theirs stays on screen. */
  forget(): void {
    this.seq++;
    this.shown = "";
    this.root.hidden = true;
    this.root.replaceChildren();
  }
}
