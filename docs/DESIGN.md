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
the task text** — so the browser sends the conversation so far (its recent
part: see "The conversation, kept") to `/api/delegate`
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
blue and amber rather than switching. A delegation in flight adds a slow inward
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

**The sky behind it** (`src/app/orb/Sky.ts`) is one full-screen quad in the
theme's palette (night #000 to #171A20, day #DDE3EA to #F4F4F4, so what is over
it stays as readable as before), with the sun where it is now (where home is,
from Home Assistant's `zone.home`, else by the clock), the clouds and rain of
the first weather entity, and haze from a panel's kept air-quality reading
(`GET /api/hub/panels/sky`: one template, no model). Everything over it is
blurred glass that is redrawn with it, so it draws at half the screen's
resolution or less, ten frames a second, governed as the orb is (the same
`Governor`, fed the time between frames too, since the blur costs the GPU
rather than the script), and goes still when even its lowest step is too
much. It holds still in the car's driving view and where less motion is
asked for, and without WebGL the old backdrop stays.

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

**How long the router thinks is not where the time goes.** Tested on 26 Sep
2026 with GPT-6 Luna: ten real questions (the car, memory, the staff list, the
calendar, the web, Malay, the house, a planted false memory, the gate and a
follow-up) at each reasoning effort, through the live deployment.

| effort | total | output tokens | wrong answers |
|---|---|---|---|
| model default | 85 s | 1,262 | 0 |
| medium | 73 s | 1,191 | 0 |
| low | 87 s | 1,313 | 0 |
| minimal | 80 s | 1,416 | 0 |
| none | 63 s | 943 | 1 |

Low and minimal were no faster and wrote as much: Luna already thinks little.
The differences are the house (one porch-light question took 10 to 28 s,
depending on how many searches it made) and the link to it. "None" was quickest
and invented a task: asked about tomorrow's calendar, it started a background
job looking for payroll dates. So `ROUTER_EFFORT` stays at the model's
default; the setting is there for a heavier router model, where it may matter.

## Paying for it: the ChatGPT plan first

Many owners already pay for ChatGPT, and since DevDay 2026 OpenAI lets an
open-source app spend a Plus or Pro plan's included usage ("Sign in with
ChatGPT", plan usage). So a ChatGPT plan or an API key is all Jarvis needs,
and with both, every model call tries the plan first (`lib/openai-auth.ts`
`modelAuth`). One plan for the house, the owner's, connected in Settings: the
family's questions are one household's.

**What the plan cannot do needs the key.** GPT-Live is not part of plan usage,
so live voice needs a key, and without one the app hides the Live switch
(`/api/hub/me` `live`). The plan's route has no audio and no embeddings, so
without a key push-to-talk hears and speaks through Workers AI
(`lib/speech.ts`), and memory is searched by words. Nor has it images: making
a picture (`tools/image.ts`) is offered only with a key.

**Signing in ends with a paste** (`lib/chatgpt-plan.ts`). The plan's OAuth is
for public clients whose redirect must be `http://127.0.0.1:<port>/auth/callback`;
a Worker cannot listen there. So the browser ends on a page that does not
load, its address holds the code, and the owner pastes it into Settings,
where the object trades it, with PKCE, the way OpenAI's page on remote hosts
describes ("complete OAuth where the browser is, let the host own the
refreshes"). The session lives in the Durable Object, never in KV, and only
the access token for a call ever leaves it. Refresh tokens rotate, so two
refreshes must never race: the object shares one refresh between callers
that arrive while it waits on the network.

**The plan's route is narrower than the API's**, and the router follows it
there (`lib/router.ts`): every request streamed and not stored, so no
`previous_response_id` and each hop carries the whole exchange; reasoning
carried as encrypted content; function tools in one namespace; no explicit
prompt caching, which it refuses. The items come in `response.output_item.done`
events; the closing event carries none (measured). The key path is as before.
`input` must be a list of items: a bare string, which the key's route takes,
is answered 400 "Input must be a list". Every page watch failed that way for
a day after the plan arrived, because the page reader sent its question as a
string and that 400 is not the plan's limit, so nothing fell back to the key.
`planRespond` now makes a string the user message it stands for.

**At the plan's limit** (429 `subscription_sharing_usage_limit_exceeded`) the
key carries on, mid-question if need be, with what the plan had done so far
(so no tool runs twice), and the plan is not tried again for an hour; the
owner is told once a day at most. OpenAI asks that switching billing be the
user's choice, so it is a setting (`CHATGPT_FALLBACK`), on by default;
switched off, Jarvis says the limit is reached. Other errors are not a reason
to spend the key.

**Background jobs** (`routes/jobs.ts`) cannot use OpenAI's background mode on
the plan, so a step streams inside the object's alarm, as a Hermes question
already does, and its exchange is kept in the object under `jobplan:<id>` for
the next step and the research check. `lib/jobs.ts` sees an ordinary step id.

OpenAI also says remotely hosted apps should fill in an interest form; it may
one day ask that of a Worker. The key still runs everything if it does.

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

### The look

The colours are Tesla's own, from its design system's greys and blue, so the
app looks at home on the car's screen. They are custom properties in
`index.html`: dark in `:root`, light under `[data-theme="light"]`. Nothing else
in the style block names a colour, apart from the white behind a QR code and
the caption over a photo.

Light or dark is chosen per screen (menu → **Theme**, `src/app/theme.ts`), so
the car and a phone in the same family can differ. **Auto**, the default, is
light from 07:00 to 19:00 by the screen's own clock. It is not the system
setting, because Chromium 148 in the car can report
`prefers-color-scheme: light` at night, and a white screen after dark is the
last thing a driver wants. System is offered for a phone or a laptop that
reports it properly.

A module script runs after the first paint, so one line in `<head>` paints
light while the light the screen last showed still holds (until 19:00 under
Auto), and `theme.ts` corrects it at once. That line holds no rule of its own;
without it every daytime reload flashed black, and with a bare "last shown"
one a reload after dark would have flashed white.

On a light page the orb's additive glow composites to white and vanishes, so
in light it blends normally, its shadow side is lifted and its light is
compressed less: it reads as a lit glass ball rather than a dark hole.

The layout follows Hark's: a pill switcher for the Jarvis, Chat and Home tabs, the
menu as a page behind your initial, panels as full-screen pages with round
back and close buttons, sections as rows in cards, and frosted glass over a
blurred page — in the car too, where the orb already draws smoothly. A glass
layer never sits inside another (a backdrop filter only sees its parent's
contents), the `-webkit-` prefix is kept for iOS before 18, and every control
a driver uses is sized explicitly, at 44px or more, because the car's browser
reports `pointer: fine`. Icons are line drawings held as CSS masks, painted in the
text colour: not elements, so code that rewrites a button's text keeps them.

## Panels

Hark keeps a column of cards beside its chat — the gate, the lights, the car,
what has been spent — and you make them by asking. Jarvis does the same on the
**Home** tab: "put the gate and the porch light on a panel", "add my car to
Home Controls", "a to-do panel with renew the road tax" (`panel_set`,
`panel_remove`, tools/panels.ts). `panel_list` tells the router what is on
them, each thing by name and what it is, when it is asked about them or
before it changes one; without it the router changed panels it could not
see, by a name it had to guess. It is a tool, not part of every question,
so a question that is not about panels costs no more.

- **Each person's own.** Panels are kept per person (lib/panels.ts, one key
  each); the owner key and the first person are the same person, as
  everywhere. They need `screen`, which a guest does not have, so a guest has
  no Home tab. Glasses, which have no screen, never make one; another device
  only with `screen`, for its owner's Home tab.
