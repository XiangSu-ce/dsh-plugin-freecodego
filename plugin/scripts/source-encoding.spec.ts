/**
 * Every source file in the tree this fork owns is valid UTF-8 and carries no
 * literal `U+FFFD`.
 *
 * Why this is a gate rather than a convention
 * ------------------------------------------
 * An editor that writes a non-UTF-8 byte sequence produces a file that is not
 * merely mis-rendered: it disappears from tooling. Oxlint answers a file it
 * cannot decode with `Failed to open file ... stream did not contain valid
 * UTF-8` — it does not lint it at all — and the repository's own lint entry
 * point made that fatal. `scripts/run-oxlint.ts` appends `--format=default`
 * when `CI=true`, and the default formatter unwraps the write of that
 * diagnostic, so one undecodable file turned the whole run into a Rust panic
 * (`output_formatter/default.rs:130`) exiting `127` instead of a report.
 *
 * That was not hypothetical. `packages/freecodego/harness-plugin/tests/
 * headroom-extra.spec.ts` carried three mangled sequences — a `≥` whose final
 * byte had been replaced by `?` (`e2 89 3f`) and two em dashes left in GBK
 * (`a1 aa`) — and it was the sole cause of the panic: repairing those three
 * bytes removed the panic from the full-repository run, which then reported
 * 375 files normally. Nothing failed before that fix; the file was simply
 * outside every gate.
 *
 * So the assertion is written in the negative form that catches the cause. A
 * file that has been through a lossy decode/encode round trip fails one of two
 * ways — undecodable bytes, or a `U+FFFD` that was written back in place of the
 * character that could not be represented — and both are rejected here. The
 * second form is the one that survives review: a `≥` that was written back as
 * the replacement character still compiles and still looks like ordinary text.
 *
 * Scope and boundaries
 * --------------------
 * - Only `packages/freecodego/` and `scripts/` are walked. They are the tree
 *   this fork owns: the root `.gitignore` ignores every other `packages/*`
 *   entry, which is also why the repository lint reaches essentially these
 *   files and no others. Upstream packages are a synced copy, not our source,
 *   and several of their specs deliberately contain a literal `U+FFFD` because
 *   they assert on lossy decoding — the condition below would be wrong there.
 * - Generated output (`lib/`, `dist/`, `node_modules/`) is skipped. It is
 *   rewritten, not authored, so a hit there is a build artefact rather than an
 *   edit that needs review.
 *
 * @module scripts/source-encoding
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '..')

/** The directories this fork owns, relative to the repository root. */
const OWNED_ROOTS = ['packages/freecodego', 'scripts'] as const

/** Directory names that hold generated or installed output, never authored text. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'lib', 'dist', 'coverage', '.git', '.turbo'])

/** Extensions that are expected to be UTF-8 text when they appear in this tree. */
const TEXT_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.md', '.mdx', '.css', '.html', '.yml', '.yaml', '.sh', '.txt',
] as const

/**
 * A floor on the number of files the walk must find.
 *
 * Without it the assertions below pass when the walk returns nothing — a
 * renamed root, a changed extension list, or a `SKIPPED_DIRECTORIES` entry that
 * accidentally matches would all read as "no bad files". The tree held 808
 * matching files when this guard was written, so the floor is set well below
 * that and only asserts that the walk is demonstrably doing work.
 */
const MINIMUM_SCANNED_FILES = 500

interface OwnedFile {
  /** Repository-relative, forward-slashed, for a failure message a reader can paste. */
  readonly path: string
}

/** Every authored text file under the owned roots, sorted for a stable report. */
function ownedTextFiles(): readonly OwnedFile[] {
  const found: OwnedFile[] = []
  const walk = (absolute: string): void => {
    const entries = readdirSync(absolute, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(absolute, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        walk(child)
        continue
      }
      if (!entry.isFile()) continue
      if (!TEXT_EXTENSIONS.some(extension => entry.name.endsWith(extension))) continue
      found.push({ path: relative(REPO_ROOT, child).split('\\').join('/') })
    }
  }
  for (const root of OWNED_ROOTS) walk(join(REPO_ROOT, root))
  return found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * Describe where a file stops being UTF-8, in the terms a reader needs to fix it.
 *
 * The offset is a byte offset because that is what an editor's "go to byte" or a
 * hex view accepts, and the hexadecimal window is included because the common
 * corruption is a *near-miss* — `e2 89 3f` where `e2 89 a5` was meant — which is
 * only visible in the bytes, not in the text around them.
 */
function describeUndecodable(file: OwnedFile, bytes: Buffer, text: string): string {
  const index = text.indexOf('\uFFFD')
  const byteOffset = index < 0 ? 0 : Buffer.byteLength(text.slice(0, index), 'utf8')
  const window = bytes.subarray(Math.max(0, byteOffset - 12), byteOffset + 12)
  return [
    `${file.path} is not valid UTF-8`,
    `  first undecodable byte at offset ${byteOffset}`,
    `  bytes around it: ${window.toString('hex')}`,
  ].join('\n')
}

/**
 * Read one owned file, or `undefined` when it no longer exists.
 *
 * The walk runs at module load, but other specs in this directory create
 * throwaway fixtures *inside* the owned roots (`oxlint-contract.spec.ts` writes
 * `scripts/oxlint-contract-<uuid>.ts` and removes it when it finishes). A file
 * that was enumerated and then removed is not a file this guard can judge, and
 * treating it as a defect would make the result depend on scheduling — which is
 * exactly how this test first failed. Every other error still propagates: a
 * permission problem is not a vanished fixture.
 */
function readOwned(file: OwnedFile): Buffer | undefined {
  try {
    return readFileSync(join(REPO_ROOT, file.path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const FILES = ownedTextFiles()

describe('owned source encoding', () => {
  it('walks the tree it claims to guard', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(MINIMUM_SCANNED_FILES)
    // Both roots must be represented, so a root that stops resolving is visible
    // rather than silently halving the coverage.
    expect(FILES.some(file => file.path.startsWith('packages/freecodego/'))).toBe(true)
    expect(FILES.some(file => file.path.startsWith('scripts/'))).toBe(true)
  })

  it('decodes every owned text file as UTF-8', () => {
    const failures: string[] = []
    for (const file of FILES) {
      const bytes = readOwned(file)
      if (bytes === undefined) continue
      const text = bytes.toString('utf8')
      // Re-encoding what was decoded reproduces the input only when the input was
      // valid; a malformed sequence decodes to U+FFFD and re-encodes to `ef bf bd`.
      if (!Buffer.from(text, 'utf8').equals(bytes)) failures.push(describeUndecodable(file, bytes, text))
    }
    expect(failures.join('\n')).toBe('')
  })

  it('carries no literal replacement character', () => {
    const failures: string[] = []
    for (const file of FILES) {
      const bytes = readOwned(file)
      if (bytes === undefined) continue
      if (bytes.toString('utf8').includes('\uFFFD')) {
        failures.push(`${file.path} contains a literal U+FFFD (the character a lossy decode writes back)`)
      }
    }
    expect(failures.join('\n')).toBe('')
  })

  it('treats a path that vanished after the walk as nothing to judge', () => {
    // The tolerance above is the reason this spec cannot report a scheduling
    // dependency as a defect, so it is asserted rather than assumed.
    expect(readOwned({ path: 'scripts/no-such-fixture-4f2c1a.ts' })).toBeUndefined()
  })
})
