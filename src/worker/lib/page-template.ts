import { escapeHtml } from "./http.ts";
import type { StoredPage } from "./pages.ts";

/**
 * A page as its visitors see it (routes/page.ts): one fixed template, in
 * Tesla's colours, filled with what Jarvis wrote as words and nothing else.
 * Every word is escaped; a body knows "- " lists, **bold** and https links,
 * and no HTML at all. Sections are tabs, and the theme a switch, both in CSS:
 * the page has no script, and is served sandboxed. It says it was made by
 * Jarvis, an AI, wherever it goes. Drawn when it is opened, so a fix here
 * reaches pages made before it.
 */

/** A body's words: paragraphs and "- " lists, **bold**, and links to https pages. */
function body(text: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*([^*\n]{1,200})\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]\n]{1,160})\]\((https:\/\/[^\s)"'<>]{1,2000})\)/g, '<a href="$2" rel="noopener noreferrer nofollow" target="_blank">$1</a>');
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const para of text.split(/\n{2,}/)) {
    for (const line of para.split("\n")) {
      const item = /^\s*[-*•]\s+(.*)$/.exec(line);
      if (item) list.push(item[1]!);
      else {
        flush();
        if (line.trim()) out.push(`<p>${inline(line.trim())}</p>`);
      }
    }
    flush();
  }
  return out.join("");
}

function table(t: { columns: string[]; rows: string[][] }): string {
  return (
    `<div class="tbl"><table><thead><tr>${t.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>` +
    `<tbody>${t.rows.map((r) => `<tr>${t.columns.map((_, i) => `<td>${escapeHtml(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
  );
}

export function renderPage(p: StoredPage): string {
  const tabs = p.sections.length > 1;
  // The tabs first, then the sections they choose between: siblings, so CSS alone can show one.
  const tabRow = tabs ? p.sections.map((s, i) => `<input type="radio" name="tab" id="t${i}"${i === 0 ? " checked" : ""}><label for="t${i}">${escapeHtml(s.heading)}</label>`).join("") : "";
  const sections = tabRow + p.sections.map((s, i) => `<section class="s${i}"><h2>${escapeHtml(s.heading)}</h2>${body(s.body)}${s.table ? table(s.table) : ""}</section>`).join("");
  const shown = p.sections.map((_, i) => `#t${i}:checked ~ .s${i}`).join(", ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(p.title)}</title>
<style>
:root { --bg: #f4f4f4; --card: #ffffff; --fg: #171a20; --dim: #5c5e62; --hair: #d0d1d2; --accent: #3e6ae1; }
#dark:checked ~ .page { --bg: #000000; --card: #171a20; --fg: #eeeeee; --dim: #8e8e8e; --hair: #393c41; --accent: #6e8ff0; }
* { box-sizing: border-box; }
body { margin: 0; }
#dark { position: absolute; opacity: 0; }
.page { min-height: 100vh; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px 16px 48px; }
.wrap { max-width: 760px; margin: 0 auto; }
header { padding: 32px 0 20px; }
.badge { display: inline-block; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--dim); border: 1px solid var(--hair); border-radius: 999px; padding: 2px 10px; }
h1 { font-size: 34px; line-height: 1.15; margin: 14px 0 8px; font-weight: 600; }
.sub { color: var(--dim); margin: 0; font-size: 18px; }
.theme { float: right; cursor: pointer; font-size: 13px; color: var(--dim); border: 1px solid var(--hair); border-radius: 999px; padding: 4px 12px; }
input[name=tab] { position: absolute; opacity: 0; }
input[name=tab] + label { display: inline-block; cursor: pointer; padding: 8px 16px; margin: 0 6px 12px 0; border-radius: 999px; border: 1px solid var(--hair); background: var(--card); font-size: 14px; }
input[name=tab]:checked + label { background: var(--fg); color: var(--bg); border-color: var(--fg); }
section { background: var(--card); border-radius: 24px; padding: 20px 22px; margin-bottom: 16px; }
${tabs ? `section { display: none; } ${shown} { display: block; }` : ""}
h2 { font-size: 20px; margin: 0 0 8px; font-weight: 600; }
a { color: var(--accent); }
.tbl { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--hair); vertical-align: top; }
footer { color: var(--dim); font-size: 13px; text-align: center; margin-top: 28px; }
</style></head>
<body><input type="checkbox" id="dark"><div class="page"><div class="wrap">
<header><label class="theme" for="dark">Light / dark</label><span class="badge">AI-generated</span>
<h1>${escapeHtml(p.title)}</h1>${p.subtitle ? `<p class="sub">${escapeHtml(p.subtitle)}</p>` : ""}</header>
<main>${sections}</main>
<footer>Made by Jarvis, an AI assistant. It can be wrong: check what matters.</footer>
</div></div></body></html>`;
}
