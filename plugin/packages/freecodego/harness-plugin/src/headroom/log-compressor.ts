/**
 * Log/build-output compressor — TypeScript port of Headroom's
 * `crates/headroom-core/src/transforms/log_compressor.rs` (itself a Rust
 * port of `headroom.transforms.log_compressor`), © Headroom Maintainers,
 * Apache-2.0.
 *
 * Compresses build and test output (pytest, npm, cargo, jest, make, generic).
 * Typical input: 10,000+ lines with 5-10 actual errors; typical compression
 * 10-50×. ERROR/FATAL lines, stack traces, deduped warnings, and summary
 * lines survive; the rest collapse into a one-line omission summary. When the
 * ratio is good enough the original is stored in CCR and a retrieve marker is
 * appended.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/log-compressor
 */

import type { CcrStore } from './ccr.ts'
import { computeKey } from './ccr.ts'
import { computeOptimalK } from './adaptive-sizer.ts'

export type LogLevel = 'error' | 'fail' | 'warn' | 'info' | 'debug' | 'trace' | 'unknown'
export type LogFormat = 'pytest' | 'npm' | 'cargo' | 'jest' | 'make' | 'generic'

export interface LogCompressorConfig {
  maxErrors: number
  errorContextLines: number
  keepFirstError: boolean
  keepLastError: boolean
  maxStackTraces: number
  stackTraceMaxLines: number
  maxWarnings: number
  dedupeWarnings: boolean
  keepSummaryLines: boolean
  maxTotalLines: number
  enableCcr: boolean
  minLinesForCcr: number
  collapseRuntimeFrames: boolean
  traceHeadFrames: number
  traceAppFrames: number
}

export const LOG_COMPRESSOR_DEFAULTS: LogCompressorConfig = {
  maxErrors: 10,
  errorContextLines: 3,
  keepFirstError: true,
  keepLastError: true,
  maxStackTraces: 3,
  stackTraceMaxLines: 20,
  maxWarnings: 5,
  dedupeWarnings: true,
  keepSummaryLines: true,
  maxTotalLines: 100,
  enableCcr: true,
  minLinesForCcr: 50,
  collapseRuntimeFrames: true,
  traceHeadFrames: 3,
  traceAppFrames: 5,
}

interface LogLine {
  readonly lineNumber: number
  readonly content: string
  level: LogLevel
  isStackTrace: boolean
  isSummary: boolean
  score: number
}

export interface LogCompressionResult {
  readonly compressed: string
  readonly originalLineCount: number
  readonly compressedLineCount: number
  readonly formatDetected: LogFormat
  readonly compressionRatio: number
  readonly cacheKey: string | undefined
  readonly stats: Record<string, number>
}

// ─── Format detection (first 100 lines, most marker hits wins) ────────────

const FORMAT_MARKERS: readonly (readonly [LogFormat, readonly string[]])[] = [
  ['pytest', ['=== FAILURES', '=== ERRORS', '=== test session', '=== short test summary', 'PASSED [', 'FAILED [', 'ERROR [', 'SKIPPED [', 'collected ']],
  ['npm', ['npm ERR!', 'npm WARN', 'npm info', 'npm http']],
  ['cargo', ['Compiling ', 'Finished ', 'Running ', 'warning: ', 'error[E']],
  ['jest', ['PASS ', 'FAIL ', 'Test Suites:']],
  ['make', ['make[', 'make:', 'gcc ', 'g++ ', 'clang ']],
]

function detectFormat(lines: readonly string[]): LogFormat {
  const sample = lines.slice(0, 100)
  let best: LogFormat | undefined
  let bestScore = 0
  for (const [format, markers] of FORMAT_MARKERS) {
    let score = 0
    for (const line of sample) {
      // At most one hit per line, mirroring the Rust detector.
      if (markers.some(marker => line.includes(marker))) score += 1
    }
    if (score > 0 && score > bestScore) {
      best = format
      bestScore = score
    }
  }
  return best ?? 'generic'
}

// ─── Level classification (word-boundary aware, longest match wins) ───────

