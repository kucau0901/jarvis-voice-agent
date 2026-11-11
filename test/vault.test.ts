// Sign-ins a person saved for the browser (lib/vault.ts): how they are
// sealed, what opens them, whose they are, and what is ever shown of them.
import { LOGINS_MAX, passwordOk, seal, siteOf, unseal, Vault } from "../src/worker/lib/vault.ts";
import { browserTools } from "../src/worker/tools/browser.ts";

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

function fakeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T>() => new Map<string, T>(),
    _m: m,
  };
}

const KEY = "OWNERKEY0TEST0001";
const HR = "https://hr.example.com";

console.log("the site a sign-in is for");
{
  check("an address: its origin, whatever page of it was given", siteOf("https://hr.example.com/portal/login.jsp?x=1") === HR);
  check("a bare name: https", siteOf("hr.example.com") === HR);
  check("a port and plain http are part of which site it is", siteOf("http://10.0.0.5:8080/app") === "http://10.0.0.5:8080" && siteOf("http://hr.example.com") !== HR);
  check("a look-alike is another site", siteOf("https://hr.example.com.evil.test") !== HR && siteOf("https://hr-example.com") !== HR);
  check("not the web, or not an address: none", siteOf("file:///etc/passwd") === "" && siteOf("javascript:alert(1)") === "" && siteOf("http://") === "");
}

console.log("\nsealed");
{
  const a = await seal(KEY, "owner", HR, "s3cret-Pa55");
  const b = await seal(KEY, "owner", HR, "s3cret-Pa55");
  check("what is stored does not hold the password", !a.includes("s3cret") && !atob(a).includes("s3cret-Pa55"));
  check("sealed twice, it is not the same twice", a !== b);
  check("it opens for the same owner key, person and site", (await unseal(KEY, "owner", HR, a)) === "s3cret-Pa55");
  check("not under another owner key", (await unseal("ANOTHERKEY0000001", "owner", HR, a)) === null);
  check("not as another person's", (await unseal(KEY, "u_sara", HR, a)) === null);
  check("not for another site, however alike", (await unseal(KEY, "owner", "https://hr.example.com.evil.test", a)) === null && (await unseal(KEY, "owner", "http://hr.example.com", a)) === null);
  const bytes = Uint8Array.from(atob(a), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 1;
  check("nor once it has been changed", (await unseal(KEY, "owner", HR, btoa(String.fromCharCode(...bytes)))) === null);
  check("nonsense: no, not an error", (await unseal(KEY, "owner", HR, "not base64 !!")) === null && (await unseal(KEY, "owner", HR, "")) === null);
  check("an emoji and other alphabets come back whole", (await unseal(KEY, "owner", HR, await seal(KEY, "owner", HR, "pä55🔑كلمة"))) === "pä55🔑كلمة");
  check("what may be saved as a password", passwordOk("x") && !passwordOk("") && !passwordOk("x".repeat(501)) && !passwordOk(5) && !passwordOk(null));
}

console.log("\nkept");
{
  const storage = fakeStorage();
  const vault = new Vault(storage);
  const sealed = await seal(KEY, "owner", HR, "s3cret-Pa55");
  const kept = await vault.save("owner", { origin: HR, user: " staff01 ", sealed }, 1000);
  check("saved: its site, its name trimmed, when", typeof kept !== "string" && kept.origin === HR && kept.user === "staff01" && kept.at === 1000, kept);
  check("what the app is shown has no password, sealed or not", !JSON.stringify(await vault.list("owner")).includes("sealed") && !JSON.stringify(kept).includes(sealed));
  check("what the signing-in code is given has it sealed", (await vault.all("owner"))[0]?.sealed === sealed);
  check("it is that person's alone", (await vault.list("u_sara")).length === 0 && (await vault.all("u_sara")).length === 0);
  const again = await vault.save("owner", { origin: HR, user: "staff01", sealed: await seal(KEY, "owner", HR, "new-one") }, 2000);
  check("the same name on the same site: replaced, not doubled", typeof again !== "string" && (await vault.list("owner")).length === 1 && (await unseal(KEY, "owner", HR, (await vault.all("owner"))[0]!.sealed)) === "new-one");
  await vault.save("owner", { origin: HR, user: "admin02", sealed }, 3000);
  await vault.save("owner", { origin: "https://shop.example", user: "staff01", sealed: await seal(KEY, "owner", "https://shop.example", "other") }, 4000);
  check("another name, another site: kept beside it", (await vault.list("owner")).length === 3);
  for (const [name, bad] of [
    ["a page's address rather than a site", { origin: `${HR}/login`, user: "a", sealed }],
    ["no site", { origin: "", user: "a", sealed }],
    ["not the web", { origin: "file://", user: "a", sealed }],
    ["no login name", { origin: HR, user: "  ", sealed }],
    ["no password", { origin: HR, user: "a", sealed: "" }],
  ] as const) {
    check(`not ${name}`, typeof (await vault.save("owner", bad)) === "string");
  }
  const one = (await vault.list("owner")).find((l) => l.user === "admin02")!;
  check("removed by its id, and only it", (await vault.remove("owner", one.id)) && (await vault.list("owner")).length === 2 && !(await vault.remove("owner", one.id)) && !(await vault.remove("u_sara", (await vault.list("owner"))[0]!.id)));
  await vault.save("u_sara", { origin: HR, user: "sara", sealed: await seal(KEY, "u_sara", HR, "hers") });
  await vault.forget("owner");
  check("someone who leaves: theirs go, nobody else's", (await vault.list("owner")).length === 0 && (await vault.list("u_sara")).length === 1 && !storage._m.has("vault:owner"));
  const full = new Vault(fakeStorage());
  for (let i = 0; i < LOGINS_MAX; i++) await full.save("owner", { origin: HR, user: `u${i}`, sealed });
  check(`no more than ${LOGINS_MAX} each`, typeof (await full.save("owner", { origin: HR, user: "one-more", sealed })) === "string" && typeof (await full.save("owner", { origin: HR, user: "u3", sealed })) !== "string");
}

console.log("\nused by the tool");
{
  const tool = browserTools.find((t) => t.name === "browser_sign_in")!;
  const p = tool.parameters as { properties: Record<string, unknown>; required: string[] };
  check("the tool takes no password and no site: only which saved name", Object.keys(p.properties).join() === "login" && p.required.join() === "login");
  check("and no job is ever handed it", !tool.propose && tool.scope === "browser");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
