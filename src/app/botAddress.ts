import { api } from "./key";
import { arm, button, el } from "./ui/util";
import { scopeLabels } from "./ui/Devices";

/**
 * A skill's bot's own address (src/worker/lib/skills.ts newAddress), started
 * from Chat ("give Zephyr its own address", tools/skills.ts skill_address)
 * or from Settings → Skills (ui/Skills.ts). In Chat it is a card on the
 * screen that asked, never kept, synced or said: what the bot may reach,
 * ticked by the person, and Make, which only an admin's screen may do
 * (PATCH /api/skills). Then, either way, the address shown this once, as the
 * kind of app the bot is in asks for it, each line with its own Copy.
 * Built with textContent throughout.
 */

export interface Addressee {
  id: string;
  name: string;
}

/** As PATCH /api/skills answers (routes/skills.ts): the token, its base, and the two together. */
export interface Made {
  token: string;
  base: string;
  url: string;
  skill: { address?: { hint: string } };
}

/** An "address" event from the router's stream handed to `hook`, when it is one. */
export function asAddress(ev: Record<string, unknown>, hook?: (s: Addressee) => void): void {
  if (typeof ev.id === "string" && typeof ev.name === "string") hook?.({ id: ev.id, name: ev.name });
}

/** A new address for its bot, reaching what is ticked; the one it had stops. */
export async function makeAddress(key: string, id: string, reach: string[]): Promise<Made> {
  return (await api(key, "PATCH", "/api/skills", { id, address: true, reach })) as Made;
}

type Listed = { skills: { id: string; address?: { hint: string; reach: string[]; at: number } }[]; reach: string[] };

interface Line {
  label: string;
  value: string;
}

/** What each kind of app is asked for, in its own words: every one served on the same address (routes/skills.ts handleBot). */
function kinds(m: Made): { name: string; lines: Line[]; note: string }[] {
  return [
    {
      name: "Base URL and API key",
      lines: [
        { label: "Base URL", value: m.base },
        { label: "API key", value: m.token },
        { label: "Model", value: "jarvis" },
        { label: "No box for a key: Base URL", value: m.url },
      ],
      note: "Most chat apps, Grok apps, Muse and OpenAI-style assistants. Turn streaming off if it asks: Jarvis sends one whole answer. " +
        "One that lists models first: type jarvis in yourself.",
    },
    {
      name: "MCP server",
      lines: [
        { label: "Server URL", value: `${m.base}/mcp` },
        { label: "Bearer token", value: m.token },
        { label: "Only a URL: Server URL", value: `${m.url}/mcp` },
      ],
      note: "One tool, ask_jarvis.",
    },
    {
      name: "Just a URL",
      lines: [
        { label: "To ask Jarvis: POST {\"text\": \"…\"}, the answer in \"text\"", value: `${m.base}/ask` },
        { label: "Header", value: `Authorization: Bearer ${m.token}` },
        { label: "To message you: POST {\"title\": \"…\", \"text\": \"…\"}", value: m.base },
        { label: "No headers: to ask Jarvis", value: `${m.url}/ask` },
        { label: "No headers: to message you", value: m.url },
      ],
      note: "n8n, Zapier, a script: any HTTP request with a JSON body.",
    },
  ];
}

/**
 * The address shown this once, inside `box`: which kind of app, then only
 * its lines, each with its Copy, and Done for when it is in, which says so
 * and takes the address off the screen.
 */
export function shownOnce(box: HTMLElement, name: string, m: Made, done: () => void): void {
  const said = el("small", "addrsaid", "");
  const lines = el("div", "addrlines");
  const choices = el("div", "addrkinds");
  const all = kinds(m);
  let open = all[0]!;
  const show = (k: (typeof all)[number]) => {
    open = k;
    for (const b of choices.children) b.classList.toggle("primary", b.textContent === k.name);
    lines.replaceChildren(...k.lines.map((l) => copyLine(l, said)), el("p", "", k.note));
    // What was copied was another kind's lines: never left looking copied.
    copyAll.classList.remove("copied");
    copyAll.textContent = "Copy all";
    said.textContent = "";
  };
  choices.append(...all.map((k) => button(k.name, () => show(k), "docopen")));
  const copyAll = button("Copy all", () => void copy(open.lines.map((l) => `${l.label}: ${l.value}`).join("\n"), copyAll, said), "docopen");
  const finish = button(`Done, it's in ${name}`, done, "docopen primary");
  const btns = el("div", "mdbtns");
  btns.append(copyAll, finish);
  box.replaceChildren(
    el("b", "doctitle", `${name}'s address: shown only now`),
    el("p", "", `Where does ${name} ask for it?`),
    choices,
    lines,
    btns,
    said,
    el("p", "", "Only a fingerprint of it is kept. Lost, make a new one: the old one stops."),
  );
  show(open);
}

