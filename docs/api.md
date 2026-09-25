# Jarvis device API

For anything that is not the car: a microcontroller, a pair of smartglasses, a
script. One `POST`, one JSON object back.

Base URL: `https://jarvis.example.com`

## Start here

If this returns `200`, your token works and everything else is detail.

```bash
curl -i https://jarvis.example.com/api/health \
     -H "Authorization: Bearer jdv1_your_token_here"
```

```json
{ "ok": true, "ts": 1789718254426 }
```

## Asking it something

```bash
curl -X POST https://jarvis.example.com/api/v1/ask \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"text":"how much charge is left in the car?"}'
```

```json
{
  "ok": true,
  "text": "The car has 64 percent charge left, with about 164 kilometres of range.",
  "tools": ["car_state"],
  "ms": 9592,
  "requestId": "r_4b1e9c02"
}
```

### Request

| Field | Type | Notes |
|---|---|---|
| `text` | string | **Required.** The question, as a person would say it. |
| `context` | array | Optional prior turns, `{"role":"user"\|"assistant","text":"…"}`. Last 100 items, 4 000 chars each, 20 000 total; the excess is dropped silently. |
| `timeout` | number | Seconds to wait. Default `60`, maximum `120`. |
| `clientRef` | string | Echoed back untouched, for your own logs. 64 chars. |

Whole body must be under 32 KB.

### Response

`text` is **always present and always speakable, including on every error.** A
device can do `speak(response.text)` unconditionally and never be silent. That is
deliberate — firmware should not have to branch before it has something to say.

| Field | Notes |
|---|---|
| `ok` | Whether the agent answered. |
| `text` | What to say. Always present. |
| `tools` | Which tools actually ran. Empty if none did. |
| `ms` | How long it took. |
| `requestId` | Quote this if you need to ask what happened. |
| `error` | Only when `ok` is false. See below. |

| `error` | Means |
|---|---|
| `timeout` | Still working when your `timeout` expired. The work gets about 20 more seconds to finish on its own, then is stopped; anything it had already learned is saved, but whatever it was still waiting on — typically a slow answer from home — is lost, and nobody will see it. For questions that may take longer than your `timeout`, use `/api/v1/stream`. |
| `failed` | It tried and could not. `detail` carries a truncated reason. |
| `aborted` | The connection dropped, or the turn was cut off partway. |

### Status codes

The rule: **HTTP says whether the request was accepted and processed; the body
says what the agent concluded.** So an agent-level failure is still `200` with
`"ok": false`, and `if (status == 200) speak(text)` is correct in every case.

| Code | Means |
|---|---|
| `200` | Processed. Read `ok`. |
| `400` | Malformed body, or no `text`. |
| `401` | Token missing, unknown, revoked or expired. |
| `403` | Your token lacks the scope this needs. The body names which. |
| `413` | Body over 32 KB. |
| `429` | Rate limited or out of daily budget. Honour `Retry-After`. |
| `503` | The Worker is missing a credential it needs. |

### Retrying is not safe by default

`/api/v1/ask` is **not idempotent.** `remember`, `car_command` and `music_play`
all change something, so a blind retry can set a destination twice or save a fact
twice. On `timeout` in particular the original request may *still be running* for
up to about 20 seconds, and an action it had already started may still complete.

Retry on `429` (after `Retry-After`) and on a connection error before any bytes
arrive. Do not retry a `200` you did not like, and do not retry a `timeout`
without deciding whether doing the thing twice matters.

## Authentication

Two headers work. Both carry the same value.

```
Authorization: Bearer jdv1_…       ← use this one
X-Jarvis-Key: jdv1_…
```

Prefer `Authorization: Bearer`, because the Worker's log redaction strips that
form and does not strip `X-Jarvis-Key`.

A device token looks like `jdv1_` followed by 32 characters from
`abcdefghijkmnpqrstuvwxyz23456789` — lowercase, no `l`/`o`/`0`/`1`, so it
survives being read off a screen. 160 bits.

**Send it exactly as issued.** The owner's own key is normalised (uppercased,
punctuation stripped) because it gets typed on a car touchscreen; device tokens
are not, and never should be.

**This is a bearer credential: whoever holds it is the device.** It is stored
only as a SHA-256 digest, so a lost token cannot be recovered — mint a new one
and revoke the old.

