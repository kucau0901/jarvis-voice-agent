import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { pageUrl } from "../lib/page-look.ts";
import { addServer, removeServer } from "../lib/config-store.ts";
import { callSkill, nameOf, type Skill } from "../lib/skills.ts";

/**
 * Adding and removing skills (lib/skills.ts): an outside service Jarvis
 * sends requests to, or an MCP server whose tools it uses.
 *
 * A skill reaches past Jarvis, so only the person may add one: skill_add
 * takes their own words asking for it, the address in them, and they must be
 * in their latest message, so a page, a mail or a tool's output that asks to
 * add one cannot, even one quoting an address they gave. Its key is never
 * taken in chat. Jobs are never offered these (lib/jobs.ts READ_TOOLS).
 */

/** Words as compared: in any case and spacing, and an address with or without its https://, which the model may add. */
const said = (s: string) => s.toLowerCase().replace(/https?:\/\//g, "").replace(/\s+/g, " ").trim();
/** Asking to add or change one, in their words, or in Malay. */
const ADD = /\b(add|connect|learn|teach|install|set ?up|change|update|tambah|sambung)\b/i;
const REMOVE = /\b(remove|delete|forget|disconnect|padam|buang)\b/i;

/** Whether `words` are the user's, in their latest message, asking with `verb` and naming `what`. */
function theirs(words: unknown, what: string, verb: RegExp, asked: string | undefined): boolean {
  const w = typeof words === "string" ? said(words) : "";
  return !!asked && verb.test(w) && said(asked).includes(w) && !!said(what) && w.includes(said(what));
}

/** An MCP server's label: its tools' prefix (tools/mcp.ts toolName). */
const labelOf = (name: string) => nameOf(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);

export const skillAdd: Tool = {
  name: "skill_add",
  scope: "skills",
  pace: "fast",
  description:
    "Add a skill, or change one by giving its name again: an outside service Jarvis can send requests to " +
    "(a bot, an automation, the user's own code), or an MCP server whose tools Jarvis can use. Only when " +
    "the user asks you to, with its https address in their own words ('add a skill: Nova, my Grok bot, for " +
    "the house and the car, at https://…'). Never ask for or take its key in chat: once it is added, tell " +
    "them its key goes in Settings → Skills (a service) or Settings → MCP servers (an MCP server, if it needs one). " +
    "Asked for one without its address, however they put it ('a tool that POSTs to my bot', secrets they will " +
    "fill in), ask them for each one's https address: never hand it to Hermes or a job instead.",
  parameters: {
    type: "object",
    properties: {
      user_words: { type: "string", description: "The user's own words asking for it, with its address, copied exactly from their latest message." },
      kind: { type: "string", enum: ["service", "mcp"], description: "service: Jarvis POSTs it requests. mcp: an MCP server, if they say so." },
      name: { type: "string", description: "What they call it, e.g. 'Nova'." },
      url: { type: "string", description: "Its https address, as they wrote it." },
      when: { type: "string", description: "When to use it, in their words, e.g. 'the house, the lights, the aircon and the Tesla'." },
      later: { type: ["boolean", "null"], description: "A service: true if its answer comes later as a message, not in the reply. Null for an MCP server." },
      key_header: { type: ["string", "null"], description: "A service: a header that carries its key as well as Authorization, if they name one (e.g. X-Automation-Key). Null otherwise." },
      fields: {
        type: ["array", "null"],
        description: "A service: fields its every request's body carries as they are, if they give any (e.g. mode: async). Null otherwise.",
        items: {
          type: "object",
          properties: { name: { type: "string" }, value: { type: "string" } },
          required: ["name", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["user_words", "kind", "name", "url", "when", "later", "key_header", "fields"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    // Without the punctuation after it in a sentence ("at https://…/hook,"), and said without
    // https:// ("at api.example.com/hook"), taken as https.
    const written = typeof args.url === "string" ? args.url.trim().replace(/[.,;:!?'"’”)\]]+$/, "").replace(/\/+$/, "") : "";
    const url = written && !/^[a-z]+:\/\//i.test(written) ? `https://${written}` : written;
    if (!theirs(args.user_words, url, ADD, ctx.asked)) {
      return "Not added: only the user can add a skill, in their own latest message, with its address in it. Ask them for it.";
    }
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (args.kind === "mcp") {
      const at = pageUrl(url);
      if (!at) return "Not added: its address must be https, and not one on the home network.";
      const label = labelOf(name);
      if (!label) return "Not added: its name needs a letter or a digit.";
      const when = typeof args.when === "string" ? args.when.trim().slice(0, 300) : "";
      const why = await addServer(ctx.env, { label, url: at.href, enabled: true, spokenAs: name.slice(0, 60), ...(when ? { hint: when } : {}) });
      if (why) return `Not added: ${why}. Change it in Settings → MCP servers.`;
      return `Connected the MCP server "${name}": its tools are offered from the next question, to whoever may reach the house. If it needs a token, it goes in Settings → MCP servers.`;
    }
    const state = stateStub(ctx.env);
    if (!state) return "Skills cannot be kept on this deployment: it has no state object.";
    const s = await state.skillAdd({ name, url, when: args.when, later: args.later, keyHeader: args.key_header, fields: args.fields }, Date.now());
    if (typeof s === "string") return `Not added: ${s}.`;
    return s.hasKey
      ? `Saved the skill "${s.name}"; its key is kept.`
      : `Saved the skill "${s.name}". It is used once its key is set: tell them it goes in Settings → Skills, never in chat.`;
  },
};

export const skillRemove: Tool = {
  name: "skill_remove",
  scope: "skills",
  pace: "fast",
  description: "Remove a skill (an outside service or an MCP server) by its name, only when the user asks you to in their own words.",
  parameters: {
    type: "object",
    properties: {
      user_words: { type: "string", description: "The user's own words asking for it, with its name, copied exactly from their latest message." },
      name: { type: "string", description: "Its name." },
    },
    required: ["user_words", "name"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!theirs(args.user_words, name, REMOVE, ctx.asked)) {
      return "Not removed: only the user can remove a skill, in their own latest message, naming it.";
    }
    const gone = await stateStub(ctx.env)?.skillRemove(name);
    if (gone) return `Removed the skill "${gone.name}", and its key.`;
    const label = labelOf(name);
    const server = await removeServer(ctx.env, (s) => s.label === label || (!!s.spokenAs && nameOf(s.spokenAs) === nameOf(name)));
    return server ? `Disconnected the MCP server "${server.spokenAs ?? server.label}".` : `No skill is called "${name}".`;
  },
};

/**
 * Sending a request to a skill, offered only with the skills that have a key
 * (lib/router.ts), by name: the model never names an address.
 */
export function askSkill(ready: readonly Skill[]): Tool[] {
  if (!ready.length) return [];
  return [{
    name: "ask_skill",
    scope: "skills",
    pace: "fast",
    description:
      "Send a request to an outside service the user added as a skill:\n" +
      ready.map((s) => `- ${s.name}: ${s.when || "only when the user names it"}`).join("\n") +
      "\nUse one when the user names it, or for what it is for that your own tools cannot do: the house, " +
      "the car, mail and the calendar go to your own tools first. A request approves nothing: the service " +
      "asks the user itself before it sends, buys, unlocks or opens anything.",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", enum: ready.map((s) => s.name), description: "Which one." },
        request: { type: "string", description: "What to ask it, complete on its own: it does not see this conversation." },
      },
      required: ["skill", "request"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const s = ready.find((x) => x.name === args.skill);
      if (!s) return `No skill is called "${String(args.skill)}".`;
      const request = typeof args.request === "string" ? args.request.trim() : "";
      if (!request) return "No request was given.";
      ctx.progress(`asking ${s.name}`);
      return callSkill(s, request, ctx.signal);
    },
  }];
}

export const skillTools = [skillAdd, skillRemove];
