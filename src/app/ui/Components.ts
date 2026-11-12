import { api } from "../key";
import { arm, button, el } from "./util";
import { copyLine } from "../botAddress";

/**
 * Settings → Components (src/worker/lib/components.ts): other systems
 * plugged into Jarvis. Here one is added by its address, asked what it
 * offers, and approved: every tool's name and description is read before any
 * of it is used, and what it changes later waits here again. Here too each
 * tool is classed (reads, acts, off), an acting tool is set to ask first or
 * to run by itself (the owner's choice alone), the component is shared
 * person by person, its key is typed, and its reporting address is made,
 * shown once. Built with textContent throughout: what a component says of
 * itself is shown as text, never run.
 */

interface ToolView {
  name: string;
  description: string;
  args: string[];
  reads: boolean;
  alone?: true;
  off?: true;
  /** What the component itself says of it: true, it only reads. */
  hint?: boolean;
  /** Named like a look-up: with nobody there it is neither proposed nor run. */
  looksUp?: true;
  change?: "new" | "changed";
}

interface CatalogView {
  hash: string;
  at: number;
  version?: string;
  tools: ToolView[];
  events: { type: string; says: string }[];
  gone?: string[];
}

interface Share {
  level: "see" | "use";
  tell?: true;
  as?: string;
}

interface ComponentView {
  id: string;
  label: string;
  name: string;
  url: string;
  enabled: boolean;
  hasKey: boolean;
  shares: Record<string, Share>;
  pinned?: CatalogView & { inForce: boolean };
  waiting?: CatalogView;
  address?: { hint: string; at: number };
  today: { told: number; acted: number };
}

interface Person {
  person: string;
  name: string;
  role: string;
  /** Whether they hold `components`: without it a share gives them nothing. */
  holds: boolean;
}

type ToolClass = "reads" | "acts" | "off";
const classOf = (t: ToolView): ToolClass => (t.off ? "off" : t.reads ? "reads" : "acts");
const CLASS_WORDS: Record<ToolClass, string> = { reads: "Reads only", acts: "Acts", off: "Off" };
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A choice among a few, said in words: its first option is its value until changed. */
function choice(options: [value: string, words: string][], value: string, label: string): HTMLSelectElement {
  const s = el("select");
  s.setAttribute("aria-label", label);
  for (const [v, words] of options) {
    const o = el("option", "", words);
    o.value = v;
    s.appendChild(o);
  }
  s.value = value;
  return s;
}

export class Components {
  /** The section, for Settings to place: `data-state` is ✓ all in use, ! one waits for an admin, ○ none. */
  readonly el: HTMLElement;
  private key: string;
  private list = el("div", "rlist");
  private res = el("div", "res");
  /** The component the last thing said is about: said in its row, where it was done, not at the foot of a long list. */
  private about: string | null = null;
  private people: Person[] = [];
  /** Whether this screen's person decides what runs by itself (the owner key, or whoever set Jarvis up). */
  private owner = false;
  /** A new reporting address, shown this once, in its component's row: kept there when the list is drawn again. */
  private shown: { card: HTMLElement; id: string } | null = null;
  private changed: () => void;

  constructor(key: string, changed: () => void) {
    this.key = key;
    this.changed = changed;
    this.el = el("section", "svc components");
    this.el.dataset.section = "components";
    this.el.dataset.title = "Components";
    this.el.dataset.state = "off";
    const name = this.field("Its name, e.g. School", "Its name");
    const url = this.field("https://… (its MCP server's address)", "Its address");
    const label = this.field("A short label (optional), e.g. school", "Its label");
    const form = el("div", "rform");
    form.append(name, url, label, button("Add", async () => {
      await this.act(async () => {
        await api(this.key, "POST", "/api/components", { name: name.value, url: url.value.trim(), ...(label.value.trim() ? { label: label.value.trim() } : {}) });
        name.value = url.value = label.value = "";
      }, "Added. Now have Jarvis ask it what it offers.");
    }, "primary"));
    this.el.append(
      el("h3", "", "Components"),
      el("p", "note",
        "Other systems plugged into Jarvis: a school's timetable, a shop's till. Each is an MCP server at a public https address. " +
        "Add one, have Jarvis ask it what it offers, read that, and approve it: only what you approved is ever shown to Jarvis, and " +
        "anything it changes later waits here for you. Then share it, person by person. What a component says is read as data, " +
        "never as an instruction. Moved to a new address? Add it again with the same label: its key is typed again, and what it " +
        "offers approved again."),
      form,
      this.res,
      this.list,
    );
  }

