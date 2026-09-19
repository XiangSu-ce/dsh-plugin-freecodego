/**
 * Format-native reversible lossless compaction — TypeScript port of Headroom's
 * `headroom/transforms/lossless_compaction.py`, © Headroom Maintainers,
 * Apache-2.0.
 *
 * Every transform is reversible: the expansion side is verified by
 * round-tripping the candidate back to the original before it is accepted, and
 * only strictly smaller candidates win. No CCR markers are emitted — the model
 * reconstructs repeated content from the `... (repeated N times)` markers
 * alone.
 *
 * Folds: ANSI strip + repeated-line collapse (log), ripgrep file-heading +
 * directory-heading + path-listing heading (search/paths), `index` line strip
 * (diff), blank-run collapse (text), and repeated-block folding (config).
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/lossless-compaction
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g
const RUN_MARKER_RE = /^(.*) \.\.\. \(repeated (\d+) times\)$/
const BLOCK_MARKER_RE = /^\.\.\. \(repeats (\d+) lines from (\d+) lines back\)$/

/** grep/ripgrep row: `path:line:content` (path must not start with a bare number). */
const GREP_ROW_RE = /^([^\n:]+):(\d+):(.*)$/
/** heading-form data row produced by searchHeading: `line:content`. */
const HEADING_ROW_RE = /^(\d+):(.*)$/
/** A timestamped log line shares the colon shape — never fold it as grep. */
const TIMESTAMP_ROW_RE = /^\s*\[?(?:\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}|\d{2}\/\d{2}\/\d{2,4}[ T]\d{1,2}:\d{2}|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}|\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s|\]|$))/
/** dir-heading data row: `<base>:<line>:<content>` where base has no `/`. */
const DIR_DATA_RE = /^([^/\n:]+):(\d+):(.*)$/
/** Whole-line file path: ≥1 directory segment + basename (no whitespace/colon). */
const PATH_ROW_RE = /^((?:\.{0,2}\/)?(?:[^/\s:]+\/)+)([^/\s:]+)$/
/** unified-diff `index <sha>..<sha> [mode]` bookkeeping line. */
const DIFF_INDEX_RE = /^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+(?: [0-7]+)?$/

/** Split into lines, remembering whether a trailing newline was present. */
function splitKeepTrailing(text: string): { readonly lines: readonly string[]; readonly hadTrailing: boolean } {
  if (text === '') return { lines: [], hadTrailing: false }
  const hadTrailing = text.endsWith('\n')
  const body = hadTrailing ? text.slice(0, -1) : text
  return { lines: body.split('\n'), hadTrailing }
}

function join(lines: readonly string[], hadTrailing: boolean): string {
  let out = lines.join('\n')
  if (hadTrailing) out += '\n'
  return out
}

/** Strip ANSI color escapes (non-semantic bytes; one-way). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

function expandRuns(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = RUN_MARKER_RE.exec(line)
    if (m !== null && m[1] !== undefined && m[2] !== undefined) {
      const count = Math.max(1, Number(m[2]))
      for (let i = 0; i < count; i += 1) out.push(m[1])
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

function collapseRuns(text: string): string | undefined {
  const lines = text.split('\n')
  const out: string[] = []
  let run: string[] = []
  let changed = false
  const flush = (): void => {
    if (run.length === 0) return
    const first = run[0]!
    if (run.length >= 2) {
      out.push(`${first} ... (repeated ${run.length} times)`)
      changed = true
    } else {
      out.push(first)
    }
    run = []
  }
  for (const line of lines) {
    if (run.length === 0 || run[0] === line) run.push(line)
    else {
      flush()
      run = [line]
    }
  }
  flush()
  return changed ? out.join('\n') : undefined
}

/**
 * Collapse a run of ≥2 empty lines into one repeated-line marker (text fold).
 *
 * Writing the marker is what makes this reversible, and reversibility is the
 * only thing {@link compactLossless} accepts: `expandRuns` rebuilds an empty
 * repeated line exactly. The earlier shape deleted the surplus lines instead,
 * which discarded the count — the one fact the round-trip check compares — so
 * every candidate failed that check and this fold could never apply to any
 * input at all, while the header still advertised it as one of the folds.
 *
 * Only truly empty lines take part. The marker rebuilds an *empty* line, so a
 * whitespace-only line could not be restored from one and stays content; the
 * size gate below then declines the fold unless the marker is genuinely worth
 * its own bytes, which a short run of blank lines is not.
 */
