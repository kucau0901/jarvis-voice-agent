import { api } from "../key";
import type { PanelRow, PanelView, PanelsReply } from "../../shared/panels";
import { arm, button, el } from "./util";
import { moreBody } from "./HomeMore";

/**
 * The Home tab: this person's panels (src/worker/lib/panel-view.ts), as
 * Hark's home column has them but laid across the whole page — a card each,
 * a tile for every thing with its icon, read just now, its buttons following
 * what it is doing. In the order they were made: a big panel across the page,
 * the others in columns under one another (index.html), so another panel
 * finds its place without a hole. A tall card folds, as Hark's do, to its
 * first row fading out (remembered on this screen), and its … menu reads it
 * again or removes it. A tile with more to it — a room's lights, an
 * aircond, an alarm — opens across its panel (ui/HomeMore.ts); a tile wired
 * to one of Jarvis's tools reads it on its own, every minute, so a slow tool
 * never holds up the house. Panels are made by asking Jarvis
 * ("put the gate on a panel"), so with none yet the tab is a clock and a line
 * saying how. Read again every 20 seconds while it is in view (not while the
 * page is hidden), and soon after a press, since a gate takes a moment to say
 * it is opening.
 *
 * Built with textContent throughout: names come from the house and from what
 * was asked.
 */

const EVERY_MS = 20_000;
const AFTER_PRESS_MS = 1_500;
/** How often a tile's tool is read again: a tool can be slow, or cost a request to someone else's service. */
const READ_MS = 60_000;
const FOLDED = "jarvis.homeFolded";
/** Tiles' worth (a car or the usage counts two) from which a panel takes the page's width, not a column's. */
const BIG = 5;

/** "a, b and c". */
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A car, the usage, a room's lights together ("1 of 8 on · …"), a tile's reading or a long note takes two tiles' room. */
const wide = (r: PanelRow) =>
  r.icon === "car" || r.kind === "usage" || r.key.includes(",") || !!r.read || (r.kind === "note" && r.label.length > 48);

/** The panels folded on this screen, by id: a convenience, so a private window just forgets them. */
function folded(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FOLDED) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function keepFolded(ids: Set<string>): void {
  try {
    localStorage.setItem(FOLDED, JSON.stringify([...ids]));
  } catch {
    // Storage refused (a private window): the fold holds until the next read.
  }
}

/** "3 asked" as a large 3 and a small "asked", as Hark sets a figure. */
function figure(value: string): HTMLElement {
  const b = el("b");
  const m = /^(\S+)\s+(.+)$/.exec(value);
  if (m) b.append(m[1]!, " ", el("small", "", m[2]!));
  else b.textContent = value;
  return b;
}

export class Home {
  private root: HTMLElement;
  private key: string;
  private timer = 0;
  /** The latest read: an older one coming back late is not drawn over it. */
  private seq = 0;
  /** A press under way: nothing read before its answer is drawn over that answer. */
  private pressing = 0;
  /** Tiles opened, by panel and key: they stay open when the panels are drawn again. */
  private opened = new Set<string>();
  /** Each tile's last reading, by panel and key, and when it was read. */
  private readings = new Map<string, { text: string; image?: string; failed?: boolean; at: number }>();

