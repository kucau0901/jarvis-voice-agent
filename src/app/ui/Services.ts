import { authHeaders } from "../key";

/**
 * Every setting Jarvis reads, shown and edited in the settings sheet.
 *
 * Secrets are never sent to this page, only a fingerprint (lib/settings.ts on
 * the Worker), so there is nothing here to leak: a field is blank until you
 * type a replacement, and what you type goes one way. Built with textContent
 * throughout — labels and values come from the server, and a saved value is
 * user input.
 */

interface SettingView {
  name: string;
  group: string;
  kind: "secret" | "url" | "text" | "number" | "bool" | "enum";
  label: string;
  help: string;
  required: boolean;
  options?: string[];
  source: "saved" | "deployment" | "default" | "unset";
  display: string;
  setAt?: number;
  withheld?: string;
}

interface GroupView {
  id: string;
  title: string;
  intro: string;
  testable: boolean;
  configured: boolean;
  linked?: boolean;
}

interface SettingsResponse {
  owner: { fingerprint: string; howToChange: string };
  storage: boolean;
  groups: GroupView[];
  settings: SettingView[];
  saved?: boolean;
  errors?: Record<string, string>;
}

const SOURCE: Record<SettingView["source"], string> = {
  saved: "saved here",
  deployment: "from deployment",
  default: "default",
  unset: "not set",
};

/** Where each OAuth provider must send the user back to. */
const REDIRECT: Record<string, string> = {
  google: "/api/google/callback",
  spotify: "/api/spotify/callback",
};

/** A section's own content beyond its settings, drawn under its intro. */
export type Extras = Partial<Record<string, () => HTMLElement>>;

export class Services {
  private key: string;
  private root: HTMLElement;
  private extras: Extras;
  private data: SettingsResponse | null = null;

  constructor(key: string, root: HTMLElement, extras: Extras = {}) {
    this.key = key;
    this.root = root;
    this.extras = extras;
  }

  async load(): Promise<void> {
    this.root.replaceChildren(el("p", "note", "loading settings…"));
    try {
      const res = await fetch("/api/settings", { headers: authHeaders(this.key) });
      if (!res.ok) throw new Error(`server said ${res.status}`);
      this.render((await res.json()) as SettingsResponse);
    } catch (e) {
      this.root.replaceChildren(el("p", "warn", `Could not load settings: ${message(e)}`));
    }
  }

  private render(data: SettingsResponse): void {
    this.data = data;
    this.root.replaceChildren(this.checklist(data), this.owner(data));
    if (!data.storage) {
      this.root.appendChild(el("p", "warn", "Settings storage (the STATE Durable Object) is not bound, so nothing can be saved here."));
    }
    for (const g of data.groups) this.root.appendChild(this.section(g, data.settings.filter((s) => s.group === g.id)));
  }

  /* ---------- the top of the sheet ---------------------------------------- */

  private checklist(data: SettingsResponse): HTMLElement {
    const box = el("section", "svc checklist");
    box.appendChild(el("h3", "", "Setup"));
    const list = el("div", "checks");
    for (const g of data.groups) {
      const required = data.settings.some((s) => s.group === g.id && s.required);
      const needsNothing = !g.testable && !required;
      if (needsNothing) continue;
      const row = el("button", `check ${g.configured ? "on" : required ? "need" : "off"}`);
      row.type = "button";
      row.textContent = `${g.configured ? "✓" : required ? "!" : "○"} ${g.title}`;
      row.addEventListener("click", () => this.root.querySelector(`[data-group="${g.id}"]`)?.scrollIntoView({ behavior: "smooth" }));
      list.appendChild(row);
    }
    box.appendChild(list);
    box.appendChild(el("p", "note", "Only OpenAI is required. Each other service switches its tools on once it is filled in."));
    return box;
  }

  private owner(data: SettingsResponse): HTMLElement {
    const box = el("section", "svc");
    box.appendChild(el("h3", "", "Owner key"));
    const line = el("div", "inforce");
    line.appendChild(el("span", "", "In force: "));
    line.appendChild(el("b", "", data.owner.fingerprint ? `sha256 ${data.owner.fingerprint}` : "not set"));
    box.appendChild(line);
    box.appendChild(el("p", "note",
      "The one setting that cannot change here: it is what lets you in, so it is set when Jarvis is deployed. To change it, run the command below, then enter the new key once on each screen that uses Jarvis. Device tokens keep working."));
    box.appendChild(el("code", "cmd", data.owner.howToChange));
    return box;
  }

  /* ---------- one service ------------------------------------------------- */

  private section(g: GroupView, settings: SettingView[]): HTMLElement {
    const box = el("section", "svc");
    box.dataset.group = g.id;

    const head = el("div", "svchead");
    head.appendChild(el("h3", "", g.title));
    head.appendChild(el("span", `chip ${g.configured ? "on" : "off"}`, g.configured ? "configured" : "not set up"));
    box.appendChild(head);
    box.appendChild(el("p", "note", g.intro));
    const extra = this.extras[g.id]?.();
    if (extra) box.appendChild(extra);

    if (REDIRECT[g.id]) {
      const uri = location.origin + REDIRECT[g.id];
      const p = el("p", "note");
      p.appendChild(document.createTextNode("Redirect URI to register with the provider: "));
      p.appendChild(el("code", "", uri));
      box.appendChild(p);
    }

    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    for (const s of settings) box.appendChild(this.field(s, inputs));

    const res = el("div", "res");
    const btns = el("div", "rowbtns");
    if (g.testable) btns.appendChild(button("Test", () => this.test(g.id, inputs, res)));
    btns.appendChild(button("Save", () => this.save(inputs, res), "primary"));
    if (g.linked !== undefined) {
      btns.appendChild(el("span", `chip ${g.linked ? "on" : "off"}`, g.linked ? "account linked" : "no account linked"));
      if (g.configured) btns.appendChild(button(g.linked ? "Re-link" : "Link", () => this.link(g.id, res)));
    }
    box.appendChild(btns);
    box.appendChild(res);
    return box;
  }