- **What a panel can hold is what Jarvis reaches for that person.** A thing in
  the house needs Home Assistant's address and token (Settings → Home, read
  over its REST API, as the guest pass is) and `home`; a car needs Tessie and
  `car.read`; their usage and plain notes need nothing more. With only an
  OpenAI key, Home still works, with usage and notes.
- **Live, never stored.** Only what a panel holds is kept. Each thing is read
  when the tab is open (every 20 s, and after a press): Home Assistant as the
  person (their own token when they gave one), the car from Tessie's last
  state, which never wakes it. No model call either way.
- **Buttons follow the state.** A closed gate offers Open, an open one Close; a
  lit lamp offers Turn off; a locked car Unlock. A press is checked against the
  state again before anything is sent, so a button left on screen after the
  gate moved does nothing it no longer means. The house is worked through the
  guest pass's fixed table of services (lib/access.ts `passService`), on
  things the person put on their own panel, and only with `home`: what the
  house then does is Home Assistant's to decide, as for every other route. A
  car shared to `see` shows its state with no buttons.
- **Room-sized.** Up to 20 things a panel, 8 panels, and 30 things in the
  house across them, since each is one request when the panel is shown and
  the free plan allows 50. A room's lights can be its group: one row, "On, 8
  lights", with All on or All off (Home Assistant's own
  `homeassistant.turn_on`/`turn_off`, the one service a group answers to).
  The first real panel asked for (14 Oct 2026) was fifteen things, the
  master bedroom's lights among them: against a limit of 12, the router spent
  its six rounds searching again instead of splitting, and gave up. The
  refusal now says how to fit (a second panel, or the room's group), and the
  tool asks for every lookup in one round.
- **Laid across the page.** Hark's panels sit in a narrow column beside its
  chat; Jarvis's Home tab has the whole screen, so a panel is a card of
  tiles, each thing with an icon (from Home Assistant's device class, else its
  name, since a gate is often a cover or a button with none), its state, and
  its buttons, drawn in colour while it is lit, open, unlocked, charging or
  armed (an alarm that has gone off in red). A
  car is a tile with its battery and range, then one for each of its locks,
  climate and charging, as Hark shows one. A big card (five tiles or more)
  runs across the page, the others in columns — three on a wide screen, two
  in the car, one on a phone — each column a stack, so a folded card leaves
  no hole. The cards are in their person's order: made last at the end, and
  moved by dragging a card's name, with a mouse at once and with a finger
  held a moment first, so a swipe on it still scrolls (ui/HomeWall.ts). The
  order is saved for the person (POST /api/hub/panels/order, the same list
  in the same key), so each of their screens shows it. The columns are
  filled across then down, first card in the first column, second in the
  second, rather than balanced by the browser: balanced columns put a card
  wherever the balance falls, so one dropped on another's place landed
  somewhere else; here it takes that place, and the others make room as it
  goes. Columns can end at different heights, which the person can even out
  by moving one. A tall one folds
  as Hark's do, to its first row with the next fading out under it,
  remembered on that screen, and its … menu reloads it or removes it (two
  taps), as `panel_remove` does when asked. On a light page a pale tint
  washes out, so there the icon's disc is filled with the colour instead.
- **A room's lights as one row**, as Hark showed "Master bedroom lights · 1 of
  8 on · reading lamp unavailable" for a house with no group for them: their
  ids kept together in one item, read one by one (each still counts towards
  the 30), and switched by All off or All on in one call to Home Assistant's
  own `homeassistant.turn_off`/`turn_on`, sending only those not already so.
  Only lights and switches may share a row; a gate or a lock is always its
  own, with its own button.
- **Jarvis lays it out, not the wording.** Asked to make or change a panel,
  the tool arranges the whole of it (lib/panel-arrange.ts), as Hark does
  without being told: three or more lights of one room become that room's
  row, and the way in comes first (gates, doors, locks, the alarm), then
  lights and switches, the climate, readings, the car, usage and notes. The
  room is the light's area in Home Assistant, read with one template; where
  the house will not say, lights whose names start alike ("Master …") are one
  room. Rules rather than a second model call, since model calls cost the
  owner money, and so the same request always gives the same panel.
- **Moved by hand, kept by Jarvis.** A thing on a panel is dragged by its
  name, within its panel, as a panel is (a car's tiles move together, by its
  first). That order would be undone the next time Jarvis changed the panel
  if the tool still sorted all of it, so it does not: what a panel has keeps
  its order when things are added by chat, and each thing added goes after
  the last of its kind, or else after the last of what Jarvis puts before it.
  A panel nobody moved is already in Jarvis's order, so for it nothing
  changed. A room's row still forms when a light joins, where its first light
  was. Asked to tidy or rearrange a panel, the model sends `arrange` and the
  whole of it is laid out again; `replace` lays out what it is given, as
  before. Kept in the panel's own list of things, so no new key.
- **Opened, as Hark opens a row.** A room's row, an aircond and an alarm open
  across their panel (src/app/ui/HomeMore.ts): each of the room's lights with
  its own button; the aircond's temperature up and down, its modes and its
  fan, as Home Assistant says it supports them; the alarm's Disarm, or each
  way it can be armed, with a box for its code when it wants one. The code
  goes with that one press to Home Assistant and is kept nowhere. Each press
  is checked against the state read again, as every press is
  (lib/panel-controls.ts).
- **Anything else Jarvis can do, as a tile.** The house is read directly
  because it is the cheap path; everything else — the music, the car's other
  controls, the calendar, mail, cameras, routines, Hermes, an MCP server's
  tools — goes on a panel as a tile wired to the person's own tools
  (lib/panel-tiles.ts). The model wires it once, when asked ("put Spotify on
  a panel with pause and next"): a reading, one tool with fixed arguments,
  and up to six buttons, each a tool with fixed arguments or, only where no
  tool call can do it, a sentence asked of Jarvis as if typed in Chat. After
  that a press runs the tool itself, with no model; an asking button costs
  one model call a press, which the owner accepted. A tile's tool runs only
  if the person pressing is offered it now — the same tools, filtered by the
  same grants, as when they ask — so a tile can do nothing they could not ask
  for, Hermes included. A tile's buttons are fixed when it is made, so
  those that send one of the car's paired commands (lock or unlock, climate
  or charging on or off) are shown only when the car's state offers them,
  read as for the car's own tiles, and one pressed after the car changed
  sends nothing; when the car's state cannot be read they all stay. Its
  reading comes on its own (GET
  /api/hub/panels/read), once a minute, so a slow tool or someone else's
  service never holds up the house.
- **Lists, charts and maps.** A looked-up reading can carry, beside its
  figures, a short list (lines starting "- ": a forecast's days, the
  headlines), a trend ("Chart: <title>: x=y; …", drawn as a line) and a
  place ("Map: lat, lng"); a tool that answers in lines keeps them as a list.
  A number in the house — a sensor, a number helper — opens to its last day
  from Home Assistant's history (GET /api/hub/panels/history, one request,
  thinned to 96 points by averaging, asked again only every five minutes
  while open), and the car opens to where it is. Charts are drawn as SVG in
  code, with no library; maps come through the Worker's map proxy as the
  stage's do, so they need the Maps key and are left out without one.
