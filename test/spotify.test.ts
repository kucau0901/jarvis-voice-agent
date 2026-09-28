// What music_state says (tools/spotify.ts): nothing playing is not the same as Spotify failing.
import { spotifyTools } from "../src/worker/tools/spotify.ts";

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

const kv = new Map<string, string>([["spotify:refresh", "refresh-token"]]);
const CONFIG = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) };
const ctx = { env: { CONFIG, SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" }, signal: new AbortController().signal, progress() {}, display() {}, memory: {}, grants: ["*"] } as never;
const state = spotifyTools.find((t) => t.name === "music_state")!;

/** Spotify, answering the player with `player` and the device list with one speaker. */
function spotify(player: () => Response) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("accounts.spotify.com")) return Response.json({ access_token: "access", expires_in: 3600 });
    if (u.endsWith("/me/player/devices")) return Response.json({ devices: [{ id: "1", name: "Kitchen", type: "Speaker", is_active: false }] });
    return player();
  }) as typeof fetch;
}

console.log("music_state");
const realFetch = globalThis.fetch;
try {
  spotify(() => new Response(null, { status: 204 }));
  const idle = String(await state.run({}, ctx));
  check("204: nothing is playing, and the devices are listed", idle === "Nothing is playing on Spotify. Devices Spotify can see: Kitchen (Speaker).", idle);

  spotify(() => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
  const down = String(await state.run({}, ctx));
  check("a 502 page is Spotify failing, not nothing playing", down === "Spotify returned 502.", down);

  spotify(() => Response.json({ error: { status: 429, message: "API rate limit exceeded" } }, { status: 429 }));
  const busy = String(await state.run({}, ctx));
  check("a 429 is said in Spotify's words", busy === "Spotify: API rate limit exceeded", busy);

  spotify(() => Response.json({ is_playing: true, device: { name: "Kitchen" }, item: { name: "Song", artists: [{ name: "Band" }], album: { name: "Album" } } }));
  const playing = String(await state.run({}, ctx));
  check("playing: what and where", playing.startsWith('Playing: "Song" by Band (Album) on Kitchen.'), playing);
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
