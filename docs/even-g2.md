# Jarvis on Even Realities G2 glasses

**Say "Hi Even" and ask.** That is all there is to it. Jarvis takes the place
of Even AI, the assistant already built into the glasses, so the wake word you
use today reaches your own Jarvis. Unlike an app from Even Hub, there is
nothing to open and no menu to find on the glasses: hands-free, whatever you
are doing.

"Hi Even, open the main gate." "Hi Even, what's my next meeting?" "Hi Even,
remind me at five to call the office." The Even app on your phone turns what
you say into text and sends it to your Jarvis, and the answer appears on the
display. House commands go straight to Home Assistant and are done in about a
second. Everything else goes to Jarvis's AI, with the same tools as in the car:
calendar, mail, memory, the car, the web, your own agents.

```
G2 glasses
  │ Bluetooth
Even app on your phone
  │ speech → text, HTTPS
Your Jarvis
  ├─▶ Home Assistant
  │     house commands, ~1 s
  └─▶ the AI and its tools
        the rest, 3–15 s
```

Setting it up takes about ten minutes: a token in Jarvis, an agent in the
Even app, and optionally Home Assistant.

## Why Jarvis, and not an agent connected directly

The Even app will take any agent that speaks the OpenAI chat API, and before
Jarvis, people connected OpenClaw or a Hermes agent to it directly. That works,
with two problems:

- **It is slow.** A general-purpose agent works its way through every
  question, even "turn off the study light". A question to Hermes takes from
  half a minute to four minutes; "how warm is the master bedroom?" took 74
  seconds through Hermes and 11 through Home Assistant directly. Meanwhile the
  glasses wait, and the Even app gives up on an answer that takes too long.
- **The answer does not fit.** Such an agent writes as it would in a chat
  window: at length, with headings and lists. The G2 display draws 400 to 500
  characters, then shows "Struggling to render more...", and its font drops
  formatting and emoji, leaving gaps in the text.

Jarvis sits between the glasses and everything else, and takes the quickest
route to each answer:

| "Hi Even, …" | An agent connected directly | Jarvis |
|---|---|---|
| "open the main gate" | the agent's whole loop, often a minute or more | Home Assistant's Assist: about a second |
| "how much charge has the car got?", "what's my next meeting?" | through the agent | Jarvis's own tools, straight to the car and Google: seconds |
| "what's Aisha's number?" | the agent's memory, on the slow path | Jarvis's own memory, on hand for every question |
| any answer | as long as the agent writes it | written for the display: the point first, under 350 characters, plain text, cut at a sentence |
| "compare the three cheapest EV chargers and let me know" | the glasses wait, and the app may give up | a background job: Jarvis says it has started, and the result arrives as an alert when ready |