- **Sliders and typing.** What has a level opens to a slider: a light's
  brightness (0 turns it off), a fan's speed, a blind's position, a
  speaker's volume, a number helper's value, each in the range Home
  Assistant gives it, checked again before it is sent (`level:<n>`); a
  room's dimmable lights each have their own under their row. A tile's
  button can take a slider's number or typed words first, which go into
  one argument of its tool (music_control's volume, send_note's text) or
  into its sentence where it says {}. A slider sends when it is let go, not
  at every step of a drag.
- **A checklist.** Notes are to-dos with a tick: ticked, one is struck
  through and moved to the bottom, kept until "Clear ticked" in the panel's …
  menu, so a mis-tap is undone by tapping again (the owner's choice). Any
  panel holding notes has a box to type the next one straight onto it, with
  no model call (POST /api/hub/panels/note). A ticked note keeps the stored
  shape: its `ref` is "done" instead of "".
- **A reading no tool has is looked up**, as Hark built "the latest official air
  quality for Springfield" when Jarvis had refused: no tool of the person's
  could read it, and the model's own web search cannot be wired to a tile.
  So a tile's reading can be a question instead, which Jarvis answers with
  the model and web search: a verdict and up to three figures ("API: 175",
  "As of: 3:00 PM"), kept in the state object under a key of its own
  (`panelreads:`). It is looked up again only while someone has Home open
  and the answer is older than its interval, which the model sets and
  which is never under an hour (the owner's choice: nothing is spent while
  nobody looks, where Hark checks every hour regardless). A screen shows
  the kept answer at once and asks for a new one only when it is stale; two
  screens open at once do not both pay for it, since the first claims it for
  two minutes. The exception is one asked for: "keep it updated" makes a
  tile refresh hourly or daily with Home closed (lib/panels.ts refresh),
  from the state object's one alarm, as Hark's tiles are. At most three a
  person and two a run, last in the alarm so they take what its budget has
  left, through the same claim so Home and the alarm never both pay; with
  reading tools only and without the house (no MCP to discover with nobody
  waiting); after a look that found nothing, again in a quarter hour, then
  less often; and nothing at all with no plan and no key.
- **Alerts from a panel.** "Alert me", in an opened tile, makes a routine of
  its person's (lib/panel-alerts.ts; POST /api/hub/panels/alert), so it
  needs `routines` and is changed or removed in Routines. A thing in the
  house becomes a watch with its condition written from what it is — when
  the gate opens or closes, when a reading goes above or below a number
  typed — so nobody writes a template, and it costs nothing. A reading
  Jarvis looks up becomes a page watch on its source: the owner refused a
  web search every hour as too dear, so the page is found once, when the
  alert is set — the source the look-up gave ("Source: <url>", kept with
  the reading), or else one search for a page that shows it plainly — and
  each look after that is the page fetched, which is free, and read by the
  cheapest model with no tools, about a tenth of a cent (lib/page-look.ts).
  The page is someone else's words, so it reaches the model as quoted data.
  A page that cannot be read without its scripts is refused when the alert
  is set, since it would never say.

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
second for reference material, and retrieval by words (BM25-lite) and by
meaning (embeddings), merged.

**Specialties: the user's own way, saved.** "Save this as my Monday report"
keeps the steps Jarvis just took (`lib/specialties.ts`), and a later question
that names it, or shares two words with it, gets them beside the profile, as
Hark's Specialties do. Steps are followed, so they are a standing instruction
of the user's, and only the user can make one: `specialty_save` takes their
own words asking for it, which must be in their latest message, so a page, a
mail or a tool's output cannot save one, and jobs are never offered it. They
go to the router as a user message, as the profile does, worded as a
procedure the user approved, to follow only if it fits and with the tools it
has now. Matched by words, in the same wait as the rest of the question's
preparation (one call to the Durable Object), so a question pays no model call
and the car no extra wait.

**Past attempts: what happened last time.** Each background job, question
for Hermes and research run, and each question whose tools failed, is noted
as one line (`lib/episodes.ts`): what was wanted, whether it worked, and what
came of it. A question sharing two words with one is given the best three, in
the same call as the specialty, so Jarvis does not walk into the same wall
twice. Hark tidies its memory overnight with a model; this tidies as each
note is written, for nothing: older than 180 days goes, the same attempt again
is counted rather than kept twice (as memory's near-duplicates are), and
beyond 500 the oldest goes. A note can carry what a site or a tool said, so it
is always quoted as data. Memory → Past attempts lists them, each forgettable;
they are in the export, and gone when the person leaves.

**Recall by meaning, only when searching.** The facts that matter everywhere
travel with every question, so an ordinary question makes no extra call. Only
an explicit search (`recall`) embeds the question, with OpenAI's
text-embedding-3-large at 1024 dimensions, and ranks facts by closeness in the
Durable Object, where the vectors live beside memory and never travel. The
word ranking and the meaning ranking are merged by reciprocal rank fusion, so a
fact near the top of both wins and exact names and numbers still count. A fact
is embedded on the first search after it is saved, and again if its text
changes; a forgotten fact's vector goes with it, but only after a complete read
of memory, so a storage blip cannot wipe good vectors. With no key, or OpenAI
down, recall is words alone, as before.

Measured on real memory in September 2026: the small embedding model missed
short Malay questions about English facts ("isteri saya siapa?" did not find
"The user's wife is called Sara"); the large one put the right fact first for
all nine test questions in either language, and nothing for unrelated ones
("play some jazz"). True matches scored 0.39–0.50, unrelated questions 0.17 at
most, so the cut-off is 0.35. The search adds 0.2–0.3 s to a recall, and costs
about a hundred-thousandth of a cent.

Measuring this also found an old word-search bug: names like "Ma'ruf" and
"So'od" left two-letter keys that matched inside "nama", "mana" and "some", so a
staff member turned up for "play some jazz". Partial matches now need four
letters on both sides.

"Remember" checks for a fact already saying the same thing in other words and
tells the router, rather than merging: a restatement scored 0.82 against the
saved fact, while different facts that sound alike ("My sister is called
Sara") scored up to 0.63, so the note appears above 0.75 and never merges.

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
  sentence costs one message rather than a mailbox. The one exception is not
  a model's: a brief's card to archive old promotions (`lib/mail-bulk.ts`).
  Code chooses the messages, from a search fixed in code (in the Inbox, a
  promotion, older than two days, neither starred nor important); the count
  on the card is what runs, and only those still matching when the tap is
  made; it only takes them out of the Inbox, never trashes; it is made only
  by a tap, never offered to the router or a job; and Put back returns them,
  for a week.

**Draft first** (Settings → Google, off by default) takes sending away from
the model altogether: `mail_send` saves every mail as a draft, the screen
shows it as a card with Send (`src/app/draft.ts`), and only that tap sends
it, by Gmail's own `drafts.send` (`lib/mail-draft.ts`). Gmail's Drafts are
the waiting list, so nothing is stored here, and a draft from a screenless
question (Telegram, the car) waits there for the person. The card has no
Discard: deleting a draft is for ever, and nothing here deletes for ever.
A household footer (Settings → Google → Footer on mail Jarvis writes) goes
under every mail Jarvis writes, after the usual `-- ` line.

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
into the server list or the repo. Jarvis's own keys are the exception: the
OpenAI key, the owner key and the rest are filled in only for a server at or
under an address that key is already sent to (the Home Assistant token for
Home Assistant's own MCP server, under its Base URL), so whoever edits the list
cannot aim one at a server of their own. A secret meant for an MCP server gets a name of its own,
and only the owner key can send one to a URL the list does not already send
it to: any admin can edit the list, and such a secret has no address of its
own to keep to. (Not the person who set up the family, signed in as
themselves: the owner key is the one credential no admin can make, and a
sign-in for them may predate the rule that only the owner key, or they, can
make one.) A
token typed into a header as-is stays with the URL it was typed for: a server
given a new URL needs it typed again. The URL as written, in both cases: not
only its host, which can be shared, as Nabu Casa's webhook host is, and not
where a new URL points today. And a server whose address is a setting, such as
the seeded `${HA_MCP_URL}`, is sent neither, whoever saved it: any admin can
change a setting, the list untouched, so this is decided on every call, as
`guarded()` is for settings. It still gets Jarvis's own keys under their own
rule. A server that needs a token of its own has its address written out in
full, or in a Worker secret.

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
  two are built in, and both need nothing more than Jarvis itself: an open screen,
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

## Seeing

`look_at_camera` fetches one frame (a few, to judge movement) and returns it inside the tool's result:
the Responses API takes pictures in a function call's output, so the router
model itself looks and answers in the same loop — no second model, no extra
call — and can go on to use other tools on what it saw. The frame is also put
on screen, as the evidence. Cameras are Home Assistant's, or plain snapshot
addresses in the CAMERAS setting (`lib/cameras.ts`), so it works without
Home Assistant; a password in the address is sent as Basic authentication,
because a fetch refuses one inside a URL.

One frame cannot tell arriving from leaving. When the question turns on
movement ("is that car pulling in or out?", "watch the porch for a moment"),
the router sets `movement` and three frames are taken instead, one after
another and never together, at least 2.5 s apart from ask to ask: past the
2 s in which a camera's frame is shared, so each is a new picture. It stops at
the first failure, at a frame that repeats the one before (a camera serving a
stored still, where watching shows nothing), or when the request is given up,
and asks for none later than 8 s after the first, which keeps a slow camera to
two frames and the whole look well inside a device's 60 s wait. The screen
opens only once the frames are in, so its refresh does not compete with them
over the slow link. It is a parameter rather than a second tool: the tool list
stays as it was, and a request that offers the tool carries one short
parameter more.

A device can also send a photo with its question (docs/api.md, Photos): the
router sees it beside the conversation. The app had a camera button for this
and it was taken out after trying it. In a live session GPT-Live, which cannot
see, answered "I don't see anything" itself rather than handing the question
on, even when told a photo was waiting; and a photo from the phone was not what
Jarvis is for — its point is reaching the user's own systems, and "is the gate
open?" already looks at the gate. The API stays for devices with cameras of
their own, such as glasses. Photos came back in Chat (below) when the owner
asked for Hark's (16 Oct 2026): there a question goes to the router itself,
which sees, so what went wrong in a live session cannot. Not in a live
session.

Measured in September 2026 on GPT-6 Luna with real home cameras: correct on
whether someone was at the door, whether a parcel had arrived, the car and
its colour, whether the charging cable was plugged in, and whether two doors
were open — hedging rather than guessing on the car's make. A camera question
takes about ten seconds; a photo question about five. Home Assistant ignored
the requested width for these cameras and sent 1080p frames, which the model
scales itself; the cost stays a fraction of a cent.

Because routines can ask anything, they can look too — "every night at eleven,
tell me if the garage door is open", or a motion event from Home Assistant
answered with a description of who is there.

## Two ways to talk

GPT-Live is the premium voice: full duplex, interruptible, and billed at $0.05
for every minute a session is open, whether anyone is speaking or not.
Push-to-talk (`routes/voice.ts`, `lib/speech.ts`, `src/app/ptt.ts`) is the
economy one: speech to text, the same router, text to speech — about $0.003 a
question with OpenAI for both, less with Workers AI's hearing or the device's
own recognition and voice. Not with Workers AI's speaking: English there is
Deepgram Aura 2 at $0.03 per 1,000 characters, about $0.025 a minute against
OpenAI's $0.015 (27 Sep 2026), once the small free allowance is used. Nothing automatic ever opens a GPT-Live session; the
choice is made per screen, and switching to push-to-talk ends a live session.

**Chat**, the tab beside the orb's, is the third way: for a noisy room or a
quiet one. The conversation goes to the router as text and the answer comes back as text
(`src/app/chat.ts`), so there is no speech either way and it is the cheapest of
the three — about $0.0005 a question on Luna. The router is told the answer is
read, not heard (`CHAT_INSTRUCTIONS`), so it can carry what a voice cannot:
exact figures, a number to copy, a link, a list or a table, in markdown that
the app draws as text and elements, never HTML (`src/app/markdown.ts`,
`ui/rich.ts`): a table with Copy and Download CSV (a cell a spreadsheet would
run as a formula made text first), and, only when something is asked for to
keep or read at length, a document, "# " and a title then "## " sections,
shown as a card that opens full-screen with Copy and Reply. The pages an
answer cited come with it from the web search's own citations, on the key and
the plan alike, and are drawn as cards under it, each its title and site:
nothing is fetched from those pages to draw them, so no third party sees the
screen and nothing is spent. Only typed chat is asked for any of this; voice,
the glasses, routines and jobs are not, and read only the words. All three modes share one
history, so a typed question can be followed by a spoken one; in Chat the
orb, small in the corner, still takes a single spoken question. Coming back to
the Jarvis tab returns to the way it last talked on that screen, so a
push-to-talk screen never comes back as Live.

**Photos, files and replies in Chat**, as Hark's chat has them
(`src/app/attach.ts`, `src/app/reply.ts`). "+" in the message box offers
Upload file and Take photo: up to two photos, shrunk on the device to 1600
pixels (enough to read a page in one), and two files, a PDF the model reads
page by page or a text file that reaches it as quoted data, someone else's
words (`lib/photos.ts`). Other kinds are refused with why. They go with that
one question to the router and are kept nowhere; the conversation keeps
their names, so a later question can say "that invoice". Take photo opens
the camera in the page rather than the phone's camera app, so it is the same
on a computer, a phone and the car, whose cabin camera the browser has in
Park only. Each answer has a reply button: the question then carries a hook
back to it, as Hark's do, which brings the answer into view when pressed,
and the router is given the answer's words with the question, so "close that
one" means the thing quoted however far up it was. Answers are solid and
questions see-through and quieter, so what Jarvis said stands out.

**The conversation, kept**, as Hark's chat is: what you typed or said aloud
(Live and push-to-talk), Jarvis's answers and what your routines said are
there again when the app opens, on any screen of yours. Each message is sent
to the object as it is finished (`src/app/conversation.ts`; a spoken row once
it settles), and a routine's as it is delivered; one record per person
(`lib/conversation.ts`), the last 200 messages of the past 30 days. Answers
that went wrong are not kept. Clear chat, over the conversation in Chat, takes
two taps and empties it on every open screen of yours; putting the person in
use aside on a shared screen takes theirs off it. Ending a live session no
longer forgets the conversation: the next one is seeded with it.

Kept is not what the model reads. A question carries only the last twenty
turns of the past three hours (`src/app/history.ts`); sending a month of chat
with every question would make each one dearer as the chat grew, for nothing
most questions need. So nothing is "forgotten" when the chat reaches 200:
the model stopped reading those messages long before. Two things reach
further back. What lasts is memory's: the router saves it with `remember`,
and it goes with every question however old the chat is. And when someone
refers to something older ("what did you say last week about the
insurance?"), the router can read back into the kept month with `look_back`
(`tools/conversation.ts`), which costs nothing until it is used. It needs
`memory.read`, as the conversation shared between devices does: the chat
says as much about a person as memory does. There is no summarising of old
turns: that would be a model call every few exchanges, and a longer question
every time, to keep what memory and look_back already reach.

**Search, by words only.** Chat's Search box (`lib/search.ts`,
`ui/Search.ts`) looks through the person's conversation, memory (their own
book and the family's) and mail at once, as Hark's does, and groups what it
finds as Top hit, Messages, Memory and Mail. It ranks by words, as look_back
and memory's word recall do: no model and no embeddings, so it costs nothing
and is the same on the ChatGPT plan or a key, and it counts no fact as used.
Memory needs `memory.read` and mail `mail`; a person's own messages are
theirs to search, as they are to read. It is a POST, so what was looked for
stays out of addresses and logs, and it runs on Enter, not each letter,
which would ask Gmail every time. Mail's subjects and snippets go only to the
screen, as text, never to a model.

**The router has to be Jarvis.** With GPT-Live, the live voice re-says what
the router found in its own words and manner. Push-to-talk has nothing in
between: text-to-speech reads the router's reply word for word. So a
push-to-talk request adds the persona's manner and language rules to the
router's instructions (`spokenReplyInstructions`), and links, citations and
markdown are stripped from what is spoken (`speakable`).

**Measured, not assumed.** On production in September 2026: hearing 0.9 s,
the router about 6 s (two model hops around a tool), speaking 1.4 s for a
five-second answer. Speech is made sentence by sentence, all at once, and
streamed as each piece is ready, so the voice starts about a second after the
words are known rather than after the whole answer is rendered. What remains
is the router; its reasoning effort is the obvious next lever.

**Workers AI is optional and can fail.** It needs a binding only Cloudflare
has, so Docker never sees it, and in testing MeloTTS answered every request
with an internal error while Deepgram Aura worked. Every Workers AI call
therefore falls back to OpenAI, and the settings panel's Test speaks a
sentence and hears it back, saying which provider did each half.

## Background jobs

Everything else here has to finish while a screen waits: Cloudflare ends the
work about thirty seconds after the reply, and the router has six steps. A job
does not (`lib/jobs.ts`, `routes/jobs.ts`).

**Each step runs at OpenAI, between steps the object runs the tools.** A
router job uses the Responses API's background mode: the step runs on
OpenAI's side with nobody connected, and the Durable Object's alarm looks at it
— after 4 seconds, then less often as it runs. When a step asks for tools, the
object runs them (the same `runCalls` a live question uses, sharing
`prepareRouter` for the prompt and tools) and starts the next step. The alarm
is the same one routines use, pointed at whichever is due first. Nothing is
held open for minutes, so a redeploy in the middle loses nothing: the step
carries on at OpenAI and the next alarm picks it up.

**Read; propose, never act.** A job runs with nobody watching and reads text
written by others — web pages, mail — so it reads with Jarvis's reading tools
and the MCP tools whose names say they read (`ha_get_state` in,
`ha_call_service` out; an unknown name is out). What it would do, it can only
propose (`lib/proposals.ts`): each tool that acts is handed to it as a held
copy, the same name and arguments, whose run files that one call for the
person who started the job, and the real run is never among its tools. It
cannot be talked into sending, deleting or unlocking, because nothing it has
can. The person approves with a tap, on the card the job's result brings
(`routes/proposals.ts`, under the ordinary sign-in), and the stored call runs
once, with no model, with no more than the job had, its maker still may and
the approver may, and never Hermes or a screen. The tap only claims it: the
object's alarm makes the call (`Proposals.tick`), as it makes a job's steps,
so a slow one (waking the car takes up to a minute and a half) finishes
whether or not the screen that approved it stays, which a Worker's
`waitUntil` (about 30 seconds) did not. The calls are made one at a time, in
the order they were tapped, beside the rest of what the alarm does, so a car
waking holds up nothing already due; what comes due meanwhile waits for it,
as it does for a job's step. A tap made while the alarm is busy (a job's
step, a Hermes question) waits for it: one not started within twenty
minutes, longer than an alarm may run, is not made at all. A call is taken off
the queue before it is made, so one cut short by a deploy is never made
twice, and reads as failed. It runs only as its card says:
a card shows the whole call or the call is not filed, and one that would now
read otherwise (another car first in their list, a car renamed) is refused and
keeps waiting. How risky a call is, code works
out from the tool and its arguments, when it is filed and again when it is
approved: a tool says so in its `propose` field (a car command another undoes is
reversible, unlocking is not), and every house or other MCP call that writes is
irreversible, since Jarvis keeps no list of which of the house's services can
be undone and Home Assistant decides what each does. A job's email is only ever
drafted, and its sending proposed (`lib/mail-draft.ts`), so mail has one way
out, Send. A brief proposes too (`lib/brief.ts`), but what it puts to the
person code chooses, never a model: an answer to an invitation left
unanswered (Decline when it clashes, else Accept), and archiving old
promotions. Its cards are filed before its one model call, so they wait
whatever becomes of the opening. Each has a subject (`about`): one waiting
already is listed again rather than filed twice, one tried in the last week
is not offered, and its X ("Don't suggest this again") is remembered for 30
days, from the stored record, never the request. A job's "Not now" is not
remembered, so a dismissal never blocks what the person or their job asks
for. Each card's button says what it does ("Lock", "Send", "Archive"), and an
approval checks the button against the stored call as it checks its words.
Routines otherwise act as they always have: they are what the person set up
to happen, and nothing here stands in front of the house when it is asked
directly. The decided proposal is the audit: who, when, and what came of it.
Once someone has approved a reversible call and it ran, they may let their
jobs make that one kind without asking ("car_command:lock", one mail action,
a calendar event): the kind is taken from the stored record, never from a
request, and an irreversible call, or any house or other MCP call, always
asks. Such a call is still recorded, run once even if a step is tried again,
and reported with the job's result.

**Hermes, the same way.** A question to Hermes takes one to four minutes, and
used to hold the car's tab open for the answer; closed, the answer was lost.
`ask_hermes` now starts a Hermes job and returns at once; the answer arrives as
an alert, and alerts join the conversation, so "yes, do that" after Hermes asks
something still has the question to refer to. A finished research report can
go with the question (`from`), and it goes quoted as reference, never as
instructions: it was written from strangers' pages, and Hermes can run
commands at home. It is handed over only when the person asks, never
automatically when research finishes, so what reaches a machine that can run
commands is always something they chose to send.

**Research is checked before it is sent.** Research is the same loop on a
stronger model (`RESEARCH_MODEL`) thinking hard, told to search widely and
write a report, with a Sources list made from the web search's own citations.
A report written from many searches can carry a figure no page gave, and
whoever reads it later has nobody to ask. So when the report is written it is
kept on the job as a draft, and one more turn of the same chain, with web
search still on, checks it against its sources and gives the whole report
back, corrected, ending with a "Checked:" line when something changed; the
check's own pages are listed first. Once the report is written the job gets
ten minutes more, however late it was written. The check never costs the
report: if it cannot start, fails, runs past the job's time or step limit, or
answers with notes rather than the report, the report goes out as it was
written. It makes a report cost more, by how much is to be measured: the Jobs
panel shows each one's real cost.

**Research into a table, as Hark's wide research.** "The 10 cheapest genuine
Xiaomi speakers, with seller and rating" is a research team that fills rows
(`lib/research-table.ts`): the plan fixes the columns and splits the list
between the teams (by brand, region or shop), each team gives one line per
item it found, and the merge and the check give the rows back as JSON, which
the job keeps apart (`jobtable:<id>`, at most 100 rows and 256 kB) to download
as CSV. The cells come from strangers' pages, so a cell a spreadsheet would
run as a formula is made text. A plan that gives no columns, or a merge that
gives prose, makes it the ordinary team's report, so nothing is lost.

**Research as a team, in one job.** Asked for in so many words, three teams
research the brief at once, each a chain of background responses of its own on
the one job record (`team`, beside `engine: "research"`). One record means a
team run is one of the three running jobs, one alarm steps it (its `nextAt` is
the earliest any team needs), one cancel stops every chain, and Settings →
Usage counts it once. First one call with no tools plans three angles for this
question (a purchase wants makers, owners and the case against; a trip,
getting there, staying and doing); if it cannot start, fails or answers with
anything but three good angles, fixed ones are used, so planning never costs
the run. The angles come from the user's own brief, so each reaches its team
as a user message after one fixed developer message, and the three teams share
one cached prefix. Web search runs inside a single response, so a team comes
back to the object only when it calls a function: `share_findings`, offered to
the teams alone, is that moment. What a team posts goes on the job's board, at
most four each, and the answer carries what the others posted since it last
asked, never its own. That answer is a tool output wrapped by `asQuotedData`,
never a developer message, because it was read on strangers' pages. When no
team is working, or after 35 minutes, one call with no tools merges the
reports, the board and the pages they cited, all quoted, and the result is
checked like any research report. Work is never thrown away: a team that
fails, throws three times running or passes its 12 steps is stopped and named
to the merge while the others go on; a failed merge sends each team's report as
written; a failed check sends the merged report. The owner chose to count a
team run as one of the month's research jobs although it costs about three
times as much (roughly $4–7), and to allow one at a time.

Measured on production in September 2026: a three-dashcam comparison with web
search, 57 seconds and about $0.004; a question to Hermes, 12 seconds; "look
into EV-charging cashback and let me know", said aloud, became a job the router
started itself and finished in under four minutes.

## Routines

A routine is a trigger — a moment, a time of day, an event from outside, or
"when to leave" for calendar events — and an action: a fixed message, or a
request Jarvis carries out then, with the answer sent as an alert. Shapes and
time zones are in `lib/routines.ts`, the running in `lib/scheduler.ts`, "leave
now" in `lib/leave.ts`.

**One alarm, pointed at the earliest thing due.** A Durable Object has a single
alarm. After every change and every run it is set to the earliest due moment;
the handler runs what is due and sets it again. Alarms survive restarts and
redeploys, run on the free plan, and work the same in Docker's workerd. No
Cloudflare Cron Trigger is needed: the calendar is re-read every 15 minutes by
the same alarm, only while a leave routine is on, and a routine on a cron
schedule ("0 8,12 * * *") is one more next time on it, worked out in the
deployment's zone as a daily one's is. Its minute is one number, so it runs at
most hourly: an `ask` is a paid answer each time.

**A log beside the routine.** Routines → Past runs shows a routine's last 20
runs, with the start of what each said, kept under `runs:<id>` rather than in
the routine: the routine's stored shape stays as it was, and `lastRun` stays
too, because `GET /api/v1/routines` returns it and the event cooldown reads it.
A leave routine's calendar reads ("calendar read 10:15: …") are shown as its
last run but not kept among its runs, or a read every 15 minutes would push
the warnings out.

**What a routine says is in the conversation too**, as Hark shows what its
checks found: under a pill with the routine's name, on the asking side, hooked
to its words, and pressed, the pill opens that routine in Routines
(`src/app/fromRoutine.ts`). Its alert carries the routine's id. On a screen
that is open it arrives with the alert, whichever tab is up, so "check my
email every morning and tell me what matters" lands where the answer can be
replied to. It is kept in its maker's conversation as it is delivered
(state.ts, `lib/conversation.ts`), so a screen that was closed shows it when
it opens. Each is shown once, and goes into the history, so "reply to that
one" has it to go on.

**Handled before it runs.** An alarm handler that throws is retried, so each
routine's next time (or its "done") is written before its action runs. A retry
can skip a message; it can never send one twice.

**Late is not the same as never.** If Jarvis was down, a 7:30 briefing that
wakes at noon is skipped and recorded as missed, but "call Mum at five" given
at six is still worth giving — marked with when it was due.

**A routine never outgrows whoever made it.** It keeps its creator's grants,
and a request it makes at the time runs with exactly those. A device allowed
only the house cannot schedule a question that reads the mailbox. Text arriving
with an outside event reaches the router fenced as data.

**Running a request from the object without calling itself.** A routine's
request runs the ordinary router (`run()` in routes/delegate.ts) inside the
object. Anything in there that reaches state through `stateStub(env)` — memory,
alerts — is handed the object itself rather than a stub, so it is a plain
method call, not a request from the object to itself.

**Watches cost nothing; a page watch a little.** A watch is a Home Assistant
template checked every minute, with no model. A page watch, set only from a
panel's tile, reads a public https page at the tile's own pace, at most hourly:
the page fetched, then the cheapest model with no tools asked YES, NO or
UNKNOWN. Both say their message once each time their condition comes true, and
a page's message carries the reading it rests on. Each is tried once before it
is kept, and a page watch's try is its first look, so one already true is said
at once. Ten of each at most.

**A brief is written by code, opened by one answer.** A routine's `brief`
action (lib/brief.ts) reads what its maker may reach and has set up: one read
of the calendar for its clashes, free time and invitations left unanswered
(lib/agenda.ts), the weather from Home Assistant, the car from Tessie's last
state without waking it, the day's orders and a count of old promotions (ids
only: their words are never read, lib/mail-bulk.ts), their jobs, and what
waits for their OK. Each source has ten seconds, and one that fails is a line
saying so. The document is built from those in code, so what it says of the
day is what the sources said; a model writes only its opening, at most 240
characters, from the whole day fenced as data, with links taken out. That is
the one model call, made only with a plan or a key; without one the brief goes
without an opening. Daily or once only, two each, and one an alarm: a brief is
a dozen requests of the alarm's fifty, so a second due at the same minute goes
in an alarm of its own straight after.

**"Leave now" uses what is there.** The car's position if Tessie is set up,
else the saved home; live traffic if Google Maps is set up; otherwise a plain
reminder a fixed time ahead. Routes are billed per call, so drive times are
fetched only within two hours of an event, at most every 30 minutes, and once
more at the moment of warning. If the road has cleared by then the warning
moves later, once.

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

Every `/api/*` route is gated by the owner key or a device token. The
exceptions are the Google and Spotify sign-in callbacks, which a third party
redirects to and which carry a single-use `state` value instead, and a page
Jarvis made (`/api/v1/p/<id>`, `routes/page.ts`), whose link carries its own
proof: a view link signed with a key that never leaves the Durable Object,
good for an hour, or, once an admin taps Share, a random token kept only as
its hash, until Stop sharing. A page is served on the app's own origin, beside
the stored owner key, so it is never written by the model as HTML: Jarvis gives
words in sections and one fixed template escapes them, and its policy
sandboxes it (an origin of its own) and allows no script at all. Enter the owner
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
