# Changelog

What changed in each version of Jarvis, newest first.

Versions follow [semantic versioning](https://semver.org), read from the side
of someone running their own copy:

- **Major** (2.0.0) — updating needs you to do something: a new secret, a
  changed setting, a step to run. It is listed under **Action needed**.
- **Minor** (1.1.0) — new features. Update and carry on.
- **Patch** (1.0.1) — fixes only.

The version you are running is at the foot of the menu in **Settings**, which
also says when a newer one is out. To hear from GitHub instead, choose
**Watch → Custom → Releases** on the repository. How to update is at the foot
of every release, and in the [README](README.md#updating).

## [Unreleased]

### Added

- **Edit a memory** in Memory: each saved fact has an Edit button beside
  Forget, to change its words where it is, and a person's or place's name
  and a place's address. It keeps everything else about the fact: when it
  was saved, how often it has been used, and whether it is kept forever.

### Changed

- **Sharing a car says what it shares.** In Family → Cars the levels are now
  *can check it* (where it is, the battery, the climate) and *can control it*
  (commands too, lock and unlock among them), not "may see it" and "may drive
  it": they only ever decided what Jarvis will do with the car for someone,
  and who can drive it is up to the Tesla app or key. What each level allows
  is unchanged.

### Fixed

- A memory moved to the family's, or back, was labelled "added here" even
  when it had come by voice. It keeps saying where it came from now.

## [2.1.0] - 2026-09-28

### Changed

- **Family and Memory are laid out as Settings is**: a menu on the left, one
  section open beside it, and on a phone the menu first. In Family, each
  person has a page of their own; in Memory, each kind of fact (places,
  people, notes) yours and the family's, with how many there are.

### Fixed

- Four small things: in Family, a button waiting for its second tap (Remove
  it?, Sign out here?) now turns red as it does elsewhere; when the
  browser's own speech recognition failed, push-to-talk said it had not
  heard anything instead of why; a key given in the address could be misread
  on a browser with no storage; and the debug event log wrote an event's
  name into the page unescaped.
- Losing signal more than once, or stopping and starting again before it
  came back, could open a second live conversation when it did come back,
  billed alongside the first. Only one is ever reopened now, and none after
  you stop.
- When the house could not list its things, a guest pass's existing items
  were shown to be typed over, but clearing one did not remove it and
  renaming one was ignored. Both now take effect.
- If your passkeys or the list of where you are signed in could not be
  loaded, Family left those places empty without a word. It now says it
  could not load them, and why.
- Removing a car or unlinking an account in Family said it was done even
  when the server refused, and cancelling an invite, ending another sign-in,
  starting the chores tally again, or removing a device from notifications
  failed without a word. Each now says what went wrong.
- Saving the MCP servers in Settings reloaded the whole sheet: on a phone it
  jumped back to the list, and anything typed but not yet saved in other
  sections was lost. Only the server list is reloaded now.
- A message in the family chat could show twice, when the chat's regular
  check and the one after sending overlapped. Each message now shows once.
- When a shared screen locked itself after half an hour idle with the family
  chat open, the chat kept checking for messages as the person put aside.
  Panels are now closed properly when the screen locks.
- Switching from push-to-talk to typing or to a live conversation while it
  was still listening sent what had been heard so far as a question anyway.
  Putting it down now drops it.
- When a voice conversation failed to start (the microphone blocked, the
  server unreachable), the screen stayed in focus mode, the next tap only
  cleared it instead of trying again, and the idle lock and new-version
  reload waited on it. Now a failed start ends cleanly, the next tap tries
  again, and a failed reconnect keeps retrying as a dropped connection does.
- An MCP server saved with a header value typed as a number (8123 rather
  than "8123") made every question fail to load the house's tools. Such a
  value is now kept as text.
- A camera whose password had a stray "%" or a character such as "€" in it
  could not be shown, and the failure went unhandled. Such passwords now
  work; they are sent as UTF-8.
- Cancelling a car command while the car was waking left the wake-up request
  running for up to 100 seconds. It now stops with the question.
- A connection to Home Assistant (or another MCP server) that opened only
  after Jarvis had given up waiting for it was left open. It is now closed
  when it arrives.
- Hermes could lose the last words of an answer when its stream ended
  without a final newline. And everyone Hermes was shared with talked to one
  Hermes memory, so what the first person told Hermes, anyone else could ask
  it about. Each person now has their own; the first person keeps the one
  they had.
- A Home Assistant reached through an address with a path (behind a proxy,
  such as https://example.com/ha) worked for the house but not for alerts
  sent through Home Assistant, the Settings test, or checking a personal
  Home Assistant token: those dropped the path. All of them now keep it.
- When the car left a reading out, Jarvis said it anyway: "Battery
  undefined%", "Inside undefined°C", a location of "undefined, undefined" —
  and the summary said the car was locked when it had not said. A missing
  reading is now left out, an unknown lock is not claimed, and a reading
  with nothing in it says the car did not report it.
- When Google Maps refused to look a place up (a key not allowed to find
  addresses, or over its quota), Jarvis said it could not find the place and
  asked for the full address. It now says Google Maps refused, and why.
- When Spotify itself failed (overloaded, or down behind an error page),
  Jarvis said nothing was playing. It now says Spotify failed, in Spotify's
  words where it gave any.
- Sending the JSON value null as a request's body made eight routes (probe,
  speech, starting a voice session, typed questions, the MCP test and call,
  memory search and saving) fail with an internal error. They now answer
  that the body must be a JSON object.
- Removing a device with DELETE /api/v1/devices?id=… and no body was refused
  as "body is not valid JSON". The id in the address is enough now, as the
  API documents.
- Through the API, changing your Home Assistant token in the same request as
  your name or your voice and language saved the token alone and silently
  dropped the rest. Everything sent is now kept, and a bad choice refuses
  the request before anything is saved.
- A background job started by an admin was not told it has no screen, so it
  could try to show a map or a photo that nobody would see. It is now told,
  as everyone else's jobs are.
- A message posted through the API to a direct conversation written the
  other way round ("dm:b|a" rather than "dm:a|b"), or to a conversation with
  oneself, was accepted and then never shown to anyone. Such a conversation
  is now refused as not existing.
- A routine's alert kept for someone's quiet time showed in the routine's
  history as failed, saying "nothing is set up to receive it". It now says
  it is held until their quiet time ends; one dropped because it would be
  out of date by then says that.
- A mail from late the day before yesterday, read just after midnight, was
  said to be from "1 days ago". Mail is now dated by the days on the
  calendar, so it is two days ago.
- Asked to keep a roster or a list of numbers for looking up later, voice
  filed it as a note, which is carried into every question, because
  "reference" was missing from the kinds it could choose. It can now, as its
  instructions always said.
- The car was never recognised as the car: its browser does not say
  "Tesla", which is what was looked for. Its notifications were labelled
  "Linux computer", and Family offered to sign in another screen from the
  dashboard. The car is now told apart by its screen, as the voice already
  was.
- Saving or removing your own Home Assistant token in Family → Home closed
  the section, and the message saying it had worked went with it. The
  section now stays open and says so.
- When a long voice conversation reconnected, it kept its oldest turns and
  forgot the newest, so Jarvis lost track of what was just said. It now
  keeps the most recent end.
- The text boxes and pickers in the panels (and the family chat's message
  box) were in the browser's small default type, not 16px, so a phone zoomed
  the page in when one was tapped. The rule meant to set them was not valid
  CSS and was ignored.
- An invite link appeared on the first person's card in Family, not under
  the invite form, once the family had more than one person.
- Something passed on to a child in their quiet time counted as sent at
  once: she was nudged, held till morning, and the sender heard "no answer"
  in the night. It now waits for her quiet time to end, and the sender is
  told when it will reach her.
- Removing someone left their routines running, messages waiting on them,
  and chore rotas passing turns to them. Their routines now stop, rotas go
  on without them, and nothing waits on them.
- "Ask everyone": if one person never answered, the others' answers never
  came back together. They now do once that question lapses, a day on.
- Limits set on an invite (a guest's pass, an end date) were dropped if
  their section was folded away before making the link.
- Moving a reference fact (a roster, a directory) between yours and the
  family's failed, and a moved fact showed under Recently forgotten.
- The first person's own Telegram chat, set in Family → Alerts, was used
  for answers but not for reminders or messages passed on to them.
- A moment's hiccup reaching the family's records could turn away members'
  glasses and ESP32s for half a minute.
- "What's on tomorrow?" started tomorrow at 8 in the morning in Malaysia
  (midnight by the server's clock) and ran two days, and "today" ran 24
  hours from now rather than to midnight. Both are your own days now.
- An all-day event was said a day early west of UTC.
- A "time to leave" warning held for a child's quiet time arrived after
  the event had begun. One that would be too late is now let go.
- Jarvis told someone whose Google was not linked to open an address in
  the API; it now says Family → Accounts.

### Security

- A device's token could end up in the Worker's logs: the voice debugging
  helper, the example request under Routines and one example in docs/api.md
  sent it as X-Jarvis-Key, which the logs do not scrub. They now use
  Authorization: Bearer, which they do.
- When a voice session could not start, OpenAI's error was passed back to
  the app as it came, and such a message can quote the key it was given.
  Keys and tokens are now cut from it first; the rest of the reason still
  shows, to debug from.
- An MCP server added in Settings could name any of Jarvis's keys in a
  header, as `${OPENAI_API_KEY}` or `${HERMES_API_KEY}`, and Jarvis filled it
  in and sent it to that server. Jarvis's own keys are now filled in only for
  a server at an address the key already goes to, such as the Home Assistant
  token for Home Assistant's own MCP server. If a server of yours used one of
  them, give it a Worker secret of its own and name that instead.
- A calendar event's title could end the fence that marks the events as
  data, not instructions: whoever sent an invitation could write text the
  assistant read as though it came from outside the calendar. Events are now
  fenced as mail is, with a marker no one can guess.
- Anyone who could change settings could point the OpenAI address (Settings
  → Advanced) at a server of their own, and Jarvis sent the stored OpenAI key
  there with every question. The OpenAI key now follows the rule the other
  addresses already had: when the address is changed in the panel, the key
  is held back until it is entered again. If you set the OpenAI address in
  Settings yourself, enter the OpenAI key again after updating.
- Named in the family room, the assistant read the room's recent messages
  as requests, while holding the asker's mail, memory and house: something
  one person wrote could be carried out the next time another asked. Only
  the asker's own message is a request now; the rest of the room is quoted
  as context.
- A routine ran with what its maker could reach when they made it: taking
  the house away from someone did not take it from their routines. It now
  reaches no further than they may today.
- An event sent to `/api/v1/trigger` started everyone's routines, whoever
  sent it, with their words attached. A member's event now starts only
  their own; the house's (the owner key, an admin, the first person's
  devices, as Home Assistant uses) still start everyone's.
- A guest could start research in depth, spending the family's monthly
  allowance. Research now needs `routines`, which guests do not have.
- On a shared tablet, a profile put aside kept getting its notifications
  there. Putting someone aside now lets go of them; the next person to use
  the screen gets theirs.
- Put aside on a shared screen, a person's live alerts still reached it
  while the page stayed open: only their pushed notifications were let go.
  Their live connection is now closed as well.

## [2.0.0] - 2026-09-27

Jarvis becomes something a family shares: everyone signs in as themselves,
with their own memory, mail and reminders, and Jarvis passes things on
between you.

### Action needed

Nothing breaks if you update and do nothing: Jarvis keeps working on the
owner key, exactly as before, and your memory, routines, devices and
connected accounts stay yours. To use what is new, once:

1. Open Jarvis on your phone and unlock it with the owner key
   (`JARVIS_SHARED_SECRET`).
2. **Family** offers to set up your family: your name, the family's name,
   and what you call the assistant.
3. Tap **Create my passkey**. You are now the admin, and can invite the
   others from Family → Members.

Keep the owner key somewhere safe: it is the way back in if every passkey is
lost. Passkeys belong to the address you open Jarvis at, so set everyone up
on the one you will keep using. [Sharing Jarvis with your family](docs/family.md).

### Added

- **Share Jarvis with your family.** Everyone signs in as themselves with a
  passkey (Face ID, a fingerprint or the phone's PIN; no passwords), and the
  car or any other screen pairs with a short code approved from a phone. One
  of you is the admin, who invites the others with a link, chooses each
  person's role (admin, adult, child or guest) and what they can reach, and
  can remove them. Call the assistant whatever you like. Until you set a
  family up, nothing changes: the owner key works as before, and keeps
  working after, as the way back in.
  [Sharing Jarvis with your family](docs/family.md).
- **Each person's own.** Memory, mail, calendar and contacts, Spotify,
  reminders, routines, background jobs, alerts, the conversation across
  devices, and what they have used are each person's, and nobody else sees
  them. Each person links their own Google and Spotify, and chooses their
  own voice, language and Telegram chat, in Family → You. Alerts reach only
  the person they are for. What Jarvis kept before is the admin's who set
  up the family, where it always was.
- **Family memory**: "remember for the family that the spare key is under
  the blue pot". Everyone sees it; adults change it. Memory has Mine and The
  family's, and a fact can be moved between them.
- **Cars, shared as far as their owner wants.** Each car has an owner, who
  shares it with each person to see (where it is, the battery) or to drive
  (climate, locks, navigation too). Anyone adds their own car with their
  Tessie token, in Family → You → Cars. Jarvis uses your own car, or one
  shared with you, and "is Mum's car charged?" names another. A car shared
  to see is never operated.
- **Your own Home Assistant user**, if you like: give its token in Family →
  You, and the house answers you as yourself, in Home Assistant's logbook
  and under its rules for you.
- **Jarvis passes things on.** "Remind Aisyah to buy ice cream when she
  gets home, around five", "ask Mum if she wants anything from the shop",
  "tell everyone dinner is at eight": it reaches them at the right time, on
  their own screens and phones, and their Done, Can't or answer comes back to
  you. Unanswered, it nudges once, then tells you. "When she gets home" uses
  her Home Assistant person. Asking everyone gathers every answer for you.
- Something passed on for later shows at once in the two people's
  conversation, and for a reminder, its recipient is told quietly that it is
  coming ("Aisyah will remind you, Sat 17:00: …"), so neither wonders whether
  it went through. Someone whose permissions an admin set by hand also gets
  what their role has gained since, such as passing things on.
- **Each person's own glasses and devices.** Anyone makes a token for
  their own G2 glasses or ESP32 in Devices; it acts as them (their memory,
  mail, reminders and messages) and never reaches further than they may. An
  admin sees everyone's and can make one for a child. When someone leaves,
  their devices stop working.
- **Guests and helpers.** An admin gives someone limits: until a date, only
  between certain hours on certain days, and a pass — only these things in the
  house, such as the gate, with a button for each, ticked from the list of
  what your Home Assistant has. Outside their hours Jarvis does not answer
  them; after the date they are signed out.
- **Children's quiet time**: the same hours, as a child's waking hours.
  Anything passed on to them in quiet time, and any alert, waits until their
  hours begin.
- **Chores, check-ins and medicine.** Routines can pass things on: a chore
  rota that takes turns and earns points on Done (Family → Chores), a daily
  check-in on a grandparent, or medicine reminders, which tell the whole family
  if they go unanswered.
- **Time to answer**: how long someone has before a reminder or question
  counts as unanswered, an hour unless you change it in Settings → Alerts,
  or say otherwise for one ("within 15 minutes").
- **OpenAI address** (Settings → Advanced): an OpenAI-compatible gateway a
  company requires, instead of OpenAI itself.
- **Family chat**: a room the whole family shares and a conversation with
  each person, in the menu. Name the assistant in the room and it answers
  there. Messages Jarvis passed on appear in the two people's conversation,
  with Done or a reply.
- **The assistant goes by the family's name for it**, and knows who it is
  talking to.
- **Settings → Usage** shows each person's part.
- **One car, the whole family.** Add each person to the car once, and tap
  the name at the top to switch. A PIN keeps your profile yours: switching
  away locks it on the car, as does half an hour untouched, and only your
  PIN opens it again.

- **One conversation across your devices**: ask in the car, and "what was
  that address again?" works on the phone or the glasses for the next half
  hour. Only devices allowed to read memory take part.
- **Watches**: "tell me if the gate stays open ten minutes", "let me know when
  the car has finished charging", "tell me when the washer is done". Jarvis
  checks Home Assistant itself every minute, with no AI cost per check, and
  says it once each time the condition comes true. Needs Home Assistant.
- **Research jobs**: "research the best home charger for my car and let me
  know" runs as a background job on a stronger model (GPT-6 Sol by default),
  searches widely, and comes back as a report with its sources, taken from
  the searches' own citations. Roughly $1–2 each, 10 to 40 minutes, capped
  at 10 a month (Settings → OpenAI). The Jobs panel shows what each job cost.
- **Settings → Usage and cost**: what Jarvis has cost this month and today,
  split into answering, live minutes and background jobs; how many questions
  Home Assistant answered for nothing; the typical answer time; and the
  slowest recent answers, with who answered them. Estimates at OpenAI's
  published prices; OpenAI's usage page stays the bill.
- **Settings → OpenAI → Thinking before answering**: how long the AI thinks
  on a question you are waiting for. Auto, the model's own, stays the
  default: tested on real questions, lower levels were no faster with GPT-6
  Luna, and "none" made a serious mistake (docs/DESIGN.md). It is there for a
  heavier router model, where it may help.
- [How Jarvis reaches you](docs/notifications.md): where alerts go, turning
  on notifications, why the app need not be open or reopened after a restart,
  and what to do when one does not arrive.

### Changed

- **Hermes has its own permission,** `hermes`, apart from the house (`home`),
  because Hermes can run commands on its machine: sharing the house with
  someone never shares that. Devices made before this version with the house
  keep Hermes.
- What Jarvis knows about you (the profile it reads before answering) goes
  only to people and devices allowed to read memory (`memory.read`). A device
  without it no longer gets it, as it could not ask for it either.
- **Settings → Voice** (was "Push-to-talk voice") now sets the voice of
  everything Jarvis says outside a Live conversation: push-to-talk's answers
  and alerts said aloud — reminders, routines, watches, finished jobs and
  research. Alerts used to be spoken by OpenAI in a fixed voice whatever was
  chosen there. With the device's own voice chosen, alerts use it too.

### Fixed

- An update never reached a phone with Jarvis on its home screen until the
  app was swiped away: the phone resumes it rather than reloading it. Now,
  whenever Jarvis comes back to the front (and every half hour while it stays
  there, as in the car), it picks up a newer version, unless you are in the
  middle of something.
- The voice prices in Settings: Workers AI's English speech (Deepgram Aura 2,
  $0.03 per 1,000 characters) is dearer than OpenAI's past Cloudflare's free
  allowance, not the cheapest option; the docs said otherwise.

- A phone whose notifications had slipped off Jarvis's list (the push service
  replaced them, or reported them gone) kept believing they were on, and
  alerts stopped without a word. Opening Jarvis now checks them in again. A
  device you removed in Settings → Alerts stays removed until you turn
  notifications on again on it, and the list keeps each device's history.
- Notifications could arrive late on an idle phone (screen off, on a table),
  as Android held them for its next battery-saving window: every alert is now
  sent as high priority. And a phone that was off for more than an hour never
  got them: they are now held for a day, except "time to leave", which is held
  only until the appointment starts.
- Cancelling a background job just as Jarvis was checking on it could be
  undone: the check saved the job as still running, and it ran on to the end
  and reported back. A cancel now sticks, and the work already started is
  stopped.
- Without an OpenAI key, Type and push-to-talk refused every question, even
  those Home Assistant's Assist answers on its own. They now go to Assist
  first, as the glasses do; push-to-talk still needs a key when OpenAI
  transcribes speech.

## [1.1.0] - 2026-09-26

### Added

- Jarvis's voice is louder, to match music: about 8 dB, with a limiter so it
  does not clip. In the car, the volume had to be turned up for Jarvis, and
  Spotify came back far too loud when a live conversation ended; now the
  volume can stay where the music wants it. Live, push-to-talk and spoken
  alerts all follow it. To change it, per screen: **Settings → This screen →
  Jarvis's voice** — Loudest (the default), Louder (about 6 dB) or Normal (as
  before). If a screen hears Jarvis echo in a live conversation, choose less
  there.

- A setup guide for Even Realities G2 glasses: say "Hi Even" and ask, with
  Jarvis in place of the glasses' built-in assistant, so there is no app to
  open. It explains why Jarvis beats connecting OpenClaw or Hermes directly:
  faster, answers that fit the display, and background jobs for slow work.
  [docs/even-g2.md](docs/even-g2.md).

### Changed

- Updating moves to the newest release rather than to the latest code on
  `main`: see [Updating](README.md#updating), and the foot of every release.
  Releases now collect changes that have been in use, rather than one per
  change.

## [1.0.0] - 2026-09-26

The first numbered release. A copy made before it has no version number;
updating to this one needs nothing doing.

### What it does

- **Three ways to talk**, chosen per screen: *Live* (GPT-Live, a real
  conversation), *Push-to-talk* (one question at a time, a fraction of a cent
  each) and *Type* (a chat, for noisy or quiet places).
- **A router with tools**: the car (Tessie), the house (Home Assistant, over
  MCP and through Assist), Gmail, Google Calendar and Contacts, Spotify, Maps
  and Places, web search, any MCP server, and a Hermes agent at home.
- **Memory**, found by meaning as well as by words, in any language, and
  shown in the memory panel.
- **It speaks first**: alerts to open screens and phone notifications, with
  Telegram, ntfy, a webhook and Home Assistant as optional routes.
- **Routines** (reminders, daily requests, events, "tell me when to leave"),
  **background jobs** for work that takes minutes, and **cameras** it can
  look at.
- **Other devices** through the [device API](docs/api.md): ESP32 boards and
  Even Realities G2 glasses, each with its own revocable, scoped token.
- Runs on Cloudflare Workers (the free plan is enough) or in Docker, and is
  set up in the browser.

### Added since the first public snapshot (24 September 2026)

- Alerts, routines, push-to-talk, Type, vision, recall by meaning, background
  jobs and the memory panel.
- Settings in a menu of sections, one open at a time; one menu button on the
  screen, and focus mode while talking.
- Version checking: Settings shows the running version and says when a newer
  release is out. The `UPDATE_REPO` setting points it at a fork's own
  releases, or turns it off.

### Changed

- The router defaults to GPT-6 Luna, about a twentieth of GPT-6 Sol's price,
  and its unchanging prompt is cached, so it is read at a tenth of the price.
- House requests from the glasses, Type and push-to-talk go to Home
  Assistant's Assist first, gates and doors included: under a second and no
  model cost for what Assist understands. What it may do is what you expose to
  Assist in Home Assistant.
- The settings `G2_FASTPATH` and `G2_HA_LANGUAGE` are now `HA_ASSIST` and
  `HA_ASSIST_LANGUAGE`, under Home. Values saved under the old names are still
  read.

### Fixed

- Camera questions timing out over a slow link home: frames are asked for at
  540p, and the camera list no longer waits for every state in the house.
- House questions waiting up to 12 s for Home Assistant's tool list, and
  reconnecting before every call.
- A camera picture in Type mode was drawn under the chat; the chat now keeps
  its newest message in view above the phone's keyboard.

[Unreleased]: https://github.com/kucau0901/jarvis-voice-agent/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/kucau0901/jarvis-voice-agent/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/kucau0901/jarvis-voice-agent/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/kucau0901/jarvis-voice-agent/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kucau0901/jarvis-voice-agent/releases/tag/v1.0.0
