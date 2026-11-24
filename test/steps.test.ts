// What typed chat shows while Jarvis works (src/app/steps.ts): a pill per tool
// call, in words rather than the tool's name, and a tool's own notes made fit
// to read.
import { doing, said } from "../src/app/steps.ts";
import { heard, linesOf, nowDoing, powers, progress, type JobView } from "../src/app/jobWords.ts";

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

console.log("a job at work");
{
  const j: JobView = { id: "j1", title: "x", task: "x", engine: "jarvis", status: "running", createdAt: 0, steps: 3, reach: "web", limits: { steps: 25, going: 60, minutes: 60 } };
  check("thinking, with nothing running", nowDoing(j) === "Thinking");
  check("what runs, in words, once each", nowDoing({ ...j, doing: ["mail_search", "web_search", "web_search", "school__timetable"] }) === "Searching your mail, Searching the web, Checking", nowDoing({ ...j, doing: ["mail_search", "web_search", "web_search", "school__timetable"] }));
  check("waiting, or writing what it has, before either", nowDoing({ ...j, doing: ["recall"], waiting: { for: "plan", until: 1 } }) === "Waiting for the ChatGPT plan" && nowDoing({ ...j, doing: ["recall"], wrapping: "it took its 25 steps" }) === "Writing what it has: it took its 25 steps");
  check("how far: done of those not dropped", progress(j) === null && progress({ ...j, todo: [{ text: "a", state: "done" }, { text: "b", state: "doing" }, { text: "c", state: "dropped", why: "x" }] }) === "1 of 2");
  check("what it may do is said by code, from what it was handed", /^Searches the web, and has nothing of yours/.test(powers(j)) && /Never acts/.test(powers(j)) && /60 minutes and 25 steps, 60 while/.test(powers(j)) && !/stronger/.test(powers(j)), powers(j));
  check("on their own things, and on the stronger model", /Does not search the web/.test(powers({ ...j, reach: "private" })) && /stronger model/.test(powers({ ...j, mode: "thorough" })));
  const told = (taken: boolean) => [{ at: 1, text: "x", ...(taken ? { taken: true as const } : {}) }];
  check("whether a change has reached it", heard(j) === null && /next step/.test(heard({ ...j, told: told(false) })!) && /taken in/.test(heard({ ...j, told: told(true) })!));
  check("…or came too late", /too late/.test(heard({ ...j, told: told(false), wrapping: "x" })!) && /too late/.test(heard({ ...j, told: told(false), status: "done" })!));
  check("a list typed a line each", JSON.stringify(linesOf(" a \n\n b")) === '["a","b"]');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