## Scopes

Every token carries what it may reach. The agent is only ever *shown* the tools
your scopes allow, so a tool you were not granted cannot be invoked, talked into
existence, or argued around.

| Scope | Unlocks |
|---|---|
| `*` | Everything, **including capabilities added in future**. |
| `ask` | The baseline. Needed to call the agent at all. Web search, `place_info` (ratings, opening hours, reviews), `recall`-free questions. |
| `memory.read` | `recall`; `GET /api/memory`, `POST /api/memory/search`. |
| `memory.write` | `remember`, `forget`. |
| `car.read` | `car_state`, `directions`. |
| `car.control` | `car_command` — including unlock and sending a destination. |
| `home` | Home Assistant, `control_home`, `ask_hermes`, `show_camera`, `look_at_camera`, `/api/camera`. |
| `media` | Spotify. |
| `mail` | Gmail: `mail_check`, `mail_search`, `mail_send`, `mail_manage`, `contacts_lookup`. Reads, sends, replies, drafts, trashes and archives — there is no read-only half. Also reads Google Contacts to turn a name into an address. |
| `calendar` | Google Calendar: `calendar_check`, `calendar_add`. Reads the diary **and creates events**. |
| `screen` | `show_place`, `hide_display`, `/api/map`. |
| `voice` | `/api/session`, `/api/tts`, `/api/voices`, and push-to-talk `/api/v1/voice` (which also needs `ask`). |
| `ask` (jobs) | `/api/v1/jobs`, `/api/v1/jobs/cancel`, `start_job`. A job for Hermes also needs `home`. Each job runs with its creator's grants, and only their reading tools. |
| `routines` | `/api/v1/routines`, `/api/v1/routines/run`, `/api/v1/trigger`; `routine_add`, `routine_list`, `routine_remove`. A routine's question runs with **its creator's** grants, never more. |
| `alerts` | Receiving alerts (`/api/v1/events`, `/api/v1/push`, `/api/v1/alerts`), raising one (`/api/v1/notify`), and `send_note`. The same scope both ways: a device that may be told things may ask to be told something. |

Ask for something out of reach and you get a normal answer explaining it is not
available — not an error. `tools` will be empty.

> **`*` keeps widening.** A device holding it picks up new capabilities the
> moment they are added to Jarvis, with no re-issue and no reflashing. That is
> the point of it, and also its sharpest edge: if a future MCP server can send
> mail or reach a shell, that device can too, from the day it is added. Grant
> named scopes to anything you would not want to widen silently.

Everything to do with administration — `/api/v1/devices`, `/api/alerts`, `/api/mcp/*`,
`/api/spotify/*`, `/api/google/*`, `/api/diag`, `/api/probe`, and adding, editing
or forgetting through `/api/memory` (`POST`, `PUT`, `DELETE`) —
is reachable **only with the owner's key**, whatever scopes a device holds. A
device can never mint its own successor.

> **`mail` is the widest scope here after `*`.** It can read every message in
> the account, send as the account holder, and move messages to the trash.
> There is no read-only variant: a token either has mail or it does not. Do
> not grant it to anything you would not hand the mailbox to.
>
> It cannot delete anything permanently. That needs the `mail.google.com`
> OAuth scope, which the Worker does not request — trashed mail sits in Trash
> for 30 days and `mail_manage` can restore it.

## Limits

| | |
|---|---|
| Body | 32 KB |
| Conversation | 100 turns, 4 000 chars each, 20 000 total |
| Burst | 20 requests / 60s per device |
| Daily | 500 requests per device (`DEVICE_DAILY_LIMIT`) |
| Tool hops | 6 per question |
| Wait | 60s default, 120s maximum |

Burst limiting is enforced per Cloudflare location rather than globally, so it
bounds a runaway loop rather than acting as a hard global cap. The daily budget
is the one that protects the bill. The owner's key is never limited.

## Managing devices

Owner key only.

```bash
# Mint. The token is shown ONCE and cannot be recovered.
curl -X POST .../api/v1/devices -H "X-Jarvis-Key: $OWNER" \
     -H 'Content-Type: application/json' \
     -d '{"name":"garage esp32","scopes":["ask","car.read"]}'

curl .../api/v1/devices -H "X-Jarvis-Key: $OWNER"          # list

curl -X PATCH .../api/v1/devices -H "X-Jarvis-Key: $OWNER" \
     -d '{"id":"d_85cca711","revoked":true}'               # revoke

curl -X PATCH .../api/v1/devices -H "X-Jarvis-Key: $OWNER" \
     -d '{"id":"d_85cca711","scopes":["ask"]}'             # narrow it, same token
```

