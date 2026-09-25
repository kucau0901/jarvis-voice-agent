import {
  dataUrl,
  listCameras,
  parseCameraList,
  pickCamera,
  snapshot,
  type Camera,
} from "../src/worker/lib/cameras.ts";
import { photosFrom, MAX_PHOTOS } from "../src/worker/lib/photos.ts";
import { lookAtCamera, showCamera } from "../src/worker/tools/camera.ts";
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

type Call = { url: string; headers: Record<string, string> };
let calls: Call[] = [];
let answer: (url: string) => Response = () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  calls.push({ url: String(input), headers: (init.headers ?? {}) as Record<string, string> });
  return answer(String(input));
}) as typeof fetch;

const kv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string, t?: string) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)!) : m.get(k)) : null), put: async (k: string, v: string) => void m.set(k, v), _m: m };
};
const env = (e: Record<string, unknown> = {}) => ({ CONFIG: kv(), ...e }) as never;

console.log("the camera list setting");
{
  const r = parseCameraList("Front gate = https://cam.example.com/snap.jpg; Driveway = http://user:p%40ss@192.168.1.20/snap.jpg\nBack garden=https://x.example/b.jpg");
  check("three cameras, named and addressed", Array.isArray(r) && r.length === 3 && r[1]!.name === "Driveway" && r[1]!.slug === "driveway" && r[0]!.slug === "front-gate", r);
  check("an entry without a name is refused", typeof parseCameraList("https://cam.example.com/snap.jpg") === "string");
  check("a non-web address is refused", typeof parseCameraList("Gate = ftp://x/y.jpg") === "string" && typeof parseCameraList("Gate = not a url") === "string");
  check("two with the same name are refused", typeof parseCameraList("Gate = https://a/1.jpg; gate = https://a/2.jpg") === "string");
  check("the panel refuses a bad list, with a reason", !validateChanges({ CAMERAS: "Gate https://a/1.jpg" }).ok);
  check("…and takes a good one", validateChanges({ CAMERAS: "Gate = https://a/1.jpg" }).ok);
}

console.log("\nfinding the camera meant");
{
  const list: Camera[] = [
    { id: "camera.porch", name: "Porch", source: "ha" },
    { id: "camera.doorbird", name: "Doorbird", source: "ha" },
    { id: "url:front-gate", name: "Front gate", source: "url" },
    { id: "camera.backyard", name: "Backyard", source: "ha" },
  ];
  check("exact", pickCamera(list, "porch")?.id === "camera.porch");
  check("loose: 'the front gate camera'", pickCamera(list, "the front gate camera")?.id === "url:front-gate");
  check("by entity id", pickCamera(list, "camera.backyard")?.id === "camera.backyard");
  check("nothing matching: nothing", pickCamera(list, "garage") === undefined);
}

console.log("\nevery camera, from both places");
{
  answer = (u) =>
    u.endsWith("/api/states")
      ? Response.json([{ entity_id: "camera.porch", attributes: { friendly_name: "Porch" } }, { entity_id: "light.hall" }])
      : new Response("x");
  calls = [];
  const e = env({ HA_BASE_URL: "https://ha.example.com", HA_TOKEN: "t", CAMERAS: "Gate = https://cam.example.com/g.jpg" });
  const all = await listCameras(e);
  check("listed ones first, then Home Assistant's; lights are not cameras", all.map((c) => c.id).join() === "url:gate,camera.porch", all);
  await listCameras(e);
  check("Home Assistant's list is cached", calls.filter((c) => c.url.endsWith("/api/states")).length === 1);
  check("no Home Assistant, no listed cameras: none, no calls", (await listCameras(env())).length === 0);
}

