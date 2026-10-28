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

- **Jarvis talks to you about your alerts.** Every alert (a reminder, a
  routine, a finished job, a message from the family, the house) is now in
  your Chat, so you can answer it there, aloud too ("tell her yes"); each
  person's in their own only, and the same words twice in a few minutes only
  once. With **Talk to me about alerts** on (Family → You → Alerts, on unless
  you turn it off, or ask Jarvis to change it), a screen that can speak says
  it and listens for your reply; off, it is in Chat and a notification, not
  said. Two more choices there for the family room: whether its messages are
  said too (yes, unless you turn it off), and whether answering one aloud
  goes to whoever wrote it (the default) or into the room. The device API's
  alerts carry `talk` for this, and `/api/session` takes an `opening` alert
  for a Live session that starts by saying it (docs/api.md).

### Changed

- **Meetings from mail takes invitations, and work mail forwarded to you.**
  A calendar invitation (.ics) that names you as a guest is now put in your
  calendar from its own date and time, read by code with no model, however
  many people were asked. Mail forwarded to Gmail from another address of
  yours (work mail, say) counts as sent to you. Google Calendar adds an
  invitation itself only for the address it went to, so one sent to your work
  address and forwarded was missed before. One already in your calendar is
  still left as it is.

### Fixed

- **Run now in Routines answers where you pressed it.** Its button says
  "Running…" and stays off while the routine runs, the row says so, and the
  row then shows what the run did. Before, the only answer went to the foot
  of the panel, out of sight, and the row kept its old result.
- **Mail written in bold or fancy letters no longer stops Jarvis.** A
  listing cut such a letter in half (𝗠𝗘𝗘𝗧𝗜𝗡𝗚, or an emoji), and the ChatGPT
  plan refused the whole question with "Bad Request", so chat and routines
  that read that mail said only "Something went wrong".

### Security

- **A watch on the house needs the house.** Someone allowed routines but
  not the house (a child, or a device given only routines) could make a
  watch whose condition read anything in Home Assistant, and see what it
  read in the reply. Watches are now refused without the house permission.
- **A device reaches only the routines and jobs it may.** A device token
  given only routines (for a Home Assistant automation, say) could list,
  run and remove every routine of its person's, including ones made with
  full reach, and read their job results. A device now works only what it
  made, or what is no stronger than itself. Revoking or deleting a device
  now stops the routines it made, and narrowing it narrows them; before,
  they kept running.
- **No one can push out the family's phone notifications.** The 20
  notification subscriptions were shared by the whole family, so anyone
  allowed alerts could add 20 made-up ones and stop everyone else's phones
  being told anything. Each person now has 20 of their own.
- **What others write is quoted for the AI.** A family member's message
  waiting for your answer, the family room, family messages, results from
  MCP servers, Hermes's answers to a house request, and alerts from the
  family or a program, now reach the AI marked as their writer's words,
  never as yours or its own. Before, a message could have been read as an
  instruction in a request that could reach Hermes or your mail.
- **Routines no longer reach Hermes.** A routine's question runs with
  nobody there, often over mail or pages strangers wrote, and Hermes can
  run commands on its computer. Routines can still do everything else
  their maker may; ask Hermes yourself, or with a job, for anything that
  needs it.
- **Telegram's secret follows Jarvis's address.** An admin who pointed the
  public address elsewhere could learn the secret Telegram sends and keep
  using it after the address was put back. It is now tied to the address.
  A Telegram set up before this is told the new secret by itself the first
  time a message arrives; that message comes through a moment later.
- **Linking Google or Spotify asks whose Jarvis it is for.** After you
  choose an account, a page now asks "Link this Google account to Sara?",
  and links only when you press it. Before, someone could start a link and
  send it to another family member, whose mailbox would then have gone to
  the first person's Jarvis without a word.

## [2.5.0] - 2026-10-22

### Added

- **Briefs.** A routine can now brief you on your day: "every weekday at
  seven, brief me on my day", or Routines → Brief me on my day. Jarvis puts
  together your calendar (what clashes, your free time, invitations you have
  not answered), the weather, the car, the day's orders and how many old
  promotions sit in your inbox, your jobs, and anything waiting for your OK,
  as a page you can read, opened by a line or two on what matters most. Only
  what you can reach and have set up is in it. One sent after 3 PM covers
  tomorrow. One short answer per brief, so it costs little.
