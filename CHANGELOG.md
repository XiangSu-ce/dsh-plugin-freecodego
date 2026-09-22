# Changelog

Every release of this repository, newest first.

**This file is where a release takes its notes from.** The release workflow
(`.github/workflows/release-freecodego.yml`) reads the section whose heading
names the version it is publishing and refuses to build anything when there is
none, so a version with no section here cannot be released by accident — the run
stops in its first seconds instead of publishing a Release nobody can read.

The heading names the version the tag publishes (`freecodego-v<version>`), which
is this bundle's own version, not the Harness line it mounts on. English only:
the notes are the release's own text, and a paired translation of a published
changelog would be a second thing to keep in step without a reader who needs it.

## 0.1.6-alpha.2.4 — 2026-09-23

Nothing in the bundle itself changes in this version either: it carries the
release pipeline fixes the version before it exposed, so that a release which
fails in the registry half can be retired or repaired instead of leaving a tag
whose two halves disagree.

### Fixed

- A publish the registry acknowledges is no longer treated as a published
  version. The registry accepts an upload before the version it accepted can be
  installed, and npm reports that acceptance as success — in its own words,
  "Your package is being processed and may take a few minutes to become
  available" — so the publish step confirmed nothing, the release step built the
  release on top of it, and the final step found no version to verify. The
  publish step now waits until the registry carries this release's bytes, and
  says what happened when it never does.
- A release whose registry half failed can be repaired by re-running it. The
  release step refused any tag that already carried a release, so a run that had
  published its release asset while the registry half was still arriving could
  not be retried at all — which is the one situation the step order (registry
  first, release second) exists to make re-runnable. It now continues when the
  existing release already carries this run's asset, and still refuses one
  carrying anything else, because that is what a withdrawn release looks like.
- The verification step reads the registry until it settles instead of once, so
  a slow registry is no longer reported as a failed release.
- A refused publish explains itself. npm answers every way the
  trusted-publishing exchange can fail with one opaque `ENEEDAUTH`, and prints
  its own reason only at a raised log level — which is what the previous
  version's release spent its attempts discovering. The publish step now names
  the trusted-publisher fields the run has to match, read from the run itself,
  or the permission that never reached npm; and a manually dispatched run can
  raise npm's log level to read the registry's own words.

## 0.1.6-alpha.2.3 — 2026-09-23

Nothing in the bundle itself changes in this version: it is about being able to
build and publish the bundle from this repository alone. A reader who only mounts
it can skip it.

### Changed

- The published tree now carries every helper its own release run reads. The
  workspace synchronization reads a few of them directly, and without them the
  release stopped in its first minute — before anything was built, with the
  publish half skipped behind it. That is why the three versions before this one
  exist as tags and releases on GitHub but never reached the registry.
- The synchronization also materializes the upstream entries under `scripts/`
  that a fresh clone does not start with, and the workspace manifest names the
  bundler those steps use. Both are what the build stopped on once the
  synchronization itself could run.
- Release notes are written per version, in this file, and a release takes them
  from the section naming its version. The fixed sentence they replace described
  the artifact rather than the version, so a reader learned nothing about what
  changed — and a version with no section here is now refused before the build
  starts rather than published under notes about some other version.

## 0.1.6-alpha.2.2 — 2026-09-23

### Added

- The free-model tables in this repository's READMEs are **generated** from each
  provider's own directory rather than maintained by hand. Three providers are
  read live (OpenCode, Kilo, Logfare); NVIDIA and SenseNova publish a roster and
  expose a directory that needs a key, so their rows are cross-checked when the
  environment has one. The generator and its check ship in the package:
  `pnpm run generate-free-model-tables` and `pnpm run verify-free-model-tables`.
  A route upstream retires now leaves the table on the next read, which is how
  `gpt-image-2` and `hy3-free` were found still listed after they were withdrawn.
- The lefthook installer the workspace's `postinstall` names is part of the
  published tree, so a clone can install without a missing-module failure.

### Fixed

- Regenerating the tables without network access dated them to the previous day
  whenever the recorded reading happened between local midnight and the UTC
  offset. The recording now carries the date the reading had, which is the date
  the table states, and a recording without one is refused instead of guessed.

## 0.1.6-alpha.2.1 — 2026-09-23

### Changed

- Pushing the family's tag (`freecodego-v*`) now starts the release workflow by
  itself, so publishing a version needs no second action after the push. A
  manual dispatch remains for a re-run that has to start without a new tag.
- The workflow's pnpm setup reads `plugin/package.json`: the workspace manifest is
  where this repository declares its pnpm version, and a run that looked for it at
  the repository root failed before the first step.

## 0.1.6-alpha.2 — 2026-09-23

### Added

- First public release: FreeCodeGo for DeepSeek Harness, published as the
  standalone `freecodego` bundle — the engine inventory, a managed free-model
  gateway, per-provider accounts, media generation, and the engineering
  (code-graph + memory) toolchain — together with this repository's root face.
