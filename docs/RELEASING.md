# Releasing

How Jarvis is versioned, and how a version is released. For how to update a
running copy, see the [README](../README.md#updating).

## What the numbers mean

Semantic versioning, read from the side of someone running their own copy.
The question each number answers is *what does updating ask of me?*

| Release | When | Example |
|---|---|---|
| **Patch** 1.0.**1** | Fixes only. Nothing new to learn or set. | A camera question stops timing out. |
| **Minor** 1.**1**.0 | New features, or changed behaviour that needs nothing done. New settings are optional, with defaults. | Push-to-talk tries Home Assistant's Assist first. |
| **Major** **2**.0.0 | Updating needs a step: a new required secret, a setting renamed without the old name still being read, a change to `wrangler.jsonc`, a device API change that breaks existing devices, data that must be moved. | `/api/v1/ask` changes its answer's shape. |

Prefer changes that do not need a major release. Renaming a setting, for
instance, can keep reading the old name (`RENAMED` in
`src/worker/lib/settings.ts`), which makes it a minor change.

The device API (`/api/v1`, [api.md](api.md)) follows the same rule: adding a
field is minor; removing or changing one that devices read is major.

## Releases and main

`main` always passes CI and is what the maintainer runs, but a release is the
checkpoint: changes collect under `[Unreleased]` and are released together once
they have been used for a while. Running copies are told about releases, not
commits, and the README's update commands move to the newest release rather
than to `main`.

When to release:

- **A fix for something broken or unsafe** in a copy people run: a patch
  release straight away, even for that one fix.
- **Features and small fixes:** a minor release once they have been tried,
  typically every week or two, not one per change.
- **Something that needs doing on update:** a major release, avoided where a
  compatible change will do.

## While working

Every change someone running a copy would notice gets a line under
`## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md), in the same change that
makes it, under one of:

- `### Action needed` — what to do when updating, step by step. Its presence
  is what makes a release major.
- `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security`.

Write for the person updating, not for the code: what they will notice, and
what (if anything) they must do. Refactors, tests and CI changes they cannot
notice need no line.

## Cutting a release

From a clean `main` that has passed CI:

```bash
npm run release -- minor          # or patch, or major
git push origin main --follow-tags
```

`npm run release` refuses to go on if nothing is under `[Unreleased]`, and if
the kind does not match: *Action needed* requires `major`, and `major`
requires *Action needed*. Otherwise it sets the version in `package.json` and
`package-lock.json`, dates the changelog section, updates its comparison
links, commits `Release vX.Y.Z` and tags `vX.Y.Z`. It does not push.

Pushing the tag starts [release.yml](../.github/workflows/release.yml): it
runs the tests on the tagged code, checks the tag matches `package.json`, and
publishes a GitHub release whose notes are that version's changelog section
plus how to update. People watching the repository for releases are told, and
every running copy's settings panel shows the new version within twelve hours.

`npm run release -- notes 1.2.0` prints a version's notes, as the release
will show them.

## If something goes wrong

- **The workflow failed before publishing** (a test, or the tag check): fix it
  on `main`, then move the tag with `git tag -f -a vX.Y.Z -m "Jarvis vX.Y.Z"`
  and `git push -f origin vX.Y.Z`. Nothing was published, so nobody saw it.
- **A published release is broken:** do not move its tag, as copies may
  already run it. Fix it and release a patch.