const LEVEL_WORDS: readonly (readonly [LogLevel, readonly string[]])[] = [
  ['error', ['ERROR', 'error', 'Error', 'FATAL', 'fatal', 'Fatal', 'CRITICAL', 'critical']],
  ['fail', ['FAIL', 'FAILED', 'fail', 'failed', 'Fail', 'Failed']],
  ['warn', ['WARN', 'WARNING', 'warn', 'warning', 'Warn', 'Warning']],
  ['info', ['INFO', 'info', 'Info']],
  ['debug', ['DEBUG', 'debug', 'Debug']],
  ['trace', ['TRACE', 'trace', 'Trace']],
]

// One alternation regex per level replaces the per-line per-word startsWith
// scan (the Rust original precompiles an aho-corasick automaton; a single
// regex exec over each line is the closest cheap equivalent in JS). Words are
// sorted longest-first within each alternation so "warning" wins over "warn";
// the boundary check keeps "errorid" from matching. Level order matters:
// first match wins, mirroring the original's ERROR-before-FAIL priority.
const LEVEL_MATCHERS: readonly { readonly regex: RegExp; readonly level: LogLevel }[] = LEVEL_WORDS.map(([level, words]) => {
  const pattern = [...words].sort((a, b) => b.length - a.length).join('|')
  return { regex: new RegExp(`(?:${pattern})`, 'g'), level }
})

function isWordByte(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x5f
}

function classifyLevel(line: string): LogLevel {
  for (const matcher of LEVEL_MATCHERS) {
    matcher.regex.lastIndex = 0
    let match = matcher.regex.exec(line)
    while (match !== null) {
      // Boundary check on UTF-16 code units, matching the regex indices.
      const start = match.index
      const end = start + match[0].length
      const leftOk = start === 0 || !isWordByte(line.charCodeAt(start - 1))
      const rightOk = end >= line.length || !isWordByte(line.charCodeAt(end))
      if (leftOk && rightOk) {
        matcher.regex.lastIndex = 0
        return matcher.level
      }
      match = matcher.regex.exec(line)
    }
  }
  return 'unknown'
}

// ─── Stack-trace detection (per-language flavor state machine) ────────────

type TraceFlavor = 'python' | 'js' | 'java' | 'rust-error' | 'rust-backtrace' | 'go-panic' | 'dotnet'

function hasLineColSuffix(s: string): boolean {
  return /:\d+:\d+/.test(s)
}

function isPythonFileFrame(s: string): boolean {
  return s.startsWith('File "') && s.includes('", line ') && /\d$/u.test(s)
}

function isJsAtFrame(s: string): boolean {
  return s.startsWith('at ') && s.includes('(') && s.includes(')') && hasLineColSuffix(s)
}

function isJavaAtFrame(s: string): boolean {
  if (!s.startsWith('at ') || !s.includes('(')) return false
  const body = s.slice(3, s.indexOf('('))
  return body.length > 0 && /^[A-Za-z0-9._$/]+$/.test(body)
}

function isDotnetFrame(s: string): boolean {
  return s.startsWith('at ') && s.includes(') in ') && s.includes(':line ')
}

function isDotnetOpener(s: string): boolean {
  return s.startsWith('Unhandled exception.') || isDotnetFrame(s)
}

function isRustBacktraceFrame(s: string): boolean {
  return /^\d+:\s+0x[0-9a-fA-F]+/u.test(s.trimStart())
}

function isGoroutineHeader(line: string): boolean {
  if (!line.startsWith('goroutine ')) return false
  const rest = line.slice('goroutine '.length)
  const digits = rest.match(/^\d+/u)?.[0]?.length ?? 0
  return digits > 0 && rest.slice(digits).startsWith(' [')
}

function isGoFileFrame(line: string): boolean {
  if (!line.startsWith('\t')) return false
  const rest = line.slice(1)
  return rest.includes('.go:') && rest.includes(' +0x')
}