function collapseBlankRuns(text: string): string | undefined {
  const lines = text.split('\n')
  const out: string[] = []
  let blankRun = 0
  let changed = false
  const flush = (): void => {
    if (blankRun === 0) return
    if (blankRun === 1) out.push('')
    else {
      out.push(` ... (repeated ${blankRun} times)`)
      changed = true
    }
    blankRun = 0
  }
  for (const line of lines) {
    if (line === '') {
      blankRun += 1
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return changed ? out.join('\n') : undefined
}

const FOLD_MIN_BLOCK = 3
const FOLD_MAX_BLOCK = 64
const FOLD_MAX_CANDIDATES = 8
const FOLD_MAX_LINES = 20_000

function foldRepeatedBlocks(text: string): string | undefined {
  const lines = text.split('\n')
  if (lines.length > FOLD_MAX_LINES) return undefined
  const out: string[] = []
  /** Last positions where each line value occurred in `out`. */
  const recent = new Map<string, number[]>()
  /** Unfolded line count before each `out` entry was emitted, parallel to `out`.
   * A marker must record its span as a distance in *unfolded* space, because
   * `unfoldRepeatedBlocks` counts the lines it has already rebuilt — which is
   * larger than `out.length` once an earlier marker has expanded. Using the
   * folded distance would mis-target every fold after the first. */
  const unfoldedAt: number[] = []
  let emitted = 0
  let i = 0
  let changed = false
  while (i < lines.length) {
    let folded = false
    for (let k = Math.min(FOLD_MAX_BLOCK, lines.length - i); k >= FOLD_MIN_BLOCK; k -= 1) {
      const block = lines.slice(i, i + k)
      const blockHead = block[0]
      if (blockHead === undefined) continue
      const candidates = recent.get(blockHead)
      if (candidates === undefined) continue
      for (const anchor of candidates) {
        // `anchor` is the index in `out` where this block head was emitted; the
        // marker records how far back that span starts in unfolded coordinates.
        const d = emitted - (unfoldedAt[anchor] ?? 0)
        if (k > d) continue
        let match = true
        for (let j = 0; j < k; j += 1) {
          if (out[anchor + j] !== block[j]) {
            match = false
            break
          }
        }
        if (!match) continue
        changed = true
        out.push(`... (repeats ${k} lines from ${d} lines back)`)
        unfoldedAt.push(emitted)
        emitted += k
        i += k
        folded = true
        break
      }
      if (folded) break
    }
    if (!folded) {
      const line = lines[i]
      if (line === undefined) break
      const positions = recent.get(line) ?? []
      if (positions.length >= FOLD_MAX_CANDIDATES) positions.shift()
      positions.push(out.length)
      recent.set(line, positions)
      out.push(line)
      unfoldedAt.push(emitted)
      emitted += 1
      i += 1
    }
  }
  return changed ? out.join('\n') : undefined
}

function unfoldRepeatedBlocks(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = BLOCK_MARKER_RE.exec(line)
    if (m !== null && m[1] !== undefined && m[2] !== undefined) {
      const k = Number(m[1])
      const d = Number(m[2])
      const start = out.length - d
      if (start >= 0 && k <= d) {
        for (let j = 0; j < k; j += 1) out.push(out[start + j]!)
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

// ─── Search folds (reversible, round-trip verified) ─────────────────────────

/** Convert grep `path:line:content` rows into ripgrep --heading form. */
export function searchHeading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text)
  if (lines.length === 0) return text
  const out: string[] = []
  let currentPath: string | undefined
  for (const line of lines) {
    const m = TIMESTAMP_ROW_RE.test(line) ? null : GREP_ROW_RE.exec(line)
    if (m !== null) {
      const path = m[1]!
      if (path !== currentPath) {
        out.push(path)
        currentPath = path
      }
      out.push(`${m[2]}:${m[3]}`)
    } else {
      out.push(line)
      currentPath = undefined
    }
  }
  return join(out, hadTrailing)
}

/** Exact inverse of searchHeading. */
export function searchUnheading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text)
  if (lines.length === 0) return text
  const out: string[] = []
  let currentPath: string | undefined
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const data = HEADING_ROW_RE.exec(line)
    if (currentPath !== undefined && data !== null) {
      out.push(`${currentPath}:${data[1]}:${data[2]}`)
      i += 1
      continue
    }
    const next = lines[i + 1]
    if (data === null && next !== undefined && HEADING_ROW_RE.test(next)) {
      currentPath = line
      i += 1
      continue
    }
    currentPath = undefined
    out.push(line)
    i += 1
  }
  return join(out, hadTrailing)
}