Re-scoping keeps the token, so a device can be reined in without being reflashed.
Revoking is permanent — a token nobody should trust is not worth resurrecting.

**Revocation takes up to 60 seconds** to be felt everywhere, because credential
reads are edge-cached for that long. That is a property, not a fault; if you need
it instant, rotate the owner key too.

## Writing ESP32 firmware

Two things cost people a weekend, and neither is about this API:

1. **Set the clock before TLS.** A fresh ESP32 believes it is 1970, so every
   certificate looks not-yet-valid and TLS fails with nothing useful in the log.
   Call `configTime()` and wait for it *before* the first HTTPS request.
2. **Do not use `setInsecure()`.** It disables certificate validation entirely,
   which on a token that can operate your car is not a shortcut worth taking.

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

const char* SSID  = "...";
const char* PASS  = "...";
const char* TOKEN = "jdv1_................................";
const char* URL   = "https://jarvis.example.com/api/v1/ask";

// ISRG Root X1, which is what Let's Encrypt issues from. Replace if that changes.
const char* ROOT_CA = "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n";

void setup() {
  Serial.begin(115200);
  WiFi.begin(SSID, PASS);
  while (WiFi.status() != WL_CONNECTED) delay(250);

  // Before any TLS: an unset clock makes every certificate look invalid.
  configTime(0, 0, "pool.ntp.org");
  while (time(nullptr) < 1700000000) delay(200);
}

String ask(const String& question) {
  WiFiClientSecure tls;
  tls.setCACert(ROOT_CA);

  HTTPClient http;
  http.begin(tls, URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + TOKEN);
  // A slow question can take the better part of a minute.
  http.setTimeout(70000);

  JsonDocument req;
  req["text"] = question;
  req["clientRef"] = "garage-esp32";
  String body;
  serializeJson(req, body);

  int code = http.POST(body);
  String out = "I could not reach Jarvis.";

  if (code == 200) {
    JsonDocument res;
    if (!deserializeJson(res, http.getString())) {
      // `text` is present whether or not `ok` is true, so this is always safe.
      out = res["text"].as<String>();
    }
  } else if (code == 429) {
    out = "Too many requests. Try again shortly.";
  } else if (code == 401 || code == 403) {
    out = "This device is not allowed to do that.";
  }

  http.end();
  return out;
}

void loop() {
  Serial.println(ask("how much charge is left in the car?"));
  delay(60000);   // never hammer it: 20 requests a minute is the ceiling
}
```

## Photos

A question from a device can carry a photo to ask about — glasses with a
camera, say. On `/api/v1/voice`, add up to two
as `image` files in the form, or as `images` (data: URLs) in JSON; on
`/api/v1/stream` (and the app's `/api/delegate`), as `images`. JPEG, PNG or
WebP, up to about 2 MB each — shrink them to about 1024 pixels first; the
model sees no more in a larger one. They go to the router beside the
question and are never stored.

```
POST /api/v1/voice
{"text": "What am I looking at?", "images": ["data:image/jpeg;base64,…"], "reply": "text"}
```

## Push-to-talk voice

`POST /api/v1/voice` takes one spoken question and gives back a spoken answer —
no live session, paid per question. It is what a $10 microphone-and-speaker
board should use.

```
POST /api/v1/voice?format=wav&thread=kitchen
Content-Type: audio/wav            (or audio/webm, audio/ogg, audio/mpeg, audio/mp4…)
Accept: audio/wav
X-Jarvis-Key: <device token with voice and ask>

