import { blocks, csvOf, docOf, hasBlocks, type Block } from "../markdown";
import { button, el, inline, richText } from "./util";

/**
 * A typed answer, drawn (src/app/markdown.ts reads it): plain words as they
 * always were; headings, lists, tables, code and quotes as they are meant; a
 * document, asked for to keep or read at length, as a card that opens in the
 * reader (ui/Reader.ts); and the pages it cited as cards under it. All of it
 * text nodes and elements, never HTML, links https only: an answer can quote
 * a web page.
 */

export type Doc = { title: string; body: string };

/** The answer's own body: a document's card, or its markdown. */
export function answerBody(text: string, open: (doc: Doc) => void): HTMLElement {
  const doc = docOf(text);
  return doc ? docCard(doc, open) : markdown(text);
}

/** Markdown as elements; with no blocks in it, the plain words exactly as before. */
export function markdown(text: string, cls = "txt"): HTMLElement {
  if (!hasBlocks(text)) return richText(text, cls);
  const box = el("div", `${cls} md`);
  for (const b of blocks(text)) box.appendChild(draw(b));
  return box;
}

function draw(b: Block): HTMLElement {
  switch (b.kind) {
    case "h": {
      // Within an answer, a heading is a heading of the answer, not of the page.
      const h = el(b.level === 1 ? "h3" : b.level === 2 ? "h4" : "h5");
      inline(h, b.text);
      return h;
    }
    case "p": {
      const p = el("p");
      inline(p, b.text);
      return p;
    }
    case "ul":
    case "ol": {
      const list = el(b.kind);
      for (const item of b.items) {
        const li = el("li");
        inline(li, item);
        list.appendChild(li);
      }
      return list;
    }
    case "table":
      return table(b);
    case "code": {
      const pre = el("pre");
      pre.appendChild(el("code", "", b.text));
      return pre;
    }
    case "quote": {
      const q = el("blockquote");
      inline(q, b.text);
      return q;
    }
    case "hr":
      return el("hr");
  }
}

/** A table, scrolled sideways when wide, with Copy and Download CSV. */
function table(t: { head: string[]; rows: string[][] }): HTMLElement {
  const wrap = el("div", "mdtable");
  const scroll = el("div", "mdscroll");
  const tbl = el("table");
  const head = el("tr");
  for (const h of t.head) {
    const th = el("th");
    inline(th, h);
    head.appendChild(th);
  }
  tbl.appendChild(el("thead")).appendChild(head);
  const body = tbl.appendChild(el("tbody"));
  for (const r of t.rows) {
    const tr = el("tr");
    for (const c of r) {
      const td = el("td");
      inline(td, c);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  scroll.appendChild(tbl);
  const btns = el("div", "mdbtns");
  const csv = csvOf(t);
  const copy = button("Copy", () => {
    void navigator.clipboard?.writeText([t.head, ...t.rows].map((r) => r.join("\t")).join("\n")).then(() => (copy.textContent = "Copied"), () => (copy.textContent = "Could not copy"));
  });
  btns.append(copy, button("Download CSV", () => {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: "table.csv" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }));
  wrap.append(scroll, btns);
  return wrap;
}

/** A document's card: its title, how it begins, and Open. */
function docCard(doc: Doc, open: (doc: Doc) => void): HTMLElement {
  const card = el("div", "txt doc");
  const first = blocks(doc.body).find((b): b is Extract<Block, { kind: "p" }> => b.kind === "p")?.text ?? "";
  card.append(el("span", "doctag", "Document"), el("b", "doctitle", doc.title));
  if (first) card.appendChild(el("span", "docfirst", first.replace(/\*\*|`|\[([^\]]*)\]\([^)]*\)/g, "$1")));
  card.appendChild(button("Open", () => open(doc), "docopen"));
  return card;
}

/** The pages an answer cited, as cards: each its title and site, opened in a new tab. */
export function linkCards(links: readonly { url: string; title: string }[]): HTMLElement {
  const box = el("div", "links");
  for (const l of links) {
    let host = "";
    try {
      const u = new URL(l.url);
      if (u.protocol !== "https:") continue;
      host = u.hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    const a = el("a", "lcard");
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.append(el("b", "", l.title || host), el("small", "", host));
    box.appendChild(a);
  }
  return box;
}
