import { api } from "../key";
import type { PanelRow, PanelView, PanelsReply } from "../../shared/panels";
import { button, el } from "./util";

/**
 * The Home tab: this person's panels (src/worker/lib/panel-view.ts), as
 * Hark's home column has them — a card each, every thing read just now, its
 * buttons following what it is doing. They are made by asking Jarvis ("put
 * the gate on a panel"), so with none yet the tab is a clock and a line
 * saying how. Read again every 20 seconds while it is in view (not while the
 * page is hidden), and soon after a press, since a gate takes a moment to say
 * it is opening.
 *
 * Built with textContent throughout: names come from the house and from what
 * was asked.
 */

const EVERY_MS = 20_000;
const AFTER_PRESS_MS = 1_500;

/** "a, b and c". */
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export class Home {
  private root: HTMLElement;
  private key: string;
  private timer = 0;
  /** The latest read: an older one coming back late is not drawn over it. */
  private seq = 0;
  /** A press under way: nothing read before its answer is drawn over that answer. */
  private pressing = 0;

  constructor(key: string) {
    this.key = key;
    this.root = document.getElementById("home")!;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.timer) void this.load();
    });
  }

  show(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!document.hidden) void this.load();
    }, EVERY_MS);
    void this.load();
  }

  hide(): void {
    clearInterval(this.timer);
    this.timer = 0;
  }

  /** Its person was put aside: nothing of theirs stays on screen. */
  forget(): void {
    this.hide();
    this.seq++;
    this.root.replaceChildren();
  }

  private async load(): Promise<void> {
    const n = ++this.seq;
    try {
      const r = (await api(this.key, "GET", "/api/hub/panels")) as PanelsReply;
      if (n === this.seq && !this.pressing) this.render(r);
    } catch (e) {
      if (n !== this.seq || this.pressing) return;
      // A dropped read (a tunnel, a moment offline) keeps what was on screen, under a note.
      const note = el("p", "hnote", `Could not load your panels: ${e instanceof Error ? e.message : String(e)}`);
      this.root.replaceChildren(note, ...this.root.querySelectorAll(":scope > .hcard"));
    }
  }

  private render(r: PanelsReply): void {
    this.root.replaceChildren(...(r.panels.length ? r.panels.map((p) => this.card(p)) : this.empty(r)));
  }

  /** None yet: Hark's clock, and what Jarvis could put here for this person. */
  private empty(r: PanelsReply): HTMLElement[] {
    const now = new Date();
    const clock = el("div", "hclock");
    clock.append(
      el("span", "", now.toLocaleDateString([], { weekday: "short" })),
      el("span", "", now.toLocaleDateString([], { month: "short", day: "numeric" })),
      el("span", "", now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })),
    );
    const can = [r.can.home ? "things in the house" : "", r.can.car ? "your car" : "", "what you have used", "notes"].filter(Boolean);
    const example = r.can.home
      ? "“put the gate and the porch light on a panel”"
      : r.can.car
        ? "“put my car on a panel”"
        : "“make me a to-do panel”";
    return [clock, el("p", "hnote", `Ask Jarvis for a panel and it appears here: ${example}. A panel can show ${list(can)}.`)];
  }

  private card(p: PanelView): HTMLElement {
    const card = el("section", "hcard");
    card.appendChild(el("h3", "", p.title));
    for (const r of p.rows) card.appendChild(this.row(p.id, r));
    return card;
  }

  private row(panel: string, r: PanelRow): HTMLElement {
    const row = el("div", `hrow ${r.kind}`);
    const top = el("div", "htop");
    const text = el("div", "htext");
    text.appendChild(el("b", "", r.label));
    const said = el("small", r.note ? "hwhy" : "", r.note ?? r.value);
    if (r.value || r.note) text.appendChild(said);
    top.appendChild(text);
    for (const a of r.actions) {
      const b = button(a.label, () => void this.act(panel, r.key, a.action, b, text, said));
      top.appendChild(b);
    }
    row.appendChild(top);
    if (r.tiles.length) {
      const tiles = el("div", "htiles");
      for (const t of r.tiles) {
        const tile = el("div", "htile");
        tile.append(el("small", "", t.label), el("b", "", t.value));
        tiles.appendChild(tile);
      }
      row.appendChild(tiles);
    }
    return row;
  }

  /** A button pressed: the server checks the state again before it sends anything. */
  private async act(panel: string, key: string, action: string, b: HTMLButtonElement, text: HTMLElement, said: HTMLElement): Promise<void> {
    const label = b.textContent;
    b.disabled = true;
    b.textContent = "…";
    this.pressing++;
    this.seq++;
    try {
      said.textContent = ((await api(this.key, "POST", "/api/hub/panels/act", { panel, key, action })) as { text: string }).text;
      said.className = "";
    } catch (e) {
      said.textContent = e instanceof Error ? e.message : String(e);
      said.className = "hwhy";
    } finally {
      this.pressing--;
    }
    if (!said.isConnected) text.appendChild(said);
    b.textContent = label;
    b.disabled = false;
    setTimeout(() => void this.load(), AFTER_PRESS_MS);
  }
}
