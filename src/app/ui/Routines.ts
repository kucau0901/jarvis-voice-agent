import { authHeaders } from "../key";

/**
 * Routines: things Jarvis does by itself (src/worker/lib/routines.ts). Listed,
 * switched on and off, run now, removed, and added — though saying it is
 * usually quicker: "remind me at five to call Mum".
 *
 * Built with textContent throughout: names and messages are user input, and a
 * routine made by a device was made by that device.
 */

interface RoutineView {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { kind: string; event?: string };
  createdBy: string;
  nextAt?: number;
  lastRun?: { at: number; ok: boolean; detail: string };
  /** A watch's last look at the house. */
  watch?: { checkedAt?: number; trueSince?: number; fired?: boolean; errors?: number };
  when: string;
  does: string;
}

const DAYS: [string, string][] = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];

export class Routines {
  private el: HTMLElement;
  private list: HTMLElement;
  private key: string;
  private tz = "";

  constructor(key: string) {
    this.key = key;
    this.el = el("div", "panel");
    this.el.id = "routines";
    const sheet = el("div", "sheet");
    const head = el("header", "");
    head.appendChild(el("h2", "", "Routines"));
    const close = button("Done", () => this.hide(), "close");
    head.appendChild(close);
    sheet.appendChild(head);
    sheet.appendChild(
      el("p", "note",
        "Things Jarvis does by itself and sends you as an alert — Settings → Alerts decides where. " +
        "Saying it is usually quicker: \"remind me at five to call Mum\", \"every weekday at 7:30 " +
        "tell me my first meeting and the traffic\", \"tell me when to leave for my appointments\"."),
    );
    this.list = el("div", "rlist");
    sheet.appendChild(this.list);
    sheet.appendChild(el("h3", "", "New routine"));
    sheet.appendChild(this.form());
    sheet.appendChild(this.hookHelp());
    const msg = el("div", "msg");
    sheet.appendChild(msg);
    this.el.appendChild(sheet);
    document.body.appendChild(this.el);
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.hide();
    });
  }

  async show(): Promise<void> {
    this.el.classList.add("open");
    await this.load();
  }

  hide(): void {
    this.el.classList.remove("open");
  }

  private msg(text: string, bad = false): void {
    const m = this.el.querySelector<HTMLElement>(".msg")!;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetch(path, { method, headers: authHeaders(this.key), ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as { error?: string }).error ?? `server said ${r.status}`);
    return data;
  }

  private async load(): Promise<void> {
    try {
      const data = (await this.api("GET", "/api/v1/routines")) as { timeZone: string; routines: RoutineView[] };
      this.tz = data.timeZone;
      this.el.querySelector<HTMLElement>(".tzline")!.textContent = `Times are in ${this.tz}, from Settings → Where you are.`;
      this.render(data.routines);
    } catch (e) {
      this.list.replaceChildren(el("p", "warn", `Could not load routines: ${message(e)}`));
    }
  }

  private render(all: RoutineView[]): void {
    if (!all.length) {
      this.list.replaceChildren(el("p", "note", "None yet."));
      return;
    }
    const rows = all.map((r) => {
      const row = el("div", `routine${r.enabled ? "" : " off"}`);
      const top = el("div", "rtop");
      top.appendChild(el("b", "", r.name));
      const toggle = el("label", "on");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = r.enabled;
      box.addEventListener("change", () => void this.act(() => this.api("PATCH", "/api/v1/routines", { id: r.id, enabled: box.checked })));
      toggle.appendChild(box);
      toggle.appendChild(document.createTextNode(" on"));
      top.appendChild(toggle);
      row.appendChild(top);
      row.appendChild(el("div", "rwhen", `${r.when}; ${r.does}`));
      const facts: string[] = [];
      if (r.enabled && r.nextAt) facts.push(`next ${when(r.nextAt, this.tz)}`);
      if (r.enabled && r.watch?.checkedAt) {
        const w = r.watch;
        facts.push(
          `checked ${when(w.checkedAt!, this.tz)}` +
            (w.errors ? ", could not check" : w.trueSince ? `, true since ${when(w.trueSince, this.tz)}${w.fired ? ", told you" : ""}` : ", not true"),
        );
      }
      if (r.lastRun) facts.push(`last ${when(r.lastRun.at, this.tz)}: ${r.lastRun.ok ? "✓" : "✗"} ${r.lastRun.detail}`);
      if (r.createdBy !== "owner" && r.createdBy !== "voice") facts.push("made by a device");
      if (facts.length) row.appendChild(el("div", `rfacts${r.lastRun && !r.lastRun.ok ? " bad" : ""}`, facts.join(" · ")));
      const btns = el("div", "rowbtns");
      btns.appendChild(button("Run now", () => void this.act(() => this.api("POST", "/api/v1/routines/run", { id: r.id }), "Running — it arrives as an alert.")));
      btns.appendChild(button("Remove", () => void this.act(() => this.api("DELETE", `/api/v1/routines?id=${encodeURIComponent(r.id)}`))));
      row.appendChild(btns);
      return row;
    });
    this.list.replaceChildren(...rows);
  }

  private async act(fn: () => Promise<unknown>, done = ""): Promise<void> {
    try {
      await fn();
      this.msg(done);
    } catch (e) {
      this.msg(message(e), true);
    }
    await this.load();
  }

  /* ---------- adding one ------------------------------------------------------ */

  private form(): HTMLElement {
    const f = el("div", "rform");
    const name = input("text", "name (optional)");
    const kind = select([["once", "Once, at a time"], ["daily", "Every day or some days"], ["event", "When an event arrives"], ["leave", "Before calendar events: when to leave"]]);
    const at = input("datetime-local", "");
    const time = input("time", "");
    time.value = "07:30";
    const days = el("div", "rdays");
    const dayBoxes = DAYS.map(([v, label]) => {
      const l = el("label", "on");
      const b = document.createElement("input");
      b.type = "checkbox";
      b.value = v;
      b.checked = true;
      l.appendChild(b);
      l.appendChild(document.createTextNode(` ${label}`));
      days.appendChild(l);
      return b;
    });
    const event = input("text", "event name, e.g. arrived_home");
    const buffer = input("number", "");
    buffer.value = "10";
    buffer.min = "0";
    buffer.max = "120";
    const bufferRow = el("label", "on");
    bufferRow.appendChild(buffer);
    bufferRow.appendChild(document.createTextNode(" minutes to spare on top of the drive"));
    const doKind = select([["say", "Send this message"], ["ask", "Ask Jarvis this, and send the answer"]]);
    const text = document.createElement("textarea");
    text.rows = 2;
    text.placeholder = "Call Mum";

    const tzline = el("p", "note tzline");
    const shown: Record<string, HTMLElement[]> = { once: [at], daily: [time, days], event: [event], leave: [bufferRow] };
    const all = [at, time, days, event, bufferRow];
    const sync = () => {
      for (const x of all) x.style.display = "none";
      for (const x of shown[kind.value] ?? []) x.style.display = "";
      const leave = kind.value === "leave";
      doKind.style.display = leave ? "none" : "";
      text.style.display = leave ? "none" : "";
      text.placeholder = doKind.value === "ask" ? "What's on my calendar today, and the traffic to work?" : "Call Mum";
    };
    kind.addEventListener("change", sync);
    doKind.addEventListener("change", sync);
    sync();

    const add = button("Add", () =>
      void this.act(async () => {
        const body: Record<string, unknown> = { name: name.value, when: kind.value };
        if (kind.value === "once") body.localTime = at.value;
        if (kind.value === "daily") {
          body.time = time.value;
          body.days = dayBoxes.filter((b) => b.checked).map((b) => b.value);
        }
        if (kind.value === "event") body.event = event.value;
        if (kind.value === "leave") body.bufferMin = Number(buffer.value);
        else body[doKind.value] = text.value;
        await this.api("POST", "/api/v1/routines", body);
        name.value = "";
        text.value = "";
      }, "Added."), "primary");

    for (const x of [name, kind, at, time, days, event, bufferRow, doKind, text, tzline, add]) f.appendChild(x);
    return f;
  }

  private hookHelp(): HTMLElement {
    const box = el("details", "hookhelp");
    box.appendChild(el("summary", "", "Sending events from Home Assistant, a phone or anything else"));
    box.appendChild(el("p", "note",
      "Make a device token with the routines scope (devices panel), then have the other system POST to this address. " +
      "Every enabled routine waiting for that event runs, at most once a minute. text is optional and is passed along."));
    box.appendChild(el("pre", "", `POST ${location.origin}/api/v1/trigger\nX-Jarvis-Key: <device token>\nContent-Type: application/json\n\n{"event": "arrived_home", "text": "optional detail"}`));
    return box;
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

function input(type: string, placeholder: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = type;
  i.placeholder = placeholder;
  return i;
}

function select(options: [string, string][]): HTMLSelectElement {
  const s = document.createElement("select") as unknown as HTMLSelectElement;
  for (const [v, t] of options) s.add(new Option(t, v));
  return s;
}

const when = (ts: number, tz: string) =>
  new Intl.DateTimeFormat([], { ...(tz ? { timeZone: tz } : {}), weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