<the recording, up to 3 MB>
```

With `Accept: audio/*` the body is just the answer's audio — `format=wav` is
24 kHz, 16-bit mono; `pcm` is the same without a header; `mp3` and `opus`
too — and the words come in headers, URI-encoded: `X-Jarvis-Transcript` (what
was heard), `X-Jarvis-Text` (what was said), `X-Jarvis-Ok`. `thread` is any
short id: questions on the same thread within five minutes are understood as
a conversation, so "and tomorrow?" works.

Without that `Accept`, the answer is JSON:
`{ok, transcript, text, tools, heardBy, audio: {format, mime, by, data}}`,
`data` being base64. `{"text": "…"}` as JSON instead of a recording skips the
hearing, for a device that recognised the speech itself; `reply=text` skips
the speaking. The app sends `multipart/form-data` — an `audio` file and an
`options` JSON field — with `Accept: text/event-stream`, and gets `transcript`,
`progress`, `display`, `result`, then the answer's speech sentence by sentence
as `audio` events, so it starts talking about a second after the words are
ready.

How it hears and speaks is set in Settings → Push-to-talk voice: OpenAI
(default; any language, mixed ones too), Cloudflare Workers AI (cheapest;
needs `"ai": {"binding": "AI"}` in wrangler.jsonc; English speech only, via
Deepgram Aura), or the device itself. Anything unavailable falls back to
OpenAI. People and places saved in memory are passed to the recogniser as
hints, so names are heard right.

## Alerts

Jarvis can speak first. An alert walks an ordered list of channels and stops
at the first that reaches you: an **open Jarvis screen that someone is looking
at**, then **notifications** on each browser where they were turned on, then
the optional channels set in Settings → Alerts (Telegram, ntfy, a webhook,
Home Assistant). An urgent alert goes to all of them. The order is the
`ALERT_ORDER` setting.

### Raising one

```
POST /api/v1/notify
{"text": "Leave in ten minutes.", "title": "Office", "urgent": false, "speak": true}
```

`text` is required (up to 1,500 characters); `title` defaults to "Jarvis";
`speak: false` shows it without saying it. The answer says where it went:

```json
{"id": "k3v…", "deliveredBy": "push",
 "attempts": [{"channel": "live", "ok": false, "detail": "1 screen open, none in front of anyone"},
              {"channel": "push", "ok": true, "detail": "1 of 1 device accepted"}]}
```

`502` means no channel took it — the body still lists what was tried. Home
Assistant, Node-RED or IFTTT can raise alerts this way with a device token
holding only `alerts`.

### Receiving them on a socket

`GET /api/v1/events` is a WebSocket. A client that can send a header connects
with its token as usual. A browser cannot, so it first asks
`POST /api/v1/events/ticket` (`{"label": "phone"}` → `{"ticket", "expiresIn": 60}`)
and connects to `/api/v1/events?ticket=…`. A ticket works once.

| Direction | Message |
|---|---|
| ← | `{"type":"hello","label":…}` on connecting |
| ← | `{"type":"alert","alert":{id, at, title, text, speak, urgent, source}}` |
| → | `{"type":"presence","visible":true}` whenever the screen is shown or hidden |
| → | `{"type":"ack","id":…,"visible":true}` on each alert, if someone can see it |
| → / ← | `ping` / `pong`, every 25 seconds or so, to keep proxies from closing it |

An alert counts as delivered live only when a **visible** screen acknowledges
it within four seconds; otherwise the next channel is tried. A device that
always shows what it receives (a display, a speaker) can simply report itself
visible. Close code `4001` means the token was revoked: stop reconnecting.

The socket costs nothing while quiet. The Durable Object holding it hibernates,
and the runtime answers the pings itself.

### Notifications

`GET /api/v1/push` returns the VAPID `publicKey` to subscribe with;
`POST /api/v1/push` with `{"subscription": PushSubscription.toJSON(), "label"}`
registers the browser, `DELETE` with `{"endpoint"}` removes it. Only the push
services browsers use (Google, Apple, Mozilla, Microsoft) are accepted as
endpoints. A tapped notification carries only the alert's id; the text is
`GET /api/v1/alerts?id=…` for about the last thirty alerts. On iPhone and
iPad, notifications need the app added to the Home Screen first.

### The webhook

Each alert is POSTed as JSON: `{"event":"alert", id, at, title, text, speak,
urgent, source}`. With a signing secret set, `X-Jarvis-Signature` is
`sha256=` and the hex HMAC-SHA256 of the raw body:

```js
const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-jarvis-signature"] ?? ""))) reject();
```

`at` is in the signed body, so a receiver can refuse old replays.

## Background jobs

Work that takes minutes — research, comparisons, going through mail, a
question for Hermes — started now and answered later, whatever screens are
open. The result arrives as an alert (a summary, or all of it when it is short)
and stays readable in full.

```
POST /api/v1/jobs
{"title": "Dashcams", "task": "Compare three dashcams under RM800 …", "engine": "jarvis"}
```

`engine` is `jarvis` (default: the router, many steps, in OpenAI's background
mode) or `hermes` (one question to the Hermes agent; needs `home`). `task` must
be complete on its own: a job never sees a conversation. `GET /api/v1/jobs`
lists them (a device sees its own); `GET ?id=` returns one with its whole
result; `POST /api/v1/jobs/cancel {id}` stops one; `DELETE ?id=` removes it.

A job may READ — web search, mail, calendar, memory, contacts, the car,
cameras, and the reading tools of MCP servers (judged by name: `get`, `list`,
`search`… in, `set`, `call`, `control`… out) — and nothing else. It cannot
send, book, delete, unlock or switch anything; when the work leads to an
action, it says what it would do. At most 3 run at once and 30 are started a
day; one is stopped after 25 steps or 20 minutes.

## Routines

Things Jarvis does by itself, with the result sent as an alert (above). They
live in the Durable Object and run from its alarm, so they survive restarts and
redeploys and need no screen open.

```
POST /api/v1/routines
{"when": "daily", "time": "07:30", "days": ["mon","tue","wed","thu","fri"],
 "ask": "What's my first meeting, and the traffic to work?", "name": "Briefing"}
```

| `when` | Also needs |
|---|---|
| `once` | `localTime` (`"2026-09-26T17:00"`, in the time zone set in Settings), or `inMinutes`, or `at` (ms since the epoch) |
| `daily` | `time` (`"HH:MM"`), optional `days` (`"mon"`…`"sun"` or 0–6, Sunday first; absent = every day) |
| `event` | `event`: a name like `arrived_home` |
| `leave` | optional `bufferMin` (default 10). No message: it warns before each calendar event with a place |

Every kind but `leave` takes exactly one of `say` (a fixed message) or `ask`
(a request for Jarvis, answered at the time with the creator's grants and sent).
`GET /api/v1/routines` lists them with plain-English `when` and `does`, the
next run and the last result; `PATCH` takes `{id, enabled?, name?}`; `DELETE
?id=` removes one; `POST /api/v1/routines/run {id}` runs one now.

A daily routine more than 30 minutes late (Jarvis was not running) is skipped
rather than sent at the wrong time; a one-off reminder up to 12 hours late is
still given, marked with when it was due.

### Setting one off from outside

```
POST /api/v1/trigger
{"event": "arrived_home", "text": "optional detail, passed along"}
```

Every enabled `event` routine waiting for that name runs, each at most once a
minute however often the event arrives. The answer lists the routines it
started. Give the sender a device token holding only `routines`. `text` reaches
an `ask` fenced as data, never as instructions.

### Leave now

With a `leave` routine on, the calendar is read every 15 minutes for the next
four hours. For each timed event with a place (not a video call, not declined),
the warning comes at *start − drive time − spare minutes*. The drive time is
from the car's position (Tessie) or else the place saved as "home", in live
traffic (Google Maps), fetched at most every 30 minutes inside two hours of the
event and once more at the moment of warning. Without Maps or a starting point
it is a plain reminder 30 minutes plus the spare before the start. Without
Google Calendar it cannot work, and the routine's last result says so.

## Streaming, if you want progress

`POST /api/v1/stream` takes `{"transcript":[…]}` and returns Server-Sent Events.
Use it when a question may run for minutes and you want to say something in the
meantime. Most devices should not bother.

- Frames are `data: {json}\n\n`. **There are no `event:`, `id:` or `retry:` lines.**
- `: ping\n\n` arrives every 15 seconds. Skip those; treat a gap as a dead link.
- **There is no `[DONE]` sentinel.** The stream simply ends.
- Event `type` is one of `progress`, `tool`, `used`, `display`, `result`, `error`.
- Exactly one of `result` or `error` is terminal — **except when the turn is
  aborted**, where the stream can close having sent neither. Treat end-of-stream
  without either as a failure, as `/api/v1/ask` does internally.

`EventSource` cannot be used: it is GET-only and cannot set headers. Use a real
HTTP client and read the body as it arrives — `src/app/delegate.ts` is the
reference implementation.

## Even Realities G2 glasses

`POST /api/v1/chat/completions` lets the G2 glasses use Jarvis as Even AI. It is
`/api/v1/ask` in the shape the Even app reads, an OpenAI chat completion, so no
firmware or app changes are needed. Requires `ask`.

In the Even app: **Settings → Even AI → Agent configuration → Add agent**.

| Field | Value |
|---|---|
| Name | `Jarvis` |
| URL | `https://jarvis.example.com/api/v1/chat/completions` — the **full** path; the app appends nothing |
| Token | a device token (`jdv1_…`) minted as above |

Then tap the agent's name: saving does not select it.

Suggested scopes for the glasses: `ask`, `home`, `memory.read`, `memory.write`,
`calendar`, `mail`, `media`. There is no `screen` channel on this route, and
`voice` and `car.control` are not needed.

**What the app does**, measured against `EvenCore/1.0`, the real app:

- It sends `{"model":"openclaw","messages":[…]}` with only the latest message
  in it, never a transcript. `model` is ignored here.
- It never streams, and hangs up after **300 seconds**.
- Its display draws about **400–500 characters**, then shows "Struggling to render
  more...". Nothing is spoken.
- Speech never reaches this API: the phone app transcribes, including Malay.

**What this route does about it:**

1. **Assist first.** When the device has `home`, the question goes to Home
   Assistant's own Assist (`conversation.home_assistant`) with a 3s limit. If it
   switches a light or reads a sensor, that answer comes straight back, in well
   under a second where the router takes 8–17. Anything Assist does not
   understand goes to the router as if this step had not happened. For locks,
   doors, gates, the garage and the alarm, only closing, locking or arming them,
   or a question about them ("is the main gate closed?"), tries Assist. Anything
   that would open one, or does not say which way, skips Assist and still passes
   the router's tool allowlist. Switch this off with `G2_FASTPATH=0`.
2. **Follow-ups.** The last six turns per device are kept for five minutes in the
   Durable Object, so "turn it off" knows what "it" is.
3. **Length.** The router is told the answer is going to the glasses, and the
   reply is cut at a sentence boundary to `G2_CHAR_BUDGET` characters (default
   350) with markdown and emoji removed.
4. **Always a 200.** A timeout or a router error comes back as readable text in
   the completion, because any other status makes the glasses show only "AI
   server error". A body with no user message is still a 400.

It waits `G2_WAIT_S` seconds (default 240) before answering that it is still
working, which leaves room for most Hermes questions.

## Live voice

`POST /api/session` relays a WebRTC SDP offer to OpenAI and returns the answer.
The OpenAI key never leaves the Worker. Requires `voice`.

```json
→ {"sdp":"v=0\r\n…","voice":"cedar","history":[]}
← {"sdp":"…","sessionId":"…","voice":"cedar","restoredTurns":0}
```

The session is created with `delegation: {type:"client"}`, which means **your
client must close the loop itself**: listen on the `oai-events` data channel, and
when a `session.delegation.created` arrives, send the conversation to
`/api/v1/stream` as `{"transcript":[…]}` — or the latest question to
`/api/v1/ask` as `text`, with earlier turns as `context` — and feed the answer
back with `session.commentary.append`. The event carries no task text, which is
why the conversation has to be sent. The Worker does not do this for you.

Permitted client events: `session.commentary.append`,
`session.thinking.append`, `session.input_audio.mute`,
`session.input_audio.unmute`, `session.close`.

**For smartglasses, consider not doing any of this.** If they can load a web
page, point them at `https://jarvis.example.com` — it is already a web app
that implements the whole loop, and it already copes with a narrow viewport
because the car gives it one while driving. Enter a device token once on the
unlock screen and it is remembered.

## Cross-origin browsers

Irrelevant to native clients and microcontrollers — CORS is enforced by browsers,
not servers. If a browser-based client runs on a *different* origin, set
`JARVIS_ALLOWED_ORIGINS` to a comma-separated list of exact origins. No wildcards
and no suffix matching. Loading the app from this domain needs none of it.

## Not part of this contract

`/api/probe`, `/api/diag`, `/api/mcp/*`, `/api/memory`, `/api/spotify/*` and
`/api/delegate` are internal and may change without notice. `/api/delegate` in
particular is the browser's own route; use `/api/v1/stream`, which is the same
thing under a name that will not move.
