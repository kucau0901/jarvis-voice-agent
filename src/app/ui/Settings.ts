import { authHeaders } from "../key";
import { Services } from "./Services";
import { AlertsPanel } from "./AlertsPanel";
import { LOUDNESS, loudness, setLoudness, type Loudness } from "../loud";
import { speakText } from "../alerts";

/** The settings menu: groups, and the sections in each, by id. */
const NAV: [string, string[]][] = [
  ["Connections", ["openai", "car", "home", "hermes", "google", "spotify", "maps", "cameras", "mcp"]],
  ["How Jarvis behaves", ["router", "voice", "screen", "alerts", "locale"]],
  ["Access and advanced", ["owner", "devices", "advanced"]],
];
const SECTION_KEY = "jarvis.settings.section";
const LOUD_LABEL: Record<Loudness, string> = { normal: "Normal", louder: "Louder", loudest: "Loudest" };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  return e;
}

interface RouterState {
  model: string;
  source: "ui" | "env" | "default";
  default: string;
  envModel: string | null;
  listed: boolean | null;
  candidates: string[];
  candidatesError?: string;
  fallback: { model: string; fellBackTo: string; at: number; status?: number; message: string } | null;
}

interface ProbeResult {
  ok: boolean;
  model: string;
  stage?: "call" | "tool" | "chain";
  status?: number;
  error?: string;
  toolMs?: number;
  chainMs?: number;
}

interface ServerRow {
  label: string;
  url: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
  enabled?: boolean;
  hint?: string;
}

/**
 * The router model and the MCP servers.
 *
 * Meant for a phone or laptop rather than the car: adding a server means typing
 * a URL and a token, which is miserable on the Tesla keyboard. Changes take
 * effect on the next question, with no redeploy.
 */
export class Settings {
  private el: HTMLElement;
  private list: HTMLElement;
  private router: HTMLElement;
  private servers: ServerRow[] = [];
  private routerState: RouterState | null = null;
  private services: Services;
  /** The version line under the menu, filled by loadVersion(). */
  private versionLine = node("p", "");

  constructor(private key: string) {
    this.el = document.createElement("div");
    this.el.id = "settings";
    this.el.className = "panel";
    this.el.innerHTML = `
      <div class="sheet setsheet">
        <header>
          <button class="back" type="button">‹ All settings</button>
          <h2>Settings</h2>
          <button class="close" aria-label="Close">Done</button>
        </header>
        <div class="setwrap">
        <nav class="setnav" aria-label="Settings sections"></nav>
        <div class="setbody">
        <div class="services"></div>
        <section class="router svc" data-section="router" data-title="Router model" data-state="on">
          <h3>Router model</h3>
          <p class="note">
            Decides what each question needs — which tool, which system. The voice
            is GPT-Live whichever model this is. A model is tested before it is
            used, and if OpenAI later refuses it, questions fall back to the
            default rather than failing.
          </p>
          <div class="now"></div>
          <select class="pick" aria-label="Router model"></select>
          <div class="rowbtns">
            <button class="rtest">Test</button>
            <button class="use primary">Use this model</button>
            <button class="reset">Reset</button>
          </div>
          <div class="res"></div>
        </section>
        <section class="svc screen" data-section="screen" data-title="This screen" data-state="on">
          <h3>This screen</h3>
          <p class="note">Kept on this screen only, so the car and your phone can differ.</p>
          <div class="field">
            <div class="fieldtop"><label>Jarvis's voice</label></div>
            <div class="checks loud" role="group" aria-label="How loud Jarvis speaks"></div>
            <p class="note">
              Jarvis's voice is quieter than music, so it is made louder here, and
              Loudest is where it starts. Set the car's volume for your music and
              leave it: the music then comes back at the volume you left it. Choose
              less if Jarvis is too loud on this screen, or if, in a live
              conversation, it starts to hear itself and interrupt.
            </p>
            <div class="rowbtns"><button class="hear" type="button">Hear it</button></div>
            <div class="res loudres"></div>
          </div>
        </section>
        <section class="svc mcp" data-section="mcp" data-title="MCP servers" data-state="off">
        <h3>MCP servers</h3>
        <p class="note">
          Tools Jarvis can call directly. A header written as
          <code>\${NAME}</code> is filled from a Worker secret and never stored here.
        </p>
        <p class="note src"></p>
        <div class="list"></div>
        <div class="actions">
          <button class="add">Add server</button>
          <button class="save primary">Save</button>
        </div>
        <div class="msg"></div>
        </section>
        </div>
        </div>
      </div>`;
    document.body.appendChild(this.el);
    this.list = this.el.querySelector(".list")!;
    this.router = this.el.querySelector(".router")!;
    const alerts = new AlertsPanel(key);
    this.services = new Services(
      key,
      this.el.querySelector<HTMLElement>(".services")!,
      { alerts: () => alerts.render() },
      () => this.buildNav(),
    );
    this.el.querySelector(".back")!.addEventListener("click", () => this.sheet.classList.remove("detail"));
    this.renderLoud();
    this.el.querySelector(".hear")!.addEventListener("click", () => void this.hearLoud());
    this.buildNav();
    this.router.querySelector(".rtest")!.addEventListener("click", () => void this.testModel());
    this.router.querySelector(".use")!.addEventListener("click", () => void this.useModel());
    this.router.querySelector(".reset")!.addEventListener("click", () => void this.resetModel());

    this.el.querySelector(".close")!.addEventListener("click", () => this.hide());
    this.el.querySelector(".add")!.addEventListener("click", () => {
      this.servers.push({ label: "", url: "", enabled: true, headers: {} });
      this.render();
    });
    this.el.querySelector(".save")!.addEventListener("click", () => void this.save());
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
  }

