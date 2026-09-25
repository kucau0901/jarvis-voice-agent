# Design notes

How Jarvis works, and why it is built the way it is. Most sections record a
decision and the measurement or failure that forced it — the kind of thing that
is invisible in the code and expensive to rediscover. For setting Jarvis up, see
the [README](../README.md); for the device API, [api.md](api.md).

## Debugging from the car

The Tesla browser has no devtools, so the app carries its own. Tap **events**
for the raw server-event stream, and `window.__jarvis` exposes a live session:

```js
__jarvis.say("text Jarvis should speak")   // session.commentary.append
__jarvis.think("silent context")           // session.thinking.append
__jarvis.events()                          // event type histogram
__jarvis.stop()
```

```js
__jarvis.simulateDrop()            // fake a dead zone and watch recovery, while parked
__jarvis.history()                 // the transcript that would seed a reconnect
await __jarvis.speak("...")        // say something to Jarvis without a microphone
```

`speak()` synthesises the text and swaps it onto the outgoing audio track, then
puts the microphone back. It exists because `commentary.append` is useless for
testing: it hands the model something to *say* rather than a request to act on,
so it never triggers a delegation and every test looks like it passed.

`GET /api/diag` reports whether OpenAI and Hermes are actually reachable, which
is otherwise invisible from the driver's seat.

Every close path carries a reason, shown under the orb (`ended — …`), because
"why did the session end" is otherwise unanswerable from the driver's seat.

## Losing signal

The car runs on LTE, so tunnels and dead zones are a normal part of a drive, not
an edge case. GPT-Live has **no resume or renegotiation endpoint** — `live.create`
is the only way in — so recovery means starting a *new* session seeded with the
transcript so far, which the API supports via `input` (128 messages / 8,192 tokens).

- `disconnected` gets a 4s grace period first, because a cell handover usually
  heals itself and tearing down immediately would be worse than waiting.
- Reconnects back off 1s / 3s / 7s / 15s, then stop and offer a retry.
- While `navigator.onLine` is false it waits for the `online` event instead of
  burning attempts against a radio that is plainly down.
- On recovery Jarvis gets *silent* context about the gap, so he behaves sensibly
  if you repeat yourself without narrating the network at you.
- A drop is reported once per session. Several events fire for a single failure
  (`pc.connectionState`, then `datachannel.close`), and without that guard each
  one would start its own session — every orphan billing at $0.05/min.

## The in-car probe

Open **https://jarvis.example.com/probe** on the car screen and tap *Run all checks*
in **Park**, then *Run — tag as DRIVE* while moving (as a passenger). Before you
start, enable **Wi-Fi → Remain connected in Drive**, or the car drops to LTE the
moment you shift out of Park.

It answers what the public record does not: whether the microphone opens, whether
WebRTC works including a **data channel** (GPT‑Live carries all its events on one
labelled `oai-events` — media support alone is not enough), whether audio plays,
the WebGL budget that decides the orb's quality tier, storage, and what the
browser says about itself.

One run, on 21 September 2026, settled how to recognise the car: its user agent
has **no `Tesla` token** (it reads as Chrome on Linux) and the window is only
about 773 CSS pixels wide, so neither identifies it. `src/app/client.ts` uses the
pointer pair instead — a fine primary pointer *with* a coarse one is the car.

It was written for one question: **does the microphone work while driving?**
In the author's Model 3 in Malaysia, it does. That matches Tesla's 2026.26
release notes, which opened the cabin microphone and camera to the browser and
restrict only the *camera* to Park. The notes list the feature for cars with the
**AMD** infotainment computer; on an older Intel car, expect the browser to have
no microphone, and run the probe to be sure.

Whether the *browser itself* can be used on the move is a separate question, and
the answer depends on the country. Tesla publishes no list. An owner in
**Australia** reports that the browser is unavailable while driving there, and
coverage of the same feature says driver access while moving "varies by
jurisdiction". Where it is blocked, Jarvis on the car's screen is Park-only; use
it from a phone instead, with the phone's audio going to the car over Bluetooth.