  private field(placeholder: string, label: string, type = "text"): HTMLInputElement {
    const input = el("input");
    input.type = type;
    input.autocomplete = "off";
    input.placeholder = placeholder;
    input.setAttribute("aria-label", label);
    return input;
  }

  async load(): Promise<void> {
    try {
      const got = (await api(this.key, "GET", "/api/components")) as { components: ComponentView[]; people: Person[]; owner: boolean };
      this.people = got.people;
      this.owner = got.owner;
      this.render(got.components);
    } catch (e) {
      this.say(`Could not read the components: ${why(e)}`, true);
    }
  }

  /** Said under the form, or, about one component, at the foot of its row. */
  private say(text: string, bad = false, about: string | null = null): void {
    this.res.textContent = text;
    this.res.classList.toggle("bad", bad);
    this.about = about;
    this.settle();
  }

  private settle(): void {
    const row = this.about ? this.list.querySelector(`[data-component="${CSS.escape(this.about)}"]`) : null;
    if (row) row.appendChild(this.res);
    else this.list.before(this.res);
  }

  /** One change: made, said, and the list read again; or why not. */
  private async act(go: () => Promise<unknown>, said: string, about: string | null = null): Promise<void> {
    try {
      await go();
      this.say(said, false, about);
      await this.load();
    } catch (e) {
      this.say(why(e), true, about);
    }
  }

  private change(c: ComponentView, body: Record<string, unknown>, said: string): Promise<void> {
    return this.act(() => api(this.key, "PATCH", "/api/components", { id: c.id, ...body }), said, c.id);
  }

  private render(all: ComponentView[]): void {
    const waits = (c: ComponentView) => c.enabled && (!c.pinned || !c.pinned.inForce || !!c.waiting);
    this.el.dataset.state = !all.length ? "off" : all.some(waits) ? "need" : "on";
    this.changed();
    this.list.replaceChildren(...(all.length ? all.map((c) => this.row(c)) : [el("p", "note", "None yet.")]));
    this.settle();
    if (this.shown) this.place(this.shown);
  }

  private row(c: ComponentView): HTMLElement {
    const row = el("div", c.enabled ? "routine" : "routine off");
    row.dataset.component = c.id;
    const top = el("div", "rtop");
    const state = !c.enabled ? "switched off" : c.pinned && !c.pinned.inForce ? "moved: check it again" : c.waiting ? "waiting for your approval" : c.pinned ? "in use" : "not checked yet";
    top.append(el("b", "", c.name), el("small", "", state));
    const version = (c.waiting ?? c.pinned)?.version;
    row.append(
      top,
      el("div", "rwhen", `${c.label} · ${c.url}`),
      el("div", "rfacts", [c.hasKey ? "key set" : "no key", ...(version ? [`version ${version}`] : []), `today: told ${c.today.told}, did ${c.today.acted} by itself`].join(" · ")),
    );
    if (c.waiting) row.appendChild(this.waiting(c, c.waiting));
    if (c.pinned?.inForce) row.append(this.approved(c, c.pinned), this.sharing(c));

    const form = el("div", "rform");
    const input = this.field(c.hasKey ? "A new key, to replace it" : "Its key, if it needs one", `${c.name}'s key`, "password");
    form.appendChild(input);
    const btns = el("div", "rowbtns");
    btns.append(
      button("Save key", () => void this.act(() => api(this.key, "PUT", "/api/components", { id: c.id, key: input.value.trim() }), `${c.name}'s key is saved.`, c.id)),
      button("Ask what it offers", () => void this.check(c), c.pinned?.inForce ? "" : "primary"),
      button(c.enabled ? "Switch off" : "Switch on", () => void this.change(c, { enabled: !c.enabled }, `${c.name} is ${c.enabled ? "off: nobody is offered it, and its reports are refused" : "on"}.`)),
    );
    const remove = el("button", "", "Remove");
    remove.type = "button";
    arm(remove, "Remove it?", () => this.act(async () => {
      await api(this.key, "DELETE", `/api/components?id=${encodeURIComponent(c.id)}`);
      this.forget();
    }, `${c.name} is removed.`));
    btns.appendChild(remove);
    row.append(form, btns, this.reports(c));
    return row;
  }

  /** Asked now: what differs from what is approved waits, and what it listed that Jarvis cannot use is said. */
  private async check(c: ComponentView): Promise<void> {
    this.say(`Asking ${c.name}…`, false, c.id);
    try {
      const got = (await api(this.key, "PATCH", "/api/components", { id: c.id, check: true })) as { component: ComponentView; skipped: { name: string; why: string }[] };
      const left = got.skipped.length ? ` Left out: ${got.skipped.map((s) => `${s.name} (${s.why})`).join("; ")}.` : "";
      this.say((got.component.waiting ? `${c.name} answered: read what it offers, then approve it.` : `${c.name} offers what you approved: nothing has changed.`) + left, false, c.id);
      await this.load();
    } catch (e) {
      this.say(why(e), true, c.id);
    }
  }

