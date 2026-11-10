/**
 * A browser Jarvis drives: a full Chrome running somewhere Jarvis can reach
 * (docker-compose.yml's `browser`), worked through Chrome's own debugging port.
 *
 * Jarvis reads a page as words and a numbered list of what can be pressed or
 * filled, and presses or fills by number: no picture goes to a model, so it
 * costs what any other tool's text does. What a page says is a stranger's, and
 * goes back quoted (lib/quote.ts).
 *
 * Two things it never does, whoever asks. It types no password: the person
 * signs in themselves, in the browser, and the profile keeps them signed in.
 * And it answers no "are you human" check: it says the page has one, and stops.
 *
 * Each call connects, does one thing and hangs up. Nothing is kept here
 * between calls: the browser itself remembers its tab and the numbers on it.
 */
import { asQuotedData } from "./quote.ts";

/** One connection to a tab's debugger. */
export interface Wire {
  send(text: string): void;
  close(): void;
}
/** Opens one; `onText` gets each message, `onClose` is told once when it ends. */
export type Dial = (url: string, onText: (text: string) => void, onClose: (why: string) => void) => Promise<Wire>;

export interface BrowserDeps {
  /** Chrome's debugging address, e.g. http://127.0.0.1:9222. */
  base: string;
  fetch: (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  dial: Dial;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** How much of a page's words goes to the model. */
const TEXT_MAX = 6000;
/** How many pressable things are listed. */
const ITEMS_MAX = 120;
/** How long a page may take to finish loading before it is read as it is. */
const SETTLE_MS = 12_000;

/** What can be opened: the web, and nothing of the machine the browser runs on (file:, chrome:, javascript:). */
export function webAddress(raw: string): URL | string {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return "that is not a web address";
  }
  return u.protocol === "https:" || u.protocol === "http:" ? u : "only http and https addresses can be opened";
}

/**
 * Run in the page: its words, and each thing that can be pressed or filled,
 * numbered. The number is left on the element (data-jarvis), so a later press
 * finds the same one. A password box's contents are never read.
 */
const READ = `(() => {
  const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  for (const e of document.querySelectorAll("[data-jarvis]")) e.removeAttribute("data-jarvis");
  const seen = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(e);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const nameOf = (e) => {
    const label = e.labels && e.labels[0] ? e.labels[0].innerText : "";
    const img = e.querySelector ? e.querySelector("img[alt]") : null;
    return clean(e.getAttribute("aria-label") || label || e.innerText || (e.type === "password" ? "" : e.value) ||
      e.getAttribute("placeholder") || e.getAttribute("title") || (img ? img.getAttribute("alt") : "") || e.getAttribute("name")).slice(0, 80);
  };
  const kindOf = (e) => {
    const t = e.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "input") return ["checkbox", "radio", "submit", "button", "password", "file"].includes(e.type) ? e.type.replace("submit", "button") : "box";
    if (t === "textarea" || e.isContentEditable) return "box";
    if (t === "select") return "choice";
    return e.getAttribute("role") || "button";
  };
  const items = [];
  let more = 0;
  const all = document.querySelectorAll("a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [contenteditable=true]");
  for (const e of all) {
    if (!seen(e)) continue;
    if (items.length >= ${ITEMS_MAX}) { more++; continue; }
    const n = items.length + 1;
    e.setAttribute("data-jarvis", String(n));
    const kind = kindOf(e);
    const item = { n, kind, name: nameOf(e) };
    if (kind === "box" && e.value) item.holds = clean(e.value).slice(0, 80);
    if ((kind === "checkbox" || kind === "radio") && e.checked) item.on = true;
    if (kind === "choice") item.holds = clean(e.selectedOptions && e.selectedOptions[0] ? e.selectedOptions[0].text : "");
    items.push(item);
  }
  const text = (document.body ? document.body.innerText : "").replace(/[ \\t]+/g, " ").replace(/\\n\\s*\\n+/g, "\\n").trim();
  const check = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], .g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form');
  return JSON.stringify({ title: clean(document.title).slice(0, 200), url: location.href, text: text.slice(0, ${TEXT_MAX}), cut: text.length > ${TEXT_MAX}, items, more,
    password: !!document.querySelector("input[type=password]"), check });
})()`;

/** Run in the page: where number `n` is, brought into view, and what it is. A link that would open another tab opens here. */
const where = (n: number): string => `(() => {
  const e = document.querySelector('[data-jarvis="${n}"]');
  if (!e) return "null";
  const a = e.closest("a[target]");
  if (a) a.removeAttribute("target");
  e.scrollIntoView({ block: "center", inline: "center" });
  const r = e.getBoundingClientRect();
  const t = e.tagName.toLowerCase();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, tag: t, type: e.type || "", editable: t === "textarea" || e.isContentEditable || (t === "input" && !["checkbox", "radio", "submit", "button", "file", "image", "reset"].includes(e.type)) });
})()`;

/** Run in the page: number `n`, a choice, set to the option that reads `text`. */
const choose = (n: number, text: string): string => `(() => {
  const e = document.querySelector('[data-jarvis="${n}"]');
  const want = ${JSON.stringify(text.trim().toLowerCase())};
  const o = [...e.options].find((o) => o.text.trim().toLowerCase() === want) || [...e.options].find((o) => o.text.toLowerCase().includes(want));
  if (!o) return JSON.stringify([...e.options].map((o) => o.text.trim()).slice(0, 40));
  e.value = o.value;
  e.dispatchEvent(new Event("input", { bubbles: true }));
  e.dispatchEvent(new Event("change", { bubbles: true }));
  return "true";
})()`;

interface Reading {
  title: string;
  url: string;
  text: string;
  cut: boolean;
  items: { n: number; kind: string; name: string; holds?: string; on?: boolean }[];
  more: number;
  password: boolean;
  check: boolean;
}

interface Spot {
  x: number;
  y: number;
  tag: string;
  type: string;
  editable: boolean;
}

/** One tab, for the length of one call. */
class Tab {
  private wire: Wire | null = null;
  private next = 1;
  private waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private deps: BrowserDeps;
  /** Why nothing more can be asked of it, once that is so. */
  private gone = "";