So it is still worth running on a new car, in a new country, or after a software
update.

Tap *Upload results* to push them to the Worker (it asks for the access key once,
then remembers it), and read them back with:

```bash
curl -s https://jarvis.example.com/api/probe -H "X-Jarvis-Key: $JARVIS_KEY" | jq
```

The probe is intentionally dependency-free — plain `<script>`, no ES modules, no bundler,
no three.js — because "is the modern bundle broken in this browser" is one of the things
it is testing. It lives in `public/` and is copied verbatim, never compiled.

## How a request reaches your house

`session.delegation.created` carries only an id and a timeline offset — **never
the task text** — so the browser sends the whole transcript to `/api/delegate`
and a router model (`gpt-6-luna` unless another is chosen in the settings
panel) works out what was wanted and picks a tool.
That router is also what makes third-party MCP servers usable at all.

The reply streams back over SSE. Progress notes arrive as *silent* context, so
Jarvis mentions a delay in his own words only when the wait has been long enough
to be strange, rather than narrating every step. The final answer is spoken.

There is no timeout on Hermes. A local model can take minutes, and the
requirement was that Jarvis waits and says so rather than giving up — so the
stream is held open with a heartbeat every 15s and the silence is filled at 12s,
35s, 75s, 150s, 240s and 360s. Only the driver ending the turn cancels it.

**The Hermes call must stream.** `hermes.example.com` is proxied by
Cloudflare, which gives an origin 100 seconds to send its first byte before
returning 524. A non-streaming request sends nothing until the model has
finished, so every question slower than that died at ~130s no matter how patient
the caller was. With `stream: true` the first token arrives at once and the
connection then stays open as long as it needs — a 230-second answer now
completes where a 130-second one used to fail.

## The orb

Three layers, cheapest first: a radial halo quad, a displaced icosahedron core,
and an additive point shell for the sparks. No post-processing — the bloom is
faked in-shader, because a real bloom pass costs a full-screen blur the in-car
GPU cannot spare.

It is driven by two continuous levels rather than a state enum. GPT-Live is full
duplex, so the driver and Jarvis genuinely overlap, and the orb blends between
cyan and gold rather than switching. A delegation in flight adds a slow inward
churn.

**Quality adapts at runtime instead of being guessed from the user agent.** The
real frame budget in the car is unknown, so the orb measures its own median frame
cost and steps down — first dropping the per-pixel veins, which are pure fragment
cost, and only then the geometry detail, because a coarser silhouette is more
visible than softer filaments. It steps back up when there is headroom.
`__jarvis.orb()` reports where it settled, and `__jarvis.orbForce({user, agent,
think})` forces a visual state for tuning without holding a billing session open.

Device pixel ratio is deliberately capped at 1: honouring the car's 1.53 would
cost about 2.3x the fragment work for no visible gain on a dashboard at arm's
length.

## Where an answer can come from

| | route | typical |
|---|---|---|
| "what's my home address" | memory, injected | **instant, no tool call** |
| "how long to get home" | memory + Tessie + Routes | **~10s** |
| "how's the car" | Tessie direct | **~6s** |
| "is the gate open" | Home Assistant MCP | **8s** |
| "what's the weather / any news" | web search | **5s** |
| "any new mail / what did X say" | Gmail REST, direct | **~2s** |
| "what's my next meeting" | Calendar REST, direct | **~2s** |
| "when do I need to leave" | calendar + Tessie + Routes | **~4s** |
| anything else | Hermes | 30–230s |

Times were measured in September 2026 and move with the router model, the
network and how long Hermes thinks.

## The car

Home Assistant mirrors the Tesla's basic state, but only a subset — it cannot push
a destination to the car's navigation, which is the thing actually wanted while
driving. So the car goes direct through Tessie: `car_state` to read,
`car_command` to operate, including `navigate_to`.