  /**
   * Which version is running, and whether a newer one is out (GET /api/version).
   * A newer release links to its notes, which say whether updating needs
   * anything doing (docs/RELEASING.md).
   */
  private async loadVersion(): Promise<void> {
    const line = this.versionLine;
    line.className = "navver";
    try {
      const r = await fetch("/api/version", { headers: authHeaders(this.key) });
      if (!r.ok) throw new Error(String(r.status));
      const v = (await r.json()) as {
        version: string;
        repo: string | null;
        latest: { version: string; url: string } | null;
        update: boolean;
        error?: string;
      };
      line.replaceChildren(node("span", `Jarvis ${v.version}`));
      if (v.update && v.latest) {
        const a = document.createElement("a");
        a.href = v.latest.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = `${v.latest.version} is out — what changed`;
        line.appendChild(document.createTextNode(" · "));
        line.appendChild(a);
        line.classList.add("update");
      } else if (v.repo && v.latest && !v.error) {
        line.appendChild(document.createTextNode(" · up to date"));
      }
    } catch {
      line.textContent = "";
    }
  }

  /** This screen's voice level (loud.ts): one button each, the chosen one lit. */
  private renderLoud(): void {
    const box = this.el.querySelector<HTMLElement>(".checks.loud")!;
    const now = loudness();
    box.replaceChildren(
      ...LOUDNESS.map((level) => {
        const b = node("button", LOUD_LABEL[level]);
        b.type = "button";
        b.className = `check${level === now ? " on" : ""}`;
        b.setAttribute("aria-pressed", String(level === now));
        b.addEventListener("click", () => {
          setLoudness(level);
          this.renderLoud();
          void this.hearLoud();
        });
        return b;
      }),
    );
  }

  /** A sentence at the chosen level, through the same path as a spoken alert. */
  private async hearLoud(): Promise<void> {
    const res = this.el.querySelector<HTMLElement>(".loudres")!;
    res.classList.remove("bad");
    res.textContent = "playing…";
    const ok = await speakText(this.key, "This is how loud I will be.");
    res.textContent = ok ? "" : "Could not play it here. Tap Hear it again.";
    res.classList.toggle("bad", !ok);
  }

  /* ---------- the menu of sections ------------------------------------------ */

  private get sheet(): HTMLElement {
    return this.el.querySelector(".sheet")!;
  }