console.log("\none frame");
{
  answer = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } });
  calls = [];
  const e = env({ CAMERAS: "Driveway = http://admin:p%40ss@192.168.1.20/snap.jpg", HA_BASE_URL: "https://ha.example.com", HA_TOKEN: "tok" });
  const s = await snapshot(e, "url:driveway");
  check("a picture", s.ok && s.mime === "image/jpeg" && s.bytes.byteLength === 4);
  check("the password goes as Basic auth, not in the address", calls[0]!.url === "http://192.168.1.20/snap.jpg" && calls[0]!.headers.Authorization === `Basic ${btoa("admin:p@ss")}`, calls[0]);
  calls = [];
  await snapshot(e, "camera.porch", 1024);
  check("Home Assistant: its proxy, scaled, with the token", calls[0]!.url === "https://ha.example.com/api/camera_proxy/camera.porch?width=1024" && calls[0]!.headers.Authorization === "Bearer tok", calls[0]);
  calls = [];
  check("a crafted id is refused before any call", !(await snapshot(e, "camera.porch/../../api/states")).ok && calls.length === 0);
  check("an unknown listed camera is refused", !(await snapshot(e, "url:nope")).ok);
  answer = () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
  const html = await snapshot(e, "url:driveway");
  check("a login page is not a picture", !html.ok && /text\/html rather than a picture/.test(html.error), html);
  answer = () => new Response("no", { status: 401 });
  const denied = await snapshot(e, "url:driveway");
  check("a wrong password says so", !denied.ok && /wrong user or password/.test(denied.error));
  answer = () => new Response(new Uint8Array(10), { headers: { "content-type": "image/jpeg", "content-length": String(50 * 1024 * 1024) } });
  check("something enormous is refused", !(await snapshot(e, "url:driveway")).ok);
  check("a data: URL of it", dataUrl(new Uint8Array([1, 2, 3]).buffer, "image/png") === "data:image/png;base64,AQID");
}

console.log("\nthe tools");
{
  answer = (u) =>
    u.endsWith("/api/states")
      ? Response.json([{ entity_id: "camera.porch", attributes: { friendly_name: "Porch" } }])
      : new Response(new Uint8Array([0xff, 0xd8]), { headers: { "content-type": "image/jpeg" } });
  const shown: Record<string, unknown>[] = [];
  const progress: string[] = [];
  const ctx = {
    env: env({ HA_BASE_URL: "https://ha.example.com", HA_TOKEN: "t", TIMEZONE: "Asia/Kuala_Lumpur" }),
    display: (p: Record<string, unknown>) => shown.push(p),
    progress: (t: string) => progress.push(t),
  } as never;
  const out = await lookAtCamera.run({ camera: "the porch", question: "Is anyone there?" }, ctx);
  check("returns the picture, for the router to look at", typeof out !== "string" && out.images.length === 1 && out.images[0]!.url.startsWith("data:image/jpeg;base64,"), out);
  check("with the question and a warning not to guess", typeof out !== "string" && /Is anyone there\?/.test(out.text) && /too dark, blurred or blocked/.test(out.text));
  check("and shows it on screen as the evidence", shown[0]?.kind === "camera" && shown[0]?.entity === "camera.porch");
  check("and says it is looking", progress[0] === "looking at the Porch");
  const none = await lookAtCamera.run({ camera: "garage", question: "open?" }, ctx);
  check("an unknown camera: names the real ones", typeof none === "string" && /There is: Porch/.test(none));
  const list = await showCamera.run({ camera: "" }, ctx);
  check("show_camera with no name lists them", list === "Cameras available: Porch.");
  check("available with only a listed camera, no Home Assistant", lookAtCamera.available!(env({ CAMERAS: "Gate = https://a/g.jpg" })) && !lookAtCamera.available!(env()));
}

console.log("\nphotos from the phone");
{
  const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
  check("a photo is taken", photosFrom([jpeg]).length === 1 && photosFrom(jpeg).length === 1);
  check("not an image: dropped", photosFrom(["data:text/html;base64,PGh0bWw+", "https://evil.example/x.jpg", 42]).length === 0);
  check("no SVG (it can carry script)", photosFrom(["data:image/svg+xml;base64,PHN2Zz4="]).length === 0);
  check(`at most ${MAX_PHOTOS}`, photosFrom([jpeg, jpeg, jpeg, jpeg]).length === MAX_PHOTOS);
  check("too big: dropped", photosFrom([`data:image/jpeg;base64,${"A".repeat(3_100_000)}`]).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
