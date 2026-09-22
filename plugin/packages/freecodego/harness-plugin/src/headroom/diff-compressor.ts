/**
 * Unidiff compressor — TypeScript port of Headroom's
 * `crates/headroom-core/src/transforms/diff_compressor.rs`, © Headroom
 * Maintainers, Apache-2.0.
 *
 * Compresses `git diff` / `diff -u` output: files capped by change volume,
 * hunks capped to first/last/top-scored with context trimmed to ±2 lines,
 * the `\ No newline` marker always retained, and a summary footer describing
 * what was omitted. The full diff is stored in CCR when the savings are real.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/diff-compressor
 */

import type { CcrStore } from './ccr.ts'
import { computeKey } from './ccr.ts'

/**
 * Tunables for unified-diff compaction: when to engage, how many files and
 * hunks survive, how much context each keeps, and the ratio to beat.
 */
export interface DiffCompressorConfig {
  /** Minimum total lines before compression is attempted. */
  minLines: number
  /** Maximum files rendered. */
  maxFiles: number
  /** Maximum hunks rendered per file. */
  maxHunksPerFile: number
  /** Context lines kept around the hunk head. */
  contextRadius: number
  /** Accept only when the rendering is below this ratio of the original. */
  maxRatio: number
}

/** Default diff-compressor tunables. */
export const DIFF_COMPRESSOR_DEFAULTS: DiffCompressorConfig = {
  minLines: 50,
  maxFiles: 20,
  maxHunksPerFile: 10,
  contextRadius: 2,
  maxRatio: 0.8,
}

interface DiffLine {
  readonly text: string
  readonly kind: 'context' | 'add' | 'remove' | 'meta'
}

interface Hunk {
  readonly header: string
  readonly lines: DiffLine[]
  /** Score: added/removed content outweighs context. */
  score: number
}

interface FileDiff {
  /** The section's header lines: `diff --git …`, `Index: …`, and/or `--- `/`+++ `. */
  header: string
  readonly hunks: Hunk[]
  changeCount: number
}

/** Hunk scoring: added/removed lines count; metadata never scores. */
function scoreHunk(hunk: Hunk): number {
  let score = 0
  for (const line of hunk.lines) {
    if (line.kind === 'add' || line.kind === 'remove') score += 1
  }
  return score
}

/**
 * Split a unified diff into file sections.
 *
 * A section starts at a `diff --git` line, an svn `Index:` line, or a `--- `
 * line that is immediately followed by `+++ `. The lookahead is what makes the
 * last case decidable, and it is the whole point of this function's shape:
 *
 * - A `--- ` line **inside** a hunk is a removal whose text happens to begin
 *   with `--`, and it is never followed by a `+++ ` line.
 * - Every real unified-diff file header **is** such a pair.
 *
 * The previous condition was `diff --git || (--- && currentFile === undefined)
 * || Index:`, which — through `&&` binding tighter than `||` — let only the
 * *first* `--- ` open a section. Plain `diff -u` output (git prints a
 * `diff --git` line, `diff -u` does not) therefore collapsed every file into
 * one section whose header named only the first, and each later file's
 * boundary was parsed as a removal/addition pair. Both halves were visible:
 * the first file's `+++ ` line was dropped outright, so the compressed diff was
 * not a valid unified diff at all, and the phantom boundary pair added 2 to
 * every later file's `changeCount`, which is the number `maxFiles` selects by.
 *
 * The header keeps both lines so the pair survives compression; the `+++ ` half
 * is consumed here rather than re-read as a hunk line.
 *
 * @param text - the diff's text.
 * @returns one entry per file section, in document order.
 */
