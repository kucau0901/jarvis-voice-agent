// The pages one question makes, and which card each gets (src/app/madePages.ts).
import { MadePages, type Page } from "../src/app/madePages.ts";

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

const page = (id: string, label: string) => ({ kind: "page", page: id, label });

console.log("the pages one answer makes");
{
  const apart: Page[] = [];
  const m = new MadePages((p) => void apart.push(p));
  check("anything else shown is not a page", !m.seen({ kind: "map", place: "x" }) && m.take() === undefined);
  check("a page waits for its answer", m.seen(page("p1", "Chargers")) && apart.length === 0);
  check("…which takes it", m.take()?.id === "p1" && m.take() === undefined);
  m.seen(page("p2", "Chargers"));
  m.seen(page("p3", "Speakers"));
  check("two in one answer: the first apart, the answer the last", apart.map((p) => p.id).join() === "p2" && m.take()?.title === "Speakers");
  m.seen(page("p4", "Shoes"));
  m.flush();
  check("no answer came: apart", apart.at(-1)?.id === "p4" && m.take() === undefined);
  m.flush();
  check("nothing waiting: nothing apart", apart.length === 2);
  m.seen(page("p5", "Old"));
  m.clear();
  check("the chat cleared: forgotten, not left for the next answer", m.take() === undefined && apart.length === 2);
  m.seen({ kind: "page", page: "p6" });
  check("no label: called Page", m.take()?.title === "Page");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