- **Briefs put things to you.** A brief now comes with cards to tap: answer
  an invitation you have left unanswered for three days (Decline when it
  clashes with something, else Accept), and archive the old promotions in your
  inbox once there are 20 or more, with **Put back** for a week. **Don't
  suggest this again** on a brief's card stops it being offered for 30 days.
  Every card's button now says what it does (Lock, Send, Add, Archive), and
  Now shows up to five.
- **Errands for later.** What a background job proposes can wait for when
  you want it: at a time, before a calendar event, or when you get home or
  leave (with Home Assistant and your Home Assistant person in Family). It
  comes as a **Ready now** alert with its card then, checked again first;
  meanwhile it waits in Jobs → Later, where Don't do this drops it. A brief
  also lines up starting the car's climate half an hour before your first
  event with a place, if you can drive the car.
- **Meetings from your mail go in your calendar.** A routine can now add
  meetings emailed to you: Routines → Add meetings emailed to me to my
  calendar, or "every hour on workdays, add meetings sent to me to my
  calendar". Mail sent to you by name with a Meet, Zoom, Teams or Webex link
  is read once, and each meeting is added with a reminder 10 minutes before;
  mailing lists and mail to a crowd are left out, and so is anything at a
  time already taken in your calendar. You are told what was added; an hour
  with nothing new sends nothing.
- **Jobs ask before they act.** A background job that would do something
  (lock the car, put an event in your calendar, archive or star an email,
  send an email it wrote, a Home Assistant call) now proposes it: its result
  comes with a card for each, its button saying what it does (Approve for a
  Home Assistant call) beside Not now, on the alert, under
  its answer in the chat, and on Home under Now until you answer. Only your
  tap does it, once, with no more
  than the job could reach; a card says when something can't be undone, and
  waits a day. An email a job writes is saved to your Drafts, and its card's
  Send sends it. Once you approve something that can be undone (locking
  the car, an event, archiving mail), **Let jobs do this without asking**
  lets them do that one kind from then on; Jobs lists what is allowed, with
  Stop. Anything irreversible, and anything for the house, always asks.
  Routines act as they always have.
