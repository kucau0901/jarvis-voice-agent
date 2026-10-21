/**
 * The markdown of a typed answer, read into blocks (ui/rich.ts draws them):
 * headings, paragraphs, lists, tables, code, quotes and rules. Pure, so Node
 * tests it. Nothing here makes HTML: every block holds text, and the drawing
 * puts it in text nodes, so whatever an answer quoted from a page stays words.
 */

export type Block =
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "hr" };

/** As much of a table as is drawn. */
const MAX_ROWS = 200;
const MAX_COLS = 12;

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const FENCE = /^\s*```/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()).slice(0, MAX_COLS);

/** Whether a text has anything beyond words and lines: plain answers stay drawn as they always were. */
export function hasBlocks(text: string): boolean {
  const lines = text.split("\n");
  return lines.some((l, i) => HEADING.test(l) || FENCE.test(l) || BULLET.test(l) || NUMBERED.test(l) || /^\s*>/.test(l) || (l.includes("|") && SEPARATOR.test(lines[i + 1] ?? "")));
}

export function blocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !FENCE.test(lines[i]!)) code.push(lines[i]!);
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      out.push({ kind: "h", level: h[1]!.length as 1 | 2 | 3, text: h[2]! });
      continue;
    }
    if (line.includes("|") && SEPARATOR.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i++;
      while (i + 1 < lines.length && lines[i + 1]!.includes("|") && lines[i + 1]!.trim()) {
        i++;
        if (rows.length < MAX_ROWS) {
          const r = cells(lines[i]!);
          // Ragged rows are made as wide as the heading.
          rows.push(head.map((_, c) => r[c] ?? ""));
        }
      }
      out.push({ kind: "table", head, rows });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push({ kind: "hr" });
      continue;
    }
    const bullet = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (bullet) {
      flush();
      const kind = BULLET.test(line) ? "ul" : "ol";
      const items = [bullet[1]!];
      while (i + 1 < lines.length && (kind === "ul" ? BULLET : NUMBERED).test(lines[i + 1]!)) items.push((kind === "ul" ? BULLET : NUMBERED).exec(lines[++i]!)![1]!);
      out.push({ kind, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [line.replace(/^\s*>\s?/, "")];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]!)) quote.push(lines[++i]!.replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return out;
}

/** A document, as asked for to keep or read at length: a "# " title first, and "## " sections. Its title and the rest; null for an ordinary answer. */
export function docOf(text: string): { title: string; body: string } | null {
  const t = text.trim();
  const first = HEADING.exec(t.split("\n")[0] ?? "");
  if (!first || first[1] !== "#" || !/^##\s/m.test(t)) return null;
  return { title: first[2]!, body: t.slice(t.indexOf("\n") + 1).trim() };
}

/**
 * A table as CSV, for a spreadsheet. A cell a spreadsheet would run as a
 * formula (=, +, -, @) is made text first: the words may have come from a
 * web page.
 */
export function csvOf(t: { head: string[]; rows: string[][] }): string {
  const cell = (c: string) => {
    const safe = /^[=+\-@]/.test(c) ? `'${c}` : c;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [t.head, ...t.rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
