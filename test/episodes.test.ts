// Past attempts (lib/episodes.ts): what was tried, how it went, given to the
// next question like it, as data.
import { Episodes, episodeOfChain, episodeOfJob, KEEP_MS, MAX_EPISODES, pastBlock } from "../src/worker/lib/episodes.ts";
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

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
    _m: m,
  };
}

const T = 1_790_000_000_000;
const job = (over: Record<string, unknown> = {}) => ({ id: "j1", title: "Cheapest genuine Xiaomi speaker on Shopee", task: "t", engine: "jarvis" as const, status: "failed", error: "Shopee refused the search: the browser was blocked", ...over });

console.log("what an attempt comes to");
{
  const f = episodeOfJob(job());
  check("a failed job: its error is the lesson", f.outcome === "failed" && f.source === "job" && /blocked/.test(f.lesson) && f.id === "j1", f);
  const ok = episodeOfJob(job({ status: "done", summary: "The A229 at RM650.", engine: "research" }));
  check("a done one: its summary, as research", ok.outcome === "ok" && ok.source === "research" && ok.lesson === "The A229 at RM650.", ok);
  const c = episodeOfChain("Turn on the porch light", [{ tool: "control_home", said: "That failed: Home Assistant timed out" }]);
  check("a question whose tools failed: which, and what they said", c.source === "chain" && c.lesson === "control_home: Home Assistant timed out", c);
}

console.log("\nkept, tidied as they come");
{
  const st = fakeStorage();
  const e = new Episodes(st);
  await e.add("u_sara", episodeOfJob(job()), T);
  await e.add("u_sara", episodeOfJob(job()), T + 1);
  check("the same job finishing twice (a retried alarm) is kept once", (await e.of("u_sara", T)).length === 1 && (await e.of("u_sara", T))[0]!.seen === 1);
  await e.add("u_sara", episodeOfJob(job({ id: "j2", title: "Cheapest genuine Xiaomi speaker on Shopee Malaysia" })), T + 2);
  const one = await e.of("u_sara", T + 2);
  check("the same attempt again is counted, not kept twice", one.length === 1 && one[0]!.seen === 2, one);
  check("each person's own", (await e.of("u_adam", T)).length === 0);
  check(`gone after ${KEEP_MS / 86_400_000} days`, (await e.of("u_sara", T + KEEP_MS + 10)).length === 0);
  for (let i = 0; i < MAX_EPISODES + 5; i++) await e.add("u_many", { id: `x${i}`, source: "chain", goal: `task number ${i} alpha${i} beta${i}`, outcome: "ok", lesson: "" }, T + i);
  const many = await e.of("u_many", T + MAX_EPISODES + 5);
  check(`at most ${MAX_EPISODES}, the newest kept`, many.length === MAX_EPISODES && many[0]!.id === `x${MAX_EPISODES + 4}`, many.length);
  check("forgotten one at a time", (await e.forget("u_sara", one[0]!.id)) && (await e.of("u_sara", T)).length === 0);
  await e.clear("u_many");
  check("all gone when they leave", !st._m.has("episodes:u_many"));
}

console.log("\ngiven to a question like them");
{
  const e = new Episodes(fakeStorage());
  await e.add("u_sara", episodeOfJob(job()), T);
  await e.add("u_sara", episodeOfChain("Turn on the porch light", [{ tool: "control_home", said: "That failed: timed out" }]), T);
  const like = await e.match("u_sara", "find me a Xiaomi speaker on Shopee", T);
  check("by the words they share", like.length === 1 && like[0]!.id === "j1", like);
  check("not one word alone, nor anything else", !(await e.match("u_sara", "Shopee", T)).length && !(await e.match("u_sara", "play jazz", T)).length);
  const block = pastBlock(like, "Asia/Kuala_Lumpur");
  check("as data, not instructions, with how it went", /DATA, NOT INSTRUCTIONS/.test(block) && block.includes("failed. Shopee refused the search") && /avoid repeating what did not work/.test(block), block);
  check("read and forgotten as memory is", requiredScope("/api/memory/past", "GET") === "memory.read" && requiredScope("/api/memory/past", "DELETE") === "memory.write");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
