/**
 * The git unified-diff reader the review engine is built on.
 *
 * Why the parser is here and not behind a library
 * ---------------------------------------------
 * A review reasons about *what a hunk says* — which lines a change adds, on
 * which new-file line numbers, in which file — so the diff has to be a data
 * structure, not a text blob handed to a model. The `diff` package computes
 * diffs; this module does the one job that is actually needed here: read the
 * output `git diff` already produced. That keeps the reviewer's input identical
 * to what a human would review, renames and deletions included, instead of a
 * second diff engine that could disagree with git about the same change.
 *
 * Three facts the parser must not lose
 * ------------------------------------
 * **New-file line numbers are the review's coordinate system.** A comment is
 * addressed to the file as it will look after the change, so `newStart` plus the
 * hunk body is what makes `startLine`/`endLine` meaningful. Dropping the header
 * would make every comment unpositionable.
 *
 * **A rename is not a delete plus an add.** `rename from`/`rename to` and the
 * similarity index are parsed so a moved file is reported as moved; the
 * alternative makes a reviewer read an entire file as new code.
 *
 * **A binary file has no lines to review.** `Binary files … differ` and
 * `GIT binary patch` set `binary`, and the hunk list stays empty so no caller can
 * mistake zero hunks for "unchanged".
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/diff
 */

import { Buffer } from 'node:buffer'

/** How one file changed, as git reports it. */
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'

/** One line of a hunk, keeping the prefix that says which side it belongs to. */
export interface DiffLine {
  /** `+` for an added line, `-` for a removed line, ` ` for retained context. */
  readonly kind: '+' | '-' | ' '
  /** The line's text without its prefix and without the trailing newline. */
  readonly text: string
  /** Whether git marked this line as having no newline at end of file. */
  readonly noNewline?: true
}

/** One hunk with both coordinate systems preserved. */
export interface DiffHunk {
  /** First line of the hunk on the old side, 1-based. */
  readonly oldStart: number
  /** Lines of the hunk on the old side; zero for a pure addition. */
  readonly oldLines: number
  /** First line of the hunk on the new side, 1-based. */
  readonly newStart: number
  /** Lines of the hunk on the new side; zero for a pure deletion. */
  readonly newLines: number
  /** Hunk body in file order. */
  readonly lines: readonly DiffLine[]
}

/** One changed file with its hunks. */
export interface DiffFile {
  /** Display path: the new path, or the old path when the file was deleted. */
  readonly path: string
  /** Path on the old side; null when the file is newly added. */
  readonly oldPath: string | null
  /** Path on the new side; null when the file was deleted. */
  readonly newPath: string | null
  readonly status: DiffFileStatus
  /** True when git reported binary content, in which case `hunks` is empty. */
  readonly binary: boolean
  /** Lines added, counted from the hunks. */
  readonly added: number
  /** Lines removed, counted from the hunks. */
  readonly deleted: number
  readonly hunks: readonly DiffHunk[]
}

/** A hunk header's parsed coordinates. */
interface HunkHeader {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
}

/**
 * Read a `git diff` output into files and hunks.
 *
 * Tolerant by design: an unrecognized line inside a hunk is retained as context
 * rather than aborting the parse, because a review that refuses a whole run over
 * one unexpected metadata line is a review nobody can rely on. Lines outside any
 * file header are ignored, which is what makes it safe to hand this the complete
 * output of a range diff.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: MutableDiffFile | null = null
  let hunk: MutableDiffHunk | null = null

  const flushFile = (): void => {
    if (current === null) return
    files.push(finalizeFile(current))
    current = null
    hunk = null
  }

  for (const raw of splitLines(text)) {
    if (raw.startsWith('diff --git ')) {
      flushFile()
      const paths = parseDiffGitPaths(raw.slice('diff --git '.length))
      current = {
        oldPath: paths?.old ?? null,
        newPath: paths?.new ?? null,
        status: 'modified',
        binary: false,
        hunks: [],
      }
      hunk = null
      continue
    }

    if (current === null) continue

    if (raw.startsWith('@@')) {
      const header = parseHunkHeader(raw)
      if (header === null) {
        hunk = null
        continue
      }
      hunk = { ...header, lines: [] }
      current.hunks.push(hunk)
      continue
    }

    if (hunk !== null) {
      // A new file's header can follow a hunk without an intervening
      // `diff --git` only in hand-edited input; treat a metadata-looking line as
      // the end of the hunk rather than as its content.
      const first = raw[0] as string | undefined
      if (first === '+' || first === '-' || first === ' ') {
        hunk.lines.push(parseHunkLine(raw))
        continue
      }
      if (first === '\\' && raw.startsWith('\\ No newline at end of file')) {
        markNoNewline(hunk)
        continue
      }
      hunk = null
    }

    applyFileMetadata(current, raw)
  }

  flushFile()
  return files
}

/** Everything the parser needs while one file's header block is still open. */
interface MutableDiffFile {
  oldPath: string | null
  newPath: string | null
  status: DiffFileStatus
  binary: boolean
  hunks: MutableDiffHunk[]
}

