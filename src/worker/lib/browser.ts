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
 * Run in the page, before the scripts below. A page may be several documents:
 * frames inside it, and frames inside those (an older system is often built
 * so). `docs` is every one this page may read, which is its own and any frame
 * from the same site; another site's frame (a payment box, a human check) is
 * closed to it, and stays so. `find` is a numbered thing, wherever it is.
 */
const FRAMES = `
  const docs = (doc, out) => {
    out.push(doc);
    for (const f of doc.querySelectorAll("iframe, frame")) {
      let d = null;
      try { d = f.contentDocument; } catch (e) {}
      if (d && d.body) docs(d, out);
    }
    return out;
  };
  const find = (n) => {
    for (const d of docs(document, [])) {
      const e = d.querySelector('[data-jarvis="' + n + '"]');
      if (e) return e;
    }
    return null;
  };`;

/**
 * Run in the page: its words, and each thing that can be pressed or filled,
 * numbered. The number is left on the element (data-jarvis), so a later press
 * finds the same one. A password box's contents are never read. A long page
 * is read a part at a time: `part` 1 is its start.
 */
const read = (part: number): string => `(() => {${FRAMES}
  const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  const all = docs(document, []);
  for (const d of all) for (const e of d.querySelectorAll("[data-jarvis]")) e.removeAttribute("data-jarvis");
  const seen = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = e.ownerDocument.defaultView.getComputedStyle(e);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const nameOf = (e) => {
    const label = e.labels && e.labels[0] ? e.labels[0].innerText : "";
    const img = e.querySelector ? e.querySelector("img[alt]") : null;
    // What it is called, not what it holds: a box's contents and a choice's options are said apart.
    const own = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) ? (/^(submit|button|reset)$/.test(e.type) ? e.value : "") : e.innerText;
    return clean(e.getAttribute("aria-label") || label || own || e.getAttribute("placeholder") || e.getAttribute("title") ||
      (img ? img.getAttribute("alt") : "") || e.getAttribute("name")).slice(0, 80);
  };
  const kindOf = (e) => {
    const t = e.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "input") return ["checkbox", "radio", "submit", "button", "password", "file"].includes(e.type) ? e.type.replace("submit", "button") : "box";
    if (t === "textarea" || e.isContentEditable) return "box";
    if (t === "select") return "choice";
    return e.getAttribute("role") || "button";
  };
  const first = ${(part - 1) * ITEMS_MAX}, from = ${(part - 1) * TEXT_MAX};
  const items = [];
  let n = 0, text = "", password = false, check = false;
  for (const d of all) {
    for (const e of d.querySelectorAll("a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [contenteditable=true]")) {
      if (!seen(e)) continue;
      n++;
      e.setAttribute("data-jarvis", String(n));
      if (n <= first || items.length >= ${ITEMS_MAX}) continue;
      const kind = kindOf(e);
      const item = { n, kind, name: nameOf(e) };
      if (kind === "box" && e.value) item.holds = clean(e.value).slice(0, 80);
      if ((kind === "checkbox" || kind === "radio") && e.checked) item.on = true;
      if (kind === "choice") item.holds = clean(e.selectedOptions && e.selectedOptions[0] ? e.selectedOptions[0].text : "");
      items.push(item);
    }
    const words = (d.body && d.body.tagName !== "FRAMESET" ? d.body.innerText : "").replace(/[ \\t]+/g, " ").replace(/\\n\\s*\\n+/g, "\\n").trim();
    if (words) text += (text ? "\\n" : "") + words;
    password = password || !!d.querySelector("input[type=password]");
    check = check || !!d.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], .g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form');
  }
  return JSON.stringify({ title: clean(document.title).slice(0, 200), url: location.href, text: text.slice(from, from + ${TEXT_MAX}), cut: text.length > from + ${TEXT_MAX},
    items, more: Math.max(0, n - first - items.length), part: ${part}, password, check });
})()`;