  /**
   * The list on the left (or on its own, on a narrow screen): every section,
   * grouped, each with its state. Rebuilt whenever the sections are, so a
   * save that sets something up turns its mark green.
   */
  private buildNav(): void {
    const nav = this.el.querySelector<HTMLElement>(".setnav")!;
    const sections = [...this.el.querySelectorAll<HTMLElement>(".setbody [data-section]")];
    const byId = new Map(sections.map((s) => [s.dataset.section!, s]));
    const placed = new Set<string>();
    const parts: HTMLElement[] = [];
    NAV.forEach(([heading, ids], i) => {
      const here = ids.filter((id) => byId.has(id));
      // Anything the menu does not know yet goes in the last group.
      if (i === NAV.length - 1) for (const id of byId.keys()) if (!NAV.some(([, l]) => l.includes(id))) here.push(id);
      if (!here.length) return;
      parts.push(node("h4", heading));
      for (const id of here) {
        placed.add(id);
        const s = byId.get(id)!;
        const b = node("button", "");
        b.type = "button";
        b.dataset.for = id;
        b.appendChild(node("span", s.dataset.title ?? id));
        const state = s.dataset.state ?? "off";
        const mark = node("span", state === "on" ? "✓" : state === "need" ? "!" : "○");
        mark.className = `st ${state}`;
        mark.title = state === "on" ? "set up" : state === "need" ? "needs setting up" : "optional, not set up";
        b.appendChild(mark);
        b.addEventListener("click", () => this.choose(id, true));
        parts.push(b);
      }
    });
    const note = node("p", "Only OpenAI is required. Everything else is optional, and switches its tools on once set up.");
    note.className = "navnote";
    parts.push(note, this.versionLine);
    nav.replaceChildren(...parts);
    this.choose(this.current ?? this.firstChoice(sections), false);
  }

  private current: string | null = (() => {
    try {
      return sessionStorage.getItem(SECTION_KEY);
    } catch {
      return null;
    }
  })();

  /** Something that needs setting up, else OpenAI. */
  private firstChoice(sections: HTMLElement[]): string {
    return sections.find((s) => s.dataset.state === "need")?.dataset.section ?? "openai";
  }

  private choose(id: string, open: boolean): void {
    const sections = [...this.el.querySelectorAll<HTMLElement>(".setbody [data-section]")];
    if (!sections.some((s) => s.dataset.section === id)) id = this.firstChoice(sections);
    this.current = id;
    try {
      sessionStorage.setItem(SECTION_KEY, id);
    } catch {
      // the choice is just not remembered
    }
    for (const s of sections) s.classList.toggle("active", s.dataset.section === id);
    for (const b of this.el.querySelectorAll<HTMLElement>(".setnav button")) b.classList.toggle("on", b.dataset.for === id);
    // On a narrow screen, choosing opens the section in place of the list.
    if (open) {
      this.sheet.classList.add("detail");
      this.sheet.scrollTop = 0;
    }
  }

  async show() {
    this.el.classList.add("open");
    // A narrow screen starts on the list; a wide one shows the list and a section together.
    this.sheet.classList.remove("detail");
    this.msg("loading…");
    // Independent: a slow MCP server must not hold the other sections hostage.
    void this.services.load();
    void this.loadRouter();
    void this.loadVersion();
    try {
      const res = await fetch("/api/mcp", { headers: authHeaders(this.key) });
      const data = (await res.json()) as {
        servers: ServerRow[];
        source?: "saved" | "default";
        liveTools: { name: string }[];
        liveError: string | null;
      };
      this.servers = data.servers ?? [];
      const mcp = this.el.querySelector<HTMLElement>('[data-section="mcp"]')!;
      mcp.dataset.state = this.servers.some((s) => s.enabled !== false && s.url) ? "on" : "off";
      this.buildNav();
      // Said plainly, because an empty save does not remove the defaults and
      // nothing else on this screen would explain why they came back.
      this.el.querySelector<HTMLElement>(".src")!.textContent =
        data.source === "default"
          ? "These are the built-in defaults from the repo; nothing has been saved here. " +
            "To turn a server off, untick enabled and save — removing every server " +
            "brings the defaults back."
          : "";
      this.render();
      this.msg(
        data.liveError
          ? `Could not reach a server: ${data.liveError}`
          : `${data.liveTools.length} tool${data.liveTools.length === 1 ? "" : "s"} available: ` +
            data.liveTools.map((t) => t.name).join(", "),
        !!data.liveError,
      );
    } catch (e) {
      this.msg(e instanceof Error ? e.message : String(e), true);
    }
  }

  hide() {
    this.el.classList.remove("open");
  }

  /* ---------- router model ------------------------------------------------ */

  private async loadRouter() {
    this.routerMsg("loading…");
    try {
      const res = await fetch("/api/router", { headers: authHeaders(this.key) });
      if (!res.ok) throw new Error(`server said ${res.status}`);
      this.renderRouter((await res.json()) as RouterState);
      this.routerMsg("");
    } catch (e) {
      this.routerMsg(e instanceof Error ? e.message : String(e), true);
    }
  }

