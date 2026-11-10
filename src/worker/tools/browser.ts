import type { Tool, ToolContext } from "./registry.ts";
import type { Env } from "../types.ts";
import { browserCloseTab, browserFill, browserOpen, browserPress, browserRead, dialWebSocket, type BrowserDeps } from "../lib/browser.ts";

/**
 * "Open the school portal and tell me what homework is due."
 *
 * A full browser Jarvis drives for whoever was given the `browser` scope
 * (lib/browser.ts): signed in wherever the family signed it in, which is why
 * nobody has it by default. A page's words come back quoted, as a stranger's.
 */
const available = (env: Env): boolean => !!env.BROWSER_URL;

const deps = (ctx: ToolContext): BrowserDeps => ({
  base: ctx.env.BROWSER_URL ?? "",
  fetch: (url, init) => fetch(url, init),
  dial: dialWebSocket,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  signal: ctx.signal,
});

/** A tool's work, with what went wrong said in words: the browser may be off, or mid-restart. */
const attempt = async (work: Promise<string>): Promise<string> => {
  try {
    return await work;
  } catch (e) {
    return `The browser could not do that: ${e instanceof Error ? e.message : String(e)}.`;
  }
};

const number = { type: "integer", description: "The thing's number, from the square brackets in the latest reading of the page." };

const RULES =
  " Never type a password, a card number or a one-time code, and never try to answer an 'are you human' check: " +
  "when a page asks for one, stop and tell the user to do that part themselves in the browser. Before pressing " +
  "anything that buys, pays, sends, posts, books or deletes, say what it will do and wait for the user to say yes.";

export const browserTools: Tool[] = [
  {
    name: "browser_open",
    scope: "browser",
    available,
    pace: "slow",
    description:
      "Open a web address in the family's own browser and read the page: its words, and a numbered list of what " +
      "can be pressed or filled. For a website that needs working like a person does (signed-in pages, forms, " +
      "portals, shops); for a plain question about the world, search the web instead, which is quicker." + RULES,
    parameters: {
      type: "object",
      properties: { address: { type: "string", description: "The web address, e.g. https://example.com/orders." } },
      required: ["address"],
      additionalProperties: false,
    },
    run: (args, ctx) => attempt(browserOpen(deps(ctx), String(args.address ?? ""))),
  },
  {
    name: "browser_read",
    scope: "browser",
    available,
    pace: "slow",
    description:
      "Read the page the browser is on now, again: after the user says they have signed in or passed a check " +
      "there, when the numbers are stale, or for the next part of a long page. Gives the same words and numbered " +
      "list as browser_open, with what is inside the page's own frames.",
    parameters: {
      type: "object",
      properties: { part: { type: "integer", description: "Which part of the page: 1 for its start, 2 and up when a reading said there is more further down." } },
      required: ["part"],
      additionalProperties: false,
    },
    run: (args, ctx) => attempt(browserRead(deps(ctx), Number(args.part) || 1)),
  },
  {
    name: "browser_press",
    scope: "browser",
    available,
    pace: "slow",
    description:
      "Press one numbered thing on the browser's page (a link, a button, a tick box), or only point at it so a " +
      "menu that opens under the mouse opens; then read the page as it is afterwards." + RULES,
    parameters: {
      type: "object",
      properties: { number, hover: { type: "boolean", description: "True to point at it without pressing, for a menu that opens on hover. False to press." } },
      required: ["number", "hover"],
      additionalProperties: false,
    },
    run: (args, ctx) => attempt(browserPress(deps(ctx), Number(args.number), args.hover === true)),
  },
  {
    name: "browser_fill",
    scope: "browser",
    available,
    pace: "slow",
    description:
      "Type into one numbered box on the browser's page, replacing what it held, or pick an option of a numbered " +
      "choice by its words; then read the page as it is afterwards." + RULES,
    parameters: {
      type: "object",
      properties: {
        number,
        text: { type: "string", description: "What to type, or the option's words." },
        enter: { type: "boolean", description: "True to press Enter afterwards, as for a search box." },
      },
      required: ["number", "text", "enter"],
      additionalProperties: false,
    },
    run: (args, ctx) => attempt(browserFill(deps(ctx), Number(args.number), String(args.text ?? ""), args.enter === true)),
  },
  {
    name: "browser_close_tab",
    scope: "browser",
    available,
    pace: "slow",
    description:
      "Close the browser's tab in front (a window a page opened that is finished with, or was never wanted), " +
      "then read the tab behind it. Never closes the last tab.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    run: (_args, ctx) => attempt(browserCloseTab(deps(ctx))),
  },
];