Every command slug is read from `developer.tessie.com/reference/<page>.md`, never
derived from a doc page title. Three of fifteen differ — `flash-lights` is
really `flash`, `front-trunk` is `activate_front_trunk`, `set-temperature` is
`set_temperatures`. Do not guess a new one.

Whether a command wakes a sleeping car is undocumented, so the tool checks
`/status` and calls `/wake` itself when needed, which also gives the driver
"waking the car" instead of ninety seconds of apparent silence.

> **`navigate_to` validates its argument as an address or lat/long, and rejects
> URLs.** Tessie's `share` command also accepts a video URL, so without that
> check anything able to write text the user later asks about — an email, a
> calendar entry, a search result — could put arbitrary content on the car's
> screen. That is prompt injection into the vehicle rather than a misheard word,
> which is why it is guarded in code even though every other command is allowed.

## Showing something

Ask to *see* a camera — "show me the gate", "what's at the front door" — and a
live view from Home Assistant takes the main panel, refreshing about once a
second. Snapshots rather than an MJPEG stream, because a stream has to be an
`<img src>` and an `<img>` cannot send the auth header; that would mean putting
a credential in the URL and undoing the proxying. One frame a second is plenty
for "who is at the gate", and it stops the moment the panel closes rather than
quietly pulling frames for the rest of the drive.

Jarvis is told never to describe what a camera shows. He cannot see it, and
guessing is worse than silence.

Ask to *see* a place — "show me Menara TM", "what does it look like there" — and
the orb shrinks into the top-left corner while a map or a street-level photo
takes the main view. Only on request: a map appearing unasked is a distraction
while driving.

The picture travels as a separate `display` event on the delegate stream, so the
spoken answer stays to one sentence while the screen carries the detail.

**Imagery is proxied.** The browser asks the Worker, the Worker asks Google, so
the Maps key never reaches the page. That also means the images sit behind the
same shared-secret gate as everything else — the browser fetches them with its
auth header and hands the blob to an `<img>`, because an `<img src>` cannot send
one and putting a credential in the URL would undo the point.

Street View imagery is checked for existence first, so Jarvis says "there is no
street-level photo there" rather than showing Google's grey placeholder and
claiming success.

Set `GOOGLE_MAPS_EMBED_KEY` and the view becomes an **interactive Google embed**
you can pan, instead of a photograph of one. That key necessarily reaches the
browser, so it must be a *second* key — restricted by HTTP referrer to this app's
hostname and to the Maps Embed API alone. It cannot be the same key as the
server-side one: a referrer restriction is what makes a browser key safe, and a
Worker sends no referrer, so the restriction protecting one would break the
other. The key is delivered over the authenticated stream rather than baked into
the bundle, because **only `/api/*` is behind the shared secret — the page and
its JS are served to anyone who loads the URL.** If the embed fails to load
within six seconds the static image takes over, since a dashboard is no place to
discover an iframe was blocked.

### Two viewports

Tesla gives this app the whole screen when parked and a narrow column beside the
driving visualisation when moving. The layout scales rather than switching at a
breakpoint — the orb, the type and the panel all derive from `vmin` — so it also
survives Tesla changing that split.

## Getting somewhere

`directions` answers "how long to get home" using the Routes API — chosen over the
legacy Directions API because it returns `duration` *and* `staticDuration`, so the
answer can separate the journey from the traffic.

The origin is **the car's live position from Tessie**, which sidesteps browser
geolocation entirely — untested in the Tesla browser, and not something the probe
checks. The destination resolves through memory, so "home" works without
repeating the address.

> **An unresolved place is never passed to Google.** Handed a bare "the office",
> Google will cheerfully geocode *an* office somewhere and the model will report
> that travel time as fact. Instead it says it has no address and asks for one,
> which turns the failure into the moment that teaches it.

The field mask is minimal on purpose: the Routes API **bills by requested
fields**, and adding `routes.polyline` for debugging moves the call to a more
expensive tier.