  /** One tool, as it would be or is approved: its name and arguments, its own description, and its class to choose. */
  private tool(t: ToolView, classed: HTMLSelectElement, extra: HTMLElement[] = []): HTMLElement {
    const box = el("div", "ctool");
    const name = el("div", "cname");
    name.append(el("code", "", `${t.name}(${t.args.join(", ")})`));
    if (t.change) name.append(el("small", "ctag", t.change));
    const hints = [
      ...(t.hint === true ? ["It says it only reads."] : t.hint === false ? ["It says it changes things."] : []),
      ...(t.looksUp && classOf(t) === "acts" ? ["Named like a look-up: with nobody there, Jarvis will neither propose it nor run it."] : []),
    ];
    box.append(name, classed, el("div", "csaid", t.description), ...(hints.length ? [el("div", "csaid dim", hints.join(" "))] : []), ...extra);
    return box;
  }

  private waiting(c: ComponentView, w: CatalogView): HTMLElement {
    const box = el("div", "cpart");
    const picks = new Map<string, HTMLSelectElement>();
    box.append(
      el("h4", "", "Waiting for your approval"),
      el("p", "note", "Read each one: its description is what Jarvis is shown, and nothing here is used until you approve it. " +
        "A tool that only looks things up can be Reads only; anything that changes, sends or books is Acts, and then asks first when nobody is there."),
      ...w.tools.map((t) => {
        const pick = choice(Object.entries(CLASS_WORDS) as [ToolClass, string][], classOf(t), `${t.name} is`);
        picks.set(t.name, pick);
        return this.tool(t, pick);
      }),
    );
    if (!w.tools.length) box.appendChild(el("p", "note", "It offers no tools."));
    if (w.events.length) box.appendChild(el("p", "note", `It will report: ${w.events.map((e) => `${e.type} (${e.says})`).join("; ")}.`));
    if (w.gone?.length) box.appendChild(el("p", "note", `It no longer offers: ${w.gone.join(", ")}.`));
    const btns = el("div", "rowbtns");
    btns.appendChild(button("Approve what is shown", () => void this.change(c, { approve: w.hash, classes: Object.fromEntries([...picks].map(([n, s]) => [n, s.value])) }, `${c.name} is approved as shown.`), "primary"));
    box.appendChild(btns);
    return box;
  }

  private approved(c: ComponentView, p: CatalogView): HTMLElement {
    const box = el("div", "cpart");
    box.appendChild(el("h4", "", "What Jarvis may use"));
    for (const t of p.tools) {
      const pick = choice(Object.entries(CLASS_WORDS) as [ToolClass, string][], classOf(t), `${t.name} is`);
      pick.addEventListener("change", () => void this.change(c, { classes: { [t.name]: pick.value } }, `${t.name} is now: ${CLASS_WORDS[pick.value as ToolClass].toLowerCase()}.`));
      const extra: HTMLElement[] = [];
      // An acting tool: whether Jarvis may run it with nobody there. The owner's choice alone.
      if (classOf(t) === "acts" && !t.looksUp) {
        const alone = choice([["ask", "With nobody there: ask first"], ["alone", "With nobody there: by itself"]], t.alone ? "alone" : "ask", `${t.name}, with nobody there`);
        alone.disabled = !this.owner;
        alone.addEventListener("change", () => void this.change(c, { alone: { [t.name]: alone.value === "alone" } },
          alone.value === "alone" ? `${t.name} may now run by itself: Jarvis tells you each time, and stops at 20 a day.` : `${t.name} asks first again.`));
        const lone = el("div", "calone");
        lone.append(alone, el("small", "", this.owner
          ? "By itself: a routine, a job, or the component's own report may run it with nobody there. Jarvis tells you each time."
          : "Only the owner key, or the person who set Jarvis up, can change this."));
        extra.push(lone);
      }
      box.appendChild(this.tool(t, pick, extra));
    }
    if (!p.tools.length) box.appendChild(el("p", "note", "No tools: it only reports."));
    if (p.events.length) {
      box.appendChild(el("p", "note", `It reports: ${p.events.map((e) => `${e.type} (${e.says})`).join("; ")}. ` +
        `Someone it is shared with can ask Jarvis for a routine on one: "when ${c.name} reports that, tell me".`));
    }
    return box;
  }

