/**
 * FreeCodeGo Headroom runtime: context compression wired into the Harness
 * tool pipeline.
 *
 * Algorithm ported from Headroom (https://github.com/headroomlabs-ai/headroom),
 * © Headroom Maintainers, Apache-2.0 — see the attribution panel in the
 * settings UI. The per-block pipeline mirrors the original ContentRouter:
 *
 *   1. Safety gates — excluded tools (Read/Glob/Grep/…, byte-exact edits),
 *      failed tool outputs (tracebacks stay verbatim), and bash search folds.
 *   2. Cross-turn dedup — repeated verbatim runs collapse to a pointer.
 *   3. Lossless-first — format-native reversible folds (rg --heading, ANSI
 *      strip + run collapse, diff index strip, blank-run collapse) accepted
 *      at any ratio: zero accuracy cost.
 *   4. Content routing — JSON → SmartCrusher (doc-level), diff → hunk caps,
 *      HTML → text extraction, search → file grouping, log → line scoring,
 *      tabular → CSV-schema, config → comment elision, prose → extractive
 *      text crusher. Mixed content splits into typed sections first.
 *
 * Every accepted lossy compression stashes the original in the CCR store so
 * the model can retrieve full text via `headroom_retrieve`.
 *
 * Compression hooks the official `tools/post-execute` waterfall: the durable
 * log keeps the lossless canonical value, only the model-facing content
 * projection is replaced.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { CcrStore, computeKey } from './ccr.ts'
import { LogCompressor } from './log-compressor.ts'
import { SMART_CRUSHER_DEFAULTS, crushJsonDocument, type SmartCrusherConfig } from './smart-crusher.ts'
import { compressSearch, looksLikeSearchOutput, SEARCH_COMPRESSOR_DEFAULTS } from './search-compressor.ts'
import { compressDiff, DIFF_COMPRESSOR_DEFAULTS } from './diff-compressor.ts'
import { crushText, TEXT_CRUSHER_DEFAULTS } from './text-crusher.ts'
import { CrossTurnDedup } from './cross-turn-dedup.ts'
import { compactLossless, stripAnsi } from './lossless-compaction.ts'
import { compressTabular, detectTabular } from './tabular-ingest.ts'
import { compressConfig } from './config-compressor.ts'
import { compressHtml } from './html-extractor.ts'
import { detectContentType } from './content-detector.ts'
import { contextWords, scoreBatch } from './relevance.ts'
import { isMixedContent, mixedIsActuallyCode, splitIntoSections, type ContentSection } from './mixed-content.ts'
import { protectTags, restoreTags } from './tag-protector.ts'
import { READ_LIKE_TOOL_NAMES, isSkeletonEligibleTool, skeletonizeReadOutput } from './code-skeleton.ts'

export interface HeadroomSettings {
  headroomEnabled: boolean
  headroomThresholdChars: number
  headroomMinSavingsRatio?: number
  headroomDedupEnabled?: boolean
  headroomExcludeTools?: readonly string[]
  headroomFoldReads?: boolean
  headroomCodeSkeletonEnabled?: boolean
}

import { toolDefinition } from '../tool-definition.ts'
import type { HeadroomKind, HeadroomStats } from '../types.ts'
export type { HeadroomKind, HeadroomStats } from '../types.ts'

// ─── Port provenance ────────────────────────────────────────────────────────

/**
 * Provenance of this port, kept in code so reconciliation against upstream is a
 * mechanical diff rather than an archaeology exercise. Without it there was no
 * way to answer "which upstream revision do we track?" — the audit could only
 * report that no version stamp existed anywhere in the port.
 *
 * `upstreamRevision` is the upstream ref this port was taken from. It is a
 * string rather than a checked-in snapshot on purpose: the port is a
 * behavioural reimplementation in TypeScript, not a vendored subtree, so there
 * is no commit to pin — only the ref a human reviewed.
 *
 * `reconciliation` records *why* the port diverges, so a future reader does not
 * "fix" an intentional omission. Every entry must name an upstream mechanism we
 * consciously do not implement and the reason.
 */
