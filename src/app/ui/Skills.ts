import { api } from "../key";
import { arm, button, el } from "./util";
import { scopeLabels } from "./Devices";
import { makeAddress, shownOnce } from "../botAddress";

/**
 * Settings → Skills (src/worker/lib/skills.ts): the outside services Jarvis
 * was asked, in chat, to send requests to, each with its key. Added and
 * changed in chat, never here; the key is typed only here, and never shown
 * again. Here too each one's bot is given an address of its own, to ask
 * Jarvis and message you, reaching only what is ticked: shown once, as a
 * device's token is. Built with textContent throughout.
 */

interface SkillView {
  id: string;
  name: string;
  url: string;
  when: string;
  later: boolean;
  keyHeader?: string;
  fields: Record<string, string>;
  hasKey: boolean;
  /** Its bot's own address: never the token, which is shown once (make). */
  address?: { hint: string; person: string; reach: string[]; at: number };
}

export class Skills {
  /** The section, for Settings to place: `data-state` is ✓ every one has its key, ! one waits for it, ○ none. */
  readonly el: HTMLElement;
  private key: string;
  private list = el("div", "rlist");
  private res = el("div", "res");
  /** A new address, shown this once, in its skill's row: kept there when the list is drawn again. */
  private shown: { card: HTMLElement; id: string } | null = null;
  /** What an address may be ticked to reach (src/worker/lib/skills.ts BOT_REACH). */
  private reach: string[] = [];
  /** Told when its state changes, so the menu's mark follows. */
  private changed: () => void;

  constructor(key: string, changed: () => void) {
    this.key = key;
    this.changed = changed;
    this.el = el("section", "svc skills");
    this.el.dataset.section = "skills";
    this.el.dataset.title = "Skills";
    this.el.dataset.state = "off";
    this.el.append(
      el("h3", "", "Skills"),
      el("p", "note",
        "Outside services Jarvis sends requests to: a bot, an automation, your own code. Add one in chat, with its address: " +
        "\"add a skill: Nova, my Grok bot, for the house and the car, at https://…\". Its key goes here, never in chat, and is " +
        "never shown again; a skill is used once it has one. One that answers later posts its answer to the replyUrl in each " +
        "request: it needs no token, and its answer shows in Chat under its name. Give one an address of its own to let it ask " +
        "Jarvis or message you, reaching only what you tick, here or by asking in chat (\"give Zephyr its own address\"). " +
        "MCP servers added in chat are under MCP servers."),
      this.list,
      this.res,
    );
  }

