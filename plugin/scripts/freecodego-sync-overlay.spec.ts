/**
 * The private sync overlay must ship with the repository.
 *
 * Why this is a gate rather than a convention
 * -------------------------------------------
 * `sync:harness` replaces whole upstream package directories — `tests/`
 * included — so the specs that cover the private seams cannot live in the
 * synced tree. They live in `scripts/harness-overlay` as `.tpl` files and are
 * copied back on every sync. But `scripts/*` is gitignored wholesale, with
 * named `!` exceptions for the files a clone must have, and the overlay was
 * never added to that list: **the three templates existed only in this working
 * copy.**
 *
 * The failure is loud rather than silent (`sync-harness.mjs` throws
 * `harness overlay spec template missing`), which is why it went unnoticed: the
 * only way to hit it is to clone and then sync. Loud-but-undiscoverable is
 * still broken — a fresh clone could not run the sync at all.
 *
 * What it checks
 * --------------
 * 1. The copy list is read *out of* `sync-harness.mjs`, so the guard cannot
 *    disagree with the script it guards.
 * 2. Every template named there exists on disk.
 * 3. Every template is tracked by git, and is therefore present after a clone.
 *    Skipped — not failed — when the working copy is not a git work tree, so
 *    the gate never depends on a tool that may be absent.
 *
 * @module scripts/freecodego-sync-overlay
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const SYNC_SCRIPT = join(REPO_ROOT, 'scripts/sync-harness.mjs')

/** The `[from, to]` pairs the sync script copies out of the overlay. */
function overlayCopies(): readonly { readonly from: string; readonly to: string }[] {
  const source = readFileSync(SYNC_SCRIPT, 'utf8')
  // The pairs are the array literal of the copy loop; a missing loop means the
  // script was reshaped and this guard must be re-read, not silently pass.
  const block = /for \(const \[from, to\] of \[([\s\S]*?)\]\s*\)\s*\{/u.exec(source)
  if (block === null) throw new Error('sync-harness.mjs no longer copies an overlay in the expected shape')
  const pairs = [...block[1]!.matchAll(/\['([^']+)',\s*'([^']+)'\]/gu)]
  return pairs.map(match => ({ from: match[1]!, to: match[2]! }))
}

/** Whether the working copy is inside a git work tree. */
function isGitWorkTree(): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Whether git would exclude a repository-relative path from a clone.
 *
 * The question is "does a clone receive this file", which is not the same as
 * "is it in the index": these templates are legitimately untracked until
 * somebody stages them, and a guard that demanded staging would fail for a
 * reason unrelated to the defect. `git check-ignore` answers the actual
 * question, and answers it by exit code.
 */
function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: REPO_ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('FreeCodeGo sync overlay', () => {
  const copies = overlayCopies()

  it('finds copy pairs, so an empty scan cannot pass silently', () => {
    // Three today: the timeout pause/resume seam, the approval suspension seam,
    // and the binary-document guard.
    expect(copies.length).toBeGreaterThanOrEqual(3)
    expect(copies.map(entry => entry.from)).toContain('timeout/tests/pause-resume.spec.ts.tpl')
  })

  it('has every template the sync script copies', () => {
    const missing = copies
      .filter(entry => statSync(join(REPO_ROOT, 'scripts/harness-overlay', entry.from), { throwIfNoEntry: false }) === undefined)
      .map(entry => entry.from)
    expect(missing).toStrictEqual([])
  })

  it('targets a path the sync actually writes into the synced tree', () => {
    const suspicious = copies
      .filter(entry => !entry.to.endsWith('.spec.ts'))
      .map(entry => entry.to)
    // A template that does not land as a spec would be copied and forgotten.
    expect(suspicious).toStrictEqual([])
  })

  it('keeps every template out of gitignore, so a clone can sync', () => {
    if (!isGitWorkTree()) return
    const ignored = copies
      .map(entry => `scripts/harness-overlay/${entry.from}`)
      .filter(path => isIgnored(path))
    // This is the measured defect: these three existed only in the author's
    // working copy, because `scripts/*` is ignored except for named exceptions.
    expect(ignored).toStrictEqual([])
  })
})

/**
 * The `scripts/` tree is the one the fork shares with upstream file by file, so it
 * is materialized by a third rule: upstream files the destination lacks are added,
 * and nothing is ever overwritten or swept.
 *
 * Why the rule is needed at all: the synced workspace typechecks and builds as a
 * whole, so upstream's own specs and build configs import helpers under `scripts/`
 * (`gen-tool-catalog`, `project-doc-site`, `libreoffice-packages`, the coverage
 * partitions `vitest.config.ts` names). A published clone starts without them --
 * `scripts/*` is gitignored except for the fork's own entries -- so the release run
 * reached `build:official` and died on unresolved imports of files this working copy
 * has carried since it was first imported.
 *
 * Why it is exercised rather than described: the copy rules are the contract, and
 * the property that matters is what the destination looks like afterwards. A
 * fixture source exercises the three outcomes that distinguish this rule from a
 * mirror -- an absent upstream file is added, an existing one keeps its bytes, and
 * a fork-only one survives -- in the shape `HARNESS_SYNC_COPY_ONLY` exists for.
 */
describe('FreeCodeGo sync script sources', () => {
  function fixture(): { readonly source: string; readonly root: string; readonly scripts: string } {
    const base = mkdtempSync(join(tmpdir(), 'dsh-sync-scripts-'))
    const source = join(base, 'source')
    const root = join(base, 'root')
    const scripts = join(root, 'scripts')
    mkdirSync(join(source, 'apps'), { recursive: true })
    mkdirSync(join(source, 'packages/demo'), { recursive: true })
    mkdirSync(join(source, 'scripts/release'), { recursive: true })
    mkdirSync(scripts, { recursive: true })
    writeFileSync(join(source, 'apps/kept.txt'), 'upstream application\n')
    writeFileSync(join(source, 'packages/demo/package.json'), '{}\n')
    writeFileSync(join(source, 'scripts/absent-upstream.ts'), 'export const added = true\n')
    writeFileSync(join(source, 'scripts/release/absent-upstream.ts'), 'export const nested = true\n')
    writeFileSync(join(source, 'scripts/shared.ts'), 'export const upstream = true\n')
    writeFileSync(join(root, 'harness.lock.json'), JSON.stringify({ repository: 'https://example.invalid/harness.git', candidate: { commit: 'a'.repeat(40) } }))
    writeFileSync(join(root, 'harness.config.json'), JSON.stringify({ repository: 'https://example.invalid/harness.git' }))
    // The fork's own copy of a name both sides have, plus a file only the fork has.
    writeFileSync(join(scripts, 'shared.ts'), 'export const forked = true\n')
    writeFileSync(join(scripts, 'fork-only.ts'), 'export const fork = true\n')
    return { source, root, scripts }
  }

  it('adds upstream scripts, keeps existing bytes, and sweeps nothing', () => {
    const { source, root, scripts } = fixture()
    try {
      execFileSync(process.execPath, [SYNC_SCRIPT], {
        env: { ...process.env, HARNESS_SYNC_SOURCE: source, HARNESS_SYNC_ROOT: root, HARNESS_SYNC_COPY_ONLY: '1' },
        stdio: 'pipe',
      })
      expect(readFileSync(join(scripts, 'absent-upstream.ts'), 'utf8')).toContain('added = true')
      expect(readFileSync(join(scripts, 'release/absent-upstream.ts'), 'utf8')).toContain('nested = true')
      expect(readFileSync(join(scripts, 'shared.ts'), 'utf8')).toContain('forked = true')
      expect(readFileSync(join(scripts, 'fork-only.ts'), 'utf8')).toContain('fork = true')
      // The directories that are mirrored rather than added still mirror.
      expect(readFileSync(join(root, 'apps/kept.txt'), 'utf8')).toBe('upstream application\n')
    } finally {
      rmSync(dirname(source), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })

  it('refuses a source that is not a Harness checkout before adding anything', () => {
    const { source, root, scripts } = fixture()
    try {
      rmSync(join(source, 'packages'), { recursive: true, force: true })
      let failed = false
      try {
        execFileSync(process.execPath, [SYNC_SCRIPT], {
          env: { ...process.env, HARNESS_SYNC_SOURCE: source, HARNESS_SYNC_ROOT: root, HARNESS_SYNC_COPY_ONLY: '1' },
          stdio: 'pipe',
        })
      } catch {
        failed = true
      }
      expect(failed).toBe(true)
      // Nothing was added on the way to the refusal.
      expect(statSync(join(scripts, 'absent-upstream.ts'), { throwIfNoEntry: false })).toBeUndefined()
    } finally {
      rmSync(dirname(source), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
})

/**
 * A checkout on this host writes a symlink as a regular file holding its target,
 * because `core.symlinks=false` is the Windows default. `mirrorDirectory` copies
 * with `dereference: true`, so there was nothing to resolve and the link *text*
 * landed in the tree -- measured on twelve upstream paths, two of them load-bearing
 * (`packages/CLAUDE.md` carried the nine bytes `AGENTS.md`; a snapshot fixture the
 * session suite compares against real output).
 *
 * Why the fixture uses `git update-index --cacheinfo`
 * --------------------------------------------------
 * The defect is "the index says 120000, the working tree says plain text", and that
 * pair cannot be built on Windows with `ln -s` at all -- the host refuses. Writing
 * the index entry directly reproduces the same pair anywhere, without needing the
 * privilege whose absence causes the bug. The look-alike case is the other half of
 * the contract: a file whose whole body happens to name a sibling must be left
 * alone, which is why the repair asks git for the mode instead of testing shape.
 */
describe('FreeCodeGo sync symlink repair', () => {
  function git(args: readonly string[], cwd: string): string {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }

  /** A throwaway checkout whose `apps/CLAUDE.md` is recorded as a link, or merely looks like one. */
  function gitFixture(options: { readonly recordedAsLink: boolean }): { readonly source: string; readonly root: string } {
    const base = mkdtempSync(join(tmpdir(), 'dsh-sync-links-'))
    const source = join(base, 'source')
    const root = join(base, 'root')
    mkdirSync(join(source, 'apps'), { recursive: true })
    mkdirSync(join(source, 'packages/demo'), { recursive: true })
    mkdirSync(root, { recursive: true })
    writeFileSync(join(source, 'apps/AGENTS.md'), 'the agent instructions\n')
    writeFileSync(join(source, 'apps/CLAUDE.md'), 'AGENTS.md\n')
    writeFileSync(join(source, 'packages/demo/package.json'), '{}\n')
    git(['init', '-q', '.'], source)
    git(['config', 'user.email', 'fixture@example.invalid'], source)
    git(['config', 'user.name', 'fixture'], source)
    git(['add', '-A'], source)
    if (options.recordedAsLink) {
      const blob = git(['rev-parse', ':apps/CLAUDE.md'], source)
      git(['update-index', '--add', '--cacheinfo', `120000,${blob},apps/CLAUDE.md`], source)
    }
    git(['commit', '-qm', 'fixture'], source)
    const commit = git(['rev-parse', 'HEAD'], source)
    writeFileSync(join(root, 'harness.lock.json'), JSON.stringify({ repository: 'https://example.invalid/harness.git', candidate: { commit } }))
    writeFileSync(join(root, 'harness.config.json'), JSON.stringify({ repository: 'https://example.invalid/harness.git' }))
    return { source, root }
  }

  function sync(source: string, root: string): void {
    execFileSync(process.execPath, [SYNC_SCRIPT], {
      env: { ...process.env, HARNESS_SYNC_SOURCE: source, HARNESS_SYNC_ROOT: root, HARNESS_SYNC_COPY_ONLY: '1' },
      stdio: 'pipe',
    })
  }

  it('restores the target bytes of a link the source materialized', () => {
    const { source, root } = gitFixture({ recordedAsLink: true })
    try {
      sync(source, root)
      // The mirror copied the link text; the repair replaces it with the target's bytes.
      expect(readFileSync(join(root, 'apps/CLAUDE.md'), 'utf8')).toBe('the agent instructions\n')
      expect(readFileSync(join(root, 'apps/AGENTS.md'), 'utf8')).toBe('the agent instructions\n')
    } finally {
      rmSync(dirname(source), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })

  it('leaves a look-alike alone when git does not record it as a link', () => {
    const { source, root } = gitFixture({ recordedAsLink: false })
    try {
      sync(source, root)
      // Shape is not evidence: this file's body names a sibling, and it is still a file.
      expect(readFileSync(join(root, 'apps/CLAUDE.md'), 'utf8')).toBe('AGENTS.md\n')
    } finally {
      rmSync(dirname(source), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
})

/**
 * Every fixture above runs the sync with `HARNESS_SYNC_COPY_ONLY=1`, which returns
 * before the first fork — so nothing in this suite ever executed `applyForks`, and the
 * one thing a fork can get wrong at module scope went unchecked.
 *
 * FreeCodeGo 0.1.7-rc.2 shipped with exactly that defect: `patchGenConfigCatalogTypeParameters`
 * read two `const` anchor strings declared *below* the top-level `applyForks` call, so the
 * run died on `Cannot access 'GEN_CONFIG_CATALOG_COLLECTOR_ANCHOR' before initialization`
 * once the copies had been made. Nothing local could see it. A `const` below the call is
 * only in its dead zone when the patch actually applies, and a working copy this fork has
 * already patched returns early on its marker and never reads the anchor; the release
 * workflow was therefore the first place the two met, and it stopped the release there.
 *
 * The rule is mechanical, so it is checked mechanically: a fork reads module state at call
 * time, and `applyForks` runs from the patch-only branch near the top of the file, so a
 * module binding declared below that call is uninitialized whenever a fork reads it. Hoisted
 * `function` declarations are how a helper or an anchor stays beside its fork — the script's
 * own `runPluginCommandBefore` and `genConfigCatalogCollectorAnchor` are the two that already
 * do. Only the forks `applyForks` names are judged, because straight-line code below the call
 * runs long after the module is initialized. Scanned as text because that is what the language
 * does here: declaration order, not call order, decides what is initialized when the call runs.
 */
describe('FreeCodeGo sync fork phase', () => {
  const lines = readFileSync(SYNC_SCRIPT, 'utf8').split('\n')

  /** The body of a top-level `function name(...)`; this file closes those with `}` in column 0. */
  function bodyOf(name: string): string {
    const start = lines.findIndex(line => new RegExp(`^(?:async )?function ${name}\\(`, 'u').test(line))
    if (start < 0) throw new Error(`sync-harness.mjs no longer declares ${name}`)
    const end = lines.findIndex((line, index) => index > start && line === '}')
    return lines.slice(start, end < 0 ? lines.length : end + 1).join('\n')
  }

  /** The forks `applyForks` calls, read out of `applyForks` so the two cannot disagree. */
  const forks = [...bodyOf('applyForks').matchAll(/await (\w+)\(/gu)].map(match => match[1]!)

  it('names the forks, so an empty scan cannot pass silently', () => {
    expect(forks.length).toBeGreaterThanOrEqual(8)
    expect(forks).toContain('patchGenConfigCatalogTypeParameters')
  })

  it('initializes every module binding a fork reads before the first fork runs', () => {
    const firstCall = lines.findIndex(line => /^\s*(?:await )?applyForks\(/u.test(line))
    // A reshaped script must be re-read by this guard rather than pass it silently.
    expect(firstCall).toBeGreaterThanOrEqual(0)
    const forkSource = forks.map(bodyOf).join('\n')
    const lateBindings = lines
      .map((line, index) => ({ line, index }))
      .filter(entry => entry.index > firstCall && /^(?:const|let|var) \w+/u.test(entry.line))
      .map(entry => ({ entry, name: /^(?:const|let|var) (\w+)/u.exec(entry.line)?.[1] ?? '' }))
      .filter(({ name }) => name !== '' && new RegExp(`\\b${name}\\b`, 'u').test(forkSource))
      .map(({ entry }) => `${String(entry.index + 1)}: ${entry.line}`)
    expect(lateBindings).toStrictEqual([])
  })
})
