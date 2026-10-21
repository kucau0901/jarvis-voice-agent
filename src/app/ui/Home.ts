import { api } from "../key";
import { everyWords, type PanelRow, type PanelView, type PanelsReply } from "../../shared/panels";
import { arm, button, el } from "./util";
import { moreBody, slider, typed, type SetAlert } from "./HomeMore";
import { lineChart, mapImage } from "./HomeChart";
import { columnsFor, draggable, layOut, type Moving } from "./HomeWall";
import { Now } from "./Now";

/**
 * The Home tab: this person's panels (src/worker/lib/panel-view.ts), as
 * Hark's home column has them but laid across the whole page — a card each,
 * a tile for every thing with its icon, read just now, its buttons following
 * what it is doing. In their person's order, made last at the end and moved
 * by dragging a panel's name, or a thing's within its panel (ui/HomeWall.ts): a big panel across the page,
 * the others in columns across then down. A tall card folds, as Hark's do, to its
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
/** How long what "Alert me" answered stays under it, through the redraws every twenty seconds. */
const TOLD_MS = 120_000;
/** How often a tile's tool is read again: a tool can be slow, or cost a request to someone else's service. */
const READ_MS = 60_000;
/** How soon to look again when another screen is already looking a reading up. */
const SOON_MS = 20_000;
/** A card in the making never outstays a panel_set that never said it was done (a question stopped, a dropped line). */
const MAKING_MS = 90_000;

/** A tile's reading as the server sends it (GET /api/hub/panels/read). */
type Shown = {
  text: string;
  image?: string;
  figures?: { label: string; value: string }[];
  list?: string[];
  chart?: { title: string; points: { x: string; y: number }[] };
  map?: { lat: number; lng: number };
  at?: number;
  /** Where a reading Jarvis looked up came from: an https page, for More info. */
  source?: string;
  stale?: boolean;
  pending?: boolean;
  failed?: boolean;
};
/** How long a sensor's last day, once fetched for its chart, is drawn again without asking the house. */
const HISTORY_MS = 5 * 60_000;
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const FOLDED = "jarvis.homeFolded";
/** Tiles' worth (a car or the usage counts two) from which a panel takes the page's width, not a column's. */
const BIG = 5;