  private field(s: SettingView, inputs: Map<string, HTMLInputElement | HTMLSelectElement>): HTMLElement {
    const row = el("div", "field");

    const top = el("div", "fieldtop");
    top.appendChild(el("label", "", s.label + (s.required ? " *" : "")));
    top.appendChild(el("span", `badge ${s.source}`, SOURCE[s.source]));
    row.appendChild(top);

    if (s.display) row.appendChild(el("div", s.kind === "secret" ? "current secret" : "current", s.display));
    if (s.withheld) row.appendChild(el("div", "warn", `Not in use: ${s.withheld}.`));

    let input: HTMLInputElement | HTMLSelectElement;
    if (s.kind === "bool" || s.kind === "enum") {
      const sel = document.createElement("select") as unknown as HTMLSelectElement;
      sel.add(new Option("— unchanged —", ""));
      const opts = s.kind === "bool" ? [["on", "1"], ["off", "0"]] : (s.options ?? []).map((o) => [o, o]);
      for (const [text, value] of opts) sel.add(new Option(text!, value!));
      input = sel;
    } else {
      const inp = document.createElement("input");
      inp.type = s.kind === "secret" ? "password" : s.kind === "number" ? "number" : "text";
      inp.autocomplete = s.kind === "secret" ? "new-password" : "off";
      inp.spellcheck = false;
      inp.placeholder = s.source === "unset" ? "enter a value" : "enter a new value to replace it";
      input = inp;
    }
    input.setAttribute("aria-label", s.label);
    inputs.set(s.name, input);
    row.appendChild(input as unknown as HTMLElement);

    const foot = el("div", "fieldfoot");
    foot.appendChild(el("span", "help", s.help));
    if (s.source === "saved") {
      const clear = button(s.kind === "secret" ? "Clear" : "Reset", () => void this.clear(s, row));
      clear.title = "Remove the value saved here; the deployment value or default applies again.";
      foot.appendChild(clear);
    }
    row.appendChild(foot);
    return row;
  }

  /* ---------- actions ----------------------------------------------------- */

  /** Only what was typed or chosen; blank means "leave it as it is". */
  private changes(inputs: Map<string, HTMLInputElement | HTMLSelectElement>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, input] of inputs) {
      const v = input.value.trim();
      if (v) out[name] = v;
    }
    return out;
  }

  private async save(inputs: Map<string, HTMLInputElement | HTMLSelectElement>, res: HTMLElement) {
    const changes = this.changes(inputs);
    if (!Object.keys(changes).length) return say(res, "Nothing typed to save.", true);
    say(res, "saving…");
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: authHeaders(this.key),
        body: JSON.stringify({ changes }),
      });
      const body = (await r.json()) as SettingsResponse & { error?: string };
      if (body.errors) return say(res, Object.values(body.errors).join(" · "), true);
      if (!r.ok) return say(res, body.error ?? `server said ${r.status}`, true);
      this.render(body);
      const again = this.root.querySelector(`[data-group="${this.groupOf(Object.keys(changes)[0]!)}"] .res`);
      if (again) say(again as HTMLElement, "Saved. Takes effect within about 15 seconds.");
    } catch (e) {
      say(res, message(e), true);
    }
  }

  private async clear(s: SettingView, row: HTMLElement) {
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: authHeaders(this.key),
        body: JSON.stringify({ changes: { [s.name]: null } }),
      });
      if (!r.ok) throw new Error(`server said ${r.status}`);
      this.render((await r.json()) as SettingsResponse);
    } catch (e) {
      row.appendChild(el("div", "warn", message(e)));
    }
  }

  private async test(group: string, inputs: Map<string, HTMLInputElement | HTMLSelectElement>, res: HTMLElement) {
    const values = this.changes(inputs);
    say(res, Object.keys(values).length ? "testing what you typed, before saving…" : "testing…");
    try {
      const r = await fetch("/api/settings/test", {
        method: "POST",
        headers: authHeaders(this.key),
        body: JSON.stringify({ group, values }),
      });
      const body = (await r.json()) as { ok: boolean; detail?: string; error?: string };
      say(res, body.detail ?? body.error ?? `server said ${r.status}`, !body.ok);
      // A section whose Test changes what it shows (Alerts: the recent list) redraws that part.
      this.extras[group]?.();
    } catch (e) {
      say(res, message(e), true);
    }
  }

  private async link(group: string, res: HTMLElement) {
    say(res, "opening the sign-in page…");
    try {
      const r = await fetch(`/api/${group}/auth`, { headers: authHeaders(this.key) });
      const body = (await r.json()) as { url?: string; error?: string };
      if (!body.url) throw new Error(body.error ?? `server said ${r.status}`);
      window.open(body.url, "_blank", "noopener");
      say(res, "Finish signing in in the new tab, then press Test here.");
    } catch (e) {
      say(res, message(e), true);
    }
  }

  private groupOf(name: string): string {
    return this.data?.settings.find((s) => s.name === name)?.group ?? "";
  }
}

/* ---------- small DOM helpers ---------------------------------------------- */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function say(res: HTMLElement, text: string, bad = false) {
  res.textContent = text;
  res.classList.toggle("bad", bad);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