/** One thing to copy, under what it is, with its own Copy; `said` is where a refused clipboard is explained. For ui/Components.ts too. */
export function copyLine(l: Line, said: HTMLElement): HTMLElement {
  const row = el("div", "tok");
  const code = el("code", "", l.value);
  const b = button("Copy", () => void copy(l.value, b, said, code), "docopen");
  row.append(el("small", "", l.label), code, b);
  return row;
}

/** Copied, said on the button pressed alone; where the clipboard is refused, selected to copy by hand. */
async function copy(value: string, b: HTMLButtonElement, said: HTMLElement, code?: HTMLElement): Promise<void> {
  const box = b.closest(".addrcard");
  try {
    await navigator.clipboard.writeText(value);
    for (const other of box?.querySelectorAll<HTMLButtonElement>("button.copied") ?? []) {
      other.classList.remove("copied");
      other.textContent = other.dataset.was ?? "Copy";
    }
    b.dataset.was = b.textContent ?? "";
    b.textContent = "✓ Copied";
    b.classList.add("copied");
    said.textContent = "";
  } catch {
    if (code) getSelection()?.selectAllChildren(code);
    said.textContent = code ? "Select and copy it yourself." : "Copy each line yourself.";
  }
}

/**
 * The card in Chat: what the bot may reach, as Settings → Skills has it,
 * and Make; then the address shown once; then, when it is in, one line.
 * Not now takes the card away with nothing made.
 */
export function addressCard(key: string, s: Addressee): HTMLElement {
  const card = el("div", "pagecard addrcard");
  card.append(el("span", "doctag", `${s.name} · its own address`), el("small", "pagesaid", "Looking it up…"));
  void (async () => {
    try {
      const got = (await api(key, "GET", "/api/skills")) as Listed;
      const skill = got.skills.find((x) => x.id === s.id);
      if (!skill) {
        card.replaceChildren(el("span", "doctag", s.name), el("small", "pagesaid", `${s.name} is no longer a skill.`));
        return;
      }
      ask(card, key, s, got.reach, skill.address);
    } catch (e) {
      card.replaceChildren(el("span", "doctag", s.name), el("small", "pagesaid", `Not now: ${e instanceof Error ? e.message : String(e)}`));
    }
  })();
  return card;
}

function ask(card: HTMLElement, key: string, s: Addressee, reach: string[], had?: { hint: string; reach: string[]; at: number }): void {
  const ticks = el("div", "scopes");
  ticks.append(...scopeLabels(reach, had?.reach ?? ["ask"]));
  const said = el("small", "pagesaid", "");
  const make = el("button", "docopen primary", had ? "Make a new one" : `Make ${s.name}'s address`);
  make.type = "button";
  const go = async () => {
    make.disabled = true;
    try {
      if (!had) {
        // Made meanwhile, here or on another screen: replacing it is asked first, as below.
        const now = (await api(key, "GET", "/api/skills")) as Listed;
        const made = now.skills.find((x) => x.id === s.id)?.address;
        if (made) return ask(card, key, s, now.reach, made);
      }
      const m = await makeAddress(key, s.id, [...ticks.querySelectorAll<HTMLInputElement>("input:checked")].map((b) => b.value));
      shownOnce(card, s.name, m, () => card.replaceChildren(
        el("span", "doctag", s.name),
        el("small", "pagesaid", `✓ ${s.name} has its own address${m.skill.address ? ` (${m.skill.address.hint})` : ""}. When it first asks, you will see "${s.name} asked" here.`),
      ));
    } catch (e) {
      make.disabled = false;
      said.textContent = `Not made: ${e instanceof Error ? e.message : String(e)}.`;
    }
  };
  // Replacing one stops a bot that works: pressed twice, as Settings → Skills has it.
  if (had) arm(make, "Replace it?", go);
  else make.addEventListener("click", () => void go());
  const later = button("Not now", () => (card.closest(".row") ?? card).remove(), "docopen");
  const btns = el("div", "mdbtns");
  btns.append(make, later);
  card.replaceChildren(
    el("span", "doctag", `${s.name} · its own address`),
    el("b", "doctitle", `Let ${s.name} ask Jarvis and message you?`),
    el("small", "pagesaid", had
      ? `${s.name} has an address already (${had.hint}, made ${new Date(had.at).toLocaleDateString()}). A new one stops it at once.`
      : "It asks as you, within your hours, and reaches only what you tick."),
    ticks,
    btns,
    said,
  );
}