function parseDiff(text: string): readonly FileDiff[] {
  const files: FileDiff[] = []
  let currentFile: FileDiff | undefined
  let currentHunk: Hunk | undefined
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!
    const next = lines[index + 1]
    if (raw.startsWith('diff --git ') || raw.startsWith('Index: ')) {
      currentFile = { header: raw, hunks: [], changeCount: 0 }
      files.push(currentFile)
      currentHunk = undefined
      continue
    }
    if (raw.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      const carriesOwnPair = currentFile !== undefined && currentFile.header.includes('\n+++ ')
      // `diff --git` prints its own `--- `/`+++ ` pair on the next lines, so a
      // section with no hunks yet is that header, not a second file.
      if (currentFile === undefined || carriesOwnPair || currentFile.hunks.length > 0) {
        currentFile = { header: `${raw}\n${next}`, hunks: [], changeCount: 0 }
        files.push(currentFile)
      } else {
        currentFile.header = `${currentFile.header}\n${raw}\n${next}`
      }
      currentHunk = undefined
      index += 1
      continue
    }
    if (currentFile === undefined) continue
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(raw) || /^@@@/u.test(raw)) {
      currentHunk = { header: raw, lines: [], score: 0 }
      currentFile.hunks.push(currentHunk)
      continue
    }
    if (currentHunk === undefined) continue
    if (raw.startsWith('+')) currentHunk.lines.push({ text: raw, kind: 'add' })
    else if (raw.startsWith('-')) currentHunk.lines.push({ text: raw, kind: 'remove' })
    else if (raw.startsWith(' ') || raw.startsWith('\t')) currentHunk.lines.push({ text: raw, kind: 'context' })
    else if (raw.startsWith('\\')) currentHunk.lines.push({ text: raw, kind: 'meta' })
    else currentHunk.lines.push({ text: raw, kind: 'context' })
  }
  for (const file of files) {
    for (const hunk of file.hunks) hunk.score = scoreHunk(hunk)
    file.changeCount = file.hunks.reduce((total, hunk) => total + hunk.score, 0)
  }
  return files
}

/** Trim a hunk's context lines down to a radius around non-context lines. */
function trimContext(hunk: Hunk, radius: number): readonly DiffLine[] {
  const keep = new Set<number>()
  for (const [i, line] of hunk.lines.entries()) {
    if (line.kind === 'context') continue
    for (let j = Math.max(0, i - radius); j <= Math.min(hunk.lines.length - 1, i + radius); j += 1) keep.add(j)
  }
  const out: DiffLine[] = []
  let omittedRun = 0
  for (const [i, line] of hunk.lines.entries()) {
    if (keep.has(i) || line.kind === 'meta') {
      if (omittedRun > 0) {
        out.push({ text: ` [... ${omittedRun} context lines omitted]`, kind: 'meta' })
        omittedRun = 0
      }
      out.push(line)
    } else {
      omittedRun += 1
    }
  }
  if (omittedRun > 0) out.push({ text: ` [... ${omittedRun} context lines omitted]`, kind: 'meta' })
  return out
}

/**
 * Outcome of one diff compaction: the rendering, whether it was adopted, and
 * the CCR key when the dropped hunks were stashed.
 */
export interface DiffCompressionResult {
  readonly compressed: string
  readonly applied: boolean
  readonly cacheKey: string | undefined
}

/** Compress one unified diff; `applied: false` for short or non-diff text.
 * `bias` > 1 keeps more hunks (conservative), < 1 fewer (aggressive).
 * @param text - the text to process.
 * @param cfg - the diff-compressor settings to apply.
 * @param store - the store to read, when one is mounted.
 * @param bias - multiplier on the file and hunk budgets (>1 keeps more).
 * @returns the diff compaction result.
 */