  private constructor(deps: BrowserDeps) {
    this.deps = deps;
  }

  private heard(text: string): void {
    let m: { id?: unknown; error?: { message?: unknown }; result?: Record<string, unknown> };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof m.id !== "number") return;
    const w = this.waiting.get(m.id);
    if (!w) return;
    this.waiting.delete(m.id);
    if (m.error) w.reject(new Error(String(m.error.message ?? "the browser refused")));
    else w.resolve(m.result ?? {});
  }

  /** Everything still waiting is told, and so is anything asked afterwards: never a wait for ever. */
  private lost(why: string): void {
    this.gone ||= why;
    for (const w of this.waiting.values()) w.reject(new Error(this.gone));
    this.waiting.clear();
  }

  /** The tab in front, as the browser lists them; a new one when there is none. */
  static async open(deps: BrowserDeps): Promise<Tab> {
    const base = deps.base.replace(/\/+$/, "");
    const ask = async (path: string, method = "GET"): Promise<unknown> => {
      let r: Awaited<ReturnType<BrowserDeps["fetch"]>>;
      try {
        r = await deps.fetch(`${base}${path}`, { method, signal: deps.signal });
      } catch (e) {
        throw new Error(`the browser did not answer at ${base} (${e instanceof Error ? e.message : String(e)})`);
      }
      const body = await r.text();
      // Chrome refuses a debugging address given by name: only an IP address or localhost.
      if (!r.ok) throw new Error(`the browser said ${r.status}: ${body.slice(0, 200)}`);
      try {
        return JSON.parse(body);
      } catch {
        throw new Error(`what answered at ${base} is not a browser's debugging port`);
      }
    };
    const pages = (v: unknown): { webSocketDebuggerUrl: string }[] => {
      const out: { webSocketDebuggerUrl: string }[] = [];
      for (const t of Array.isArray(v) ? (v as unknown[]) : []) {
        if (!t || typeof t !== "object") continue;
        const { type, url, webSocketDebuggerUrl } = t as Record<string, unknown>;
        if (type === "page" && typeof webSocketDebuggerUrl === "string" && !/^(devtools|chrome-extension):/.test(String(url))) out.push({ webSocketDebuggerUrl });
      }
      return out;
    };
    let page = pages(await ask("/json/list"))[0];
    if (!page) page = pages([await ask("/json/new?about:blank", "PUT")])[0];
    if (!page) throw new Error("the browser has no tab to use and would not open one");

    const tab = new Tab(deps);
    tab.wire = await deps.dial(page.webSocketDebuggerUrl, (text) => tab.heard(text), (why) => tab.lost(`the browser hung up: ${why}`));
    deps.signal?.addEventListener("abort", () => tab.close(), { once: true });
    return tab;
  }

  close(): void {
    this.wire?.close();
    this.lost("stopped");
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      if (this.gone || !this.wire) return reject(new Error(this.gone || "not connected"));
      this.waiting.set(id, { resolve, reject });
      this.wire.send(JSON.stringify({ id, method, params }));
    });
  }

  /** What a script run in the page gave back. */
  async run(expression: string): Promise<unknown> {
    const r = await this.call("Runtime.evaluate", { expression, returnByValue: true });
    const result = r.result as { value?: unknown } | undefined;
    if (r.exceptionDetails) throw new Error("the page would not run it");
    return result?.value;
  }

  /** Waits until the page says it has loaded, or long enough: a page mid-load answers nothing, which is "not yet". */
  async settle(): Promise<void> {
    await this.deps.sleep(400);
    for (let waited = 400; waited < SETTLE_MS; waited += 300) {
      const state = await this.run("document.readyState").catch(() => null);
      if (state === "complete") return;
      if (this.gone) throw new Error(this.gone);
      await this.deps.sleep(300);
    }
  }

  async read(): Promise<Reading> {
    return JSON.parse(String(await this.run(READ))) as Reading;
  }

  async spot(n: number): Promise<Spot | null> {
    return JSON.parse(String(await this.run(where(n)))) as Spot | null;
  }

  async press(at: Spot): Promise<void> {
    const point = { x: at.x, y: at.y, button: "left", clickCount: 1 };
    await this.call("Input.dispatchMouseEvent", { ...point, type: "mouseMoved", button: "none" });
    await this.call("Input.dispatchMouseEvent", { ...point, type: "mousePressed" });
    await this.call("Input.dispatchMouseEvent", { ...point, type: "mouseReleased" });
  }

  /** Everything in the box in front selected, so typing replaces it: the browser's own command, the same on every system. */
  async selectAll(): Promise<void> {
    const k = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 };
    await this.call("Input.dispatchKeyEvent", { ...k, type: "rawKeyDown", commands: ["selectAll"] });
    await this.call("Input.dispatchKeyEvent", { ...k, type: "keyUp" });
  }

  async enter(): Promise<void> {
    const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
    await this.call("Input.dispatchKeyEvent", { ...k, type: "rawKeyDown" });
    await this.call("Input.dispatchKeyEvent", { ...k, type: "char", text: "\r" });
    await this.call("Input.dispatchKeyEvent", { ...k, type: "keyUp" });
  }
}

