// A typed answer's markdown, read into blocks (src/app/markdown.ts): what
// ui/rich.ts draws, as text, never HTML.
import { blocks, csvOf, docOf, hasBlocks } from "../src/app/markdown.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 400) : "");
  }
}

console.log("plain answers stay plain");
check("words and lines, a bold word, a link: no blocks", !hasBlocks("The gate is closed.\nThe **front door** is locked: [map](https://x.example)."));
check("a dash in a sentence is not a list", !hasBlocks("It is 3 - 2 now, and 5-4 later."));
check("one pipe is not a table", !hasBlocks("Either this | or that"));

console.log("\nblocks");
{
  const b = blocks("# Plan\n\nIntro line one\nline two\n\n## Steps\n\n- first\n- second\n\n1. one\n2) two\n\n> quoted\n> more\n\n---\n\n```\ncode <script>x</script>\n```");
  check("headings, a paragraph with its lines, lists, a quote, a rule, code", b.map((x) => x.kind).join() === "h,p,h,ul,ol,quote,hr,code", b.map((x) => x.kind));
  check("…each holding its words", b[1]!.kind === "p" && b[1]!.text === "Intro line one\nline two" && b[3]!.kind === "ul" && b[3]!.items.join() === "first,second" && b[4]!.kind === "ol" && b[4]!.items.join() === "one,two");
  check("a tag in code stays text", b[7]!.kind === "code" && b[7]!.text === "code <script>x</script>");
  const t = blocks("Compared:\n\n| Speaker | Price | Rating |\n|:---|---:|---|\n| Mi A | RM99 |\n| Mi B | RM149 | 4.6 | extra |\n\nDone.");
  const table = t.find((x) => x.kind === "table");
  check("a table: its heading and rows, ragged rows made as wide as the heading", table?.kind === "table" && table.head.join() === "Speaker,Price,Rating" && table.rows.length === 2 && table.rows[0]!.join("|") === "Mi A|RM99|" && table.rows[1]!.length === 3, table);
  check("…between its paragraphs", t[0]!.kind === "p" && t.at(-1)!.kind === "p");
}

console.log("\na document");
{
  const d = docOf("# Trip to Langkawi\n\nThree days, by car and ferry.\n\n## Day one\n\nDrive to Kuala Perlis.");
  check("a # title and ## sections: a document", d?.title === "Trip to Langkawi" && d.body.startsWith("Three days"), d);
  check("an answer with headings but no title is not", docOf("## Day one\n\nx") === null && docOf("# Title only\n\nno sections") === null);
}

console.log("\nCSV");
{
  const csv = csvOf({ head: ["Name", "Note"], rows: [["Mi A", 'Says "great", cheap'], ["=HYPERLINK(\"x\")", "+1"], ["-2", "@cmd"]] });
  check("quoted as RFC 4180 has it", csv.split("\r\n")[1] === 'Mi A,"Says ""great"", cheap"', csv);
  check("a cell a spreadsheet would run is made text", csv.includes(`"'=HYPERLINK(""x"")"`) && csv.includes("'+1") && csv.includes("'-2") && csv.includes("'@cmd"), csv);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
