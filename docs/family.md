# Sharing Jarvis with your family

One Jarvis, used by everyone at home. Each person signs in as themselves,
with a **passkey** (Face ID, a fingerprint or their phone's PIN; there are no
passwords). One of you is the **admin**, and decides what everyone else can
reach. The family chooses what the assistant is called: "Jarvis", or any
name you like.

This is the first part of Jarvis for families. It covers signing in,
members, roles and pairing screens. Coming next: each person's own memory,
mail and alerts; sharing the car and the house with levels; Jarvis passing
messages and reminders between you; and a family chat. See
[What is shared today](#what-is-shared-today).

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
| **Admin** | Everything, and manage the family: invite, remove, change roles, settings, devices. |
| **Adult** | Ask questions, use the house (Home Assistant), talk in live voice, see maps. |
| **Child** | Ask questions, live voice, maps. |
| **Guest** | Ask questions and live voice. |

An admin can widen or narrow any member, one item at a time, from their
card in **Members**. **Back to what an adult gets** undoes that. A family
can have more than one admin, but never none: the last admin can neither
step down nor be removed.

## Signing in on the car, a tablet or any screen

The car's browser cannot make a passkey, and typing is a chore. Pair it
instead:

1. On the car, choose **Pair with my phone**. It shows a six-letter code.
2. On your phone: **Family → Pair a screen**. Type the code and tap **Pair**.

The car signs itself in as you within a few seconds. An admin can pair a
screen for someone else, a grandparent's tablet say, by choosing them
before tapping **Pair**. A code lasts ten minutes.

On a phone or computer, **Sign in with a passkey** is quicker.

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

## What is shared today

For now, memory, mail, calendar, the car, Spotify, alerts and routines are
the admin's, as they were the owner's. That is why only admins get them by
default. You can give them to someone else, but they will see yours.

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
