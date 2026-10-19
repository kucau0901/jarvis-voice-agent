import { api } from "../key";
import { arm, button, el } from "./util";

/**
 * Settings → ChatGPT plan (src/worker/lib/chatgpt-plan.ts): the owner's
 * ChatGPT Plus or Pro, which every question uses before any API key.
 *
 * OpenAI sends the browser back to a loopback address that a Worker cannot
 * answer, so connecting ends with a paste: the tab that cannot load holds the
 * code in its address. Built with textContent throughout.
 */

interface PlanView {
  connected: boolean;
  pending: boolean;
  email?: string;
  model?: string | null;
  limitedUntil?: number;
  problem?: string;
  /** Whether an OpenAI key is set too: for live voice, and to carry on at the plan's limit. */
  key?: boolean;
  models?: { id: string; name: string }[];
  modelsError?: string;
}

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export class ChatGptPlan {
  /** The section, for Settings to place: `data-state` is ✓ connected, ! with neither a plan nor a key, ○ otherwise. */
  readonly el: HTMLElement;
  private key: string;
  private body: HTMLElement;
  private res: HTMLElement;
  /** Told when its state changes, so the menu's mark follows. */
  private changed: () => void;

  constructor(key: string, changed: () => void) {
    this.key = key;
    this.changed = changed;
    this.el = el("section", "svc chatgpt");
    this.el.dataset.section = "chatgpt";
    this.el.dataset.title = "ChatGPT plan";
    this.el.dataset.state = "off";
    this.el.appendChild(el("h3", "", "ChatGPT plan"));
    this.el.appendChild(
      el("p", "note",
        "Your ChatGPT Plus or Pro plan pays for Jarvis's questions, chat, jobs and routines, out of the usage it already " +
        "includes. With an API key too, the plan is used first and the key for live voice (which only a key can run) " +
        "and, if you allow it, when the plan's limit is reached. One plan for the whole family."),
    );
    this.body = el("div", "planbody");
    this.res = el("div", "res");
    this.el.append(this.body, this.res);
  }

  async load(): Promise<void> {
    try {
      this.render((await api(this.key, "GET", "/api/chatgpt")) as PlanView);
    } catch (e) {
      this.say(`Could not read the plan: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  private say(text: string, bad = false): void {
    this.res.textContent = text;
    this.res.classList.toggle("bad", bad);
  }

  private render(v: PlanView): void {
    this.el.dataset.state = v.connected && !v.problem ? "on" : v.key ? "off" : "need";
    this.changed();
    // A plan that needs signing in again is connected again the same way.
    this.body.replaceChildren(...(v.connected ? this.connected(v) : []), ...(!v.connected || v.problem ? this.connect(v) : []));
  }

  /** Not connected: the button, and where to paste what the browser ended on. */
  private connect(v: PlanView): HTMLElement[] {
    const steps = el("ol", "note plansteps");
    for (const s of [
      "Press Connect ChatGPT. A ChatGPT sign-in opens in a new tab.",
      "Sign in and allow Jarvis to use your plan.",
      "The tab then ends on a page that cannot be reached, at 127.0.0.1. That is expected: copy that page's whole address.",
      "Paste it below and press Finish.",
    ]) steps.appendChild(el("li", "", s));
    const go = button("Connect ChatGPT", () => void this.start(go), "primary");
    const paste = el("input");
    paste.type = "text";
    paste.placeholder = "http://127.0.0.1:1455/auth/callback?code=…";
    paste.setAttribute("aria-label", "The address the sign-in ended on");
    const finish = button("Finish", () => void this.finish(paste.value, finish));
    const row = (...b: HTMLElement[]) => {
      const r = el("div", "rowbtns");
      r.append(...b);
      return r;
    };
    return [
      ...(!v.key && !v.connected ? [el("p", "note", "Jarvis has neither a ChatGPT plan nor an OpenAI key yet: connect one to ask it anything.")] : []),
      steps,
      row(go),
      // Once a sign-in is under way: where its address goes.
      ...(v.pending ? [paste, row(finish)] : []),
    ];
  }

  private connected(v: PlanView): HTMLElement[] {
    const out: HTMLElement[] = [el("p", "now", `Connected${v.email ? ` as ${v.email}` : ""}. Questions use your plan first.`)];
    if (v.problem) out.push(el("p", "now bad", v.problem));
    if (v.limitedUntil) out.push(el("p", "now", `The plan's limit was reached: ${v.key ? "the API key is used" : "questions wait"} until ${time(v.limitedUntil)}, then the plan is tried again.`));
    if (!v.key) out.push(el("p", "note", "Live voice needs an OpenAI key; push-to-talk and typing work on the plan."));

    // The plan's own model for questions, tried before it is used.
    const pick = el("select", "pick");
    pick.setAttribute("aria-label", "The plan's model");
    const same = el("option", "", "The router model");
    same.value = "";
    pick.appendChild(same);
    for (const m of v.models ?? []) {
      const o = el("option", "", m.name);
      o.value = m.id;
      pick.appendChild(o);
    }
    pick.value = v.model ?? "";
    const use = button("Use this model", () => void this.useModel(pick.value, use), "primary");
    const off = button("Disconnect", () => {});
    arm(off, "Disconnect for good?", () => this.disconnect());
    const row = el("div", "rowbtns");
    row.append(use, off);
    out.push(el("p", "note", "Model for questions on the plan:"), pick, row);
    if (v.modelsError) out.push(el("p", "note", `Its models could not be listed: ${v.modelsError}`));
    return out;
  }

  private async start(b: HTMLButtonElement): Promise<void> {
    b.disabled = true;
    try {
      const { url } = (await api(this.key, "POST", "/api/chatgpt/start")) as { url: string };
      window.open(url, "_blank", "noopener");
      this.say("");
      await this.load();
    } catch (e) {
      this.say(`Could not start: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      b.disabled = false;
    }
  }

  private async finish(address: string, b: HTMLButtonElement): Promise<void> {
    if (!address.trim()) return this.say("Paste the address the sign-in ended on first.", true);
    b.disabled = true;
    this.say("Connecting…");
    try {
      this.render((await api(this.key, "POST", "/api/chatgpt/finish", { address })) as PlanView);
      this.say("Connected.");
      await this.load();
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
      await this.load();
    } finally {
      b.disabled = false;
    }
  }

  private async useModel(model: string, b: HTMLButtonElement): Promise<void> {
    b.disabled = true;
    this.say(model ? "Trying it on your plan…" : "");
    try {
      await api(this.key, "PUT", "/api/chatgpt/model", { model: model || null });
      this.say(model ? `${model} works on your plan, and is in use.` : "Questions on the plan use the router model.");
      await this.load();
    } catch (e) {
      this.say(`Not changed: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      b.disabled = false;
    }
  }

  private async disconnect(): Promise<void> {
    try {
      this.render((await api(this.key, "DELETE", "/api/chatgpt")) as PlanView);
      this.say("Disconnected.");
    } catch (e) {
      this.say(`Could not disconnect: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
}
