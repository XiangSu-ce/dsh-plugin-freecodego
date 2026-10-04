/**
 * Materialize the locked official Harness source directly into this workspace.
 *
 * Why the order below is copy-then-sweep
 * -------------------------------------
 * This script used to remove each destination directory and then copy the cache
 * over it. On 2026-09-19 the cache (`.upstream-cache/<commit>`) held nothing but a
 * `.git` directory, so every `rm` succeeded and every `cp` failed on a source that
 * was not there: the upstream tree, and the 12 uncommitted fixes living in it, were
 * deleted, and the first error named a path inside the cache rather than the
 * deletion that had already happened. The release workflow runs this unattended, so
 * the same shape was one empty cache away from repeating.
 *
 * The order is therefore inverted, and each step is what makes the next one safe:
 *
 *   1. resolve the source and prove it is a Harness checkout -- a source without
 *      `packages/` aborts before the first write;
 *   2. copy over the destination, which never removes anything the source has;
 *   3. sweep the names the source does not have, so the destination still ends up an
 *      exact mirror -- the promise COMPATIBILITY.md records for the directories this
 *      script owns.
 *
 * A destination is never removed on the strength of an *expected* source, and a
 * cache directory that exists without content is refused rather than re-cloned, so
 * there is no deletion anywhere in this file before a copy has succeeded.
 *
 * `scripts/` is the one directory that cannot be mirrored that way, because it
 * holds upstream files and fork-owned ones side by side: a wholesale copy would
 * sweep the fork's own scripts, and skipping it leaves the upstream helpers the
 * synced workspace imports absent in a fresh clone (see `addMissingScriptFiles`).
 *
 * Environment seams, all optional:
 *   HARNESS_SYNC_ROOT       workspace root to sync into (default: this script's parent)
 *   HARNESS_SYNC_SOURCE     upstream tree to copy from, bypassing cache discovery
 *   HARNESS_SYNC_DRY_RUN    `1` reports the plan and writes nothing, not even a clone
 *   HARNESS_SYNC_PATCH_ONLY `1` re-applies only the forks at the bottom of this
 *                           file to the tree as it stands, copying nothing and
 *                           needing no upstream source
 *   HARNESS_SYNC_COPY_ONLY  `1` performs the copies described above and stops
 *                           before the forks, so a fixture source can exercise the
 *                           copy contract on its own
 */

import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(process.env.HARNESS_SYNC_ROOT ?? resolve(import.meta.dirname, '..'))
const dryRun = process.env.HARNESS_SYNC_DRY_RUN === '1'
const lock = JSON.parse(await readFile(join(root, 'harness.lock.json'), 'utf8'))
const config = JSON.parse(await readFile(join(root, 'harness.config.json'), 'utf8'))
const repository = lock.repository ?? config.repository
const commit = lock.candidate?.commit
if (typeof repository !== 'string' || typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error('harness.lock.json must contain repository and candidate.commit')
}

const cache = join(root, '.upstream-cache', commit)

// Directories this script owns wholesale: each one ends up an exact mirror of the
// source copy, which is the promise COMPATIBILITY.md records for them.
const copiedDirectories = ['apps', 'native', 'python', 'docs', 'website', 'snapshots', 'vendor']

/**
 * The in-box bundle set a FreeCodeGo profile starts from.
 *
 * 0.2.0 split the scheduler out into the shipped optional bundle
 * `@deepseek-ai/dsh-experimental-schedule-bundle`, and 0.2.1 retired it again: the
 * Web composition declares the `schedule` row itself and the `standard` preset
 * declares the clock and reminder rows. Naming the retired bundle here would mount
 * nothing -- `app-boot`'s `RETIRED_BUNDLES` drops it from every profile it loads --
 * so the set is the web template's own two bundles. One declaration, so the
 * constants injected into the official installer and the idempotent branch that
 * brings an already-materialized tree forward cannot drift.
 */
const FREECODEGO_PROFILE_BUNDLES_DECLARATION = "const FREECODEGO_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']"

/** The Desktop profile's bundle list: the web template plus the app-owned FreeCodeGo bundle. */
const DESKTOP_PROFILE_BUNDLES_DECLARATION = 'const DESKTOP_PROFILE_BUNDLES: readonly string[] = [...WEB_PROFILE.bundles, FREECODEGO_BUNDLE]'



// Re-apply the forks alone, without a source checkout.
//
// Every fork function is idempotent (each one checks for its marker and returns),
// so a second run reports nothing to do rather than writing the same bytes again.
// That makes this mode the way to answer "is the patch I just wrote live?" -- and
// the way to restore the forks after resolving a conflict by hand -- without
// holding a checkout of the locked commit, which on this host is the difference
// between a one-second check and a network clone.
if (process.env.HARNESS_SYNC_PATCH_ONLY === '1') {
  await applyForks(root)
  console.log(`sync-harness: re-applied forks under ${root} (patch-only; nothing copied)`)
  process.exit(0)
}

/**
 * The tree this run copies from.
 *
 * A checkout of the locked commit kept beside the workspace wins over the cache: it
 * needs no network, and `git clone` on this host fails on certificate revocation
 * checks (CRYPT_E_REVOCATION_OFFLINE) before it can fetch anything. A `.git`-only
 * cache directory -- the state that caused the 2026-09-19 loss -- is not a source, so
 * the test is `packages/` rather than `.git`.
 */
async function resolveSource() {
  const override = process.env.HARNESS_SYNC_SOURCE
  if (override !== undefined) return resolve(override)
  // Two locations, because the checkout may sit either inside the tree the sync
  // writes into or beside it: `plugin/.upstream-src/<name>` and
  // `plugin/../.upstream-src/<name>`. HARNESS_SYNC_SOURCE covers anywhere else.
  const name = `deepseek-harness-${commit}`
  for (const candidate of [join(root, '.upstream-src', name), join(root, '..', '.upstream-src', name)]) {
    if (existsSync(join(candidate, 'packages'))) return candidate
  }
  if (existsSync(join(cache, 'packages'))) return cache
  if (existsSync(cache)) {
    // Present but empty is the accident's precondition. Cloning over it would
    // replace an honest refusal with whatever the network answers, and on this host
    // the clone fails on certificate revocation checks anyway.
    throw new Error(
      `the upstream cache ${cache} exists but has no packages/ directory; refusing to sync. ` +
        'Remove that directory to force a fresh clone, or set HARNESS_SYNC_SOURCE to a checkout of this commit. ' +
        'Nothing was copied and nothing was removed.',
    )
  }
  if (dryRun) {
    throw new Error(`no upstream source for ${commit}: no .upstream-src/${name} checkout and no ${cache}, and a dry run does not clone ${repository}`)
  }
  await mkdir(join(root, '.upstream-cache'), { recursive: true })
  run('git', ['clone', '--filter=blob:none', repository, cache])
  run('git', ['-C', cache, 'checkout', '--detach', commit])
  return cache
}

const sourceRoot = await resolveSource()

/**
 * Refuse to sync from something that is not a Harness checkout, before any write.
 *
 * Checked up front rather than lazily, because the failure being guarded against is
 * a *partially* usable source: copying the directories that happen to be there and
 * failing later turns a missing cache entry into a half-synced tree instead of a
 * no-op.
 */
async function assertSourceUsable(source) {
  const refuse = (reason) => {
    throw new Error(`upstream source ${source} ${reason}; refusing to sync. Nothing was copied and nothing was removed.`)
  }
  if (!existsSync(join(source, 'packages'))) refuse('has no packages/ directory')
  if ((await readdir(join(source, 'packages'))).length === 0) refuse('has an empty packages/ directory')
  const present = copiedDirectories.filter((directory) => existsSync(join(source, directory)))
  if (present.length === 0) refuse(`contains none of ${copiedDirectories.join(', ')}`)
}

// Called before the first write in this file, which is the point of it: a source
// that cannot be a checkout aborts here instead of half-way through the copies.
await assertSourceUsable(sourceRoot)

/**
 * Destination entries the sweep never removes, because the source cannot own them.
 *
 * A clone has no `node_modules`: the links are made by `pnpm install`, one per package
 * that has dependencies. "Remove what the source does not have" therefore deleted every
 * one of them on every sync -- silently, since a swept link looks exactly like a link
 * that was never made. What it cost: the host type gate then reports thousands of
 * `Cannot find module 'react'`/TS7026 errors that belong to the *install*, not to the
 * sync, and every reading of it is untrustworthy until someone notices and reinstalls.
 * `.git` is here for the same reason -- it is not upstream's to sweep.
 *
 * Build output (`lib/`, `dist/`, `*.tsbuildinfo`) is deliberately *not* on this list: it
 * is derived from the files the mirror does own, so letting it outlive the sources it
 * was emitted from is the worse failure. It is regenerated by the next build, and the
 * type gate rebuilds what it needs.
 */
const UNCLEARED_BY_SWEEP = new Set(['node_modules', '.git'])

/** Remove destination entries the source does not have, so the mirror is exact. */
async function sweepMissing(from, to) {
  const [sourceEntries, targetEntries] = await Promise.all([
    readdir(from, { withFileTypes: true }),
    readdir(to, { withFileTypes: true }),
  ])
  const expected = new Map(sourceEntries.map((entry) => [entry.name, entry]))
  let swept = 0
  for (const entry of targetEntries) {
    if (UNCLEARED_BY_SWEEP.has(entry.name)) continue
    const counterpart = expected.get(entry.name)
    if (counterpart === undefined) {
      await rm(join(to, entry.name), { recursive: true, force: true })
      swept += 1
      continue
    }
    if (entry.isDirectory() && counterpart.isDirectory()) swept += await sweepMissing(join(from, entry.name), join(to, entry.name))
  }
  return swept
}

/**
 * Repair the one case `cp` cannot express: a name that changed kind upstream.
 *
 * `cp` with `force` overwrites a file with a file, but a file upstream turned into a
 * directory (or the reverse) fails the copy. Every removal here is guarded by the
 * source declaring that same name, so it is always followed by a copy of it: a
 * replacement step, not a cleanup.
 *
 * Both kinds are read from the *source* first. An earlier revision only asked what
 * the destination was, so a file upstream sitting where the destination had a
 * directory reached `readdir(from)` and threw ENOTDIR before any copy ran. That is
 * a real shape in this repository -- `packages/` itself carries `AGENTS.md`,
 * `README.md` and `tsdown.worker.ts` beside the scope directories.
 */
async function alignKinds(from, to) {
  const source = statSync(from, { throwIfNoEntry: false })
  const target = statSync(to, { throwIfNoEntry: false })
  if (source === undefined || target === undefined) return
  if (source.isDirectory() !== target.isDirectory()) {
    await rm(to, { recursive: true, force: true })
    return
  }
  // Two files: `cp` overwrites in place, and neither side has names to compare.
  if (!source.isDirectory()) return
  const [sourceEntries, targetEntries] = await Promise.all([
    readdir(from, { withFileTypes: true }),
    readdir(to, { withFileTypes: true }),
  ])
  const expected = new Map(sourceEntries.map((entry) => [entry.name, entry]))
  for (const entry of targetEntries) {
    const counterpart = expected.get(entry.name)
    if (counterpart === undefined) continue
    if (entry.isDirectory() !== counterpart.isDirectory()) {
      await rm(join(to, entry.name), { recursive: true, force: true })
      continue
    }
    if (entry.isDirectory()) await alignKinds(join(from, entry.name), join(to, entry.name))
  }
}

/**
 * Copy `from` over `to`, then sweep what is left over, in that order.
 *
 * Sweeping compares directory entries, which only a directory has: a file source is
 * already a complete copy of itself, and `readdir` on it would throw ENOTDIR.
 *
 * Symlinks are dereferenced on purpose. The upstream tree keeps a handful of them
 * -- `packages/CLAUDE.md` -> `AGENTS.md`, `apps/cli/tests/profiles/acp/cordis.yml`
 * -> a snapshot, four under `snapshots/session/office-skills*` -- and this
 * destination has never held one: every earlier sync materialized the target's
 * bytes. Two reasons to keep that. A destination that holds no symlinks is the
 * only shape where comparing names means anything, because a link to a directory
 * answers `readdir` with the *source's* entries and silently disarms the sweep. And
 * it makes the result host-independent: `git clone` on Windows writes a symlink as
 * a plain file containing the link target (`core.symlinks=false` is the default),
 * so a checkout that preserved links would produce a different tree here than on
 * the release host. Dereferencing is what makes this copy a copy.
 */
