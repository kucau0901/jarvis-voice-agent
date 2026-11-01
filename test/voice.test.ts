import {
  DEFAULT_STYLE,
  FORMAT_MIME,
  MAX_SPEAK_CHARS,
  audioExtension,
  speakable,
  speechChunks,
  recognitionHints,
  speechConfig,
  synthesize,
  transcribe,
} from "../src/worker/lib/speech.ts";
import { jarvisPrompt, spokenReplyInstructions } from "../src/worker/lib/prompt.ts";
import { requiredScope } from "../src/worker/lib/scopes.ts";
import { handleVoice } from "../src/worker/routes/voice.ts";
import { handleDelegate } from "../src/worker/routes/delegate.ts";
import { OVERHEARD_TEXT } from "../src/worker/lib/glasses.ts";
import { validateChanges } from "../src/worker/lib/settings.ts";

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

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let answer: (url: string) => Response = () => Response.json({ text: "hello" });
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  calls.push({ url: String(input), init });
  return answer(String(input));
}) as typeof fetch;

const env = (e: Record<string, unknown> = {}) => ({ OPENAI_API_KEY: "sk-test", ...e }) as never;
const audio = new Uint8Array([1, 2, 3, 4]).buffer;

console.log("configuration");
{
  const c = speechConfig(env());
  check("OpenAI both ways by default, GPT-Live's cedar voice", c.stt === "openai" && c.tts === "openai" && c.voice === "cedar");
  check("the butler's direction by default", c.style === DEFAULT_STYLE);
  check("language from the settings", speechConfig(env({ LOCALE: "ms", COUNTRY: "MY" })).language === "ms-MY");
  check("unknown values fall back", speechConfig(env({ VOICE_STT: "carrier-pigeon", VOICE_TTS_VOICE: "hal9000" })).stt === "openai");
  check("Workers AI is reported only when bound", !c.workersAi && speechConfig(env({ AI: { run: async () => ({}) } })).workersAi);
  const planOnly = speechConfig(env({ OPENAI_API_KEY: undefined, AI: { run: async () => ({}) } }));
  check("with no key (the ChatGPT plan has no speech), Workers AI both ways", planOnly.stt === "workers-ai" && planOnly.tts === "workers-ai", planOnly);
  check("…unless another was chosen", speechConfig(env({ OPENAI_API_KEY: undefined, AI: { run: async () => ({}) }, VOICE_STT: "browser" })).stt === "browser");
  check("with no key and no Workers AI, still OpenAI, which says what is missing", speechConfig(env({ OPENAI_API_KEY: undefined })).stt === "openai");
  check("the panel refuses an unknown provider", !validateChanges({ VOICE_STT: "siri" }).ok);
  check("…and accepts a known one", validateChanges({ VOICE_TTS: "browser", VOICE_TTS_VOICE: "marin" }).ok);
}

console.log("\nrecognition hints");
{
  const doc = {
    rev: 1,
    trash: [],
    facts: [
      { id: "1", text: "Home is 1 Jalan X", kind: "place", slug: "home", keys: [], createdAt: 1, updatedAt: 1, useCount: 0, source: "voice" },
      { id: "2", text: "Ayesha is my sister", kind: "person", slug: "Ayesha", keys: [], createdAt: 1, updatedAt: 1, useCount: 0, source: "voice" },
      { id: "3", text: "Likes it warm", kind: "preference", keys: [], createdAt: 1, updatedAt: 1, useCount: 0, source: "voice" },
    ],
  } as never;
  const h = recognitionHints(doc);
  check("people and places, and Jarvis itself", h === "Names that may come up: Jarvis, home, Ayesha.", h);
  check("nothing saved: still Jarvis", recognitionHints(null) === "Names that may come up: Jarvis.");
}

console.log("\nrecordings accepted");
{
  for (const [m, e] of [["audio/webm;codecs=opus", "webm"], ["audio/mp4", "m4a"], ["audio/wav", "wav"], ["audio/mpeg", "mp3"], ["audio/ogg", "ogg"]]) {
    check(`${m} → .${e}`, audioExtension(m!) === e);
  }
  check("not audio: refused", audioExtension("application/pdf") === null && audioExtension("text/html") === null);
}