  constructor(key: string) {
    this.key = key;
    this.root = document.getElementById("home")!;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.timer) void this.load();
    });
    document.addEventListener("click", (e) => {
      if (!(e.target instanceof Element && e.target.closest("#home .hmenu, #home .hmore"))) this.closeMenus();
    });
    // The page's width decides how many tiles fit a row, so which cards are tall enough to fold.
    new ResizeObserver(() => this.measure()).observe(this.root);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenus();
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
      // Not while a menu is open or a code is being typed: drawing again would take them away.
      const busy = this.root.querySelector(".hmenu:not([hidden])") || [...this.root.querySelectorAll<HTMLInputElement>(".hcode")].some((c) => c.value || c === document.activeElement);
      if (n === this.seq && !this.pressing && !busy) this.render(r);
    } catch (e) {
      if (n !== this.seq || this.pressing) return;
      // A dropped read (a tunnel, a moment offline) keeps what was on screen, under a note.
      this.say(`Could not load your panels: ${why(e)}`);
    }
  }

  /** A line above the cards, which stay as they were. */
  private say(text: string): void {
    this.root.replaceChildren(el("p", "hnote", text), ...this.root.querySelectorAll(":scope > .hwall"));
  }

  private render(r: PanelsReply): void {
    if (!r.panels.length) return this.root.replaceChildren(...this.empty(r));
    const shut = folded();
    const wall = el("div", "hwall");
    wall.append(...r.panels.map((p) => this.card(p, shut.has(p.id))));
    this.root.replaceChildren(wall);
    this.measure();
    for (const p of r.panels) for (const row of p.rows) if (row.read) void this.read(p.id, row.key);
  }

  /** A tile's reading, from its tool, unless it was read within the minute. */
  private async read(panel: string, key: string): Promise<void> {
    const at = `${panel}\n${key}`;
    const had = this.readings.get(at);
    if (had && Date.now() - had.at < READ_MS) return;
    // Marked now, so the next drawing does not ask again while this is under way.
    this.readings.set(at, { ...(had ?? { text: "" }), at: Date.now() });
    let got: { text: string; image?: string; failed?: boolean };
    try {
      got = (await api(this.key, "GET", `/api/hub/panels/read?panel=${encodeURIComponent(panel)}&key=${encodeURIComponent(key)}`)) as { text: string; image?: string };
    } catch (e) {
      got = { text: why(e), failed: true };
    }
    this.readings.set(at, { ...got, at: Date.now() });
    const t = [...this.root.querySelectorAll<HTMLElement>(".htile")].find((x) => x.dataset.at === at);
    if (t) this.showReading(t, got);
  }

  private showReading(t: HTMLElement, got: { text: string; image?: string; failed?: boolean }): void {
    const said = t.querySelector<HTMLElement>(".hstate")!;
    said.textContent = got.text;
    said.className = got.failed ? "hstate hwhy" : "hstate";
    t.querySelector(".hshot")?.remove();
    if (got.image) {
      const img = el("img", "hshot");
      img.src = got.image;
      img.alt = "";
      t.querySelector(".htop")!.after(img);
    }
  }

  /** Only a card taller than a folded one (--fold, index.html) offers to fold. */
  private measure(): void {
    const fold = parseFloat(getComputedStyle(this.root).getPropertyValue("--fold"));
    for (const card of this.root.querySelectorAll<HTMLElement>(".hcard")) {
      const tall = card.querySelector(".hgrid")!.scrollHeight > fold + 12;
      card.classList.toggle("tall", tall);
      card.querySelector<HTMLButtonElement>(".hfold")!.disabled = !tall;
    }
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

  private card(p: PanelView, shut: boolean): HTMLElement {
    const size = p.rows.reduce((n, r) => n + (wide(r) ? 2 : 1), 0);
    const card = el("section", `hcard${size >= BIG ? " big" : ""}${shut ? " folded" : ""}`);

    const head = el("div", "hhead");
    const icon = el("span", "hic");
    icon.dataset.icon = p.rows.some((r) => r.kind === "home") ? "house" : (p.rows[0]?.icon ?? "house");
    const fold = button("", () => {
      const now = folded();
      const shutNow = card.classList.toggle("folded");
      if (shutNow) now.add(p.id);
      else now.delete(p.id);
      keepFolded(now);
      fold.setAttribute("aria-expanded", String(!shutNow));
    }, "hfold");
    fold.append(icon, el("h3", "", p.title));
    fold.setAttribute("aria-expanded", String(!shut));

    const menu = el("div", "hmenu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    const more = button("", () => {
      const open = menu.hidden;
      this.closeMenus();
      menu.hidden = !open;
      more.setAttribute("aria-expanded", String(open));
    }, "hmore");
    more.setAttribute("aria-label", `${p.title}: more`);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    const reload = button("Reload", () => {
      this.closeMenus();
      void this.load();
    }, "hreload");
    const remove = el("button", "hremove", "Remove panel");
    remove.type = "button";
    arm(remove, "Tap again to remove", () => this.remove(p));
    for (const b of [reload, remove]) b.setAttribute("role", "menuitem");
    menu.append(reload, remove);
    head.append(fold, more, menu);

    const grid = el("div", "hgrid");
    for (const r of p.rows) grid.appendChild(this.tile(p.id, r));
    card.append(head, grid);
    return card;
  }

  private closeMenus(): void {
    for (const m of this.root.querySelectorAll<HTMLElement>(".hmenu")) m.hidden = true;
    for (const b of this.root.querySelectorAll(".hmore")) b.setAttribute("aria-expanded", "false");
  }

  private async remove(p: PanelView): Promise<void> {
    this.closeMenus();
    try {
      await api(this.key, "POST", "/api/hub/panels/remove", { panel: p.id });
    } catch (e) {
      this.say(`Could not remove ${p.title}: ${why(e)}`);
      return;
    }
    const shut = folded();
    if (shut.delete(p.id)) keepFolded(shut);
    await this.load();
  }

  private tile(panel: string, r: PanelRow): HTMLElement {
    const at = `${panel}\n${r.key}`;
    const t = el("div", `htile ${r.kind}${r.active ? " active" : ""}${wide(r) ? " wide" : ""}`);
    t.dataset.icon = r.icon;
    t.dataset.at = at;
    const top = el("div", "htop");
    const text = el("div", "htext");
    const name = el("b", "hname", r.label);
    const said = el("small", r.note ? "hstate hwhy" : "hstate", r.note ?? (r.read ? "…" : r.value));
    text.appendChild(name);
    if (r.value || r.note || r.read) text.appendChild(said);
    top.append(el("span", "hic"), text);
    if (r.level !== undefined) top.appendChild(el("span", "hbadge", `${r.level}%`));
    t.appendChild(top);
    const reading = this.readings.get(at);
    if (r.read && reading?.text) this.showReading(t, reading);
    if (r.more) {
      // Opened across its panel, as Hark opens a row: its name is what is pressed.
      const open = this.opened.has(at);
      t.classList.add("can-open");
      t.classList.toggle("open", open);
      top.setAttribute("role", "button");
      top.tabIndex = 0;
      top.setAttribute("aria-expanded", String(open));
      const flip = () => {
        const now = !this.opened.has(at);
        if (now) this.opened.add(at);
        else this.opened.delete(at);
        t.classList.toggle("open", now);
        top.setAttribute("aria-expanded", String(now));
      };
      top.addEventListener("click", flip);
      top.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          flip();
        }
      });
    }
    if (r.level !== undefined) {
      const bar = el("div", r.level < 20 ? "hbar low" : "hbar");
      const fill = el("i");
      fill.style.width = `${Math.max(0, Math.min(100, r.level))}%`;
      bar.appendChild(fill);
      t.appendChild(bar);
    }
    if (r.tiles.length) {
      const stats = el("div", "hstats");
      for (const s of r.tiles) {
        const stat = el("div", "hstat");
        stat.append(el("small", "", s.label), figure(s.value));
        stats.appendChild(stat);
      }
      t.appendChild(stats);
    }
    if (r.actions.length) {
      const acts = el("div", "hacts");
      for (const a of r.actions) {
        const b = button(a.label, () => void this.act(panel, r.key, a.action, b, said, name));
        acts.appendChild(b);
      }
      t.appendChild(acts);
    }
    if (r.more) t.appendChild(moreBody(r.more, said, (action, b, shown, extra) => this.act(panel, r.key, action, b, shown, name, extra)));
    return t;
  }

  /**
   * A button pressed: the server checks the state again before it sends
   * anything. A room's light is pressed as its `member`; an alarm's code goes
   * with the press and is kept nowhere.
   */
  private async act(
    panel: string,
    key: string,
    action: string,
    b: HTMLButtonElement,
    said: HTMLElement,
    after: HTMLElement,
    extra: { member?: string; code?: string } = {},
  ): Promise<void> {
    const label = b.textContent;
    b.disabled = true;
    b.textContent = "…";
    this.pressing++;
    this.seq++;
    try {
      said.textContent = ((await api(this.key, "POST", "/api/hub/panels/act", { panel, key, action, ...extra })) as { text: string }).text;
      said.className = "hstate";
    } catch (e) {
      said.textContent = why(e);
      said.className = "hstate hwhy";
    } finally {
      this.pressing--;
    }
    if (!said.isConnected) after.after(said);
    b.textContent = label;
    b.disabled = false;
    setTimeout(() => void this.load(), AFTER_PRESS_MS);
  }
}
