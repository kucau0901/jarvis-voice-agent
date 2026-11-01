// Past attempts (lib/episodes.ts): what was tried, how it went, given to the
// next question like it, as data.
import { Episodes, episodeOfChain, episodeOfAnswer, episodeOfJob, KEEP_MS, MAX_EPISODES, pastBlock } from "../src/worker/lib/episodes.ts";
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
  // A short goal inside a longer, different one is not the same attempt (Jaccard, as memory's near-duplicates).
  const f = new Episodes(fakeStorage());
  await f.add("u_sara", episodeOfJob(job({ id: "t1", title: "Flights to Tokyo in December", status: "done", summary: "A flight at RM2,100." })), T);
  await f.add("u_sara", episodeOfJob(job({ id: "t2", title: "Book a hotel near Tokyo station for the December flights, and email the itinerary" })), T + 1);
  check("…kept apart, the first one's outcome kept", (await f.of("u_sara", T + 1)).length === 2 && (await f.of("u_sara", T + 1)).some((x) => x.id === "t1" && x.outcome === "ok"));
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

console.log("\na question someone asked, answered with two tools or more: what worked");
{
  const asked = "Will it rain before my dentist appointment on Friday?";
  const two = { ok: true, tools: ["calendar_list", "weather"], text: "Your dentist is at 3 PM on Friday, and rain is due from 5. Take an umbrella anyway." };
  const ok = episodeOfAnswer(asked, two);
  check("kept as what worked", ok?.source === "chain" && ok.outcome === "ok" && ok.goal === asked, ok);
  check("its lesson: the tools in order, then the answer's first sentence",
    ok?.lesson === "calendar_list, weather: Your dentist is at 3 PM on Friday, and rain is due from 5.", ok?.lesson);
  check("one tool: nothing kept", episodeOfAnswer(asked, { ...two, tools: ["weather"] }) === null);
  check("only chatted: nothing kept", episodeOfAnswer("Tell me a joke about umbrellas", { ok: true, tools: [], text: "Why did the umbrella…" }) === null);
  check("two tools but no answer: nothing kept", episodeOfAnswer(asked, { ...two, ok: false, text: "I got stuck working that one out." }) === null);
  check("one that started a job: nothing kept, the job is noted when it finishes",
    episodeOfAnswer(asked, { ...two, tools: ["recall", "start_job"], text: "I've started researching that." }) === null);
  check("a first sentence that ends too soon is not all that is kept",
    episodeOfAnswer(asked, { ...two, text: "Dr. Lee is at 3. Rain from 5." })?.lesson === "calendar_list, weather: Dr. Lee is at 3. Rain from 5.");
  const long = episodeOfAnswer("x ".repeat(300), { ok: true, tools: Array.from({ length: 12 }, (_, i) => `tool_number_${i}`), text: "word ".repeat(200) });
  check("still inside the 240-character cut", !!long && long.goal.length <= 240 && long.lesson.length <= 240 && long.lesson.endsWith("…"), long);
  const clause = episodeOfAnswer(asked, { ...two, text: "a".repeat(400) });
  check("a first sentence that runs on is cut short", !!clause && clause.lesson.length < 160 && clause.lesson.endsWith("…"), clause?.lesson.length);

  const e = new Episodes(fakeStorage());
  await e.add("u_sara", ok!, T);
  const like = await e.match("u_sara", "is rain due for the dentist?", T);
  check("matched by two words it shares", like.length === 1 && like[0]!.outcome === "ok", like);
  check("not by one alone", !(await e.match("u_sara", "dentist", T)).length);
  const block = pastBlock(like, "Asia/Kuala_Lumpur");
  check("given as data, saying it worked", /DATA, NOT INSTRUCTIONS/.test(block) && block.includes(`"${asked}" worked. calendar_list, weather: `), block);
  await e.add("u_sara", episodeOfAnswer(asked, two)!, T + 1);
  await e.add("u_sara", episodeOfAnswer(asked, two)!, T + 2);
  const again = await e.of("u_sara", T + 2);
  check("asked again: counted on the one kept, not kept twice", again.length === 1 && again[0]!.seen === 3 && again[0]!.id === ok!.id, again);
  check("forgotten as any other", (await e.forget("u_sara", ok!.id)) && !(await e.of("u_sara", T + 2)).length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