console.log("\nhearing, with OpenAI");
{
  calls = [];
  answer = () => Response.json({ text: " Where is my office? " });
  const h = await transcribe(env(), audio, "audio/webm;codecs=opus", "Names that may come up: Jarvis, Ayesha.");
  check("heard, trimmed", h.ok && h.text === "Where is my office?" && h.by === "openai", h);
  const form = calls[0]!.init.body as FormData;
  check("the mini transcription model", form.get("model") === "gpt-4o-mini-transcribe");
  check("with the names as a prompt", form.get("prompt") === "Names that may come up: Jarvis, Ayesha.");
  const file = form.get("file") as File;
  check("a file with the right extension and type", file.name === "speech.webm" && file.type === "audio/webm", [file.name, file.type]);
  answer = () => new Response("quota", { status: 429 });
  const bad = await transcribe(env(), audio, "audio/webm", "");
  check("a refusal is reported, not thrown", !bad.ok && /429/.test(bad.error));
  check("no key: says so", !(await transcribe(env({ OPENAI_API_KEY: "" }), audio, "audio/webm", "")).ok);
  check("not audio: refused before any call", !(await transcribe(env(), audio, "text/plain", "")).ok);
}

console.log("\nhearing, with Workers AI");
{
  calls = [];
  const runs: { model: string; input: Record<string, unknown> }[] = [];
  const AI = { run: async (model: string, input: Record<string, unknown>) => (runs.push({ model, input }), { text: " hi there " }) };
  const h = await transcribe(env({ VOICE_STT: "workers-ai", AI }), audio, "audio/webm", "Names: Jarvis.");
  check("Whisper turbo, audio as base64, with the names", h.ok && h.by === "workers-ai" && runs[0]!.model === "@cf/openai/whisper-large-v3-turbo" && runs[0]!.input.audio === "AQIDBA==" && runs[0]!.input.initial_prompt === "Names: Jarvis.", runs[0]);
  check("OpenAI not called", calls.length === 0);
  const broken = { run: async () => { throw new Error("capacity"); } };
  answer = () => Response.json({ text: "fallback" });
  const f = await transcribe(env({ VOICE_STT: "workers-ai", AI: broken }), audio, "audio/webm", "");
  check("if it fails, OpenAI hears it instead", f.ok && f.by === "openai" && f.text === "fallback");
  const nb = await transcribe(env({ VOICE_STT: "workers-ai" }), audio, "audio/webm", "");
  check("not bound (Docker): OpenAI", nb.ok && nb.by === "openai");
}

console.log("\nspeaking, with OpenAI");
{
  calls = [];
  answer = () => new Response(new Uint8Array([9, 9, 9]));
  const s = await synthesize(env({ VOICE_TTS_VOICE: "marin", VOICE_STYLE: "Brisk." }), "Your office is on the High Street.", "wav");
  const body = JSON.parse(String(calls[0]!.init.body));
  check("gpt-4o-mini-tts, the chosen voice and direction", body.model === "gpt-4o-mini-tts" && body.voice === "marin" && body.instructions === "Brisk.", body);
  check("the requested format", body.response_format === "wav" && s.ok && s.mime === FORMAT_MIME.wav && s.audio.byteLength === 3);
  calls = [];
  await synthesize(env(), "x".repeat(5000));
  check("an essay is cut to length", JSON.parse(String(calls[0]!.init.body)).input.length === MAX_SPEAK_CHARS);
  check("PCM for microcontrollers is 24 kHz mono", FORMAT_MIME.pcm === "audio/L16;rate=24000;channels=1");
}