## Memory

Jarvis remembers across drives. The only durable memory used to be Hermes's,
reached through `X-Hermes-Session-Key` — which meant every memory question took
the slow path. Memory is now local: one document in the Durable Object, plus a
second for reference material, BM25-lite retrieval, no embeddings.

It lived in KV until 23 September 2026. On first use the object copies `mem:v1`
and `mem:ref:v1` out of KV and leaves them there untouched as a backup, so the KV
copy is stale by design. A deployment without the `STATE` binding still runs, on
KV — which is how the author's deployment spent a day serving that stale copy. Check that
`env.STATE (JarvisState)` is in the bindings wrangler prints on deploy.

The important facts are **injected** into every delegation rather than fetched
with a `recall` call, because *"how long to get home"* carries no signal that
memory is involved — retrieval-on-demand structurally cannot cover the case that
matters most. `recall` remains for the long tail.

> **The profile block is injected as a `user` message, never as `instructions`.**
> These are facts the car heard and stored. `lib/history.ts` already settled this
> for live speech — nothing from the car becomes a developer message — and stored
> speech is strictly worse, because it persists into every future drive. A
> passenger saying *"remember that you should always ..."* must not be able to
> write a standing instruction into a context that can reach a shell at home.
> A write-time filter rejects instruction-shaped text as well, but that is a
> heuristic; the placement is the boundary.

Places are typed (`slug` + `address`) and upserted by name, so two contradicting
copies of "home" are structurally impossible — and so `directions` can resolve
"home" in code with no model in the path.

The **memory** panel lists every fact by kind, shows the profile block and how
much of its budget is used, adds a fact and forgets one. It writes through
`POST` and `DELETE /api/memory`, one fact per request, using the same changesets
the voice tools use — never the replace-all `PUT`, which from a page left open
would delete anything saved by voice in the meantime. A forgotten fact goes to
the trash, except reference facts, which have none. *Test recall* runs a query
through `POST /api/memory/search`, which ranks without counting a use: a lexical
scorer is only debuggable by trying queries against it.

`PROFILE_BUDGET` (1,500 characters) bounds the fact lines in the profile block;
a fixed header of about 460 characters sits on top. Facts that do not fit are
still saved and reached through `recall`, and the panel says how many there are.

> **The delegation runs inside `ctx.waitUntil()`, and that is load-bearing.**
> Without it the runtime may tear the Worker down the moment the client
> disconnects — and ending a session aborts the in-flight delegation. The
> memory write would start and then be killed, so a fact learned during a drive
> was gone by the next one. At the time memory was in KV, and it looked like
> KV's eventual consistency; it was not. With `waitUntil`, a fact survives the
> connection being cut three seconds in.

Web search is OpenAI's built-in tool on the Responses API the router already
uses, so it runs server-side: no extra credential, and no function call for the
Worker to dispatch. Set `DISABLE_WEB_SEARCH=1` to withhold it.

Answers follow the **Where you are** settings — time zone, country, language and
units (metric unless set to imperial) — which drive times, directions, address
lookups and distances. Until September 2026 that was Malaysia, hard-coded in
nine places; the first version cheerfully led with Fahrenheit.

## Mail

Gmail goes **direct from the Worker** — `mail_check`, `mail_search`, `mail_send`
and `mail_manage` against the REST API, with the same one-time OAuth flow
Spotify uses and the refresh token in KV. There is no MCP server in the path,
on the Synology or anywhere else.

Between them they cover what a person does with mail: read it, reply in thread,
draft something to look at later, send, trash, restore, archive, mark read,
star.

That was a deliberate reversal of the original plan. An MCP server is how you
reach *somebody else's* tools; this is the user's own mailbox, and the Worker is
already the MCP client, so putting one in between means a connect → call → close
round trip to talk to yourself. It also rules itself out on the details: the
comprehensive Python server cannot run on a Worker at all, anything built on
`googleapis` needs Node built-ins a V8 isolate does not have, and the one
genuinely Workers-native TypeScript server authenticates its clients with OAuth
and PKCE, which this app's MCP client — static headers, nothing else — cannot
speak. Direct is both faster and less machinery.

