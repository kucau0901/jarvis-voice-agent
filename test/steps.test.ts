// What typed chat shows while Jarvis works (src/app/steps.ts): a pill per tool
// call, in words rather than the tool's name, and a tool's own notes made fit
// to read.
import { doing, said } from "../src/app/steps.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 200) : ""); }
}

console.log("doing");
check("a tool, in words", doing("calendar_check") === "Checking your calendar" && doing("car_state") === "Checking the car", [doing("calendar_check"), doing("car_state")]);
check("another server's tool does not show its label: its own note follows", doing("home-assistant__ha_get_state") === "Checking");
check("a tool it does not know", doing("something_new") === "Working");
check("the web search, after the fact", doing("web_search") === "Searched the web");

console.log("said");
check("a note, capitalised", said("checking Home") === "Checking Home", said("checking Home"));
check("the voice's advice after a semicolon is not for reading",
  said("home is still thinking; say the user can ask you to drop it") === "Home is still thinking", said("home is still thinking; say the user can ask you to drop it"));
check("no trailing dots", said("waking the car…") === "Waking the car" && said("still working on that.") === "Still working on that");
check("nothing to say stays nothing", said("  ") === "" && said("; just advice") === "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