  async load(): Promise<void> {
    try {
      const got = (await api(this.key, "GET", "/api/skills")) as { skills: SkillView[]; reach: string[] };
      this.reach = got.reach;
      this.render(got.skills);
    } catch (e) {
      this.say(`Could not read the skills: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  private say(text: string, bad = false): void {
    this.res.textContent = text;
    this.res.classList.toggle("bad", bad);
  }

  private render(all: SkillView[]): void {
    // One that only asks Jarvis, through its own address, needs no key.
    this.el.dataset.state = !all.length ? "off" : all.every((s) => s.hasKey || s.address) ? "on" : "need";
    this.changed();
    this.list.replaceChildren(...(all.length ? all.map((s) => this.row(s)) : [el("p", "note", "None yet.")]));
    if (this.shown) this.place(this.shown);
  }

  private row(s: SkillView): HTMLElement {
    const row = el("div", "routine");
    row.dataset.skill = s.id;
    const top = el("div", "rtop");
    top.append(el("b", "", s.name), el("small", "", s.hasKey ? "key set" : "needs its key"));
    row.append(top, el("div", "rwhen", s.when));
    const facts = [s.url, s.later ? "answers later, as a message" : "answers at once"];
    if (s.keyHeader) facts.push(`key also in ${s.keyHeader}`);
    for (const [k, v] of Object.entries(s.fields)) facts.push(`${k}: ${v}`);
    row.appendChild(el("div", "rfacts", facts.join(" · ")));
    const form = el("div", "rform");
    const input = el("input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = s.hasKey ? "A new key, to replace it" : "Its key";
    input.setAttribute("aria-label", `${s.name}'s key`);
    form.appendChild(input);
    const btns = el("div", "rowbtns");
    btns.appendChild(button("Save key", async () => {
      try {
        await api(this.key, "PUT", "/api/skills", { id: s.id, key: input.value.trim() });
        this.say(`${s.name}'s key is saved.`);
        await this.load();
      } catch (e) {
        this.say(e instanceof Error ? e.message : String(e), true);
      }
    }, "primary"));
    const remove = el("button", "", "Remove");
    remove.type = "button";
    arm(remove, "Remove it?", async () => {
      try {
        await api(this.key, "DELETE", `/api/skills?id=${encodeURIComponent(s.id)}`);
        this.forget();
        this.say(`${s.name} is removed.`);
        await this.load();
      } catch (e) {
        this.say(e instanceof Error ? e.message : String(e), true);
      }
    });
    btns.appendChild(remove);
    row.append(form, btns, this.talks(s));
    return row;
  }

  /** Its bot's own address, to ask Jarvis and message you: what it may reach, made, made again, or stopped. */
  private talks(s: SkillView): HTMLElement {
    const box = el("div", "talks");
    const a = s.address;
    box.appendChild(el("div", "rwhen", a
      ? `Talks to Jarvis, with its address ${a.hint}, made ${new Date(a.at).toLocaleDateString()}. It may reach:`
      : "It cannot ask Jarvis or message you. Give it an address of its own to do that, reaching only what you tick:"));
    const ticks = el("div", "scopes");
    ticks.append(...scopeLabels(this.reach, a?.reach ?? ["ask"]));
    const picked = () => [...ticks.querySelectorAll<HTMLInputElement>("input:checked")].map((b) => b.value);
    const btns = el("div", "rowbtns");
    if (!a) {
      btns.appendChild(button("Make its address", () => this.make(s, picked()), "primary"));
    } else {
      btns.appendChild(button("Save what it may reach", () => this.change(s, { reach: picked() }, `${s.name} may reach what is ticked now.`)));
      const again = el("button", "", "New address");
      again.type = "button";
      arm(again, "Replace it?", () => this.make(s, picked()));
      const stop = el("button", "", "Stop it");
      stop.type = "button";
      arm(stop, "Stop it?", () => this.change(s, { address: false }, `${s.name}'s address is stopped.`));
      btns.append(again, stop);
    }
    box.append(ticks, btns);
    return box;
  }

  /** A new address shown once is not left showing: Settings closed (ui/Settings.ts hide), or that address stopped. */
  forget(): void {
    this.shown?.card.remove();
    this.shown = null;
  }

  /** Above what its skill's bot may reach; with the skill gone, not at all. */
  private place(shown: { card: HTMLElement; id: string }): void {
    const talks = this.list.querySelector(`[data-skill="${CSS.escape(shown.id)}"] .talks`);
    if (talks) talks.before(shown.card);
    else this.forget();
  }

  private async change(s: SkillView, body: Record<string, unknown>, said: string): Promise<void> {
    try {
      await api(this.key, "PATCH", "/api/skills", { id: s.id, ...body });
      if (body.address === false) this.forget();
      this.say(said);
      await this.load();
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    }
  }

  /** A new address: shown this once in its row, as a device's token is (ui/Devices.ts); Jarvis keeps only its digest. */
  private async make(s: SkillView, reach: string[]): Promise<void> {
    try {
      const m = await makeAddress(this.key, s.id, reach);
      const card = el("div", "token addrcard");
      shownOnce(card, s.name, m, () => {
        this.forget();
        this.say(`${s.name}'s address is in.`);
      });
      card.appendChild(el("p", "", "Closing Settings hides it."));
      this.forget();
      this.shown = { card, id: s.id };
      // Shown at once, in the row pressed: the list read again moves it, and its failing must not lose it.
      this.place(this.shown);
      this.say(`${s.name} has an address of its own.`);
      await this.load();
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    }
  }
}
