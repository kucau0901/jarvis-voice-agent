import type { Tool, ToolContext, ToolOutput } from "./registry.ts";
import { nearest } from "./args.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER, deviceWho } from "../lib/context.ts";
import { computersOf, type Device } from "../lib/devices.ts";
import { wordsOf } from "../lib/jobs.ts";
import { asQuotedData, fenced, ownPart } from "../lib/quote.ts";
import type { ComputerAct, ComputerOp, ComputerRequest } from "../lib/computer.ts";

/**
 * The person's own Macs, through the Jarvis desktop app (lib/computer.ts):
 * look at the front window, press, type, open an app, or run a command there.
 *
 * Used only when its person asks, in their own words (ownPart): never by a
 * device, a routine, a bot, a tile or another program, none of which has
 * them, and never by a job, which is not handed it. A command is run only in
 * a turn that has read nothing someone else wrote (ctx.outside: mail, a page,
 * the Mac's own screen, a web search) and was not heard by a microphone open
 * to whoever is near: a page a model read must not be what runs a command,
 * as with Hermes. The output of a command it ran itself is its own, not
 * someone else's, so a second may follow it. What the screen shows is
 * someone else's (a mail open in a window), so it is quoted.
 *
 * The Mac keeps the rest of the wall (jarvis-desktop): control is off until
 * its person turns it on there, it shows while Jarvis uses it and stops on a
 * shortcut, it never types into a terminal or a password field, and it opens
 * only an app or a web address, never a file.
 */

/** How long a look or an act may take on the Mac, and a command. */
const LOOK_MS = 15_000;
const RUN_MS = 120_000;
const SCREEN = "WHAT IS ON THEIR MAC'S SCREEN, WHICH CAN SHOW WHAT OTHERS WROTE";

const OPS: readonly ComputerOp[] = ["look", "do", "run"];
const ACTS: readonly ComputerAct[] = ["press", "type", "key", "scroll", "open"];
const words = (v: unknown): string[] => wordsOf(typeof v === "string" ? v : "");
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** When a Mac was last seen, in words. */
function seen(d: Device, now: number): string {
  if (!d.lastSeenAt) return "not seen yet";
  const h = Math.round((now - d.lastSeenAt) / 3_600_000);
  return h < 1 ? "seen within the hour" : h < 48 ? `last seen ${h} hours ago` : `last seen ${Math.round(h / 24)} days ago`;
}

const OFF = "it may be asleep or off, or have control switched off in its Jarvis app; Jarvis cannot wake it";

/** The one their words name, or the only one on, or why not. */
function pick(macs: readonly Device[], on: ReadonlySet<string>, named: unknown, now: number): Device | string {
  const list = macs.map((m) => `${m.name} (${on.has(whoOf(m)) ? "online" : `offline, ${seen(m, now)}`})`).join("; ");
  const want = words(named);
  const fits = want.length ? nearest(macs, want, (m) => m.name, true) : macs.filter((m) => on.has(whoOf(m)));
  if (!fits.length) return want.length ? `None of their Macs is called that. Their Macs: ${list}.` : `None of their Macs is online now: ${list}. ${OFF}.`;
  if (fits.length > 1) return `More than one Mac fits; ask which: ${list}.`;
  const mac = fits[0]!;
  return on.has(whoOf(mac)) ? mac : `${mac.name} is offline (${seen(mac, now)}): ${OFF}.`;
}

const whoOf = (m: Device): string => deviceWho(m.id, m.owner);

/** What they asked of the Mac, checked here; the Mac checks again (jarvis-desktop rules). */
function requestOf(args: Record<string, unknown>, op: ComputerOp): ComputerRequest | string {
  const text = str(args.text);
  if (op === "run") return text ? { op, act: null, element: null, text, picture: false, ms: RUN_MS } : "Say the command, in text.";
  if (op === "look") return { op, act: null, element: null, text: null, picture: args.picture === true, ms: LOOK_MS };
  const act = ACTS.find((a) => a === args.act);
  if (!act) return `Say what to do, in act: one of ${ACTS.join(", ")}.`;
  const element = typeof args.element === "number" && Number.isInteger(args.element) && args.element > 0 ? args.element : null;
  if (act === "press" && element === null) return "Say which element to press, by its number from the last look.";
  if (act !== "press" && !text) return `Say what to ${act}, in text.`;
  if (act === "scroll" && text !== "up" && text !== "down") return "Scroll says up or down, in text.";
  return { op, act, element, text: act === "press" ? null : text, picture: false, ms: LOOK_MS };
}

