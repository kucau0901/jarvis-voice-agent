// Hermes (tools/hermes.ts): each person's own memory there, and every line of its answer.
import { ask, sessionKey } from "../src/worker/tools/hermes.ts";

/** The key Hermes has always been asked with (tools/hermes.ts SESSION_KEY). */
const SESSION_KEY = "jarvis:tesla";

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

const base = { HERMES_BASE_URL: "https://hermes.example", HERMES_API_KEY: "test-hermes-key" };

console.log("whose memory Hermes keeps");
check("the first person keeps the key Hermes has always had", sessionKey(base as never) === SESSION_KEY && sessionKey({ ...base, JARVIS_PERSON: "owner" } as never) === SESSION_KEY);
check("anyone else has their own", sessionKey({ ...base, JARVIS_PERSON: "u_sara" } as never) === `${SESSION_KEY}:u_sara`);

/** Hermes streaming `frames` as given, split where they are split; the headers it was sent. */
function hermes(frames: string[]) {
  const sent: Record<string, string>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(Object.fromEntries(new Headers(init.headers).entries()));
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return sent;
}
const piece = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;

console.log("\nits answer, streamed");
const realFetch = globalThis.fetch;
try {
  hermes([`${piece("Hello")}\n`, `${piece(", world")}\n`, "data: [DONE]\n"]);
  check("lines ending in newlines", (await ask(base as never, "hi")) === "Hello, world");

  hermes([`${piece("Hello")}\n`, piece(", world")]);
  check("a last line with no newline is not dropped", (await ask(base as never, "hi")) === "Hello, world", await ask(base as never, "hi"));

  const whole = `${piece("Hello")}\n${piece(" there")}`;
  hermes([whole.slice(0, 20), whole.slice(20)]);
  check("a line split across reads is joined", (await ask(base as never, "hi")) === "Hello there", await ask(base as never, "hi"));

  const sent = hermes([`${piece("ok")}\n`]);
  await ask({ ...base, JARVIS_PERSON: "u_sara" } as never, "hi");
  check("asked as someone, it is their session", sent[0]?.["x-hermes-session-key"] === `${SESSION_KEY}:u_sara`, sent[0]);
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