/** A reading as the model gets it: ours outside the fence, the page's inside. */
export function describe(r: Reading): string {
  const lines = [`Address: ${r.url}`, `Title: ${r.title || "(none)"}`, "", r.text || "(the page shows no words)"];
  if (r.cut) lines.push("(…more words further down, not read)");
  if (r.items.length) {
    lines.push("", "What can be pressed or filled, by number:");
    for (const i of r.items) lines.push(`[${i.n}] ${i.kind}${i.name ? ` "${i.name}"` : ""}${i.holds ? `, holding "${i.holds}"` : ""}${i.on ? ", ticked" : ""}`);
    if (r.more) lines.push(`(and ${r.more} more further down, not numbered)`);
  }
  const notes: string[] = [];
  if (r.check)
    notes.push("This page is asking whoever is there to prove they are human. Do not try to answer it, and press nothing on it: tell the user the page wants a human check, and that they must do it themselves in the browser.");
  if (r.password)
    notes.push("This page asks for a password. Passwords are never typed for the user: tell them to sign in themselves in the browser; it stays signed in afterwards.");
  return [asQuotedData("web page", lines.join("\n"), "THE WEBSITE"), ...notes].join("\n\n");
}

/** One thing done in the browser's tab, then the page as it is afterwards. */
async function withTab(deps: BrowserDeps, act: (tab: Tab) => Promise<string | void>): Promise<string> {
  const tab = await Tab.open(deps);
  try {
    const refused = await act(tab);
    if (typeof refused === "string") return refused;
    await tab.settle();
    return describe(await tab.read());
  } finally {
    tab.close();
  }
}

const GONE = "Nothing on the page has that number now: the page has changed. Read it again and use the numbers it gives.";

export const browserOpen = (deps: BrowserDeps, address: string): Promise<string> => {
  const url = webAddress(address);
  if (typeof url === "string") return Promise.resolve(`Not opened: ${url}.`);
  return withTab(deps, async (tab) => {
    const r = await tab.call("Page.navigate", { url: url.href });
    if (typeof r.errorText === "string" && r.errorText) return `The browser could not open it: ${r.errorText}.`;
  });
};

export const browserRead = (deps: BrowserDeps): Promise<string> => withTab(deps, async () => {});

export const browserPress = (deps: BrowserDeps, n: number): Promise<string> =>
  withTab(deps, async (tab) => {
    const at = await tab.spot(n);
    if (!at) return GONE;
    await tab.press(at);
  });

export const browserFill = (deps: BrowserDeps, n: number, text: string, enter: boolean): Promise<string> =>
  withTab(deps, async (tab) => {
    const at = await tab.spot(n);
    if (!at) return GONE;
    if (at.type === "password") return "Not typed: that is a password box, and passwords are never typed for the user. Tell them to sign in themselves in the browser.";
    if (at.tag === "select") {
      const chosen = await tab.run(choose(n, text));
      if (chosen !== "true") return `Not chosen: it has no such option. It offers: ${asQuotedData("options", String(chosen), "THE WEBSITE")}`;
      return;
    }
    if (!at.editable) return "Not typed: that is not something to type in. Press it instead.";
    await tab.press(at);
    // What it held is replaced, as a person would: select all, then type over it.
    await tab.selectAll();
    await tab.call("Input.insertText", { text });
    if (enter) await tab.enter();
  });

/** The real connection: the runtime's own WebSocket (Workers and Node both have one). */
export const dialWebSocket: Dial = (url, onText, onClose) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let open = false;
    ws.addEventListener("open", () => {
      open = true;
      resolve({ send: (t) => ws.send(t), close: () => ws.close() });
    });
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") onText(e.data);
    });
    ws.addEventListener("close", () => (open ? onClose("the connection closed") : reject(new Error("the browser would not take a connection"))));
    ws.addEventListener("error", () => (open ? onClose("the connection failed") : reject(new Error("the browser would not take a connection"))));
  });
