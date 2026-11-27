// The desktop app's bridge (src/app/desktop.ts): whether someone can see this
// screen, for the events socket's presence and ack (docs/api.md), and which
// bridge is taken. Idle or locked is not seen, so an alert goes on to the phone.
import { desktop, seenHere } from "../src/app/desktop.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 300) : ""); }
}

console.log("seen here");
{
  check("visible, in use: seen", seenHere(true, true) === true);
  check("visible, idle or locked: not seen (nobody at the desk)", seenHere(true, false) === false);
  check("visible, no bridge: seen", seenHere(true, undefined) === true);
  check("hidden, in use: seen (the desktop app shows it)", seenHere(false, true) === true);
  check("hidden, idle or locked: not seen", seenHere(false, false) === false);
  check("hidden, no bridge: not seen", seenHere(false, undefined) === false);
}

console.log("\nthe bridge");
{
  check("no window (and so no bridge): null", desktop === null);
  const w = globalThis as { window?: unknown };
  w.window = { jarvisDesktop: { version: 2 } };
  const v2 = (await import("../src/app/desktop.ts?v2")) as typeof import("../src/app/desktop.ts");
  check("another version: not taken", v2.desktop === null);
  const bridge = { version: 1, passkeys: false };
  w.window = { jarvisDesktop: bridge };
  const v1 = (await import("../src/app/desktop.ts?v1")) as typeof import("../src/app/desktop.ts");
  check("version 1: taken", v1.desktop === bridge);
  delete w.window;
}

console.log("\nlinking a Mac: its name");
{
  const { uniqueName } = await import("../src/app/computerLink.ts");
  check("a name nobody has: kept", uniqueName("Mac mini", ["Office iMac"]) === "Mac mini");
  check("one they have: numbered", uniqueName("Mac mini", ["mac mini"]) === "Mac mini 2");
  check("numbered past those taken", uniqueName("Mac mini", ["Mac mini", "Mac mini 2", "Mac mini 3"]) === "Mac mini 4");
  check("spaces tidied, and none at all: Mac", uniqueName("  Mac   mini ", []) === "Mac mini" && uniqueName("   ", []) === "Mac");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