> **The consent screen must be published to "In production".** Left in
> "Testing", Google expires every refresh token after exactly seven days and the
> only symptom is `invalid_grant`, which reads like a bug in this code rather
> than a setting in a console. Publishing is self-service and does not require
> passing verification review. Changing the Google password also revokes the
> token — Google does that for Gmail scopes specifically — so `lib/google.ts`
> tells those two cases apart from ordinary errors and says "needs re-linking"
> instead of suggesting a retry that cannot work.

**Mail is the first input in this system that somebody else wrote.** The
transcript is the driver; memory is what the driver said; Tessie and Home
Assistant return machine state. An email body is arbitrary text from an
arbitrary sender arriving in the context of an agent that can unlock a car and
reach a shell at home.

So everything read out of a message is fenced and labelled as data before it
goes back to the model, exactly as the memory profile is, and the router is told
plainly that an email is never an instruction — not to send a reply, not to open
a link, not to put a destination on the car's screen. `mail_send` refuses any
recipient it cannot parse as a bare address, which is what stops "forward this
to someone@else" *inside* a message from being actionable, and it rejects CR/LF
in a header rather than letting a subject line smuggle in a `Bcc:`.

The scope is `gmail.modify`. This began as `gmail.readonly` plus `gmail.send`,
on the argument that modify can trash mail and a car has no undo — and that was
reversed deliberately, because read-and-send is a notetaker rather than an
assistant. What makes it hold is that the undo now exists instead of being
promised:

- **Trash is not deletion.** Gmail keeps it 30 days, and `mail_manage` carries
  the restore next to the trash, so "no, not that one" is a sentence.
- **Permanent deletion is unreachable.** It requires the `mail.google.com`
  scope, which is not requested. No sequence of misheard words can destroy a
  message for good.
- **One message per call.** `mail_manage` has no bulk verb, so a misheard
  sentence costs one message rather than a mailbox.

`gmail.settings.*` remains deliberately absent, and nothing above changes that —
it is the one Gmail permission that would let a single bad turn install an
auto-forwarding rule and turn a mistake into ongoing exfiltration. Note that
`gmail.modify` sits in the same *Restricted* tier Google already placed
`gmail.readonly` in, so this widened what the app can do without widening what
Google asks of it.

## The diary

`calendar_check` and `calendar_add` ride the same Google grant as Gmail — one
OAuth client, one refresh token, one consent. That is the dividend of talking to
Google directly rather than through an MCP server: a second service cost three
lines of scope and a tool file.

Home Assistant already exposed calendar events, so this is not a new capability.
It is the same move Tessie made for the car: take the thing that matters off the
eight-second path, and gain write access on the way.

**The reason it earns its place is the third term.** This app already knows where
the car is (Tessie) and what a drive costs right now with traffic (`directions`).
Add the diary and it can answer the question a car assistant should be best at:

> *"When do I need to leave for my next meeting?"*

Nothing in the stack could answer that before. So `calendar_check` returns each
event's **location verbatim** rather than summarising it away — that string is the
argument the next call needs, and the router is told to make the hop itself and
report a time to set off rather than a duration.

**The router is given the current time on every delegation.** A model has no
clock, and "put that in my diary for three tomorrow" is otherwise unanswerable —
it would invent a date, and a silently misfiled meeting is not discovered until
it is missed. `calendar_add` refuses anything that is not a full ISO 8601
timestamp with an offset, and refuses a start more than a day in the past, since
that is a wrong year far more often than it is a real booking.

Contacts is read-only and exists to answer exactly one question: which address
does "Sam" mean. Without it `mail_send` can only refuse a name — which it
should, because guessing an address is how private mail reaches a stranger. With
it, one match is used, several means asking which, and none still refuses.
Whichever address it lands on is named back to you, so "sent to Sam" can never
hide which Sam.

