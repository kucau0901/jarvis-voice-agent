// Research into a table (lib/research-table.ts): the plan's columns, the rows
// the merge gives back, and the CSV to download.
import { MAX_ROWS, parseTablePlan, tableOf, tableResult, toCsv } from "../src/worker/lib/research-table.ts";
import { handleJobs } from "../src/worker/routes/jobs.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : "");
  }
}

const angles = [1, 2, 3].map((n) => ({ name: `share ${n}`, brief: `The ${n}th share of the list.` }));

console.log("the plan");
{
  const p = parseTablePlan(`Here: ${JSON.stringify({ columns: ["Speaker", "Price", "Source"], angles })} done`, 3);
  check("columns and the teams' shares", p?.columns.join() === "Speaker,Price,Source" && p.angles.length === 3, p);
  check("the last column is where it came from", parseTablePlan(JSON.stringify({ columns: ["Speaker", "Price"], angles }), 3) === null);
  check("two to seven columns", parseTablePlan(JSON.stringify({ columns: ["Source"], angles }), 3) === null && parseTablePlan(JSON.stringify({ columns: [...Array(7).fill("x"), "Source"], angles }), 3) === null);
  check("one share for each team", parseTablePlan(JSON.stringify({ columns: ["a", "Source"], angles: angles.slice(0, 2) }), 3) === null && parseTablePlan("no JSON", 3) === null);
}

console.log("\nthe rows");
{
  const cols = ["Speaker", "Price", "Source"];
  const t = tableOf(`${JSON.stringify({ summary: "Two found.", rows: [["Mi A", "RM99", "https://a.example"], ["Mi B"], "not a row", ["Mi C", 5, null, "extra"]] })}\n\nSources:\n- https://a.example`, cols);
  check("read before the Sources list, each row as wide as the columns", t?.summary === "Two found." && t.rows.length === 3 && t.rows[1]!.join("|") === "Mi B||" && t.rows[2]!.join("|") === "Mi C|5|", t);
  const many = tableOf(JSON.stringify({ rows: Array.from({ length: 150 }, (_, i) => [`item ${i}`, "x".repeat(400), "s"]) }), cols);
  check(`at most ${MAX_ROWS}, each cell cut, a summary when none was given`, many?.rows.length === MAX_ROWS && many.rows[0]![1]!.length === 300 && many.summary === "100 found.", many?.rows.length);
  check("prose is not a table", tableOf("SUMMARY: a report.\n\nSome findings.", cols) === null && tableOf(JSON.stringify({ rows: [] }), cols) === null);
  const result = tableResult({ summary: "Two found.", rows: [["Mi | A", "RM99", "https://a.example"]] }, cols, "\n\nSources:\n- https://a.example");
  check("shown as a table, a bar in a cell not breaking it, then where the rest is", result.startsWith("SUMMARY: Two found.\n\n| Speaker | Price | Source |\n|---|---|---|\n| Mi / A | RM99 |") && /in Jobs, to download as CSV\.\n\nSources:/.test(result), result);
}

console.log("\nCSV");
{
  const csv = toCsv(["Name", "Note"], [["Mi A", 'Says "great", cheap'], ["=HYPERLINK(\"https://evil.example\")", "+1"], ["-5%", "@SUM(1)"]]);
  check("UTF-8 for a spreadsheet, quoted as RFC 4180 has it", csv.startsWith("﻿Name,Note\r\n") && csv.includes('Mi A,"Says ""great"", cheap"'), csv);
  check("a cell a spreadsheet would run is made text", csv.includes(`"'=HYPERLINK(""https://evil.example"")"`) && csv.includes("'+1") && csv.includes("'-5%") && csv.includes("'@SUM(1)"), csv);
}

console.log("\nthe download");
{
  const job = { id: "jtable01", title: "Cheapest speakers: Malaysia/2026", createdBy: "u_sara", engine: "research", status: "done" };
  const stub = new Proxy({}, { get: (_t, m) => (m === "then" ? undefined : async (id: string) => (m === "getJob" ? (id === job.id ? job : undefined) : m === "jobTable" ? { columns: ["Speaker", "Source"], rows: [["Mi A", "https://a.example"]] } : undefined)) });
  const env = { STATE: { idFromName: () => "j", get: () => stub } } as never;
  const get = (id: string, person: string, method = "GET") =>
    handleJobs(new Request(`https://j.test/api/v1/jobs/csv?id=${id}`, { method }), env, new URL(`https://j.test/api/v1/jobs/csv?id=${id}`), { kind: "member", id: person, role: "adult", scopes: ["*"], session: "s" } as never);
  const r = (await get(job.id, "u_sara"))!;
  check("theirs: a CSV file, named for the job in plain letters", r.status === 200 && r.headers.get("content-type")?.startsWith("text/csv") === true && r.headers.get("content-disposition") === 'attachment; filename="Cheapest speakers Malaysia2026.csv"' && (await r.text()).includes("Mi A,https://a.example"), r.headers.get("content-disposition"));
  check("someone else's, or none: no such table", (await get(job.id, "u_adam"))!.status === 404 && (await get("nope", "u_sara"))!.status === 404);
  check("read only, for whoever may ask", (await get(job.id, "u_sara", "POST"))!.status === 405 && requiredScope("/api/v1/jobs/csv", "GET") === "ask");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
