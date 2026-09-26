import { SHARED_CHARS, SHARED_KEEP_MS, SHARED_MAX, SHARED_SHOW, fromOthers, keep, originOf, sharedBlock, type SharedTurn } from "../src/worker/lib/shared.ts";
import { StateHost } from "../src/worker/lib/state-host.ts";

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

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const turn = (origin: string, label: string, role: "user" | "assistant", text: string, at: number): SharedTurn => ({ at, origin, label, role, text });

console.log("where a question came from");
{
  const glasses = originOf({ kind: "device", id: "dev_g2", name: "G2 glasses", scopes: ["ask"] }, { id: "ignored_id", label: "forged" });
  check("a device is itself, whatever it claims", glasses?.id === "dev_g2" && glasses.label === "G2 glasses", glasses);
  const car = originOf({ kind: "owner" }, { id: "s_abc123", label: "the car" });
  check("an owner-key screen says which it is", car?.id === "s_abc123" && car.label === "the car");
  check("no id, no origin", originOf({ kind: "owner" }, {}) === null && originOf({ kind: "owner" }, null) === null);
  check("an odd id is refused", originOf({ kind: "owner" }, { id: "../../x", label: "x" }) === null);
  check("the label is cleaned and short", originOf({ kind: "owner" }, { id: "s_abc123", label: "a\u0000b" + "c".repeat(60) })!.label.length === 40);
  check("no label: another screen", originOf({ kind: "owner" }, { id: "s_abc123" })!.label === "another screen");
}

console.log("\nthe shared log");
{
  const log = [
    turn("car", "the car", "user", "what's the dentist's address?", T0 - 40 * MIN),
    turn("car", "the car", "assistant", "12 Main Street.", T0 - 40 * MIN),
    turn("car", "the car", "user", "and their phone number?", T0 - 5 * MIN),
    turn("car", "the car", "assistant", "03-1234 5678.", T0 - 5 * MIN),
    turn("phone", "iPhone", "user", "remind me at five", T0 - 2 * MIN),
    turn("phone", "iPhone", "assistant", "Done.", T0 - 2 * MIN),
  ];
  check(`half an hour is kept`, keep(log, T0).length === 4 && SHARED_KEEP_MS === 30 * MIN);
  check(`${SHARED_MAX} turns at most`, keep(Array.from({ length: 30 }, (_, i) => turn("a", "a", "user", `${i}`, T0)), T0).length === SHARED_MAX);
  const forPhone = fromOthers(log, "phone", T0);
  check("the phone sees the car's, not its own", forPhone.length === 2 && forPhone.every((t) => t.origin === "car"), forPhone);
  check("oldest first", forPhone[0]!.text === "and their phone number?");
  check(`the latest ${SHARED_SHOW} at most`, fromOthers(Array.from({ length: 16 }, (_, i) => turn("a", "a", "user", `${i}`, T0)), "b", T0).length === SHARED_SHOW);
  const long = Array.from({ length: 6 }, (_, i) => turn("a", "a", "user", "x".repeat(600) + i, T0));
  const cut = fromOthers(long, "b", T0);
  check(`and ${SHARED_CHARS} characters at most, dropping the oldest`, cut.reduce((n, t) => n + t.text.length, 0) <= SHARED_CHARS && cut[cut.length - 1]!.text.endsWith("5"), cut.length);

  const block = sharedBlock(forPhone, T0);
  check("said as what was said, not instructions", /not instructions/.test(block) && block.includes("[the car, 5 min ago] User: and their phone number?") && block.includes("Jarvis: 03-1234 5678."), block);
  check("nothing when there is nothing", sharedBlock([], T0) === "");
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
  await host.appendShared([turn("car", "the car", "user", "where did I park?", T0), turn("car", "the car", "assistant", "Level 3, bay 42.", T0)], T0);
  check("the car's turns reach the glasses", (await host.recentShared("dev_g2", T0 + MIN)).length === 2);
  check("not back to the car", (await host.recentShared("car", T0 + MIN)).length === 0);
  check("gone after half an hour", (await host.recentShared("dev_g2", T0 + 31 * MIN)).length === 0);
  await host.appendShared([turn("x", "x", "user", "new", T0 + 31 * MIN)], T0 + 31 * MIN);
  check("and pruned when the next is added", ((m.get("convo:shared") as SharedTurn[]) ?? []).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