/** Fold grep rows by DIRECTORY (the `grep -rn` case where each file has one match). */
export function searchDirHeading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text)
  if (lines.length === 0) return text
  const out: string[] = []
  let currentDir: string | undefined
  for (const line of lines) {
    const m = TIMESTAMP_ROW_RE.test(line) ? null : GREP_ROW_RE.exec(line)
    if (m !== null && m[1]!.includes('/')) {
      const path = m[1]!
      const cut = path.lastIndexOf('/') + 1
      const dirPart = path.slice(0, cut)
      const base = path.slice(cut)
      if (dirPart !== currentDir) {
        out.push(dirPart)
        currentDir = dirPart
      }
      out.push(`${base}:${m[2]}:${m[3]}`)
    } else {
      out.push(line)
      currentDir = undefined
    }
  }
  return join(out, hadTrailing)
}

/** Exact inverse of searchDirHeading. */
export function searchDirUnheading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text)
  if (lines.length === 0) return text
  const out: string[] = []
  let currentDir: string | undefined
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const data = DIR_DATA_RE.exec(line)
    if (currentDir !== undefined && data !== null) {
      out.push(`${currentDir}${line}`)
      i += 1
      continue
    }
    const next = lines[i + 1]
    if (line.endsWith('/') && next !== undefined && DIR_DATA_RE.test(next)) {
      currentDir = line
      i += 1
      continue
    }
    currentDir = undefined
    out.push(line)
    i += 1
  }
  return join(out, hadTrailing)
}

/** Fold a pure file-path listing (`find`/`ls -1`/`rg -l`) into dir-heading form. */
export function pathHeading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text)
  if (lines.filter(line => PATH_ROW_RE.test(line)).length < 2) return text
  const out: string[] = []
  let current: string | undefined
  for (const line of lines) {
    const m = PATH_ROW_RE.exec(line)
    if (m !== null) {
      const dir = m[1]!
      if (dir !== current) {
        out.push(dir)
        current = dir
      }
      out.push(m[2]!)
    } else {
      out.push(line)
      current = undefined
    }
  }
  return join(out, hadTrailing)
}

/** Exact inverse of pathHeading. */
export function pathUnheading(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text)
  if (lines.length === 0) return text
  const out: string[] = []
  let current: string | undefined
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const isBase = line !== '' && !line.includes('/')
    if (current !== undefined && isBase) {
      out.push(`${current}${line}`)
      i += 1
      continue
    }
    const next = lines[i + 1]
    if (line.endsWith('/') && next !== undefined && next !== '' && !next.includes('/')) {
      current = line
      i += 1
      continue
    }
    current = undefined
    out.push(line)
    i += 1
  }
  return join(out, hadTrailing)
}

/** Drop `index <sha>..<sha>` bookkeeping lines from a unified diff (still applies). */
export function diffStripIndex(text: string): string {
  const { lines, hadTrailing } = splitKeepTrailing(text)
  if (lines.length === 0) return text
  return join(lines.filter(line => !DIFF_INDEX_RE.test(line)), hadTrailing)
}

