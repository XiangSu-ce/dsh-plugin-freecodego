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
 * (`gen-tool-catalog`, `project-doc-site`, `libreoffice-engine`, the coverage
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
