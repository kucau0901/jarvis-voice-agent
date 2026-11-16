// A video a component returns (lib/component-video.ts, tools/mcp.ts): which
// links count, where they may be, what is put on the screen, and that the
// model reads what it read before, with one line of code's after it.
import { MAX_VIDEOS, VIDEO_SHOWN, videoOf } from "../src/worker/lib/component-video.ts";
import { runCalls } from "../src/worker/lib/router.ts";
import { componentTools } from "../src/worker/tools/components.ts";
import { remoteTool } from "../src/worker/tools/mcp.ts";
import type { Offered } from "../src/worker/lib/components.ts";
import type { SseEvent } from "../src/worker/lib/sse.ts";
import type { Tool } from "../src/worker/tools/registry.ts";
import { fakeSchool, schemaOf, serve } from "./fake-component.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 500) : "");
  }
}

const URL_ = "https://video.example.com/mcp";
const V = "https://video.example.com/v/TOKEN";
const link = (uri: string, mimeType: string, more: Record<string, unknown> = {}) => ({ type: "resource_link", uri, name: uri.split("/").pop()!.split("#")[0], mimeType, ...more });
const TITLE = "Saved clip, Tue 10 Nov 07:11";
const CLIP = [
  { type: "text", text: "Now playing the saved clip." },
  link(`${V}/hd.mp4#t=553.8`, "video/mp4", { title: TITLE }),
  link(`${V}/sd.mp4#t=553.8`, "video/mp4", { title: TITLE }),
  link(`${V}/poster.jpg`, "image/jpeg"),
];

console.log("which links count, and where they may be");
{
  const { video, dropped } = videoOf(CLIP, URL_, "Clips");
  check("its videos in its own order, largest first, the fragment kept", JSON.stringify(video?.sources) === JSON.stringify([`${V}/hd.mp4#t=553.8`, `${V}/sd.mp4#t=553.8`]), video);
  check("its poster", video?.poster === `${V}/poster.jpg`);
  check("captioned with the component's name, then the first video's title", video?.label === `Clips — ${TITLE}`, video);
  check("nothing dropped", dropped === 0);

  const only = (uri: string, mime = "video/mp4") => videoOf([link(uri, mime)], URL_, "Clips");
  check("http: dropped", only("http://video.example.com/v/a.mp4").video === null && only("http://video.example.com/v/a.mp4").dropped === 1);
  check("another host: dropped", only("https://elsewhere.example.com/v/a.mp4").video === null);
  check("a host that only begins the same: dropped", only("https://video.example.com.example.net/v/a.mp4").video === null);
  check("another port: dropped", only("https://video.example.com:8443/v/a.mp4").video === null);
  check("its default port written out: the same origin", only("https://video.example.com:443/v/a.mp4").video?.sources[0] === "https://video.example.com/v/a.mp4");
  check("a user name: dropped", only("https://someone@video.example.com/v/a.mp4").video === null);
  check("a user name and password: dropped", only("https://someone:secret@video.example.com/v/a.mp4").dropped === 1);
  const long = `${V}/${"a".repeat(2048 - V.length - 5)}.mp4`;
  check("2048 characters: taken", long.length === 2048 && only(long).video !== null, long.length);
  check("2049: dropped", only(`${long}4`).video === null);
  check("not an address at all: dropped", only("not a url").dropped === 1 && videoOf([{ type: "resource_link", uri: 42, mimeType: "video/mp4" }], URL_, "Clips").dropped === 1);
  check("a javascript: address: dropped", only("javascript:alert(1)").video === null);
  check("a mime that is not exactly video/mp4: ignored, not counted as dropped", only(`${V}/a.webm`, "video/webm").dropped === 0 && only(`${V}/a.mp4`, "Video/MP4").video === null && only(`${V}/a.mp4`, "video/mp4; codecs=avc1").video === null);
  check("a resource that is not a link, and other parts: ignored", videoOf([{ type: "resource", resource: { uri: `${V}/a.mp4`, mimeType: "video/mp4" } }, { type: "image", data: "", mimeType: "image/png" }, null, "x"], URL_, "Clips").video === null);

  const many = Array.from({ length: 5 }, (_, i) => link(`${V}/${i}.mp4`, "video/mp4"));
  const capped = videoOf([link("https://elsewhere.example.com/x.mp4", "video/mp4"), ...many], URL_, "Clips");
  check(`at most ${MAX_VIDEOS}: the first that pass`, JSON.stringify(capped.video?.sources) === JSON.stringify([0, 1, 2].map((i) => `${V}/${i}.mp4`)) && capped.dropped === 1, capped);

  const posters = videoOf([link(`${V}/a.webp`, "image/webp"), link(`${V}/b.png`, "image/png"), link(`${V}/a.mp4`, "video/mp4"), link(`${V}/c.gif`, "image/gif")], URL_, "Clips");
  check("one poster, the first that passes, wherever it is in the list", posters.video?.poster === `${V}/a.webp`, posters);
  check("a poster elsewhere: dropped, the video still shown without one", (() => {
    const r = videoOf([link("https://elsewhere.example.com/p.jpg", "image/jpeg"), link(`${V}/a.mp4`, "video/mp4")], URL_, "Clips");
    return r.video !== null && r.video.poster === undefined && r.dropped === 1;
  })());
  check("a poster alone shows nothing", videoOf([link(`${V}/p.jpg`, "image/jpeg")], URL_, "Clips").video === null);
  check("nothing at all shows nothing", videoOf([], URL_, "Clips").video === null);
}

