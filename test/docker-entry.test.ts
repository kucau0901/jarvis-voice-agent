import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 260) : "");
  }
}

// What the container starts with (docker/entrypoint.sh), against the wrangler the lockfile pins. That they are
// really off, in the running image, is checked in CI (.github/workflows/ci.yml).
const entry = readFileSync("docker/entrypoint.sh", "utf8");
const cli = readFileSync("node_modules/wrangler/wrangler-dist/cli.js", "utf8");

console.log("the runtime's developer helpers are off in the container");
for (const name of ["X_LOCAL_EXPLORER", "X_LOCAL_OBSERVABILITY"]) {
  check(`${name}=false, before it starts`, new RegExp(`^export [^\\n]*\\b${name}=false\\b`, "m").test(entry) && entry.indexOf(`${name}=false`) < entry.indexOf("exec wrangler dev"));
  // Gone, or renamed: look at what the new wrangler has on by default before letting it through.
  check(`…which the installed wrangler still reads by that name`, cli.includes(`variableName: "${name}"`));
}
check("the traces kept before are removed, and nothing beside them", /^rm -rf "\$\{DATA_DIR:-\/data\}\/v3\/observability"$/m.test(entry) && entry.split("rm -rf").length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
