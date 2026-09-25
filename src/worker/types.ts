export interface Env {
  ASSETS: Fetcher;
  CONFIG: KVNamespace;
  /**
   * The Durable Object holding memory and the daily device counter
   * (src/worker/state.ts). Optional so the Node tests, which have no such
   * thing, fall back to KV.
   */
  STATE?: DurableObjectNamespace;

  /** OpenAI key. Worker-only — it must never be sent to the browser. */
  OPENAI_API_KEY: string;
  /** Shared secret gating every /api/* route. */
  JARVIS_SHARED_SECRET: string;

  /** Hermes agent (Nous Research hermes-agent api_server). */
  HERMES_BASE_URL?: string;
  HERMES_API_KEY?: string;
  /** Model name the Hermes api_server expects; defaults to "hermes". */
  HERMES_MODEL?: string;

  /**
   * Backend model that routes delegations. The settings panel overrides this,
   * and it overrides the default in lib/router-model.ts. Kept as the way to set
   * a model the settings probe would refuse.
   */
  ROUTER_MODEL?: string;

  /** Set to "1" to withhold web search from the router. */
  DISABLE_WEB_SEARCH?: string;

  /**
   * Home Assistant long-lived access token, used for REST calls: the camera
   * tools and the Assist fast path (lib/assist.ts).
   */
  HA_TOKEN?: string;
  /** Home Assistant origin, for the camera proxy and the Assist fast path. */
  HA_BASE_URL?: string;
  /** Where to look for new releases: owner/name on GitHub, "off", or empty for this project's own. */
  UPDATE_REPO?: string;
  /** "0" stops house requests trying Home Assistant's Assist before the router. */
  HA_ASSIST?: string;
  /** Language Assist is asked in. Defaults to "en". */
  HA_ASSIST_LANGUAGE?: string;

  /** HA MCP endpoint. Held as a secret because the webhook URL IS the credential. */
  HA_MCP_URL?: string;

  /** Tessie personal access token, from dash.tessie.com/settings/api. */
  TESSIE_TOKEN?: string;
  /** Discovered once from GET /vehicles; not a secret. */
  TESSIE_VIN?: string;

  /** Google Maps key, used server-side. Must NOT be referrer-restricted: a
   *  Worker sends no referrer, so such a restriction would break it. */
  GOOGLE_MAPS_API_KEY?: string;

  /**
   * Separate key for the interactive embed, which runs in the browser.
   * Restrict this one BY REFERRER to the app's own hostname, and to the Maps
   * Embed API only. It is delivered over the authenticated stream rather than
   * baked into the bundle, so it never reaches a browser without the shared
   * secret — but assume it is public and restrict it accordingly.
   */
  GOOGLE_MAPS_EMBED_KEY?: string;

  /**
   * Spotify app credentials from developer.spotify.com/dashboard.
   * The refresh token is NOT here: it is obtained at runtime by the OAuth
   * callback and kept in KV, because nobody can type it in ahead of time.
   */
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;

  /**
   * Google OAuth client for Gmail, from console.cloud.google.com → Credentials
   * → OAuth client ID → **Web application**. As with Spotify, the refresh token
   * is not here; the callback writes it to KV.
   *
   * The consent screen MUST be published to "In production". Left in "Testing",
   * Google expires every refresh token after exactly 7 days and Gmail dies
   * weekly with `invalid_grant`. Publishing is self-service and does not
   * require passing verification review.
   */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  /**
   * Origins allowed to call the API from a browser, comma-separated and matched
   * exactly. Only needed for a browser-based client on a different origin — a
   * native client or a microcontroller never involves CORS at all.
   */
  JARVIS_ALLOWED_ORIGINS?: string;

  /** Cloudflare's own rate limiter, keyed per device. Optional: absent means off. */
  DEVICE_LIMIT?: RateLimit;
  /** Requests per device per day. Defaults to 500. */
  DEVICE_DAILY_LIMIT?: string;

  /** Cloudflare Access service token fronting Hermes. */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;

  /*
   * Even Realities G2 glasses (POST /api/v1/chat/completions). All optional.
   */
  /** Characters the glasses show before their renderer gives up. Defaults to 350. */
  G2_CHAR_BUDGET?: string;
  /** Seconds to wait for an answer. The Even app hangs up at 300. Defaults to 240. */
  G2_WAIT_S?: string;
  /** Old name of HA_ASSIST, still read. */
  G2_FASTPATH?: string;
  /** Old name of HA_ASSIST_LANGUAGE, still read. */
  G2_HA_LANGUAGE?: string;

  /*
   * Where the user is. Set in the settings panel; see lib/settings.ts and
   * lib/locale.ts. Until September 2026 all four were hard-coded to Malaysia.
   */
  /** IANA time zone. Defaults to UTC. */
  TIMEZONE?: string;
  /** ISO 3166 alpha-2. Biases directions and geocoding when set. */
  COUNTRY?: string;
  /** BCP 47 language tag. Defaults to "en". */
  LOCALE?: string;
  /** "metric" or "imperial". Defaults to metric. */
  UNITS?: string;

  /**
   * The https address people use to reach Jarvis, when it differs from what
   * the server sees — behind a reverse proxy, e.g. in Docker. Used for OAuth
   * redirects (lib/http.ts publicOrigin).
   */
  PUBLIC_URL?: string;

  /*
   * Alerts: how Jarvis reaches you when it speaks first (lib/alerts.ts). An
   * open screen and browser notifications need none of these; each of the
   * rest adds one more way through.
   */
  /** Channels to try, in order, comma-separated. Defaults to all of them. */
  ALERT_ORDER?: string;
  /** From @BotFather. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Who the bot writes to: your own chat id, or a group's. */
  TELEGRAM_CHAT_ID?: string;
  /** An ntfy topic's full address. On a public server the topic name is the only secret. */
  NTFY_URL?: string;
  /** For a topic that needs one. */
  NTFY_TOKEN?: string;
  /** Receives every alert as a JSON POST. May carry a credential in its path, so secret. */
  ALERT_WEBHOOK_URL?: string;
  /** Signs each POST: X-Jarvis-Signature: sha256=HMAC(secret, body). */
  ALERT_WEBHOOK_SECRET?: string;
  /** A Home Assistant notify service, without "notify.": e.g. mobile_app_pixel_9. */
  HA_NOTIFY_SERVICE?: string;
  /** "1": ask the Android Companion app to read alerts aloud. */
  HA_NOTIFY_SPEAK?: string;

  /*
   * Push-to-talk (lib/speech.ts): hearing and speaking one question at a
   * time, without GPT-Live. All optional; OpenAI is the default for both.
   */
  /** "openai", "workers-ai" or "browser". */
  VOICE_STT?: string;
  /** "openai", "workers-ai" or "browser". */
  VOICE_TTS?: string;
  /** An OpenAI voice: cedar, marin, alloy… */
  VOICE_TTS_VOICE?: string;
  /** How the voice should sound, for gpt-4o-mini-tts. */
  VOICE_STYLE?: string;
  /**
   * Cameras by snapshot address, for anyone without Home Assistant (or for
   * cameras it does not have): "Front gate = https://…/snap.jpg; Driveway = …".
   * Secret: an address often carries the camera's password.
   */
  CAMERAS?: string;
  /** Workers AI, for the cheapest hearing and speaking. Cloudflare only; add "ai": {"binding": "AI"}. */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
}
