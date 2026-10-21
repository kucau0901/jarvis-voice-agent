// Pictures Jarvis makes when asked (tools/image.ts): what OpenAI is sent, what
// is kept and for whom (lib/images.ts), and what the screen fetches
// (routes/image.ts).
import { Images, IMAGE_ID, IMAGE_KEEP_MS, KEEP_IMAGES } from "../src/worker/lib/images.ts";
import { IMAGE_MODEL, IMAGES_A_DAY, makeImage } from "../src/worker/tools/image.ts";
import { handleImage } from "../src/worker/routes/image.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";

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
    m,
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T])),
  };
}

const T0 = Date.UTC(2026, 9, 21, 2);

console.log("kept, each person's own");
{
  const s = fakeStorage();
  const images = new Images(s);
  const id = await images.put("u_sara", { mime: "image/jpeg", data: "/9j/AAAA", prompt: "a red car" }, T0);
  check("an id of its own kind", IMAGE_ID.test(id), id);
  const got = await images.get("u_sara", id, T0);
  check("theirs, as it was made", got?.mime === "image/jpeg" && got.data === "/9j/AAAA" && got.prompt === "a red car" && got.who === "u_sara", got);
  check("nobody else's", (await images.get("owner", id, T0)) === null);
  check("gone after as long as the conversation is kept", (await images.get("u_sara", id, T0 + IMAGE_KEEP_MS + 1)) === null);
  const ids = [id];
  for (let i = 1; i <= KEEP_IMAGES; i++) ids.push(await images.put("u_sara", { mime: "image/jpeg", data: "x", prompt: `p${i}` }, T0 + i));
  check(`the newest ${KEEP_IMAGES} kept, the oldest gone from storage too`, !s.m.has(`img:${ids[0]}`) && (await images.get("u_sara", ids[0]!, T0)) === null && s.m.has(`img:${ids.at(-1)}`), [...s.m.keys()].length);
  const owners = await images.put("owner", { mime: "image/jpeg", data: "y", prompt: "q" }, T0);
  await images.clear("u_sara");
  check("cleared: none of theirs left, another person's kept",
    ![...s.m.keys()].some((k) => k === "images:u_sara" || ids.slice(1).some((x) => k === `img:${x}`)) && (await images.get("owner", owners, T0))?.data === "y", [...s.m.keys()]);
}

