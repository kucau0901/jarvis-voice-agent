import { authHeaders } from "../key";
import { disablePush, enablePush, pushState, setSpeakHere, speakHere, type PushState } from "../alerts";

/**
 * The part of Settings → Alerts that is not a setting: whether THIS device
 * gets notifications and speaks alerts, which screens are open right now,
 * which devices get notifications, and where recent alerts went.
 *
 * Built with textContent throughout: labels come from devices and alert text
 * from anything that can raise one.
 */

interface Overview {
  order: string[];
  push: { id: string; label: string; who: string; service: string; createdAt: number; okAt?: number; failures: number }[];
  live: { who: string; label: string; visible: boolean; since: number }[];
  recent: {
    alert: { id: string; at: number; title: string; text: string; source: string };
    attempts: { channel: string; ok: boolean; detail: string }[];
    deliveredBy: string | null;
  }[];
}

const STATE_TEXT: Record<PushState, string> = {
  on: "Notifications are on for this device.",
  off: "Notifications are off for this device.",
  blocked: "Notifications are blocked for this site in the browser's settings.",
  unsupported: "This browser cannot receive notifications.",
  "needs-install": "On iPhone and iPad, notifications need Jarvis added to the Home Screen first (Share → Add to Home Screen).",
};

export class AlertsPanel {
  readonly el: HTMLElement;
  private key: string;

  constructor(key: string) {
    this.key = key;
    this.el = el("div", "alertbox");
  }

  /** Called whenever the section is drawn; refreshes itself in place. */
  render(): HTMLElement {
    void this.load();
    return this.el;
  }

  private async load(): Promise<void> {
    const state = await pushState().catch(() => "unsupported" as PushState);
    const parts: HTMLElement[] = [el("h4", "", "This device"), this.thisDevice(state)];

    try {
      const r = await fetch("/api/alerts", { headers: authHeaders(this.key) });
      // A device key sees only its own part; the overview is the owner's.
      if (r.ok) parts.push(...this.overview((await r.json()) as Overview));
    } catch {
      parts.push(el("p", "warn", "Could not load where alerts have gone."));
    }
    this.el.replaceChildren(...parts);
  }

  private thisDevice(state: PushState): HTMLElement {
    const box = el("div", "");
    const row = el("div", "thisdev");
    row.appendChild(el("span", "", STATE_TEXT[state]));
    const res = el("div", "res");
    if (state === "off" || state === "on") {
      row.appendChild(
        button(state === "on" ? "Turn off" : "Turn on", async () => {
          res.textContent = state === "on" ? "turning off…" : "asking the browser…";
          res.classList.remove("bad");
          try {
            if (state === "on") await disablePush(this.key);
            else await enablePush(this.key);
            await this.load();
          } catch (e) {
            res.textContent = e instanceof Error ? e.message : String(e);
            res.classList.add("bad");
          }
        }, state === "off" ? "primary" : ""),
      );
    }
    box.appendChild(row);

    const speak = el("label", "on");
    const box2 = document.createElement("input");
    box2.type = "checkbox";
    box2.checked = speakHere();
    box2.addEventListener("change", () => setSpeakHere(box2.checked));
    add(speak, box2, document.createTextNode(" Say alerts aloud on this screen (a short clip, not a live session)"));
    add(box, speak, res);
    return box;
  }

  private overview(o: Overview): HTMLElement[] {
    const out: HTMLElement[] = [];

    out.push(el("h4", "", "Jarvis open right now"));
    out.push(list(o.live, "No screen has Jarvis open.", (c) => {
      const li = el("li", "");
      add(li, el("span", "", c.label), el("small", "", c.visible ? "in front of someone" : "in the background"));
      return li;
    }));

    out.push(el("h4", "", "Notifications go to"));
    out.push(list(o.push, "No device has turned notifications on.", (s) => {
      const li = el("li", "");
      const worked = s.okAt ? `last delivered ${ago(s.okAt)}` : "nothing sent yet";
      add(
        li,
        el("span", "", s.label),
        el("small", "", `${s.who === "owner" ? "" : "device · "}${worked}${s.failures ? ` · ${s.failures} refused` : ""}`),
        button("Remove", async () => {
          await fetch(`/api/alerts?sub=${encodeURIComponent(s.id)}`, { method: "DELETE", headers: authHeaders(this.key) });
          await this.load();
        }),
      );
      return li;
    }));

    out.push(el("h4", "", "Recent alerts"));
    out.push(list(o.recent.slice(0, 5), "None yet. Press Test below to send one.", (d) => {
      const li = el("li", "");
      const text = d.alert.text.length > 70 ? d.alert.text.slice(0, 70) + "…" : d.alert.text;
      add(
        li,
        el("span", "", `${time(d.alert.at)} · ${text}`),
        el("small", "", d.deliveredBy ? `by ${d.deliveredBy}` : d.attempts.length ? "not delivered" : "nowhere to send it"),
      );
      li.title = d.attempts.map((a) => `${a.ok ? "✓" : "✗"} ${a.channel}: ${a.detail}`).join("\n");
      return li;
    }));
    return out;
  }
}

/* ---------- small DOM helpers ---------------------------------------------- */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** appendChild, several at once. (`append` is shadowed by the Workers types' Element.) */
function add(parent: Node, ...kids: Node[]): void {
  for (const k of kids) parent.appendChild(k);
}

function button(text: string, onClick: () => void | Promise<void>, cls = ""): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", () => void onClick());
  return b;
}

function list<T>(items: T[], empty: string, row: (t: T) => HTMLElement): HTMLElement {
  const ul = el("ul", "");
  if (!items.length) ul.appendChild(el("li", "empty", empty));
  for (const i of items) ul.appendChild(row(i));
  return ul;
}

const time = (at: number) => new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
