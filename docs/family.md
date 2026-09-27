# Sharing Jarvis with your family

One Jarvis, used by everyone at home. Each person signs in as themselves,
with a **passkey** (Face ID, a fingerprint or their phone's PIN; there are no
passwords). One of you is the **admin**, and decides what everyone else can
reach. The family chooses what the assistant is called: "Jarvis", or any
name you like.

Each person has their own memory, mail, calendar, music, reminders and
alerts; the family has a memory it shares; cars are shared by their owners,
to see or to drive; and Jarvis passes things on between you, and talks with
you in the family chat. See
[What is yours, and what is shared](#what-is-yours-and-what-is-shared) and
[Passing things on](#passing-things-on-and-the-family-chat).

## Setting it up

You need the **owner key**: the `JARVIS_SHARED_SECRET` you deployed with.

1. On your phone, open Jarvis and unlock it with the owner key.
2. **Family** opens, offering to set up your family (it is also in the menu).
   Enter your name, the family's name, and what you call the assistant.
3. Tap **Create my passkey**, and confirm with Face ID, a fingerprint or
   your PIN.

You are now the admin, signed in as yourself. The owner key keeps working
everywhere it was already used. **Keep it somewhere safe**: it is the way
back in if every passkey is ever lost.

Until you do this, nothing changes: Jarvis works on the owner key, as before.

## Inviting someone

In **Family → Invite someone**, give their name, choose a role, and tap
**Make an invite link**. Send them the link, or let them scan the QR code
from their phone. They open it, check their name, and make a passkey. The
link works once, for seven days. Whoever opens it first joins, so send it
only to them.

| Role | Can, until you change it |
|---|---|
| **Admin** | Everything, and manage the family: invite, remove, change roles, settings, devices, Hermes. |
| **Adult** | The house (Home Assistant); their own memory, mail, calendar, Spotify, alerts and reminders; changing what the family shares; cars, as far as their owners share them; live voice, maps. |
| **Child** | Their own memory, calendar, alerts and reminders; cars, as far as their owners share them; live voice, maps. |
| **Guest** | Ask questions and live voice. |

An admin can widen or narrow any member, one item at a time, from their
card in **Members**. **Back to what an adult gets** undoes that. A family
can have more than one admin, but never none: the last admin can neither
step down nor be removed.

## Signing in on the car, a tablet or any screen

The car's browser cannot make a passkey, and typing is a chore. Pair it
instead:

1. On the car, choose **Pair with my phone**. It shows a six-letter code.
2. On your phone: **Family → Sign in another screen**. Type the code and
   tap **Sign it in**.

The car signs itself in as you within a few seconds. An admin can pair a
screen for someone else, a grandparent's tablet say, by choosing them
before tapping **Sign it in**. A code lasts ten minutes.

On a phone or computer, **Sign in with a passkey** is quicker.

A screen already unlocked with the owner key (the car, if you set it up
before families) keeps working as it is. To make it yours: **Family → Pair
this screen with my phone**, and approve the code on your phone. The owner
key stays on that screen until you do.

## A screen you share: the family car

A phone is one person's. The car, or a tablet at home, can hold the whole
family: each person is added once, and switching is a tap.

- **Add someone:** on the car, **Family → Add someone to this screen**. It
  shows a code; they type it on their phone (**Family → Sign in another
  screen**). You both stay signed in on the car.
- **Switch:** tap the name at the top (**JARVIS · ADAM**), and choose who is
  using it.
- **A PIN keeps your profile yours.** Set one in **Family → A screen you
  share** (4 to 8 digits). With it, switching away from you locks you on
  that screen: your sign-in there does nothing, not even for someone who
  copies it, until your PIN is given. A screen shared by two or more people
  also locks you after half an hour untouched, and asks who is using it. Set
  one if your profile can do things others in the car should not: unlock
  it, open the gate.
- **Five wrong PINs** in a row wait fifteen minutes. **Forgot yours?** An
  admin can clear it from your card in Members, and you set a new one.

Without a PIN, anyone at that screen can switch to you.

## Passing things on, and the family chat

Ask Jarvis, by voice or typing, as you would ask anyone at home:

- **"Remind Aisyah to buy ice cream when she gets home, around five."** At
  five, or once she is home, whichever is later, it reaches her: on her
  open Jarvis screen (said aloud), her phone, or her Telegram. She taps
  **Done** (or **Can't**), or tells Jarvis "done", and you hear it.
- **"Ask Mum if she wants anything from the shop."** Her answer comes back to
  you, wherever you are.
- **"Tell everyone dinner is at eight."** Or **"ask everyone where we should
  eat on Saturday"**: each answers, and when all have, you hear the answers
  together.
- **"Did Aisyah get my message?"**, **"what's still open?"**: Jarvis knows
  what became of each.

Unanswered, a reminder or question nudges once after half an hour; after an
hour, you are told it has not been answered. A day after it was due, it is
let go.

**"When she gets home"** needs to know where she is: her person in Home
Assistant, which follows her phone (Family → You → **Getting home**, or an
admin sets it on her card, `person.aisyah`). Without it, it goes by the time
alone, and Jarvis says so.

**Chat** (in the menu) has the family room everyone shares, and a
conversation with each person. What Jarvis passed on between two people
appears in theirs, with Done or a reply while it waits. In the family room,
name the assistant, "**Jarvis**, add rice to the shopping list", and it
answers there, as you, with what you may reach. Each message reaches the
others quietly, as a notification, not aloud.

Talking with the family needs the `chat` permission: adults and children
have it; guests do not.

## Lost phone, new phone

- **A new phone with the same account** (iCloud Keychain, Google Password
  Manager): passkeys usually sync, so just sign in.
- **Otherwise**, an admin opens the person's card and taps **New passkey
  link**. That link adds a passkey to them; it does not make a new person.
- **You can add passkeys yourself** while signed in: **Family → Your
  passkeys → Add a passkey on this device**.
- **The admin lost everything:** unlock with the owner key, open **Family**,
  and make yourself a **New passkey link**.

**Where you are signed in** lists your screens, and signs any of them out.
A screen that goes unused for six months signs itself out.

## Removing someone

Tap **Remove** on their card. Their sessions end and their passkeys are
deleted: within half a minute on every screen, since each server copy
remembers a sign-in that long. Any Jarvis screen they have open stops
receiving alerts.

## What is yours, and what is shared

**Yours alone** — nobody else sees them, admins included:

- **Memory.** "Remember that…" saves to your own. Only you see it, in
  **Memory → Mine**.
- **Mail, calendar and contacts.** Link your own Google in **Family → You →
  Your accounts**. If the family's Google app is still in testing, an admin
  adds your Google address as a test user in Google Cloud first.
- **Spotify.** Link your own the same way.
- **Reminders, routines and background jobs.** They are yours, they run as
  you (your calendar, your memory), and they tell only you.
- **Alerts.** They go to your open Jarvis screens, your phones and your own
  Telegram chat (**Family → You → Telegram**). Never to the family's
  notification channels, and never to anyone else's.
- **Your voice and language**, in **Family → You**. Empty means the family's.
- **The conversation across your devices** ("what was that address again?").
- **What you have used**, in **Family → You**. Admins see everyone's in
  Settings → Usage.

**The family's**, shared by everyone:

- **Family memory**: the house, the family doctor, where the spare key is.
  Say "remember *for the family* that…", or add it in **Memory → The
  family's**. **Move to the family's** moves one of your own there. Everyone
  who may read memory sees it; adults (the `family` permission) change it.
- **The house**, through Home Assistant: adults get it by default.
- **The assistant's name, and the family's defaults** (Settings, for admins).

**Cars are their owners'**, shared as far as the owner chooses. In
**Family → You → Cars**:

- **The car in Settings** is the first person's (whoever set up the family).
  They choose, for each person, *not shared*, *may see it* (where it is, the
  battery, whether it is locked) or *may drive it* (climate, locks,
  navigation too).
- **Anyone can add their own car** with their Tessie token (dash.tessie.com →
  Settings → API), and share it the same way. A daughter who gets a car adds
  it, and decides who sees or drives it.
- Asked about "the car", Jarvis uses your own if you have one, else one
  shared with you. Name another: "is **Mum's car** charged?". A car shared to
  see is never operated.

**The house** is the family's, for everyone with the `home` permission
(adults, by default). Optionally, each person can give their own Home
Assistant user's token (**Family → You → Home Assistant**): the house then
answers them as themselves, so Home Assistant's logbook shows who did what,
and whatever Home Assistant allows that user is what they can do.

**Still the admin's**: Hermes, which can run commands on its machine. What
Jarvis kept before there was a family (your memory, your Google, your
reminders) is the first person's, where it always was.

Two things changed with families:

- **Hermes is its own permission** (`hermes`), because Hermes can run
  commands on its machine. Sharing the house never shares it. Devices made
  before this version with the house keep Hermes.
- **What Jarvis knows about you** (the profile it reads before answering)
  now goes only to people and devices allowed to read memory.

## For developers

- The routes are in [docs/api.md](api.md#families-and-signing-in).
- Passkeys are checked in `src/worker/lib/webauthn.ts`, with WebCrypto and no
  library.
- People, invites, sessions and pairing are in `src/worker/lib/hub.ts`, kept
  in the Durable Object that already holds memory. No new binding or setting
  is needed.
