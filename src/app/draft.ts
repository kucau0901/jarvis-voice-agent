import { api } from "./key";
import { button, el } from "./ui/util";

/**
 * A mail Jarvis wrote and held (Settings → Google → Draft first,
 * src/worker/lib/mail-draft.ts), as a card in the thread: who it is to, its
 * subject and words, and Send, the only way it leaves. Open in Gmail is for
 * changing it first; Not now puts the card away and leaves the draft in
 * Drafts. Nothing here deletes it.
 */
export interface Draft {
  draft: string;
  to: string;
  subject: string;
  body: string;
  reply: boolean;
}

/** A "draft" event from the router's stream handed to `hook`, when it is one. */
export function asDraft(ev: Record<string, unknown>, hook?: (d: Draft) => void): void {
  const { draft, to, subject, body } = ev;
  if (typeof draft === "string" && typeof to === "string" && typeof subject === "string" && typeof body === "string") hook?.({ draft, to, subject, body, reply: ev.reply === true });
}

export function draftCard(key: string, d: Draft): HTMLElement {
  const card = el("div", "pagecard draftcard");
  const said = el("small", "pagesaid", "Not sent: it waits in Drafts for you.");
  card.append(
    el("span", "doctag", d.reply ? "Draft reply" : "Draft"),
    el("b", "doctitle", d.subject),
    el("small", "pagesaid", `To ${d.to}`),
    el("div", "draftbody", d.body),
    said,
  );
  const btns = el("div", "mdbtns");
  const send = button("Send", async () => {
    send.disabled = true;
    try {
      await api(key, "POST", "/api/google/drafts/send", { id: d.draft });
      said.textContent = "✓ Sent.";
      btns.remove();
    } catch (e) {
      send.disabled = false;
      said.textContent = e instanceof Error ? e.message : String(e);
    }
  }, "docopen primary");
  const open = button("Open in Gmail", () => void window.open("https://mail.google.com/mail/#drafts", "_blank", "noopener"), "docopen");
  const later = button("Not now", () => (card.closest(".row") ?? card).remove(), "docopen");
  btns.append(send, open, later);
  card.appendChild(btns);
  return card;
}