/** Run in the page: where number `n` is on the browser's screen, brought into view, and what it is. A link that would open another tab opens here. */
const where = (n: number): string => `(() => {${FRAMES}
  const e = find(${n});
  if (!e) return "null";
  const a = e.closest("a[target]");
  // Unless it names a frame of this page (a menu that fills the frame beside it): that is this tab already.
  const frame = a && docs(document, []).some((d) => [...d.querySelectorAll("iframe, frame")].some((f) => f.name === a.target));
  if (a && !frame && !/^_(self|parent|top)$/.test(a.target)) a.removeAttribute("target");
  e.scrollIntoView({ block: "center", inline: "center" });
  const r = e.getBoundingClientRect();
  let x = r.left + r.width / 2, y = r.top + r.height / 2;
  // Inside a frame, a place is counted from the frame's own corner: add each frame's, out to the screen.
  for (let w = e.ownerDocument.defaultView; w.frameElement; w = w.parent) {
    const f = w.frameElement.getBoundingClientRect();
    x += f.left + w.frameElement.clientLeft;
    y += f.top + w.frameElement.clientTop;
  }
  const t = e.tagName.toLowerCase();
  return JSON.stringify({ x, y, tag: t, type: e.type || "", editable: t === "textarea" || e.isContentEditable || (t === "input" && !["checkbox", "radio", "submit", "button", "file", "image", "reset"].includes(e.type)) });
})()`;

/** Run in the page: number `n`, a choice, set to the option that reads `text`. */
const choose = (n: number, text: string): string => `(() => {${FRAMES}
  const e = find(${n});
  const want = ${JSON.stringify(text.trim().toLowerCase())};
  const o = [...e.options].find((o) => o.text.trim().toLowerCase() === want) || [...e.options].find((o) => o.text.toLowerCase().includes(want));
  if (!o) return JSON.stringify([...e.options].map((o) => o.text.trim()).slice(0, 40));
  e.value = o.value;
  const Ev = e.ownerDocument.defaultView.Event;
  e.dispatchEvent(new Ev("input", { bubbles: true }));
  e.dispatchEvent(new Ev("change", { bubbles: true }));
  return "true";
})()`;

/** Run in the page: down to its end and back to where it was not, so what a page only loads when reached is there to read. */
const TO_END = `(() => {${FRAMES}
  for (const d of docs(document, [])) for (const el of [d.scrollingElement, ...d.querySelectorAll("*")]) {
    if (el && el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 200) el.scrollTop = el.scrollHeight;
  }
  return true;
})()`;

/** The keys a hand can press besides typing: its Windows key code, and the character it types if any. */
const KEYS = {
  Enter: [13, "\r"], Tab: [9, ""], Backspace: [8, ""], Delete: [46, ""], Escape: [27, ""],
  ArrowLeft: [37, ""], ArrowUp: [38, ""], ArrowRight: [39, ""], ArrowDown: [40, ""],
} as const;
export type ViewKey = keyof typeof KEYS;

