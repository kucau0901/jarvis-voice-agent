import { api } from "../key";
import { arm, button, el } from "./util";

/**
 * Settings → Skills (src/worker/lib/skills.ts): the outside services Jarvis
 * was asked, in chat, to send requests to, each with its key. Added and
 * changed in chat, never here; the key is typed only here, and never shown
 * again. Built with textContent throughout.
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
}

export class Skills {
  /** The section, for Settings to place: `data-state` is ✓ every one has its key, ! one waits for it, ○ none. */
  readonly el: HTMLElement;
  private key: string;
  private list = el("div", "rlist");
  private res = el("div", "res");
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
        "never shown again; a skill is used once it has one. One that answers later sends its answer to POST /api/v1/notify, " +
        "with an alerts-only token from Devices. MCP servers added in chat are under MCP servers."),
      this.list,
      this.res,
    );
  }

  async load(): Promise<void> {
    try {
      this.render(((await api(this.key, "GET", "/api/skills")) as { skills: SkillView[] }).skills);
    } catch (e) {
      this.say(`Could not read the skills: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  private say(text: string, bad = false): void {
    this.res.textContent = text;
    this.res.classList.toggle("bad", bad);
  }

  private render(all: SkillView[]): void {
    this.el.dataset.state = !all.length ? "off" : all.every((s) => s.hasKey) ? "on" : "need";
    this.changed();
    this.list.replaceChildren(...(all.length ? all.map((s) => this.row(s)) : [el("p", "note", "None yet.")]));
  }

  private row(s: SkillView): HTMLElement {
    const row = el("div", "routine");
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
        this.say(`${s.name} is removed.`);
        await this.load();
      } catch (e) {
        this.say(e instanceof Error ? e.message : String(e), true);
      }
    });
    btns.appendChild(remove);
    row.append(form, btns);
    return row;
  }
}
