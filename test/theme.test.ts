// Light or dark on a screen (src/app/theme.ts): Auto, the default, follows the
// screen's clock rather than the system, because the car's browser can report a
// light system theme at night.
import { asThemeChoice, DAY_STARTS, NIGHT_STARTS, resolveTheme, THEMES } from "../src/app/theme.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 200) : ""); }
}

console.log("resolveTheme");

check("Dark and Light hold whatever the hour and the system say",
  [0, 12, 23].every((h) => resolveTheme("dark", h, false) === "dark" && resolveTheme("light", h, true) === "light"));
check("System follows the system, not the clock",
  resolveTheme("system", 12, true) === "dark" && resolveTheme("system", 2, false) === "light");
check("Auto's day is 07:00 to 19:00", DAY_STARTS === 7 && NIGHT_STARTS === 19, { DAY_STARTS, NIGHT_STARTS });
const auto = (h: number) => resolveTheme("auto", h, true);
check("Auto: dark before 07:00, light from 07:00", auto(6) === "dark" && auto(7) === "light", [auto(6), auto(7)]);
check("Auto: light until 19:00, dark from then", auto(18) === "light" && auto(19) === "dark", [auto(18), auto(19)]);
check("Auto: dark around midnight", auto(0) === "dark" && auto(23) === "dark");
check("Auto ignores the system setting", resolveTheme("auto", 12, true) === "light" && resolveTheme("auto", 22, false) === "dark");

console.log("asThemeChoice");

check("anything not a choice is Auto", [null, undefined, "", "blue", "Dark"].every((v) => asThemeChoice(v) === "auto"));
check("each choice survives a round trip", THEMES.every((c) => asThemeChoice(c) === c));
check("offered in the picker's order", THEMES.join() === "auto,system,dark,light", THEMES);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