function smaller(candidate: string, original: string): boolean {
  return candidate.length < original.length
}

export interface LosslessResult {
  /** Compacted text, or the original when nothing applied. */
  readonly output: string
  readonly applied: boolean
}

function accept(baseline: string, candidate: string | undefined, withBlocks: boolean): LosslessResult {
  if (candidate === undefined || candidate.length >= baseline.length) return { output: baseline, applied: false }
  // Blocks were folded over run-collapsed coordinates: unfold blocks first,
  // then expand runs back to the baseline.
  const inverse = withBlocks ? expandRuns(unfoldRepeatedBlocks(candidate)) : expandRuns(candidate)
  if (inverse !== baseline) return { output: baseline, applied: false }
  return { output: candidate, applied: true }
}

/**
 * Dispatch format-native lossless compaction by `kind`. For reversible kinds
 * the round-trip is verified internally (modulo the intentionally-dropped
 * non-semantic bits, e.g. ANSI color for logs); if verification fails or the
 * result is not smaller, the original content is returned unchanged. Never
 * throws; unknown kinds pass through.
 */
export function compactLossless(text: string, kind: 'log' | 'search' | 'paths' | 'diff' | 'text' | 'config'): LosslessResult {
  if (text === '') return { output: text, applied: false }
  try {
    if (kind === 'log') {
      // ANSI is non-semantic and dropped one-way; run-collapse must be
      // exactly reversible against the de-ANSI'd baseline.
      const baseline = stripAnsi(text)
      if (baseline === text) return { output: text, applied: false }
      const candidate = collapseRuns(baseline)
      return accept(baseline, candidate, false)
    }

    if (kind === 'search') {
      // Two independent folds; keep the smaller that round-trips exactly.
      // searchHeading factors a repeated FILE; searchDirHeading factors a
      // repeated DIRECTORY (the `grep -rn` case the file fold misses).
      let best = text
      for (const [candidate, inverse] of [
        [searchHeading(text), searchUnheading],
        [searchDirHeading(text), searchDirUnheading],
      ] as const) {
        if (inverse(candidate) === text && smaller(candidate, best)) best = candidate
      }
      return best === text ? { output: text, applied: false } : { output: best, applied: true }
    }

    if (kind === 'paths') {
      const candidate = pathHeading(text)
      if (pathUnheading(candidate) !== text) return { output: text, applied: false }
      return smaller(candidate, text) ? { output: candidate, applied: true } : { output: text, applied: false }
    }

    if (kind === 'diff') {
      // Purely subtractive of non-semantic bookkeeping lines; the
      // remaining hunks still apply. No exact inverse needed.
      const candidate = diffStripIndex(text)
      return smaller(candidate, text) ? { output: candidate, applied: true } : { output: text, applied: false }
    }

    if (kind === 'text') {
      // Collapse blank-line runs; reversible against itself.
      const candidate = collapseBlankRuns(text)
      if (candidate === undefined || expandRuns(candidate) !== text) return { output: text, applied: false }
      return smaller(candidate, text) ? { output: candidate, applied: true } : { output: text, applied: false }
    }

    if (kind === 'config') {
      // Structured config: single-line runs first, then repeated stanzas. Each
      // fold is kept only when its own inverse rebuilds its own input, so a
      // stanza fold that finds nothing cannot discard a run fold that worked.
      const runCollapsed = collapseRuns(text)
      const runFolded = runCollapsed !== undefined && expandRuns(runCollapsed) === text ? runCollapsed : undefined
      const blockFolded = foldRepeatedBlocks(runFolded ?? text)
      const candidate = blockFolded ?? runFolded
      if (candidate === undefined || !smaller(candidate, text)) return { output: text, applied: false }
      // Prove the accepted candidate rebuilds the original before returning it.
      if (expandRuns(unfoldRepeatedBlocks(candidate)) !== text) return { output: text, applied: false }
      return { output: candidate, applied: true }
    }
  } catch {
    return { output: text, applied: false }
  }
  return { output: text, applied: false }
}
