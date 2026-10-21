import { api } from "../key";
import { button, el } from "./util";
import type { Prefs } from "./Mine";

/**
 * Family → You → About you: what Jarvis should know of you to help — what you
 * like to be called and your birthday (your own choices, PATCH /api/hub/me),
 * and, with memory, home and work (places "home" and "work" in your own book)
 * and the people in your life with who each is to you (person facts with a
 * relation), so "remind my wife" and "how long to work" just work. Nothing is
 * guessed silently: a work address seen in your calendar is offered, and kept
 * only if you say so.
 */

interface Fact { id: string; text: string; kind: string; slug?: string; address?: string; relation?: string }

const RELATIONS = ["wife", "husband", "partner", "daughter", "son", "mother", "father", "sister", "brother", "grandmother", "grandfather", "friend", "colleague"];

export class Profile {
  private key: string;
  private box: HTMLElement;
  private prefs: Prefs;
  private may: (...need: string[]) => boolean;
  private save: (prefs: Prefs, ok: string) => Promise<void>;
  private say: (text: string, bad?: boolean) => void;

  constructor(key: string, box: HTMLElement, prefs: Prefs, may: (...need: string[]) => boolean, save: (prefs: Prefs, ok: string) => Promise<void>, say: (text: string, bad?: boolean) => void) {
    this.key = key;
    this.box = box;
    this.prefs = prefs;
    this.may = may;
    this.save = save;
    this.say = say;
  }

  render(): void {
    const nick = Object.assign(document.createElement("input"), { type: "text", maxLength: 40, placeholder: "What you like to be called", value: this.prefs.nickname ?? "" });
    const born = Object.assign(document.createElement("input"), { type: "date", value: this.prefs.birthday ?? "" });
    born.setAttribute("aria-label", "Your birthday");
    const row = el("div", "rowbtns");
    row.appendChild(button("Save", () => void this.save({ nickname: nick.value.trim(), birthday: born.value }, "Saved: Jarvis knows."), "primary"));
    this.box.append(el("p", "note", "Empty means Jarvis uses your name and does not know the day."), nick, born, row);
    if (this.may("memory.write")) void this.places();
  }

  /** What is saved now, read again after each change, so each change is to what is there. */
  private facts: Fact[] = [];

  private async refresh(): Promise<void> {
    this.facts = ((await api(this.key, "GET", "/api/memory")) as { facts: Fact[] }).facts;
  }

  private placeNamed(slug: string): Fact | undefined {
    return this.facts.find((f) => f.kind === "place" && f.slug === slug);
  }

