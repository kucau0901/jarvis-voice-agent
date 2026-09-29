# Working on this repository

One Cloudflare Worker serves the app and `/api/*`. One Durable Object holds
most of the state (memory, the family, messages, routines, jobs, settings); KV
holds device tokens, linked-account tokens, the MCP server list and the router
model. Why it is built the way it is: `docs/DESIGN.md`, and for the family
`docs/family.md`, for alerts `docs/notifications.md`, for the device API
`docs/api.md`. Before changing an area, read its section: most of what looks
odd is a decision, with the reason written down.

## Project rules

These come from the owner and hold for every change.

- **An OpenAI key is all Jarvis needs.** Every feature works with only
  `OPENAI_API_KEY` set. Home Assistant, Tessie, Hermes, Google, Spotify,
  Telegram, ntfy and MCP servers are optional: a tool that needs one declares
  `available(env)` and disappears without it, and nothing else may assume it.
- **House safety lives in Home Assistant.** What the house may do is set
  there. No keyword lists, confirmation steps or second model call in front of
  it: scopes decide who reaches the house, Home Assistant what it does. Model
  calls cost the owner money, so take the cheap direct path.
- **Hermes can run terminal commands** where it lives. The `hermes` scope is
  never granted by default: not in a role, a device preset, a guest's pass,
  sharing the house or `READ_TOOLS`.
- **The repository is public.** Never commit the owner's real data (family
  names, addresses, domain, emails, KV or account ids, keys, tokens) in code,
  tests, docs, example configs, CHANGELOG, commit messages or PR descriptions:
  invented stand-ins only (`example.com`, made-up names). No session links in
  commit messages. Read the staged diff and the message before every commit.
- **Releases and deploys are the owner's call.** Release only when the owner
  says "release" (`npm run release -- patch|minor|major`), confirm before
  pushing the tag, and deploy (`npm run deploy`) only when asked.

## Commands

