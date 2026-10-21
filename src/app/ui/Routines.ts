import { api } from "../key";
import { button, el } from "./util";

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
  /** What it does; an ask may wait for something worth telling (notify "if-important"). */
  action?: { kind: string; notify?: string };
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

  /** Open; with `focus`, that routine brought into view and marked (a routine's pill in the conversation). */
  async show(focus?: string): Promise<void> {
    this.el.classList.add("open");
    await this.load();
    const row = focus ? [...this.list.querySelectorAll<HTMLElement>(".routine")].find((r) => r.dataset.id === focus) : undefined;
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("flash");
  }

  hide(): void {
    this.el.classList.remove("open");
  }

  private msg(text: string, bad = false): void {
    const m = this.el.querySelector<HTMLElement>(".msg")!;
    m.textContent = text;
    m.classList.toggle("bad", bad);
  }

  private async load(): Promise<void> {
    try {
      const data = (await api(this.key, "GET", "/api/v1/routines")) as { timeZone: string; routines: RoutineView[] };
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
      row.dataset.id = r.id;
      const top = el("div", "rtop");
      top.appendChild(el("b", "", r.name));
      const toggle = el("label", "on");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = r.enabled;
      box.addEventListener("change", () => void this.act(() => api(this.key, "PATCH", "/api/v1/routines", { id: r.id, enabled: box.checked })));
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
      const quietly = r.action?.notify === "if-important";
      btns.appendChild(button("Run now", () => void this.act(() => api(this.key, "POST", "/api/v1/routines/run", { id: r.id }),
        quietly ? "Running — it arrives as an alert if there is anything to tell." : "Running — it arrives as an alert.")));
      btns.appendChild(button("Remove", () => void this.act(() => api(this.key, "DELETE", `/api/v1/routines?id=${encodeURIComponent(r.id)}`))));
      const past = el("div", "rruns");
      past.hidden = true;
      btns.appendChild(button("Past runs", () => void this.runs(r.id, past)));
      row.append(btns, past);
      return row;
    });
    this.list.replaceChildren(...rows);
  }

  /** A routine's last runs, newest first, with what each said: opened under it, and closed again. */
  private async runs(id: string, box: HTMLElement): Promise<void> {
    box.hidden = !box.hidden;
    if (box.hidden) return;
    box.replaceChildren(el("p", "note", "Loading…"));
    try {
      const { runs } = (await api(this.key, "GET", `/api/v1/routines/runs?id=${encodeURIComponent(id)}`)) as { runs: { at: number; ok: boolean; detail: string; said?: string }[] };
      box.replaceChildren(...(runs.length ? runs.flatMap((x) => [
        el("div", `rfacts${x.ok ? "" : " bad"}`, `${when(x.at, this.tz)}: ${x.ok ? "✓" : "✗"} ${x.detail}`),
        ...(x.said ? [el("p", "note", x.said)] : []),
      ]) : [el("p", "note", "No runs yet.")]));
    } catch (e) {
      box.replaceChildren(el("p", "note", message(e)));
    }
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
    const kind = select([["once", "Once, at a time"], ["daily", "Every day or some days"], ["cron", "On a cron schedule"], ["event", "When an event arrives"], ["leave", "Before calendar events: when to leave"]]);
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
    const cron = input("text", "0 8,12 * * *  (minute hour day month weekday)");
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
    // An answer is sent only when it is worth sending, as Hark's checks say "nothing important, so I sent nothing".
    const quiet = document.createElement("input");
    quiet.type = "checkbox";
    const quietRow = el("label", "on");
    quietRow.appendChild(quiet);
    quietRow.appendChild(document.createTextNode(" Only if there is something worth telling me"));

    const tzline = el("p", "note tzline");
    const shown: Record<string, HTMLElement[]> = { once: [at], daily: [time, days], cron: [cron], event: [event], leave: [bufferRow] };
    const all = [at, time, days, cron, event, bufferRow];
    const sync = () => {
      for (const x of all) x.style.display = "none";
      for (const x of shown[kind.value] ?? []) x.style.display = "";
      const leave = kind.value === "leave";
      doKind.style.display = leave ? "none" : "";
      text.style.display = leave ? "none" : "";
      quietRow.style.display = !leave && doKind.value === "ask" ? "" : "none";
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
        if (kind.value === "cron") body.cron = cron.value;
        if (kind.value === "event") body.event = event.value;
        if (kind.value === "leave") body.bufferMin = Number(buffer.value);
        else body[doKind.value] = text.value;
        if (kind.value !== "leave" && doKind.value === "ask" && quiet.checked) body.notify = "if-important";
        await api(this.key, "POST", "/api/v1/routines", body);
        name.value = "";
        text.value = "";
        quiet.checked = false;
      }, "Added."), "primary");

    for (const x of [name, kind, at, time, days, cron, event, bufferRow, doKind, text, quietRow, tzline, add]) f.appendChild(x);
    return f;
  }

  private hookHelp(): HTMLElement {
    const box = el("details", "hookhelp");
    box.appendChild(el("summary", "", "Sending events from Home Assistant, a phone or anything else"));
    box.appendChild(el("p", "note",
      "Make a device token with the routines scope (devices panel), then have the other system POST to this address. " +
      "Every enabled routine waiting for that event runs, at most once a minute. text is optional and is passed along."));
    box.appendChild(el("pre", "", `POST ${location.origin}/api/v1/trigger\nAuthorization: Bearer <device token>\nContent-Type: application/json\n\n{"event": "arrived_home", "text": "optional detail"}`));
    return box;
  }
}

/* ---------- small DOM helpers ---------------------------------------------- */

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
