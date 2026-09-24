import type { Tool, ToolContext } from "./registry";
import { call, explain, spotifyConfig, type SpotifyConfig } from "../lib/spotify";

/**
 * Spotify, by voice.
 *
 * An important limitation, stated once here so the tool descriptions can be
 * short: **a Tesla is not a Spotify Connect receiver.** The car's built-in
 * Spotify app authenticates directly with Spotify and does not advertise itself
 * as a device, so the Web API very likely cannot see or control what is playing
 * through the car's own speakers. What it *can* control is a phone, a laptop or
 * a speaker — which is still useful if music reaches the car over Bluetooth
 * from a paired phone, because then the phone is the Connect device.
 *
 * `music_state` is deliberately honest about which device it found, rather than
 * saying "playing X" and leaving the driver to guess where. Until a real drive
 * shows what appears in the device list, that honesty is the feature.
 */

const cfgOf = (ctx: ToolContext): SpotifyConfig => {
  const cfg = spotifyConfig(ctx.env, "https://jarvis.invalid");
  if (!cfg) throw new Error("Spotify is not configured");
  return cfg;
};

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" && v.trim() ? v.trim() : fallback;

const available = (env: { SPOTIFY_CLIENT_ID?: string; SPOTIFY_CLIENT_SECRET?: string }) =>
  !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);

const NOT_LINKED =
  "Spotify is not linked yet. The user needs to open /api/spotify/auth once from a phone " +
  "or laptop and approve access. Tell them that plainly; do not retry.";

/** Every path here can hit an unlinked account; say so rather than leaking a stack. */
async function guard<T>(fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return /not linked/i.test(msg) ? NOT_LINKED : `Spotify error: ${msg}`;
  }
}

/* ---------- shapes, narrowed to what is actually read ---------------------- */

interface Device {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  volume_percent: number | null;
}
interface Playback {
  is_playing: boolean;
  device?: Device;
  shuffle_state?: boolean;
  item?: {
    name: string;
    artists?: { name: string }[];
    album?: { name: string };
  } | null;
}

const artistsOf = (p: Playback): string =>
  (p.item?.artists ?? []).map((a) => a.name).join(", ");

/* ---------- what is playing ----------------------------------------------- */

export const musicState: Tool = {
  name: "music_state",
  scope: "media",
  pace: "fast",
  available,
  description:
    "What is playing on the user's Spotify, and on which device. Use for 'what's this song', " +
    "'what am I listening to', or when you need to know whether any device is available " +
    "before trying to control playback. Always mention the device name if the user seems " +
    "unsure where the music is coming from.",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(_args, ctx) {
    return (await guard(async () => {
      const cfg = cfgOf(ctx);
      const [playerRes, devRes] = await Promise.all([
        call(ctx.env, cfg, "/me/player", { signal: ctx.signal }),
        call(ctx.env, cfg, "/me/player/devices", { signal: ctx.signal }),
      ]);

      const devices = ((devRes.body as { devices?: Device[] } | null)?.devices ?? []).filter(
        (d) => d && d.name,
      );
      const names = devices.length
        ? devices.map((d) => `${d.name} (${d.type}${d.is_active ? ", active" : ""})`).join("; ")
        : "none";

      // 204 means Spotify knows the account but nothing is playing anywhere.
      if (playerRes.status === 204 || !playerRes.body) {
        return `Nothing is playing on Spotify. Devices Spotify can see: ${names}.`;
      }
      const e = explain(playerRes);
      if (e) return e;

      const p = playerRes.body as Playback;
      const track = p.item?.name;
      if (!track) return `Spotify is ${p.is_playing ? "playing" : "paused"} on ${names}.`;

      const where = p.device?.name ?? "an unknown device";
      const verb = p.is_playing ? "Playing" : "Paused";
      const by = artistsOf(p);
      return (
        `${verb}: "${track}"${by ? ` by ${by}` : ""}` +
        `${p.item?.album?.name ? ` (${p.item.album.name})` : ""} on ${where}. ` +
        `All devices Spotify can see: ${names}.`
      );
    }))!;
  },
};

/* ---------- start something ----------------------------------------------- */

const TYPES = ["track", "album", "artist", "playlist"] as const;