export const HEADROOM_PORT = {
  /** Upstream project this port tracks. */
  upstream: 'headroomlabs-ai/headroom',
  upstreamLicense: 'Apache-2.0',
  /** Upstream ref last reviewed against this implementation. */
  upstreamRevision: 'main @ 2026-09-10',
  /** Revision of this port itself; bump on any behavioural change. */
  portVersion: 3,
  /**
   * Phase of the original ContentRouter this port reproduces. Listed so a
   * reconciliation pass can walk the upstream pipeline in order.
   */
  portedPhases: [
    'safety-gates (original config.py + error_detection.py)',
    'cross-turn-dedup',
    'lossless-compaction',
    'content-routing (json/diff/html/search/log/tabular/config/prose)',
    'code-skeleton (not in upstream)',
  ] as const,
  /**
   * Deliberate divergences from upstream. Each is a decision, not a gap.
   */
  reconciliation: [
    {
      mechanism: 'adaptive-sizer budget source',
      upstream: 'reads the host context-budget remaining before each fold',
      ours: 'uses the configured static threshold and minSavingsRatio',
      reason: 'The Host compaction state is not exposed through a stable service this plugin depends on; wiring it would couple the port to an unversioned internal. Revisit if the Harness publishes a remaining-budget reader.',
    },
    {
      mechanism: 'upstream compressor tuning updates',
      upstream: 'tuned continuously against upstream benchmarks',
      ours: 'fixed constants in smart-crusher.ts (SMART_CRUSHER_DEFAULTS)',
      reason: 'Tuning is empirical; importing it requires the same corpus. Constants are named and centralised so a reconciliation diff is mechanical.',
    },
    {
      mechanism: 'protected-tool list (original DEFAULT_EXCLUDE_TOOLS)',
      upstream: 'names the read tools other harnesses ship (`view`, `read_file`, …)',
      ours: 'the same read spellings, plus `str_replace_editor`',
      reason: 'This composition ships a byte-patch tool (`str_replace_editor`), whose `str_replace` command consumes an `old_str` copied out of a previous `view`. Upstream\'s list predates it, so the one tool here whose entire contract is a byte-exact patch was the one left eligible for a lossy rewrite — a JSON-crusher pass on a `.json` view makes the next `str_replace` match nothing.',
    },
    {
      mechanism: 'protected-tool list source',
      upstream: 'one list in config.py, replaced wholesale by the user setting',
      ours: 'the built-in read spellings in code-skeleton.ts, unioned with the user setting',
      reason: 'The setting is `z.array(z.string()).default([])`, so a wholesale replacement meant every install that never touched the field resolved to an empty list and protected nothing — which also made the code skeleton unreachable, because its branch requires the tool to be protected first.',
    },
    {
      mechanism: 'code-aware compression',
      upstream: 'gated behind enable_code_aware, off by default',
      ours: 'on by default via headroomCodeSkeletonEnabled, applied to read results only',
      reason: 'Measured against real sessions, read output is 85% of all tool bytes ingested, and the Harness re-sends the whole transcript every step. Leaving it uncompressed costs ~10x its size in transmission. The skeleton keeps every retained line byte-exact so Edit anchors still match, and the original stays retrievable.',
    },
  ] as const,
} as const

/** Human-readable provenance line for diagnostics and the settings surface. */
export function headroomProvenance(): string {
  return `${HEADROOM_PORT.upstream} (${HEADROOM_PORT.upstreamLicense}) ${HEADROOM_PORT.upstreamRevision}; port v${HEADROOM_PORT.portVersion}`
}

// ─── Safety gates (original config.py + error_detection.py) ─────────────────

/**
 * Tools never lossy-compressed: the model byte-patches against their output.
 *
 * The read spellings are **not** written here — they are
 * {@link READ_LIKE_TOOL_NAMES}, imported, because the code skeleton is offered
 * only to a tool this set protects and one vocabulary written twice is how a
 * spelling ends up skeleton-eligible and routed like any other tool at the same
 * time. `code-skeleton.spec.ts` fails if the two disagree again, by running every
 * spelling in {@link READ_LIKE_TOOL_NAMES} through the gate and requiring it to be
 * protected.
 *
 * `str_replace_editor` is this port's own addition, and the reason is the same
 * sentence this list was written for: its `str_replace` command needs an `old_str`
 * copied byte-for-byte out of a previous `view`. Upstream's list predates this
 * composition and names the read tools other harnesses ship, so the one tool here
 * whose whole contract is a byte-exact patch was the one tool left unprotected.
 * See the reconciliation entry in {@link HEADROOM_PORT}.
 */
export const DEFAULT_EXCLUDE_TOOLS: readonly string[] = [
  ...READ_LIKE_TOOL_NAMES,
  'glob', 'grep', 'edit', 'write', 'apply_patch', 'str_replace_editor',
  'websearch', 'webfetch', 'web_search', 'web_fetch', 'skill',
]

/**
 * Shell tool names whose read-only search output is losslessly foldable.
 *
 * Both shells are named because the platform picks between them: the base
 * `cordis.patch.yml` disables `tool-bash` on win32 and enables `tool-pwsh`, so
 * `pwsh` is the only shell a Windows session can call. Naming only the POSIX
 * spellings left that session on the generic stage.
 *
 * `exec_command` is the third spelling, and the omission repeated one transport
 * over. A native Codex session's shell approvals arrive as `shell`/`exec_command`
 * — the same pair `bashCommandOf` and its credential screen carry, and the pair
 * the hook matcher family names — and `shell` was already a member, so the set
 * reached one Codex spelling and not the other. `local_shell` stays: this set is
 * consulted by name, so a name nothing emits simply never matches and costs
 * nothing, which is why `CLEARABLE_TOOL_KINDS` keeps its inert entries too. The
 * distinction that matters is that `exec_command` is *not* inert — it has a
 * producer — and it was the one missing.
 *
 * What that costs is bounded, and saying so is the point of this note rather
 * than a nicety. The generic stage in `compressWorking` detects content by shape
 * and folds a search result through the same `compactLossless(text, 'search')`,
 * but its floor is `MIN_COMPRESSIBLE_CHARS` while this branch's floor is 200. So
 * the omission was only ever visible *between the two floors* — a search result
 * of 200 to 1200 characters folded under `bash` and not under `pwsh`. It was
 * never "Windows folded nothing", which is how the next reader would take it
 * without this sentence, and which is why the case was invisible: every fixture
 * large enough to test the fold was also large enough for the generic stage.
 */