- **Run Jarvis on your ChatGPT plan.** Connect your ChatGPT Plus or Pro in
  Settings → ChatGPT plan, and every question, chat, job, research run and
  routine comes out of the usage your plan already includes, at no cost in
  Usage. A ChatGPT plan or an OpenAI API key is now enough on its own; with
  both, the plan is used first, the key runs live voice (which the plan does
  not cover) and, unless you switch it off, carries on when the plan's limit
  is reached. Without a key the Live switch is hidden and push-to-talk uses
  Workers AI. Setting it up: [README](README.md#use-your-chatgpt-plan).

- **Jarvis reads its background jobs back.** Asked "has Hermes answered?" or
  "what did that research find?", Jarvis now answers from your finished job
  (or says it is still working) instead of asking Hermes again or starting a
  new job. This is how Grok, the glasses and `/api/v1/ask`, which never see
  the alert, get a Hermes answer.
- **Jarvis as an MCP server, for Grok.** `POST /api/v1/mcp` lets Grok's custom
  connectors (grok.com → Connectors → New Connector → Custom), xAI's remote
  MCP tool and other MCP clients ask Jarvis things through one tool,
  `ask_jarvis`. Grok signs in with OAuth: Jarvis asks you what it may do, and
  allowing it makes a device you can revoke in Devices. A client that sends
  its own header can use a device token instead. Setting it up:
  [docs/api.md](docs/api.md#grok-and-other-mcp-clients).
- **Change what a device may do.** Each device in Devices has an Edit button
  that changes its scopes and keeps its token, so nothing has to be
  reflashed or reconnected. A change takes up to a minute to reach it.
- **A panel shows its alerts.** A tile with an alert on it says so, e.g.
  "Alert: above 200", whether the alert was set with Alert me or by asking
  Jarvis to watch that thing. Off ones are not shown. In Alert me a number
  alone, such as 200, now means above it.
- **See what Jarvis is doing.** While a typed question is worked on, the chat
  shows a pill for each thing Jarvis checks ("Checking the house", "Checking
  your calendar"), ticked as each is done, where the answer will appear. A
  question says "Read" once Jarvis has it, and stays at the top while its
  answer is read.
- **"On it" for a background job.** A job or a question for Hermes started
  from the chat shows its pill at once; when the result comes, that pill moves
  down to it and takes its name, and opens the job in Jobs. The result is kept
  in the conversation, so it is still there after a reload. A device reading
  `POST /api/v1/stream` gets a `job` event for it
  ([docs/api.md](docs/api.md#streaming-if-you-want-progress)).
- **More info and Reply on a Home panel.** A panel's … menu now has Reply,
  which opens the chat ready to ask for a change, and More info, which says
  how often each thing on it is read, from where, and when it was last and is
  next checked. While Jarvis makes a panel asked for on that screen, a card in
  the making stands in for it.
- **Routines that only speak up when it matters.** A routine that asks Jarvis
  something can now be told to send the answer only when there is something
  worth telling ("every morning, tell me only if there is urgent mail", or the
  new box in Routines). A run with nothing to tell sends nothing, and Routines
  shows "nothing to report".
- **A monthly budget.** Settings → OpenAI → Monthly budget (US dollars): you
  are told at 80% and at 100% of it, once each a month, and nothing is
  stopped. For those who run the house, the Home usage tile and Settings →
  Usage then show how much of it is gone and when it resets.
- **Dictation.** The mic in the chat's message box now writes what you say
  into the box, to read over before sending. `POST /api/v1/voice` takes
  `transcribe=1` to only hear a recording.
- **Jarvis draws pictures.** Ask for a picture ("draw me a red car on a
  beach") and it appears on the screen with a Download button. It needs the
  OpenAI key (the ChatGPT plan has no images), makes up to 10 a day for each
  person, and keeps each person's newest 20 for 30 days; clearing the chat
  removes them. Each counts in Usage, and toward a budget, at OpenAI's price.
- **Export your data.** Settings → Export your data downloads one JSON file
  of your memory, routines, panels, conversation and jobs, and the household's
  settings without any key or token. For the owner and admins.
- **Draft first.** Switch on Settings → Google → Draft first, and mail
  Jarvis writes for you is saved to Gmail's Drafts, never sent by Jarvis: a
  card shows who it is to and what it says, with Send, Open in Gmail and
  Not now. Asked from Telegram or the car, it waits in Drafts. Footer on
  mail Jarvis writes, beside it, puts a line of yours under each one.
- **Panels kept up to date with Home closed.** Ask for a tile to "keep it
  updated", and Jarvis refreshes its reading hourly or daily on its own, as
  Hark's tiles do, so it is fresh when you open Home or an alert needs it.
  At most three such tiles each; More info says so. Each refresh is an
  answer from the model, so it costs what one does.
- **A live sky.** Behind the app, a sky in the theme's colours follows the
  sun where your home is, and the clouds and rain from your Home
  Assistant weather, hazy when a panel's air-quality reading is poor. It
  holds still in the car's driving view, and steps down or stops on a
  screen that struggles.
- **Ask Jarvis on Telegram.** Switch on Settings → Alerts → Ask Jarvis on
  Telegram, and the family's bot answers as well as alerts: a message from
  the private chat someone gave in Family → You → Telegram is answered as
  them, within their hours, without Hermes. A chat nobody gave is told its
  number. Long work becomes a background job whose result comes there.
- **Pages.** "Make me a page comparing these chargers" makes a small web
  page, in sections and tabs, light or dark, marked as made by an AI. It
  comes as a card under the answer to open, typed or spoken; those who run
  the house can Share it as a link anyone can open, and Stop sharing. Each
  person's newest 20 are kept for 30 days; clearing the chat removes them.
- **Research into a table.** Ask for a list of many things found and
  compared ("the 10 cheapest genuine Xiaomi speakers in Malaysia, with seller
  and rating"), or tick As a table in Jobs: a research team fills the rows,
  each from a page it read, checked against its sources. The first rows come
  as a message, and Jobs → Download CSV has them all. It costs as a team does.
- **Formatted answers in Chat.** Lists, headings, code and tables are drawn
  as they are meant, a table with Copy and Download CSV. Something asked for
  to keep or read at length (a plan, a guide, a letter) comes as a document
  card that opens full-screen, with Copy and Reply. The pages an answer cited
  are cards under it. Read aloud, a table is read as its rows.
- **Past attempts.** Jarvis notes how each background job, question for
  Hermes and research run went, and each question whose tools failed, and
  when you ask for something like one of them, it is told what happened
  last time. Memory → Past attempts lists them, each forgettable; no model
  is used to keep them tidy.
- **Specialties.** Say "save this as my Monday report" after Jarvis does
  something in a few steps, and next time you ask for it, by name or as you
  usually would, Jarvis does it the same way. Only you can save one, in your
  own words; Memory → Specialties lists them, with Forget. They are in the
  data export.
- **About you.** Family → You → About you keeps what you like to be called,
  your birthday, your home and work, and the people in your life with who
  each is to you, so "remind my wife" and "how long to work" just work. A
  work address seen in your calendar on three or more days is offered, and
  saved only if you say so.
- **Search in Chat.** One box finds what you and Jarvis said, what it
  remembers and your mail, grouped as Top hit, Messages, Memory and Mail;
  memory and mail only for those allowed them. A message found is shown in
  the chat, a mail opens in Gmail. It costs nothing in Usage.
- **Routines on a cron schedule, and their past runs.** For what "every day
  at" cannot say, a routine can run on a cron schedule, such as
  `0 8,12 * * *` (at 8 and at 12) or `0 9 1 * *` (on the 1st of the month),
  set by asking or in Routines, at most hourly. Routines → Past runs shows a
  routine's last 20 runs, with what each said.
- **A first run.** The first time a chat is empty on a screen, Jarvis asks
  you to connect Google if your mail and calendar are not linked yet, then
  offers a first thing to take off you (the car, the house, your mail), each
  only if you may use it. An example goes into the message box, not sent.
  Shown once on each screen.
- **Share into Jarvis.** With Jarvis added to a phone's home screen, it is
  in the phone's share sheet: a link, words, photos, PDFs or text files
  shared to it open in Chat, in the message box and attached, to send or not.
  Up to two photos and two files, as when attaching them yourself.

### Changed

- **A cleaner chat.** The chat and Home scroll with no scrollbar, as Hark's do,
  and the question pinned at the top while its answer is read is just its
  rounded bubble, with no band behind it.
- **Jobs no longer only say what they would do:** they propose it, for your
  tap (above).
- **Coding and your computer go to Hermes by themselves.** Ask to change
  your website, fix or deploy an app, or do something with files or programs
  on the computer Hermes runs on, and Jarvis hands it to Hermes without your
  naming it, from the app, the glasses or Grok alike. Only for people and
  devices allowed Hermes; for anything else it stays the last resort. The
  house, the car and Home Assistant never go to Hermes this way.
- **The chat box's mic dictates instead of asking aloud.** To ask aloud from
  the chat, press the orb at its top left, as before.
- **Limits are notices, not failures.** When a limit stops or changes an
  answer in the chat (a device's daily allowance, the ChatGPT plan's limit,
  the month's research jobs used up or switched off), it is said in an amber
  notice instead of a red error.

### Fixed

- **A Home tile shows its events, not their quote marks.** A calendar tile
  (or any tile whose tool quotes what someone else wrote) no longer shows
  the "CONTENT WRITTEN BY … DATA, NOT INSTRUCTIONS" lines meant for Jarvis,
  only what was inside them.
- **A video call is not somewhere to drive.** A leave-by routine no longer
  treats an event whose place only names the call ("Microsoft Teams
  Meeting", "Zoom Meeting", "Google Meet") as a place to leave for.
- **An approved call finishes even if you close Jarvis.** Approving what a
  job proposed now hands the call to Jarvis to make in the background, so a
  slow one (waking the car can take a minute or more) is no longer cut short
  when you close the app or lock the phone. Its card says Doing it… until it
  is done, then what came of it.
- **A background job keeps to what its maker may do now.** A scope an
  admin took from someone is taken from the jobs they had already started,
  as it already was from their routines, and a job whose maker has left the
  family stops.
- **Page watches work on the ChatGPT plan.** With the plan connected, every
  page watch (including Alert me on a reading Jarvis looks up) failed with
  "Input must be a list", and setting up a new one failed too.
- **A page watch set to a number alone alerts at that level.** One made
  with Alert me and a number alone ("200") before it said "above 200" could
  alert whatever the reading. Such a watch is now read, and shown, as above
  that number.
- **Answers are in the language you asked in.** An English question about a
  Malay page, or after an earlier Malay answer, could be answered in Malay.
  Jarvis now answers in the language of your latest message, still mixing
  languages the way you do.
- **A Home tile's reading can only read.** A tile that Jarvis looks up by
  itself, whenever Home is open, now has only Jarvis's reading tools: it can
  no longer start Hermes or a job, or change anything. Its buttons are
  unchanged.
- **A panel button's answer stays in sight.** What Jarvis answered to a
  button on a Home panel (a tile's button, a gate's Open) was drawn over
  by the panel's own refresh 1.5 seconds later, so a slower answer was
  never seen. It now stays under the buttons for two minutes, as "Alert
  me"'s does.
- **Panels can be made from devices.** Asking through `/api/v1/ask`, the
  glasses, push-to-talk or MCP now reaches `panel_set`, `panel_remove` and
  `panel_list` for a device granted `screen` (or `*`). Those routes used to
  take `screen` away entirely because there is nothing to show a map on; now
  they leave out only the map tools.

## [2.4.0] - 2026-10-16

### Added

- **Panels on a Home tab, made by asking.** "Put the gate and the porch light
  on a panel", "add my car to Home Controls", "a to-do panel with renew the
  road tax": each person's panels are their own, and show what Jarvis can
  reach for them — things in Home Assistant, their car through Tessie, what
  they have used, notes. Everything is read live when the tab is open, and the
  buttons follow the state (a closed gate offers Open; a locked car, Unlock)
  and are checked again before anything is sent. A room's lights can be one
  row with All on and All off, even when Home Assistant has no group for
  them ("1 of 8 on · Reading lamp unavailable"), and Jarvis lays each panel
  out itself, however it was asked: three or more lights of a room (its area
  in Home Assistant) become one row, and the gate and doors come first, then
  lights, the climate, readings, the car and notes. A panel holds up to 20
  things. Guests have no Home tab. Each thing is a tile with an icon, lit in
  colour while it is on, open, unlocked, charging or armed; a car shows its
  battery and range, then its locks, climate and charging, each with its own
  button. Big panels run across the page and smaller ones sit side by side
  in columns. Drag a panel by its name to move it, or a thing on a panel by
  its own name (on a touch screen, hold it a moment first); the order is
  kept for you on every screen, and when you ask Jarvis to add to a panel
  what you moved stays put, the new thing going beside its kind. "Tidy up
  Home Controls" has Jarvis lay it out again. A tall panel folds to its first row, and its … menu reloads or
  removes it. A room's row opens to show each light with its own button; an
  aircond opens to its temperature, modes and fan; an alarm to Disarm or the
  ways to arm it, with its code when it wants one (never kept). And a panel
  can hold anything else Jarvis can do, not only the house: "put Spotify on a
  panel with pause and next", "a tile with today's calendar" — wired once to
  Jarvis's own tools, so a press needs no model; where no tool can do it, a
  button asks Jarvis a sentence instead. A tile does only what its person
  could ask for, and its car buttons follow the car as its own tiles do:
  Unlock while it is locked, Lock while it is not. Lights dim, fans, blinds
  and speakers set by a slider; a temperature or any other number in the
  house opens to its last day as a chart, the car to where it is on a map,
  and a looked-up reading can show a list (a forecast), a trend and a map.
  A tile's button can take a number or
  typed words (the music's volume, a note to the family). Notes are a checklist:
  tick one off and it is struck through until "Clear ticked", and type new
  ones straight onto the panel. For what no tool can read ("a panel for the latest air
  quality in my town"), Jarvis looks it up with web search and shows a
  verdict and its figures, looked up again at most hourly and only while
  Home is open. **Alert me**, in an opened tile, makes a routine: when the
  gate opens, when a reading goes above a number, or, for a reading Jarvis
  looks up, when what you type comes true ("the API is above 150"), read
  from its source page at most hourly by the cheapest model, about a tenth
  of a cent a look. Jarvis can see what is on your panels, so "what's on my
  panels?", "suggest another panel" and changes to one go by what is there.
- **Light and dark, per screen.** Menu → **Theme**: Auto, the default, is
  light by day and dark at night (07:00–19:00, by the screen's clock), because
  the car's browser can report the wrong system setting. Or System, Dark or
  Light. Each screen keeps its own, so the car and a phone can differ.
- **Watching a camera for a few seconds.** Ask "is that car pulling in or
  out?" or "is someone coming to the door or leaving?", and Jarvis takes three
  pictures a few seconds apart and answers from what changed between them.
  Only when the question is about movement, or you ask it to watch: anything
  else is still one picture, as quick as before. Watching takes a few seconds
  longer.
- **A guide to Hermes** ([docs/hermes.md](docs/hermes.md)): connecting it, who
  may use it, the six-minute wait, an alerts-only token so Hermes can report
  back, and two ready-made Hermes skills in `docs/hermes/`, downloaded straight
  to Hermes's machine: one that reports long work back to you, and one that
  builds what research found with Claude Code and, if asked, deploys it as a
  static site on your own server (a Synology, for example) at its own
  subdomain, or makes it a PowerPoint deck and puts it in your Google Drive
  (with gog). A build asks nobody anything: its commands (npm install, npm run
  build) run by themselves inside Claude Code's sandbox, which can write only
  in the project, can't read the alerts token, Hermes's keys or gog's, gets
  none of Hermes's environment, and reaches npm's registry only;
  `sandbox-check.sh` proves it on Hermes's machine.
- **Research as a team.** Ask Jarvis to research something "as a team", or
  tick *As a team* in Jobs. Three teams look into it at once, each from an
  angle chosen for the question. They pass each other what they find as they
  go, and their reports become one, checked against the pages they found. It
  takes 20–55 minutes, costs roughly $4–7, counts as one of the month's
  research jobs, and one runs at a time. If the reports can't be merged, you
  get each team's report as written.
- **Hand research to Hermes.** Say "send the research on home chargers to
  Hermes and have it build a first version", or press **Send to Hermes** on a
  finished research job in Jobs, and Hermes gets the whole report as
  reference, with your instruction. Only your own finished research, and only
  when you ask. It needs Hermes and the `hermes` permission. With the setup in
  [docs/hermes.md](docs/hermes.md#building-from-research), Hermes can build with
  Claude Code and tell you when it is done.

- **Photos, files and replies in Chat**, as Hark's chat has them. "+" in the
  message box offers Upload file and Take photo: up to two photos and two
  files a question, a PDF or a text file, which Jarvis reads with the
  question and keeps nowhere. Take photo opens the camera in the page, on a
  computer, a phone or the car (in Park). Each answer has a reply button: your
  question then carries a hook back to it, which brings that answer into view,
  and Jarvis knows which one you mean. Answers now stand out from questions,
  solid against see-through, in dark as in light.

- **What your routines say appears in the chat**, as Hark's checks do: under
  a pill with the routine's name (for example "Work email check"), hooked to
  the message, whichever tab is open. Messages that came while Jarvis was
  closed are there when you open it. Press the pill to open that routine in
  Routines; the message can be replied to like any answer.

- **The chat is kept**, as Hark's is: what you typed or said aloud, Jarvis's
  answers and what your routines said are there again when you open Jarvis,
  on any screen of yours, for 30 days (the last 200 messages). **Clear chat**,
  above the conversation in Chat, empties it with two taps, on every screen
  of yours. Jarvis can also look back through it when you ask about
  something said before, such as "what did you say last week about the
  insurance?". This needs permission to read memory, so guests don't get it.

### Changed

- **A question carries only the recent part of the conversation**: the last
  20 turns of the past three hours, rather than up to the last hundred since
  the page opened. A long chat costs no more to ask in than a short one. What
  lasts is still in memory, and older chat is read back only when you ask
  about it. Ending a live session no longer forgets the conversation: the
  next one carries on from it.

- **More room for the conversation on the Jarvis tab.** On a screen wider
  than a phone held upright, the orb is a little smaller with what it is
  doing in a small frosted card under it, and Live and Push-to-talk are a tall
  narrow switch at the right edge instead of a row under the orb; the
  conversation takes all the height left. The line of prices under the orb is
  gone, the running cost of a live session with it (Settings → Usage keeps
  what each one cost). In the car the orb's top no longer
  goes under the tabs, nor the conversation off the foot of the screen.

- **A new look, in Tesla's colours, laid out like Hark.** The app uses the
  greys and blue of Tesla's own screens, so it looks at home in the car, on
  frosted glass over a softly blurred page. The orb is blue when idle and
  while you talk, and amber while Jarvis speaks. Alerts, pictures and the
  sign-in screen follow suit.
- **Jarvis, Chat and Home, as tabs at the top.** Home holds your panels (see
  Added). Chat is what *Type* was, now with replies in bubbles and one message
  box holding a microphone (ask aloud), read-aloud and send; Live and
  Push-to-talk stay under the orb in the Jarvis tab, and coming back from Chat
  returns to whichever of them that screen last used.
- **The menu is a page behind your initial**, top right, as Hark's settings
  are: its items in cards, each with an icon. The family's chat in it is now
  called **Messages**, so it is not confused with the Chat tab.
- **Every panel is a page**, as Hark's settings are: full screen, a large
  title, round buttons to go back and to close, and its content in cards.
  Settings, Family and Memory open on their list on every screen, and a
  section opens on a page of its own.
- **Research reports are checked before they reach you.** When a research job
  has written its report, it takes one more turn to check it against the pages
  it found, searching again where it needs to, and corrects or removes what
  they do not support, ending with a line saying what it changed. If the check
  cannot finish, the report arrives as it was written. A report costs somewhat
  more and can take a few minutes longer; the Jobs panel shows what each one
  cost.
- **A question for Hermes says how long Jarvis waits.** Each one ends with a
  short note: Jarvis waits at most six minutes, so longer work (a build, a
  deploy) should be answered at once and reported with a Jarvis alert when it
  is done, with the address of anything deployed.

### Fixed

- **Typing in the car: the box stays in sight.** The car's on-screen keyboard
  covers the page without the browser being told, so the message box stayed
  under it and you could not see what you typed. In the car, the box you type
  into now moves to the top of the screen while the keyboard is up, as the
  car's own boxes are: in Chat the message box sits under the tabs with the
  newest messages just below it, and a box on a panel or in Settings scrolls
  up. Opening Chat in the car no longer brings the keyboard up by itself.

- **Hermes taking longer than six minutes no longer reads as a failure.** The
  alert said "Could not finish … The operation was aborted due to timeout"
  while Hermes was still working. It now says "Still working", and that its
  answer will not come back to Jarvis.

- **A long research report keeps its Sources list.** Jobs keeps the first
  20,000 characters of a report, and the list came last, so a long report lost
  it. The report is now shortened to make room, and the list is kept whole.

## [2.3.0] - 2026-09-29

### Security

- **Whoever could edit the MCP servers (a family admin) could have the
  family's Home Assistant token sent to a server of their own.** It was put
  into the headers of any MCP server on the same host as the Home Assistant
  MCP URL, and a Nabu Casa webhook's host is shared by every Nabu Casa
  customer. The token now goes only to servers at or under the Home
  Assistant Base URL, and a new MCP URL no longer stops the token being
  used. An MCP server that takes `${HA_TOKEN}` must be under the Base URL.
  The same holds for Jarvis's other keys: each goes only to MCP servers at
  or under the address it is already sent to, not anywhere on that host.
- **A token pasted into an MCP server's header could be sent to another
  address.** Any family admin could keep the server's name, give it a new
  URL, and press **Test** or **Save**: the saved token went to the new
  address. A saved token is now only sent to the address it was saved for:
  a server given a new address needs its token typed again, and Settings
  says so.
- Any family admin could also send a Worker secret set for an MCP server
  (written as `${NAME}`) to a server of their own, with **Test**, **Save**
  or `/api/mcp/call`. Now only the owner key can send one to an address it
  is not already sent to; other admins can still rename, turn off or remove
  servers using one.
- And an admin could change the setting an MCP server's address names (the
  Home Assistant MCP URL, for one) and have that server's token or Worker
  secret sent to the new address. A server whose address is a setting is
  now sent neither; Jarvis's own keys still reach it under their own rule.
  If one of yours needs a token of its own, write its address out in full
  in Settings → MCP servers, and type the token again.
- **A family admin could have another person's own Home Assistant token sent
  to a server of their own** by changing the Home Assistant Base URL: a token
  given in Family → Home went to whatever address the house had. Each
  person's own token is now used only at the address it was checked with,
  and Family → Home shows that address before a token is given: it is sent
  only to the address shown. When the address changes (moving house, say),
  theirs is no longer used, and Family → Home asks them to enter it again,
  showing the new address. Only people who may use the house see the
  address or give a token. Tokens given before this version are tied to no
  address, so each person who gave one enters it once more.
- **On a shared screen, a profile locked with a PIN could still have its own
  choices changed** by whoever was at the screen: where its Telegram
  messages go, its name, and its own Home Assistant token. A locked profile
  now changes nothing until its PIN is given.
- **A profile locked on a shared screen still told who it was.** Anyone who
  copied a locked sign-in from the screen could read that person's Telegram
  chat, their Home Assistant person, their voice and language, and a guest's
  pass (its hours, end and what it opens). A locked sign-in now says only
  who it is and whether it has a PIN, until the PIN is given.
- **Any family admin could sign in as the person who set up the family,**
  and so act as the owner, with their memory, mail and calendar: by signing
  a screen in as them, making them a new passkey link, clearing their PIN on
  a shared screen, or making a device for them. Now only the owner key, or
  that person, can do these for them. Admins can still do them for everyone
  else, to get someone back in, and Sharing Jarvis with your family now says
  that plainly.

### Changed

- **Live now closes after 30 seconds of quiet,** instead of two minutes after
  you last spoke, since an open session is billed even when nobody talks. Quiet
  means neither you nor Jarvis is speaking, so Jarvis is not cut off while
  answering. While Jarvis works on a request, it stays open for up to two
  minutes after you last spoke, as before, and an answer that comes later is
  kept for your next tap.

### Fixed

- **After a new Home Assistant address or token was saved, the cameras of the
  old one were offered** for up to an hour, and a new MCP address could be
  offered the old one's tools for up to a day. Clearing them on saving was
  not enough: a request answered in the seconds before the new settings
  reached it could list the old house and store it again. Each stored list
  now says which address it came from, and one from another address is not
  used. This also fixes the camera Test in Settings, on an address not yet
  saved: it tried the saved house's cameras, or left its own list to be
  offered to the house in use.
- **Live could go on billing for a session it had let go of.** A connection
  given up on in a tunnel could come back once a new session had opened, and
  stay open beside it until the tab closed: billed, writing what was said on
  screen twice, and cutting short the new session's requests. And a session
  ended while still connecting (a second tap on the orb, or the screen
  hidden) could connect anyway, with nothing left to end it, or show a
  browser error in red. Such sessions now close for good.

## [2.2.0] - 2026-09-29

### Security

- **Since 2.0.0, with a family, each person's notifications also reached
  everyone else's browsers and phones** where notifications were on:
  reminders, notes sent to a phone, finished jobs and answers from Hermes,
  family chat messages (direct ones between two other people included),
  passed-on messages and their answers, routines and leave-time warnings.
  Quiet hours did not stop other people's. Each person's now reach only their
  own devices; open Jarvis screens, and each member's own Telegram chat,
  already went only to them. Notifications already delivered stay where they
  arrived, and a phone that was off may still receive one for up to a day.
  An alert raised with the owner key or the first person's device (Home
  Assistant calling `/api/v1/notify`, for one) now reaches only the first
  person's devices; to tell the whole house, use Home Assistant's notify or
  ntfy.

- Signing out did not stop that person's notifications on that browser:
  whoever used it next still got them, and signing out a lost or lent
  screen from **Where you are signed in** left it receiving their alerts
  while it stayed open. Signing out, here or from another screen, now ends
  that browser's notifications, and a Jarvis open there signs out too. A
  sign-in left unused for six months ends them as well (tapping a
  notification counts as using it). Notifications turned on before this
  update end when you sign out on that screen itself; for a lost phone, also
  remove it in Settings → Alerts.
- Settings → Alerts showed every admin the text of everyone's recent alerts,
  direct messages between two other people included, and an admin could
  open anyone's alert by its id, though each person's alerts are meant to be
  theirs alone. An admin now sees when and how another person's alert went,
  not what it said.
- Settings → Google and Settings → Spotify showed, and **Test** used, the
  first person's linked account whoever was looking: Test told another admin
  the first person's Gmail address or Spotify name. Each admin now sees and
  tests their own. And changing the Google or Spotify app in Settings now
  unlinks everyone's accounts, not only the first person's.

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

[Unreleased]: https://github.com/kucau0901/jarvis-voice-agent/compare/v2.5.0...HEAD
[2.5.0]: https://github.com/kucau0901/jarvis-voice-agent/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/kucau0901/jarvis-voice-agent/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/kucau0901/jarvis-voice-agent/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/kucau0901/jarvis-voice-agent/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/kucau0901/jarvis-voice-agent/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/kucau0901/jarvis-voice-agent/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/kucau0901/jarvis-voice-agent/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kucau0901/jarvis-voice-agent/releases/tag/v1.0.0