/** "a, b and c". */
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A car, the usage, a room's lights together ("1 of 8 on · …"), a tile's reading, one to type into, or a long note takes two tiles' room. */
const wide = (r: PanelRow) =>
  r.icon === "car" || r.kind === "usage" || r.key.includes(",") || !!r.read || r.actions.some((a) => a.input?.kind === "text") ||
  (r.kind === "note" && r.label.length > 48);

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
  /** A sensor's last day, fetched when its tile opened, by panel and key. */
  private histories = new Map<string, { points: { t: number; v: number }[]; unit: string; fetched: number }>();
  /** Each tile's last reading, by panel and key, and when it was read. */
  private readings = new Map<string, { got: Shown; fetched: number }>();
  /** The cards in their person's order, as the wall lays them out. */
  private cards: HTMLElement[] = [];
  /** What "Alert me" last answered, by tile, until when. */
  private told = new Map<string, { text: string; until: number }>();
  /** What a tile's buttons last answered, by tile, until when: drawing again 1.5 s after a press would take it away. */
  private replied = new Map<string, { text: string; why: boolean; until: number }>();
  /** Panels whose More info is open, by id: it stays open when the panels are drawn again. */
  private info = new Set<string>();
  /** When the panels were last read, for More info. */
  private drawn = 0;
  /** panel_set runs under way for a question asked on this screen: while any is, a card in the making. */
  private making = 0;
  private makingTimer = 0;
  private sketched: HTMLElement | null = null;
  /** Chat, with words typed in its box to finish: a panel's Reply (main.ts). */
  private chat: (text: string) => void;
  /** What jobs proposed, waiting for an OK, above the panels (Now.ts). */
  private now: Now;

  constructor(key: string, chat: (text: string) => void) {
    this.key = key;
    this.chat = chat;
    this.root = document.getElementById("home")!;
    this.now = new Now(key);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.timer) void this.load();
    });
    document.addEventListener("click", (e) => {
      if (!(e.target instanceof Element && e.target.closest("#home .hmenu, #home .hmore"))) this.closeMenus();
    });
    // The page's width decides how many columns there are, and how many tiles fit a row, so which cards are tall enough to fold.
    new ResizeObserver(() => {
      const wall = this.root.querySelector<HTMLElement>(":scope > .hwall");
      if (wall && wall.dataset.cols !== String(columnsFor(wall.clientWidth))) layOut(wall, this.laid());
      this.measure();
    }).observe(this.root);
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
    this.now.forget();
  }

  private async load(): Promise<void> {
    void this.now.load();
    const n = ++this.seq;
    try {
      const r = (await api(this.key, "GET", "/api/hub/panels")) as PanelsReply;
      // Not while a menu is open, something is being moved or a code is being typed: drawing again would take them away.
      const busy =
        this.root.querySelector(".hmenu:not([hidden]), .hgap") ||
        [...this.root.querySelectorAll<HTMLInputElement>(".hcode, .hnum, .hadd input, .htyped input, .hlevel input")].some(
          (c) => c === document.activeElement || (c.type !== "range" && c.value),
        );
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
    this.drawn = Date.now();
    if (!r.panels.length && !this.making) return this.root.replaceChildren(...this.empty(r));
    const shut = folded();
    const wall = el("div", "hwall");
    this.root.replaceChildren(wall);
    this.cards = r.panels.map((p) => this.card(p, shut.has(p.id)));
    const panels: Moving = {
      items: this.cards,
      lay: () => layOut(wall, this.laid()),
      page: this.root,
      moved: () => void this.order({ order: this.cards.map((c) => c.dataset.panel!) }),
    };
    for (const card of this.cards) draggable(card, card.querySelector(".hfold")!, panels);
    panels.lay();
    this.measure();
    for (const p of r.panels) for (const row of p.rows) if (row.read) void this.read(p.id, row.key);
  }

  /**
   * A tile's reading, unless it was read within the minute. One looked up by
   * Jarvis comes in two steps: what was kept, at once, then — when that is
   * stale — the answer looked up again, which takes a model call.
   */
  private async read(panel: string, key: string): Promise<void> {
    const at = `${panel}\n${key}`;
    const had = this.readings.get(at);
    if (had && Date.now() - had.fetched < READ_MS) return;
    // Marked now, so the next drawing does not ask again while this is under way.
    this.readings.set(at, { got: had?.got ?? { text: "" }, fetched: Date.now() });
    const url = `/api/hub/panels/read?panel=${encodeURIComponent(panel)}&key=${encodeURIComponent(key)}`;
    const get = async (cached: boolean): Promise<Shown> => {
      try {
        return (await api(this.key, "GET", cached ? `${url}&cached=1` : url)) as Shown;
      } catch (e) {
        return { text: why(e), failed: true };
      }
    };
    const show = (got: Shown) => {
      this.readings.set(at, { got, fetched: Date.now() });
      const t = [...this.root.querySelectorAll<HTMLElement>(".htile")].find((x) => x.dataset.at === at);
      if (t) this.showReading(t, got);
    };
    let got = await get(true);
    if (got.text || got.failed) show(got);
    if (!got.stale) return;
    got = await get(false);
    // Another screen is looking it up: look again shortly, not in a minute.
    show(got.pending && !got.text ? { ...got, text: "Looking it up…" } : got);
    if (got.pending) this.readings.set(at, { got, fetched: Date.now() - READ_MS + SOON_MS });
  }

  private showReading(t: HTMLElement, got: Shown): void {
    const said = t.querySelector<HTMLElement>(".hstate")!;
    said.textContent = got.text;
    said.className = got.failed ? "hstate hwhy" : "hstate";
    for (const old of t.querySelectorAll(".hshot, .hstats, .hwhen, .hlist, .hchart, .hmap")) old.remove();
    let after: Element = t.querySelector(".htop")!;
    if (got.image) {
      const img = el("img", "hshot");
      img.src = got.image;
      img.alt = "";
      after.after(img);
      after = img;
    }
    if (got.figures?.length) {
      const stats = el("div", "hstats");
      for (const f of got.figures) {
        const stat = el("div", "hstat");
        stat.append(el("small", "", f.label), figure(f.value));
        stats.appendChild(stat);
      }
      after.after(stats);
      after = stats;
    }
    // Beyond its figures, what helps: a short list, a trend, a place.
    const extras: HTMLElement[] = [];
    if (got.list?.length) {
      const list = el("ul", "hlist");
      for (const line of got.list) list.appendChild(el("li", "", line));
      extras.push(list);
    }
    if (got.chart) {
      const p = got.chart.points;
      extras.push(lineChart(p.map((q) => q.y), "", got.chart.title, p[0]!.x, p.at(-1)!.x));
    }
    if (got.map) extras.push(mapImage(this.key, got.map.lat, got.map.lng));
    if (got.at) extras.push(el("small", "hwhen", `Checked ${clock(got.at)}`));
    for (const e of extras) {
      after.after(e);
      after = e;
    }
  }

  /**
   * What an opened tile draws beyond its controls: a sensor's last day as a
   * chart (asked of the house only every few minutes), the car's place on a map.
   */
  private async fill(t: HTMLElement, panel: string, r: PanelRow): Promise<void> {
    const extra = t.querySelector<HTMLElement>(".hextra");
    if (!extra || extra.dataset.done) return;
    extra.dataset.done = "1";
    if (r.more?.map) extra.appendChild(mapImage(this.key, r.more.map.lat, r.more.map.lng));
    if (!r.more?.history) return;
    const at = `${panel}\n${r.key}`;
    let h = this.histories.get(at);
    if (!h || Date.now() - h.fetched > HISTORY_MS) {
      try {
        const got = (await api(this.key, "GET", `/api/hub/panels/history?panel=${encodeURIComponent(panel)}&key=${encodeURIComponent(r.key)}`)) as { points: { t: number; v: number }[]; unit: string };
        h = { ...got, fetched: Date.now() };
        this.histories.set(at, h);
      } catch (e) {
        extra.appendChild(el("small", "hwhy", `No chart just now: ${why(e)}`));
        return;
      }
    }
    if (h.points.length < 2) {
      extra.appendChild(el("small", "hwhen", "Not enough readings yet for a chart."));
      return;
    }
    extra.appendChild(lineChart(h.points.map((p) => p.v), h.unit ? ` ${h.unit}` : "", "Last 24 hours", clock(h.points[0]!.t), "now"));
  }

  /**
   * Jarvis making or changing a panel (panel_set's tool events, for a question
   * asked on this screen, main.ts): a card in the making meanwhile, then the
   * panels read again so the new one takes its place.
   */
  building(on: boolean): void {
    this.making = Math.max(0, this.making + (on ? 1 : -1));
    clearTimeout(this.makingTimer);
    if (this.making) {
      this.makingTimer = setTimeout(() => {
        this.making = 0;
        if (this.timer) void this.load();
      }, MAKING_MS);
    }
    const wall = this.root.querySelector<HTMLElement>(":scope > .hwall");
    // Laid out at once where there are cards; with none yet, or once done, the panels are read again.
    if (on && wall) layOut(wall, this.laid());
    else if (this.timer) void this.load();
  }

  /** The cards as the wall lays them out: a card in the making last, never one to drag or put in order. */
  private laid(): HTMLElement[] {
    return this.making ? [...this.cards, this.sketch()] : this.cards;
  }

  /** A card in the making, as Hark shows one: its name, and tiles waiting to be filled. */
  private sketch(): HTMLElement {
    if (this.sketched) return this.sketched;
    const card = el("section", "hcard hsketch");
    card.setAttribute("aria-busy", "true");
    card.setAttribute("aria-label", "Jarvis is making a panel");
    const head = el("div", "hhead");
    head.append(el("span", "hic"), el("h3", "", "Making your panel…"));
    const grid = el("div", "hgrid");
    grid.append(el("div", "htile"), el("div", "htile"), el("div", "htile"));
    card.append(head, grid);
    return (this.sketched = card);
  }

  /** More info, from a panel's … menu: how often each thing on it is read, from where, when last and when next. */
  private infoOf(p: PanelView): HTMLElement {
    const box = el("div", "hinfo");
    const shut = button("", () => {
      this.info.delete(p.id);
      box.remove();
    }, "hinfox");
    shut.setAttribute("aria-label", "Close More info");
    box.appendChild(shut);
    const line = (name: string, ...parts: (string | HTMLElement)[]) => {
      const l = el("p");
      l.append(el("b", "", name));
      for (const part of parts) l.append(" · ", part);
      box.appendChild(l);
    };
    const live = p.rows.filter((r) => r.kind !== "note" && !r.read).map((r) => r.label);
    if (live.length) line(list(live), `live, read every ${EVERY_MS / 1000} seconds while Home is open`, `last read ${clock(this.drawn)}`);
    for (const r of p.rows) {
      if (!r.read) continue;
      const seen = this.readings.get(`${p.id}\n${r.key}`);
      if (r.every) {
        const got = seen?.got;
        const parts: (string | HTMLElement)[] = [`updates every ${everyWords(r.every)}${r.refresh ? ", even with Home closed" : ""}`];
        // Where a model's answer said it came from: a link only to an https page, its name only as words.
        if (got?.source?.startsWith("https://")) {
          try {
            const a = el("a", "", `from ${new URL(got.source).hostname}`) as HTMLAnchorElement;
            a.href = got.source;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            parts.push(a);
          } catch {
            // Not a URL after all: left out.
          }
        }
        if (got?.at) parts.push(`last checked ${clock(got.at)}`);
        const next = got?.at ? got.at + r.every * 60_000 : 0;
        // Kept fresh, it is checked whether Home is open or not.
        const after = r.refresh ? (next > Date.now() ? `next check about ${clock(next)}` : "next check soon") : next > Date.now() ? `next check when Home is open after ${clock(next)}` : "next check when Home is next open";
        parts.push(got?.pending ? "being looked up now" : after);
        line(r.label, ...parts);
      } else {
        line(r.label, `reads ${r.tool ?? "a tool"} every minute while Home is open`, ...(seen ? [`last read ${clock(seen.fetched)}`] : []));
      }
    }
    if (box.childElementCount === 1) line(p.title, "to-dos only: nothing here is read");
    return box;
  }

  /** Only a card taller than a folded one (--fold, index.html) offers to fold. */
  private measure(): void {
    const fold = parseFloat(getComputedStyle(this.root).getPropertyValue("--fold"));
    for (const card of this.root.querySelectorAll<HTMLElement>(".hcard:not(.hsketch)")) {
      const tall = card.querySelector(".hgrid")!.scrollHeight > fold + 12;
      card.classList.toggle("tall", tall);
      // Not disabled: a disabled button gets no pointer, and its name is what a panel is moved by.
      card.querySelector(".hfold")!.setAttribute("aria-disabled", String(!tall));
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
    card.dataset.panel = p.id;

    const head = el("div", "hhead");
    const icon = el("span", "hic");
    icon.dataset.icon = p.rows.some((r) => r.kind === "home") ? "house" : (p.rows[0]?.icon ?? "house");
    const fold = button("", () => {
      if (!card.classList.contains("tall")) return;
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
    // Hark's Reply: changing a panel is asking Jarvis to, so it opens Chat with the start of the question typed.
    const ask = button("Reply", () => {
      this.closeMenus();
      this.chat(`Change the panel "${p.title}": `);
    }, "hask");
    const about = button("More info", () => {
      this.closeMenus();
      const open = card.querySelector(":scope > .hinfo");
      if (open) {
        this.info.delete(p.id);
        open.remove();
      } else {
        this.info.add(p.id);
        head.after(this.infoOf(p));
      }
    }, "habout");
    const remove = el("button", "hremove", "Remove panel");
    remove.type = "button";
    arm(remove, "Tap again to remove", () => this.remove(p));
    // A checklist's ticked to-dos go only when asked to: a mis-tap is undone by tapping again.
    const items = [ask, reload, about, ...(p.rows.some((r) => r.done) ? [button("Clear ticked", () => void this.note(p.id, { clear: true }), "hclear")] : []), remove];
    for (const b of items) b.setAttribute("role", "menuitem");
    menu.append(...items);
    head.append(fold, more, menu);

    const grid = el("div", "hgrid");
    // A thing's tiles stay together (a car is several), moved as one by its first, by its name.
    const units = new Map<string, HTMLElement[]>();
    for (const r of p.rows) {
      const t = r.kind === "note" ? this.todo(p.id, r) : this.tile(p.id, r);
      t.dataset.key = r.key;
      units.set(r.key, [...(units.get(r.key) ?? []), t]);
    }
    const firsts = [...units.values()].map((u) => u[0]!);
    const things: Moving = {
      items: firsts,
      lay: () => grid.replaceChildren(...firsts.flatMap((f) => units.get(f.dataset.key!)!)),
      page: this.root,
      moved: () => void this.order({ panel: p.id, order: firsts.map((f) => f.dataset.key!) }),
    };
    for (const f of firsts) draggable(f, f.querySelector<HTMLElement>(".htop, .hname")!, things);
    things.lay();
    card.append(head, ...(this.info.has(p.id) ? [this.infoOf(p)] : []), grid);
    if (p.rows.some((r) => r.kind === "note")) card.appendChild(this.adder(p));
    return card;
  }

  /** A to-do: a tick, and its words, struck through once ticked. */
  private todo(panel: string, r: PanelRow): HTMLElement {
    const t = el("div", `htile note${r.done ? " done" : ""}`);
    t.dataset.icon = "note";
    const tick = button("", () => {
      // At once on screen; the server then moves it, and the next drawing follows.
      const now = t.classList.toggle("done");
      tick.setAttribute("aria-checked", String(now));
      void this.note(panel, { tick: r.key });
    }, "htick");
    tick.setAttribute("role", "checkbox");
    tick.setAttribute("aria-checked", String(!!r.done));
    tick.setAttribute("aria-label", r.label);
    t.append(tick, el("b", "hname", r.label));
    return t;
  }

  /** A to-do typed straight onto its panel, with no model. */
  private adder(p: PanelView): HTMLElement {
    const form = el("form", "hadd");
    const input = el("input");
    input.placeholder = "Add a to-do";
    input.maxLength = 120;
    input.setAttribute("aria-label", `Add a to-do to ${p.title}`);
    const go = el("button", "", "Add");
    go.type = "submit";
    form.append(input, go);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      void this.note(p.id, { add: text });
    });
    return form;
  }

  /** Panels, or a panel's things, dragged to another place: kept so for their person, on every screen (POST /api/hub/panels/order). */
  private async order(body: { order: string[]; panel?: string }): Promise<void> {
    // A reading already on its way has the order from before.
    this.seq++;
    try {
      await api(this.key, "POST", "/api/hub/panels/order", body);
    } catch (e) {
      this.say(`Could not move it: ${why(e)}`);
      return;
    }
    await this.load();
  }

  /** A checklist changed: a to-do added, ticked or cleared (POST /api/hub/panels/note). */
  private async note(panel: string, body: { add?: string; tick?: string; clear?: boolean }): Promise<void> {
    this.closeMenus();
    try {
      await api(this.key, "POST", "/api/hub/panels/note", { panel, ...body });
    } catch (e) {
      this.say(`Could not change the list: ${why(e)}`);
      return;
    }
    await this.load();
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
    const reading = this.readings.get(at)?.got;
    if (r.read && reading?.text) this.showReading(t, reading);
    // Alerts set on it, here or by asking (lib/panel-alerts.ts alertsOn); a reading is drawn above them.
    if (r.alerts?.length) t.appendChild(el("small", "halerts", `${r.alerts.length > 1 ? "Alerts" : "Alert"}: ${r.alerts.join(" · ")}`));
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
        if (now) void this.fill(t, panel, r);
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
      // Their answer goes under them and stays a while, as "Alert me"'s does.
      const kept = this.replied.get(at);
      const fresh = kept && kept.until > Date.now() ? kept : null;
      const reply = el("small", fresh?.why ? "hreply hwhy" : "hreply", fresh?.text ?? "");
      const press = (action: string, b: HTMLButtonElement | HTMLInputElement, extra?: { value: string }) =>
        void this.act(panel, r.key, action, b, reply, name, extra).then(() =>
          this.replied.set(at, { text: reply.textContent ?? "", why: reply.classList.contains("hwhy"), until: Date.now() + TOLD_MS }),
        );
      for (const a of r.actions) {
        // A tile's button that takes a number or words first (the music's volume, a message).
        if (a.input?.kind === "slider") {
          const { min, max, step } = a.input;
          const mid = Math.round((min + max) / 2 / step) * step;
          acts.appendChild(slider(a.label, { value: mid, min, max, step, unit: "" }, (n, input) => press(a.action, input, { value: String(n) })));
          continue;
        }
        if (a.input?.kind === "text") {
          acts.appendChild(typed(a.label, a.input.hint, (text, b) => press(a.action, b, { value: text })));
          continue;
        }
        const b = button(a.label, () => press(a.action, b));
        acts.appendChild(b);
      }
      t.append(acts, reply);
    }
    if (r.more) {
      const told = this.told.get(at);
      const body = moreBody(
        r.more,
        said,
        (action, b, shown, extra) => this.act(panel, r.key, action, b, shown, name, extra),
        (alert, b, shown) => this.alert(panel, r.key, at, alert, b, shown),
        told && told.until > Date.now() ? told.text : "",
      );
      // A chart or a map, drawn the first time the tile is open.
      if (r.more.history || r.more.map) body.prepend(el("div", "hextra"));
      t.appendChild(body);
      if (this.opened.has(at)) void this.fill(t, panel, r);
    }
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
    b: HTMLButtonElement | HTMLInputElement,
    said: HTMLElement,
    after: HTMLElement,
    extra: { member?: string; code?: string; value?: string } = {},
  ): Promise<void> {
    const ok = await this.post("/api/hub/panels/act", { panel, key, action, ...extra }, b, said);
    said.classList.toggle("hwhy", !ok);
    if (!said.isConnected) after.after(said);
    setTimeout(() => void this.load(), AFTER_PRESS_MS);
  }

  /** "Alert me": made a routine of theirs by the server, whose answer stays under it a while. */
  private async alert(panel: string, key: string, at: string, body: Parameters<SetAlert>[0], b: HTMLButtonElement, said: HTMLElement): Promise<void> {
    const ok = await this.post("/api/hub/panels/alert", { panel, key, ...body }, b, said);
    this.told.set(at, { text: said.textContent ?? "", until: Date.now() + TOLD_MS });
    // Drawn again, so the new alert shows on the tile; what was told is kept through it.
    if (ok) setTimeout(() => void this.load(), AFTER_PRESS_MS);
  }

  /** A press sent, with the server's answer (or why not) put in `said`; whether it was done. */
  private async post(path: string, body: Record<string, unknown>, b: HTMLButtonElement | HTMLInputElement, said: HTMLElement): Promise<boolean> {
    // A button says "…" while it waits; a slider is only held still.
    const label = b instanceof HTMLButtonElement ? b.textContent : null;
    b.disabled = true;
    if (label !== null) b.textContent = "…";
    this.pressing++;
    this.seq++;
    let ok = true;
    try {
      said.textContent = ((await api(this.key, "POST", path, body)) as { text: string }).text;
    } catch (e) {
      said.textContent = why(e);
      ok = false;
    } finally {
      this.pressing--;
    }
    if (label !== null) b.textContent = label;
    b.disabled = false;
    return ok;
  }
}