interface Reading {
  title: string;
  url: string;
  text: string;
  cut: boolean;
  items: { n: number; kind: string; name: string; holds?: string; on?: boolean }[];
  more: number;
  /** Tabs open behind this one, when there are any. */
  behind?: number;
  /** Which part of a long page this is: 1 is its start. */
  part: number;
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

/** A tab, as the browser lists it. */
interface Listed {
  id: string;
  webSocketDebuggerUrl: string;
}

/** What the browser's debugging port answers at a path, as text. */
async function ask(deps: BrowserDeps, path: string, method = "GET"): Promise<string> {
  const base = deps.base.replace(/\/+$/, "");
  let r: Awaited<ReturnType<BrowserDeps["fetch"]>>;
  try {
    r = await deps.fetch(`${base}${path}`, { method, signal: deps.signal });
  } catch (e) {
    throw new Error(`the browser did not answer at ${base} (${e instanceof Error ? e.message : String(e)})`);
  }
  const body = await r.text();
  // Chrome refuses a debugging address given by name: only an IP address or localhost.
  if (!r.ok) throw new Error(`the browser said ${r.status}: ${body.slice(0, 200)}`);
  return body;
}

function parsed(deps: BrowserDeps, body: string): unknown {
  try {
    const v: unknown = JSON.parse(body);
    return Array.isArray(v) ? v : [v];
  } catch {
    throw new Error(`what answered at ${deps.base.replace(/\/+$/, "")} is not a browser's debugging port`);
  }
}

/** The tabs among what the browser lists: pages, and not its own tools'. */
function pages(v: unknown): Listed[] {
  const out: Listed[] = [];
  for (const t of Array.isArray(v) ? (v as unknown[]) : []) {
    if (!t || typeof t !== "object") continue;
    const { id, type, url, webSocketDebuggerUrl } = t as Record<string, unknown>;
    if (type === "page" && typeof webSocketDebuggerUrl === "string" && !/^(devtools|chrome-extension):/.test(String(url))) out.push({ id: String(id ?? ""), webSocketDebuggerUrl });
  }
  return out;
}

/** The browser's tabs, the newest first: that is the order it lists them in. */
const tabs = async (deps: BrowserDeps): Promise<Listed[]> => pages(parsed(deps, await ask(deps, "/json/list")));

/** One tab, for the length of one call. */
class Tab {
  /** Which tab this is, and how many others are open behind it. */
  at: Listed = { id: "", webSocketDebuggerUrl: "" };
  behind = 0;
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