| What | Command | Notes |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | `tsc --noEmit` twice: the app (`tsconfig.json`, DOM types) and the Worker (`tsconfig.worker.json`, the Workers runtime's types). A fresh clone first needs `cp wrangler.example.jsonc wrangler.jsonc` and `npx wrangler types`. |
| Test | `npm test` | Plain Node, no runner: each `test/*.test.ts` is run with `node`, one after another. **A new test file must be added to the `test` script in `package.json`**, or it never runs. |
| Build | `npm run build` | `vite build` into `dist/`. Two warnings are expected: "chunks larger than 500 kB", and `INEFFECTIVE_DYNAMIC_IMPORT` for `@modelcontextprotocol/client`. |
| Lint | none | None is configured, and none is to be added. |
| Behavior check | `node test/behavior/check.mjs verify` | About 3 minutes. See "Checking a feature". |

Tests load source files straight into Node (type stripping), so:

- imports between Worker files, and in anything a test loads, use an explicit
  `.ts` extension;
- no TypeScript-only runtime syntax in those files (no parameter properties,
  enums or namespaces): Node's strip-only mode rejects them;
- a JSON import carries `with { type: "json" }`, as `lib/config-store.ts`'s
  does: Node rejects a bare one.

## Where things go

| Path | What it holds |
| --- | --- |
| `src/worker/index.ts` | The gate (credentials, locked profiles, hours, scopes, device limits), then `route()`. A new top-level route is one line in `route()` plus its import. A third-party redirect (an OAuth callback, which carries no credential) goes before the gate, as the Google and Spotify callbacks do. |
| `src/worker/routes/` | HTTP: read the request, check it, call `lib/`, shape the reply. One file per area. |
| `src/worker/lib/` | The logic, as plain functions and classes Node can test. New logic goes here, not in a route. |
| `src/worker/tools/` | What the router model can call: one file per service, listed in `ALL` in `tools/registry.ts`. Hermes's two tools are in `registry.ts` itself; MCP tools are added at request time. |
| `src/worker/state.ts` | The Durable Object: a thin class over `lib/` classes that do the work (`StateHost`, `HubHost`, `LiveHub`, `Scheduler`, `Jobs`, `Relays`, `Chat`). It still keeps chore points and held alerts itself; add nothing more there. |
| `src/app/main.ts` | The app's wiring: the voice session, unlocking, modes, the menu. Wiring only. |
| `src/app/ui/` | One class per panel, built in code. |
| `src/shared/` | Only what both halves need. |
| `public/` | Copied as is, never compiled. `probe.html` has no dependencies on purpose. |

A few engines still live in `routes/`, used by `state.ts` and `lib/router.ts`:
`jobEngine` (`routes/jobs.ts`), `askForRoutine` and `travelFor`
(`routes/routines.ts`), `recordUsage` (`routes/usage.ts`). Leave them there
and don't add more.

## Adding a feature

Most features are one or more of these. Copy the example named; don't invent a
new shape.

**A tool** (something Jarvis does when asked). A file in `src/worker/tools/`
shaped like `tools/notes.ts`: `name`, `description`, `parameters`, `scope`,
`pace`, `available(env)` if it needs setting up, and `run()` returning text.
Add it to `ALL` in `tools/registry.ts`.

- The schema is strict: every property in `required` and
  `additionalProperties: false`; an optional one is typed with `"null"`, as
  `title` is in `notes.ts`.
- `scope` (from `lib/scopes.ts`) decides who is even shown the tool; none means
  anyone with `ask`. Ask before adding a scope: it changes what every role and
  device can reach. If one is agreed: `SCOPES` (`lib/scopes.ts`), `ROLE_SCOPES` plus a
  `GAINS` entry and a `SCOPES_V` bump (`lib/hub.ts`), its label in
  `ui/Devices.ts` and `ui/Family.ts`, and `docs/api.md`. Every `*` device gets
  it at once.
- Text someone else wrote (mail, reviews, calendar invitations) goes back to
  the model through `asQuotedData()` in `lib/quote.ts`.
- Tools using a person's linked Google or Spotify account wrap their work in
  `guardTool()` (`lib/google.ts`).
- Background jobs are offered only the local tools named in `READ_TOOLS`
  (`lib/jobs.ts`). Add a new tool there if it only reads and jobs should have
  it; never one that sends, changes or unlocks anything.
- `test/router-inputs.test.ts` pins, for each case (owner key, admin, adult,
  child, guest), the model, the tool names and a hash of what the router is
  told, and `PROMPT_SHA256`. A feature that adds a tool, changes the prompt or
  changes what the router is told updates the matching `EXPECTED` field or
  `PROMPT_SHA256` in the same commit, with a short comment, and says so in the
  message. Anything else changing there is a regression.

**An endpoint.** In its area's file in `src/worker/routes/`, plus:

- a line in `route()` in `index.ts`, or under `/api/v1/` in `handleV1()`
  (`routes/v1.ts`), where each area's handler returns `null` for paths that are
  not its own, as `handleJobs()` does;
- a line in `requiredScope()` in `lib/scopes.ts`, in the order `route()`
  matches (prefixes first). A path no rule matches is owner-only. Everything
  under `/api/hub/`, `/api/google`, `/api/spotify` and `/api/v1/devices` is
  already open to every signed-in person, so an admin-only handler there
  checks `isAdmin()` itself, as `routes/hub.ts` does. Open a path
  deliberately, never by widening a prefix;
- bodies read with `readObject()` or `readObjectOrEmpty()`, replies made with
  `json()` and `err()` (`lib/http.ts`);
- under `/api/v1/`, a line in `docs/api.md`. Adding a field is a minor change;
  changing or removing one that devices read is a major release
  (`docs/RELEASING.md`).

**A setting.** An entry in `SETTINGS` in `lib/settings.ts` (group, kind,
label, help, `validate`, `default`) and a field in `Env` in `types.ts`. The
settings panel shows it with no UI work. A secret sent to an address that is
itself a setting goes in that address's `bindsTo`. A rename keeps the old name
working: an entry in `RENAMED` (for values saved in the panel), the old `Env`
field kept and listed in `NOT_SETTINGS` (for deployments that set it), and
reads as `env.NEW ?? env.OLD`, as `lib/assist.ts` does. `test/settings.test.ts`
checks that every `Env` field is a setting or in `NOT_SETTINGS`. Only add a
setting someone asked to change; a value with one sensible choice is a
constant.

**Stored data.** In the Durable Object, not KV: the free plan allows KV 1,000
writes a day, so the existing KV keys stay and no new ones are added. Under a
new key; never a new shape under an existing key, since running copies already
have data there.

- The logic goes in a class Node can test, given a `Storage`, like the ones
  above. Then add a pass-through method in `state.ts`, and in
  `lib/state-host.ts` the method's name in `StateApi` (for `StateHost`) or its
  signature in `RoutineApi`, `JobApi` or `FamilyApi` (for the others).
- **Forward every argument.** `stateStub()` casts to `StateApi`, so
  TypeScript catches neither a missing pass-through nor one that drops an
  argument; one that did sent every person's notifications to every phone.
  `test/state-object.test.ts` loads the object in Node and checks each
  pass-through to `StateHost`; those to the other classes are not checked.
- People and sign-in go through `lib/hub.ts` instead: add the method to
  `HubHost` and its name to `HUB_METHODS`. There is no pass-through to write.
- Anything that wakes at a time runs from the object's one alarm: a
  `nextWake()` and a `tick()`, called from `rearm()` and `alarm()` in
  `state.ts`, as `Scheduler`, `Jobs` and `Relays` do. Every pass-through that
  changes timed work ends with `await this.rearm()`, or nothing wakes. Add to
  one of those classes before making another.

**A panel.** A class in `src/app/ui/` built like `ui/Jobs.ts`: `el()`,
`button()` and `richText()` from `ui/util.ts`, JSON requests through `api()`
from `key.ts`, text through `textContent` rather than `innerHTML` templates.
Wire it in `main.ts` as `openJobs` is, put its button in `#topbtns` in
`index.html` with `data-need` set to the scope it needs, and add the button's
id to `PANELS` in `test/behavior/ui.mjs` so the behavior check opens it. A
section of Settings, Family or Memory is an element with `data-section` and
`data-title` (`ui/sections.ts`). Styles go in the `<style>` block in
`index.html`: reuse `.panel`, `.sheet`, `.rlist`, `.rform` and `.note` before
adding rules.

## Keeping it simple

What made the refactor necessary was each feature bringing its own copy of
something. So:

- **The smallest change that does the job**, in the files that already own the
  area. No unrelated edits, renames or reformatting in a feature commit.
- **Search before writing a helper.** These exist; never write a second copy:
  - Worker: `json`, `err`, `readObject`, `readObjectOrEmpty`, `redact`,
    `escapeHtml`, `publicOrigin` (`lib/http.ts`); `asQuotedData`, `tidy`
    (`lib/quote.ts`); `clampLimit` (`tools/args.ts`); `guardTool`,
    `NeedsRelink` (`lib/google.ts`); `sha256Hex` (`lib/devices.ts`); `b64u`
    (`lib/webauthn.ts`); `stateStub` (`lib/state-client.ts`); `allows`,
    `narrow` (`lib/scopes.ts`); `localeOf` (`lib/locale.ts`); `OWNER`,
    `personOfWho`, `isTheirs`, `bookOf` (`lib/context.ts`); `LOCAL`
    (`lib/routines.ts`); `withoutScreen` (`lib/scopes.ts`); `haConfig`,
    `haUrl` (`lib/ha.ts`).
  - App: `api`, `authHeaders` (`key.ts`); `el`, `button`, `esc`, `ago`,
    `arm`, `richText` (`ui/util.ts`).
  - Much of the older app code calls `fetch` with `authHeaders` itself. New
    JSON requests use `api()`, even in those files; don't copy the old pattern.
    Older copies of listed helpers exist too (`readJson` and `SCREENLESS` in
    `routes/v1.ts`, `tidy` in `lib/leave.ts`, `esc` in `ui/Settings.ts`,
    `escapeHtml` in `main.ts`): not examples to follow.
- **Don't grow the largest files**: `src/app/main.ts`, `lib/hub.ts`,
  `lib/memory.ts`, `tools/gmail.ts`, `ui/Family.ts`, `ui/Settings.ts`. New code
  goes in its own module and is called from there. If a feature needs more
  than about 40 new lines in one of them, stop and propose where it should
  live. `lib/settings.ts` and the `<style>` block in `index.html` grow only by
  the `SETTINGS` entry or the CSS rules a feature needs.
- **No new layers without asking**: no base classes, managers, plugin systems,
  event buses or generic frameworks. The extension points already exist:
  `ALL`, `SETTINGS`, `SCOPES`, `HUB_METHODS`, and `route()` with
  `requiredScope()`.
- **No new dependencies** without asking. Don't edit generated files
  (`worker-configuration.d.ts`; `package-lock.json` only with an agreed
  dependency). A new binding, Durable Object class or migration in
  `wrangler.example.jsonc` makes a major release (`docs/RELEASING.md`): ask
  first.
- **No speculative code**: no options, parameters or branches for cases nobody
  asked for, and no fallbacks for things that cannot happen.
- **Replace, don't keep both.** When a feature changes how something works, the
  old way goes in the same change. The exceptions are what running copies
  rely on: old setting names (`RENAMED`), stored keys and shapes, and
  `/api/v1` fields.
- **Never silence errors**: no new `any`, `@ts-ignore`, `@ts-expect-error` or
  `as unknown as`. Don't loosen `tsconfig.json`.
- **If a feature doesn't fit the structure above, stop** and set out two or
  three ways it could go. Don't bend the structure to fit it.

## Checking a feature

- **New logic comes with tests** in the same commit, beside the area's
  existing ones, in the same `check()` style. A fixed bug comes with a test
  that fails without the fix; where Node cannot reach the code, say in the
  commit message how it was checked. Don't change what an unrelated test
  checks to make it pass: if one fails, the change is wrong.
- **After each change**, typecheck, tests and build pass.
- **Behavior check.** Before starting, record a baseline from `main`:
  `git worktree add --detach /tmp/jarvis-main main`, then
  `node test/behavior/check.mjs record /tmp/jarvis-main .behavior-baseline`,
  then `git worktree remove --force /tmp/jarvis-main`. When done,
  `node test/behavior/check.mjs verify` lists what changed (the first 40
  differences). Each difference must be one the feature meant to make: say so
  in the commit message, or fix it.
  - It runs against stand-ins only: a fake OpenAI and Home Assistant
    (`fakes.mjs`), fresh storage, made-up keys. It makes about 105 API
    requests as a family of five (`scenario.ts`), and opens the panels listed
    in `PANELS` as an admin, an adult and a guest in headless Chrome
    (`ui.mjs`), comparing their text and each element's classes and styles,
    then puts the person in use aside on a shared screen three ways.
    It needs `node_modules`, Google Chrome at its macOS path (`CHROME=<path>`
    for another) and free ports 8791, 8792, 8798 and 9333.
  - It does not cover the live voice session (WebRTC), push-to-talk audio,
    spoken alerts, real Google, Spotify and Tessie, anything that waits on the
    clock (reminders, routines firing), or background jobs: a feature there
    needs tests of its own. Screenshots are saved for a person to look at, not
    compared.
- **Bugs noticed along the way** get their own commit, not the feature's.

## Always

- A change a self-hoster would notice gets a line under `## [Unreleased]` in
  `CHANGELOG.md` **in the same commit**, under Added, Changed, Fixed, Removed
  or Security; *Action needed* only for a step on update, which makes the
  release major (`docs/RELEASING.md`). One they cannot notice needs none.
- Don't loosen a security boundary to make a feature fit: routes are
  owner-only unless opened, tools are filtered by scope rather than by
  instruction, outside text is quoted as data, secrets never reach the
  browser, and a secret whose address was changed stays withheld (`guarded()`
  in `lib/settings.ts`). Why: `docs/DESIGN.md` ("Security", "Mail"), the
  README's settings section, and the header of `lib/scopes.ts`.