interface MutableDiffHunk extends HunkHeader {
  lines: DiffLine[]
}

/** Finish one file: resolve the display path, status, and line counts. */
function finalizeFile(file: MutableDiffFile): DiffFile {
  const status = file.status
  const display =
    file.newPath ?? file.oldPath ?? '<unknown>'
  let added = 0
  let deleted = 0
  for (const currentHunk of file.hunks) {
    for (const line of currentHunk.lines) {
      if (line.kind === '+') added += 1
      else if (line.kind === '-') deleted += 1
    }
  }
  return {
    path: display,
    oldPath: file.oldPath,
    newPath: file.newPath,
    status,
    binary: file.binary,
    added,
    deleted,
    hunks: file.hunks,
  }
}

/** Fold one non-hunk line into the file being parsed. */
function applyFileMetadata(file: MutableDiffFile, raw: string): void {
  if (raw.startsWith('new file mode')) {
    file.status = 'added'
    file.oldPath = null
    return
  }
  if (raw.startsWith('deleted file mode')) {
    file.status = 'deleted'
    file.newPath = null
    return
  }
  if (raw.startsWith('rename from ')) {
    file.status = file.status === 'copied' ? 'copied' : 'renamed'
    file.oldPath = parseQuotedPath(raw.slice('rename from '.length))
    return
  }
  if (raw.startsWith('rename to ')) {
    file.status = file.status === 'copied' ? 'copied' : 'renamed'
    file.newPath = parseQuotedPath(raw.slice('rename to '.length))
    return
  }
  if (raw.startsWith('copy from ')) {
    file.status = 'copied'
    file.oldPath = parseQuotedPath(raw.slice('copy from '.length))
    return
  }
  if (raw.startsWith('copy to ')) {
    file.status = 'copied'
    file.newPath = parseQuotedPath(raw.slice('copy to '.length))
    return
  }
  if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
    file.binary = true
    return
  }
  if (raw.startsWith('--- ')) {
    const path = parseDiffMarkerPath(raw.slice(4))
    if (path !== null) file.oldPath = path
    if (path === null) file.status = 'added'
    return
  }
  if (raw.startsWith('+++ ')) {
    const path = parseDiffMarkerPath(raw.slice(4))
    if (path !== null) file.newPath = path
    if (path === null) file.status = 'deleted'
  }
}

/** Read one hunk body line, keeping its prefix. */
function parseHunkLine(raw: string): DiffLine {
  const kind = (raw[0] ?? ' ') as '+' | '-' | ' '
  return { kind, text: raw.slice(1) }
}

/** Attach the no-newline marker to the last line of the hunk. */
function markNoNewline(hunk: MutableDiffHunk): void {
  const last = hunk.lines[hunk.lines.length - 1]
  if (last === undefined) return
  hunk.lines[hunk.lines.length - 1] = { ...last, noNewline: true }
}

/**
 * Parse `@@ -oldStart,oldLines +newStart,newLines @@ optional section`.
 *
 * An omitted count means one line, which is git's own shorthand, so
 * `@@ -1 +1 @@` is a one-line hunk on each side.
 */
export function parseHunkHeader(raw: string): HunkHeader | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
  if (match === null) return null
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  }
}

/**
 * Whether a 1-based line of the new file is covered by this diff.
 *
 * Relocation asks this to decide whether a model-proposed line number can be
 * trusted as-is; a line in no hunk is a number the reviewer could have invented.
 */
export function isLineInNewSide(file: DiffFile, line: number): boolean {
  for (const hunk of file.hunks) {
    if (hunk.newLines === 0) continue
    if (line >= hunk.newStart && line < hunk.newStart + hunk.newLines) return true
  }
  return false
}

/**
 * The set of 1-based new-file line numbers this diff adds.
 *
 * A comment on an added line is about code the change introduced (the review's
 * focus); a comment on retained context is about surrounding code. Callers that
 * need that distinction read this rather than re-walking the hunks.
 */
