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
| `home` | Home Assistant, `control_home`, `ask_hermes`, `show_camera`, `/api/camera`. |
| `media` | Spotify. |
| `mail` | Gmail: `mail_check`, `mail_search`, `mail_send`, `mail_manage`, `contacts_lookup`. Reads, sends, replies, drafts, trashes and archives — there is no read-only half. Also reads Google Contacts to turn a name into an address. |
| `calendar` | Google Calendar: `calendar_check`, `calendar_add`. Reads the diary **and creates events**. |
| `screen` | `show_place`, `hide_display`, `/api/map`. |
| `voice` | `/api/session`, `/api/tts`, `/api/voices`. |

Ask for something out of reach and you get a normal answer explaining it is not
available — not an error. `tools` will be empty.

> **`*` keeps widening.** A device holding it picks up new capabilities the
> moment they are added to Jarvis, with no re-issue and no reflashing. That is
> the point of it, and also its sharpest edge: if a future MCP server can send
> mail or reach a shell, that device can too, from the day it is added. Grant
> named scopes to anything you would not want to widen silently.

Everything to do with administration — `/api/v1/devices`, `/api/mcp/*`,
`/api/spotify/*`, `/api/google/*`, `/api/diag`, `/api/probe`, `PUT /api/memory` —
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
   under a second where the router takes 8–11. Anything Assist does not
   understand goes to the router as if this step had not happened. Anything
   touching locks, doors, gates, the garage or the alarm skips Assist, so those
   still pass the router's tool allowlist. Switch this off with `G2_FASTPATH=0`.
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
when a `session.delegation.created` arrives, POST the transcript to
`/api/v1/ask` and feed the answer back with `session.commentary.append`. The
Worker does not do this for you.

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