  /** Home, work and the people in your life: from your own memory, changed one fact at a time. */
  private async places(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      return; // A locked profile, or memory unreachable: the rest of the section still works.
    }
    const where = el("div", "m-places");
    for (const [slug, label] of [["home", "Home"], ["work", "Work"]] as const) {
      const input = Object.assign(document.createElement("input"), { type: "text", maxLength: 300, placeholder: `${label}: an address`, value: this.placeNamed(slug)?.address ?? "" });
      input.setAttribute("aria-label", `${label} address`);
      const btns = el("div", "rowbtns");
      btns.appendChild(button(`Save ${label.toLowerCase()}`, () => void this.place(slug, label, input.value.trim())));
      where.append(el("h4", "", label), input, btns);
    }
    const people = el("div", "m-people");
    this.box.append(where, el("h4", "", "People in your life"), people, this.addPerson());
    this.people(people);
    if (!this.placeNamed("work") && this.may("calendar")) void this.suggestWork(where);
  }

  /** Home or work saved at an address, or removed: what was written of it before is kept. Whether it was. */
  private async place(slug: string, label: string, address: string): Promise<boolean> {
    const was = this.placeNamed(slug);
    try {
      if (address && was) await api(this.key, "PATCH", "/api/memory", { id: was.id, text: was.text, name: slug, address });
      else if (address) await api(this.key, "POST", "/api/memory", { kind: "place", name: slug, text: label, address });
      else if (was) await api(this.key, "DELETE", "/api/memory", { id: was.id });
      else return true;
      await this.refresh();
      this.say(address ? `Saved: ${label.toLowerCase()} is ${address}.` : `Removed ${label.toLowerCase()}.`);
      return true;
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
      return false;
    }
  }

  private people(box: HTMLElement): void {
    const mine = this.facts.filter((f) => f.kind === "person");
    box.replaceChildren(...(mine.length ? mine.map((f) => {
      const r = el("div", "routine");
      const top = el("div", "rtop");
      top.append(el("b", "", f.text), el("small", "", f.relation ?? ""));
      const btns = el("div", "rowbtns");
      btns.appendChild(button("Remove", async () => {
        try {
          await api(this.key, "DELETE", "/api/memory", { id: f.id });
          await this.refresh();
          r.remove();
        } catch (e) {
          this.say(e instanceof Error ? e.message : String(e), true);
        }
      }));
      r.append(top, btns);
      return r;
    }) : [el("p", "note", "None yet. Who Jarvis should know, and who they are to you.")]));
  }

  private addPerson(): HTMLElement {
    const f = el("div", "rform");
    const name = Object.assign(document.createElement("input"), { type: "text", maxLength: 60, placeholder: "Their name" });
    const relation = Object.assign(document.createElement("input"), { type: "text", maxLength: 30, placeholder: "Who they are to you: wife, daughter…" });
    const list = document.createElement("datalist");
    list.id = "m-relations";
    for (const r of RELATIONS) list.appendChild(Object.assign(document.createElement("option"), { value: r }));
    relation.setAttribute("list", list.id);
    const note = Object.assign(document.createElement("input"), { type: "text", maxLength: 200, placeholder: "Anything to remember about them (optional)" });
    const add = button("Add", async () => {
      const who = name.value.trim();
      if (!who) return this.say("Say their name.", true);
      // Someone saved already, by voice or before: who they are to you added, what was saved of them kept.
      const slug = who.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const was = this.facts.find((x) => x.kind === "person" && !!slug && x.slug === slug);
      const text = note.value.trim() ? `${who}: ${note.value.trim()}` : was?.text ?? who;
      try {
        if (was) await api(this.key, "PATCH", "/api/memory", { id: was.id, text, name: who, relation: relation.value.trim() });
        else await api(this.key, "POST", "/api/memory", { kind: "person", name: who, text, relation: relation.value.trim() });
        name.value = relation.value = note.value = "";
        await this.refresh();
        this.people(this.box.querySelector<HTMLElement>(".m-people")!);
        this.say(was ? `Updated: ${who}.` : `Saved: Jarvis knows ${who}.`);
      } catch (e) {
        this.say(e instanceof Error ? e.message : String(e), true);
      }
    });
    f.append(name, relation, list, note, add);
    return f;
  }

  /** Where they work, as their calendar suggests: offered, never saved without a tap (lib/work-place.ts). */
  private async suggestWork(where: HTMLElement): Promise<void> {
    const r = (await api(this.key, "GET", "/api/memory/work").catch(() => null)) as { suggestion: { address: string; days: number } | null } | null;
    const s = r?.suggestion;
    if (!s) return;
    const offer = el("div", "m-workhint");
    offer.appendChild(el("p", "note", `Seen in your calendar on ${s.days} days this month: ${s.address}. Is that work?`));
    const btns = el("div", "rowbtns");
    btns.append(
      button("Use as work", async () => {
        if (!(await this.place("work", "Work", s.address))) return;
        const input = where.querySelector<HTMLInputElement>('input[aria-label="Work address"]');
        if (input) input.value = s.address;
        offer.remove();
      }, "primary"),
      button("Not this", () => offer.remove()),
    );
    offer.appendChild(btns);
    where.appendChild(offer);
  }
}