  /** Who it is shared with: to look only or to use, whether they are told its reports, and who they are there. */
  private sharing(c: ComponentView): HTMLElement {
    const box = el("div", "cpart");
    box.append(
      el("h4", "", "Shared with"),
      el("p", "note", "Nobody is offered it until it is shared with them, admins too. Look only: its reading tools. Use: all of them. " +
        "Their id there is who they are in its own system, sent with what they ask so it can answer as them: leave it empty if it has none."),
    );
    const rows = this.people.map((p) => {
      const had = c.shares[p.person];
      const level = choice([["", "Not shared"], ["see", "Look only"], ["use", "Use"]], had?.level ?? "", `Share ${c.name} with ${p.name || "you"}`);
      const tell = el("input");
      tell.type = "checkbox";
      tell.checked = had?.tell === true;
      const told = el("label", "on");
      told.append(tell, "Tell them what it reports");
      const as = this.field("Their id there (optional)", `${p.name || "Your"} id in ${c.name}`);
      as.value = had?.as ?? "";
      const who = el("div", "cname");
      who.append(el("b", "", p.name || "You"));
      // Without the permission above it, a share gives them nothing: said, so it is not a puzzle.
      if (!p.holds) who.append(el("small", "ctag", "needs “components” in Family"));
      const row = el("div", "cshare");
      row.append(who, level, told, as);
      return { person: p.person, level, tell, as, row };
    });
    box.append(...rows.map((r) => r.row));
    const btns = el("div", "rowbtns");
    btns.appendChild(button("Save sharing", () => void this.change(c, {
      shares: Object.fromEntries(rows.map((r) => [r.person, r.level.value ? { level: r.level.value, tell: r.tell.checked, as: r.as.value.trim() } : null])),
    }, `${c.name} is shared as shown.`)));
    box.appendChild(btns);
    return box;
  }

  /** Its own address to report to Jarvis: made, made again, or stopped. */
  private reports(c: ComponentView): HTMLElement {
    const box = el("div", "talks");
    const a = c.address;
    box.appendChild(el("div", "rwhen", a
      ? `Reports to Jarvis with its address ${a.hint}, made ${new Date(a.at).toLocaleDateString()}.`
      : "It cannot report to Jarvis. Give it an address of its own to tell Jarvis what happened: only the events it declared are taken."));
    const btns = el("div", "rowbtns");
    if (!a) {
      btns.appendChild(button("Make its address", () => void this.make(c)));
    } else {
      const again = el("button", "", "New address");
      again.type = "button";
      arm(again, "Replace it?", () => this.make(c));
      const stop = el("button", "", "Stop it");
      stop.type = "button";
      arm(stop, "Stop it?", async () => {
        this.forget();
        await this.change(c, { address: false }, `${c.name}'s address is stopped.`);
      });
      btns.append(again, stop);
    }
    box.appendChild(btns);
    return box;
  }

  /** A new address shown once is not left showing: Settings closed (ui/Settings.ts hide), or that address stopped. */
  forget(): void {
    this.shown?.card.remove();
    this.shown = null;
  }

  /** Above its row's reporting line; with the component gone, not at all. */
  private place(shown: { card: HTMLElement; id: string }): void {
    const at = this.list.querySelector(`[data-component="${CSS.escape(shown.id)}"] .talks`);
    if (at) at.before(shown.card);
    else this.forget();
  }

  /** A new reporting address: shown this once in its row, as a device's token is; Jarvis keeps only its digest. */
  private async make(c: ComponentView): Promise<void> {
    try {
      const m = (await api(this.key, "PATCH", "/api/components", { id: c.id, address: true })) as { token: string; url: string };
      const said = el("small", "addrsaid", "");
      const lines = el("div", "addrlines");
      lines.append(copyLine({ label: "It posts its events to", value: m.url }, said), copyLine({ label: "With the header", value: `Authorization: Bearer ${m.token}` }, said));
      const card = el("div", "token addrcard");
      card.append(
        el("b", "doctitle", `${c.name}'s reporting address: shown only now`),
        lines,
        button(`Done, it's in ${c.name}`, () => {
          this.forget();
          this.say(`${c.name}'s address is in.`, false, c.id);
        }, "docopen primary"),
        said,
        el("p", "", "Only a fingerprint of it is kept. Lost, make a new one: the old one stops. Closing Settings hides it."),
      );
      this.forget();
      this.shown = { card, id: c.id };
      // Shown at once, in the row pressed: the list read again moves it, and its failing must not lose it.
      this.place(this.shown);
      this.say(`${c.name} has an address to report to.`, false, c.id);
      await this.load();
    } catch (e) {
      this.say(why(e), true, c.id);
    }
  }
}
