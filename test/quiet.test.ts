// When a Live session is quiet enough to close (src/app/quiet.ts): GPT-Live
// bills every open second, so it closes after 30 seconds in which nobody spoke,
// but not while Jarvis is still talking, and nothing keeps it open longer than
// two minutes after the driver last spoke or a request was answered.
import { closeIn, QUIET_MS, VOICE_TAIL_MS, WORKING_MS } from "../src/app/quiet.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 200) : ""); }
}

const S = 1000;
const at = (q: Partial<Parameters<typeof closeIn>[1]>) => ({ spokeAt: 0, saidAt: 0, heardAt: 0, doneAt: 0, working: false, ...q });

console.log("closeIn");

check("30 seconds of quiet, as asked", QUIET_MS === 30 * S && WORKING_MS === 120 * S, { QUIET_MS, WORKING_MS });
check("opened and never spoken to: closes 30 s after going live", closeIn(30 * S, at({})) === 0 && closeIn(29 * S, at({})) === S);
check("the driver speaking starts the count again", closeIn(40 * S, at({ spokeAt: 20 * S })) === 10 * S);

// The driver asks at 0 s; Jarvis's answer text arrives by 5 s; its voice plays until 25 s.
const answer = at({ spokeAt: 0, saidAt: 5 * S, heardAt: 25 * S });
check("not closed while Jarvis's voice is still playing", closeIn(30 * S, answer) === 25 * S, closeIn(30 * S, answer));
check("closed 30 s after Jarvis was last heard", closeIn(54 * S, answer) === S && closeIn(55 * S, answer) === 0, closeIn(54 * S, answer));
check("its words count even when its voice was not measured (page hidden)",
  closeIn(30 * S, at({ spokeAt: 0, saidAt: 20 * S })) === 20 * S);

// A request being worked on: its "still working on it" must not keep the meter running.
const working = at({ spokeAt: 0, saidAt: 100 * S, heardAt: 110 * S, working: true });
check("while Jarvis works, open until two minutes after the driver spoke",
  closeIn(60 * S, working) === 60 * S && closeIn(120 * S, working) === 0, closeIn(60 * S, working));
check("an answer after a long job: 30 s of quiet from then",
  closeIn(130 * S, at({ spokeAt: 0, saidAt: 125 * S, doneAt: 125 * S })) === 25 * S);
check("a long answer to a long job may run past two minutes from the question",
  closeIn(150 * S, at({ spokeAt: 0, doneAt: 110 * S, saidAt: 115 * S, heardAt: 140 * S })) === 20 * S);

// Alerts and family messages said into the session: the old limit still holds.
const alerts = at({ spokeAt: 0, saidAt: 105 * S, heardAt: 110 * S });
check("alerts said every 35 s do not keep it open past two minutes after the driver spoke",
  closeIn(110 * S, alerts) === 10 * S && closeIn(120 * S, alerts) === 0, closeIn(110 * S, alerts));

// A sound from Jarvis's side long after its last words is not its voice.
const hum = at({ spokeAt: 0, saidAt: 10 * S, heardAt: 500 * S });
check("a sound long after Jarvis's words does not hold the session open",
  closeIn(500 * S, hum) === 0 && closeIn(90 * S, hum) === (10 * S + VOICE_TAIL_MS + QUIET_MS) - 90 * S, closeIn(90 * S, hum));
check("never negative", closeIn(10_000 * S, answer) === 0 && closeIn(10_000 * S, working) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
