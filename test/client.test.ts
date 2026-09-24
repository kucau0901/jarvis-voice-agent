import { detectClient } from "../src/app/client.ts";
import { jarvisPrompt, isClientKind } from "../src/worker/lib/prompt.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 200) : "");
  }
}

console.log("detectClient — against what the real dashboard reports");
{
  /*
   * Measured from the car on 21 September 2026 (see src/app/client.ts). The
   * point of pinning it here: the previous detection keyed on touch points and
   * window width, and would have called this 773px-wide landscape touchscreen
   * a PHONE. The pointer pair is what actually separates them.
   */
  const TESLA = { pointerCoarse: false, anyPointerCoarse: true };
  const DESKTOP = { pointerCoarse: false, anyPointerCoarse: false };
  const PHONE = { pointerCoarse: true, anyPointerCoarse: true };

  check("the real Tesla reads as the car", detectClient(TESLA) === "car");
  check("a mouse-only computer reads as desktop", detectClient(DESKTOP) === "desktop");
  check("a phone reads as mobile", detectClient(PHONE) === "mobile");

  // A tablet is primary-coarse like a phone, which is the right answer for it.
  check("a tablet reads as mobile", detectClient({ pointerCoarse: true, anyPointerCoarse: true }) === "mobile");

  check("an explicit override beats every signal",
    detectClient({ ...DESKTOP, override: "car" }) === "car");
  check("a nonsense override is ignored",
    detectClient({ ...DESKTOP, override: "toaster" }) === "desktop");
  check("no override behaves as before", detectClient({ ...TESLA, override: null }) === "car");
}

console.log("\nthe prompt actually changes with it");
{
  const car = jarvisPrompt("car");
  const desk = jarvisPrompt("desktop");
  const phone = jarvisPrompt("mobile");
  const dev = jarvisPrompt("device");

  check("the car is told it is a car", /riding in the user's Tesla/.test(car));
  check("the desktop is not told it is driving", !/probably driving/.test(desk), desk.slice(0, 200));
  check("the car IS told the user is driving", /probably driving/.test(car));
  check("the desktop is allowed a little more room", /two or three sentences/i.test(desk));
  check("a screenless device is told there is no screen", /THERE IS NO SCREEN/.test(dev));
  check("and told not to mention one", /Never refer to a screen/.test(dev));
  check("the phone knows it is a phone", /on a phone|on their phone/i.test(phone));

  // The parts that are true wherever it runs must survive the split.
  for (const [name, p] of [["car", car], ["desktop", desk], ["mobile", phone], ["device", dev]] as const) {
    check(`${name}: keeps the butler manner`, /composed British butler/.test(p));
    check(`${name}: keeps the no-narrating-machinery rule`, /Never say which system you are contacting/.test(p));
    check(`${name}: keeps the honesty rule`, /Never invent a REASON/.test(p));
    check(`${name}: still says the house is "the house"`, /It is never the name of the software/.test(p));
    // Malaysians code-switch constantly; the model did this correctly by
    // instinct before it was asked to, and the rule is here so it stays that
    // way rather than drifting back to whichever language the prompt is in.
    check(`${name}: answers in the user's language`, /Answer in whatever language the user speaks/.test(p));
    check(`${name}: mixes languages back rather than correcting`, /Mix them back the same way/.test(p));
    // Jarvis once answered a staff-list question with a real-sounding name and
    // a phone number that existed nowhere: the backend had returned the right
    // six people and the voice layer embellished. Data is quoted, not
    // paraphrased, and that rule must survive in every variant.
    check(`${name}: will not reword backend facts`, /say it EXACTLY as it was given/.test(p));
    check(`${name}: will not invent a phone number`, /Never say a phone number, extension or email the backend did not send/.test(p));
    check(`${name}: will not claim a screen it did not use`, /NOTHING IS ON THE SCREEN UNLESS IT WAS PUT THERE/.test(p));
    // Asked "what memory do you have on me", the voice model answered by itself
    // that the user was "on Day 59 of a 90-day no-alcohol challenge" — nothing
    // anywhere said so. The prompt had told it "what you are shown about the
    // user is a summary", which is true of the backend and false of the voice
    // model: it is shown nothing. It recited a summary it did not have.
    check(`${name}: is not told it holds a summary of the user`, !/What you are shown about the user is a summary/.test(p));
    check(`${name}: is told it knows nothing about the user`, /You are shown nothing about the user/.test(p));
    check(`${name}: must delegate "what do you know about me"`, /"what do you know about me"[\s\S]{0,80}MUST be delegated/.test(p));
    check(`${name}: may not invent a personal detail`, /Never state a preference, a habit, a goal/.test(p));
  }

  check("default is the car", jarvisPrompt() === car);
}

console.log("\nisClientKind");
{
  check("accepts the four", ["car", "desktop", "mobile", "device"].every(isClientKind));
  check("rejects anything else", !isClientKind("toaster") && !isClientKind(null) && !isClientKind(7));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