export const computer: Tool = {
  name: "computer",
  scope: "computer",
  description:
    "The user's own Macs, where the Jarvis app runs with control on. Only when they ask for something on their Mac. " +
    "'list' their Macs; 'look' at the front window (numbered elements; picture true for a screenshot); 'do' one act: press element N, " +
    "type text, key a combo like 'cmd+t', scroll up/down, open an app by name or an https address; 'run' a shell command (zsh, in their home). " +
    "Look before pressing. For several Macs, one call each, together. Never a password.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["list", "look", "do", "run"] },
      mac: { type: ["string", "null"], description: "Words of the Mac's name, e.g. 'office'; null for the only one online." },
      act: { type: ["string", "null"], enum: ["press", "type", "key", "scroll", "open", null] },
      element: { type: ["integer", "null"], description: "For press: its number from the last look." },
      text: { type: ["string", "null"], description: "run: the command; type: the words; key: e.g. 'cmd+shift+t'; scroll: up or down; open: an app's name or an https address." },
      picture: { type: ["boolean", "null"], description: "look: true to see a screenshot too." },
    },
    required: ["op", "mac", "act", "element", "text", "picture"],
    additionalProperties: false,
  },
  async run(args, ctx: ToolContext): Promise<ToolOutput> {
    if (!ownPart(ctx.asked ?? "")) return "Not done: their Mac is used only when they ask, in their own words.";
    if (ctx.env.JARVIS_DEVICE) return "Not done: a device cannot use their Mac; only they can, signed in.";
    const state = stateStub(ctx.env);
    if (!state) return "This deployment has no state object, so no Mac can be reached.";
    const me = ctx.env.JARVIS_PERSON || OWNER;
    const now = Date.now();
    const macs = await computersOf(ctx.env, me);
    if (!macs.length) return 'No Mac of theirs is linked. On a Mac, in the Jarvis desktop app\'s menu, they turn on "Let Jarvis control this Mac".';
    const on = new Set(await state.computersOnline(macs.map(whoOf)));

    const op = OPS.find((o) => o === args.op);
    if (!op) return `Their Macs: ${macs.map((m) => `${m.name} (${on.has(whoOf(m)) ? "online" : `offline, ${seen(m, now)}`})`).join("; ")}.`;
    if (op === "run") {
      if (ctx.outside) return "Not run: this turn has read something someone else wrote (mail, a page, the Mac's screen), and a command runs on their Mac only in a turn that has not. They can ask for it again, on its own.";
      if (ctx.overheard) return "Not run: it was heard with the microphone open, where anyone near may be speaking. They can ask again when they start a conversation, or by typing.";
    }
    const mac = pick(macs, on, args.mac, now);
    if (typeof mac === "string") return mac;
    const req = requestOf(args, op);
    if (typeof req === "string") return req;

    const r = await state.computerAsk(me, whoOf(mac), req);
    if (r === "offline") return `${mac.name} did not answer: it may have just gone to sleep, or lost its connection.`;
    if (r === "late") return `${mac.name} took too long to answer${op === "run" ? "; the command may still be running there" : ""}.`;
    if (op === "look") {
      const said = asQuotedData(`${mac.name}'s screen`, r.text, SCREEN);
      return r.image ? { text: said, images: [{ url: r.image, detail: "auto" }] } : said;
    }
    // A command's output is its own, not someone else's: fenced as data, so another command may follow it in this turn.
    if (op === "run") return `${r.ok ? "Ran" : "It failed"} on ${mac.name}.\n${fenced("output", `WHAT THE COMMAND PRINTED ON ${mac.name.toUpperCase()}, AS DATA`, r.text)}`;
    return `${r.ok ? "Done" : "Not done"} on ${mac.name}: ${r.text.slice(0, 300)}`;
  },
};