console.log("\nspeaking, with Workers AI");
{
  calls = [];
  const runs: { model: string; input: Record<string, unknown> }[] = [];
  const AI = { run: async (model: string, input: Record<string, unknown>) => (runs.push({ model, input }), { audio: "AQID" }) };
  const s = await synthesize(env({ VOICE_TTS: "workers-ai", AI }), "Hello.");
  check("English: Deepgram Aura 2", s.ok && s.by === "workers-ai" && runs[0]!.model === "@cf/deepgram/aura-2-en" && runs[0]!.input.text === "Hello." && s.audio.byteLength === 3, runs[0]);
  runs.length = 0;
  const fr = await synthesize(env({ VOICE_TTS: "workers-ai", AI, LOCALE: "fr" }), "Bonjour.");
  check("French: MeloTTS", fr.ok && fr.by === "workers-ai" && runs[0]!.model === "@cf/myshell-ai/melotts" && runs[0]!.input.lang === "fr");
  runs.length = 0;
  answer = () => new Response(new Uint8Array([1]));
  const ms = await synthesize(env({ VOICE_TTS: "workers-ai", AI, LOCALE: "ms" }), "Selamat pagi.");
  check("Malay is not MeloTTS's: OpenAI speaks it", ms.ok && ms.by === "openai" && runs.length === 0);
  const bytesAI = { run: async () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([7, 7, 7, 7])); c.close(); } }) };
  const raw = await synthesize(env({ VOICE_TTS: "workers-ai", AI: bytesAI }), "Hello.");
  check("…or MP3 bytes as a stream, taken as they come", raw.ok && raw.by === "workers-ai" && raw.audio.byteLength === 4);
  const wav = await synthesize(env({ VOICE_TTS: "workers-ai", AI }), "Hello.", "wav");
  check("MeloTTS gives mp3 only; wav goes to OpenAI", wav.ok && wav.by === "openai");
}

console.log("\nwhat is actually said");
{
  const cited = "Check the tyres and lights before you go. ([nhtsa.gov](https://www.nhtsa.gov/summer-driving-tips?utm_source=openai))";
  check("a web citation is not read out", speakable(cited) === "Check the tyres and lights before you go.", speakable(cited));
  check("a link keeps its words", speakable("See [the charger map](https://x.example/map) for more.") === "See the charger map for more.");
  const table = speakable("Compared:\n\n| Speaker | Price |\n|---|---:|\n| Mi A | RM99 |\n| Mi B | RM149 |\n\nThe **Mi A** is cheaper.");
  check("a table is read as its rows, not its bars", table === "Compared: Speaker, Price. Mi A, RM99. Mi B, RM149. The Mi A is cheaper.", table);
  check("…and a dash in a sentence is left alone", speakable("It is 3 - 2 now.") === "It is 3 - 2 now.");
  check("a bare address goes", speakable("It is at https://example.com/a?b=c today.") === "It is at today.");
  check("markdown is dropped", speakable("**Yes** — the *gate* is `closed`.") === "Yes — the gate is closed.");
  check("bullets become plain lines", speakable("- tyres\n- lights\n1. brakes") === "tyres lights brakes");
  check("digits and decimals are left alone", speakable("94% and 3.5 km at 14:30.") === "94% and 3.5 km at 14:30.");
}

console.log("\nan answer spoken in pieces");
{
  const c = speechChunks("The car is at 94 percent. That is about 386 kilometres, enough for the week. Charging is off.");
  check("one piece a sentence", c.length === 3 && c[0] === "The car is at 94 percent.", c);
  const d = speechChunks("The office is 3.5 km away from here. Traffic is light.");
  check("a decimal stays whole", d.length === 2 && d[0] === "The office is 3.5 km away from here.", d);
  check("a short sentence rides with the next", speechChunks("Yes. The gate is closed and locked.").join("|") === "Yes. The gate is closed and locked.", speechChunks("Yes. The gate is closed and locked."));
  check("at most four pieces", speechChunks(Array.from({ length: 9 }, (_, i) => `This is sentence number ${i + 1} of nine.`).join(" ")).length === 4);
  check("nothing to split: one piece", speechChunks("No full stop at all").join() === "No full stop at all");
  check("Malay and mixed text too", speechChunks("Pintu pagar sudah ditutup. The porch light is off.").length === 2);
}