export function addedLineNumbers(file: DiffFile): ReadonlySet<number> {
  const out = new Set<number>()
  for (const hunk of file.hunks) {
    let line = hunk.newStart
    for (const entry of hunk.lines) {
      if (entry.kind === '+') {
        out.add(line)
        line += 1
      } else if (entry.kind === ' ') {
        line += 1
      }
    }
  }
  return out
}

/** Split on `\n`, dropping a trailing empty element from a final newline. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Parse the two paths of a `diff --git a/x b/y` header. */
function parseDiffGitPaths(rest: string): { old: string; new: string } | null {
  const tokens = takePathTokens(rest, 2)
  if (tokens.length < 2) return null
  return { old: stripPrefix(tokens[0] as string), new: stripPrefix(tokens[1] as string) }
}

/**
 * Read up to `count` path tokens, honoring the quoting git applies when a path
 * holds a space, a quote, or a non-ASCII byte.
 */
function takePathTokens(rest: string, count: number): string[] {
  const out: string[] = []
  let index = 0
  while (out.length < count && index < rest.length) {
    while (rest[index] === ' ') index += 1
    if (index >= rest.length) break
    if (rest[index] === '"') {
      const parsed = readQuoted(rest, index)
      out.push(parsed.value)
      index = parsed.next
      continue
    }
    const space = rest.indexOf(' ', index)
    if (space === -1) {
      out.push(rest.slice(index))
      break
    }
    out.push(rest.slice(index, space))
    index = space
  }
  return out
}

/** Read one quoted path starting at `start`, returning the value and next index. */
function readQuoted(text: string, start: number): { value: string; next: number } {
  const out = new QuotedBytes()
  let index = start + 1
  while (index < text.length) {
    const char = text[index] as string
    if (char === '\\' && index + 1 < text.length) {
      const escaped = text[index + 1]
      if (isOctalDigit(escaped)) {
        // One to three octal digits: git writes three for a byte, but a decoder
        // that demanded three would misread a shorter run as text.
        const octal = /^[0-7]{1,3}/u.exec(text.slice(index + 1))?.[0] ?? (escaped as string)
        out.byte(Number.parseInt(octal, 8))
        index += 1 + octal.length
        continue
      }
      out.escape(escaped as string)
      index += 2
      continue
    }
    if (char === '"') return { value: out.value(), next: index + 1 }
    out.literal(char)
    index += 1
  }
  return { value: out.value(), next: text.length }
}

/** Decode one C-style escape from a quoted git path. */
function decodeEscape(char: string): string {
  switch (char) {
    case 'n': return '\n'
    case 't': return '\t'
    case 'r': return '\r'
    case '"': return '"'
    case '\\': return '\\'
    default: return char
  }
}

/** Whether a character is the first digit of a git octal byte escape. */
function isOctalDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '7'
}

/**
 * The bytes git writes for a non-ASCII path, assembled back into text.
 *
 * Quoting is per **byte**, not per character: `café.ts` arrives as
 * `"caf\303\251.ts"`, and a Chinese path as one three-byte escape per character.
 * Decoding each escape on its own therefore produces digits (`caf303251.ts`) — a
 * path that matches no file, no rule pattern and no diff entry, in a repository
 * whose filenames are not ASCII. The bytes are collected first and decoded once,
 * which is the only point at which the character exists.
 */
class QuotedBytes {
  private text = ''
  private bytes: number[] = []

  /** Append one literal character, after any pending byte run. */
  literal(char: string): void {
    this.flush()
    this.text += char
  }

  /** Append one decoded C escape, after any pending byte run. */
  escape(char: string): void {
    this.flush()
    this.text += decodeEscape(char)
  }

  /** Append one octal byte, which may be the first of several in a character. */
  byte(value: number): void {
    this.bytes.push(value & 0xff)
  }

  value(): string {
    this.flush()
    return this.text
  }

  private flush(): void {
    if (this.bytes.length === 0) return
    this.text += Buffer.from(this.bytes).toString('utf8')
    this.bytes = []
  }
}

/** Parse a `---`/`+++` marker path, where `/dev/null` means the side is absent. */
function parseDiffMarkerPath(rest: string): string | null {
  const token = takePathTokens(rest.split('\t')[0] ?? rest, 1)[0]
  if (token === undefined) return null
  if (token === '/dev/null') return null
  return stripPrefix(token)
}

/** Parse a bare path that may be quoted. */
export function parseQuotedPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"')) return readQuoted(trimmed, 0).value
  return trimmed
}

/** Drop git's `a/` or `b/` side prefix, which is not part of the path. */
function stripPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}