function isGoCallFrame(line: string): boolean {
  if (line.startsWith('created by ')) return true
  if (line.startsWith(' ') || line.startsWith('\t') || !line.endsWith(')')) return false
  const open = line.indexOf('(')
  if (open < 0) return false
  const symbol = line.slice(0, open)
  return symbol.length > 0 && symbol.includes('.') && /^[A-Za-z0-9._/*]+$/.test(symbol)
}

function flavorFor(line: string): TraceFlavor | undefined {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('Traceback (most recent call last)') || isPythonFileFrame(trimmed)) return 'python'
  if (isDotnetOpener(trimmed)) return 'dotnet'
  if (isJsAtFrame(trimmed)) return 'js'
  if (isJavaAtFrame(trimmed)) return 'java'
  if (trimmed.startsWith('--> ') && hasLineColSuffix(trimmed)) return 'rust-error'
  if (trimmed.includes('panicked at') && trimmed.startsWith("thread '")
    || trimmed.startsWith('stack backtrace:')
    || isRustBacktraceFrame(line)) return 'rust-backtrace'
  if (line.startsWith('panic: ') || line.startsWith('fatal error: ') || isGoroutineHeader(line)) return 'go-panic'
  return undefined
}

function isDotnetExceptionHead(trimmed: string): boolean {
  const colon = trimmed.indexOf(':')
  if (colon < 0) return false
  const head = trimmed.slice(0, colon)
  return head.endsWith('Exception') && head.includes('.') && /^[A-Za-z0-9._`+]+$/.test(head)
}

function isJavaMoreSummary(trimmed: string): boolean {
  if (!trimmed.startsWith('... ')) return false
  const rest = trimmed.slice(4)
  const digits = rest.match(/^\d+/u)?.[0]?.length ?? 0
  return digits > 0 && rest.slice(digits).trim() === 'more'
}

function terminates(flavor: TraceFlavor, line: string, linesSoFar: number): boolean {
  const trimmed = line.trimStart()
  switch (flavor) {
    case 'python': {
      const indentedOrBlank = line.startsWith(' ') || line.startsWith('\t') || line === ''
      const continuation = trimmed.startsWith('Traceback') || trimmed.startsWith('File ')
        || trimmed.startsWith('During handling') || trimmed.startsWith('The above exception')
      if (indentedOrBlank || continuation) return false
      return !/^[A-Z]/u.test(trimmed)
    }
    case 'js':
      return !trimmed.startsWith('at ') && line !== ''
    case 'java': {
      const chain = trimmed.startsWith('Caused by:') || trimmed.startsWith('Suppressed:') || isJavaMoreSummary(trimmed)
      return !trimmed.startsWith('at ') && !chain && line !== ''
    }
    case 'dotnet': {
      if (line === '') return false
      const continues = trimmed.startsWith('at ') || trimmed.startsWith('--->')
        || trimmed.startsWith('--- End of') || isDotnetExceptionHead(trimmed)
      return !continues
    }
    case 'rust-error':
      return !trimmed.startsWith('--> ') && line !== ''
    case 'rust-backtrace': {
      if (line === '' || linesSoFar === 1) return false
      const isFrame = /^\d/u.test(trimmed)
      const continuation = line.startsWith(' ') || line.startsWith('\t')
        || trimmed.startsWith('stack backtrace:') || trimmed.startsWith('note: run with')
      return !isFrame && !continuation
    }
    case 'go-panic': {
      if (line === '') return false
      const continues = line.startsWith('\t') || isGoroutineHeader(line) || isGoCallFrame(line)
        || line.startsWith('panic: ') || line.startsWith('fatal error: ') || line.startsWith('[signal ')
      return !continues
    }
  }
}

// ─── Frame collapse ───────────────────────────────────────────────────────

const RUNTIME_FRAME_PREFIXES = ['at java.', 'at jdk.', 'at sun.', 'at javax.', 'at scala.', 'at System.', 'at Microsoft.', 'runtime.', 'created by runtime.']
const RUNTIME_FRAME_MARKERS = ['site-packages/', '/usr/lib/python', 'lib/python3.', 'node:internal/', 'node_modules/', '(internal/', 'core::', 'std::', 'alloc::', 'rust_begin_unwind', '__rust_', '/rustc/', '/usr/local/go/src/', '/libexec/src/runtime/']

function isFrameLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('at ')
    || (trimmed.startsWith('File "') && trimmed.includes('", line '))
    || isRustBacktraceFrame(line)
    || isGoFileFrame(line)
    || isGoCallFrame(line)
}

function isChainHeadLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('Caused by:') || trimmed.startsWith('Suppressed:') || trimmed.startsWith('... ')
    || trimmed.startsWith('--->') || trimmed.startsWith('--- End of') || trimmed.startsWith('During handling')
    || trimmed.startsWith('The above exception')
}

function isRuntimeFrame(line: string): boolean {
  const trimmed = line.trimStart()
  return RUNTIME_FRAME_PREFIXES.some(prefix => trimmed.startsWith(prefix))
    || RUNTIME_FRAME_MARKERS.some(marker => line.includes(marker))
}

interface CollapsedTrace {
  readonly kept: LogLine[]
  readonly droppedIndices: Set<number>
}

function collapseTraceFrames(stack: readonly LogLine[], headFrames: number, appFrames: number): CollapsedTrace {
  const kept: LogLine[] = []
  const droppedIndices = new Set<number>()
  let framesSeen = 0
  let appKept = 0
  let runStart: number | undefined
  let runLen = 0
  let prevDropped = false
  const flushRun = (): void => {
    if (runStart !== undefined) {
      kept.push({ lineNumber: runStart, content: `      [... ${runLen} frames collapsed]`, level: 'unknown', isStackTrace: true, isSummary: false, score: 0.8 })
      runStart = undefined
      runLen = 0
    }
  }
  for (const line of stack) {
    if (isFrameLine(line.content) && !isChainHeadLine(line.content)) {
      framesSeen += 1
      const runtime = isRuntimeFrame(line.content)
      const keep = framesSeen <= headFrames || (!runtime && appKept < appFrames)
      if (keep) {
        if (!runtime) appKept += 1
        flushRun()
        kept.push(line)
        prevDropped = false
      } else {
        runStart ??= line.lineNumber
        runLen += 1
        droppedIndices.add(line.lineNumber)
        prevDropped = true
      }
    } else if (prevDropped && (line.content.startsWith(' ') || line.content.startsWith('\t')) && !isChainHeadLine(line.content)) {
      runLen += 1
      droppedIndices.add(line.lineNumber)
    } else {
      flushRun()
      kept.push(line)
      prevDropped = false
    }
  }
  flushRun()
  return { kept, droppedIndices }
}

// ─── Summary detection ────────────────────────────────────────────────────

function isSummaryLine(line: string): boolean {
  if (line.startsWith('===') || line.startsWith('---')) return true
  const digits = line.match(/^\d+/u)?.[0]?.length ?? 0
  if (digits > 0 && line[digits] === ' ') {
    const rest = line.slice(digits + 1)
    if (['passed', 'failed', 'skipped', 'error', 'warning'].some(keyword => rest.startsWith(keyword))) return true
  }
  for (const prefix of ['Test ', 'Tests ', 'Tests:', 'Test:', 'Suite ', 'Suites ', 'Suites:', 'Suite:']) {
    if (line.startsWith(prefix) && /\d/u.test(line.slice(prefix.length).trimStart().charAt(0))) return true
  }
  if (['TOTAL', 'Total', 'Summary'].some(prefix => line.startsWith(prefix))) return true
  if (['Build', 'Compile', 'Test'].some(prefix => line.startsWith(prefix))
    && ['succeeded', 'failed', 'complete'].some(outcome => line.includes(outcome))) return true
  return false
}

// ─── Scoring, dedupe ──────────────────────────────────────────────────────

function scoreLogLine(line: LogLine): number {
  const levelScore = line.level === 'error' || line.level === 'fail' ? 1.0
    : line.level === 'warn' ? 0.5
      : line.level === 'info' || line.level === 'unknown' ? 0.1
        : line.level === 'debug' ? 0.05
          : 0.02
  return Math.min(levelScore + (line.isStackTrace ? 0.3 : 0) + (line.isSummary ? 0.4 : 0), 1.0)
}

function normalizeForDedupe(content: string): string {
  const splitAt = content.search(/[:=]/u)
  const prefix = splitAt < 0 ? content : content.slice(0, splitAt)
  const suffix = splitAt < 0 ? '' : content.slice(splitAt)
  return prefix + suffix.replace(/\d+/gu, 'N').replace(/0x[0-9a-fA-F]+/gu, 'ADDR').replace(/\/[\w/]+\//gu, '/PATH/')
}

// ─── Compressor ───────────────────────────────────────────────────────────

export class LogCompressor {
  constructor(private readonly config: LogCompressorConfig = LOG_COMPRESSOR_DEFAULTS) {}

  compress(content: string, bias: number, store?: CcrStore  ): LogCompressionResult {
    const lines = content.split('\n')
    const originalLineCount = lines.length
    const emptyStats: Record<string, number> = {}
    if (originalLineCount < this.config.minLinesForCcr) {
      return { compressed: content, originalLineCount, compressedLineCount: originalLineCount, formatDetected: 'generic', compressionRatio: 1, cacheKey: undefined, stats: emptyStats }
    }
    const format = detectFormat(lines)
    const logLines = this.parseLines(lines)
    const selected = this.selectLines(logLines, bias)
    const { body, stats } = this.formatOutput(selected, logLines)
    let compressed = body
    const ratio = Buffer.byteLength(compressed, 'utf8') / Math.max(1, Buffer.byteLength(content, 'utf8'))
    let cacheKey: string | undefined
    // The stash and its marker are driven by the same fact the runtime's accept
    // gate reads: the rendering is not the input, so lines were dropped and the
    // `[N lines omitted]` note in the body is the model's only notice of them.
    //
    // Gating this on `ratio < minCompressionRatioForCcr` measured a *different*
    // quantity — the ratio — so a rendering whose ratio landed between that
    // threshold (0.5) and `ACCEPT_MIN_RATIO_DEFAULT` (0.85) was adopted and
    // delivered carrying the omission note with no `hash=` to retrieve what it
    // omitted. Two gates measuring two quantities leave a strip between them
    // that neither owns, and this was that strip: the subsystem's own contract
    // ("lossy on the wire, lossless end-to-end") was broken exactly there, on
    // ordinary test/build output, while every other branch held.
    if (this.config.enableCcr && compressed !== content && store !== undefined) {
      const key = computeKey(content)
      store.put(key, content)
      compressed += `\n[${originalLineCount} lines compressed to ${selected.length}. Retrieve more: hash=${key}]`
      cacheKey = key
    }
    // The count describes the text the caller receives: the rendering carries
    // a header line and, once CCR engaged, the retrieve marker, so reporting
    // the number of selected *entries* understated the output by those lines.
    return { compressed, originalLineCount, compressedLineCount: compressed.split('\n').length, formatDetected: format, compressionRatio: ratio, cacheKey, stats }
  }

  parseLines(lines: readonly string[]): LogLine[] {
    const out: LogLine[] = []
    let active: TraceFlavor | undefined
    let traceLines = 0
    for (const [i, line] of lines.entries()) {
      const entry: LogLine = { lineNumber: i, content: line, level: classifyLevel(line), isStackTrace: false, isSummary: isSummaryLine(line), score: 0 }
      if (active !== undefined) {
        if (traceLines >= this.config.stackTraceMaxLines || terminates(active, line, traceLines)) {
          const capHit = traceLines >= this.config.stackTraceMaxLines
          const previousFlavor = active
          active = undefined
          traceLines = 0
          const newFlavor = flavorFor(line)
          if (newFlavor !== undefined) {
            active = newFlavor
            traceLines = 1
            entry.isStackTrace = true
          } else if (capHit && !terminates(previousFlavor, line, 2)) {
            // Cap hit mid-trace on a line that still continues the flavor:
            // keep marking so the collapse pass — not cap alignment — decides.
            active = previousFlavor
            traceLines = 1
            entry.isStackTrace = true
          }
        } else {
          entry.isStackTrace = true
          traceLines += 1
        }
      } else {
        const flavor = flavorFor(line)
        if (flavor !== undefined) {
          active = flavor
          traceLines = 1
          entry.isStackTrace = true
        }
      }
      entry.score = scoreLogLine(entry)
      out.push(entry)
    }
    return out
  }

  selectLines(logLines: readonly LogLine[], bias: number): LogLine[] {
    const allStrings = logLines.map(line => line.content)
    const adaptiveMax = computeOptimalK(allStrings, bias, 10, this.config.maxTotalLines)
    const errors: LogLine[] = []
    const fails: LogLine[] = []
    const warnings: LogLine[] = []
    const summaries: LogLine[] = []
    const stackTraces: LogLine[][] = []
    let currentStack: LogLine[] = []
    for (const line of logLines) {
      if (line.level === 'error') errors.push(line)
      else if (line.level === 'fail') fails.push(line)
      else if (line.level === 'warn') warnings.push(line)
      if (line.isStackTrace) currentStack.push(line)
      else if (currentStack.length > 0) {
        stackTraces.push(currentStack)
        currentStack = []
      }
      if (line.isSummary) summaries.push(line)
    }
    if (currentStack.length > 0) stackTraces.push(currentStack)

    // Line-number-ordered dedupe: Map keyed by line number (Rust BTreeSet).
    const selected = new Map<number, LogLine>()
    const insert = (line: LogLine): void => { if (!selected.has(line.lineNumber)) selected.set(line.lineNumber, line) }
    for (const line of this.selectWithFirstLast(errors, this.config.maxErrors)) insert(line)
    for (const line of this.selectWithFirstLast(fails, this.config.maxErrors)) insert(line)

    const effectiveWarnings = this.config.dedupeWarnings ? this.dedupeSimilar(warnings) : warnings
    for (const line of effectiveWarnings.slice(0, this.config.maxWarnings)) insert(line)

    const collapsedFrameIndices = new Set<number>()
    for (const stack of stackTraces.slice(0, this.config.maxStackTraces)) {
      if (this.config.collapseRuntimeFrames && stack.length > this.config.stackTraceMaxLines) {
        const collapsed = collapseTraceFrames(stack, this.config.traceHeadFrames, this.config.traceAppFrames)
        for (const index of collapsed.droppedIndices) collapsedFrameIndices.add(index)
        for (const line of collapsed.kept.slice(0, this.config.stackTraceMaxLines)) insert(line)
      } else {
        for (const line of stack.slice(0, this.config.stackTraceMaxLines)) insert(line)
      }
    }

    if (this.config.keepSummaryLines) {
      for (const line of summaries) insert(line)
    }

    // Context lines around every selected entry, minus deliberately-collapsed frames.
    const contextCandidates = new Set<number>()
    for (const index of selected.keys()) {
      const lo = Math.max(0, index - this.config.errorContextLines)
      const hi = Math.min(logLines.length, index + this.config.errorContextLines + 1)
      for (let i = lo; i < hi; i += 1) {
        if (i !== index) contextCandidates.add(i)
      }
    }
    for (const index of contextCandidates) {
      if (!selected.has(index) && !collapsedFrameIndices.has(index) && index < logLines.length) insert(logLines[index]!)
    }

    let ordered = [...selected.values()].sort((a, b) => a.lineNumber - b.lineNumber)
    if (ordered.length > adaptiveMax) {
      ordered = ordered
        .sort((a, b) => (b.score - a.score) || (a.lineNumber - b.lineNumber))
        .slice(0, adaptiveMax)
        .sort((a, b) => a.lineNumber - b.lineNumber)
    }
    return ordered
  }

  selectWithFirstLast(lines: readonly LogLine[], maxCount: number): LogLine[] {
    if (lines.length <= maxCount) return [...lines]
    const out: LogLine[] = []
    const seen = new Set<number>()
    const push = (line: LogLine): void => {
      if (!seen.has(line.lineNumber)) {
        seen.add(line.lineNumber)
        out.push(line)
      }
    }
    if (this.config.keepFirstError && lines[0] !== undefined) push(lines[0])
    if (this.config.keepLastError && lines.length > 0) push(lines[lines.length - 1]!)
    const remaining = Math.max(0, maxCount - out.length)
    if (remaining > 0) {
      for (const line of [...lines].sort((a, b) => (b.score - a.score) || (a.lineNumber - b.lineNumber))) {
        if (out.length >= maxCount) break
        if (!seen.has(line.lineNumber)) push(line)
      }
    }
    return out
  }

  dedupeSimilar(lines: readonly LogLine[]): LogLine[] {
    const seen = new Set<string>()
    const out: LogLine[] = []
    for (const line of lines) {
      const key = normalizeForDedupe(line.content)
      if (!seen.has(key)) {
        seen.add(key)
        out.push(line)
      }
    }
    return out
  }

  formatOutput(selected: readonly LogLine[], allLines: readonly LogLine[]): { body: string; stats: Record<string, number> } {
    const count = (level: LogLevel): number => allLines.filter(line => line.level === level).length
    const stats: Record<string, number> = {
      errors: count('error'),
      fails: count('fail'),
      warnings: count('warn'),
      info: count('info'),
      total: allLines.length,
      selected: selected.length,
    }
    const output = selected.map(line => line.content)
    const omitted = allLines.length - selected.length
    if (omitted > 0) {
      const parts: string[] = []
      for (const [label, key] of [['ERROR', 'errors'], ['FAIL', 'fails'], ['WARN', 'warnings'], ['INFO', 'info']] as const) {
        const n = stats[key]!
        if (n > 0) parts.push(`${n} ${label}`)
      }
      if (parts.length > 0) output.push(`[${omitted} lines omitted: ${parts.join(', ')}]`)
    }
    return { body: output.join('\n'), stats }
  }
}