export function compressDiff(text: string, cfg: DiffCompressorConfig, store: CcrStore | undefined, bias = 1.0): DiffCompressionResult {
  const totalLines = text.split('\n').length
  if (totalLines < cfg.minLines || !looksLikeDiffOutput(text)) {
    return { compressed: text, applied: false, cacheKey: undefined }
  }
  const files = [...parseDiff(text)]
  if (files.length === 0) return { compressed: text, applied: false, cacheKey: undefined }
  const effectiveMaxFiles = Math.max(1, Math.round(cfg.maxFiles * bias))
  const effectiveMaxHunks = Math.max(1, Math.round(cfg.maxHunksPerFile * bias))

  // File cap: keep the files with the largest change volume, preserving order.
  const ordered = files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => b.file.changeCount - a.file.changeCount || a.index - b.index)
  const omittedFiles = Math.max(0, files.length - effectiveMaxFiles)
  const keptFiles = ordered.slice(0, effectiveMaxFiles).sort((a, b) => a.index - b.index)

  const outputLines: string[] = []
  let omittedHunks = 0
  let added = 0
  let removed = 0
  for (const { file } of keptFiles) {
    outputLines.push(file.header)
    const hunks = [...file.hunks]
    if (hunks.length > effectiveMaxHunks) {
      omittedHunks += hunks.length - effectiveMaxHunks
      // Keep the first and last hunk for the file's shape, then fill the
      // remaining budget with the highest-scored hunks, emitted in file order.
      const selected = new Set<number>()
      for (const index of [0, hunks.length - 1]) {
        if (selected.size >= effectiveMaxHunks) break
        selected.add(index)
      }
      const byScore = hunks.map((hunk, index) => ({ hunk, index })).sort((a, b) => b.hunk.score - a.hunk.score || a.index - b.index)
      for (const { index } of byScore) {
        if (selected.size >= effectiveMaxHunks) break
        selected.add(index)
      }
      for (const [index, hunk] of hunks.entries()) {
        if (!selected.has(index)) continue
        outputLines.push(hunk.header, ...trimContext(hunk, cfg.contextRadius).map(line => line.text))
        for (const line of hunk.lines) {
          if (line.kind === 'add') added += 1
          else if (line.kind === 'remove') removed += 1
        }
      }
      continue
    }
    for (const hunk of hunks) {
      outputLines.push(hunk.header, ...trimContext(hunk, cfg.contextRadius).map(line => line.text))
      for (const line of hunk.lines) {
        if (line.kind === 'add') added += 1
        else if (line.kind === 'remove') removed += 1
      }
    }
  }

  const footer: string[] = []
  if (omittedFiles > 0 || omittedHunks > 0) {
    footer.push(`[... ${omittedFiles} file(s) and ${omittedHunks} hunk(s) omitted, +${added} -${removed} lines shown]`)
  }

  let compressed = outputLines.join('\n')
  if (footer.length > 0) compressed += `\n${footer.join('\n')}`
  const ratio = Buffer.byteLength(compressed, 'utf8') / Math.max(1, Buffer.byteLength(text, 'utf8'))
  if (ratio >= cfg.maxRatio) return { compressed: text, applied: false, cacheKey: undefined }

  // The same one-gate rule as the search compressor (see the comment there): the
  // entry gate already required `totalLines >= cfg.minLines`, so a second
  // `minLinesForCcr` threshold answered a question that was settled before this
  // line ran. Keeping the two equal was the only thing making the delivered
  // rendering retrievable, which is a coincidence rather than a contract, and the
  // one shape of drift it allows is F-25's — an adopted rendering with no marker.
  let cacheKey: string | undefined
  if (store !== undefined) {
    const key = computeKey(text)
    // This rendering dropped hunks, so it may ship only with its original stored:
    // a refused write (`StagedCcrStore.put`, an attempt with no room left) means a
    // diff that cannot be recovered, so the whole rendering is declined — which is
    // the shape every caller here already handles.
    if (store.put(key, text) !== true) return { compressed: text, applied: false, cacheKey: undefined }
    cacheKey = key
    compressed += `\n[${totalLines} diff lines compressed to ${compressed.split('\n').length}. Retrieve full diff: hash=${cacheKey}]`
  }
  return { compressed, applied: true, cacheKey }
}

/**
 * Whether the text is a unified diff (git/diff -u style).
 * @param text - the text to test.
 * @returns true when the text carries unified-diff headers.
 */
export function looksLikeDiffOutput(text: string): boolean {
  return /^diff --git /mu.test(text) || /^--- .*\n\+\+\+ /mu.test(text)
}