  private renderRouter(st: RouterState) {
    this.routerState = st;
    const now = this.router.querySelector(".now") as HTMLElement;
    now.replaceChildren();

    const line = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = st.model;
    line.appendChild(document.createTextNode("In use: "));
    line.appendChild(b);
    line.appendChild(document.createTextNode(` — ${
      st.source === "ui" ? "chosen here" : st.source === "env" ? "set by the ROUTER_MODEL secret" : "the default"
    }`));
    now.appendChild(line);

    if (st.listed === false) {
      now.appendChild(warn(`${st.model} is not on your OpenAI account any more.`));
    }
    if (st.fallback) {
      const f = st.fallback;
      now.appendChild(warn(
        `OpenAI refused ${f.model} on ${new Date(f.at).toLocaleString()}` +
        `${f.status ? ` (${f.status})` : ""}, so questions are going to ${f.fellBackTo} instead. ` +
        `It said: ${f.message}`,
      ));
    }

    // new Option() sets text, never markup: these names come from OpenAI.
    const pick = this.select();
    pick.replaceChildren();
    const ids = st.candidates.includes(st.model) ? st.candidates : [st.model, ...st.candidates];
    for (const id of ids) {
      const tags = [id === st.model ? "in use" : "", id === st.default ? "default" : ""].filter(Boolean);
      pick.add(new Option(tags.length ? `${id} (${tags.join(", ")})` : id, id, false, id === st.model));
    }
    if (st.candidatesError) {
      now.appendChild(warn(`Could not list your OpenAI models: ${st.candidatesError}`));
    }

    const reset = this.router.querySelector<HTMLButtonElement>(".reset")!;
    reset.textContent = `Reset to ${st.envModel ?? st.default}`;
    reset.disabled = st.source !== "ui";
  }

  /**
   * The Worker's HTMLRewriter types merge into the global `Element`, and its
   * `remove()` clashes with the <select>'s `remove(index)`, so a select cannot
   * be named through querySelector's type parameter. Cast once, here.
   */
  private select(): HTMLSelectElement {
    return this.router.querySelector(".pick") as unknown as HTMLSelectElement;
  }

  private chosen(): string {
    return this.select().value;
  }

  private busy(on: boolean) {
    this.router.querySelectorAll<HTMLButtonElement>("button").forEach((el) => {
      el.disabled = on;
    });
    this.select().disabled = on;
    // Re-apply the rule that Reset only means something when a choice exists.
    if (!on && this.routerState) {
      this.router.querySelector<HTMLButtonElement>(".reset")!.disabled =
        this.routerState.source !== "ui";
    }
  }