async function mirrorDirectory(from, to) {
  const source = statSync(from, { throwIfNoEntry: false })
  await alignKinds(from, to)
  await cp(from, to, { recursive: true, force: true, dereference: true })
  return source?.isDirectory() === true ? sweepMissing(from, to) : 0
}

/**
 * The upstream paths `git` records as symlinks, read from the source's own index.
 *
 * Asked of git rather than guessed from file contents. A file whose whole body
 * happens to name a path beside it looks exactly like a materialized link, and
 * this pass overwrites what it finds, so shape is not a safe test. The index is
 * the authority, and it also carries the count, which is what lets a run report
 * how many it restored instead of leaving the number implicit.
 * @param sourceRoot - the upstream checkout the sync copied from.
 * @param commit - the locked upstream commit.
 * @returns repository-relative paths whose recorded mode is `120000`, or
 *   undefined when the source is not a checkout and the set cannot be known.
 */
function upstreamSymlinkPaths(sourceRoot, commit) {
  // `HARNESS_SYNC_SOURCE` may legitimately name a plain directory -- the fixture
  // suite drives the copy rules from exactly such a source -- and git cannot say
  // which paths are links there. Probed first so "cannot know" is reported as
  // such, instead of surfacing as an `ls-tree` failure on a source that is fine.
  if (spawnSync('git', ['-C', sourceRoot, 'rev-parse', '--git-dir'], { encoding: 'utf8', windowsHide: true }).status !== 0) {
    return undefined
  }
  // `-z`: a path may contain anything, and the record is
  // `<mode> SP <type> SP <object> TAB <path>`.
  // `maxBuffer` is load-bearing: this listing is every path in the repository --
  // 1,566,458 bytes at 0.1.7-rc.2 -- and `spawnSync` caps stdout at 1 MiB by default.
  // Exceeding the cap returns `status === null` with `error.code === 'ENOBUFS'` and an
  // *empty* stderr, which is why the sync once died here reporting a bare "git ls-tree
  // failed": the reason existed, nothing carried it. The cap is raised well past any
  // repository this script could be pointed at, and the spawn error is named when the
  // call fails for a reason git never got to speak about.
  const result = spawnSync('git', ['-C', sourceRoot, 'ls-tree', '-r', '-z', commit], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(`sync-harness: cannot read symlink modes from ${sourceRoot}: ${(result.stderr ?? '').trim() || result.error?.message || 'git ls-tree failed'}`)
  }
  return result.stdout.split('\0').flatMap((record) => {
    if (!record.startsWith('120000 ')) return []
    const tab = record.indexOf('\t')
    return tab === -1 ? [] : [record.slice(tab + 1)]
  })
}

/**
 * Resolve one upstream symlink to the bytes its destination has to hold.
 *
 * Two hosts, two shapes. A checkout that kept the link is read through it; one
 * that materialized it (`core.symlinks=false`, the Windows default) leaves the
 * target text in a regular file, so this reads the file and resolves what it
 * says. Both answers are the same bytes, which is what makes the repair
 * idempotent on a host that never needed it.
 * @param sourceRoot - the upstream checkout the sync copied from.
 * @param path - a path {@link upstreamSymlinkPaths} named.
 * @returns the target's bytes, or undefined when the link resolves to no file.
 */
async function resolveUpstreamLink(sourceRoot, path) {
  const link = join(sourceRoot, path)
  const info = await lstat(link).catch(() => undefined)
  if (info === undefined) return undefined
  const target = info.isSymbolicLink()
    ? await realpath(link).catch(() => undefined)
    : resolve(dirname(link), (await readFile(link, 'utf8').catch(() => '')).trim())
  if (target === undefined || target === '') return undefined
  const resolved = await lstat(target).catch(() => undefined)
  if (resolved === undefined || !resolved.isFile()) return undefined
  return await readFile(target)
}

/**
 * Write each upstream symlink's target bytes into the mirrored destination.
 *
 * `mirrorDirectory` copies with `dereference: true`, which resolves a link on a
 * host that holds one. The source is a `git clone` of the pinned commit, so on a
 * Windows host there is nothing to resolve: the clone wrote each symlink as a
 * plain file containing its target, the dereference had nothing to do, and the
 * link *text* was copied into the tree. Upstream keeps twelve, and two of them
 * are load-bearing rather than cosmetic:
 *
 *   - `packages/CLAUDE.md` and `vendor/CLAUDE.md` are the agent instructions, and
 *     what sat there was the nine bytes `AGENTS.md`;
 *   - `apps/cli/tests/profiles/acp/cordis.yml` is read as a Loader config by
 *     `verify-cordis-config`, where the link text parses as a YAML string and the
 *     gate fails with "root must be a Loader entry array";
 *   - the rest are `system-prompt.expected.md` and `tool-schemas.expected.json`
 *     fixtures, which a test compares against a run's real output.
 *
 * @param root - the plugin root, repaired in place.
 * @param sourceRoot - the upstream checkout the sync copied from.
 * @param commit - the locked upstream commit.
 * @returns the repository-relative paths whose content changed.
 */
async function repairMaterializedSymlinks(root, sourceRoot, commit) {
  const paths = upstreamSymlinkPaths(sourceRoot, commit)
  if (paths === undefined) {
    console.log(`sync-harness: ${sourceRoot} is not a git checkout, so the symlink set is unknown and was not restored`)
    return []
  }
  const repaired = []
  for (const path of paths) {
    const destination = join(root, path)
    const bytes = await resolveUpstreamLink(sourceRoot, path)
    if (bytes === undefined) continue
    const current = await readFile(destination).catch(() => undefined)
    if (current !== undefined && current.equals(bytes)) continue
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
    repaired.push(path)
  }
  return repaired
}

/**
 * Add the upstream files under `scripts/` that this tree does not have.
 *
 * This is the third way one of upstream's trees can be materialized, and it exists
 * because `scripts/` is the only one the fork shares with upstream *file by file*
 * rather than owning outright:
 *
 *   - mirrored (`apps/`, `packages/`, ...): upstream owns every name, so the copy
 *     is followed by a sweep;
 *   - created (`scripts/harness-overlay`): the fork owns every name;
 *   - added (here): both own names, and most of upstream's are needed untouched.
 *
 * What makes the synced workspace need them is that it typechecks and builds as a
 * whole: upstream's own specs and build configs import helpers that live under
 * `scripts/` (`gen-tool-catalog`, `project-doc-site`, `libreoffice-packages`, the
 * coverage partitions `vitest.config.ts` names). A published clone starts with
 * none of them -- `scripts/*` is gitignored except for the fork's own entries --
 * so the release run reached `build:official` and died there on unresolved imports
 * of files this working copy has had since it was first imported.
 *
 * Add-only, and that is what makes the missing protection list unnecessary: a name
 * that already exists is left exactly as it is, which is what the fork wants for
 * the 23 files here that differ from upstream (the four this script patches among
 * them) and for the files upstream never had. Nothing is overwritten, so there is
 * nothing to protect, and nothing is swept, so nothing of the fork's can be lost.
 *
 * @param from - the source `scripts/` directory.
 * @param to - the destination `scripts/` directory, created if absent.
 * @returns how many files were added.
 */
async function addMissingScriptFiles(from, to) {
  if (!existsSync(from)) return 0
  await mkdir(to, { recursive: true })
  let added = 0
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      // A directory name both sides have is descended into rather than replaced:
      // `scripts/release/` holds upstream's steps and the fork's own together.
      added += await addMissingScriptFiles(source, target)
      continue
    }
    if (existsSync(target)) continue
    await cp(source, target, { dereference: true })
    added += 1
  }
  return added
}

const summary = { mirrored: 0, swept: 0, skipped: [] }

for (const directory of copiedDirectories) {
  if (!existsSync(join(sourceRoot, directory))) {
    // Upstream dropped this directory: keep what is on disk and say so, rather
    // than deleting a tree that nothing is going to replace.
    summary.skipped.push(directory)
    continue
  }
  if (!dryRun) summary.swept += await mirrorDirectory(join(sourceRoot, directory), join(root, directory))
  summary.mirrored += 1
}

// Official packages are copied one package at a time so the private overlay
// survives every refresh without requiring a second source checkout.
const sourcePackages = join(sourceRoot, 'packages')
const targetPackages = join(root, 'packages')
for (const entry of await readdir(sourcePackages, { withFileTypes: true })) {
  if (entry.name === 'freecodego') continue
  if (!dryRun) summary.swept += await mirrorDirectory(join(sourcePackages, entry.name), join(targetPackages, entry.name))
  summary.mirrored += 1
}

// Upstream's own files under `scripts/`, added where the destination has none.
if (!dryRun) summary.mirrored += await addMissingScriptFiles(join(sourceRoot, 'scripts'), join(root, 'scripts'))

// The source is a checkout, and a checkout on this host writes a symlink as a
// file holding its target, so `mirrorDirectory`'s dereference had nothing to
// resolve and copied that text. Restore the targets before anything reads them
// as content — `verify-cordis-config` reads one of them as a Loader config.
if (!dryRun) {
  const relinked = await repairMaterializedSymlinks(root, sourceRoot, commit)
  if (relinked.length > 0) {
    console.log(`sync-harness: restored ${String(relinked.length)} symlink target(s) the source materialized: ${relinked.join(', ')}`)
  }
}


if (process.env.HARNESS_SYNC_COPY_ONLY === '1') {
  console.log(`sync-harness: copied ${String(summary.mirrored)} entries from ${sourceRoot} (copy-only; the forks were not applied)`)
  process.exit(0)
}

if (dryRun) {
  const skipped = summary.skipped.length > 0 ? `; source has no ${summary.skipped.join(", ")}` : ""
  console.log(`sync-harness: dry run - would mirror ${summary.mirrored} directories from ${sourceRoot}${skipped}`)
  console.log('sync-harness: nothing written; unset HARNESS_SYNC_DRY_RUN to apply')
  process.exit(0)
}

