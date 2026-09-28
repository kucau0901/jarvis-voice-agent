# Working on this repository

## Commands

| What | Command | Notes |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | `tsc --noEmit`. A fresh clone first needs `cp wrangler.example.jsonc wrangler.jsonc` and `npx wrangler types`, which generates `worker-configuration.d.ts` (as CI does). |
| Test | `npm test` | Plain Node, no runner: each `test/*.test.ts` is run with `node`. 32 files. |
| Build | `npm run build` | `vite build` into `dist/`. The "chunks larger than 500 kB" warning is expected. |
| Lint | none | There is no linter configured, and none is to be added. |
| Behavior check | `node test/behavior/check.mjs verify` | About 1½ minutes. Builds this checkout, runs it locally and compares what it does with `.refactor-baseline/`. Exit 0 means the same behavior. See below. |

Tests load source files straight into Node (type stripping), so:

- imports between `src/worker/lib` files and anything a test loads use an
  explicit `.ts` extension;
- no TypeScript-only runtime syntax in those files (no parameter properties,
  enums or namespaces): Node's strip-only mode rejects them.

## Rules for the refactor (branch `refactor-cleanup`)

- **Zero behavior change.** These stay exactly as they are:
  - API routes, methods, request and response shapes (`src/worker/routes/`,
    `docs/api.md`);
  - the storage schema: Durable Object and KV keys and the shape of what is
    stored under them (`hub:`, `relay:`, `chat:`, `mem:`, `google:`,
    `spotify:` and the rest);
  - environment variable and setting names (`src/worker/types.ts`,
    `src/worker/lib/settings.ts`);
  - Durable Object class names, bindings and migrations in
    `wrangler.example.jsonc`.
  The package is private (not published), so there are no public exports to
  keep.
- **No new dependencies.**
- **Don't touch** `node_modules/`, build output (`dist/`), generated files
  (`worker-configuration.d.ts`, `package-lock.json`) or migrations.
- **After each step, typecheck, tests and build must pass.**
- **Never silence errors:** no new `any`, `@ts-ignore`, `@ts-expect-error`,
  `eslint-disable` or `as unknown as`. Don't loosen `tsconfig.json`.
- **Don't change what a test checks to make it pass.** Fixing an import after
  a move is fine. If a check fails, fix the change or revert it.
- **Bugs noticed along the way** go under "Bugs found" in `REFACTOR_PLAN.md`.
  They are not fixed on this branch.
- **One step at a time:** one commit per step, `refactor: <step>`, and tick the
  step in `REFACTOR_PLAN.md`. Subagents only for read-only investigation.

### Behavior checks

`test/behavior/check.mjs` runs a build of the app locally and records what it
does:

- It runs against stand-ins, never anything real: a fake OpenAI and a fake
  Home Assistant (`fakes.mjs`), a fresh local store, and made-up keys.
- **API** (`scenario.ts`): a family of five is made and uses the API, about
  105 requests. That covers sign-in, invites, pairing, PINs, memory, cars,
  passing things on, chat, a guest's pass, devices, routines, usage,
  settings, hours and removal. It also records which tools each question was
  offered and which house calls were made.
- **Screens** (`ui.mjs`): headless Chrome opens the app as an admin, an adult
  and a guest, and reads every panel, and every section of a panel with a
  menu, as text.

Times, ids, tokens and relative times ("5m ago") are ignored when comparing,
and so is the order of lists that come in random-id order. Screenshots are
saved beside the text for a person to look at; they are not compared.

- **The baseline** is `.refactor-baseline/` (git-ignored). It was recorded from
  `main` at `fc83556`, the code before this branch. To record it again:
  `git worktree add --detach /tmp/jarvis-main main`, then
  `node test/behavior/check.mjs record /tmp/jarvis-main .refactor-baseline`,
  then `git worktree remove --force /tmp/jarvis-main`.
- **Checking a change:** `node test/behavior/check.mjs verify`. On a difference
  it lists each request or screen that changed, and keeps that run for
  inspection.
- **What it needs:** the repository's `node_modules`, Google Chrome
  (`CHROME=<path>` for another), and free ports 8791, 8792, 8798 and 9333.
- **What it does not cover:**
  - the live voice session (WebRTC), push-to-talk audio and spoken alerts;
  - real Google, Spotify and Tessie;
  - anything that waits on the clock: scheduled reminders, routines firing,
    nudges;
  - background jobs;
  - how a screen looks, as opposed to what it says.

  A step touching those needs tests of its own first.

### [med] and [high] steps

- **Before the step:** if the code it touches has no tests, write tests for
  its current behavior, confirm they pass, and commit them on their own
  (`refactor: test <what> before step <n>`).
- **After the step:** typecheck, tests and build pass (there is no linter),
  and `node test/behavior/check.mjs verify` reports the same behavior as the
  baseline.
- **If anything differs and cannot be fixed:** revert the step and mark it
  blocked in `REFACTOR_PLAN.md`, with the reason. Never commit an unverified
  step.

## Always

- This repository is public: invented names only in code, tests and docs
  (never the owner's family, address, domain, keys or accounts).
- A change a self-hoster would notice gets a line under `## [Unreleased]` in
  `CHANGELOG.md` (docs/RELEASING.md). A refactor with no behavior change needs
  none.