**Your agent is still there.** With Hermes set up in Jarvis (**Settings →
Hermes**), say "Hi Even, ask Hermes to …". Jarvis hands the question over as a
background job and answers at once, and Hermes's reply arrives as an alert
when it is ready, however long it takes (see [What to expect](#what-to-expect)).
And any MCP server you add in Jarvis's settings is a tool Jarvis can use too.

## Before you start

- **Jarvis running, and reachable from your phone over HTTPS.** Deployed to
  Cloudflare, it already is. With Docker, give it a public HTTPS address
  first — see [Using it from a phone](../README.md#run-with-docker). The
  glasses ask through your phone, so an address that works only on your home
  network works only at home.
- **An OpenAI key** in Jarvis's settings, as for everything else.
- **The G2 paired** with the Even app, and Even AI working with Even's own
  assistant.
- **Optional: Home Assistant**, for instant house commands (step 4).

## 1. Make a token for the glasses

The glasses get their own token, so they can reach only what you allow, and
you can shut them out without touching anything else. Do this on your phone:
the token has to be pasted into the Even app, and it is 37 characters long.

1. Open Jarvis on your phone and sign in with your owner key.
2. Open the menu (**☰**) → **Devices**.
3. Name it, e.g. `G2 glasses`.
4. Tick what the glasses may do:

   | Tick | So you can say |
   |---|---|
   | `ask` — **required** | anything at all: questions, the web, background jobs |
   | `home` | "turn off the study light", "is the gate closed?" — and Assist, step 4 |
   | `memory.read`, `memory.write` | "what's Aisha's number?", "remember that the plumber is Ben" |
   | `calendar`, `mail` | "what's my next meeting?", "any mail from the bank?" |
   | `car.read` | "how much charge has the car got?" |
   | `media` | "play some jazz", "skip this song" |
   | `routines` | "remind me at five to call the office" |
   | `alerts` | "send that to my phone" |

   Leave off `screen` and `voice` (the glasses show text only, and use neither).
   Leave off `car.control` unless you want to lock, unlock or open the car from
   your glasses, and avoid "everything", which also covers whatever is added
   in later versions.
5. **Create token**, then **Copy**. It is shown once, and only this once.
   Lost it? Revoke it and make another. To change what a token may do later,
   make a new one the same way and revoke the old.

## 2. Add Jarvis to the Even app

1. In the Even app: **Settings → Even AI → Agent configuration → Add agent**.
2. Fill in:

   | Field | Value |
   |---|---|
   | **Name** | `Jarvis` |
   | **URL** | `https://jarvis.example.com/api/v1/chat/completions` — your Jarvis address, **with** `/api/v1/chat/completions` on the end. The app adds nothing to it. |
   | **Token** | the token from step 1 (`jdv1_…`) |

3. Save.
4. **Tap Jarvis in the list, so the checkmark moves to it.** Saving does not
   select it. If the app shows an "Even AI is active" message, dismiss it
   first.

This is the same menu people use to connect other agents, such as OpenClaw,
and it is there for every G2 owner. If you cannot find it, update the Even
app.

## 3. Try it

Say **"Hi Even"** to the glasses, then ask. Try:

- "What's on my calendar today?"
- "What's the weather tomorrow?"
- "Remind me at five to call the office."

Then look in Jarvis under **☰ → Devices**: your glasses should say *seen just
now*. If they do not, the question never reached Jarvis — see
[When it doesn't work](#when-it-doesnt-work).

## 4. Instant house commands (optional)

Without this, "turn off the study light" still works, through the AI, in 5 to
15 seconds. With it, Home Assistant's own Assist does it in about a second,
and it costs nothing.

1. In Jarvis: **Settings → Home**. Fill in **Base URL** (your Home Assistant
   address, reachable from the internet, e.g. a Nabu Casa address) and a
   **Long-lived token** (Home Assistant → your profile → Security → Long-lived
   access tokens). **Test** checks both.
2. **Try Assist first** is on by default. Set **Assist language** to the
   language you speak to the glasses, if Home Assistant supports it.
3. In Home Assistant: **Settings → Voice assistants → Expose**, and expose
   what the glasses may control.

**Exposing is the limit.** Whatever you expose to Assist can be operated by
voice from the glasses, gates and locks included, and Jarvis adds no second
check in front of it. Expose what you are happy to control that way, and
nothing more.

Every question tries Assist first. Assist does what it understands —
switching things, opening and closing, reading a sensor ("is the main gate
closed?"). Anything else, it passes on within a second or so, and the AI
answers as before. Assist knows things by the names they have in Home
Assistant, so use those, or give things aliases there.

## Settings for the glasses

In Jarvis, **Settings → Devices**:

| Setting | Default | What it does |
|---|---|---|
| Glasses: characters shown | 350 | The longest answer sent. The G2 display gives up at about 400–500 characters. |
| Glasses: seconds to wait | 240 | How long Jarvis works on an answer before saying it is still busy. The Even app hangs up at 300. |
| Requests per device per day | 500 | A cost ceiling for every device token. |

## What to expect

- **Text only, and short.** Answers are written for the display: the point
  first, about 350 characters, no formatting. Ask a follow-up for more.
- **Follow-ups work** for five minutes: "turn it off", "and tomorrow?".
- **Any language.** The Even app transcribes what you say, Malay included,
  and Jarvis answers in the language you asked in.
- **How long:** house commands through Assist, about a second. Most other
  questions, 3 to 15 seconds. Longer work ("look into dashcams under RM800 and
  let me know") becomes a background job; its result arrives later as an
  alert, on an open Jarvis screen or as a notification on your phone once
  notifications are on there (**Settings → Alerts**).
- **Jarvis cannot start a conversation on the glasses.** The Even app only
  asks. Alerts and reminders go to your phone and any open Jarvis screen.

## When it doesn't work

| What you see | Why | What to do |
|---|---|---|
| "AI server error" straight away | The URL is wrong, usually missing `/api/v1/chat/completions`; or the token is wrong or revoked. | Check the URL. Make a new token (step 1) and paste it in again. |
| "AI server error" after a while | The phone cannot reach Jarvis (a home-only address, a VPN), or your Even app gives up sooner than 300 seconds — older versions did after about 30. | Open your Jarvis address in the phone's browser to check it loads. If it does, set **Glasses: seconds to wait** to `25`. |
| Even's own assistant answers | Jarvis was saved but not selected. | Tap Jarvis in the agent list, so the checkmark moves to it. |
| Devices never says *seen* | The question is not reaching Jarvis. | As for "AI server error" above. |
| "That is taking longer than I can wait on" | The answer took longer than **Glasses: seconds to wait**. | Ask again in a moment. For long work, say "…and let me know", and it runs as a background job. |
| The text stops with "Struggling to render more..." | The answer is longer than the display. | Lower **Glasses: characters shown**, e.g. to `300`. |
| House commands take 5 seconds or more | Assist did not understand, so the AI did it. | Check Home is set up and **Try Assist first** is on; the thing is exposed to Assist; you used its Home Assistant name; **Assist language** matches what you speak. |
| "I can't do that" for mail, the car, … | The token lacks that permission. | Make a new token with it ticked, and revoke the old one. |
| It stops answering late in the day | The daily limit for the device is used up. | Raise **Requests per device per day**. |

## Keeping it safe

- The glasses' token reaches only what you ticked, and **Revoke** in
  **☰ → Devices** shuts them out at once. Never put your owner key in the
  Even app.
- What you ask goes from the Even app to your own Jarvis, then to Home
  Assistant or OpenAI to be answered. Jarvis keeps the last few exchanges per
  device, for five minutes, for follow-ups.
- What the house will do is set in Home Assistant, by what you expose to
  Assist (step 4).

## For developers

The protocol — what the Even app sends, measured against the real app, and
what this route does about it — is in the
[device API reference](api.md#even-realities-g2-glasses).
