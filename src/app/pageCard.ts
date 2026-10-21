import { api } from "./key";
import { button, el } from "./ui/util";

/**
 * A page Jarvis made (tools/page.ts), as a card under the answer that made
 * it, as Hark shows its Pages: its title, that it was made by an AI, Open,
 * and for those who run the house Share, which makes a link anyone can open
 * until Stop sharing. Opening fetches a fresh link each time (GET /api/page):
 * the page's address carries its own proof, good for an hour.
 */
export function pageCard(key: string, page: { id: string; title: string }): HTMLElement {
  const card = el("div", "pagecard");
  const said = el("small", "pagesaid", "Page made by Jarvis · AI-generated");
  card.append(el("span", "doctag", "Page"), el("b", "doctitle", page.title), said);
  const btns = el("div", "mdbtns");
  const tell = (text: string) => (said.textContent = text);
  btns.appendChild(button("Open", async () => {
    // Opened before it is fetched, so the browser lets it be: an await first would be a popup.
    const tab = window.open("about:blank", "_blank");
    try {
      const { viewUrl } = (await api(key, "GET", `/api/page?id=${encodeURIComponent(page.id)}`)) as { viewUrl: string };
      if (tab) {
        tab.opener = null;
        tab.location.href = viewUrl;
      }
    } catch (e) {
      tab?.close();
      tell(e instanceof Error ? e.message : String(e));
    }
  }, "docopen"));
  const share = button("Share", async () => {
    if (!confirm("Anyone with the link will be able to read this page, including anything from your mail or calendar in it. Share it?")) return;
    try {
      const { shareUrl } = (await api(key, "POST", "/api/page/share", { id: page.id })) as { shareUrl: string };
      await navigator.clipboard?.writeText(shareUrl).catch(() => {});
      tell(`Shared: the link is copied. ${shareUrl}`);
      stop.hidden = false;
    } catch (e) {
      tell(e instanceof Error ? e.message : String(e));
    }
  }, "docopen");
  const stop = button("Stop sharing", async () => {
    try {
      await api(key, "DELETE", `/api/page/share?id=${encodeURIComponent(page.id)}`);
      tell("Not shared: the link no longer opens it.");
      stop.hidden = true;
    } catch (e) {
      tell(e instanceof Error ? e.message : String(e));
    }
  }, "docopen");
  stop.hidden = true;
  btns.append(share, stop);
  card.appendChild(btns);
  // Whether it is shared already, to offer Stop sharing.
  void api(key, "GET", `/api/page?id=${encodeURIComponent(page.id)}`).then((m) => (stop.hidden = !(m as { shared?: boolean }).shared), () => {});
  return card;
}