const BASH_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'shell', 'exec_command', 'local_shell', 'pwsh'])
const BASH_SEARCH_PROGRAMS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'ag', 'ack'])

/** Distinct error-indicator keywords (original ERROR_INDICATOR_KEYWORDS). */
const ERROR_INDICATOR_KEYWORDS: readonly string[] = [
  'error', 'exception', 'traceback', 'fatal', 'panic', 'crash', 'failed', 'failure', 'abort',
]

/** Zero-result summary phrases never count as error indicators (#1696). */
const ZERO_RESULT_RE = /\b\d+ (?:errors?|failures?|failed|issues?|warnings?|problems?)\b|\bfailed: 0\b|\b0 (?:errors?|failures?)\b/giu

/** Strong (≥2 distinct indicators) error detection — original error_detection.py. */
function contentHasStrongErrorIndicators(text: string): boolean {
  const lowered = text.toLowerCase().replace(ZERO_RESULT_RE, ' ')
  let hits = 0
  for (const keyword of ERROR_INDICATOR_KEYWORDS) {
    if (lowered.includes(keyword)) {
      hits += 1
      if (hits >= 2) return true
    }
  }
  return false
}

/** Per-tool compression bias (original DEFAULT_TOOL_PROFILES). */
const TOOL_BIAS: readonly (readonly [RegExp, number])[] = [
  [/^(?:grep|rg|ripgrep|ag|ack)$/iu, 1.5],
  [/^(?:webfetch|web_fetch|fetch|curl|wget)$/iu, 0.7],
]

/**
 * Whether one tool is protected from lossy compression.
 *
 * The settings field **adds** to {@link DEFAULT_EXCLUDE_TOOLS}; it does not
 * replace it. That is a correctness rule rather than a preference: the field is
 * `z.array(z.string()).default([])`, so every install that has never touched it
 * resolves to a *present, empty* list, and the previous `excludeTools ??
 * DEFAULT_EXCLUDE_TOOLS` therefore never consulted the built-in set at all — the
 * safety gate excluded nothing, which also made the code skeleton unreachable
 * (its branch requires `excluded === true`) while the settings panel went on
 * reporting the skeleton as enabled. An empty list means "no extra exclusions",
 * which is exactly how the schema field reads, and a set that could be emptied by
 * a default is not a guarantee.
 * @param name - the tool name as the pipeline received it.
 * @param excludeTools - the user's additional tools, if the settings carry any.
 * @returns true when this tool's output must reach the model unmodified.
 */
function isExcludedTool(name: string, excludeTools: readonly string[] | undefined): boolean {
  const lower = name.toLowerCase()
  // MCP wrappers (mcp__server__tool) match on the bare tool suffix too.
  const suffix = lower.startsWith('mcp__') ? lower.split('__')[2] : lower.startsWith('mcp_') ? lower.split('_').slice(2).join('_') : undefined
  const matches = (entry: string): boolean => lower === entry.toLowerCase() || (suffix !== undefined && suffix === entry.toLowerCase())
  return DEFAULT_EXCLUDE_TOOLS.some(matches) || (excludeTools ?? []).some(matches)
}