console.log("\nthe spoken reply");
{
  const s = spokenReplyInstructions();
  check("says it is read word for word", /word for word/.test(s));
  check("no markdown or URLs", /no markdown/.test(s) && /URLs/.test(s));
  check("in the language spoken, mixed as spoken", /mixing languages/.test(s));
  check("never in a tool's, a page's or its own earlier language", /never in the language of a tool result, a web page or your own earlier replies/.test(s));
  check("in Jarvis's manner", /composed British butler/.test(s));
  check("without the live voice's interruption rule", !/interrupted/.test(s));
  check("the GPT-Live prompt keeps it", /If you are interrupted, stop immediately/.test(jarvisPrompt("car")) && /VOICE AND MANNER\nSpeak like a composed British butler/.test(jarvisPrompt("car")));
}

console.log("\nwho may");
{
  check("/api/v1/voice needs voice", requiredScope("/api/v1/voice", "POST") === "voice");
  check("a lookalike path is the owner's", requiredScope("/api/v1/voicex", "POST") === "owner");
}

console.log("\ndictation: only heard (the chat box's mic)");
{
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  const owner = { kind: "owner" } as never;
  const dictate = (body: BodyInit, url = "https://j.test/api/v1/voice", headers?: HeadersInit) =>
    handleVoice(new Request(url, { method: "POST", body, ...(headers ? { headers } : {}) }), env(), ctx, owner, ["*"] as never);
  const form = () => {
    const f = new FormData();
    f.append("audio", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }), "dictation");
    f.append("options", JSON.stringify({ transcribe: true }));
    return f;
  };
  calls = [];
  answer = () => Response.json({ text: " Buy milk " });
  const r = await dictate(form());
  const b = (await r.json()) as Record<string, unknown>;
  check("the words come back, nothing else", r.status === 200 && b.ok === true && b.transcript === "Buy milk" && b.heardBy === "openai", b);
  check("…heard only: nothing asked, nothing spoken", calls.length === 1 && calls[0]!.url.endsWith("/audio/transcriptions"), calls.map((c) => c.url));
  calls = [];
  const raw = await dictate(new Uint8Array([1, 2, 3, 4]), "https://j.test/api/v1/voice?transcribe=1", { "content-type": "audio/webm" });
  check("a bare recording with ?transcribe=1 is only heard too", raw.status === 200 && ((await raw.json()) as { transcript?: string }).transcript === "Buy milk" && calls.length === 1);
  const words = new FormData();
  words.append("text", "hello");
  words.append("options", JSON.stringify({ transcribe: true }));
  check("nothing to hear is said so", (await dictate(words)).status === 400);
  answer = () => new Response("quota", { status: 429 });
  const failed = await dictate(form());
  check("hearing that fails says so, and does not throw", failed.status === 502 && typeof ((await failed.json()) as { error?: unknown }).error === "string");
  const noAsk = await handleVoice(new Request("https://j.test/api/v1/voice", { method: "POST", body: form() }), env(), ctx, owner, ["voice"] as never);
  check("still needs ask, as asking does", noAsk.status === 403);
  answer = () => Response.json({ text: "hello" });
}

