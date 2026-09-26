import { PRICES_AS_OF, priceOf, TOKEN_PRICES } from "../src/worker/lib/prices.ts";
import { addToDay, costOf, dayOf, emptyDay, report, type UsageEntry } from "../src/worker/lib/usage.ts";
import { StateHost, USAGE_KEEP_DAYS, USAGE_RECENT_MAX } from "../src/worker/lib/state-host.ts";

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
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;

const q = (over: Partial<UsageEntry> = {}): UsageEntry => ({
  at: Date.UTC(2026, 8, 26, 3), surface: "glasses", by: "gpt-6-luna", ok: true, ms: 4000,
  input: 21_000, cached: 20_000, written: 0, output: 300, searches: 0, tools: [], ask: "what's my next meeting?",
  ...over,
});

console.log("prices");
{
  check("dated", /^\d{4}-\d{2}-\d{2}$/.test(PRICES_AS_OF));
  check("Luna, as OpenAI lists it", JSON.stringify(TOKEN_PRICES["gpt-6-luna"]) === JSON.stringify({ input: 0.1, cached: 0.01, write: 0.125, output: 0.5 }));
  check("a dated model id is its model", priceOf("gpt-6-luna-2026-09-01") === TOKEN_PRICES["gpt-6-luna"] && priceOf(" GPT-6-SOL ") === TOKEN_PRICES["gpt-6-sol"]);
  check("an unknown one has no price", priceOf("gpt-7-nova") === null);
}

console.log("\nwhat a question costs");
{
  // 1,000 plain input at $0.10, 20,000 cached at $0.01, 300 output at $0.50, per million.
  check("Luna with the prompt cached", near(costOf(q()), (1000 * 0.1 + 20_000 * 0.01 + 300 * 0.5) / 1e6), costOf(q()));
  check("writing the cache costs its own price", near(costOf(q({ cached: 0, written: 21_000 })), (21_000 * 0.125 + 300 * 0.5) / 1e6));
  check("a web search adds a cent", near(costOf(q({ searches: 2 })), (costOf(q()) ?? 0) + 0.02));
  check("Home Assistant's answers are free", costOf(q({ by: "home-assistant", input: 0, output: 0 })) === 0);
  check("a live minute is five cents", near(costOf(q({ by: "gpt-live-1", seconds: 120, input: 0, cached: 0, output: 0 })), 0.1));
  check("an unknown model: no guess", costOf(q({ by: "gpt-7-nova" })) === null);
}

console.log("\na day, and the month");
{
  let d = emptyDay("2026-09-26");
  d = addToDay(d, q());
  d = addToDay(d, q({ by: "home-assistant", input: 0, cached: 0, output: 0 }));
  d = addToDay(d, q({ by: "gpt-live-1", seconds: 600, input: 0, cached: 0, output: 0, surface: "live" }));
  d = addToDay(d, q({ surface: "job", by: "gpt-6-luna" }));
  d = addToDay(d, q({ by: "gpt-7-nova" }));
  check("questions counted, jobs and live apart", d.questions === 3 && d.jobs === 1 && d.liveSeconds === 600, d);
  check("the house's share", d.byHouse === 1);
  check("costs split by what spent them", near(d.cost.live, 0.5) && near(d.cost.jobs, costOf(q())!) && near(d.cost.router, costOf(q())!), d.cost);
  check("tokens with no price are noted", d.unpriced === 21_300);

  const days = [d, { ...emptyDay("2026-09-25"), questions: 2, cost: { router: 0.01, live: 0, jobs: 0 } }, { ...emptyDay("2026-08-31"), questions: 50 }];
  const recent = [q({ ms: 1000 }), q({ ms: 9000, ask: "slow one" }), q({ ms: 3000 }), q({ surface: "job", ms: 600_000 }), q({ seconds: 60, by: "gpt-live-1", ms: 60_000 })];
  const r = report(days, recent, "2026-09-26");
  check("this month only", r.month === "2026-09" && r.total.questions === 5 && near(r.total.cost.router, costOf(q())! + 0.01), r.total);
  check("today", r.today.day === "2026-09-26" && r.today.questions === 3);
  check("median answer time, questions only", r.medianMs === 3000, r.medianMs);
  check("slowest first, questions only", r.slowest[0]?.ask === "slow one" && r.slowest.length === 3, r.slowest.map((e) => e.ms));
  check("an empty month", report([], [], "2026-10-01").total.questions === 0 && report([], [], "2026-10-01").medianMs === null);
}

console.log("\nthe day an entry belongs to");
{
  const at = Date.UTC(2026, 8, 25, 20); // 04:00 on the 26th in Kuala Lumpur
  check("in the owner's time zone", dayOf(at, "Asia/Kuala_Lumpur") === "2026-09-26" && dayOf(at, "UTC") === "2026-09-25");
  check("a bad zone falls back to UTC", dayOf(at, "Mars/Olympus") === "2026-09-25");
}

console.log("\nkept in the Durable Object");
{
  const m = new Map<string, unknown>();
  const storage = {
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
  };
  const host = new StateHost(storage, {} as never);
  for (let i = 0; i < USAGE_RECENT_MAX + 5; i++) await host.recordUsage(q({ ms: i }), "2026-09-26");
  await host.recordUsage(q(), "2026-08-01");
  const r = await host.usageReport("2026-09-26");
  check("a day's totals add up", r.total.questions === USAGE_RECENT_MAX + 5 && r.today.questions === USAGE_RECENT_MAX + 5, r.total);
  check("last month is not this month", !r.total.day.startsWith("2026-08") && r.total.questions === USAGE_RECENT_MAX + 5);
  check(`the last ${USAGE_RECENT_MAX} questions kept`, r.recent.length === USAGE_RECENT_MAX && r.recent[0]!.ms === 6, r.recent.length);

  for (let i = 0; i < USAGE_KEEP_DAYS + 3; i++) m.set(`usage:day:2020-01-${String(i).padStart(4, "0")}`, emptyDay("x"));
  await host.recordUsage(q(), "2026-09-27");
  const kept = [...m.keys()].filter((k) => k.startsWith("usage:day:"));
  check(`only ${USAGE_KEEP_DAYS} days are kept, the oldest go`, kept.length === USAGE_KEEP_DAYS && kept.includes("usage:day:2026-09-27"), kept.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