## Two routes to the same house

Home Assistant and Hermes both reach the house, and they are not equally fast.
The router is told the difference and picks:

| | via Home Assistant (MCP) | via Hermes |
|---|---|---|
| "how warm is the master bedroom" | **11s** | 74s |
| reads a state, operates a device | yes | yes |
| reasoning, memory, survey of the house | no | yes |

So state and control go direct to HA; judgement goes to Hermes.

If Jarvis cannot see a device, the cause is almost never the token, and it is
also **not** Home Assistant's "expose to Assist" setting. The MCP server
integration keeps its **own read/control scope**, and it answers plainly when
something is outside it:

> `Not in read scope: [...]. You can only see the entities the owner selected.`

Widen that scope in the integration's own options. `GetLiveContext` returning
only one area is the tell.

MCP servers are configured in `config/mcp-servers.json` and overridden at runtime
from KV, so one can be added without a redeploy — there is a **settings** panel in
the app for exactly that, with a per-server *Test* button that connects, lists
tools and reports the transport and latency. Use it from a phone or laptop rather
than the car; typing a URL and a token on the Tesla keyboard is miserable. A URL
or header value written as `${NAME}` is filled at call time from a Worker secret
or a value saved in the settings panel, so the secret itself is never written
into the server list or the repo.

MCP tools are registered **non-strict**. Strict mode demands
`additionalProperties: false` and a full `required` list on every nested object,
and rewriting a third-party server's schema to satisfy that risks changing what
it means — the server validates its own arguments anyway.

## Speaking first