// FreeCodeGo ships the Harness Agent Teams implementation as public companion
// packages. The upstream tree keeps these packages private while they are
// experimental; the bundle release owns the publication decision and applies
// this small manifest overlay on every sync.
//
// The list pins a set upstream is free to change: 0.1.7-alpha.2 merged the agent-team
// web profile away, which left the list naming a package that no longer exists and
// surfaced as a bare `ENOENT` on the path below -- a message that names the file but
// not the decision behind it. The entry is gone, and a missing one is refused by name
// from now on, because a stale pin should say which name is stale.
const publishedExperimentalPackages = [
  'experimental/agent-team',
  'experimental/agent-team-profile',
  'experimental/client-ui-agent-team',
  'experimental/tool-agent-team',
]
for (const directory of publishedExperimentalPackages) {
  const manifestPath = join(targetPackages, directory, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `the experimental package ${directory} is not in ${commit}; drop it from ` +
        'publishedExperimentalPackages, then re-run (the mirror is idempotent).',
    )
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  delete manifest.private
  manifest.publishConfig = { ...(manifest.publishConfig ?? {}), access: 'public' }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

// The upstream experimental tool/profile packages do not all carry a
// tsdown config. Keep their release artifacts reproducible after every sync.
await writeFile(join(targetPackages, 'experimental/tool-agent-team/tsdown.config.ts'), `import { defineConfig } from 'tsdown'\n\nexport default defineConfig({\n  entry: ['lib/types/index.js'],\n  outDir: 'lib',\n  format: ['esm'],\n  platform: 'node',\n  target: 'es2024',\n  fixedExtension: false,\n  dts: false,\n  clean: false,\n})\n`)
await writeFile(join(targetPackages, 'experimental/agent-team-profile/tsdown.config.ts'), `import { defineConfig } from 'tsdown'\n\nexport default defineConfig({\n  entry: ['lib/types/index.js'],\n  outDir: 'lib',\n  format: ['esm'],\n  platform: 'node',\n  target: 'es2024',\n  fixedExtension: false,\n  dts: false,\n  clean: false,\n})\n`)

await applyForks(root)

console.log(`sync-harness: materialized ${commit} from ${repository}`)

/**
 * Apply every fork, in the order the tree needs them.
 *
 * One list rather than the call sites it used to be, so full sync and patch-only
 * cannot drift apart: a fork that is added here is applied by both.
 */
/**
 * Keep the FreeCodeGo provider display names in the model-selection client.
 *
 * Two provider routes must render in the reader's language rather than under the
 * name the Host reports (`providerInfo`): the built-in `deepseek-account` route
 * and the `antseed` key-gateway this plugin installs. Upstream hard-codes the
 * first in three places and has no name at all for the second, so the fork adds
 * one `providerNameOf` lookup and routes every label through it -- the menu group
 * heading, the two failure rows, and the composer trigger's fallback label (the
 * only name left when the current provider's directory is empty, which is why the
 * map cannot be left to the Host alone).
 *
 * `packages/client/ui-model-selection` is mirrored wholesale on every sync, so
 * this cannot be a hand-edit: `applyForks` re-applies it after the copy, and the
 * marker makes a second run a no-op. Every anchor is asserted, so an upstream
 * rename surfaces as a failed sync instead of a silently dropped fork.
 */
async function patchModelSelectionProviderNames(root) {
  const localesPath = join(root, 'packages/client/ui-model-selection/src/client/locales.ts')
  const indexPath = join(root, 'packages/client/ui-model-selection/src/client/index.ts')
  const modelSelectPath = join(root, 'packages/client/ui-model-selection/src/client/ModelSelect.tsx')

  // locales.ts: the two dictionary entries (the key union derives from `zh`, and
  // `en` is checked complete against it, so both must gain the key together) and
  // the shared lookup appended at the end.
  let locales = await readFile(localesPath, 'utf8')
  if (!locales.includes('PROVIDER_NAME_KEYS')) {
    const zhAccount = "  'provider.account': 'DeepSeek 账号',"
    const enAccount = "  'provider.account': 'DeepSeek Account',"
    for (const anchor of [zhAccount, enAccount]) {
      if (!locales.includes(anchor)) throw new Error('locales.ts no longer matches the provider-name dictionary anchor')
    }
    locales = locales.replace(zhAccount, `${zhAccount}\n  'provider.gateway': '私钥网关',`)
    locales = locales.replace(enAccount, `${enAccount}\n  'provider.gateway': 'Private Key Gateway',`)
    const helper = `/**
 * Provider routes this client renames for display, keyed to a dictionary entry.
 *
 * A provider's display name normally travels from the Host (\`providerInfo\`), and
 * that is where it stays: the name is the adapter's own and needs no second
 * source. These two are the exceptions, and for the same reason — the Host has
 * one name for them while the surface needs it in the reader's language.
 * \`deepseek-account\` is the built-in account route; \`antseed\` is the loopback
 * gateway a plugin installs, whose public name is a product name rather than a
 * service's.
 *
 * The map is consulted in two places that must agree: the group heading and the
 * fallback label. The second one is why this cannot be left to the Host at all —
 * a provider whose directory is empty (a gateway that is switched off, an
 * adapter that failed to load) contributes no group, so the only thing left to
 * label the current selection with is this map. Without it the label renders the
 * raw route key, which is an internal id the reader never chose.
 */
export const PROVIDER_NAME_KEYS: Readonly<Record<string, ModelKey>> = {
  'deepseek-account': 'provider.account',
  'antseed': 'provider.gateway',
}

/**
 * The name one provider is displayed under.
 * @param providerId - the provider route key.
 * @param hostName - the name the Host reported, used when this client has none of its own.
 * @param t - the \`model\` dictionary translator.
 * @returns the display name.
 */
export function providerNameOf(
  providerId: string,
  hostName: string,
  t: (key: ModelKey) => string,
): string {
  const key = PROVIDER_NAME_KEYS[providerId]
  return key === undefined ? hostName : t(key)
}`
    await writeFile(localesPath, `${locales.trimEnd()}\n\n${helper}\n`)
  }

  // index.ts: the /model popup's group labels and its failure rows.
  let index = await readFile(indexPath, 'utf8')
  if (!index.includes('providerNameOf')) {
    const importAnchor = "import { en, zh, type ModelKey } from './locales.ts'"
    const groupAnchor = "    const name = group.id === 'deepseek-account' ? t('provider.account') : group.name"
    const failureAnchor = "      label: failure.id === 'deepseek-account' ? t('provider.account') : failure.name,"
    for (const anchor of [importAnchor, groupAnchor, failureAnchor]) {
      if (!index.includes(anchor)) throw new Error('index.ts no longer matches the provider-name anchor')
    }
    index = index.replace(importAnchor, "import { en, providerNameOf, zh, type ModelKey } from './locales.ts'")
    index = index.replace(groupAnchor, '    const name = providerNameOf(group.id, group.name, t)')
    index = index.replace(failureAnchor, '      label: providerNameOf(failure.id, failure.name, t),')
    await writeFile(indexPath, index)
  }

  // ModelSelect.tsx: the composer trigger's fallback label, the load-failure
  // row, and the group heading the 0.2.0 `MenuGroup` renders.
  let modelSelect = await readFile(modelSelectPath, 'utf8')
  if (!modelSelect.includes('providerNameOf')) {
    const importAnchor = "import type { ModelSelectInjected } from './slots.ts'"
    const fallbackAnchor = "      ?? (state.current === null ? t('trigger.fallback') : \`\${state.current.provider}/\${state.current.model}\`)"
    const warningAnchor = "                  <span>{t('warning.groupLoad', { name: failure.id === 'deepseek-account' ? t('provider.account') : failure.name, message: failure.message })}</span>"
    const groupAnchor = "                    <MenuGroup key={group.id} label={group.id === 'deepseek-account' ? t('provider.account') : group.name}>"
    for (const anchor of [importAnchor, fallbackAnchor, warningAnchor, groupAnchor]) {
      if (!modelSelect.includes(anchor)) throw new Error('ModelSelect.tsx no longer matches the provider-name anchor')
    }
    modelSelect = modelSelect.replace(importAnchor, `${importAnchor}\nimport { providerNameOf } from './locales.ts'`)
    modelSelect = modelSelect.replace(fallbackAnchor, "      ?? (state.current === null\n        ? t('trigger.fallback')\n        : \`\${providerNameOf(state.current.provider, state.current.provider, t)}/\${state.current.model}\`)")
    modelSelect = modelSelect.replace(warningAnchor, "                  <span>{t('warning.groupLoad', { name: providerNameOf(failure.id, failure.name, t), message: failure.message })}</span>")
    modelSelect = modelSelect.replace(groupAnchor, "                    <MenuGroup key={group.id} label={providerNameOf(group.id, group.name, t)}>")
    await writeFile(modelSelectPath, modelSelect)
  }
}

/**
 * Keep this plugin's own web e2e scenarios out of `apps/web`'s client program.
 *
 * The five `freecodego-*.e2e.ts` files are host-plane: they boot the host spine
 * and read its cordis Context merges, which is why `tsconfig.host.json` lists
 * them by name. Upstream's own web e2e files get the same treatment through
 * `apps/web/tsconfig.json`'s `exclude` list — that project is registered in the
 * *client* aggregate, so any file it fails to exclude is typechecked with the
 * client-side Context and every host-only merge reads as a missing property.
 *
 * `apps/` is mirrored from upstream verbatim, so this file cannot be edited in
 * place: the sync would drop the addition on the next run. Appending the five
 * entries after upstream's last one is the same shape as the host aggregate's
 * include block, and the marker makes a rerun a no-op.
 */
async function patchWebFreeCodeGoE2eExclusions(root) {
  const tsconfig = join(root, 'apps/web/tsconfig.json')
  let source = await readFile(tsconfig, 'utf8')
  const files = [
    'freecodego-capabilities.e2e.ts',
    'freecodego-teams.e2e.ts',
    'freecodego-root-engines.e2e.ts',
    'freecodego-voice.e2e.ts',
    'freecodego-design.e2e.ts',
  ]
  const missing = files.filter((file) => !source.includes(`tests/${file}`))
  if (missing.length === 0) return
  // Upstream's exclude list ends with this entry; every earlier revision this
  // workspace can check out (0.1.6-alpha.1 .. 0.2.0-rc.2) carries it too.
  const anchor = '    "tests/workflow-run.e2e.ts"\n  ],'
  if (!source.includes(anchor)) {
    throw new Error('apps/web/tsconfig.json no longer matches the client-program exclude anchor')
  }
  const added = missing.map((file) => `    "tests/${file}",`).join('\n')
  source = source.replace(anchor, `    "tests/workflow-run.e2e.ts",\n${added}\n  ],`)
  await writeFile(tsconfig, source)
}

async function applyForks(root) {
  await patchFreeCodeGoProfileInstaller(join(root, 'packages/boot/plugin-manager/src/operations.ts'))
  await patchHarnessV013Compatibility(root)
  await patchTimeoutSuspensionSeam(root)
  await patchReadBinaryDocumentGuard(root)
  await patchSessionRowIdentitySeam(root)
  await patchModelSelectionProviderNames(root)
  await patchSharedRuntimePeers(root)
  await patchWebFreeCodeGoE2eExclusions(root)
  await patchDesktopPackageSetFreecodegoTarball(join(root, 'apps/desktop/scripts/prepare-package-set.ts'))
  await patchDesktopProfileBundles(join(root, 'apps/desktop/src/project-manager.ts'))
  await patchDesktopHostInstallAnchor(join(root, 'apps/desktop-host/src/index.ts'))
  await patchDesktopElectronVersionPin(root)
  await patchGenConfigCatalogTypeParameters(join(root, 'scripts/gen-config-catalog.ts'))
}

/**
 * Keep a shared host runtime the installation's in the experimental packages
 * upstream ships beside the ones this fork owns.
 *
 * `dsh-mcp-client` carries identity in module-local state (its live `serverName`
 * reservations), so a second copy makes a later browser-tool registration fail on
 * the name the first copy already owns. A `dependencies` entry *is* that second
 * copy: pnpm resolves the package's own tree. Three upstream experimental packages
 * declare it that way while importing it from `src/`, which the checkout's
 * `host-runtime-identity.spec.ts` reads as a violation. This overlay restates the
 * entry the way a shared runtime is meant to be taken -- a `peerDependencies`
 * entry the installation satisfies, plus the `devDependencies` copy the package
 * builds and tests against on its own, which is the shape
 * `experimental/browser-use-runtime` already carries.
 *
 * `packages/*` is mirrored wholesale on every sync, so this cannot be a hand-edit:
 * `applyForks` re-applies it after the copy, and a package already carrying the
 * shape returns early. Each manifest is read back and asserted, so an upstream
 * rename surfaces as a failed sync rather than a silently dropped fork.
 */
async function patchSharedRuntimePeers(root) {
  const runtime = '@deepseek-ai/dsh-mcp-client'
  const directories = [
    'packages/experimental/browser-use-stagehand-native',
    'packages/experimental/computer-use-cua-driver-mcp',
    'packages/experimental/computer-use-cua-driver-native',
  ]
  for (const directory of directories) {
    const manifestPath = join(root, directory, 'package.json')
    // A package upstream has since removed has nothing left to restate; skipping
    // keeps a sync from failing over a name that is no longer a consumer.
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const dependency = manifest.dependencies?.[runtime]
    const peer = manifest.peerDependencies?.[runtime]
    const dev = manifest.devDependencies?.[runtime]
    // Already restated: nothing to write, and the manifest stays byte-for-byte.
    if (dependency === undefined && peer !== undefined && dev !== undefined) continue
    if (manifest.dependencies !== undefined) delete manifest.dependencies[runtime]
    manifest.peerDependencies = { ...(manifest.peerDependencies ?? {}), [runtime]: peer ?? 'workspace:*' }
    manifest.devDependencies = { ...(manifest.devDependencies ?? {}), [runtime]: dev ?? 'workspace:*' }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const written = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (
      written.dependencies?.[runtime] !== undefined ||
      written.peerDependencies?.[runtime] === undefined ||
      written.devDependencies?.[runtime] === undefined
    ) {
      throw new Error(`${directory} still declares ${runtime} outside peer + dev; the shared-runtime fork did not take`)
    }
  }
}

/**
 * Upstream's type-name collector, verbatim, as the substitution's left side.
 *
 * Kept as lines rather than one template literal so the anchor reads like the
 * source it matches, and so the backtick in the heritage-clause comment needs no
 * escaping.
 *
 * A hoisted declaration rather than a `const`, for the reason `runPluginCommandBefore`
 * records below: `applyForks` is called from the patch-only branch near the top of this
 * file as well as from the sync at the bottom, so a `const` here is still in its temporal
 * dead zone at the first of those calls. That first call is also the one that applies the
 * patch at all, because a tree this fork has already edited returns early on the marker
 * and never reads these lines -- which is why the crash only ever appeared on a clean
 * checkout, and only there as
 * `Cannot access 'GEN_CONFIG_CATALOG_COLLECTOR_ANCHOR' before initialization`.
 */
function genConfigCatalogCollectorAnchor() {
  return [
  '/** Collect every type NAME referenced in type positions under a node. */',
  'function collectTypeNames(node: ts.Node, out: Set<string>): void {',
  '  const visit = (n: ts.Node): void => {',
  '    if (ts.isTypeReferenceNode(n)) {',
  '      let head: ts.EntityName = n.typeName',
  '      while (ts.isQualifiedName(head)) head = head.left',
  '      out.add(head.text)',
  '    } else if (ts.isExpressionWithTypeArguments(n) && ts.isIdentifier(n.expression)) {',
  '      out.add(n.expression.text) // heritage clause: `extends X`',
  '    }',
  '    ts.forEachChild(n, visit)',
  '  }',
  '  visit(node)',
  '}',
  ].join('\n')
}

/**
 * The collector with type parameters treated as bindings, plus the helper that
 * reads them. Identical to the copy in the tree; `\n`-joined lines for the same
 * reason as the anchor, hoisted out of the dead zone for the same reason too.
 */
function genConfigCatalogCollectorFixed() {
  return [
  '/**',
  ' * Collect every type NAME referenced in type positions under a node.',
  ' *',
  ' * A name bound by an enclosing type-parameter list is not a reference. The walker',
  ' * resolves every collected name against three namespaces — package-local',
  ' * declarations, imports, and known globals — so a bound parameter has nothing to',
  ' * resolve to and is reported as a violation of a declaration that is well typed:',
  ' * `Live<T>` referring to its own `T`, or a mapped type referring to its own `K`.',
  ' * In this tree that report was reachable only by deleting a generic config type',
  ' * the plugin needs, which is the wrong way round. Bound names are therefore not',
  ' * collected, exactly as a local variable is not an unresolved identifier.',
  ' *',
  ' * Fork-local patch: re-applied after every upstream sync by',
  ' * `scripts/sync-harness.mjs` (`patchGenConfigCatalogTypeParameters`).',
  ' */',
  'function collectTypeNames(node: ts.Node, out: Set<string>): void {',
  '  const visit = (n: ts.Node, bound: ReadonlySet<string>): void => {',
  '    const declared = boundTypeParameterNames(n)',
  '    const scope = declared.length === 0 ? bound : new Set([...bound, ...declared])',
  '    if (ts.isTypeReferenceNode(n)) {',
  '      let head: ts.EntityName = n.typeName',
  '      while (ts.isQualifiedName(head)) head = head.left',
  '      if (!scope.has(head.text)) out.add(head.text)',
  '    } else if (ts.isExpressionWithTypeArguments(n) && ts.isIdentifier(n.expression)) {',
  '      // heritage clause: `extends X`',
  '      if (!scope.has(n.expression.text)) out.add(n.expression.text)',
  '    }',
  '    ts.forEachChild(n, child => { visit(child, scope) })',
  '  }',
  '  visit(node, new Set())',
  '}',
  '',
  '/**',
  ' * The type-variable names a node introduces for its own subtree.',
  ' *',
  " * Three shapes bind one: a declaration's type parameters (`Live<T>`), a mapped",
  " * type's parameter (`{ [K in keyof T]: … }`), and an `infer` binding. Read",
  ' * structurally rather than per node kind, so a shape this list has not met yet',
  ' * still contributes its parameters instead of being skipped silently.',
  ' */',
  'function boundTypeParameterNames(node: ts.Node): string[] {',
  '  const names: string[] = []',
  '  const declaring = node as ts.Node & { readonly typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }',
  '  if (declaring.typeParameters !== undefined) {',
  '    for (const parameter of declaring.typeParameters) names.push(parameter.name.text)',
  '  }',
  '  if (ts.isMappedTypeNode(node) || ts.isInferTypeNode(node)) names.push(node.typeParameter.name.text)',
  '  return names',
  '}',
  ].join('\n')
}

/**
 * Config catalog: a type parameter is a binding, not a reference to resolve.
 *
 * `verify-config-catalog` resolves every type name reachable from a config
 * declaration against three namespaces — package-local declarations, imports, and
 * known globals — and its collector takes every `TypeReferenceNode` name without
 * asking whether an enclosing type parameter list already bound it. A config type
 * written with a generic wrapper (`Live<T>` wrapping a settings document, so every
 * field is a live reference) therefore reports `T` and `K` as violations, and the
 * only edit that satisfies the report is to delete the generic.
 *
 * Upstream's own configs state `field: Volatile<X>` per field, so it never met
 * this. This fork does, and the fix belongs in the tool rather than in a copy of
 * the document: a hand-written per-field twin is a second answer to what the
 * settings are, and the catalog requires JSDoc on every pasted property, so the
 * twin would have to restate the settings documentation as well.
 *
 * `scripts/` is the one directory the sync shares file by file and never
 * overwrites, so this patch normally finds the fix already in place and returns;
 * it matters on a fresh clone, where `scripts/*` is absent from git and upstream's
 * copy arrives unpatched. The anchor is upstream's text, and a miss throws rather
 * than leaving a tree that looks synced and fails the gate.
 */
async function patchGenConfigCatalogTypeParameters(path) {
  const source = await readFile(path, 'utf8')
  if (source.includes('boundTypeParameterNames')) return
  const anchor = genConfigCatalogCollectorAnchor()
  if (!source.includes(anchor)) {
    throw new Error('gen-config-catalog no longer matches the type-name collection seam')
  }
  await writeFile(path, source.replace(anchor, genConfigCatalogCollectorFixed()))
}

/**
 * Desktop Host: the installation the runtime resolution reads is the runtime project root.
 *
 * `runProfile` turns `installAnchor` into the installation-scope table by walking the anchor
 * manifest's dependency edges, so a package the manifest does not declare is invisible to the
 * Loader no matter where it sits on disk. The Host anchored on the `dsh` package nested inside
 * the runtime, which mirrors the CLI's own anchor and therefore covers exactly the CLI's
 * dependency closure -- while the Desktop packaging adds the built-in FreeCodeGo bundle to the
 * runtime *project* (the `FREECODEGO_DESKTOP_TARBALL` record becomes one of its dependencies).
 * The bundle then resolves far enough to contribute its patch layer and its rows reach the
 * profile, but every row fails at import: `freecodego` is missing from the resolution table and
 * the profile has no copy of its own to fall back on.
 *
 * Anchoring on the runtime project makes the table a strict superset of the old one -- measured
 * against a win-x64 runtime: 496 entries, all with an unchanged packageDir, plus the runtime
 * project itself, `@deepseek-ai/dsh-desktop-host`, and the injected bundle. Bundle lookup for
 * the profile moves to the same anchor, which only widens the search to a directory the old one
 * already reached through its parents.
 */
async function patchDesktopHostInstallAnchor(path) {
  let source = await readFile(path, 'utf8')
  if (source.includes("const installAnchor = join(runtimeDir, 'package.json')")) return
  const anchor = "  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')\n"
  if (!source.includes(anchor)) {
    throw new Error('desktop host source no longer matches the install anchor seam')
  }
  source = source.replace(anchor, [
    "  // The installation is the runtime project the packaging pipeline packed, not the `dsh` package",
    '  // nested inside it: the project manifest declares the shipped core set and every bundle the',
    '  // pipeline adds to it. The nested package keeps a package that only the runtime project',
    "  // declares out of the resolution table, so that bundle's loader rows could never import.",
    "  const installAnchor = join(runtimeDir, 'package.json')",
    '',
  ].join('\n'))
  await writeFile(path, source)
}

/**
 * Desktop shell: the caller may pin the Electron release the packaging pipeline downloads.
 *
 * `apps/desktop` declares `electron: ^44.0.0`, so a plain install resolves the newest matching
 * patch. The shipped `node-addon-require-builtin` prebuild recognizes Electron runtimes by an
 * exact V8 fingerprint table (43.0.0 | 44.0.0 | 45.0.0-alpha.6) and refuses every other shell,
 * including later 44.x patches whose V8 build number differs -- the Desktop payload smoke fails
 * on `require('internal/modules/esm/loader')` and, more importantly, the same lookup is what the
 * packaged application needs at run time. Setting FREECODEGO_DESKTOP_ELECTRON_VERSION builds
 * against a shell the loader supports; the runtime download, the runtime descriptor, and the
 * electron-builder metadata all follow that one value. Without the variable both files stay
 * byte-for-byte upstream.
 */
async function patchDesktopElectronVersionPin(root) {
  const runtime = join(root, 'apps/desktop/scripts/prepare-runtime.ts')
  let source = await readFile(runtime, 'utf8')
  if (!source.includes('FREECODEGO_DESKTOP_ELECTRON_VERSION')) {
    const anchor = "  const { version } = require('electron/package.json') as { version: string }\n"
    if (!source.includes(anchor)) {
      throw new Error('desktop prepare-runtime source no longer matches the Electron version seam')
    }
    source = source.replace(anchor, [
      "  const { version: installedElectronVersion } = require('electron/package.json') as { version: string }",
      '  // The pinned shell wins over the resolved range so every downstream stage -- the',
      '  // download, the runtime descriptor, and electron-builder -- agrees on one release.',
      "  const version = process.env.FREECODEGO_DESKTOP_ELECTRON_VERSION?.trim() || installedElectronVersion",
      '',
    ].join('\n'))
    await writeFile(runtime, source)
  }

  const builder = join(root, 'apps/desktop/scripts/electron-builder-config.mjs')
  source = await readFile(builder, 'utf8')
  if (!source.includes('FREECODEGO_DESKTOP_ELECTRON_VERSION')) {
    const anchor = '    electronDist: buildPaths.electron,\n'
    if (!source.includes(anchor)) {
      throw new Error('desktop electron-builder config no longer matches the electronDist seam')
    }
    source = source.replace(anchor, [
      '    electronDist: buildPaths.electron,',
      '    // Reported version metadata follows a pinned shell; electron-builder copies `electronDist`',
      '    // as-is either way, so this only keeps the packaged metadata honest.',
      "    ...(process.env.FREECODEGO_DESKTOP_ELECTRON_VERSION?.trim()",
      "      ? { electronVersion: process.env.FREECODEGO_DESKTOP_ELECTRON_VERSION.trim() } : {}),",
      '',
    ].join('\n'))
    await writeFile(builder, source)
  }
}

/**
 * Desktop packaging: the caller may add the freshly built FreeCodeGo bundle tarball to the
 * local package set through FREECODEGO_DESKTOP_TARBALL.
 *
 * The Desktop runtime's production closure is selected from packed tarballs rooted at dsh and
 * its private Host; the closure walk can never reach an out-of-family package, so the bundle
 * joins after selection, in name order like every other record. Setting the variable is the
 * whole behavioural change: without it this file is byte-for-byte upstream, and the desktop
 * packaging tests (which never set it) exercise the upstream path unchanged.
 */
async function patchDesktopPackageSetFreecodegoTarball(path) {
  let source = await readFile(path, 'utf8')
  if (source.includes('FREECODEGO_DESKTOP_TARBALL')) return
  const anchor = [
    '/** Prepare a package set from release tarball directories. */',
    'export function prepareDesktopPackageSet(inputs: readonly string[], output: string): void {',
    '  const selected = selectDesktopPackageClosure(packedPackages(inputs))',
  ].join('\n')
  const replacement = [
    '/** Prepare a package set from release tarball directories. */',
    'export function prepareDesktopPackageSet(inputs: readonly string[], output: string): void {',
    '  const selected = [...selectDesktopPackageClosure(packedPackages(inputs))]',
    '  // Out-of-closure additions arrive as an absolute tarball path; the closure walk above',
    '  // cannot reach them because it starts from the dsh-family roots.',
    '  const freecodegoTarball = process.env.FREECODEGO_DESKTOP_TARBALL?.trim()',
    "  if (freecodegoTarball !== undefined && freecodegoTarball !== '') {",
    '    const tarball = resolve(REPOSITORY_ROOT, freecodegoTarball)',
    '    const manifest = packedManifest(tarball)',
    "    if (manifest.name !== 'freecodego') {",
    "      throw new Error(`desktop package set: FREECODEGO_DESKTOP_TARBALL names ${String(manifest.name)}, expected freecodego`)",
    '    }',
    "    if (selected.some(packed => packed.manifest.name === 'freecodego')) {",
    "      throw new Error('desktop package set: duplicate packed package freecodego')",
    '    }',
    '    selected.push({ tarball, manifest })',
    '    selected.sort((left, right) => String(left.manifest.name).localeCompare(String(right.manifest.name)))',
    '  }',
  ].join('\n')
  if (!source.includes(anchor)) {
    throw new Error('desktop package-set source no longer matches the FreeCodeGo tarball injection anchor')
  }
  source = source.replace(anchor, replacement)
  await writeFile(path, source)
}

/**
 * Desktop profiles: the built-in FreeCodeGo bundle ships inside the signed runtime and every
 * Desktop profile activates it -- on first creation and on every release application after.
 *
 * `createPluginProfile` covers fresh profiles; `applyRelease` covers profiles that predate this
 * fork, because initProfile never rewrites an existing manifest. Native recovery keeps the
 * bundle on purpose: it is app-owned, the same trust domain as dsh-base, and a bundle the next
 * start would re-add anyway must not be silently dropped by the recovery action. The bundle's
 * bytes are never copied into the profile -- resolution prefers the installation anchor -- so
 * replacing the application replaces the bundle, which is how updates stay automatic.
 */
async function patchDesktopProfileBundles(path) {
  let source = await readFile(path, 'utf8')
  if (source.includes('ensureFreecodegoBundle')) {
    // Already patched: still bring the bundle set forward, for the same reason the
    // profile installer's own idempotent branch does.
    let updated = source
      .replace(
        /const DESKTOP_PROFILE_BUNDLES: readonly string\[\] = \[[^\]]*\]/u,
        DESKTOP_PROFILE_BUNDLES_DECLARATION,
      )
      // 0.2.1 retired the optional schedule bundle and the Web composition mounts the
      // row again, so a tree the previous revision materialized is brought forward by
      // dropping the declaration this fork injected for it.
      .replace(/\n\/\*\* The scheduled-task bundle[^\n]*\nconst SCHEDULE_BUNDLE = '[^']*'/u, '')
      .replace(/\nconst SCHEDULE_BUNDLE = '[^']*'/u, '')
    if (updated !== source) await writeFile(path, updated)
    return
  }
  source = source.replace(
    [
      'import {',
      '  initProfile, PROFILE_TEMPLATES, removeLinkProjections, sanitizeProfile, type ProfileTemplate,',
      "} from '@deepseek-ai/dsh-app-boot'",
    ].join('\n'),
    [
      'import {',
      '  initProfile, PROFILE_TEMPLATES, readProfileManifest, removeLinkProjections, sanitizeProfile,',
      '  writeProfileBundles, type ProfileTemplate,',
      "} from '@deepseek-ai/dsh-app-boot'",
    ].join('\n'),
  )
  source = source.replace(
    'const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate',
    [
      'const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate',
      '/** The FreeCodeGo bundle shipped inside the Desktop runtime: app-owned, activated with the template. */',
      "const FREECODEGO_BUNDLE = 'freecodego'",
      '/** Bundles a Desktop profile activates: the web template plus the FreeCodeGo bundle. */',
      DESKTOP_PROFILE_BUNDLES_DECLARATION,
    ].join('\n'),
  )
  source = source.replace(
    '      createPluginProfile(this.paths.profile)\n',
    '      createPluginProfile(this.paths.profile)\n      ensureFreecodegoBundle(this.paths.profile)\n',
  )
  source = source.replace(
    "return this.withLock(() => sanitizeProfile('dsh', this.paths.profile, WEB_PROFILE.bundles))",
    "return this.withLock(() => sanitizeProfile('dsh', this.paths.profile, DESKTOP_PROFILE_BUNDLES))",
  )
  source = source.replace(
    'export function createPluginProfile(projectDir: string): void {\n  initProfile(projectDir, WEB_PROFILE.bundles)\n}',
    'export function createPluginProfile(projectDir: string): void {\n  initProfile(projectDir, DESKTOP_PROFILE_BUNDLES)\n}',
  )
  source += `\n/** Activate the built-in FreeCodeGo bundle on an existing profile without touching the user's own bundles. */\nfunction ensureFreecodegoBundle(profileDir: string): void {\n  if (!existsSync(join(profileDir, 'package.json'))) return\n  const manifest = readProfileManifest('dsh', profileDir)\n  const bundles = manifest.dsh?.profile?.bundles ?? []\n  if (bundles.includes(FREECODEGO_BUNDLE)) return\n  writeProfileBundles(profileDir, manifest, [...bundles, FREECODEGO_BUNDLE])\n}\n`
  if (
    !source.includes('const FREECODEGO_BUNDLE')
    || !source.includes('ensureFreecodegoBundle(this.paths.profile)')
    || !source.includes("sanitizeProfile('dsh', this.paths.profile, DESKTOP_PROFILE_BUNDLES)")
    || !source.includes('initProfile(projectDir, DESKTOP_PROFILE_BUNDLES)')
  ) {
    throw new Error('desktop project-manager source no longer matches the FreeCodeGo profile bundle patch')
  }
  await writeFile(path, source)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${String(result.status)}`)
}

/**
 * Install the FreeCodeGo profile behaviour into the official plugin manager.
 *
 * alpha.2 split `dsh plugin` out of `apps/cli/src/plugin.ts` -- 163 lines holding
 * the whole profile installer -- into a 25-line forwarder over
 * `packages/boot/plugin-manager/src/operations.ts` (`runPluginCommand`), and moved
 * the initialization half into `packages/boot/app-boot`. Five of the eight anchors
 * this patch used to match went with that file. The three that survive are renamed:
 * the profile is `context.profile`, stderr is `options.onOutput`, and the
 * installation anchor is `context.installAnchor` -- the last still threaded through
 * exactly as `INSTALL_ANCHOR` was, so `freecodegoInstallSpec` keeps working.
 *
 * `operations.ts` rather than the CLI forwarder, because the profile is created by
 * whoever calls `runPluginCommand`: `dsh plugin` from the CLI and the running
 * manager from the Client both land here, and only one of them is a CLI.
 *
 * Two upstream changes now do work this fork used to do itself: `reconcile()`
 * already appends a newly installed dependency that declares `dsh.bundle` to
 * `dsh.profile.bundles`, and `anchorPathSpec` moved here intact.
 *
 * An early refusal returns a `PackageResult` with an empty `logPath`: nothing ran,
 * so there is no log to point at, and the reason has already reached `onOutput`.
 */
async function patchFreeCodeGoProfileInstaller(path) {
  let source = await readFile(path, 'utf8')
  const profileMarker = "const FREECODEGO_PROFILES = new Set(['freecodego', 'freecodego-latest', 'freecodego-alpha'])"
  // Keep already-materialized generated sources idempotent while still fixing
  // constants introduced by an older overlay revision.
  if (source.includes(profileMarker)) {
    const updated = source
      .replace(
        /const FREECODEGO_BUNDLE = ['"][^'"]+['"]/u,
        "const FREECODEGO_BUNDLE = 'freecodego'",
      )
      // The bundle set is a constant this fork owns, so an already-materialized
      // tree is brought forward too: 0.2.0 moved the scheduler into a shipped
      // optional bundle the FreeCodeGo profile has to name to mount it.
      .replace(
        /const FREECODEGO_PROFILE_BUNDLES: readonly string\[\] = \[[^\]]*\]/u,
        FREECODEGO_PROFILE_BUNDLES_DECLARATION,
      )
    if (updated !== source) await writeFile(path, updated)
    return
  }
  // The import line's *contents* are upstream's to change -- 0.1.7-rc.2 added
  // `readFileSync` to it -- and an exact-string anchor goes silent when they do, which
  // is precisely how this patch shipped a tree that used `writeFileSync` without
  // importing it: the profile migration below compiled as one `TS2552` under
  // `tsconfig.host.json` while the sync still reported success. Match the line's shape
  // and add only the names the injected body needs; the postcondition below asserts the
  // result, so a future reshaping fails the sync instead of the typecheck.
  source = source.replace(
    /^import \{([^}]*)\} from 'node:fs'$/mu,
    (_match, names) => {
      const present = new Set(String(names).split(',').map((name) => name.trim()).filter((name) => name !== ''))
      for (const name of ['readFileSync', 'writeFileSync']) present.add(name)
      return `import { ${[...present].sort().join(', ')} } from 'node:fs'`
    },
  )
  if (!/^import \{[^}]*\bwriteFileSync\b[^}]*\} from 'node:fs'$/mu.test(source)) {
    throw new Error('official plugin manager source no longer imports the node:fs names this patch injects')
  }
  source = source.replace("import { join, resolve } from 'node:path'", "import { dirname, join, resolve } from 'node:path'")
  source = source.replace("import { execa } from 'execa'", "import { spawnSync } from 'node:child_process'\nimport { execa } from 'execa'")
  // The constants ride in on this module's type-only import from `./types.ts`, the one
  // line every revision of the file has at its top. Anchoring on the exact specifier
  // list broke the moment upstream added `Registry` to it: the replacement became a
  // silent no-op, and the injected usages below then compiled as 21 `TS2304` errors
  // under `tsconfig.host.json` while the sync still reported success. Match the line's
  // *shape* instead of its contents, and assert the marker in the postcondition below,
  // because a patch that stops patching without saying so is the defect this file
  // exists to avoid.
  source = source.replace(
    /^import type \{[^}]*\} from '\.\/types\.ts'$/mu,
    match => [match, '', ...freeCodeGoConstants()].join('\n'),
  )
  source = source.replace(runPluginCommandBefore().join('\n'), runPluginCommandAfter().join('\n'))
  source += `\n${freeCodeGoHelpers().join('\n')}\n`
  if (
    !source.includes(profileMarker)
    || !source.includes('const firstUse = !existsSync')
    || !source.includes('if (firstUse && FREECODEGO_PROFILES.has(context.profile))')
    || !source.includes('function migrateLegacyFreeCodeGoProfile')
  ) {
    throw new Error('official plugin manager source no longer matches the FreeCodeGo profile installer patch')
  }
  await writeFile(path, source)
}

/** Constants the injected profile behaviour reads; placed above the operations. */
function freeCodeGoConstants() {
  return [
    '/** FreeCodeGo profile names this fork owns: they install a bundle instead of a template. */',
    "const FREECODEGO_PROFILES = new Set(['freecodego', 'freecodego-latest', 'freecodego-alpha'])",
    '/** Registry package those profiles install. */',
    "const FREECODEGO_BUNDLE = 'freecodego'",
    '/** The bundle name this fork shipped before the registry package existed. */',
    "const LEGACY_FREECODEGO_BUNDLE = '@freecodego/dsh-harness-alpha-bundle'",
    '/** In-box bundles a FreeCodeGo profile starts from; the bundle itself joins on first use. */',
    FREECODEGO_PROFILE_BUNDLES_DECLARATION,
  ]
}

/**
 * The `runPluginCommand` body this patch replaces, verbatim from alpha.2.
 *
 * A hoisted declaration rather than a `const`, because the patch runs from the
 * top-level call above: a `const` here is in its temporal dead zone at that point
 * and the whole sync dies on it after the copies have already been made.
 */
function runPluginCommandBefore() {
  return [
  "    if (!existsSync(join(dir, 'package.json'))) {",
  '      const template = PROFILE_TEMPLATES[context.profile]',
  '      initProfile(dir, template?.bundles ?? DEFAULT_PROFILE_BUNDLES)',
  "      options.onOutput?.(`dsh: initialized profile ${context.profile} at ${dir}\\n`, 'stderr')",
  '    }',
  '    return runProfilePnpm(context, args, options)',
  ]
}

/**
 * What replaces it: initialize a FreeCodeGo profile from this fork's bundles, install
 * the bundle itself on first use, migrate the legacy name on later runs, and resolve
 * a bare `freecodego` argument to the spec that matches this Harness.
 */
function runPluginCommandAfter() {
  return [
  "    const firstUse = !existsSync(join(dir, 'package.json'))",
  '    const write = (text: string): void => { options.onOutput?.(text, \'stderr\') }',
  '    if (firstUse) {',
  '      const template = PROFILE_TEMPLATES[context.profile]',
  '      initProfile(',
  '        dir,',
  '        FREECODEGO_PROFILES.has(context.profile)',
  '          ? FREECODEGO_PROFILE_BUNDLES',
  '          : template?.bundles ?? DEFAULT_PROFILE_BUNDLES,',
  '      )',
  '      write(`dsh: initialized profile ${context.profile} at ${dir}\\n`)',
  '    }',
  '    if (firstUse && FREECODEGO_PROFILES.has(context.profile)) {',
  '      const selected = freecodegoInstallSpec(dir, context.installAnchor)',
  '      if (selected.error !== undefined) {',
  '        write(`dsh: ${selected.error}\\n`)',
  '        return freecodegoRefusal(selected.error)',
  '      }',
  '      if (selected.spec !== undefined) {',
  '        write(`dsh: installing FreeCodeGo Bundle ${selected.spec}\\n`)',
  "        const install = await runProfilePnpm(context, ['add', '--save-exact', selected.spec], options)",
  '        if (install.exitCode !== 0) {',
  '          write(`dsh: FreeCodeGo Bundle installation failed; rerun: dsh plugin --profile ${context.profile} add ${selected.spec}\\n`)',
  '          return install',
  '        }',
  '      }',
  '    }',
  '    if (!firstUse && FREECODEGO_PROFILES.has(context.profile)) {',
  '      migrateLegacyFreeCodeGoProfile(dir, context.installAnchor, write)',
  '    }',
  '    const freecodegoArgs = resolveFreeCodeGoArgs(args, dir, context.installAnchor)',
  '    if (freecodegoArgs.error !== undefined) {',
  '      write(`dsh: ${freecodegoArgs.error}\\n`)',
  '      return freecodegoRefusal(freecodegoArgs.error)',
  '    }',
  '    return runProfilePnpm(context, freecodegoArgs.args, options)',
  ]
}

/**
 * The helpers this fork appends below the official operations.
 *
 * Ported from the alpha.1 installer with three mechanical changes: the installation
 * anchor arrives as a parameter instead of the module constant `INSTALL_ANCHOR`, the
 * diagnostics sink is the caller's writer instead of `process.stderr` (service-mode
 * output is captured, so a raw write would escape the log), and `resolveBundleDir`
 * takes `'dsh'` the way every other call in this file already does.
 */
function freeCodeGoHelpers() {
  return [
    '/** A refused FreeCodeGo resolution: nothing ran, so there is no log to point at. */',
    'function freecodegoRefusal(message: string): PackageResult {',
    '  return { exitCode: 1, output: `${message}\\n`, truncated: false, logPath: \'\' }',
    '}',
    '',
    '/** Select the local development bundle or the exact Registry version matching this Harness. */',
    'function freecodegoInstallSpec(profileDir: string, installAnchor: string): { readonly spec?: string; readonly error?: string } {',
    "  const root = resolve(dirname(installAnchor), '../..')",
    "  const local = resolve(root, 'packages/freecodego/bundle-latest')",
    '  const baseline = harnessBaseline(profileDir, installAnchor)',
    "  if (existsSync(join(local, 'package.json'))) {",
    '    try {',
    "      const manifest = JSON.parse(readFileSync(join(local, 'package.json'), 'utf8')) as { readonly freecodego?: { readonly harnessBaseline?: unknown } }",
    "      if (baseline === undefined || manifest.freecodego?.harnessBaseline === baseline) return { spec: local }",
    '    } catch { /* fall through to registry selection */ }',
    '  }',
    '  if (baseline === undefined) return { spec: FREECODEGO_BUNDLE }',
    '  const version = registryBundleVersion(baseline)',
    '  return version === undefined',
    '    ? { error: `no ${FREECODEGO_BUNDLE} release declares compatibility with Harness ${baseline}; update Harness or install a matching bundle explicitly` }',
    '    : { spec: `${FREECODEGO_BUNDLE}@${version}` }',
    '}',
    '',
    'function isFreeCodeGoPackageSpec(value: string): boolean {',
    '  return value === FREECODEGO_BUNDLE || value.startsWith(`${FREECODEGO_BUNDLE}@`)',
    '}',
    '',
    'function resolveFreeCodeGoArgs(args: readonly string[], profileDir: string, installAnchor: string): { readonly args: readonly string[]; readonly error?: string } {',
    '  const normalized = [...args]',
    '  const targets = normalized.map((argument, index) => ({ argument, index })).filter(item => isFreeCodeGoPackageSpec(item.argument))',
    "  const needsResolution = targets.some(({ argument }) => argument === FREECODEGO_BUNDLE || argument.endsWith('@latest') || argument.endsWith('@next') || argument.endsWith('@canary'))",
    '  if (!needsResolution) return { args: normalized }',
    '  const selected = freecodegoInstallSpec(profileDir, installAnchor)',
    '  if (selected.error !== undefined) return { args: normalized, error: selected.error }',
    '  if (selected.spec === undefined) return { args: normalized }',
    '  for (const { index } of targets) normalized[index] = selected.spec',
    '  return { args: normalized }',
    '}',
    '',
    'const FREECODEGO_SEMVER_RE = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?$/u',
    '',
    'function compareFreeCodeGoSemver(left: string, right: string): number {',
    '  const a = FREECODEGO_SEMVER_RE.exec(left)',
    '  const b = FREECODEGO_SEMVER_RE.exec(right)',
    '  if (a === null || b === null) return 0',
    '  for (let index = 1; index <= 3; index += 1) {',
    '    const difference = Number(a[index]) - Number(b[index])',
    '    if (difference !== 0) return difference',
    '  }',
    "  const ap = a[4]?.split('.') ?? []",
    "  const bp = b[4]?.split('.') ?? []",
    '  if (ap.length === 0 || bp.length === 0) return ap.length === bp.length ? 0 : ap.length === 0 ? 1 : -1',
    '  for (let index = 0; index < Math.max(ap.length, bp.length); index += 1) {',
    '    if (ap[index] === undefined) return -1',
    '    if (bp[index] === undefined) return 1',
    '    if (ap[index] === bp[index]) continue',
    '    return ap[index]! < bp[index]! ? -1 : 1',
    '  }',
    '  return 0',
    '}',
    '',
    'function jsonOutput(value: string): unknown {',
    '  try { return JSON.parse(value) as unknown } catch { return undefined }',
    '}',
    '',
    'function harnessBaseline(profileDir: string, installAnchor: string): string | undefined {',
    "  for (const packageName of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base']) {",
    '    try {',
    "      const directory = resolveBundleDir('dsh', packageName, installAnchor, profileDir)",
    "      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { readonly version?: unknown }",
    "      if (typeof manifest.version === 'string' && FREECODEGO_SEMVER_RE.test(manifest.version)) return manifest.version",
    '    } catch { /* try the next installation anchor */ }',
    '  }',
    '  return undefined',
    '}',
    '',
    'function registryBundleVersion(baseline: string): string | undefined {',
    "  const versionsResult = spawnSync('pnpm', ['view', FREECODEGO_BUNDLE, 'versions', '--json'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })",
    '  if (versionsResult.error !== undefined || versionsResult.status !== 0) return undefined',
    '  const values = jsonOutput(String(versionsResult.stdout))',
    '  if (!Array.isArray(values)) return undefined',
    "  const versions = values.filter((value): value is string => typeof value === 'string' && FREECODEGO_SEMVER_RE.test(value)).sort((a, b) => compareFreeCodeGoSemver(b, a))",
    '  for (const version of versions) {',
    "    const metadata = spawnSync('pnpm', ['view', `${FREECODEGO_BUNDLE}@${version}`, 'freecodego.harnessBaseline', '--json'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })",
    '    if (metadata.error !== undefined || metadata.status !== 0 || jsonOutput(String(metadata.stdout)) !== baseline) continue',
    '    let usable = true',
    "    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {",
    "      const result = spawnSync('pnpm', ['view', `${FREECODEGO_BUNDLE}@${version}`, field, '--json'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })",
    '      const section = jsonOutput(String(result.stdout))',
    "      if (result.error !== undefined || result.status !== 0 || section !== null && typeof section === 'object' && !Array.isArray(section) && Object.values(section as Record<string, unknown>).some(value => typeof value === 'string' && value.startsWith('workspace:'))) { usable = false; break }",
    '    }',
    '    if (usable) return version',
    '  }',
    '  return undefined',
    '}',
    '',
    'function migrateLegacyFreeCodeGoProfile(dir: string, installAnchor: string, write: (text: string) => void): void {',
    "  const path = join(dir, 'package.json')",
    '  try {',
    "    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }",
    '    if (manifest.dependencies?.[LEGACY_FREECODEGO_BUNDLE] === undefined) return',
    '    const dependencies = { ...(manifest.dependencies ?? {}) }',
    '    delete dependencies[LEGACY_FREECODEGO_BUNDLE]',
    '    const selected = freecodegoInstallSpec(dir, installAnchor)',
    "    if (selected.spec === undefined) throw new Error(selected.error ?? 'no compatible FreeCodeGo Bundle')",
    '    dependencies[FREECODEGO_BUNDLE] = selected.spec',
    "    const bundles = (manifest.dsh?.profile?.bundles ?? []).filter(name => name !== LEGACY_FREECODEGO_BUNDLE)",
    '    if (!bundles.includes(FREECODEGO_BUNDLE)) bundles.push(FREECODEGO_BUNDLE)',
    '    writeFileSync(path, `${JSON.stringify({ ...manifest, dependencies, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } } }, null, 2)}\\n`)',
    '    write(`dsh: migrated ${LEGACY_FREECODEGO_BUNDLE} to ${FREECODEGO_BUNDLE}\\n`)',
    '  } catch (error) {',
    '    write(`dsh: could not migrate the legacy FreeCodeGo Bundle: ${error instanceof Error ? error.message : String(error)}\\n`)',
    '  }',
    '}',
  ]
}

/**
 * Stop the official `read` tool from returning a binary PDF as text.
 *
 * `readText` decodes bytes as UTF-8, so a PDF comes back as a page of
 * replacement characters mixed with the few ASCII runs that survive (`obj`,
 * `endobj`, flattened numbers). That output *looks* like content, costs
 * context, and carries no information — the model cannot tell it apart from a
 * corrupt file. Naming the format and pointing at a reader that extracts it is
 * the honest answer.
 *
 * Detection is by magic prefix rather than extension, so a PDF renamed to
 * `report.bin` is still refused while a text file that merely ends in `.pdf`
 * stays readable. Referring to `read_document` couples this official package to
 * the FreeCodeGo plugin deliberately: the file is only ever materialized by
 * this overlay, whose plugin registers that tool.
 */
async function patchReadBinaryDocumentGuard(root) {
  const readSource = join(root, 'packages/fs/tool-fs/src/read.ts')
  let source = await readFile(readSource, 'utf8')
  if (source.includes('binaryDocumentDenial')) return
  const imports = [
    ["import type {} from '@deepseek-ai/dsh-fs'", "import { FsError } from '@deepseek-ai/dsh-fs'\nimport type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'"],
    ["import type { GenericCallView, ReadResultView, ToolResult } from '@deepseek-ai/dsh-tools'", "import type { GenericCallView, ReadResultView, ToolExecution, ToolResult } from '@deepseek-ai/dsh-tools'"],
  ]
  for (const [from, to] of imports) {
    if (!source.includes(from) && !source.includes(to)) throw new Error('read.ts no longer matches the binary-document guard imports')
    source = source.replace(from, to)
  }
  const helper = [
    '/**',
    ' * Refuse a binary PDF before the text reader turns it into replacement',
    ' * characters. The check is a magic-prefix read, so the decision follows the',
    ' * bytes rather than the name; a backend without a window read fails open',
    ' * (the read then behaves exactly as it did before this guard).',
    ' */',
    'async function binaryDocumentDenial(',
    '  ctx: Context,',
    '  exec: ToolExecution,',
    '  target: FsTarget,',
    '  info: FsInfo,',
    '): Promise<string | undefined> {',
    '  if (info.size === 0) return undefined',
    '  if (typeof ctx.fs.readByteRange !== \'function\') return undefined',
    '  const head = await ctx.fs.readByteRange(target, { offset: 0, length: 5 }, exec.signal).catch(() => undefined)',
    '  if (head === undefined || head.length < 4) return undefined',
    '  if (head[0] !== 0x25 || head[1] !== 0x50 || head[2] !== 0x44 || head[3] !== 0x46) return undefined',
    '  return \'cannot read "\' + target.displayPath + \'" as text: the file is a binary PDF. Use the read_document tool to extract its text — a text reader can only return replacement characters for it.\'',
    '}',
    '',
  ].join('\n')
  const applyAnchor = 'export function applyReadTool(ctx: Context, caps: ReadToolCaps): void {'
  if (!source.includes(applyAnchor)) throw new Error('read.ts no longer matches the binary-document guard anchor')
  source = source.replace(applyAnchor, `${helper}${applyAnchor}`)
  const executeAnchor = '      const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)'
  if (!source.includes(executeAnchor)) throw new Error('read.ts execute() no longer matches the binary-document guard anchor')
  source = source.replace(executeAnchor, `${executeAnchor}\n\n      const binaryDenial = await binaryDocumentDenial(ctx, exec, target, info)\n      if (binaryDenial !== undefined) throw new FsError(binaryDenial, 'FS_NOT_TEXT')`)
  await writeFile(readSource, source)
}

/**
 * Suspend a tool's deadline while its approval blocks on a human, so a declared
 * budget measures the operation instead of the user's reading time. Two seams:
 * dsh-timeout learns to pause/re-arm a running deadline (addressable by the
 * signal the blocked call holds), and the approval service brackets its
 * `decide()` with suspend/resume so every answerer path is covered.
 */
async function patchTimeoutSuspensionSeam(root) {
  const timeoutSource = join(root, 'packages/util/timeout/src/index.ts')
  let source = await readFile(timeoutSource, 'utf8')
  if (!source.includes('export function suspendTimeout(signal: AbortSignal | undefined): boolean')) {
    const watchdogAnchor = '/** Rearmable timeout around one outstanding async-iterator demand. */'
    if (!source.includes(watchdogAnchor)) throw new Error('dsh-timeout source no longer matches the suspension seam anchor')
    const pausableBlock = [
      '/**',
      ' * A running deadline\'s timer, addressable so it can be paused and re-armed.',
      ' *',
      ' * Not part of the public {@link Deadline} shape on purpose: callers that only',
      ' * want "abort me if this runs long" are the overwhelming majority, and widening',
      ' * their interface would force every implementer of it to grow two methods for a',
      ' * capability only a blocking-on-a-human path needs.',
      ' */',
      'export interface PausableDeadline {',
      '  /** Suspend the timer. Nested pauses nest: the timer stays stopped until the',
      '   *  last matching {@link resume}. */',
      '  pause(): void',
      '  /** Re-arm with the time that was left when the outermost pause began. */',
      '  resume(): void',
      '  /** Milliseconds left on the clock right now. */',
      '  remainingMs(): number',
      '  /** How many pauses are currently in effect. */',
      '  readonly pauseDepth: number',
      '}',
      '',
      '/**',
      ' * Running timers by the signal their caller holds.',
      ' *',
      ' * Keyed by the signal {@link deadline} returns, because that is the object the',
      ' * code that blocks actually has: a tool receives the derived signal on',
      ' * `exec.signal` and hands that same signal to whatever it awaits, so the pause',
      ' * can be requested from the blocker without either side learning about the',
      ' * other. A `WeakMap` so a finished call leaves nothing behind.',
      ' */',
      'const runningDeadlines = new WeakMap<AbortSignal, PausableDeadline>()',
      '',
      '/**',
      ' * Suspend the timeout riding one signal.',
      ' *',
      ' * Why this exists: a tool that declares a budget and then waits for a human has',
      ' * two clocks running against each other, and the wrong one wins. The deadline',
      ' * cannot tell a slow operation from a user reading a prompt, so a call that is',
      ' * blocked on an approval burns its budget while it is doing no work at all, and',
      ' * the approval resolves into a `TOOL_TIMEOUT` that discards the answer the user',
      ' * just gave. Pausing while the human decides makes the budget measure the',
      ' * operation, which is what it was declared for.',
      ' *',
      ' * Suspending every deadline on the signal rather than a named one is',
      ' * deliberate: the call is not running, so no timer on it should be counting, and',
      ' * a nested deadline would otherwise reintroduce the same bug through a layer the',
      ' * caller cannot see.',
      ' *',
      ' * @param signal - the deadline signal the blocked call holds; absent means nothing to do.',
      ' * @returns whether a timer was actually suspended.',
      ' */',
      'export function suspendTimeout(signal: AbortSignal | undefined): boolean {',
      '  const running = signal === undefined ? undefined : runningDeadlines.get(signal)',
      '  if (running === undefined) return false',
      '  running.pause()',
      '  return true',
      '}',
      '',
      '/**',
      ' * Re-arm the timeout {@link suspendTimeout} suspended.',
      ' *',
      ' * @param signal - the signal whose deadline should resume counting.',
      ' * @returns whether a timer was actually resumed.',
      ' */',
      'export function resumeTimeout(signal: AbortSignal | undefined): boolean {',
      '  const running = signal === undefined ? undefined : runningDeadlines.get(signal)',
      '  if (running === undefined) return false',
      '  running.resume()',
      '  return true',
      '}',
      '',
      '/** Milliseconds left on the deadline riding a signal, or `undefined` without one. */',
      'export function remainingTimeoutMs(signal: AbortSignal | undefined): number | undefined {',
      '  return signal === undefined ? undefined : runningDeadlines.get(signal)?.remainingMs()',
      '}',
      '',
    ].join('\n')
    source = source.replace(watchdogAnchor, `${pausableBlock}${watchdogAnchor}`)
    const fireLine = '  const id = setTimeout(() => { timer.abort(new TimeoutReason(code, timeoutMs)) }, timeoutMs)'
    if (!source.includes(fireLine)) throw new Error('dsh-timeout deadline() no longer matches the suspension seam')
    source = source.replace(fireLine, [
      '  const fire = (): void => { timer.abort(new TimeoutReason(code, timeoutMs)) }',
      '  let remaining = timeoutMs',
      '  let armedAt = Date.now()',
      '  let id: ReturnType<typeof setTimeout> | undefined = setTimeout(fire, timeoutMs)',
      '  let pauseDepth = 0',
      '  const signal = upstream !== undefined ? AbortSignal.any([upstream, timer.signal]) : timer.signal',
      '  runningDeadlines.set(signal, {',
      '    get pauseDepth() { return pauseDepth },',
      '    remainingMs(): number {',
      '      if (pauseDepth > 0) return remaining',
      '      return Math.max(0, remaining - (Date.now() - armedAt))',
      '    },',
      '    pause(): void {',
      '      pauseDepth += 1',
      '      if (pauseDepth > 1) return',
      '      if (id !== undefined) clearTimeout(id)',
      '      id = undefined',
      '      // Freeze the clock at what was left, so the time a human spent deciding is',
      '      // not charged to the operation in either direction: not consumed, and not',
      '      // added to the budget either.',
      '      remaining = Math.max(0, remaining - (Date.now() - armedAt))',
      '    },',
      '    resume(): void {',
      '      if (pauseDepth === 0) return',
      '      pauseDepth -= 1',
      '      if (pauseDepth > 0) return',
      '      if (remaining <= 0) {',
      '        // The budget was already spent when the pause began; the deadline fires',
      '        // now rather than granting a fresh interval the call never earned.',
      '        fire()',
      '        return',
      '      }',
      '      armedAt = Date.now()',
      '      id = setTimeout(fire, remaining)',
      '    },',
      '  })',
    ].join('\n'))
    const returnShape = [
      '    signal: upstream !== undefined ? AbortSignal.any([upstream, timer.signal]) : timer.signal,',
      '    [Symbol.dispose]() { clearTimeout(id) },',
    ].join('\n')
    if (!source.includes(returnShape)) throw new Error('dsh-timeout deadline() return no longer matches the suspension seam')
    source = source.replace(returnShape, [
      '    signal,',
      '    [Symbol.dispose]() {',
      '      runningDeadlines.delete(signal)',
      '      if (id !== undefined) clearTimeout(id)',
      '      id = undefined',
      '    },',
    ].join('\n'))
    await writeFile(timeoutSource, source)
  }

  const approvalSource = join(root, 'packages/interaction/user-approval/src/index.ts')
  source = await readFile(approvalSource, 'utf8')
  if (!source.includes('resumeTimeout(req.signal)')) {
    const importAnchor = "import { createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'"
    if (!source.includes(importAnchor)) throw new Error('user-approval source no longer matches the suspension seam import anchor')
    source = source.replace(importAnchor, `${importAnchor}\nimport { resumeTimeout, suspendTimeout } from '@deepseek-ai/dsh-timeout'`)
    const decideLine = '    const outcome = await this.decide(req, session)'
    if (!source.includes(decideLine)) throw new Error('user-approval decide() no longer matches the suspension seam')
    source = source.replace(decideLine, [
      '    // The human is the slowest and least predictable participant in the call,',
      '    // and a tool that declared a budget is charged for the time they spend',
      '    // reading the prompt. That produces the worst possible outcome — the',
      '    // deadline expires while the tool is doing no work, the model is told the',
      '    // call timed out, and the answer the user just gave is discarded. Suspending',
      '    // every deadline riding this signal for the duration of the ask makes the',
      '    // budget measure the operation, which is what it was declared for. Around',
      '    // `decide()` only: the two audit appends are local writes and should be',
      '    // charged as such. Always resumed, so a throwing answerer cannot leave a',
      '    // timer frozen for the rest of the session.',
      '    suspendTimeout(req.signal)',
      '    let outcome: ApprovalOutcome',
      '    try {',
      '      outcome = await this.decide(req, session)',
      '    } finally {',
      '      resumeTimeout(req.signal)',
      '    }',
    ].join('\n'))
    await writeFile(approvalSource, source)
  }

  const approvalManifest = join(root, 'packages/interaction/user-approval/package.json')
  const approvalPackage = JSON.parse(await readFile(approvalManifest, 'utf8'))
  approvalPackage.dependencies ??= {}
  approvalPackage.dependencies['@deepseek-ai/dsh-timeout'] = 'workspace:^'
  if (approvalPackage.devDependencies !== undefined) delete approvalPackage.devDependencies['@deepseek-ai/dsh-timeout']
  await writeFile(approvalManifest, `${JSON.stringify(approvalPackage, null, 2)}\n`)

  // Specs for the seam live OUTSIDE upstream's spec files: the sync replaces
  // whole directories the fork happens to keep its tests in — package `tests/`
  // and `apps/` alike — so these are copied wholesale from the overlay on every
  // run, after the sweep. The overlay keeps them as `.tpl` because the workspace
  // tsconfig typechecks `scripts/**/*.ts`, and a template's relative imports only
  // resolve at its destination.
  //
  // The `apps/web/tests/freecodego-*.e2e.ts` set is here for the same reason as
  // the desktop spec: `apps/` is mirrored exactly (see `copiedDirectories`), and
  // a fork-only file that upstream has never heard of has no counterpart in the
  // source — so `sweepMissing` deleted it on every sync and each run had to
  // recover it by hand. The overlay is the retention mechanism for that whole
  // class and the copy below is what puts them back.
  const overlay = join(root, 'scripts/harness-overlay')
  for (const [from, to] of [
    ['timeout/tests/pause-resume.spec.ts.tpl', 'packages/util/timeout/tests/pause-resume.spec.ts'],
    ['user-approval/tests/approval-suspension.spec.ts.tpl', 'packages/interaction/user-approval/tests/approval-suspension.spec.ts'],
    ['tool-fs/tests/read-binary-document.spec.ts.tpl', 'packages/fs/tool-fs/tests/read-binary-document.spec.ts'],
    ['desktop/tests/freecodego-desktop-bundle.spec.ts.tpl', 'apps/desktop/tests/freecodego-desktop-bundle.spec.ts'],
    ['web/tests/freecodego-capabilities.e2e.ts.tpl', 'apps/web/tests/freecodego-capabilities.e2e.ts'],
    ['web/tests/freecodego-design.e2e.ts.tpl', 'apps/web/tests/freecodego-design.e2e.ts'],
    ['web/tests/freecodego-root-engines.e2e.ts.tpl', 'apps/web/tests/freecodego-root-engines.e2e.ts'],
    ['web/tests/freecodego-teams.e2e.ts.tpl', 'apps/web/tests/freecodego-teams.e2e.ts'],
    ['web/tests/freecodego-voice.e2e.ts.tpl', 'apps/web/tests/freecodego-voice.e2e.ts'],
  ]) {
    const source = join(overlay, from)
    if (!existsSync(source)) throw new Error(`harness overlay spec template missing: ${from}`)
    await cp(source, join(root, to))
  }
}

/**
 * Publish each session row's identity on the DOM.
 *
 * The core sidebar renders rows with `role="treeitem"` and `aria-selected` but
 * no identity attribute, so the FreeCodeGo delete overlay had to infer which
 * session a hovered row belonged to — by walking React's `__reactFiber$`, and
 * failing that by matching a unique title prefix. Both rows already know their
 * id (`node.id` for a hierarchy row, `result.id` for a search result); the
 * attribute is simply the missing public seam.
 *
 * This is additive. The overlay keeps its older tiers, so a host built before
 * this attribute still resolves the row; the attribute only makes the common
 * path read a declared fact instead of inferring one.
 */
/**
 * Mark each workspace row with the Session id it opens.
 *
 * The anchor is the row's own `onClick` line rather than the
 * `aria-selected`/`onClick` pair this patch matched first. 0.1.7-alpha.2 inserted
 * `aria-description={row.archived ? t('toast.archivedNotOpenable') : undefined}`
 * between those two lines -- on the session row and on the search result row alike
 * -- which broke a two-line anchor without changing anything the patch is about: the
 * id still belongs immediately above the click. Each `onClick` is unique in the file,
 * so the single line is not ambiguous.
 */
async function patchSessionRowIdentitySeam(root) {
  const rows = join(root, 'packages/client/ui-workspace/src/client/rows/Rows.tsx')
  let source = await readFile(rows, 'utf8')
  const seams = [
    [
      '      onClick={() => { onOpen(node.id) }}',
      '      data-session-id={node.id}\n      onClick={() => { onOpen(node.id) }}',
    ],
    [
      '      onClick={() => { onOpen(result.id) }}',
      '      data-session-id={result.id}\n      onClick={() => { onOpen(result.id) }}',
    ],
  ]
  for (const [from, to] of seams) {
    if (source.includes(to)) continue
    if (!source.includes(from)) throw new Error('workspace rows no longer match the session identity seam')
    source = source.replace(from, to)
  }
  await writeFile(rows, source)
}


/** Keep the private FreeCodeGo overlay compatible with the released v2 seams. */
async function patchHarnessV013Compatibility(root) {
  const persistence = join(root, 'packages/session/session-persistence-jsonl/src/index.ts')
  let source = await readFile(persistence, 'utf8')
  if (!source.includes('async delete(id: SessionId): Promise<boolean>')) {
    const marker = '    return snapshots\n  }\n\n  // --- handle-facing storage internals'
    if (!source.includes(marker)) throw new Error('session-persistence-jsonl source no longer matches the v0.1.3 list seam')
    source = source.replace(marker, '    return snapshots\n  }\n\n  /** Remove one idle session artifact directory. */\n  async delete(id: SessionId): Promise<boolean> {\n    const selected = await this.findLog(id)\n    if (selected === undefined) return false\n    await rm(dirname(selected.currentPath), { recursive: true, force: true })\n    this.coldLogMemo.delete(id)\n    return true\n  }\n\n  // --- handle-facing storage internals')
    await writeFile(persistence, source)
  }

  const usage = join(root, 'packages/llm/token-meter/src/turn-usage.ts')
  source = await readFile(usage, 'utf8')
  if (!source.includes('if (!Array.isArray(stream)) return undefined')) {
    const marker = 'function streamUsage(stream: SessionEvent<\'assistant/message\'>[\'data\'][\'stream\']): TokenUsage | undefined {\n'
    if (!source.includes(marker)) throw new Error('token-meter source no longer matches the v2 stream usage seam')
    source = source.replace(marker, `${marker}  if (!Array.isArray(stream)) return undefined\n`)
    await writeFile(usage, source)
  }

  // No `lease.ts` patch.
  //
  // Upstream moved this file onto `@deepseek-ai/node-addon-system/flock` -- POSIX
  // `flock(2)` and a Win32 named semaphore -- before 0.1.7-alpha.2, so the `fs-ext`
  // shape this block rewrote is not in any line this workspace can check out:
  // 0.1.6-alpha.1, 0.1.6-alpha.2, 0.1.7-alpha.2 and 0.1.7-rc.2 all import
  // `tryLockExclusive` instead. The guard made the block silent rather than wrong,
  // which is why it outlived its anchor by more than a line; the fork has nothing
  // left to fix here, because the native lock is upstream's own implementation and
  // no longer a dependency this repository has to soften.

  const fileUploadConfig = join(root, 'packages/client/file-upload/tsdown.config.ts')
  source = await readFile(fileUploadConfig, 'utf8')
  if (!source.includes('{ hostPhase: true }')) {
    source = source.replace("clientBundle('@deepseek-ai/dsh-client-file-upload', ['lib/types/index.js'])", "clientBundle('@deepseek-ai/dsh-client-file-upload', ['lib/types/index.js'], { hostPhase: true })")
    await writeFile(fileUploadConfig, source)
  }

  const remotesConfig = join(root, 'packages/api/remotes/tsconfig.host.json')
  source = await readFile(remotesConfig, 'utf8')
  if (!source.includes('../../client/file-upload/tsconfig.host.json')) {
    source = source.replace('    {\n      "path": "../workspace-controller/tsconfig.host.json"\n    },', '    {\n      "path": "../workspace-controller/tsconfig.host.json"\n    },\n    {\n      "path": "../../client/file-upload/tsconfig.host.json"\n    },')
    await writeFile(remotesConfig, source)
  }

  const dependencyPolicy = join(root, 'scripts/package-dependency-policy.ts')
  source = await readFile(dependencyPolicy, 'utf8')
  // `@deepseek-ai/dsh-session` must NOT be listed here: upstream classifies
  // `SESSION_FORMAT_VERSION` as peer-required, and a package may not appear in
  // both the safe and the peer-required tables.
  if (!source.includes("'@deepseek-ai/dsh-session-format': ['sessionFormatLogFilename']")) {
    source = source.replace("  '@deepseek-ai/dsh-llm': ['callConfigEquals'],", "  '@deepseek-ai/dsh-llm': ['BlockAssembler', 'callConfigEquals', 'expandAssistantStream'],\n  '@deepseek-ai/dsh-session-format': ['sessionFormatLogFilename'],")
    await writeFile(dependencyPolicy, source)
  }

  // The published FreeCodeGo bundle is a distribution bundle, not a Client/Host
  // workspace package: `hostSourceEntries` cannot map its `./dist/*.js` Host
  // subpaths to a source entry under this package, because those artifacts
  // bundle other workspace packages. `CLIENT_FACE_EXCLUDE` is the policy's own
  // escape hatch, and `discoverPackageDependencyScope` honours it by leaving the
  // package unselected, which restores the gate to its measured roster.
  if (!source.includes("  'freecodego',")) {
    const exclusionAnchor = "  '@deepseek-ai/dsh-api-workspace-controller',\n]"
    if (!source.includes(exclusionAnchor)) {
      throw new Error('package-dependency-policy.ts no longer matches the Client-face exclusion anchor')
    }
    source = source.replace(exclusionAnchor, [
      "  '@deepseek-ai/dsh-api-workspace-controller',",
      '  // The published FreeCodeGo bundle. Its Host-facing subpaths are esbuild',
      '  // artifacts of other workspace packages: tsconfig.base.json maps',
      '  // `freecodego/auto-review` and its siblings to their sources, not to anything',
      '  // under this package, so the Client/Host model (every Host export is a',
      '  // lib-built module with a source entry here) cannot hold for a bundle. Its',
      '  // manifest is a distribution manifest, whose peers mirror what the bundle',
      '  // inlines, rather than one derived from the import graph of this package.',
      "  'freecodego',",
      ']',
    ].join('\n'))
    await writeFile(dependencyPolicy, source)
  }

  const dependencySpec = join(root, 'scripts/verify-package-dependencies.spec.ts')
  source = await readFile(dependencySpec, 'utf8')
  // The roster assertion pins the policy verbatim, so the exclusion above has to
  // be mirrored here or the spec fails on the next run of the tree.
  if (!source.includes("      'freecodego',")) {
    const rosterAnchor = "      '@deepseek-ai/dsh-api-workspace-controller',\n    ])"
    if (!source.includes(rosterAnchor)) {
      throw new Error('verify-package-dependencies.spec.ts no longer matches the Client-face roster anchor')
    }
    source = source.replace(rosterAnchor, "      '@deepseek-ai/dsh-api-workspace-controller',\n      'freecodego',\n    ])")
    await writeFile(dependencySpec, source)
  }

  // No overlay for `packages/session-query/session-log-export/package.json`.
  //
  // An earlier overlay moved `@deepseek-ai/dsh-session` from `devDependencies`
  // into `dependencies`. Upstream's policy classifies `SESSION_FORMAT_VERSION`
  // under `PEER_REQUIRED_HOST_EXPORTS` — the value must come from the
  // consumer's single shared copy — so the manifest has to stay
  // `peerDependencies + devDependencies`. The overlay's companion edit to the
  // policy table never applied (the guard below already sees upstream's own
  // `dsh-session-format` entry), leaving the two halves inconsistent and
  // `verify-package-dependencies` reporting the mismatch. Upstream's manifest
  // is already the shape the policy wants, so there is nothing to patch.

  // No `session-fixture-layout` patches.
  //
  // Both anchors are gone upstream: `packChunkRuns` became `decodeSeqRanges`, and the
  // `turn/start` fixture row no longer carries `seq`/`time`. Verified absent in every
  // line this workspace can check out (0.1.6-alpha.1, 0.1.6-alpha.2, 0.1.7-alpha.2,
  // 0.1.7-rc.2), and both replaces were unconditional with no postcondition behind
  // them, so they had been silently doing nothing for at least two lines.
  //
  // Worth stating rather than deleting quietly: these two files are *tracked* in this
  // repository while `scripts/` is add-only in the sync, so upstream's later revisions
  // of them never arrive and whatever is checked in is what `tsconfig.host.json`
  // typechecks. Refreshing them is a deliberate act -- copy the upstream file, then
  // re-apply what this repository needs on top -- not something a sync performs.
}
