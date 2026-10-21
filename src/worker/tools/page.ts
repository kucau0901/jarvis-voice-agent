import type { Tool } from "./registry.ts";
import { stateStub } from "../lib/state-client.ts";
import { OWNER } from "../lib/context.ts";
import { sanitise } from "../lib/memory.ts";
import type { PageSection } from "../lib/pages.ts";

/**
 * "Make me a page comparing these three chargers": a small web page, as
 * Hark's Pages are, shown in the chat as a card to open, and shareable by an
 * admin (lib/pages.ts, routes/page.ts). Jarvis gives words in sections, never
 * HTML: one fixed template draws them, escaped (lib/page-template.ts). No
 * model call of its own, so it works on the ChatGPT plan or a key alike.
 */

const MAX_SECTIONS = 6;
const MAX_BODY = 4000;
const MAX_ROWS = 50;
const MAX_COLS = 8;

const cut = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, n) : "");

export const makePage: Tool = {
  name: "make_page",
  scope: "screen",
  pace: "fast",
  description:
    "Make a small web page when the user asks for a page ('make me a page comparing…', 'put this on a page I can share'): " +
    "a title, an optional subtitle, and one to six sections, each a heading, its words (paragraphs, '- ' lists, **bold**, " +
    "[label](https://…) links) and, if it helps, a table. Write the content yourself from what you know or found; no HTML. " +
    "It appears in the chat as a card to open; those who run the house can share it. Say it is ready in one sentence; do not repeat it.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "The page's title, a few words." },
      subtitle: { type: ["string", "null"], description: "One line under the title, or null." },
      sections: {
        type: "array",
        description: "One to six sections, shown as tabs when there are several.",
        items: {
          type: "object",
          properties: {
            heading: { type: "string", description: "A short heading." },
            body: { type: "string", description: "Its words: paragraphs, '- ' lists, **bold**, https links." },
            table: {
              type: ["object", "null"],
              description: "A table for this section, or null.",
              properties: {
                columns: { type: "array", items: { type: "string" } },
                rows: { type: "array", items: { type: "array", items: { type: "string" } } },
              },
              required: ["columns", "rows"],
              additionalProperties: false,
            },
          },
          required: ["heading", "body", "table"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "subtitle", "sections"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const state = stateStub(ctx.env);
    if (!state) return "Pages cannot be kept on this deployment: it has no state object.";
    const title = sanitise(cut(args.title, 120));
    if (!title.ok) return `No page: its title ${title.why}.`;
    const sections: PageSection[] = (Array.isArray(args.sections) ? args.sections : []).slice(0, MAX_SECTIONS).flatMap((s): PageSection[] => {
      if (!s || typeof s !== "object") return [];
      const { heading, body, table } = s as { heading?: unknown; body?: unknown; table?: unknown };
      const t = table && typeof table === "object" ? (table as { columns?: unknown; rows?: unknown }) : null;
      const columns = Array.isArray(t?.columns) ? t.columns.slice(0, MAX_COLS).map((c) => cut(c, 80)) : [];
      const rows = Array.isArray(t?.rows) ? t.rows.slice(0, MAX_ROWS).filter(Array.isArray).map((r: unknown[]) => columns.map((_, i) => cut(r[i], 300))) : [];
      const h = cut(heading, 80);
      return h ? [{ heading: h, body: cut(body, MAX_BODY), table: columns.length && rows.length ? { columns, rows } : null }] : [];
    });
    if (!sections.length) return "No page: it needs at least one section with a heading.";
    const subtitle = cut(args.subtitle, 200);
    const id = await state.pagePut(ctx.env.JARVIS_PERSON || OWNER, { title: title.text, ...(subtitle ? { subtitle } : {}), sections }, Date.now());
    ctx.display({ kind: "page", page: id, label: title.text });
    return `The page "${title.text}" is made and shown in the chat as a card to open. Say so in one short sentence; do not repeat its content.`;
  },
};