Everything else here answers a question. An alert is Jarvis starting the
conversation, which meets three hard facts: the car's tab cannot run in the
background, a GPT-Live session bills $0.05 for every minute it is open (and an
open one stops the car's own Spotify), and the repo is public, so nothing can
assume Home Assistant, a Tesla or a particular phone. Hence:

- **Always-on is server-side only.** Screens come and go; the Worker and its
  Durable Object are what is always there.
- **Nothing automatic opens GPT-Live.** A screen with no session open says an
  alert with one short text-to-speech clip (about a quarter of a cent). If a
  session happens to be open already, the session says it at no extra cost.
- **An ordered list of channels, not one** (`lib/alerts.ts`). Only the first
  two are built in, and both need nothing but the OpenAI key: an open screen,
  and browser notifications. Telegram, ntfy, a webhook and Home Assistant are
  optional, each one setting.

**Open screens use hibernating WebSockets** (`lib/live.ts`, `state.ts`). An SSE
stream or an ordinary socket keeps the Durable Object in memory for as long as
it is open, and one screen left open all day would use most of the free plan's
daily duration allowance. With the hibernation API the object leaves memory
while the socket stays connected, and keep-alive pings are answered by the
runtime itself, so an idle screen costs nothing.

**"Open" is not "seen".** A desktop tab behind other windows is open. Each
screen reports whether it is visible and acknowledges alerts only when it is,
and an alert counts as delivered live only on that acknowledgement, within
four seconds. Otherwise it goes on to the phone. Without this, a forgotten tab
would swallow every alert.

**Notifications are Web Push written on WebCrypto** (`lib/webpush.ts`): VAPID
signing and RFC 8291 payload encryption, about 150 lines. The usual library is
built on Node's crypto module; this runs unchanged on Cloudflare, in the Docker
image and under the tests, which check it byte for byte against the RFC's
worked example. The key pair is made on first use and kept in the Durable
Object, so there is nothing to generate or paste. Subscriptions are accepted
only for the real push services, or a device token could turn Jarvis into a
relay that POSTs anywhere.

**Browsers cannot put a header on a WebSocket**, so a screen asks for a
one-time ticket over an ordinary authenticated request and opens the socket
with it. Tickets live for a minute and are spent by the Durable Object, which
is also where the socket is accepted.

`send_note` ("send that to my phone") is the one alert the user raises
themselves. It skips open screens on purpose: the screen in front of them is
where they asked. Routines — alerts Jarvis raises on its own, from the clock,
the calendar or the car — build on the same `deliver()`.

## Architecture

One Cloudflare Worker serves both the app and `/api/*`, so the app needs no CORS
and ships in one deploy.

```
Browser (car, phone, laptop) ──WebRTC: audio + "oai-events" data channel──> OpenAI gpt-live-1
      │                                 session.delegation.created comes back on the channel
      │
      └── HTTPS /api/* (owner key or device token) ──> Cloudflare Worker
             /api/session   relays the SDP offer to OpenAI and returns the answer
             /api/delegate  router model + tools: Tessie, Gmail, Calendar, Contacts,
                            Maps, Spotify, web search, Home Assistant and other MCP
                            servers, Hermes at home (through Cloudflare Access)
             storage        Durable Object STATE: memory, panel settings, device
                            counters, follow-up threads
                            KV CONFIG: device tokens, Google and Spotify tokens,
                            MCP server list, router model choice
```

OpenAI never calls the Worker. The delegation event reaches the browser, and the
browser posts the transcript to `/api/delegate`.

GPT‑Live has **no ephemeral client secret**: the browser posts its SDP offer to the Worker,
the Worker calls `live.create()` with the offer inline and returns the answer. The OpenAI
key never reaches the car.

## Running and deploying

See the [README](../README.md): Cloudflare Workers or Docker.

## Other things that talk to it

The car is no longer the only client. A microcontroller, a pair of smartglasses or
a script can each hold their own credential, and `POST /api/v1/ask` takes one
string and returns one JSON object — no SSE frames, no heartbeat, which is what
makes an ESP32 practical.

```bash
curl -X POST https://jarvis.example.com/api/v1/ask \
     -H "Authorization: Bearer jdv1_…" \
     -d '{"text":"how much charge is left in the car?"}'
```

Tokens are minted from the **devices** panel in the app, which shows each one once
— with a QR encoding the `#key=` URL, so glasses scan it and arrive signed in
rather than being typed into. Every token carries scopes, and the agent is only
ever shown the tools its scopes allow: a tool a caller lacks is not in the prompt
to be argued around.

[api.md](api.md) is the reference, including a complete ESP32 sketch and
the two TLS traps that otherwise cost a weekend.

The page itself is a PWA. Open it on a phone, add to home screen, and it launches
standalone. The service worker caches the shell and never `/api/*` — every answer
there is live state, and a cached one is a wrong one.

## Security

Every `/api/*` route is gated by the owner key or a device token. The two
exceptions are the Google and Spotify sign-in callbacks, which a third party
redirects to and which carry a single-use `state` value instead. Enter the owner
key once on the unlock screen (or pass `#key=…` once) and it is remembered in
`localStorage`.

The key is 16 characters from a Crockford-style base32 alphabet with I, L, O and U
removed — 80 bits, so brute force is infeasible, but nothing in it can be misread
on a dashboard. Both sides uppercase and strip non-alphanumerics before comparing,
so the car keyboard's stray capitals, spaces and dashes all still authenticate. A
key that stops working re-opens the unlock screen rather than dead-ending on an
orb that will never start.

Devices are the exception to "one shared secret": each carries its own `jdv1_…`
token, stored only as a SHA-256 digest — which is also its KV key, so a lookup is
one read with no string comparison anywhere. Device tokens are never normalised
(that would throw away their entropy), they cannot reach the administrative
routes whatever scopes they hold, and any one of them can be revoked without
touching the car. The shared secret above remains the owner's credential and is
the only thing that can mint or revoke.

This gate is not decoration. The Hermes API server's own documentation warns that it grants
*"full access to hermes-agent's toolset, including terminal commands"*, and Jarvis is
connected to it, so anyone who can reach `/api/*` can reach a shell at home. Secrets stay
in the Worker, and the perimeter carries the weight.
