# Jarvis

A hands-free voice assistant for the car, the desk and the phone. You talk; it
answers in a natural voice and gets things done — your car, your house, your
mail and diary, your music, the web, and your own agents.

It runs in any modern browser, including the Tesla's, and was built first for a
Tesla Model 3 Highland. Deploy it to **Cloudflare Workers** (the free plan is
enough) or run it yourself with **Docker**.

> **In a Tesla:** the car's browser lets websites use the microphone from
> software 2026.26, which Tesla lists for cars with the AMD infotainment
> computer. Some countries block the browser while the car is moving
> (Australia, for one); there, Jarvis on the car's screen works only in Park, so
> use it from your phone instead. [docs/DESIGN.md](docs/DESIGN.md#the-in-car-probe)
> has a probe page to check your own car.

- **Voice** — OpenAI GPT‑Live, speaking and listening in real time, in whatever
  language you speak (and mixing two in one sentence, which it handles).
- **A router with tools** — each request goes to a fast model that picks the
  right tool: your car (Tessie), your house (Home Assistant, over MCP), Gmail,
  Google Calendar and Contacts, Spotify, Google Maps and Places, web search.
- **Memory** — it remembers what you tell it: people, places, preferences,
  directories. Found again by meaning as well as by words, so "who's the
  pharmacist?" finds the "Assistant Pharmacy Officer", and a Malay question
  finds a fact saved in English. Stored in your own deployment, applied
  atomically, and shown in the app's **memory** panel, where you can add a
  fact or forget one.
- **It speaks first** — alerts reach an open Jarvis screen and are said aloud
  there without opening a paid voice session, or arrive as a notification on
  your phone. Telegram, ntfy, a signed webhook and Home Assistant are optional
  extra routes. "Send that to my phone" works from the car. Nothing to set up
  beyond the OpenAI key.
- **Three ways to talk** — *Live* is GPT‑Live, a real conversation at $0.05 a
  minute while it is open. *Push‑to‑talk* is one question at a time:
  transcribed, answered by the same router with the same tools, and spoken
  back, for a fraction of a cent a question. *Type* is a chat, for noisy or
  quiet places: answers are written to be read, with exact figures and links,
  and cost the least of all. Chosen per screen under the orb, one conversation
  across all three. Hearing and speaking can use OpenAI, Cloudflare Workers AI,
  or the device itself.
- **It can see** — "is there a car in the driveway?", "did the parcel arrive?":
  Jarvis looks at a camera (Home Assistant's, or any camera with a snapshot
  address) and answers from what it sees, showing you the frame. Routines can
  look too: "every evening at seven, tell me if a parcel is at the door".
- **Background jobs** — "look into the best dashcams under RM800 and let me
  know": work that takes minutes runs on its own, even with every screen
  closed, and the result arrives as an alert and waits in the **jobs** panel.
  Jobs read (web, mail, calendar, memory, car, cameras) but never act. A
  question for Hermes runs the same way, so its answer is never lost.
- **Routines** — "remind me at five to call Mum", "every weekday at 7:30 tell
  me my first meeting and the traffic", "tell me when to leave for my
  appointments" (from your calendar, the car's position and live traffic), or
  anything set off by an event your home automation or phone sends. Said aloud
  or set up in the **routines** panel; run by the server, so no screen has to
  be open.
- **Your own agents** — any MCP server, and optionally a
  [Hermes](https://github.com/NousResearch/hermes-agent) agent at home.
- **Smart glasses** — on Even Realities G2, say *"Hi Even"* and ask: Jarvis
  takes the place of the glasses' built-in assistant, so there is no app to
  open, hands-free. [Setup guide](docs/even-g2.md).
- **Other devices** — an ESP32 or anything else can use it through a small
  [device API](docs/api.md) with per-device, revocable, scoped tokens.
- **Set up in the browser** — every key and setting is entered, tested and
  changed in the app's settings panel. You need exactly one secret to deploy.

How it works, and why it is built this way: [docs/DESIGN.md](docs/DESIGN.md).

## What you need

- An **OpenAI** API key with access to GPT‑Live. This is the only required
  service. Voice is billed per minute of open session, so Jarvis closes an idle
  session after two minutes.
- Optional, each switching on its own tools: a [Tessie](https://tessie.com)
  account for the car, Home Assistant for the house, a Google Cloud OAuth
  client for mail and calendar, a Spotify app, Google Maps keys, a Hermes agent.

## Deploy to Cloudflare

```bash
git clone https://github.com/kucau0901/jarvis-voice-agent && cd jarvis-voice-agent
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler kv namespace create CONFIG      # put the id it prints into wrangler.jsonc
```

Make an owner key — the one secret that unlocks your Jarvis — and give it to
the Worker:

```bash
LC_ALL=C tr -dc '0-9A-HJKMNP-TV-Z' </dev/urandom | head -c16; echo
npx wrangler secret put JARVIS_SHARED_SECRET
```

Then deploy and open the address it prints:

```bash
npm run deploy
```

Enter the owner key once on the unlock screen, open **settings**, and paste your
OpenAI key. That's it; add the other services from the same panel whenever you
like.

> **Error 10063, "You need a workers.dev subdomain"?** Jarvis keeps its memory
> in a Durable Object, and Cloudflare will not create one until your account has
> a workers.dev subdomain. Open **Workers & Pages** in the Cloudflare dashboard
> once — that creates it — and deploy again.

> **Keep the `durable_objects` block in `wrangler.jsonc`.** Memory and the
> settings you save in the panel live in that object. A config without it still
> deploys, but Jarvis quietly keeps memory in KV instead — on a deployment that
> already had the object, an out-of-date copy — and the settings panel cannot
> save. After a deploy, `env.STATE (JarvisState)` should be in the list of
> bindings wrangler prints.

**Your own domain:** uncomment `routes` in `wrangler.jsonc` and set
`workers_dev` to `false`, so Jarvis is served only there, behind your zone's
security rules.

## Run with Docker

The image runs the same code as Cloudflare, in Cloudflare's open-source
runtime, so every feature works the same. Memory and settings live in a volume.

```bash
git clone https://github.com/kucau0901/jarvis-voice-agent && cd jarvis-voice-agent
echo "JARVIS_SHARED_SECRET=$(LC_ALL=C tr -dc '0-9A-HJKMNP-TV-Z' </dev/urandom | head -c16)" > .env
cat .env                                     # this is your owner key
docker compose up -d
```

Open **http://localhost:8787**, enter the key, and configure the rest in
**settings**.

**Using it from a phone or anywhere else:** browsers only allow the microphone
over HTTPS (or on localhost). Point a domain at the machine, then:

```bash
echo "JARVIS_DOMAIN=jarvis.example.com" >> .env
echo "PUBLIC_URL=https://jarvis.example.com" >> .env
docker compose --profile https up -d         # Caddy fetches a certificate
```

Or put Cloudflare Tunnel or Tailscale in front instead. Behind any proxy, set
`PUBLIC_URL` (in `.env` or the settings panel) so Google and Spotify sign-in
return to the right address.

**Backups:** everything is in the `jarvis-data` volume.

```bash
docker run --rm -v jarvis-voice-agent_jarvis-data:/data -v "$PWD":/b busybox tar czf /b/jarvis-backup.tgz -C /data .
```

## Updating

Jarvis is released in numbered versions, each with notes in
[CHANGELOG.md](CHANGELOG.md) and on the
[releases page](https://github.com/kucau0901/jarvis-voice-agent/releases).
The number says what an update asks of you:

- **1.0.1** — a fix. Update when convenient.
- **1.1.0** — new features. Nothing to do but update.
- **2.0.0** — updating needs a step from you (a new secret, a changed
  setting), listed under **Action needed** in its notes. Read them first.

The version you are running is at the foot of the menu in **Settings**, which
also says when a newer one is out, with a link to what changed. To be told by
GitHub, choose **Watch → Custom → Releases** on the repository.

```bash
git pull                              # or: git checkout v1.1.0, to pick a version
npm ci && npm run deploy              # Cloudflare
docker compose up -d --build          # Docker
```

Your memory, settings and devices are kept across updates. A fork can point
the check at its own releases with the `UPDATE_REPO` setting (Settings →
Advanced), or turn it off.

## Settings

Everything lives in the settings panel, grouped by service, each with a short
note on where to get the value and a **Test** button that checks it against the
real service — before you save, if you like.

- **Secrets never reach the browser.** The panel shows a fingerprint
  (`••••iZYA · sha256 49598a4b`) so you can tell which key is set, never the key.
- **A value saved in the panel wins** over one set as a Worker secret or
  environment variable, which in turn wins over the default. Clear a saved value
  to fall back.
- **A stored token never follows a changed address.** If a service's URL is
  changed in the panel, its token is withheld until it is entered again — so
  someone holding the owner key cannot redirect your Home Assistant token to a
  server of their own.
- **Where you are** (time zone, country, language, units) drives times,
  directions, address lookups and distances.

The owner key is the one exception: it is what lets you in, so it is set at
deploy time. To change it, run `npx wrangler secret put JARVIS_SHARED_SECRET`
(or change `.env` and restart the container), then enter the new key once on
each screen. Device tokens keep working.

## Other devices

`POST /api/v1/ask` takes text and returns an answer, for anything that can make
an HTTPS request. Mint a token per device in the app's **devices** panel, with
only the scopes it needs, and revoke it there. See [docs/api.md](docs/api.md),
including an ESP32 example. Even Realities G2 glasses have a step-by-step
guide of their own: [docs/even-g2.md](docs/even-g2.md).

## Security

- Every `/api/*` route needs the owner key or a device token, except the Google
  and Spotify sign-in callbacks, which carry a single-use code instead. Device tokens are
  scoped (`car.read`, `home`, `mail`, …), rate-limited and individually
  revocable; administration is owner-only.
- Credentials stay on the server. Text written by other people — email bodies,
  calendar invitations, reviews — is fenced as data and never followed as an
  instruction.
- The server-rendered pages send a Content-Security-Policy that allows no
  script.

Found a vulnerability? Please open a private security advisory on GitHub
rather than a public issue.

## Development

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc && npx wrangler types
npm test            # ~1,200 tests, no framework, Node runs the TypeScript directly
npm run typecheck
npm run dev         # Vite, with the Worker in workerd
```

Every change that someone running a copy would notice gets a line under
**[Unreleased]** in [CHANGELOG.md](CHANGELOG.md). How versions are numbered
and released: [docs/RELEASING.md](docs/RELEASING.md).

## Licence

[MIT](LICENSE)