console.log("\nan answer for a small display (chars)");
{
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
  const owner = { kind: "owner" } as never;
  const said =
    "**Tomorrow** in Kuala Lumpur: thunderstorms in the afternoon, 24 to 33 degrees. Take an umbrella if you go out after lunch, because the rain usually comes at about three.";
  answer = (url) =>
    url.endsWith("/responses")
      ? Response.json({ id: "r1", object: "response", status: "completed", output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: said, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } })
      : Response.json({});
  const ask = async (opts: Record<string, unknown>) => {
    calls = [];
    const r = await handleVoice(new Request("https://j.test/api/v1/voice", { method: "POST", body: JSON.stringify({ text: "weather tomorrow?", reply: "text", ...opts }) }), env(), ctx, owner, ["*"] as never);
    const told = calls.filter((c) => c.url.endsWith("/responses")).map((c) => String(c.init.body)).join("");
    return { body: (await r.json()) as { text: string }, told };
  };
  const small = await ask({ chars: 100 });
  check("the router is told it is read on glasses, and how much fits", /SHOWN ON SMART GLASSES/.test(small.told) && /under 100 characters/.test(small.told), small.told.slice(0, 200));
  check("…not that it is spoken", !/word for word/.test(small.told));
  check("the answer is plain text, cut at a sentence to fit", small.body.text === "Tomorrow in Kuala Lumpur: thunderstorms in the afternoon, 24 to 33 degrees.", small.body.text);
  const tiny = await ask({ chars: 5 });
  check("a budget too small to say anything is raised to the least", /under 80 characters/.test(tiny.told));
  const spoken = await ask({});
  check("without it, the answer is written to be spoken, whole", /word for word/.test(spoken.told) && !/SHOWN ON SMART GLASSES/.test(spoken.told) && spoken.body.text === said, spoken.body.text);
  check("…and it is not told the glasses hear everyone", !/HEAR WHATEVER IS SAID NEAR THE USER/.test(spoken.told) && /HEAR WHATEVER IS SAID NEAR THE USER/.test(small.told));
  // Heard on the glasses, but not said to Jarvis (lib/glasses.ts, issue #16): a fixed line, and no turn kept for it.
  const threaded: unknown[][] = [];
  const stub = new Proxy({}, { get: (_t, m) => (m === "then" ? undefined : async (...a: unknown[]) => (m === "loadThread" ? [] : m === "appendThread" ? void threaded.push(a) : undefined)) });
  const heard = async (text: string, chars: number | null = 100) => {
    answer = (url) =>
      url.endsWith("/responses")
        ? Response.json({ id: "r1", object: "response", status: "completed", output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], output_text: text, usage: { input_tokens: 1, output_tokens: 1 } })
        : Response.json({});
    threaded.length = 0;
    const r = await handleVoice(new Request("https://j.test/api/v1/voice", { method: "POST", body: JSON.stringify({ text: "never let me go tonight", reply: "text", thread: "g2", ...(chars ? { chars } : {}) }) }),
      env({ STATE: { idFromName: () => "j", get: () => stub } }), ctx, owner, ["*"] as never);
    return { text: ((await r.json()) as { text: string }).text, threaded: threaded.length };
  };
  const notMine = await heard("NOT_FOR_ME");
  check("on a small display, heard but not for Jarvis: the fixed line, no turn kept", notMine.text === OVERHEARD_TEXT && notMine.threaded === 0, notMine);
  const mine = await heard("Tonight is clear, 26 degrees.");
  check("…an answer is shown and kept as before", mine.text === "Tonight is clear, 26 degrees." && mine.threaded === 1, mine);
  const spokenWord = await heard("NOT_FOR_ME", null);
  check("spoken, with no small display, the same words are only an answer: whole, and kept", spokenWord.text === "NOT_FOR_ME" && spokenWord.threaded === 1, spokenWord);
  answer = () => Response.json({ text: "hello" });
}

