// What typed chat shows while Jarvis works (src/app/steps.ts): a pill per tool
// call, in words rather than the tool's name, and a tool's own notes made fit
// to read.
import { doing, said } from "../src/app/steps.ts";
import { askOf, askSaid, beside, cameOf, ended, heard, linesOf, nowDoing, powers, progress, sizeSaid, type JobView } from "../src/app/jobWords.ts";

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
  check("one that makes files says so, and where", /no network, and gives them to you to save/.test(powers({ ...j, mode: "files" })) && !/no network/.test(powers(j)));
  check("what it is doing in the workshop, in words", nowDoing({ ...j, doing: ["run", "give_file"] }) === "Running a program, Giving you a file", nowDoing({ ...j, doing: ["run", "give_file"] }));
  check("a file's size, as a person says it", [143, 1500, 999_999, 2_340_000].map(sizeSaid).join() === "143 bytes,2 KB,1000 KB,2.3 MB", [143, 1500, 999_999, 2_340_000].map(sizeSaid));
  check("how what it ran ended", [ended({ at: 1, cmd: "x", code: 0, ms: 20 }), ended({ at: 1, cmd: "x", code: 0, ms: 1234 }), ended({ at: 1, cmd: "x", code: 3, ms: 90_000 }), ended({ at: 1, cmd: "x", code: "SIGKILL", ms: 5 }), ended({ at: 1, cmd: "x", code: null, late: true, ms: 120_000 }), ended({ at: 1, cmd: "x" })].join("|") ===
    "done|1.2 s|failed (3), 2 min|failed (SIGKILL)|stopped, out of time after 2 min|left running");
  check("a result beside its files does not name them twice", beside({ text: "Made.\n\nIn Jobs to download: a.csv", made: [1] }) === "Made." && beside({ text: "Made.\n\nIn Jobs to download: a.csv" }).endsWith("a.csv") && beside({ text: "Made.", made: [1] }) === "Made.");
  check("on their own things, and on the stronger model", /Does not search the web/.test(powers({ ...j, reach: "private" })) && /stronger model/.test(powers({ ...j, mode: "thorough" })));
  check("waiting for its person's answer, and not the plan", nowDoing({ ...j, doing: ["recall"], waiting: { for: "you", until: 1 } }) === "Waiting for your answer");
  const told = (taken: boolean) => [{ at: 1, text: "Only ones sold here", ...(taken ? { taken: true as const } : {}) }];
  const said = (x: Partial<JobView>) => heard({ ...j, ...x }).map((h) => `${h.said} / ${h.state}`).join("|");
  check("what it was told, and whether that has reached it", said({}) === "" && said({ told: told(false) }) === "You said: Only ones sold here / reaches it at its next step" && said({ told: told(true) }) === "You said: Only ones sold here / taken in", said({ told: told(false) }));
  check("…or came too late", /came too late$/.test(said({ told: told(false), wrapping: "x" })) && /came too late$/.test(said({ told: told(false), status: "done" })));
  check("an answer and a changed card as what they are, the fence of a struck line not shown, the last three",
    said({ told: [...told(true), { at: 2, text: "Front only", to: "question 1" }, { at: 3, text: "--- struck out:ab12 (CONTENT …", card: true }, { at: 5, text: "And soon" }] }) ===
      "Your answer: Front only / reaches it at its next step|You changed its card / reaches it at its next step|You said: And soon / reaches it at its next step", said({}));
  const q = { id: "q1", at: 1, text: "Front only?", choices: ["Yes", "No"] };
  check("what came of a question: nothing yet, an answer, gone on without, a day gone by, its job over", cameOf(q, j) === null && cameOf({ ...q, answer: { at: 2, text: "Yes" } }, j) === "You answered: Yes" && /chose to go on/.test(cameOf({ ...q, over: "skipped" }, j)!) && /No answer came/.test(cameOf({ ...q, over: "late" }, { status: "done" })!) && /ended before/.test(cameOf(q, { status: "cancelled" })!));
  const had = (taken: boolean) => cameOf({ ...q, answer: { at: 2, text: "Yes" } }, { status: "done", told: [{ at: 2, text: "Yes", to: "question 1", ...(taken ? { taken: true as const } : {}) }] });
  check("an answer it ended before it had is said to be so", had(true) === "You answered: Yes" && /^You answered: Yes \(too late/.test(had(false)!));
  check("a question's alert, apart: its words and its choices", JSON.stringify(askOf("Front only?\n\n- Yes\n- No, both")) === '{"question":"Front only?","choices":["Yes","No, both"]}' && JSON.stringify(askOf("How much?")) === '{"question":"How much?","choices":[]}');
  check("…and aloud: whose question it is first", askSaid("A question: Dashcams", "Front only?\n\n- Yes\n- No") === "Your background job asks, about Dashcams. Front only? Yes, No.", askSaid("A question: Dashcams", "Front only?\n\n- Yes\n- No"));
  check("a list typed a line each", JSON.stringify(linesOf(" a \n\n b")) === '["a","b"]');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
