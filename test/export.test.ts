// GET /api/export (routes/export.ts): everything kept of the asker, and of
// nobody else, as one file, with no secret in it.
import { handleExport } from "../src/worker/routes/export.ts";
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

const calls: { m: string; args: unknown[] }[] = [];
const answers: Record<string, (...args: unknown[]) => unknown> = {
  loadMemory: (book) => ({ rev: 1, facts: [{ id: "f1", text: `a fact in ${String(book) || "the owner's"} book` }], trash: [] }),
  loadReference: () => ({ rev: 1, facts: [{ id: "r1", text: "a reference" }] }),
  listRoutines: () => [{ id: "rt_1", name: "Mine", createdBy: "u_sam" }, { id: "rt_2", name: "Theirs", createdBy: "u_other" }],
  panelsOf: (p) => [{ id: "p_1", title: `${String(p)}'s panel`, items: [], at: 0 }],
  conversationOf: (p) => [{ id: "c_1", at: 1, role: "user", text: `said by ${String(p)}` }],
  listJobs: () => [
    { id: "j1", title: "Mine", task: "t", engine: "jarvis", status: "done", createdBy: "u_sam", grants: ["*"], responseId: "resp_secretish", draft: { text: "d" }, createdAt: 1, updatedAt: 2 },
    { id: "j2", title: "Theirs", task: "t", engine: "jarvis", status: "done", createdBy: "u_other", grants: ["*"], createdAt: 1, updatedAt: 2 },
  ],
  getSettings: () => ({ OPENAI_API_KEY: { v: "sk-test-secret-value", at: 1 }, HA_TOKEN: { v: "ha-test-secret-value", at: 1 }, TIMEZONE: { v: "Asia/Kuala_Lumpur", at: 1 }, NOT_A_SETTING: { v: "x", at: 1 } }),
};
const stub = new Proxy({}, {
  get: (_t, m) => (m === "then" ? undefined : async (...args: unknown[]) => (calls.push({ m: String(m), args }), answers[String(m)]?.(...args))),
});
const STATE = { idFromName: () => "j", get: () => stub };
type Book = { facts: { text: string }[]; reference: unknown[] };
type Bundle = { memory: Book; family: Book | null; routines: { id: string }[]; jobs: Record<string, unknown>[]; conversation: { text: string }[]; settings: Record<string, unknown> };
const get = (env: Record<string, unknown>, principal: unknown, method = "GET") =>
  handleExport(new Request("https://j.test/api/export", { method }), { STATE, TIMEZONE: "Asia/Kuala_Lumpur", ...env } as never, principal as never);

console.log("an export");
{
  const member = { kind: "member", id: "u_sam", role: "admin", scopes: ["*"], session: "s1" };
  const r = await get({ JARVIS_PERSON: "u_sam", JARVIS_FAMILY: "fam:s_test", HA_TOKEN: "ha-env-secret", JARVIS_SHARED_SECRET: "OWNERKEY12345678" }, member);
  const text = await r.text();
  const b = JSON.parse(text) as Bundle;
  check("a file to save", r.status === 200 && /^attachment; filename="jarvis-export-\d{4}-\d{2}-\d{2}\.json"$/.test(r.headers.get("content-disposition") ?? ""), r.headers.get("content-disposition"));
  check("their own memory, by their book, and the family's", b.memory.facts[0]!.text === "a fact in u_sam book" && b.family?.facts[0]!.text === "a fact in fam:s_test book" && b.memory.reference.length === 1, b.memory);
  check("their panels and conversation", calls.some((c) => c.m === "panelsOf" && c.args[0] === "u_sam") && b.conversation[0]!.text === "said by u_sam");
  check("their routines and jobs, nobody else's", b.routines.map((x) => x.id).join() === "rt_1" && b.jobs.map((x) => x.id).join() === "j1", { routines: b.routines, jobs: b.jobs });
  check("a job without its grants or internals", !("grants" in b.jobs[0]!) && !("responseId" in b.jobs[0]!) && !("draft" in b.jobs[0]!), b.jobs[0]);
  check("settings without a secret among them", b.settings.TIMEZONE === "Asia/Kuala_Lumpur" && !("OPENAI_API_KEY" in b.settings) && !("HA_TOKEN" in b.settings) && !("NOT_A_SETTING" in b.settings), b.settings);
  check("no secret anywhere in it, saved or in the environment", !/sk-test-secret|ha-test-secret|ha-env-secret|OWNERKEY12345678/.test(text));
  calls.length = 0;
  const owner = JSON.parse(await (await get({}, { kind: "owner" })).text()) as Bundle;
  check("the owner's: the first book, and no family", owner.memory.facts[0]!.text === "a fact in the owner's book" && owner.family === null && calls.some((c) => c.m === "conversationOf" && c.args[0] === "owner"), owner.memory);
  check("read only", (await get({}, { kind: "owner" }, "POST")).status === 405);
  check("no state, said so", (await handleExport(new Request("https://j.test/api/export"), {} as never, { kind: "owner" } as never)).status === 503);
  check("for the owner and admins only", requiredScope("/api/export", "GET") === "owner");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