  private async testModel() {
    const model = this.chosen();
    this.busy(true);
    this.routerMsg(`testing ${model}…`);
    try {
      const res = await fetch("/api/router/test", {
        method: "POST",
        headers: authHeaders(this.key),
        body: JSON.stringify({ model }),
      });
      const p = (await res.json()) as ProbeResult;
      this.routerMsg(describe(p), !p.ok);
    } catch (e) {
      this.routerMsg(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.busy(false);
    }
  }

  private async useModel() {
    const model = this.chosen();
    this.busy(true);
    this.routerMsg(`testing ${model} before switching…`);
    try {
      const res = await fetch("/api/router", {
        method: "PUT",
        headers: authHeaders(this.key),
        body: JSON.stringify({ model }),
      });
      const r = (await res.json()) as RouterState & { saved?: boolean; probe?: ProbeResult; error?: string };
      if (r.error) throw new Error(r.error);
      this.renderRouter(r);
      this.routerMsg(
        r.saved
          ? `Now using ${model}. ${describe(r.probe!)} Takes effect within a minute.`
          : `Not switched. ${describe(r.probe!)}`,
        !r.saved,
      );
    } catch (e) {
      this.routerMsg(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.busy(false);
    }
  }

  private async resetModel() {
    this.busy(true);
    this.routerMsg("resetting…");
    try {
      const res = await fetch("/api/router", { method: "DELETE", headers: authHeaders(this.key) });
      if (!res.ok) throw new Error(`server said ${res.status}`);
      const r = (await res.json()) as RouterState;
      this.renderRouter(r);
      this.routerMsg(`Back to ${r.model}. Takes effect within a minute.`);
    } catch (e) {
      this.routerMsg(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.busy(false);
    }
  }

  private routerMsg(text: string, bad = false) {
    const m = this.router.querySelector(".res") as HTMLElement;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  private msg(text: string, bad = false) {
    const m = this.el.querySelector(".msg") as HTMLElement;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  private render() {
    this.list.innerHTML = "";
    this.servers.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "srv";
      const auth = s.headers?.["Authorization"] ?? "";
      row.innerHTML = `
        <label class="on">
          <input type="checkbox" ${s.enabled !== false ? "checked" : ""}> enabled
        </label>
        <input class="label" placeholder="name" value="${esc(s.label)}">
        <input class="url" placeholder="https://…/mcp" value="${esc(s.url)}">
        <input class="auth" placeholder="Authorization (optional)" value="${esc(auth)}">
        <div class="rowbtns">
          <button class="test">Test</button>
          <button class="del">Remove</button>
        </div>
        <div class="res"></div>`;

      row.querySelector<HTMLInputElement>(".on input")!.addEventListener("change", (e) => {
        s.enabled = (e.target as HTMLInputElement).checked;
      });
      row.querySelector<HTMLInputElement>(".label")!.addEventListener("input", (e) => {
        s.label = (e.target as HTMLInputElement).value;
      });
      row.querySelector<HTMLInputElement>(".url")!.addEventListener("input", (e) => {
        s.url = (e.target as HTMLInputElement).value;
      });
      row.querySelector<HTMLInputElement>(".auth")!.addEventListener("input", (e) => {
        const v = (e.target as HTMLInputElement).value;
        s.headers = v ? { Authorization: v } : {};
      });
      row.querySelector(".del")!.addEventListener("click", () => {
        this.servers.splice(i, 1);
        this.render();
      });
      row.querySelector(".test")!.addEventListener("click", async (ev) => {
        const btn = ev.target as HTMLButtonElement;
        const out = row.querySelector(".res") as HTMLElement;
        btn.disabled = true;
        out.textContent = "connecting…";
        try {
          // A masked "***" goes as-is, with the label: the Worker fills it from
          // the stored server, because this page never holds the real value.
          const res = await fetch("/api/mcp/test", {
            method: "POST",
            headers: authHeaders(this.key),
            body: JSON.stringify({ label: s.label, url: s.url, headers: s.headers ?? {} }),
          });
          const r = (await res.json()) as {
            ok: boolean; transport?: string; ms?: number; toolCount?: number;
            tools?: string[]; error?: string;
          };
          // What the server OFFERS is not what Jarvis may USE: Home Assistant
          // offers 85 tools and the allowlist admits 11. Saying only "85 tools"
          // under a server whose allowlist exists reads as all 85 being live.
          const allowed = s.allowedTools?.length ?? 0;
          out.textContent = r.ok
            ? `Reachable: ${r.toolCount} tools offered over ${r.transport} in ${r.ms}ms. ` +
              (allowed
                ? `Jarvis is allowed ${allowed} of them: ${s.allowedTools!.join(", ")}.`
                : `No allowlist, so Jarvis may use all of them: ${(r.tools ?? []).join(", ")}.`)
            : `failed: ${r.error}`;
          out.classList.toggle("bad", !r.ok);
        } catch (e) {
          out.textContent = e instanceof Error ? e.message : String(e);
          out.classList.add("bad");
        } finally {
          btn.disabled = false;
        }
      });

      this.list.appendChild(row);
    });
  }

  private async save() {
    this.msg("saving…");
    try {
      // "***" is sent back as-is and means "unchanged": the Worker restores the
      // stored value. Dropping it here instead is what used to erase a pasted
      // token on any save. Only genuinely empty headers are left out.
      const payload = this.servers.map((s) => ({
        ...s,
        headers: Object.fromEntries(Object.entries(s.headers ?? {}).filter(([, v]) => v)),
      }));
      const res = await fetch("/api/mcp", {
        method: "PUT",
        headers: authHeaders(this.key),
        body: JSON.stringify({ servers: payload }),
      });
      if (!res.ok) throw new Error(`server said ${res.status}`);
      await this.show();
    } catch (e) {
      this.msg(e instanceof Error ? e.message : String(e), true);
    }
  }
}

/** One line a person can act on, from a probe result. */
function describe(p: ProbeResult): string {
  const secs = (ms?: number) => (ms === undefined ? "?" : `${(ms / 1000).toFixed(1)}s`);
  if (p.ok) return `${p.model} passed: tool call in ${secs(p.toolMs)}, follow-up in ${secs(p.chainMs)}.`;
  const where =
    p.stage === "tool" ? "calling a tool" : p.stage === "chain" ? "following up after a tool" : "the first call";
  return `${p.model} failed at ${where}${p.status ? ` (${p.status})` : ""}: ${p.error ?? "no detail"}`;
}

function warn(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "warn";
  d.textContent = text;
  return d;
}

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
