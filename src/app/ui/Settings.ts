import { authHeaders } from "../key";
import { Services } from "./Services";

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

  constructor(private key: string) {
    this.el = document.createElement("div");
    this.el.id = "settings";
    this.el.className = "panel";
    this.el.innerHTML = `
      <div class="sheet">
        <header>
          <h2>Settings</h2>
          <button class="close" aria-label="Close">Done</button>
        </header>
        <div class="services"></div>
        <section class="router">
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
      </div>`;
    document.body.appendChild(this.el);
    this.list = this.el.querySelector(".list")!;
    this.router = this.el.querySelector(".router")!;
    this.services = new Services(key, this.el.querySelector<HTMLElement>(".services")!);
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

  async show() {
    this.el.classList.add("open");
    this.msg("loading…");
    // Independent: a slow MCP server must not hold the other sections hostage.
    void this.services.load();
    void this.loadRouter();
    try {
      const res = await fetch("/api/mcp", { headers: authHeaders(this.key) });
      const data = (await res.json()) as {
        servers: ServerRow[];
        source?: "saved" | "default";
        liveTools: { name: string }[];
        liveError: string | null;
      };
      this.servers = data.servers ?? [];
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