console.log("\nmake_image");
const realFetch = globalThis.fetch;
{
  const calls: Record<string, unknown[]> = {};
  let allowed = true;
  const stub = new Proxy({}, {
    get: (_t, m) =>
      m === "then"
        ? undefined
        : async (...args: unknown[]) => {
            (calls[String(m)] ??= []).push(args);
            if (m === "consume") return { ok: allowed, n: 1 };
            if (m === "imagePut") return "iabcdefghj";
            return undefined;
          },
  });
  const env = { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://openai.example/v1", JARVIS_PERSON: "u_sara", TIMEZONE: "Asia/Kuala_Lumpur", STATE: { idFromName: () => "j", get: () => stub } };
  const shown: Record<string, unknown>[] = [];
  const ctx = { env, signal: new AbortController().signal, progress() {}, display: (x: Record<string, unknown>) => void shown.push(x), grants: ["*"] } as never;
  const sent: { url: string; init: RequestInit }[] = [];
  let reply: () => Response = () => Response.json({ data: [{ b64_json: "/9j/AAAA" }], usage: { input_tokens: 12, output_tokens: 1000 } });
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => (sent.push({ url: String(url), init }), reply())) as typeof fetch;
  try {
    check("offered only with the OpenAI key: the ChatGPT plan has no images", !makeImage.available!({} as never) && makeImage.available!(env as never) && makeImage.scope === "screen");
    const said = String(await makeImage.run({ prompt: "A red car on a beach", shape: "wide" }, ctx));
    const body = JSON.parse(String(sent[0]?.init.body)) as Record<string, unknown>;
    check("asked of OpenAI's images, on the key", sent[0]?.url === "https://openai.example/v1/images/generations" && new Headers(sent[0]!.init.headers).get("authorization") === "Bearer sk-test", sent[0]?.url);
    check("…a JPEG, as wide as asked", body.model === IMAGE_MODEL && body.output_format === "jpeg" && body.n === 1 && body.size === "1536x1024" && body.prompt === "A red car on a beach", body);
    const put = calls.imagePut?.[0] as [string, Record<string, unknown>, number] | undefined;
    check("kept as theirs", put?.[0] === "u_sara" && put[1].mime === "image/jpeg" && put[1].data === "/9j/AAAA" && put[1].prompt === "A red car on a beach", put);
    check("put on the screen by its id, never its bytes", shown[0]?.kind === "image" && shown[0].image === "iabcdefghj" && !JSON.stringify(shown).includes("/9j/"), shown);
    const usage = (calls.recordUsage?.[0] as [Record<string, unknown>] | undefined)?.[0];
    check("counted in Usage as a picture, not a question", usage?.surface === "image" && usage.by === IMAGE_MODEL && usage.output === 1000 && usage.who === "u_sara", usage);
    check("the model is told it is shown, not shown it", said.startsWith("The picture is on the screen") && !said.includes("/9j/"), said);
    check(`at most ${IMAGES_A_DAY} a day each`, (calls.consume?.[0] as unknown[])?.[0] === "img:u_sara" && (calls.consume?.[0] as unknown[])?.[1] === IMAGES_A_DAY, calls.consume);

    sent.length = 0;
    shown.length = 0;
    allowed = false;
    const capped = String(await makeImage.run({ prompt: "Another", shape: null }, ctx));
    check("past the day's pictures: OpenAI not asked, nothing shown", sent.length === 0 && shown.length === 0 && capped.includes(`${IMAGES_A_DAY} pictures for today`), capped);
    allowed = true;
    calls.imagePut = [];
    reply = () => Response.json({ error: { message: "Your request was rejected by the safety system", code: "moderation_blocked" } }, { status: 400 });
    const refused = String(await makeImage.run({ prompt: "Something refused", shape: null }, ctx));
    check("refused by OpenAI: said as it is, nothing kept or shown", refused.includes("rejected by the safety system") && !calls.imagePut.length && !shown.length, refused);
    check("square unless asked", JSON.parse(String(sent.at(-1)?.init.body)).size === "1024x1024");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\nGET /api/image");
{
  const asked: unknown[][] = [];
  const stub = {
    imageGet: async (...args: unknown[]) => (asked.push(args), args[0] === "u_sara" && args[1] === "iabcdefghj" ? { who: "u_sara", at: T0, mime: "image/jpeg", data: btoa("JPEGBYTES"), prompt: "x" } : null),
  };
  const env = (person?: string) => ({ ...(person ? { JARVIS_PERSON: person } : {}), STATE: { idFromName: () => "j", get: () => stub } }) as never;
  const get = (id: string, person?: string, method = "GET") => handleImage(new Request(`https://j.test/api/image?id=${id}`, { method }), env(person));
  const ok = await get("iabcdefghj", "u_sara");
  check("their picture, as its bytes", ok.status === 200 && ok.headers.get("content-type") === "image/jpeg" && (await ok.text()) === "JPEGBYTES");
  check("looked up as the asker", asked[0]?.[0] === "u_sara", asked);
  check("someone else's: no such picture", (await get("iabcdefghj")).status === 404 && asked.at(-1)?.[0] === "owner");
  check("not an id: refused before looking", (await get("../etc")).status === 400 && asked.length === 2);
  check("read only", (await get("iabcdefghj", "u_sara", "DELETE")).status === 405);
  check("needs screen, as a map does", requiredScope("/api/image", "GET") === "screen");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