console.log("\nits caption");
{
  const cap = (more: Record<string, unknown>) => videoOf([link(`${V}/a.mp4`, "video/mp4", more)], URL_, "Clips").video?.label;
  check("its name when it has no title", cap({}) === "Clips — a.mp4", cap({}));
  check("its name when its title is empty", cap({ title: "  " }) === "Clips — a.mp4");
  check("the component's name alone when it has neither", cap({ name: 5 }) === "Clips", cap({ name: 5 }));
  check("on one line", cap({ title: "Line one\nline\ttwo\u0000" }) === "Clips — Line one line two", cap({ title: "Line one\nline\ttwo\u0000" }));
  const longCap = cap({ title: "x".repeat(200) }) ?? "";
  check("cut to 80 characters", longCap.length === 80 && longCap.startsWith("Clips — x"), longCap.length);
  const half = cap({ title: `${"x".repeat(71)}😀😀` });
  check("not left on half a character", half === `Clips — ${"x".repeat(71)}`, half);
  check("markup stays text: it is set with textContent", cap({ title: "<img src=x onerror=alert(1)>" }) === "Clips — <img src=x onerror=alert(1)>");
  check("only the first video's title", videoOf([link(`${V}/a.mp4`, "video/mp4", { title: "First" }), link(`${V}/b.mp4`, "video/mp4", { title: "Second" })], URL_, "Clips").video?.label === "Clips — First");
}

