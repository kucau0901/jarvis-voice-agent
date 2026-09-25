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
  check("in Jarvis's manner", /composed British butler/.test(s));
  check("without the live voice's interruption rule", !/interrupted/.test(s));
  check("the GPT-Live prompt keeps it", /If you are interrupted, stop immediately/.test(jarvisPrompt("car")) && /VOICE AND MANNER\nSpeak like a composed British butler/.test(jarvisPrompt("car")));
}

console.log("\nwho may");
{
  check("/api/v1/voice needs voice", requiredScope("/api/v1/voice", "POST") === "voice");
  check("a lookalike path is the owner's", requiredScope("/api/v1/voicex", "POST") === "owner");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
