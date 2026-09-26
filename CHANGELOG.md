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

- A setup guide for Even Realities G2 glasses: say "Hi Even" and ask, with
  Jarvis in place of the glasses' built-in assistant, so there is no app to
  open. It explains why Jarvis beats connecting OpenClaw or Hermes directly:
  faster, answers that fit the display, and background jobs for slow work.
  [docs/even-g2.md](docs/even-g2.md).

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

[Unreleased]: https://github.com/kucau0901/jarvis-voice-agent/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/kucau0901/jarvis-voice-agent/releases/tag/v1.0.0
