import { el } from "./util";

/**
 * The Home tab's panels laid on the page (src/app/ui/Home.ts), and moved by
 * dragging.
 *
 * In columns filled across then down, the first panel in the first column
 * and the second in the second, rather than the browser's balanced columns:
 * those fill down then across and put a card wherever the balance falls, so
 * a panel dropped on another's place would land somewhere else. Here it
 * takes that place. A big panel runs across the page between the others.
 *
 * A panel is moved by its name, and a thing on it by its own name (within
 * its panel): with a mouse, pressed and moved; with a finger, held a moment
 * first, so a swipe on it still scrolls the page. The others make room as it
 * goes, and near the top or bottom the page scrolls under it. Let go, the
 * order is its person's (POST /api/hub/panels/order), on every screen of
 * theirs; Jarvis keeps it when it adds to a panel (lib/panel-arrange.ts).
 */

/** As the page had them: three columns at most, none narrower than this, this far apart. */
const COLUMN = 350;
const GAP = 16;
const MOST = 3;
/** A finger held this long picks a panel up; moved this far first, it was a swipe. */
const HOLD_MS = 350;
const SLOP = 8;
/** Near the top or bottom of the page, it scrolls under a panel being moved: faster nearer the edge, up to this many px a second. */
const EDGE = 64;
const SPEED = 600;

export const columnsFor = (width: number): number => Math.max(1, Math.min(MOST, Math.floor((width + GAP) / (COLUMN + GAP))));

/** The cards, in their order, onto the wall: across then down, a big one across the page. */
export function layOut(wall: HTMLElement, cards: HTMLElement[]): void {
  const n = columnsFor(wall.clientWidth);
  wall.dataset.cols = String(n);
  const blocks: HTMLElement[] = [];
  let cols: HTMLElement[] = [];
  let i = 0;
  for (const card of cards) {
    if (card.classList.contains("big")) {
      blocks.push(card);
      cols = [];
      continue;
    }
    if (!cols.length) {
      cols = Array.from({ length: n }, () => el("div", "hcol"));
      const run = el("div", "hcols");
      run.append(...cols);
      blocks.push(run);
      i = 0;
    }
    cols[i++ % n]!.appendChild(card);
  }
  wall.replaceChildren(...blocks);
}

/** What can be moved: the panels on the wall, or the things on one panel. */
export interface Moving {
  /** In their order, changed in place as one is moved. */
  items: HTMLElement[];
  /** Lays them out again in that order. */
  lay: () => void;
  /** What scrolls under one being moved; the copy that follows the pointer goes on it. */
  page: HTMLElement;
  /** Let go somewhere else. */
  moved: () => void;
}

/** `card`, one of `m.items`, moved by `handle`. */
export function draggable(card: HTMLElement, handle: HTMLElement, m: Moving): void {
  const { items, page } = m;
  // Once a finger has picked it up, its moves are the panel's, not the page's.
  handle.addEventListener("touchmove", (e) => card.classList.contains("hgap") && e.preventDefault(), { passive: false });
  // A finger held on it would otherwise bring up the browser's menu.
  handle.addEventListener("contextmenu", (e) => e.preventDefault());

  handle.addEventListener("pointerdown", (down) => {
    if (!down.isPrimary || down.button !== 0) return;
    const finger = down.pointerType !== "mouse";
    const start = { x: down.clientX, y: down.clientY };
    let at = start;
    let lift: HTMLElement | null = null;
    let grip = { x: 0, y: 0 };
    // Where it started, to tell a move from putting it back.
    const from = items.indexOf(card);
    // Where it last moved, on the page rather than the screen: the page may have scrolled under it since.
    let last = { x: 0, y: 0 };
    let frame = 0;
    let then = 0;
    const onPage = () => ({ x: at.x, y: at.y + page.scrollTop });

    const place = (l: HTMLElement) => {
      // Corrected by where it is: whatever it is fixed against, it sits under the pointer.
      const was = l.getBoundingClientRect();
      l.style.left = `${(parseFloat(l.style.left) || 0) + at.x - grip.x - was.left}px`;
      l.style.top = `${(parseFloat(l.style.top) || 0) + at.y - grip.y - was.top}px`;
    };

    // The one under the pointer, if another, gives up its place; not again until the pointer moves on.
    const over = () => {
      const here = onPage();
      if (Math.hypot(here.x - last.x, here.y - last.y) < SLOP * 3) return;
      const hit = document.elementFromPoint(at.x, at.y);
      const under = hit && items.find((x) => x !== card && x.contains(hit));
      if (!under) return;
      const to = items.indexOf(under);
      items.splice(items.indexOf(card), 1);
      items.splice(to, 0, card);
      m.lay();
      last = here;
    };

    // By the time since the last frame, so a screen that draws few frames scrolls as fast.
    const scroll = (now: number) => {
      const dt = then ? Math.min(100, now - then) : 0;
      then = now;
      const r = page.getBoundingClientRect();
      const by = at.y < r.top + EDGE ? at.y - r.top - EDGE : at.y > r.bottom - EDGE ? at.y - r.bottom + EDGE : 0;
      if (by && dt) {
        page.scrollTop += (Math.sign(by) * Math.max(0.2, Math.min(1, Math.abs(by) / EDGE)) * SPEED * dt) / 1000;
        over();
      }
      frame = requestAnimationFrame(scroll);
    };

    const pickUp = () => {
      const r = card.getBoundingClientRect();
      grip = { x: at.x - r.left, y: at.y - r.top };
      const l = card.cloneNode(true) as HTMLElement;
      l.classList.add("hlift");
      l.setAttribute("aria-hidden", "true");
      l.style.width = `${r.width}px`;
      // On the page rather than among the others, which are laid out again under it.
      page.appendChild(l);
      place(l);
      lift = l;
      card.classList.add("hgap");
      document.body.classList.add("hdragging");
      // From where it was pressed: a quick drag straight onto another panel still moves it.
      last = { x: start.x, y: start.y + page.scrollTop };
      frame = requestAnimationFrame(scroll);
    };

    const move = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      at = { x: e.clientX, y: e.clientY };
      if (!lift) {
        if (Math.hypot(at.x - start.x, at.y - start.y) <= SLOP) return;
        // A finger that moves before it is held is scrolling the page.
        if (finger) return end();
        pickUp();
      }
      place(lift!);
      over();
    };

    const end = () => {
      clearTimeout(hold);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!lift) return;
      cancelAnimationFrame(frame);
      lift.remove();
      card.classList.remove("hgap");
      document.body.classList.remove("hdragging");
      // Letting go is not a tap on its name: the panel does not fold.
      const eat = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      };
      window.addEventListener("click", eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
      if (items.indexOf(card) !== from) m.moved();
    };

    const hold = finger ? setTimeout(pickUp, HOLD_MS) : 0;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });
}