console.log("\nthrough a call, as the router makes it");
{
  const clips = { ...fakeSchool(URL_), tools: [{ name: "play_clip", description: "Play a saved clip.", inputSchema: schemaOf("id") }], manifest: undefined };
  let parts: Record<string, unknown>[] = CLIP.slice(1);
  let isError = false;
  clips.answer = () => ({ text: "Now playing the saved clip.", parts, isError });
  const restore = serve([clips]);
  const logged: string[] = [];
  const realWarn = console.warn;
  try {
    const part: Offered = { id: "c1", label: "clips", name: "Clips", url: URL_, key: "clips-key-0123456789", level: "use", tools: [{ name: "play_clip", description: "Play a saved clip.", inputSchema: schemaOf("id"), reads: true }], events: [] };
    const asked = async (tool: Tool, opts: { grants?: string[]; screenless?: boolean } = {}) => {
      const events: SseEvent[] = [];
      const sink = { send: (e: SseEvent) => void events.push(e), isClosed: false };
      const out = await runCalls(
        [{ type: "function_call", call_id: "c1", name: tool.name, arguments: '{"id":"e1"}' }] as never,
        new Map([[tool.name, tool]]),
        { env: {} as never, signal: new AbortController().signal, memory: {} as never, grants: (opts.grants ?? ["*"]) as never, ...(opts.screenless ? { screenless: true } : {}) },
        sink,
      );
      const first = out[0];
      return { text: first && "output" in first ? String(first.output) : "", events, shown: events.filter((e) => e.type === "display") };
    };
    const [tool] = componentTools([part], true);
    // Each call's fence has its own nonce: compared without it.
    const plainly = (s: string) => s.replace(/:[0-9a-f]{8}\b/g, ":NONCE");

    const none = await (async () => {
      parts = [];
      return asked(tool!);
    })();
    parts = CLIP.slice(1);
    const r = await asked(tool!);
    check("put on the screen as a video: its sources, poster and caption", r.shown.length === 1 && JSON.stringify(r.shown[0]) === JSON.stringify({ type: "display", kind: "video", sources: [`${V}/hd.mp4#t=553.8`, `${V}/sd.mp4#t=553.8`], poster: `${V}/poster.jpg`, label: `Clips — ${TITLE}` }), r.shown);
    check("the model's text is what it was without the links, and one line after the quoted result", plainly(r.text) === `${plainly(none.text)}\n${VIDEO_SHOWN}` && none.shown.length === 0, { with: r.text, without: none.text });
    check("that line is code's, word for word", VIDEO_SHOWN === "Jarvis is now showing this video on the user's screen; do not show anything else for it.");
    check("the model never sees an address", !r.text.includes("/v/TOKEN") && !r.text.includes("video.example.com"));
    check("nor does anything else the call sends but the screen's display", !JSON.stringify(r.events.filter((e) => e.type !== "display")).includes("/v/TOKEN"), r.events);

    const screenless = await asked(tool!, { screenless: true });
    check("no screen (a device's text or voice): nothing shown, and the text as without links", screenless.shown.length === 0 && plainly(screenless.text) === plainly(none.text), screenless);
    const noScope = await asked(tool!, { grants: ["ask", "components"] });
    check("a caller without `screen` (a routine, a job): nothing shown", noScope.shown.length === 0 && plainly(noScope.text) === plainly(none.text), noScope);

    isError = true;
    const failed = await asked(tool!);
    check("a result marked isError: nothing shown, and its error read as before", failed.shown.length === 0 && /^clips reported an error: --- clips result:/.test(failed.text) && !failed.text.includes(VIDEO_SHOWN), failed);
    isError = false;

    const plainServer = remoteTool({ label: "clips", url: URL_, headers: {} }, { name: "play_clip" });
    const mcp = await asked(plainServer);
    check("a plain MCP server, not a component: nothing shown", mcp.shown.length === 0 && plainly(mcp.text) === plainly(none.text), mcp);

    console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
    parts = [link("https://elsewhere.example.com/v/SECRET/hd.mp4", "video/mp4"), link(`${V}/sd.mp4`, "video/mp4")];
    const mixed = await asked(tool!);
    console.warn = realWarn;
    check("a link elsewhere is dropped, the rest still shown", mixed.shown.length === 1 && JSON.stringify(mixed.shown[0]!.sources) === JSON.stringify([`${V}/sd.mp4`]), mixed.shown);
    check("the drop is logged by the component's label alone, never the address", logged.some((l) => l.includes("clips") && l.includes("dropped")) && !logged.join().includes("SECRET") && !logged.join().includes("elsewhere"), logged);

    parts = [link("https://elsewhere.example.com/v/a.mp4", "video/mp4"), link(`${V}/p.jpg`, "image/jpeg")];
    console.warn = () => {};
    const posterOnly = await asked(tool!);
    console.warn = realWarn;
    check("no video passing: nothing shown and no line, even with a poster", posterOnly.shown.length === 0 && !posterOnly.text.includes(VIDEO_SHOWN), posterOnly);
  } finally {
    console.warn = realWarn;
    restore();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
