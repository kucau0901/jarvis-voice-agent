import { tidy } from "./quote.ts";

/**
 * Research into a table (Hark's wide research): a research team that fills
 * rows rather than writing a report, for "the 10 cheapest genuine Xiaomi
 * speakers in Malaysia, with seller and rating". The plan fixes the columns
 * and splits the list between the teams; each team finds its share; the merge
 * writes the rows as JSON, checked against the sources like any report
 * (lib/jobs.ts). Pure, so Node tests it: the prompts are in
 * lib/router-prompt.ts.
 */

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 7;
export const MAX_ROWS = 100;
const MAX_CELL = 300;
/** All of a table's rows, as kept in the Durable Object. */
const MAX_BYTES = 256_000;
/** Rows shown in the result itself: the whole table is a download. */
const PREVIEW = 20;

export interface TablePlan {
  columns: string[];
  angles: { name: string; brief: string }[];
}

/** The JSON object in a model's answer, wherever it sits; null when there is none. */
function jsonIn(text: string): unknown {
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

/** The plan's columns (the last one Source) and `teams` angles, each team's share of the list; null for anything else. */
export function parseTablePlan(text: string, teams: number): TablePlan | null {
  const v = jsonIn(text) as { columns?: unknown; angles?: unknown } | null;
  if (!v || !Array.isArray(v.columns) || !Array.isArray(v.angles) || v.angles.length !== teams) return null;
  const columns = v.columns.map((c) => (typeof c === "string" ? tidy(c).slice(0, 40) : "")).filter(Boolean);
  if (columns.length < MIN_COLUMNS || columns.length > MAX_COLUMNS || columns.length !== v.columns.length || !/^sources?$/i.test(columns.at(-1)!)) return null;
  const angles: TablePlan["angles"] = [];
  for (const a of v.angles) {
    const name = typeof a?.name === "string" ? tidy(a.name) : "";
    const brief = typeof a?.brief === "string" ? tidy(a.brief) : "";
    if (!name || !brief || name.length > 40 || brief.length > 400) return null;
    angles.push({ name, brief });
  }
  return { columns, angles };
}

/**
 * The rows a merged (and checked) table came back as: JSON
 * {"summary": "…", "rows": [[…], …]} before any Sources list. Each row made
 * the width of the columns, each cell tidied and cut; at most MAX_ROWS, and
 * fewer if they would not fit. Null when it is not that.
 */
export function tableOf(text: string, columns: readonly string[]): { summary: string; rows: string[][] } | null {
  const end = text.lastIndexOf("\n\nSources:");
  const v = jsonIn(end >= 0 ? text.slice(0, end) : text) as { summary?: unknown; rows?: unknown } | null;
  if (!v || !Array.isArray(v.rows)) return null;
  const rows = v.rows
    .filter((r): r is unknown[] => Array.isArray(r))
    .slice(0, MAX_ROWS)
    .map((r) => columns.map((_, i) => (r[i] === undefined || r[i] === null ? "" : tidy(String(r[i])).slice(0, MAX_CELL))));
  while (rows.length && JSON.stringify(rows).length > MAX_BYTES) rows.pop();
  if (!rows.length) return null;
  return { summary: typeof v.summary === "string" && v.summary.trim() ? tidy(v.summary) : `${rows.length} found.`, rows };
}

/** The result as read in a message and in Jobs: the summary, the first rows as a table, and where the rest is. */
export function tableResult(t: { summary: string; rows: string[][] }, columns: readonly string[], sources: string): string {
  const cell = (c: string) => c.replace(/\|/g, "/");
  const shown = t.rows.slice(0, PREVIEW);
  return (
    `SUMMARY: ${t.summary}\n\n` +
    `| ${columns.map(cell).join(" | ")} |\n|${columns.map(() => "---").join("|")}|\n` +
    shown.map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n") +
    `\n\n${t.rows.length > shown.length ? `The first ${shown.length} of ${t.rows.length} rows. ` : ""}The whole table is in Jobs, to download as CSV.` +
    sources
  );
}

/**
 * The table as CSV, with a byte order mark so a spreadsheet reads it as
 * UTF-8. A cell a spreadsheet would run as a formula (= + - @, a tab or a
 * return first) is made text: the cells come from strangers' web pages.
 */
export function toCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (c: string) => {
    const safe = /^[=+\-@\t\r]/.test(c) ? `'${c}` : c;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return "﻿" + [columns, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