// Glasses with no display, their microphone hearing everyone (RunOptions.openMic): the Ray-Bans' push-to-talk.
console.log("\nan open microphone, spoken (openMic)");
{
  const ctx = (later: Promise<unknown>[]) => ({ waitUntil: (w: Promise<unknown>) => void later.push(w), passThroughOnException() {} }) as never;
  const owner = { kind: "owner" } as never;
  // Hop by hop: a tool's name is a call to it, anything else the answer.
  const hops = (...said: string[]) => (url: string) => {
    if (!url.endsWith("/responses")) return Response.json({});
    const text = said.shift() ?? "";
    const output = text.startsWith("call:")
      ? [{ type: "function_call", id: "fc1", call_id: "c1", name: text.slice(5), arguments: JSON.stringify({ zone: "Asia/Tokyo" }), status: "completed" }]
      : [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
    return Response.json({ id: "r1", object: "response", status: "completed", output, output_text: text.startsWith("call:") ? "" : text, usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const kept = { threaded: 0, shared: 0, offered: 0, usage: [] as { ask?: string }[] };
  const stub = new Proxy({}, {
    get: (_t, m) => (m === "then" ? undefined : async (...a: unknown[]) => {
      if (m === "loadThread" || m === "recentShared") return [];
      if (m === "appendThread") return void kept.threaded++;
      if (m === "appendShared") return void kept.shared++;
      if (m === "recordUsage") return void kept.usage.push(a[0] as { ask?: string });
      if (m === "specialtyOffer") return void kept.offered++;
      return undefined;
    }),
  });
  const heard = async (body: Record<string, unknown>, accept = "application/json") => {
    calls = [];
    kept.threaded = 0;
    kept.shared = 0;
    kept.offered = 0;
    kept.usage = [];
    const later: Promise<unknown>[] = [];
    const r = await handleVoice(new Request("https://j.test/api/v1/voice", { method: "POST", headers: { accept }, body: JSON.stringify({ text: "call now, offer ends tonight", thread: "rb", origin: { id: "phone-1", label: "Phone" }, ...body }) }),
      env({ STATE: { idFromName: () => "j", get: () => stub } }), ctx(later), owner, ["*"] as never);
    const raw = await r.text();
    await Promise.all(later);
    const told = calls.filter((c) => c.url.endsWith("/responses")).map((c) => String(c.init.body)).join("");
    const spoken = calls.some((c) => c.url.includes("/audio/speech"));
    return { status: r.status, type: r.headers.get("content-type") ?? "", raw, told, spoken, ...kept, usage: [...kept.usage] };
  };
  answer = hops("NOT_FOR_ME");
  const notMine = await heard({ openMic: true, reply: "audio" });
  const body = JSON.parse(notMine.raw) as { text: string; notForMe?: boolean; audio?: unknown };
  check("told the microphone hears everyone, as the glasses are", /HEAR WHATEVER IS SAID NEAR THE USER/.test(notMine.told) && /exactly NOT_FOR_ME/.test(notMine.told));
  check("not for Jarvis: nothing said, and the reply says so", body.text === "" && body.notForMe === true && !body.audio && !notMine.spoken, body);
  check("…and nothing kept: not the thread, not the conversation shared between devices", notMine.threaded === 0 && notMine.shared === 0, notMine);
  check("…the call in Usage, without the words heard", notMine.usage.length === 1 && notMine.usage[0]!.ask === "(not for me)", notMine.usage);
  answer = hops("NOT_FOR_ME");
  const streamed = await heard({ openMic: true, reply: "audio" }, "text/event-stream");
  const events = streamed.raw.split("\n\n").filter((b) => b.includes("data:")).map((b) => JSON.parse(b.slice(b.indexOf("data:") + 5)) as { type: string; text?: string; notForMe?: boolean });
  const results = events.filter((e) => e.type === "result");
  check("streamed: one result saying so, empty, and no speech", results.length === 1 && results[0]!.text === "" && results[0]!.notForMe === true && !events.some((e) => e.type === "audio"), events.map((e) => e.type));
  answer = hops("NOT_FOR_ME");
  const asAudio = await heard({ openMic: true, reply: "audio" }, "audio/mpeg");
  check("asked for audio: there is none, so the words come back as JSON", asAudio.type.includes("json") && JSON.parse(asAudio.raw).notForMe === true, asAudio.type);
  answer = hops("The gate is closed.");
  const mine = await heard({ openMic: true, reply: "text", text: "is the gate closed?" });
  check("for Jarvis: answered and kept as before", JSON.parse(mine.raw).text === "The gate is closed." && !("notForMe" in JSON.parse(mine.raw)) && mine.threaded === 1 && mine.shared === 1 && mine.usage[0]!.ask === "is the gate closed?", mine);
  answer = hops("call:time_in", "NOT_FOR_ME");
  const acted = await heard({ openMic: true, reply: "text" });
  check("a tool ran before its word: the word never said, the exchange kept", JSON.parse(acted.raw).text === "" && !("notForMe" in JSON.parse(acted.raw)) && acted.threaded === 1, acted);
  answer = hops("NOT_FOR_ME");
  const closed = await heard({ reply: "text" });
  check("no open microphone: not told it, and the same words are only an answer", !/HEAR WHATEVER IS SAID/.test(closed.told) && JSON.parse(closed.raw).text === "NOT_FOR_ME" && closed.threaded === 1, closed.raw);
  // Two tools, then the word (against its rule): no offer to save steps goes after it, so it is never said.
  answer = hops("call:time_in", "call:hide_display", "NOT_FOR_ME");
  const twice = await heard({ openMic: true, reply: "audio" });
  check("two tools, then its word: no offer to save the steps after it, and nothing said", JSON.parse(twice.raw).text === "" && twice.offered === 0 && !twice.spoken, twice.raw);
  answer = hops("NOT_FOR_ME");
  const charsOnly = await heard({ chars: 200, reply: "text" });
  check("a small display alone: the fixed line, and the reply says so too", JSON.parse(charsOnly.raw).text === OVERHEARD_TEXT && JSON.parse(charsOnly.raw).notForMe === true && charsOnly.threaded === 0, charsOnly.raw);
  answer = hops("NOT_FOR_ME");
  const shown = await heard({ openMic: true, chars: 200, reply: "text" });
  check("on a small display, the fixed line, and the reply says so", JSON.parse(shown.raw).text === OVERHEARD_TEXT && JSON.parse(shown.raw).notForMe === true && shown.threaded === 0, shown.raw);
  answer = () => Response.json({ text: "hello" });
}

// A live voice on glasses hands a question to Jarvis (/api/v1/stream): with openMic the router judges again.
console.log("\na live voice's handoff from glasses (openMic)");
{
  const handoff = async (body: Record<string, unknown>, ...said: string[]) => {
    calls = [];
    answer = (url) => {
      if (!url.endsWith("/responses")) return Response.json({});
      const text = said.shift() ?? "";
      const output = text.startsWith("call:")
        ? [{ type: "function_call", id: "fc1", call_id: "c1", name: text.slice(5), arguments: JSON.stringify({ zone: "Asia/Tokyo" }), status: "completed" }]
        : [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
      return Response.json({ id: "r1", object: "response", status: "completed", output, output_text: text.startsWith("call:") ? "" : text, usage: { input_tokens: 1, output_tokens: 1 } });
    };
    const later: Promise<unknown>[] = [];
    const r = await handleDelegate(new Request("https://j.test/api/v1/stream", { method: "POST", body: JSON.stringify({ transcript: [{ role: "user", text: "call now, offer ends tonight" }], ...body }) }),
      env(), { waitUntil: (w: Promise<unknown>) => void later.push(w), passThroughOnException() {} } as never, ["*"] as never, { kind: "owner" } as never);
    const raw = await r.text();
    await Promise.all(later);
    const told = calls.filter((c) => c.url.endsWith("/responses")).map((c) => String(c.init.body)).join("");
    const result = raw.split("\n\n").filter((b) => b.includes("data:")).map((b) => JSON.parse(b.slice(b.indexOf("data:") + 5)) as Record<string, unknown>).find((e) => e.type === "result");
    return { told, result };
  };
  const notMine = await handoff({ openMic: true }, "NOT_FOR_ME");
  check("told the microphone hears everyone", /HEAR WHATEVER IS SAID NEAR THE USER/.test(notMine.told));
  check("not for Jarvis: an empty result that says so, for the app to tell the live voice silently",
    notMine.result?.text === "" && notMine.result?.notForMe === true, notMine.result);
  const acted = await handoff({ openMic: true }, "call:time_in", "NOT_FOR_ME");
  check("a tool ran before its word: the word emptied, what was done not hidden", acted.result?.text === "" && !("notForMe" in (acted.result ?? {})), acted.result);
  const plain = await handoff({}, "NOT_FOR_ME");
  check("without it: not told, and the result as the router gave it", !/HEAR WHATEVER IS SAID/.test(plain.told) && plain.result?.text === "NOT_FOR_ME" && !("notForMe" in (plain.result ?? {})), plain.result);
  answer = () => Response.json({ text: "hello" });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