export const musicPlay: Tool = {
  name: "music_play",
  scope: "media",
  pace: "fast",
  available,
  description:
    "Search Spotify and start playing it. Use for 'play X', 'put on some Y'. Pick the type " +
    "that matches what the user said: a song name is a track, a band or singer is an artist, " +
    "a record is an album, a mood or activity is usually a playlist. This needs an active " +
    "Spotify device — if there is none, say so rather than claiming it worked.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to search for, in the user's own words: 'Paranoid Android', 'Radiohead'.",
      },
      type: {
        type: "string",
        enum: TYPES as unknown as string[],
        description: "What kind of thing to look for.",
      },
    },
    required: ["query", "type"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    return (await guard(async () => {
      const cfg = cfgOf(ctx);
      const query = str(args.query);
      if (!query) return "No search term was supplied.";
      const type = (TYPES as readonly string[]).includes(str(args.type))
        ? str(args.type)
        : "track";

      const q = new URLSearchParams({ q: query, type, limit: "1" });
      const found = await call(ctx.env, cfg, `/search?${q}`, { signal: ctx.signal });
      const e = explain(found);
      if (e) return e;

      const bucket = (found.body as Record<string, { items?: unknown[] }> | null)?.[`${type}s`];
      const hit = bucket?.items?.[0] as
        | { uri?: string; name?: string; artists?: { name: string }[] }
        | undefined;
      if (!hit?.uri) return `Spotify has nothing matching "${query}".`;

      // A track plays as a one-item queue; everything else plays as a context.
      const body =
        type === "track" ? { uris: [hit.uri] } : { context_uri: hit.uri };
      const res = await call(ctx.env, cfg, "/me/player/play", {
        method: "PUT",
        body,
        signal: ctx.signal,
      });
      const failed = explain(res);
      if (failed) return failed;

      const by = (hit.artists ?? []).map((a) => a.name).join(", ");
      return `Playing ${type === "track" ? "" : type + " "}"${hit.name}"${by ? ` by ${by}` : ""}.`;
    }))!;
  },
};

/* ---------- operate it ------------------------------------------------------ */

const ACTIONS = {
  pause: { method: "PUT", path: "/me/player/pause", said: "Paused." },
  resume: { method: "PUT", path: "/me/player/play", said: "Resumed." },
  next: { method: "POST", path: "/me/player/next", said: "Skipped." },
  previous: { method: "POST", path: "/me/player/previous", said: "Went back." },
  shuffle_on: { method: "PUT", path: "/me/player/shuffle?state=true", said: "Shuffle on." },
  shuffle_off: { method: "PUT", path: "/me/player/shuffle?state=false", said: "Shuffle off." },
} as const;

export const musicControl: Tool = {
  name: "music_control",
  scope: "media",
  pace: "fast",
  available,
  description:
    "Operate Spotify playback that is already going: pause, resume, skip, go back, shuffle, " +
    "or set the volume. Needs an active Spotify device. Say what actually happened.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...Object.keys(ACTIONS), "volume"],
        description: "What to do. Use 'volume' together with the volume field.",
      },
      volume: {
        type: ["integer", "null"],
        description: "0-100, only for action 'volume'. Null otherwise.",
      },
    },
    required: ["action", "volume"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    return (await guard(async () => {
      const cfg = cfgOf(ctx);
      const action = str(args.action);

      if (action === "volume") {
        const raw = Number(args.volume);
        if (!Number.isFinite(raw)) return "No volume level was supplied.";
        const pct = Math.min(100, Math.max(0, Math.round(raw)));
        const res = await call(ctx.env, cfg, `/me/player/volume?volume_percent=${pct}`, {
          method: "PUT",
          signal: ctx.signal,
        });
        return explain(res) ?? `Volume at ${pct} percent.`;
      }

      const spec = ACTIONS[action as keyof typeof ACTIONS];
      if (!spec) return `I cannot do "${action}" with the music.`;

      const res = await call(ctx.env, cfg, spec.path, { method: spec.method, signal: ctx.signal });
      return explain(res) ?? spec.said;
    }))!;
  },
};

export const spotifyTools: Tool[] = [musicState, musicPlay, musicControl];