  /** The tab in front: the newest the browser has, so a window a page opened is the one worked in. A new one when there is none. */
  static async open(deps: BrowserDeps): Promise<Tab> {
    let all = await tabs(deps);
    if (!all.length) all = pages(parsed(deps, await ask(deps, "/json/new?about:blank", "PUT")));
    const front = all[0];
    if (!front) throw new Error("the browser has no tab to use and would not open one");
    const tab = new Tab(deps);
    tab.at = front;
    tab.behind = all.length - 1;
    tab.wire = await deps.dial(front.webSocketDebuggerUrl, (text) => tab.heard(text), (why) => tab.lost(`the browser hung up: ${why}`));
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

  async read(part = 1): Promise<Reading> {
    return JSON.parse(String(await this.run(read(part)))) as Reading;
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

  /** One key that is not a letter, pressed and let go. */
  async key(name: ViewKey): Promise<void> {
    const [windowsVirtualKeyCode, text] = KEYS[name];
    const k = { key: name, code: name, windowsVirtualKeyCode };
    await this.call("Input.dispatchKeyEvent", text ? { ...k, type: "keyDown", text } : { ...k, type: "rawKeyDown" });
    await this.call("Input.dispatchKeyEvent", { ...k, type: "keyUp" });
  }

  /** The mouse, as a hand on the browser's screen moves it: held down between "down" and "up". */
  async mouse(type: "down" | "move" | "up", x: number, y: number): Promise<void> {
    const at = { x, y, button: "left", clickCount: 1 };
    if (type === "down") await this.call("Input.dispatchMouseEvent", { ...at, type: "mouseMoved", button: "none" });
    await this.call("Input.dispatchMouseEvent", type === "down" ? { ...at, type: "mousePressed", buttons: 1 } : type === "up" ? { ...at, type: "mouseReleased" } : { ...at, type: "mouseMoved", buttons: 1 });
  }
}

/** A reading as the model gets it: ours outside the fence, the page's inside. */
export function describe(r: Reading): string {
  const lines = [`Address: ${r.url}`, `Title: ${r.title || "(none)"}`, "", r.text || "(the page shows no words)"];
  if (r.part > 1) lines.splice(2, 0, `(part ${r.part} of the page)`);
  if (r.cut) lines.push(`(…more words further down: read part ${r.part + 1})`);
  if (r.items.length) {
    lines.push("", "What can be pressed or filled, by number:");
    for (const i of r.items) lines.push(`[${i.n}] ${i.kind}${i.name ? ` "${i.name}"` : ""}${i.holds ? `, holding "${i.holds}"` : ""}${i.on ? ", ticked" : ""}`);
    if (r.more) lines.push(`(and ${r.more} more further down: read part ${r.part + 1})`);
  }
  const notes: string[] = [];
  if (r.behind) notes.push(`This is the browser's newest tab; ${r.behind} more ${r.behind === 1 ? "is" : "are"} open behind it. browser_close_tab closes this one and goes back to the one behind.`);
  if (r.check)
    notes.push("This page is asking whoever is there to prove they are human. Do not try to answer it, and press nothing on it: tell the user the page wants a human check, and that they must do it themselves: in Jarvis's menu, Browser shows the page and takes their taps. When they say it is done, read the page again.");
  if (r.password)
    notes.push("This page asks for a password. Passwords are never typed for the user: tell them to sign in themselves, in Jarvis's menu under Browser; it stays signed in afterwards. When they say it is done, read the page again.");
  return [asQuotedData("web page", lines.join("\n"), "THE WEBSITE"), ...notes].join("\n\n");
}

/** One thing done in the browser's tab, then the page as it is afterwards. */
async function withTab(deps: BrowserDeps, act: (tab: Tab) => Promise<string | void>, part = 1): Promise<string> {
  let tab = await Tab.open(deps);
  try {
    const refused = await act(tab);
    if (typeof refused === "string") return refused;
    await tab.settle();
    // What was done may have opened a window, or closed this one: the page to read is then the one in front now.
    const front = (await tabs(deps))[0];
    if (front && front.webSocketDebuggerUrl !== tab.at.webSocketDebuggerUrl) {
      tab.close();
      tab = await Tab.open(deps);
      await tab.settle();
    }
    return describe({ ...(await tab.read(part)), behind: tab.behind });
  } finally {
    tab.close();
  }
}

/** The tab in front closed, and the one behind it read: for a window a page opened that is done with, or was never wanted. */
export async function browserCloseTab(deps: BrowserDeps): Promise<string> {
  const all = await tabs(deps);
  const front = all[0];
  if (!front || all.length < 2) return "Not closed: it is the browser's only tab.";
  await ask(deps, `/json/close/${encodeURIComponent(front.id)}`);
  await deps.sleep(300);
  return browserRead(deps);
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

/** The page as it is; a later part of a long one after going down to its end, so what loads only when reached has loaded. */
export const browserRead = (deps: BrowserDeps, part = 1): Promise<string> =>
  withTab(deps, async (tab) => {
    if (part > 1) await tab.run(TO_END);
  }, Math.max(1, Math.min(50, Math.floor(part) || 1)));

/** Pressed, or only pointed at: a menu that opens under the mouse opens, and its entries are in the reading that follows. */
export const browserPress = (deps: BrowserDeps, n: number, hover = false): Promise<string> =>
  withTab(deps, async (tab) => {
    const at = await tab.spot(n);
    if (!at) return GONE;
    if (hover) await tab.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
    else await tab.press(at);
  });

export const browserFill = (deps: BrowserDeps, n: number, text: string, enter: boolean): Promise<string> =>
  withTab(deps, async (tab) => {
    const at = await tab.spot(n);
    if (!at) return GONE;
    if (at.type === "password") return "Not typed: that is a password box, and passwords are never typed for the user. Tell them to sign in themselves, in Jarvis's menu under Browser.";
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
    if (enter) await tab.key("Enter");
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

/* ---------- the person's own hands on it (routes/browser.ts, src/app/ui/Browser.ts) ---------- */

/**
 * What a person does on the browser's screen themselves: signing in, passing
 * a human check. It goes to the browser as real input and nowhere else: no
 * model sees it, and nothing here keeps or logs it.
 */
export type ViewEvent =
  | { kind: "mouse"; type: "down" | "move" | "up"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: ViewKey }
  | { kind: "open"; address: string }
  | { kind: "back" };

/** As many events as one drag across the screen sends at once. */
const EVENTS_MAX = 80;
const coord = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000;

/** A request's events, checked: the list, or what is wrong with it. */
export function asViewEvents(raw: unknown): ViewEvent[] | string {
  if (!Array.isArray(raw) || !raw.length) return "send { events: [...] }";
  if (raw.length > EVENTS_MAX) return `at most ${EVENTS_MAX} events at once`;
  const out: ViewEvent[] = [];
  for (const e of raw as unknown[]) {
    if (!e || typeof e !== "object") return "each event is an object";
    const v = e as Record<string, unknown>;
    if (v.kind === "mouse" && (v.type === "down" || v.type === "move" || v.type === "up") && coord(v.x) && coord(v.y)) out.push({ kind: "mouse", type: v.type, x: v.x, y: v.y });
    else if (v.kind === "wheel" && coord(v.x) && coord(v.y) && typeof v.dy === "number" && Number.isFinite(v.dy)) out.push({ kind: "wheel", x: v.x, y: v.y, dy: Math.max(-2000, Math.min(2000, v.dy)) });
    else if (v.kind === "text" && typeof v.text === "string" && v.text.length > 0 && v.text.length <= 2000) out.push({ kind: "text", text: v.text });
    else if (v.kind === "key" && typeof v.key === "string" && Object.hasOwn(KEYS, v.key)) out.push({ kind: "key", key: v.key as ViewKey });
    else if (v.kind === "open" && typeof v.address === "string") out.push({ kind: "open", address: v.address });
    else if (v.kind === "back") out.push({ kind: "back" });
    else return "an event was not one of mouse, wheel, text, key, open or back";
  }
  return out;
}

/** Those events, done in order on the tab in front. An error's words when one could not be. */
export async function browserInput(deps: BrowserDeps, events: readonly ViewEvent[]): Promise<string | null> {
  const tab = await Tab.open(deps);
  try {
    for (const e of events) {
      if (e.kind === "mouse") await tab.mouse(e.type, e.x, e.y);
      else if (e.kind === "wheel") await tab.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: e.x, y: e.y, deltaX: 0, deltaY: e.dy });
      else if (e.kind === "text") await tab.call("Input.insertText", { text: e.text });
      else if (e.kind === "key") await tab.key(e.key);
      else if (e.kind === "back") await tab.run("history.back()");
      else {
        const url = webAddress(e.address);
        if (typeof url === "string") return url;
        const r = await tab.call("Page.navigate", { url: url.href });
        if (typeof r.errorText === "string" && r.errorText) return `the browser could not open it: ${r.errorText}`;
      }
    }
    return null;
  } finally {
    tab.close();
  }
}

export interface Screen {
  /** A JPEG of what the browser shows, base64. */
  jpeg: string;
  /** The size of that view in the page's own points: where a tap on the picture lands. */
  width: number;
  height: number;
  url: string;
  title: string;
}

/** What the browser shows now. */
export async function browserScreen(deps: BrowserDeps): Promise<Screen> {
  const tab = await Tab.open(deps);
  try {
    const at = JSON.parse(String(await tab.run("JSON.stringify({ width: innerWidth, height: innerHeight, url: location.href, title: document.title })"))) as Omit<Screen, "jpeg">;
    const shot = await tab.call("Page.captureScreenshot", { format: "jpeg", quality: 55, optimizeForSpeed: true });
    return { jpeg: String(shot.data ?? ""), width: Number(at.width) || 0, height: Number(at.height) || 0, url: String(at.url ?? ""), title: String(at.title ?? "").slice(0, 200) };
  } finally {
    tab.close();
  }
}
