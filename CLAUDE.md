# Working on this repository

## Commands

| What | Command | Notes |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | `tsc --noEmit`. A fresh clone first needs `cp wrangler.example.jsonc wrangler.jsonc` and `npx wrangler types`, which generates `worker-configuration.d.ts` (as CI does). |
| Test | `npm test` | Plain Node, no runner: each `test/*.test.ts` is run with `node`. 32 files. |
| Build | `npm run build` | `vite build` into `dist/`. The "chunks larger than 500 kB" warning is expected. |
| Lint | none | There is no linter configured, and none is to be added. |

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

## Always

- This repository is public: invented names only in code, tests and docs
  (never the owner's family, address, domain, keys or accounts).
- A change a self-hoster would notice gets a line under `## [Unreleased]` in
  `CHANGELOG.md` (docs/RELEASING.md). A refactor with no behavior change needs
  none.