/** True when the shell command is a read-only search (original _bash_command_is_search). */
function bashCommandIsSearch(command: string): boolean {
  const tokens = command.split(/[\s|;&]+/u).map(token => token.replace(/^["']|["']$/gu, ''))
  let sawSearchProgram = false
  for (const token of tokens) {
    if (BASH_SEARCH_PROGRAMS.has(token)) {
      sawSearchProgram = true
      continue
    }
    // Redirects and writers disqualify: the output isn't the stdout we'd fold.
    if (token === '>' || token === '>>' || token === 'tee' || token.startsWith('>')) return false
  }
  return sawSearchProgram
}

const ACCEPT_MIN_RATIO_DEFAULT = 0.85
const ERROR_PROTECTION_MAX_CHARS = 8_000
const MIN_COMPRESSIBLE_CHARS = 1_200

/** Flavor detection for structured-config outputs (text-only heuristics). */
type ConfigFlavor = 'yaml' | 'toml' | 'ini'

const TOML_SECTION_RE = /^\s*\[[^\]\n=]+\]\s*$/
const YAML_KEY_RE = /^\s*[\w.-]+:\s?/
const INI_SEMICOLON_RE = /^\s*;/

function detectConfigFlavor(text: string): ConfigFlavor | undefined {
  const lines = text.slice(0, 4000).split('\n').filter(l => l.trim() !== '')
  if (lines.length < 3) return undefined
  const eqLines = lines.filter(l => /^\s*[\w."'-]+\s*=/.test(l)).length
  const sections = lines.filter(l => TOML_SECTION_RE.test(l)).length
  const iniComments = lines.filter(l => INI_SEMICOLON_RE.test(l)).length
  if (sections >= 1 && eqLines >= 2) return 'toml'
  if (iniComments >= 1 && eqLines >= 2) return 'ini'
  if (lines.filter(l => YAML_KEY_RE.test(l)).length / lines.length >= 0.4) return 'yaml'
  return undefined
}

export interface HeadroomQuery {
  readonly toolName: string
  readonly query: string
}

export class FreeCodeGoHeadroomRuntime {
  private readonly store = new CcrStore()
  private readonly logCompressor = new LogCompressor()
  private readonly crusherConfig: SmartCrusherConfig = SMART_CRUSHER_DEFAULTS
  private readonly dedup = new CrossTurnDedup()
  private compressions = 0
  private originalBytes = 0
  private compressedBytes = 0
  private readonly kindCounts: Partial<Record<HeadroomKind, number>> = {}
  private protectedCount = 0
  private retrievals = 0
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly settings: { get(): unknown } | undefined,
  ) {}

  /** Attach the post-execute compression waterfall and the retrieve tool. */
  start(): void {
    // Compress oversized model-facing tool results. Failures are contained:
    // a throwing listener must never surface as a broken tool result.
    this.ctx.effect(() => this.ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        if (exec.name === 'headroom_retrieve') return await next()
        const compressed = this.compressContent(exec, result)
        if (compressed === undefined) return await next()
        return { kind: 'accept' as const, content: compressed }
      } catch {
        return await next()
      }
    }), 'freecodego: headroom compression')
    this.registerRetrieveTool()
  }

  /** Latch the off state: disposed runtimes stop compressing new results. */
  dispose(): void {
    this.disposed = true
  }

  status(): HeadroomStats {
    const settings = this.settings?.get() as HeadroomSettings | undefined
    return {
      enabled: settings?.headroomEnabled !== false && !this.disposed,
      // Read back through the same accessors the pipeline uses, so the panel
      // can never report a configuration different from the one in force.
      dedupEnabled: this.dedupEnabled(),
      foldReads: this.foldReads(),
      codeSkeletonEnabled: this.codeSkeletonEnabled(),
      compressions: this.compressions,
      originalBytes: this.originalBytes,
      compressedBytes: this.compressedBytes,
      logCompressions: this.kindCounts.log ?? 0,
      jsonCompressions: this.kindCounts.json ?? 0,
      diffCompressions: this.kindCounts.diff ?? 0,
      searchCompressions: this.kindCounts.search ?? 0,
      proseCompressions: this.kindCounts.prose ?? 0,
      htmlCompressions: this.kindCounts.html ?? 0,
      tabularCompressions: this.kindCounts.tabular ?? 0,
      configCompressions: this.kindCounts.config ?? 0,
      losslessCompressions: this.kindCounts.lossless ?? 0,
      dedupCompressions: this.kindCounts.dedup ?? 0,
      codeSkeletonCompressions: this.kindCounts.code ?? 0,
      protectedCount: this.protectedCount,
      ccrEntries: this.store.size,
      ccrBytes: this.store.bytes,
      retrievals: this.retrievals,
      retrieveMisses: this.retrieveMisses,
      provenance: headroomProvenance(),
      portVersion: HEADROOM_PORT.portVersion,
      upstreamRevision: HEADROOM_PORT.upstreamRevision,
    }
  }

  private enabled(): boolean {
    const settings = this.settings?.get() as HeadroomSettings | undefined
    return settings?.headroomEnabled !== false && !this.disposed
  }

  private threshold(): number {
    const settings = this.settings?.get() as HeadroomSettings | undefined
    const threshold = settings?.headroomThresholdChars
    return typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 256 ? Math.floor(threshold) : MIN_COMPRESSIBLE_CHARS
  }

  private minRatio(): number {
    const settings = this.settings?.get() as HeadroomSettings | undefined
    const ratio = settings?.headroomMinSavingsRatio
    if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 && ratio < 1) return ratio
    return ACCEPT_MIN_RATIO_DEFAULT
  }

  private dedupEnabled(): boolean {
    const settings = this.settings?.get() as HeadroomSettings | undefined
    return settings?.headroomDedupEnabled !== false
  }

  /** Code skeletonization of read results. On by default: see HEADROOM_PORT. */
  private codeSkeletonEnabled(): boolean {
    const settings = this.settings?.get() as HeadroomSettings | undefined
    return settings?.headroomCodeSkeletonEnabled !== false
  }

  private excludeTools(): readonly string[] | undefined {
    const settings = this.settings?.get() as HeadroomSettings | undefined
    return settings?.headroomExcludeTools
  }

  private foldReads(): boolean {
    const settings = this.settings?.get() as HeadroomSettings | undefined
    return settings?.headroomFoldReads === true
  }

  /** Per-tool bias (original DEFAULT_TOOL_PROFILES). */
  private biasFor(toolName: string): number {
    const lower = toolName.toLowerCase()
    for (const [pattern, bias] of TOOL_BIAS) {
      if (pattern.test(lower)) return bias
    }
    return 1.0
  }

  /** Information-need query for relevance scoring: tool name + arguments. */
  private queryFor(exec: { readonly name: string; readonly arguments: unknown }): HeadroomQuery {
    let argsText = ''
    try {
      argsText = typeof exec.arguments === 'string' ? exec.arguments : JSON.stringify(exec.arguments) ?? ''
    } catch {
      argsText = ''
    }
    return { toolName: exec.name, query: `${exec.name}\n${argsText}`.slice(0, 2_000) }
  }

  // ─── Safety gates ─────────────────────────────────────────────────────────

  /** True when this tool result must reach the model byte-identical. */
  private isProtected(exec: { readonly name: string; readonly arguments: unknown }, result: { readonly isError?: boolean; readonly content: readonly ContentBlock[] }): boolean {
    const name = exec.name
    const text = joinText(result.content)
    // Failed tool calls stay verbatim: the model needs exact tracebacks to
    // recover (original issue #847). Above the size cap, LogCompressor still
    // preserves error lines in big logs — the two features are complementary.
    if (result.isError === true && text.length <= ERROR_PROTECTION_MAX_CHARS && contentHasStrongErrorIndicators(text)) return true
    const excluded = isExcludedTool(name, this.excludeTools())
    if (!excluded) return false
    // Reads fold only when the user opted in — and then only losslessly.
    if (this.foldReads()) return false
    return true
  }

  /** Bash search folds + read folds: the lossless-only paths for gated tools. */
  private foldGatedTool(exec: { readonly name: string; readonly arguments: unknown }, result: { readonly isError?: boolean; readonly content: readonly ContentBlock[] }): ContentBlock[] | undefined {
    const name = exec.name.toLowerCase()
    const text = joinText(result.content)
    if (text.length < 200) return undefined
    const foldReads = this.foldReads()
    const excluded = isExcludedTool(name, this.excludeTools())
    if (BASH_TOOL_NAMES.has(name)) {
      const args = exec.arguments as { command?: unknown } | undefined
      const command = typeof args?.command === 'string' ? args.command : ''
      if (command !== '' && bashCommandIsSearch(command)) {
        return this.replaceIfSmaller(result.content, compactLossless(text, 'search'), 'lossless')
      }
      return undefined
    }
    // Code skeleton: the only strategy that reaches source, and the only one
    // that touches an excluded tool's content at all. Skipped for errors (the
    // model needs the traceback) and for non-code files, which the detector and
    // the extension check reject inside the wrapper.
    if (excluded && result.isError !== true && this.codeSkeletonEnabled() && isSkeletonEligibleTool(name)) {
      const skeleton = this.skeletonizeRead(text)
      if (skeleton !== undefined) return this.replaceIfSmaller(result.content, skeleton, 'code')
    }
    if (excluded && foldReads && result.isError !== true) {
      // Opt-in Read fold: shape-dispatched, byte-reversible only.
      const detection = detectContentType(text)
      const kind = detection.contentType === 'search' ? 'search'
        : detection.contentType === 'log' ? 'log'
          : undefined
      if (kind === undefined) return undefined
      return this.replaceIfSmaller(result.content, compactLossless(text, kind), 'lossless')
    }
    return undefined
  }

  /**
   * Skeletonize one read result and stash the original under its CCR hash.
   *
   * The store is written only after the wrapper reports `applied`, so a declined
   * skeleton never leaves an entry the model could retrieve for no reason.
   */
  private skeletonizeRead(text: string): { readonly applied: boolean; readonly output: string } | undefined {
    const hash = computeKey(text)
    const result = skeletonizeReadOutput(text, hash)
    if (!result.applied) return undefined
    this.store.put(hash, text)
    return { applied: true, output: result.output }
  }

  // ─── Block pipeline ───────────────────────────────────────────────────────

  /** Compress oversized text blocks; returns replacement blocks or undefined. */
  private compressContent(exec: { readonly name: string; readonly arguments: unknown }, result: { readonly isError?: boolean; readonly content: readonly ContentBlock[] }): ContentBlock[] | undefined {
    if (!this.enabled()) return undefined
    if (this.isProtected(exec, result)) {
      this.protectedCount += 1
      return this.foldGatedTool(exec, result)
    }
    const gated = this.foldGatedTool(exec, result)
    if (gated !== undefined) return gated

    const threshold = this.threshold()
    const query = this.queryFor(exec)
    const bias = this.biasFor(exec.name)
    let changed = false
    const out: ContentBlock[] = []
    for (const block of result.content) {
      if (block.type !== 'text') {
        out.push(block)
        continue
      }
      const bytes = Buffer.byteLength(block.text, 'utf8')
      if (bytes < threshold) {
        // Stays verbatim in context: index it for later cross-turn dedup.
        if (this.dedupEnabled()) this.dedup.remember(block.text)
        out.push(block)
        continue
      }
      const compressed = this.compressText(block.text, query, bias)
      if (compressed === undefined) {
        if (this.dedupEnabled()) this.dedup.remember(block.text)
        out.push(block)
        continue
      }
      out.push({ ...block, text: compressed })
      changed = true
    }
    return changed ? out : undefined
  }

  private compressText(text: string, query: HeadroomQuery, bias: number): string | undefined {
    const originalBytes = Buffer.byteLength(text, 'utf8')

    // Stage 0a — cross-turn verbatim dedup: later repeats of earlier in-context
    // content collapse to a pointer (zero information loss, cache-safe).
    if (!this.dedupEnabled()) return this.compressWorking(text, query, bias, originalBytes)
    const folded = this.dedup.fold(text)
    if (!folded.applied) {
      const compressed = this.compressWorking(text, query, bias, originalBytes)
      // Indexed only when the text really is what the model received. The stage
      // below replaces it with a summary (prose extraction, JSON crush, search
      // compression) whose lines are *not* in context, and the pointer this stage
      // emits carries no `hash=` token — `cross-turn-dedup` is explicit that it
      // needs none because "the referenced text physically exists in the earlier
      // (still uncompressed) output". Remembering before the next stage ran made
      // that false: a repeat of a compressed output folded to `[↑NL same as
      // earlier tool result]` over lines the crush had already dropped, and the
      // omission was unrecoverable — the model was told to look at something it
      // never had. A repeat of a compressed output is now compressed again, on
      // its own hash, which it can retrieve.
      if (compressed === undefined) this.dedup.remember(text)
      return compressed
    }
    const result = this.compressWorking(folded.output, query, bias, originalBytes)
    // A later stage that compressed the folded text already reports the whole
    // delta measured from the original bytes, so the fold is inside that one
    // record — crediting it separately counted the same bytes twice.
    if (result !== undefined) return result
    // Nothing downstream accepted what came out of the fold. The fold is still a
    // complete, self-describing replacement — the lines it points at are verbatim
    // in an earlier result that `remember` only ever indexed for that reason — so
    // it is what the model receives and it is what gets recorded. Throwing it away
    // made this stage a no-op for exactly the repeated code and list output it
    // exists for (nothing else compresses those), while the panel still credited
    // the compression that never reached anyone.
    this.record('dedup', originalBytes, folded.output)
    return folded.output
  }

  /** Stage 0b onward: everything measured against the bytes handed in here. */
  private compressWorking(text: string, query: HeadroomQuery, bias: number, originalBytes: number): string | undefined {
    const workingBytes = Buffer.byteLength(text, 'utf8')
    if (workingBytes < MIN_COMPRESSIBLE_CHARS) return undefined

    // Stage 1 — mixed content: split interleaved code/JSON/search/prose and
    // compress each section under its own strategy. Reassemble when the
    // total wins.
    if (isMixedContent(text) && !mixedIsActuallyCode(text)) {
      const spliced = this.compressMixed(text, query, bias)
      if (spliced !== undefined) return spliced
    }

    // Stage 2 — content-type keyed lossless fold (any shrink wins).
    const detection = detectContentType(text)
    const foldKind = detection.contentType === 'search' ? 'search'
      : detection.contentType === 'log' ? 'log'
        : detection.contentType === 'diff' ? 'diff'
          : detection.contentType === 'config' ? 'config'
            : undefined
    if (foldKind !== undefined) {
      const folded = compactLossless(text, foldKind)
      if (folded.applied) {
        this.record('lossless', workingBytes, folded.output)
        return folded.output
      }
    }
    // Pure path listings (find/ls -1/rg -l).
    if (detection.contentType === 'text' || detection.contentType === 'search') {
      const folded = compactLossless(text, 'paths')
      if (folded.applied) {
        this.record('lossless', workingBytes, folded.output)
        return folded.output
      }
    }

    const minRatio = this.minRatio()
    const acceptRatio = (candidate: string): boolean =>
      Buffer.byteLength(candidate, 'utf8') / Math.max(1, workingBytes) <= minRatio

    // Stage 3 — type-routed lossy compressors (CCR-backed, recoverable).
    if (detection.contentType === 'json') {
      const crushed = crushJsonDocument(text, this.crusherConfig, this.store, query.query)
      if (crushed.applied && acceptRatio(crushed.output)) {
        const withMarker = `${crushed.output}\n[JSON compressed from ${workingBytes} bytes. Retrieve original: hash=${computeKey(text)}]`
        if (acceptRatio(withMarker)) {
          this.store.put(computeKey(text), text)
          this.record('json', originalBytes, withMarker)
          return withMarker
        }
      }
      return undefined
    }
    if (detection.contentType === 'diff') {
      const diff = compressDiff(text, DIFF_COMPRESSOR_DEFAULTS, this.store, bias)
      if (diff.applied && acceptRatio(diff.compressed)) {
        this.record('diff', originalBytes, diff.compressed)
        return diff.compressed
      }
      return undefined
    }
    if (detection.contentType === 'html') {
      const html = compressHtml(text)
      if (html.applied && acceptRatio(html.output)) {
        // The marker is not optional here, and this branch was the one that
        // omitted it: `compressHtml` strips every tag, so the extraction drops
        // markup the model may need back — an `<img src>`, an inline JSON
        // payload, a table's structure. Storing the original without naming its
        // hash made the compression *irrecoverable*: the entry sat in CCR with
        // nothing in the conversation pointing at it, which is the one shape
        // this whole subsystem exists to avoid. The JSON and tabular branches
        // below already build the same suffix; this one now does too.
        const withMarker = `${html.output}\n[HTML compressed from ${workingBytes} bytes. Retrieve original: hash=${computeKey(text)}]`
        if (acceptRatio(withMarker)) {
          this.store.put(computeKey(text), text)
          this.record('html', originalBytes, withMarker)
          return withMarker
        }
      }
      return undefined
    }
    if (looksLikeSearchOutput(text) || detection.contentType === 'search') {
      const search = compressSearch(text, SEARCH_COMPRESSOR_DEFAULTS, this.store, contextWords(query.query), bias)
      if (search.applied && acceptRatio(search.compressed)) {
        this.record('search', originalBytes, search.compressed)
        return search.compressed
      }
      return undefined
    }
    if (detection.contentType === 'log') {
      const stripped = stripAnsi(text)
      const log = this.logCompressor.compress(stripped, bias, this.store)
      // Adoption asks whether the compressor changed the text it was handed —
      // every other branch in this chain asks its compressor's own `applied`
      // signal, and the ratio gate below already refuses a no-op (a refused
      // rendering is the input verbatim, i.e. ratio 1.0). Gating on `cacheKey`
      // instead asked a different question: LogCompressor used to set it only
      // when CCR engaged, under a threshold of its own, so every real 15–50%
      // saving between that threshold and `acceptRatio` was discarded in full —
      // the log kept its size and the panel never credited the compression that
      // did happen. `LogCompressor` now sets it whenever the rendering differs
      // from the input, which is this same predicate, so the two gates cannot
      // disagree again.
      if (log.compressed !== stripped && acceptRatio(log.compressed)) {
        this.record('log', originalBytes, log.compressed)
        return log.compressed
      }
      return undefined
    }
    const tabularDetection = detectTabular(text)
    if (tabularDetection !== undefined) {
      const tabular = compressTabular(text, tabularDetection, this.crusherConfig, this.store)
      if (tabular.applied && acceptRatio(tabular.output)) {
        const withMarker = `${tabular.output}\n[Table compressed from ${workingBytes} bytes. Retrieve original: hash=${computeKey(text)}]`
        if (acceptRatio(withMarker)) {
          this.store.put(computeKey(text), text)
          this.record('tabular', originalBytes, withMarker)
          return withMarker
        }
      }
      return undefined
    }
    if (detection.contentType === 'config') {
      const flavor = detectConfigFlavor(text) ?? 'yaml'
      const config = compressConfig(text, flavor, this.store)
      if (config.applied && acceptRatio(config.output)) {
        this.record('config', originalBytes, config.output)
        return config.output
      }
      return undefined
    }
    // Source code passes through unmangled (original enable_code_aware=false).
    if (detection.contentType === 'code') return undefined

    // Long prose: extractive sentence selection (READMEs, reports), with
    // custom XML tags protected and restored.
    const protectedProse = protectTags(text, false)
    const prose = crushText(protectedProse.cleaned, TEXT_CRUSHER_DEFAULTS, this.store, query.query)
    if (prose.applied) {
      const restored = restoreTags(prose.compressed, protectedProse.blocks)
      if (acceptRatio(restored)) {
        this.record('prose', originalBytes, restored)
        return restored
      }
    }
    return undefined
  }

  /** Split mixed content, compress each section, adopt when the splice wins. */
  private compressMixed(text: string, query: HeadroomQuery, bias: number): string | undefined {
    const sections = splitIntoSections(text)
    if (sections.length < 2) return undefined
    const rendered: string[] = []
    let changed = false
    for (const section of sections) {
      const sectionCompressed = this.compressSection(section, query, bias)
      if (sectionCompressed !== section.content) changed = true
      rendered.push(sectionCompressed)
    }
    if (!changed) return undefined
    const output = rendered.join('\n')
    return Buffer.byteLength(output, 'utf8') < Buffer.byteLength(text, 'utf8') ? output : undefined
  }

  /** Compress one typed section (lossless fold + its type's compressor only). */
  private compressSection(section: ContentSection, query: HeadroomQuery, bias: number): string {
    if (section.atomic || section.contentType === 'code') return section.content
    const bytes = Buffer.byteLength(section.content, 'utf8')
    if (bytes < MIN_COMPRESSIBLE_CHARS) return section.content
    const minRatio = this.minRatio()
    switch (section.contentType) {
      case 'json': {
        const crushed = crushJsonDocument(section.content, this.crusherConfig, this.store, query.query)
        if (crushed.applied && Buffer.byteLength(crushed.output, 'utf8') / bytes <= minRatio) {
          this.store.put(computeKey(section.content), section.content)
          this.record('json', bytes, crushed.output)
          return `${crushed.output}\n[JSON compressed. Retrieve original: hash=${computeKey(section.content)}]`
        }
        return section.content
      }
      case 'search': {
        const folded = compactLossless(section.content, 'search')
        const base = folded.applied ? folded.output : section.content
        if (folded.applied) this.record('lossless', bytes, folded.output)
        const search = compressSearch(base, SEARCH_COMPRESSOR_DEFAULTS, this.store, contextWords(query.query), bias)
        if (search.applied && Buffer.byteLength(search.compressed, 'utf8') / bytes <= minRatio) {
          this.record('search', bytes, search.compressed)
          return search.compressed
        }
        return base
      }
      case 'text': {
        const protectedProse = protectTags(section.content, false)
        const prose = crushText(protectedProse.cleaned, TEXT_CRUSHER_DEFAULTS, this.store, query.query)
        if (prose.applied) {
          const restored = restoreTags(prose.compressed, protectedProse.blocks)
          if (Buffer.byteLength(restored, 'utf8') / bytes <= minRatio) {
            this.record('prose', bytes, restored)
            return restored
          }
        }
        return section.content
      }
      default:
        return section.content
    }
  }

  /**
   * Replace the text blocks when the folded text is strictly smaller.
   *
   * A fold is a projection of the **whole** result (`joinText`), so it is only
   * offered for a result that is one text block. With more than one block the
   * old code put that whole-result fold in the first block and left the rest
   * verbatim, which sent the model every remaining block twice — the fold had
   * already consumed them and they were still there — while `record` credited the
   * fold against the joined length, so the report of the saving was fiction too.
   * (`mcp__server__tool` results are the shape that reaches this: a multi-part
   * MCP answer keeps its several text blocks.) Folding each block on its own
   * instead would be a second reading of the same document, so a result with more
   * than one text block is left alone.
   */
  private replaceIfSmaller(content: readonly ContentBlock[], folded: { readonly output: string; readonly applied: boolean }, kind: HeadroomKind): ContentBlock[] | undefined {
    if (!folded.applied) return undefined
    const textBlocks = content.filter(block => block.type === 'text')
    if (textBlocks.length !== 1) return undefined
    const original = joinText(content)
    if (Buffer.byteLength(folded.output, 'utf8') >= Buffer.byteLength(original, 'utf8')) return undefined
    this.record(kind, Buffer.byteLength(original, 'utf8'), folded.output)
    const out: ContentBlock[] = []
    let replaced = false
    for (const block of content) {
      if (block.type === 'text' && !replaced) {
        out.push({ ...block, text: folded.output })
        replaced = true
      } else {
        out.push(block)
      }
    }
    return replaced ? out : undefined
  }

  private record(kind: HeadroomKind, originalBytes: number, compressed: string): void {
    this.compressions += 1
    this.kindCounts[kind] = (this.kindCounts[kind] ?? 0) + 1
    this.originalBytes += originalBytes
    this.compressedBytes += Buffer.byteLength(compressed, 'utf8')
  }

  /** Retrieve misses recorded since start; feeds the stats snapshot so a
   * rising miss rate is visible before it degrades model quality. */
  private retrieveMisses = 0

  private registerRetrieveTool(): void {
    const tools = this.ctx.get('tools') as { register?: (tool: unknown) => () => void } | undefined
    if (tools?.register === undefined) return
    const output = {
      schema: { type: 'object' as const, additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
    }
    const dispose = tools.register(toolDefinition({
      name: 'headroom_retrieve',
      description: 'Retrieve the original uncompressed text for a compressed tool output. Use this when a compressed result references "hash=<24 hex chars>" or "<<ccr:hash,...>>" and you need the full content that was omitted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['hash'],
        properties: { hash: { type: 'string', pattern: '^[a-f0-9]{24}$', description: 'The 24-hex hash from the compressed output marker.' } },
      },
      output,
      execute: async (args: { readonly hash: string }) => {
        this.retrievals += 1
        const payload = this.store.get(args.hash)
        if (payload === undefined) {
          // Tombstone instead of a bare error: the model learns the original
          // is gone for good (TTL/capacity eviction) and must re-run the tool
          // rather than retrying the same hash in a doom loop.
          this.retrieveMisses += 1
          throw new Error(`The original for hash "${args.hash}" is no longer stored (expired or evicted). The compressed summary you have is all that remains; re-run the original tool if you need the full content again.`)
        }
        return payload
      },
      presentCall: (args: { readonly hash: string }) => ({ card: 'generic', title: `Retrieve original (hash ${args.hash})` }),
    }))
    this.ctx.effect(() => dispose, 'freecodego: headroom_retrieve tool')
  }
}

function joinText(content: readonly ContentBlock[]): string {
  return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n')
}

// Re-export for tests and future callers.
export { scoreBatch }
