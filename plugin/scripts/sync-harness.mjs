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

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

/** Remove destination entries the source does not have, so the mirror is exact. */
async function sweepMissing(from, to) {
  const [sourceEntries, targetEntries] = await Promise.all([
    readdir(from, { withFileTypes: true }),
    readdir(to, { withFileTypes: true }),
  ])
  const expected = new Map(sourceEntries.map((entry) => [entry.name, entry]))
  let swept = 0
  for (const entry of targetEntries) {
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
 * `scripts/` (`gen-tool-catalog`, `project-doc-site`, `libreoffice-engine`, the
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
for (const directory of [
  'experimental/agent-team',
  'experimental/agent-team-profile',
  'experimental/agent-team-web-profile',
  'experimental/client-ui-agent-team',
  'experimental/tool-agent-team',
]) {
  const manifestPath = join(targetPackages, directory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  delete manifest.private
  manifest.publishConfig = { ...(manifest.publishConfig ?? {}), access: 'public' }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

// The upstream experimental tool/profile packages do not all carry a
// tsdown config. Keep their release artifacts reproducible after every sync.
await writeFile(join(targetPackages, 'experimental/tool-agent-team/tsdown.config.ts'), `import { defineConfig } from 'tsdown'\n\nexport default defineConfig({\n  entry: ['lib/types/index.js'],\n  outDir: 'lib',\n  format: ['esm'],\n  platform: 'node',\n  target: 'es2024',\n  fixedExtension: false,\n  dts: false,\n  clean: false,\n})\n`)
await writeFile(join(targetPackages, 'experimental/agent-team-profile/tsdown.config.ts'), `import { defineConfig } from 'tsdown'\n\nexport default defineConfig({\n  entry: ['lib/types/index.js'],\n  outDir: 'lib',\n  format: ['esm'],\n  platform: 'node',\n  target: 'es2024',\n  fixedExtension: false,\n  dts: false,\n  clean: false,\n})\n`)
await writeFile(join(targetPackages, 'experimental/agent-team-web-profile/tsdown.config.ts'), `import { defineConfig } from 'tsdown'\n\nexport default defineConfig({\n  entry: ['lib/types/index.js'],\n  outDir: 'lib',\n  format: ['esm'],\n  platform: 'node',\n  target: 'es2024',\n  fixedExtension: false,\n  dts: false,\n  clean: false,\n})\n`)

await applyForks(root)

console.log(`sync-harness: materialized ${commit} from ${repository}`)

/**
 * Apply every fork, in the order the tree needs them.
 *
 * One list rather than the call sites it used to be, so full sync and patch-only
 * cannot drift apart: a fork that is added here is applied by both.
 */
async function applyForks(root) {
  await patchFreeCodeGoProfileInstaller(join(root, 'packages/boot/plugin-manager/src/operations.ts'))
  await patchHarnessV013Compatibility(root)
  await patchTimeoutSuspensionSeam(root)
  await patchReadBinaryDocumentGuard(root)
  await patchSessionRowIdentitySeam(root)
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
    const updated = source.replace(
      /const FREECODEGO_BUNDLE = ['"][^'"]+['"]/u,
      "const FREECODEGO_BUNDLE = 'freecodego'",
    )
    if (updated !== source) await writeFile(path, updated)
    return
  }
  source = source.replace("import { existsSync } from 'node:fs'", "import { existsSync, readFileSync, writeFileSync } from 'node:fs'")
  source = source.replace("import { join, resolve } from 'node:path'", "import { dirname, join, resolve } from 'node:path'")
  source = source.replace("import { execa } from 'execa'", "import { spawnSync } from 'node:child_process'\nimport { execa } from 'execa'")
  source = source.replace(
    "import type { PackageResult } from './types.ts'",
    ["import type { PackageResult } from './types.ts'", '', ...freeCodeGoConstants()].join('\n'),
  )
  source = source.replace(runPluginCommandBefore().join('\n'), runPluginCommandAfter().join('\n'))
  source += `\n${freeCodeGoHelpers().join('\n')}\n`
  if (
    !source.includes('const firstUse = !existsSync')
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
    "const FREECODEGO_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']",
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
  // whole package directories (tests included), so these are copied wholesale
  // from the overlay on every run — the same pattern as the tsdown overlays.
  // The overlay keeps them as `.tpl` because the workspace tsconfig typechecks
  // `scripts/**/*.ts`, and a template's relative imports only resolve at its
  // destination.
  const overlay = join(root, 'scripts/harness-overlay')
  for (const [from, to] of [
    ['timeout/tests/pause-resume.spec.ts.tpl', 'packages/util/timeout/tests/pause-resume.spec.ts'],
    ['user-approval/tests/approval-suspension.spec.ts.tpl', 'packages/interaction/user-approval/tests/approval-suspension.spec.ts'],
    ['tool-fs/tests/read-binary-document.spec.ts.tpl', 'packages/fs/tool-fs/tests/read-binary-document.spec.ts'],
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
async function patchSessionRowIdentitySeam(root) {
  const rows = join(root, 'packages/client/ui-workspace/src/client/rows/Rows.tsx')
  let source = await readFile(rows, 'utf8')
  const seams = [
    [
      '      aria-selected={selected}\n      onClick={() => { onOpen(node.id) }}',
      '      aria-selected={selected}\n      data-session-id={node.id}\n      onClick={() => { onOpen(node.id) }}',
    ],
    [
      '      aria-selected={selected}\n      onClick={() => { onOpen(result.id) }}',
      '      aria-selected={selected}\n      data-session-id={result.id}\n      onClick={() => { onOpen(result.id) }}',
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

  const lease = join(root, 'packages/session/session-persistence-jsonl/src/lease.ts')
  source = await readFile(lease, 'utf8')
  if (source.includes("import { flock } from 'fs-ext'")) {
    source = source.replace("import { flock } from 'fs-ext'", "type Flock = typeof import('fs-ext').flock")
    source = source.replace('function flockAsync(fd: number, flags: \'exnb\' | \'un\'): Promise<void> {\n', "function flockAsync(fd: number, flags: 'exnb' | 'un'): Promise<void> {\n  const flock = posixFlock\n  if (flock === undefined) return Promise.reject(new Error('POSIX flock implementation is unavailable'))\n")
    source = source.replace("/** Whether a flock failure means another descriptor holds the lock. */", "let posixFlock: Flock | undefined\n\n/** Whether a flock failure means another descriptor holds the lock. */")
    source = source.replace("    // Bounded retry: locking an inode", "    // Windows uses the named semaphore above. Load fs-ext only on POSIX.\n    posixFlock ??= (await import('fs-ext')).flock\n    // Bounded retry: locking an inode")
    source = source.replace('    flock(fd, flags, (error) => {', '    flock(fd, flags, (error: unknown) => {')
    source = source.replace('let posixFlock: typeof Flock | undefined', 'let posixFlock: Flock | undefined')
    await writeFile(lease, source)
  }

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
      '  // `freecodego/agent-team` and its siblings to their sources, not to anything',
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

  const fixture = join(root, 'scripts/session-fixture-layout.ts')
  source = await readFile(fixture, 'utf8')
  source = source.replace("import { packChunkRuns, type SessionEvent } from '@deepseek-ai/dsh-session'", "import type { SessionEvent } from '@deepseek-ai/dsh-session'")
  source = source.replace('    ...packChunkRuns(events).map((stored) => {', '    ...events.map((stored) => {')
  await writeFile(fixture, source)

  const fixtureSpec = join(root, 'scripts/session-fixture-layout.spec.ts')
  source = await readFile(fixtureSpec, 'utf8')
  source = source.replace('  }))\n}\n\nfunction unpackedFixture', '  })) as unknown as SessionEvent[]\n}\n\nfunction unpackedFixture')
  source = source.replace('{"type":"turn/start","data":{"turn":1,"seq":99,"time":100}}', '{"type":"turn/start","data":{"turn":1}}')
  await writeFile(fixtureSpec, source)
}
