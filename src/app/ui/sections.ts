/**
 * A sheet of sections with a menu: Settings, Family and Memory. The list is
 * on the left and one section is open beside it; on a narrow screen (a phone,
 * the car's driving layout) the list comes first, and choosing opens the
 * section in its place, with a back button.
 *
 * The sheet holds `.setwrap > .setnav + .setbody` and a `.back` button in its
 * header. Each section in `.setbody` is an element with `data-section` (its
 * id) and `data-title` (its name in the menu), and either `data-state` (on,
 * need or off: a ✓, ! or ○) or `data-aside` (a count or a word, shown dimly).
 */

export type NavGroup = [heading: string, ids: string[]];

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, cls = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

export class SectionMenu {
  private current: string | null;

  constructor(
    private readonly sheet: HTMLElement,
    /** Where the open section is remembered for this tab (sessionStorage). */
    private readonly remember: string,
  ) {
    try {
      this.current = sessionStorage.getItem(remember);
    } catch {
      this.current = null;
    }
    sheet.querySelector(".back")?.addEventListener("click", () => sheet.classList.remove("detail"));
  }

  private sections(): HTMLElement[] {
    return [...this.sheet.querySelectorAll<HTMLElement>(".setbody [data-section]")];
  }

  /**
   * The menu, rebuilt from the sections there are now: a section no group
   * names goes in the last. `first` is what opens when the remembered section
   * is gone; `foot` goes under the list.
   */
  build(groups: NavGroup[], first: string | ((sections: HTMLElement[]) => string), foot: HTMLElement[] = []): void {
    const nav = this.sheet.querySelector<HTMLElement>(".setnav")!;
    const sections = this.sections();
    const byId = new Map(sections.map((s) => [s.dataset.section!, s]));
    const parts: HTMLElement[] = [];
    groups.forEach(([heading, ids], i) => {
      const here = ids.filter((id) => byId.has(id));
      if (i === groups.length - 1) for (const id of byId.keys()) if (!groups.some(([, l]) => l.includes(id))) here.push(id);
      if (!here.length) return;
      if (heading) parts.push(node("h4", heading));
      for (const id of here) {
        const s = byId.get(id)!;
        const b = node("button", "");
        b.type = "button";
        b.dataset.for = id;
        b.appendChild(node("span", s.dataset.title ?? id));
        const state = s.dataset.state;
        if (s.dataset.aside !== undefined) {
          b.appendChild(node("span", s.dataset.aside, "st aside"));
        } else if (state) {
          const mark = node("span", state === "on" ? "✓" : state === "need" ? "!" : "○", `st ${state}`);
          mark.title = state === "on" ? "set up" : state === "need" ? "needs setting up" : "optional, not set up";
          b.appendChild(mark);
        }
        b.addEventListener("click", () => this.choose(id, true));
        parts.push(b);
      }
    });
    parts.push(...foot);
    nav.replaceChildren(...parts);
    const fallback = typeof first === "function" ? first(sections) : first;
    this.choose(this.current && byId.has(this.current) ? this.current : fallback, false);
  }

  /** Open a section; `open` also shows it in place of the list on a narrow screen. */
  choose(id: string, open: boolean): void {
    const sections = this.sections();
    if (!sections.some((s) => s.dataset.section === id)) id = sections[0]?.dataset.section ?? id;
    this.current = id;
    try {
      sessionStorage.setItem(this.remember, id);
    } catch {
      // the choice is just not remembered
    }
    for (const s of sections) s.classList.toggle("active", s.dataset.section === id);
    for (const b of this.sheet.querySelectorAll<HTMLElement>(".setnav button")) b.classList.toggle("on", b.dataset.for === id);
    if (open) {
      this.sheet.classList.add("detail");
      this.sheet.scrollTop = 0;
    }
  }

  /** How the sheet opens: on a narrow screen, with the list. */
  toList(): void {
    this.sheet.classList.remove("detail");
  }
}
