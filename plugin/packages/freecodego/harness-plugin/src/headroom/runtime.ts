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
 *   3. Lossless-favoured folds — format-native reversible folds (rg --heading,
 *      ANSI strip + run collapse, diff index strip, blank-run collapse). A fold
 *      that reaches {@link FOLD_DECISIVE_RATIO} is the delivery: zero accuracy
 *      cost, and no later stage is allowed to buy a smaller payload for it. A
 *      weaker fold is only a *candidate* — it competes with the typed stages
 *      below and ships when every one of them refuses. Accepting every fold "at
 *      any ratio" instead let a small reversible saving stand in front of a much
 *      larger recoverable one, measured on the shapes a fold touches: a
 *      twelve-hunk diff with `index` lines at 0.931 where the stage behind it
 *      ships 0.530, and a search result with a shared directory prefix at 0.984
 *      where the stage ships 0.47.
 *   4. Content routing — JSON → SmartCrusher (doc-level), diff → hunk caps,
 *      HTML → text extraction, search → file grouping, log → line scoring,
 *      tabular → CSV-schema, config → comment elision, prose → extractive
 *      text crusher. Mixed content splits into typed sections first.
 *
 * Every accepted lossy compression stashes the original in the CCR store so
 * the model can retrieve full text via `headroom_retrieve`. The same original is
 * also parked in the Harness's own spill store when the composition mounts one,
 * so the bytes outlive the process (see `ccr-spill.ts`); the in-memory entry
 * stays the fast path and the whole answer where no backend is mounted.
 *
 * Compression hooks the official `tools/post-execute` waterfall: the durable
 * log keeps the lossless canonical value, only the model-facing content
 * projection is replaced.
 *
 * Two shrinkers, two seams, one order
 * ----------------------------------
 * This runtime is not the only thing that shrinks a tool result. The Harness
 * ships `compaction-tool-result-pruner`, which replaces an over-budget result's
 * middle with a marker on the session *surface* (`thresholdChars: 8192`,
 * `headChars: 4096`, `tailChars: 1024` in the base composition), and
 * `cache-cold` in this plugin then refuses to clear a result whose text carries
 * that marker. Nothing used to say how the two divide the work, which left two
 * questions open: whether one of them was dead configuration, and what happens
 * to output neither of them takes.
 *
 * - **Order is fixed by the seams, not by a setting.** Delivery is the earlier
 *   event: `tools/post-execute` runs while a call is being answered, and
 *   `pruneSession` runs only from a compaction pass — `compaction-basic` calls it
 *   when a context-overflow or pressure trigger fires, which is later by
 *   construction and may be much later. So this runtime is always the *first*
 *   shrinker, and what the pruner later measures is this runtime's rendering.
 * - **It is a floor, not a rival.** Neither threshold bounds the other: a 100 KB
 *   payload delivered at 0.5 is still 50 KB, so the pruner does take that. That is
 *   the intended composition, and it is safe for one reason worth stating — the
 *   `hash=` reference this module writes is the *last line* of a rendering, so it
 *   rides in the tail the pruner retains (`tailChars`, asserted against the
 *   pruner's own composition in `headroom-pruner-boundary.spec.ts`). The inline
 *   `<<ccr:HASH,…>>` cell markers inside a removed middle are lost with it, which
 *   degrades per-cell retrieval while the whole-payload reference survives.
 * - **The populations are complementary.** This module's gate protects what the
 *   pruner cannot recognize as safe: read-like and byte-exact tools, and a short
 *   failed result's traceback, stay verbatim here (see
 *   {@link DEFAULT_EXCLUDE_TOOLS}). The pruner is size-only — no tool name, no
 *   `isError` — so it is exactly the thing that eventually takes those payloads
 *   once they are over its own budget. Deleting either one because the other
 *   exists would leave a real population unserved: this module alone leaves a
 *   500 KB read result in the transcript until a compaction pass, and the pruner
 *   alone mangles a read result's bytes at delivery time.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { SpillWriter } from '../result-spill.ts'
import { CcrStore, StagedCcrStore, computeKey, stagedWrites } from './ccr.ts'
import { ArchivingCcrStore, SpillArchive, attachArchiveNotices, type SpillArchiveOwner } from './ccr-spill.ts'
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

/**
 * Host settings the headroom runtime reads: the enable switch, the size
 * threshold, dedup and fold policy, and the protected/read-fold tool lists.
 */
export interface HeadroomSettings {
  headroomEnabled: boolean
  headroomThresholdChars: number
  headroomMinSavingsRatio?: number
  headroomDedupEnabled?: boolean
  headroomExcludeTools?: readonly string[]
  headroomFoldReads?: boolean
  headroomCodeSkeletonEnabled?: boolean
  /**
   * `reversible` (default) delivers a fold that clears {@link FOLD_DECISIVE_RATIO}
   * on sight; `max` demotes every fold to a candidate so the typed stages always
   * get their chance. See {@link FreeCodeGoHeadroomRuntime.foldPolicy}.
   */
  headroomFoldPolicy?: 'reversible' | 'max'
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
  portVersion: 4,
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

/**
 * Human-readable provenance line for diagnostics and the settings surface.
 * @returns the upstream ref, license and port version as one line.
 */
export function headroomProvenance(): string {
  // The panel's only reading of the port's origin: project, license, reviewed ref,
  // and port revision in one sentence. See `HeadroomStats.provenance`.
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

/**
 * The ratio at or below which a Stage 2 lossless fold is delivered on the spot.
 *
 * Stage 2's folds are reversible, so they are preferred to a lossy rendering of
 * the same size — but "at any ratio" is not a preference, it is a veto, and it
 * was measurably costing the payloads it touched. Every typed branch behind it
 * must reach `minRatio` (0.85 by default) to ship at all, and the renderings they
 * actually deliver land near half: prose 0.47–0.54, search 0.47, diff 0.50, json
 * 0.49, log 0.03–0.50, html ~0.50, config 0.50, tabular 0.82. So a fold at or
 * below this line is within a factor of ~1.2 of anything the chain could
 * realistically hand back, and the reversible copy wins that tie; a fold above it
 * can be 30 points worse than the branch standing behind it, which is where it
 * now has to compete.
 *
 * The bar is `min(FOLD_DECISIVE_RATIO, minRatio)` rather than `minRatio` alone,
 * and the difference matters in both directions. With the user's own ratio as the
 * bar, a *lenient* setting (`headroomMinSavingsRatio: 0.99`) would make almost
 * every fold decisive — the more compression the user asked for, the less of it
 * they would get on exactly the payload shapes that fold. A stricter one
 * (0.5) would make `minRatio` the binding term, so a fold at 0.55 competes with a
 * branch that must itself reach 0.5: the typed stage keeps its chance whenever
 * the user has said the fold's saving is not good enough. Delivering a fold early
 * is never *wrong*, only possibly worse than what is behind it — which is the
 * whole content of this decision, and the reason the deferral is pinned in
 * `headroom-fold-competition.spec.ts` rather than left to a comment.
 */
const FOLD_DECISIVE_RATIO = 0.6
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

/**
 * One compression request as the runtime receives it: the tool that produced
 * the bytes and the query text used to score relevance.
 */
export interface HeadroomQuery {
  readonly toolName: string
  readonly query: string
}

/**
 * One mixed-content section's rendering, with the credit it would earn.
 *
 * The credit travels with the rendering rather than being recorded where it is
 * computed, because a section is a saving only once the *splice* carrying it is
 * smaller than the payload it replaced: a splice that loses that comparison is
 * discarded whole (its CCR entries included), and a counter that had already been
 * incremented would report a compression the model never received.
 */
interface SectionCompression {
  readonly text: string
  readonly credit?: { readonly kind: HeadroomKind; readonly originalBytes: number; readonly output: string }
}

/**
 * A rendering the chain did not have to produce: a Stage 2 fold, or a mixed-content
 * splice. Held while the typed branches are offered the payload, and shipped only if
 * none of them beats it on bytes.
 *
 * `ship` is what makes holding one honest. The writes a rendering needs — the CCR
 * entries, and for a splice the credit for each section it compressed — happen at
 * the moment the model receives it, never before. Branches were the other half of
 * that rule and did not follow it: they committed their entries and only then asked
 * `adopt`, which could hand the payload back as a fold instead, leaving an entry in
 * the store that no marker in the context points at. Measured through the shipped
 * seam on a forty-path listing under `headroomFoldPolicy: 'max'`: the fold is the
 * delivery and the store holds one entry, with not a single reference in the text.
 */
interface DeferredRender {
  readonly output: string
  readonly bytes: number
  /** Commit this rendering's writes and report its saving. Called at most once. */
  readonly ship: () => void
}

/**
 * The headroom runtime: owns the CCR store and the compressor chain's state,
 * and drives the post-execute waterfall that rewrites oversized tool results.
 */
export class FreeCodeGoHeadroomRuntime {
  /**
   * Durable copies of the originals `store` parks, in the Harness's spill store.
   * The in-memory store stays the fast path; this is what makes a retrieval
   * survive a restart or an expiry. See `ccr-spill.ts` for why the Harness's own
   * spill policy cannot take its place.
   */
  private readonly archive: SpillArchive
  private readonly store: CcrStore
  private readonly logCompressor = new LogCompressor()
  private readonly crusherConfig: SmartCrusherConfig = SMART_CRUSHER_DEFAULTS
  private readonly dedup = new CrossTurnDedup()
  private compressions = 0
  // Fold-competition ledger: see `foldDeferred` in the stats snapshot for what the
  // three counters mean together, and `adopt`/`settleDeferred` for where each
  // one is incremented. They exist because the rule they record is invisible from
  // outside: a panel that only showed `losslessCompressions` could not tell a
  // payload whose fold shipped from one whose fold was beaten to half its size.
  private foldDeferred = 0
  private foldSuperseded = 0
  private foldSettled = 0
  private originalBytes = 0
  private compressedBytes = 0
  private readonly kindCounts: Partial<Record<HeadroomKind, number>> = {}
  private protectedCount = 0
  private retrievals = 0
  /**
   * Writes the store refused at the two branches that check the write themselves
   * (`json`, `html`), as opposed to the compressors that fold their own `put` into
   * an `applied` flag. Reported because the refusal is invisible otherwise and it is
   * the moment compression quality starts to degrade: it is what the whole-payload
   * branches fall through on, and the reason a delivered rendering can be a generic
   * one rather than the one written for the payload's shape.
   */
  private writeRefusals = 0
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly settings: { get(): unknown } | undefined,
    options: {
      readonly readArtifact?: (locator: string) => Promise<string>
      /**
       * Build the store originals are parked in. The default is
       * {@link ArchivingCcrStore} with `CcrStore`'s own default bounds, which is
       * what a deployment gets; a caller that needs different capacity or
       * lifetime bounds composes one over the same archive, so its writes are
       * still the ones the archive sees.
       */
      readonly store?: (archive: SpillArchive) => CcrStore
    } = {},
  ) {
    this.archive = new SpillArchive({
      store: () => this.spillStore(),
      logger: ctx.logger,
      ...(options.readArtifact === undefined ? {} : { readArtifact: options.readArtifact }),
    })
    this.store = options.store?.(this.archive) ?? new ArchivingCcrStore(this.archive)
  }

  /**
   * The mounted spill backend, or `undefined` when the composition has none.
   *
   * Looked up when a write happens rather than when the runtime is built, so the
   * archive works in a composition that mounts the backend after this plugin, and
   * degrades to memory-only in one that mounts none.
   */
  private spillStore(): SpillWriter | undefined {
    return this.ctx.get('spillStore') as SpillWriter | undefined
  }

  /** Attach the post-execute compression waterfall and the retrieve tool. */
  start(): void {
    // Compress oversized model-facing tool results. Failures are contained:
    // a throwing listener must never surface as a broken tool result.
    this.ctx.effect(() => this.ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        if (exec.name === 'headroom_retrieve') return await next()
        // The archive groups artifacts under the owning session, so the owner has
        // to be in place before the compressors run: they write synchronously, and
        // a write that lands with no owner cannot be parked at all.
        this.archive.setOwner(archiveOwner(exec))
        const compressed = await this.compressContent(exec, result)
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

  /**
   * Snapshot the runtime's live state for the panel: whether it is enabled and
   * the compression, fold-competition, protection and retrieval counters.
   * @returns the headroom statistics snapshot.
   */
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
      foldPolicy: this.foldPolicy(),
      foldDeferred: this.foldDeferred,
      foldSuperseded: this.foldSuperseded,
      foldSettled: this.foldSettled,
      codeSkeletonCompressions: this.kindCounts.code ?? 0,
      protectedCount: this.protectedCount,
      ccrEntries: this.store.size,
      ccrBytes: this.store.bytes,
      retrievals: this.retrievals,
      retrieveMisses: this.retrieveMisses,
      ccrWriteRefusals: this.writeRefusals,
      provenance: headroomProvenance(),
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

  /**
   * Whether a reversible render that clears the bar is a delivery (`reversible`, the
   * default) or a candidate like any other stage (`max`). Every held render is
   * covered: a Stage 2 fold of the whole payload, a mixed-content splice that
   * compressed the payload's sections, a fold inside one of those sections, and the
   * cross-turn pointer over a repeat — see {@link DeferredRender}.
   *
   * This is the knob that moves `FOLD_DECISIVE_RATIO`'s effect, and the two settings
   * are genuinely two products rather than a fine-tuning: `reversible` prefers the
   * zero-accuracy-cost rendering whenever it is within a hair of what the chain
   * could produce, and `max` says the context budget wins even where the fold was
   * good enough — measured on the same payloads, a repeated-run log ships at 0.051
   * lossless under `reversible` and at 0.032 lossy under `max`, while a twelve-hunk
   * diff and a shared-prefix search result are compressed identically either way
   * (their folds never cleared the bar). Both policies keep every guarantee the
   * other has: the fold still ships when every branch refuses *or* when none of them
   * beats it on bytes (`adopt` compares — under `max` that comparison is the only
   * thing keeping a demoted fold from being replaced by a bigger, lossier
   * rendering), and every lossy rendering still carries a resolvable marker. The
   * cross-turn pointer is the row where the two policies agree on the model's bytes
   * and differ only on the route: an exact repeat of numbered source is a shape the
   * chain refuses, so the pointer reaches the model at 0.034 under both — on sight
   * under `reversible` (it clears the decisive bar), after being held and settling
   * under `max` — while a *mild* repeat's pointer sits above that bar and is held
   * under both (0.916 or 0.958 of the payload, against 0.539 the prose stage makes
   * of the same bytes — see `headroom-extra.spec.ts`, where the warm and cold
   * deliverables are asserted byte-identical).
   */
  private foldPolicy(): 'reversible' | 'max' {
    const settings = this.settings?.get() as HeadroomSettings | undefined
    return settings?.headroomFoldPolicy === 'max' ? 'max' : 'reversible'
  }

  /**
   * The ratio at or below which a lossless fold is delivered on the spot.
   *
   * One formula, read by both places that decide a fold: the whole-payload Stage 2
   * and the mixed-content section path. They used to compute it separately, and the
   * section copy hard-coded `min(minRatio, FOLD_DECISIVE_RATIO)` — so a fold inside
   * a section was delivered on sight while `headroomFoldPolicy: 'max'` said every
   * fold had to be beaten first. The setting was silently half-applied: measured on
   * a prose + match-block + prose payload whose section folds to 0.265 and whose
   * search compressor answers 0.182, both policies delivered the same bytes and the
   * ledger reported no demotion under `max` at all.
   */
  private foldDecisiveBar(): number {
    return this.foldPolicy() === 'max' ? 0 : Math.min(this.minRatio(), FOLD_DECISIVE_RATIO)
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
      if (skeleton !== undefined) {
        const replaced = this.replaceIfSmaller(result.content, skeleton, 'code')
        // Pinned only once the skeleton really ships: `replaceIfSmaller` leaves a
        // result with several text blocks alone, and an entry the model was never
        // given a marker for is not a promise capacity has to protect.
        if (replaced !== undefined) this.store.pin(skeleton.hash)
        return replaced
      }
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
   * skeleton never leaves an entry the model could retrieve for no reason — and a
   * *refused* write (no slot left that is not already a live promise) is declined
   * too, rather than shipping a skeleton whose marker names nothing. The hash comes
   * back so the caller can pin it once the skeleton is the text the model receives.
   */
  private skeletonizeRead(text: string): { readonly applied: boolean; readonly output: string; readonly hash: string } | undefined {
    const hash = computeKey(text)
    const result = skeletonizeReadOutput(text, hash)
    if (!result.applied) return undefined
    if (this.store.put(hash, text) !== true) return undefined
    return { applied: true, output: result.output, hash }
  }

  // ─── Block pipeline ───────────────────────────────────────────────────────

  /** Compress oversized text blocks; returns replacement blocks or undefined. */
  private async compressContent(exec: { readonly name: string; readonly arguments: unknown }, result: { readonly isError?: boolean; readonly content: readonly ContentBlock[] }): Promise<ContentBlock[] | undefined> {
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
      // The durable locator, when the Harness's store holds this original: a
      // reported saving pays for naming where the bytes went, and a rendering
      // that saved too little to afford it keeps the in-memory path alone.
      out.push({ ...block, text: await attachArchiveNotices(this.archive, compressed, bytes - Buffer.byteLength(compressed, 'utf8')) })
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
    // The pointer is a **candidate**, and the chain is handed the original: a
    // rendering with pointer lines in it is a shape no branch was written to read,
    // which is how a mild repeat used to cost 1.7x the payload's own size (see the
    // candidate block in `compressWorking`). Whether the pointer ships is decided
    // there — on its bar, and on bytes against whatever the chain delivers — and its
    // credit is recorded by `dedupRender`'s `ship`, so it is credited when the model
    // receives it rather than when it was computed. That was the other half of the
    // stage's history: the fold used to be computed and dropped while the panel
    // credited a compression that never reached anyone.
    return this.compressWorking(text, query, bias, originalBytes, this.dedupRender(folded.output, originalBytes))
  }

  /**
   * Stage 0b onward: everything measured against the bytes handed in here.
   *
   * `dedup` is the cross-turn pointer when Stage 0a folded one, and it travels as a
   * candidate rather than a verdict — see `compressWorking`'s candidate block, and
   * `dedupRender` for why the pointer text must not be what the chain is handed.
   */
  private compressWorking(text: string, query: HeadroomQuery, bias: number, originalBytes: number, dedup?: DeferredRender): string | undefined {
    const workingBytes = Buffer.byteLength(text, 'utf8')
    if (workingBytes < MIN_COMPRESSIBLE_CHARS) return undefined

    const minRatio = this.minRatio()
    const acceptRatio = (candidate: string): boolean =>
      Buffer.byteLength(candidate, 'utf8') / Math.max(1, workingBytes) <= minRatio
    const ratioOf = (candidate: string): number =>
      Buffer.byteLength(candidate, 'utf8') / Math.max(1, workingBytes)

    // Stage 1 — mixed content: split interleaved code/JSON/search/prose and compress
    // each section under its own strategy. The splice is a **candidate**, not a
    // delivery: a payload whose sections compress is only a saving if the reassembled
    // text beats what the chain can make of the whole payload, and answering with it
    // unconditionally was measurable as an inversion — the *same* payload went out at
    // 0.684 with one section spliced and at 0.478 when the sections were coloured and
    // therefore refused, i.e. adding terminal escapes improved the compression. See
    // `candidates` below for how the two are compared.
    let splice: DeferredRender | undefined
    if (isMixedContent(text) && !mixedIsActuallyCode(text)) {
      splice = this.compressMixed(text, query, bias)
    }
    const foldCandidates: DeferredRender[] = []

    // Stage 2 — content-type keyed lossless fold.
    //
    // *Decisive*: the fold alone reaches `FOLD_DECISIVE_RATIO`, so it is within a
    // hair of anything the chain could hand back and the reversible copy is what
    // the model receives — the stage's whole point.
    //
    // *Deferred*: the fold is weaker than that, so it is a candidate rather than a
    // delivery. The chain below still sees the **original** payload — not the
    // fold's rendering, which is a shape of its own that no branch was written to
    // read (heading-form search rows are not `path:line:` rows) — and a delivery
    // only takes the fold's place if it is **smaller** than it: `adopt` compares
    // the two and hands back the fold when it is not. The bars alone do not give
    // that, and assuming they did was a real defect — a deferred fold is only
    // above `min(FOLD_DECISIVE_RATIO, minRatio)` while a branch delivery merely has
    // to be at or below `minRatio`, so with the default ratio (0.85) a branch could
    // answer with a rendering *larger* than the fold it demoted (measured: a
    // forty-path listing folds to 0.100 and the prose stage answered 0.517 under
    // `headroomFoldPolicy: 'max'`). If every branch refuses, the fold is what ships
    // (`settleDeferred`), so the worst case for the model is exactly the fold it
    // would have received without this rule, and the only thing the rule can take
    // away is a fold a later stage beat on bytes.
    //
    // This used to return at *any* ratio, which is a veto rather than a
    // preference, and the cost is measurable on every shape a fold touches: a
    // twelve-hunk diff carrying `index` lines folded to 0.931 where the stage
    // behind it ships 0.530 as a subset whose changes stay paired over a
    // retrievable original, a search result whose matches share a directory prefix
    // folded to 0.984 where that stage ships 0.47, and a coloured log — typed
    // `search` before the detector's colour fix, so folded as a heading on its
    // `ESC[32m` prefix — folded to 0.777 where its own compressor delivers 0.173
    // with every fatal line kept by its anchor rule. Each of those payloads
    // reached a folded rendering and stopped there.
    const detection = detectContentType(text)
    // `max` says every render competes — see `foldDecisiveBar` — so the bar is zero
    // and even one that halves the payload has to be beaten before it ships.
    const decisiveBar = this.foldDecisiveBar()
    let foldedShape = false
    const foldKind = detection.contentType === 'search' ? 'search'
      : detection.contentType === 'log' ? 'log'
        : detection.contentType === 'diff' ? 'diff'
          : detection.contentType === 'config' ? 'config'
            : undefined
    if (foldKind !== undefined) {
      const folded = compactLossless(text, foldKind)
      if (folded.applied) {
        foldCandidates.push(this.foldRender(folded.output, workingBytes))
        foldedShape = true
      }
    }
    // Pure path listings (find/ls -1/rg -l). Tried only when the payload's own
    // shape did not fold, which is the precedence this stage has always had: the
    // two folds are alternative readings of the same lines, and the smaller of two
    // readings is a question `compactLossless` already answers inside `search`.
    if (!foldedShape && (detection.contentType === 'text' || detection.contentType === 'search')) {
      const folded = compactLossless(text, 'paths')
      if (folded.applied) foldCandidates.push(this.foldRender(folded.output, workingBytes))
    }

    // ─── One candidate, and the bar that decides what it is ───────────────────
    //
    // Both reversible reads of this payload are now in hand — the mixed-content
    // splice and the content-type fold — and only the smaller of them can matter:
    // they are two renderings of the same bytes, so a byte comparison settles which
    // one the chain would have to beat. The bar then says what that winner *is*:
    //
    // - at or below it, the winner is within a factor of ~1.2 of anything the chain
    //   realistically delivers, and a reversible copy wins that tie → it ships on
    //   sight, which is the whole reason the fold stage exists;
    // - above it, the winner is held (`deferred`) and every typed branch is offered
    //   the payload first. `adopt` compares bytes at each delivery point, so the
    //   held render is what the model receives whenever no branch beats it, and the
    //   ledger's `deferred = superseded + settled` covers both levels of the rule.
    //
    // Deciding the candidate here rather than letting Stage 1 answer for itself is
    // what stopped the splice from being a veto: it used to return before the fold
    // was even computed, so a payload whose sections compressed by a few percent
    // could never be looked at as a whole (measured on prose + a JSON block + prose:
    // 0.684, against 0.478 for the *same* payload with the blocks coloured, where the
    // section refused and the whole-payload stage finally answered).
    //
    // Smallest wins, and ties go to whichever comes first in this order — fold, the
    // dedup pointer, the splice — because at equal bytes the cheapest render to read
    // is the one that needs neither a look back nor a retrieve: a fold keeps every
    // line in place, a pointer refers to an earlier result, and a splice's lossy
    // sections are each one `headroom_retrieve` away. The tie rule is load-bearing
    // rather than theoretical for the fold/splice pair, which land within a byte of
    // each other: measured on prose + thirty matched rows + prose, the whole-payload
    // fold is 0.581 and the splice that folds the same rows as its own section is
    // 0.582.
    //
    // The dedup pointer competes on the same bar, and it is the level where the
    // deferral matters most: a *partial* repeat — a file re-read after an edit, an
    // appended JSON document — folds a run here and there, which breaks the payload's
    // shape (a pointer line inside a JSON body parses as nothing), so a chain handed
    // the pointer text cannot answer with the compressor written for that shape.
    // Measured on a `jq` document whose first four records repeated: the pointer is
    // 0.916, the chain answers 0.539 when it sees the original, and before this the
    // model received 0.916 — the *same* payload was 1.7x bigger with dedup memory
    // than it would have been with none.
    let deferred: DeferredRender | undefined
    for (const candidate of foldCandidates) {
      if (deferred === undefined || candidate.bytes < deferred.bytes) deferred = candidate
    }
    if (dedup !== undefined && (deferred === undefined || dedup.bytes < deferred.bytes)) deferred = dedup
    if (splice !== undefined && (deferred === undefined || splice.bytes < deferred.bytes)) deferred = splice
    if (deferred !== undefined) {
      if (ratioOf(deferred.output) <= decisiveBar) {
        deferred.ship()
        return deferred.output
      }
      this.foldDeferred += 1
    }

    // Stage 3 — type-routed lossy compressors (CCR-backed, recoverable).
    //
    // A refusal here ships the payload verbatim, and whether that refusal *ends*
    // the chain is decided by two different questions — the same two the refusal
    // table in `tests/headroom-branch-refusals.spec.ts` is organised around, with
    // the measured cost of every row. Change one and read that file first:
    //
    // 1. **How was the branch entered?** On a reading of the *whole* payload
    //    (`detectContentType`, or `looksLikeSearchOutput`'s proportion of lines),
    //    or on a reading of a *part* of it? A part reading (`detectTabular`
    //    finding a table in some lines, `isMixedContent` finding sections, both
    //    further down) can never justify ending the chain, because "some lines of
    //    this look like a table" is not a claim about the payload; the table
    //    branch used to end the chain on exactly that, and a report quoting one
    //    small table was delivered verbatim.
    // 2. **Can the surviving lines be read without the absent ones?** A sentence
    //    selector has no notion of a hunk, a log line or a JSON entry, so a
    //    whole-payload verdict normally stands: the payload *is* that type and
    //    shipping it verbatim is the considered answer. Two rows are exceptions,
    //    and both because the unit the model needs is not the line: a *search*
    //    result is a list of homogeneous, independent records, where any subset
    //    states the same kinds of facts, and a *diff* change is a pair of lines
    //    plus the header that locates them — which the text stage now selects as
    //    one unit rather than as lines that can be scored apart. Both then report
    //    how much of the payload they kept. The log row does not qualify: the
    //    class the model needs there is "the errors", and the generic scorer
    //    measurably misses it (2 of 5), while the log branch's own anchor rule
    //    exists for exactly that.
    if (detection.contentType === 'json') {
      // One stage for the whole delivery: the crusher's inline markers and the
      // `hash=` marker for the payload are written against the same budget, so
      // neither can be the write that evicts the other.
      const stage = new StagedCcrStore(this.store)
      const crushed = crushJsonDocument(text, this.crusherConfig, stage, query.query)
      const hash = computeKey(text)
      const withMarker = `${crushed.output}\n[JSON compressed from ${workingBytes} bytes. Retrieve original: hash=${hash}]`
      // The shape and both halves of the ratio, decided before the write so the two
      // kinds of refusal can be told apart below.
      const compressible = crushed.applied && acceptRatio(crushed.output) && acceptRatio(withMarker)
      if (compressible) {
        if (stage.put(hash, text) === true) {
          return this.adopt('json', originalBytes, withMarker, deferred, () => { stage.commit() })
        }
        this.writeRefusals += 1
      }
      // One refusal here is not a verdict about the payload: the store could not hold
      // the original (it needs a slot per opaque cell, and a full session fills it).
      // The rule that a declined JSON payload ships verbatim rests on the refusal
      // being about the *shape* — that the payload is what the crusher says it is and
      // could not be improved — and a full store is not that. Treating it as one used
      // to cost nothing, because "versus verbatim" was the only alternative; with a
      // held render in hand it costs the whole delivery, and the page reaches the
      // model at 0.99 while the prose stage behind this branch would have given 0.50
      // (measured on the capacity gate's own fixture: a payload whose JSON crush is
      // refused by a full store, at 0.989 with the pointer against 0.498 through the
      // stage behind it). So a capacity refusal falls through and the chain keeps
      // its chance; the candidate still settles at the end if nothing else delivers.
      if (!compressible) return this.settleDeferred(deferred)
    }
    if (detection.contentType === 'diff') {
      const diff = stagedWrites(this.store, store => compressDiff(text, DIFF_COMPRESSOR_DEFAULTS, store, bias))
      if (diff.value.applied && acceptRatio(diff.value.compressed)) {
        return this.adopt('diff', originalBytes, diff.value.compressed, deferred, () => { diff.commit() })
      }
      // Falls through, and the condition that had to be met first is now met: a
      // refusal here used to end the chain because the only renderer behind it
      // scored *lines*, and a diff's lines are not independent — a lone `-` states
      // a deletion the payload did not make, and a change line without its hunk
      // header cannot be placed. Measured on the 64-line `git diff -U0` below the
      // old chain: 21 of 30 removals against 14 of 30 additions kept, and no `@@`
      // line at all, which is a different change set, not a smaller one.
      //
      // The text stage now reads a diff's structure: inside a change block it
      // pairs the removals with the additions positionally (how a unified diff is
      // read — the first removal and the first addition are the same edit) and
      // charges the pair as one unit, and it carries the change's locators with it
      // (`diff --git`, `--- `/`+++ `, `@@`), charged once. So the same fixture now
      // arrives as 14 complete changes under their hunk header, 5652 -> 2832 bytes
      // (0.50), every kept removal with its addition, and the marker reports
      // "32 of 64 lines kept". A payload that merely contains `+`/`-` lines is
      // untouched by that rule (measured: a 60-line listing still refuses).
      //
      // The compressor above still wins where it applies: its rendering is
      // hunk-aware and costs the same visit, so a diff it can fold never reaches
      // this line — and a diff it *can't* fold now gets the visit too, where Stage
      // 2 used to answer for it with an index-line strip (0.931 on the twelve-hunk
      // fixture above) before this branch was ever asked.
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
        const hash = computeKey(text)
        const withMarker = `${html.output}\n[HTML compressed from ${workingBytes} bytes. Retrieve original: hash=${hash}]`
        // Both halves of the delivery are asked before either happens: the ratio,
        // and whether the store can hold this original without spending one the
        // model already has a marker for. A refused write means the marker would
        // name nothing, so the extraction is declined and the HTML ships verbatim.
        //
        // Staged like every other branch: the entry and the pin land when — and only
        // when — this rendering is the one that ships.
        const stage = new StagedCcrStore(this.store)
        const compressible = acceptRatio(html.output) && acceptRatio(withMarker)
        if (compressible) {
          if (stage.put(hash, text) === true) {
            return this.adopt('html', originalBytes, withMarker, deferred, () => { stage.commit(); this.store.pin(hash) })
          }
          this.writeRefusals += 1
        }
        // Falls through on a capacity refusal for the same reason the JSON branch
        // does: an extraction the store cannot back is a fact about the store, not
        // about the markup, and the stages behind this one may still deliver.
        if (!compressible) return this.settleDeferred(deferred)
      }
      return this.settleDeferred(deferred)
    }
    if (looksLikeSearchOutput(text) || detection.contentType === 'search') {
      const search = stagedWrites(this.store, store => compressSearch(text, SEARCH_COMPRESSOR_DEFAULTS, store, contextWords(query.query), bias))
      if (search.value.applied && acceptRatio(search.value.compressed)) {
        return this.adopt('search', originalBytes, search.value.compressed, deferred, () => { search.commit() })
      }
      // Falls through — the one whole-payload branch that does (see question 2 in
      // the Stage 3 note above), and the reason is the shape of the payload rather
      // than how it was routed. A search result is a list of *homogeneous,
      // independent* records: which matches survive does not change what the
      // survivors say, so a subset plus a marker is a faithful rendering of the
      // same findings, and the text stage's marker reports how many lines it kept
      // — the reporting gap that made a silent subset unacceptable here is closed
      // in `text-crusher.ts`.
      //
      // Measured on the shipped seam once the text stage stopped re-flowing its
      // input into sentences (it used to cut `path:line:` in half at the `.`
      // before `ts`, which is what made this row a refusal before): nine refused
      // match lines in nine directories, 4319 -> 2013 bytes (0.47), every
      // surviving line whole with its token intact, retrievable through the
      // marker, which now reads "4 of 9 lines kept".
      //
      // That shape is no longer the narrow one. The ordinary case — matches that
      // share a directory or file prefix, which Stage 2 factors into a heading
      // (4310 -> 4239, 0.984) — used to be answered *before* this branch by the
      // fold, and the fold now competes like every other stage instead of returning
      // on sight, so those payloads arrive here too. Measured through the seam on
      // this row's fixtures: the shared-prefix result is delivered at 0.47 with its
      // kept lines whole and its original retrievable, where the fold alone was
      // 0.984. The decision that search may fall through was taken on the *shape*
      // — a subset of homogeneous, independent records states the same kinds of
      // findings — and a 1.6% reversible fold is not a finding about the shape, so
      // it no longer outbids it. The narrow case is what remains of the old
      // behaviour: a result whose fold is decisive still ships folded.
      //
      // The rows that still end the chain do so because the surviving lines
      // cannot be read without the absent ones. A diff's `-`/`+` lines are paired
      // *and* located by the hunk header above them, and the stage keeps neither
      // relation — measured on that row's fixture (a 64-line `git diff -U0`): 21
      // of 30 removals and 14 of 30 additions kept, and no hunk header at all, so
      // what arrives is a change set this payload did not contain. A log's
      // important line is what the scorer misses (2 of the 5 ERROR records kept —
      // salience is a per-word average, so a long record scores below a short
      // informational one), while the log compressor's own anchor rule is the
      // guarantee for exactly that. A count repairs neither: it counts lines,
      // while what went missing is a pairing, a location, or a *class* of line.
    }
    if (detection.contentType === 'log') {
      const stripped = stripAnsi(text)
      const log = stagedWrites(this.store, store => this.logCompressor.compress(stripped, bias, store))
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
      if (log.value.compressed !== stripped && acceptRatio(log.value.compressed)) {
        return this.adopt('log', originalBytes, log.value.compressed, deferred, () => { log.commit() })
      }
      return this.settleDeferred(deferred)
    }
    const tabularDetection = detectTabular(text)
    if (tabularDetection !== undefined) {
      const tabularStage = new StagedCcrStore(this.store)
      const tabular = compressTabular(text, tabularDetection, this.crusherConfig, tabularStage)
      if (tabular.applied && acceptRatio(tabular.output)) {
        const withMarker = `${tabular.output}\n[Table compressed from ${workingBytes} bytes. Retrieve original: hash=${computeKey(text)}]`
        if (acceptRatio(withMarker) && tabularStage.put(computeKey(text), text) === true) {
          return this.adopt('tabular', originalBytes, withMarker, deferred, () => { tabularStage.commit() })
        }
      }
      // Falls through, and that is the point: a shape is not a delivery.
      //
      // This branch used to end the chain unconditionally, which made a table
      // found *anywhere* in a payload enough to switch the whole waterfall off —
      // measured through this seam, a 7.5 KB report of sixty prose sentences
      // with one six-row table in it was delivered verbatim (ratio 1.00, every
      // counter at zero) while the same report without the table compressed to
      // 0.50. Two ordinary shapes starve it: a note after the table makes the
      // ingest's jagged-row guard (#1652) refuse the whole transform, and a
      // table that is a few percent of the payload can be compacted correctly
      // and still miss `acceptRatio` against the preamble it must carry. In
      // both, the table transform delivered nothing and the payload's own text
      // was never priced at all.
      //
      // The other typed branches do end the chain on a refusal, and the
      // difference is not taste: their verdict comes from `detectContentType`
      // over the whole payload, so a declined JSON, HTML or log payload really
      // is that payload, and shipping it verbatim is the considered answer.
      // Here the shape is claimed by a reading of its own — `detectTabular`
      // walks every line, the detector's verdict is sampled from the first
      // fifty — so what ends the chain is at most "some lines of this look like
      // a table", which is not a reason to skip config compaction and prose
      // extraction for a document that merely quotes one. Existing tests hold
      // the other direction: a payload that *is* a table still takes this
      // branch and still says so (`kinds[tabular=1]`, 0.82 for a 60-row table),
      // so preferring it where it delivers is unchanged.
    }
    if (detection.contentType === 'config') {
      const flavor = detectConfigFlavor(text) ?? 'yaml'
      const config = stagedWrites(this.store, store => compressConfig(text, flavor, store))
      if (config.value.applied && acceptRatio(config.value.output)) {
        return this.adopt('config', originalBytes, config.value.output, deferred, () => { config.commit() })
      }
      return this.settleDeferred(deferred)
    }
    // Source code passes through unmangled (original enable_code_aware=false).
    if (detection.contentType === 'code') return this.settleDeferred(deferred)

    // Long prose: extractive sentence selection (READMEs, reports), with
    // custom XML tags protected and restored.
    const protectedProse = protectTags(text, false)
    const prose = stagedWrites(this.store, store => crushText(protectedProse.cleaned, TEXT_CRUSHER_DEFAULTS, store, query.query))
    if (prose.value.applied) {
      const restored = restoreTags(prose.value.compressed, protectedProse.blocks)
      if (acceptRatio(restored)) {
        return this.adopt('prose', originalBytes, restored, deferred, () => { prose.commit() })
      }
    }
    return this.settleDeferred(deferred)
  }

  /**
   * What a deferred render is worth once nothing behind it delivered.
   *
   * A candidate that does not clear `FOLD_DECISIVE_RATIO` is not a delivery, so the
   * chain is offered the payload first — and every branch that refuses one routes
   * its refusal through here rather than returning a bare `undefined`. Two
   * outcomes are possible and both are the intended one: a branch delivered
   * something the candidate does not beat, in which case this is never reached
   * (`adopt` ships the candidate instead); or every branch refused, in which case
   * the candidate is what the model receives, because shipping the payload verbatim
   * would throw away a real saving. Shipping it *here* rather than when it was
   * computed is what keeps the panel honest: it is a compression the model got, and
   * only when the model got it.
   *
   * A branch that refuses a payload which carries no candidate at all (`json`,
   * `html`, `code` — the first two answer for themselves, the third is never
   * compressed) simply gets its `undefined` back, so routing every refusal through
   * this function costs those rows nothing and makes the invariant structural
   * instead of a thing each branch has to remember.
   */
  private settleDeferred(deferred: DeferredRender | undefined): string | undefined {
    if (deferred === undefined) return undefined
    this.foldSettled += 1
    deferred.ship()
    return deferred.output
  }

  /**
   * Ship a typed branch's rendering, and note what became of a deferred fold.
   *
   * Every delivery in Stage 3 goes through here instead of calling `record`
   * directly, which is what makes the ledger exact rather than derived: the three
   * counters then say `deferred = superseded + settled` by construction, and an
   * edit that adds a delivery point without this call is caught by the spec instead
   * of showing up as a quietly larger "superseded" figure.
   *
   * Whether the fold lost is decided here, on bytes, rather than inferred from the
   * bars both candidates had to pass. The deferral's argument is that a fold may
   * only be taken away by a rendering that beats it, and the bars do not deliver
   * that: a deferred fold is above `min(FOLD_DECISIVE_RATIO, minRatio)` while a
   * branch delivery only has to reach `minRatio`, so whenever `minRatio >
   * FOLD_DECISIVE_RATIO` (0.85 > 0.6 by default) the branch could answer with
   * something *larger* than the fold it demoted. Measured through the shipped seam
   * on forty paths sharing a 140-character prefix: the fold is 0.100, and under
   * `headroomFoldPolicy: 'max'` — which defers every fold — the prose stage
   * answered 0.517, five times the bytes and lossy where the fold was reversible.
   * Ties go to the held render: at equal size it is the one that costs no accuracy
   * (a fold is reversible, a splice's lossy sections are each marked), which is the
   * same tie `FOLD_DECISIVE_RATIO` settles for a candidate that clears the bar.
   * `settleDeferred` remains the other landing point — nothing delivered at all.
   *
   * `commit` is the branch's own writes, made here rather than at the call site so
   * that a branch which does *not* ship cannot spend them: every branch used to
   * commit its CCR entries and only then call this, so a payload answered by its fold
   * left the store holding an entry no marker pointed at (measured: one entry, zero
   * references, on the listing above).
   */
  private adopt(
    kind: HeadroomKind,
    originalBytes: number,
    rendered: string,
    deferred: DeferredRender | undefined,
    commit: () => void,
  ): string {
    if (deferred !== undefined && deferred.bytes <= Buffer.byteLength(rendered, 'utf8')) {
      this.foldSettled += 1
      deferred.ship()
      return deferred.output
    }
    commit()
    if (deferred !== undefined) this.foldSuperseded += 1
    this.record(kind, originalBytes, rendered)
    return rendered
  }

  /**
   * The cross-turn dedup pointer, held the way a fold or a splice is.
   *
   * It is a rendering of the payload in which repeated runs became
   * `[↑NL same as earlier tool result: '…']` lines, so it is neither something a
   * typed branch was written to read (a pointer is not a `path:line:` row, a log
   * line, or a JSON entry) nor something that can be handed on: the chain has to see
   * the **original** bytes for its own compressors to apply at all. Its `ship` is
   * the `dedup` credit, which is what the panel counted when this stage returned the
   * pointer on sight.
   */
  private dedupRender(output: string, originalBytes: number): DeferredRender {
    return {
      output,
      bytes: Buffer.byteLength(output, 'utf8'),
      ship: () => this.record('dedup', originalBytes, output),
    }
  }

  /**
   * A Stage 2 fold, held the way a splice is.
   *
   * A fold stages nothing — it is a projection of the payload, so shipping it is
   * only a `record` — but it travels as a {@link DeferredRender} all the same, which
   * is what lets one comparison and one ledger cover both levels of the rule rather
   * than two copies that can drift apart.
   */
  private foldRender(output: string, workingBytes: number): DeferredRender {
    return {
      output,
      bytes: Buffer.byteLength(output, 'utf8'),
      ship: () => this.record('lossless', workingBytes, output),
    }
  }

  /**
   * Split mixed content, compress each section, and offer the splice as a candidate.
   *
   * The splice is *held* rather than returned: whether it ships is a comparison
   * against the whole-payload chain, which is the caller's job (`compressWorking`
   * decides the winning candidate, `adopt`/`settleDeferred` decide at each delivery
   * point). Its `ship` is the only thing that commits the sections' CCR entries and
   * reports their credits, so a splice that loses leaves the panel and the store
   * exactly as it found them.
   */
  private compressMixed(text: string, query: HeadroomQuery, bias: number): DeferredRender | undefined {
    const sections = splitIntoSections(text)
    if (sections.length < 2) return undefined
    // One stage for the whole splice: a section that compressed is only a saving
    // once the reassembled text is smaller than what it replaced, and a splice that
    // loses that comparison must not leave the sections' entries behind — which is
    // why this stage is around the loop rather than around each section.
    //
    // The *credits* wait for the same proof the entries do, which is the rule
    // `compressWorking` applies one level up: a compression is recorded when the
    // model receives it, not when it is computed. Every accepted section is at or
    // below `minRatio` *including* its own marker (the JSON and text gates ask both
    // halves for exactly this reason), so the comparison below is expected to hold —
    // and holding the credits is what keeps that true when it does not: a splice
    // abandoned whole, entries included, leaves the panel untouched instead of
    // reporting a saving nobody got. "Abandoned" now includes losing to the chain:
    // the splice is one candidate among two and only `ship` spends it.
    const stage = new StagedCcrStore(this.store)
    const rendered: string[] = []
    const credits: { readonly kind: HeadroomKind; readonly originalBytes: number; readonly output: string }[] = []
    let changed = false
    for (const section of sections) {
      const compressed = this.compressSection(section, query, bias, stage)
      if (compressed.credit !== undefined) credits.push(compressed.credit)
      if (compressed.text !== section.content) changed = true
      rendered.push(compressed.text)
    }
    if (!changed) return undefined
    const output = rendered.join('\n')
    if (Buffer.byteLength(output, 'utf8') >= Buffer.byteLength(text, 'utf8')) return undefined
    return {
      output,
      bytes: Buffer.byteLength(output, 'utf8'),
      ship: () => {
        stage.commit()
        for (const credit of credits) this.record(credit.kind, credit.originalBytes, credit.output)
      },
    }
  }

  /**
   * Compress one typed section, returning its rendering and the credit it earns.
   *
   * A section is answered by the same rule as a whole payload: a lossless fold that
   * clears {@link foldDecisiveBar} is the delivery, otherwise the compressor written
   * for that shape is asked first and the fold is the fallback. The bar comes from
   * that one helper rather than a local `min(minRatio, FOLD_DECISIVE_RATIO)`, which
   * is what used to leave `headroomFoldPolicy: 'max'` unable to reach a section. The search case used to
   * run the two the other way round — fold first, then hand the *fold's rendering*
   * to the search compressor — and that was not a preference but a loss: the
   * compressor reads `path:line:` rows, a heading-form fold has none, so it refuses
   * a section it can compress by three quarters. Measured on a 5039-byte section of
   * twenty matches in one file: 0.245 compressed from the original, `matches=0` and
   * `applied=false` from the fold, and a mixed payload that should have gone out at
   * 0.47 went out at 0.95. It also recorded the fold *and* the compressor for the
   * same bytes whenever both applied, which doubled the panel's `originalBytes`.
   */
  private compressSection(section: ContentSection, query: HeadroomQuery, bias: number, store: CcrStore): SectionCompression {
    if (section.atomic || section.contentType === 'code') return { text: section.content }
    const bytes = Buffer.byteLength(section.content, 'utf8')
    if (bytes < MIN_COMPRESSIBLE_CHARS) return { text: section.content }
    const minRatio = this.minRatio()
    switch (section.contentType) {
      case 'json': {
        const stage = new StagedCcrStore(store)
        const crushed = crushJsonDocument(section.content, this.crusherConfig, stage, query.query)
        const withMarker = `${crushed.output}\n[JSON compressed. Retrieve original: hash=${computeKey(section.content)}]`
        // Both halves of the delivery are asked, as the whole-payload JSON branch
        // asks them: the marker is part of what ships, so a section that only beats
        // the ratio without it would deliver a rendering above the gate it was
        // accepted under.
        if (crushed.applied && Buffer.byteLength(crushed.output, 'utf8') / bytes <= minRatio
          && Buffer.byteLength(withMarker, 'utf8') / bytes <= minRatio
          && stage.put(computeKey(section.content), section.content) === true) {
          stage.commit()
          return { text: withMarker, credit: { kind: 'json', originalBytes: bytes, output: withMarker } }
        }
        return { text: section.content }
      }
      case 'search': {
        const fold = compactLossless(section.content, 'search')
        const foldBytes = fold.applied ? Buffer.byteLength(fold.output, 'utf8') : 0
        const decisive = fold.applied && foldBytes / bytes <= this.foldDecisiveBar()
        if (decisive) return { text: fold.output, credit: { kind: 'lossless', originalBytes: bytes, output: fold.output } }
        // Demoted, and counted like a demoted whole-payload fold. A section fold that
        // loses to its own compressor is the same event as a payload fold that does,
        // and leaving it out of the ledger made `max` look like a no-op on a payload
        // it changed: measured on prose + a match block + prose, 0.528 delivered
        // under `reversible` and 0.493 under `max` on the same bytes, with all three
        // counters at zero.
        if (fold.applied) this.foldDeferred += 1
        const search = stagedWrites(store, candidate => compressSearch(section.content, SEARCH_COMPRESSOR_DEFAULTS, candidate, contextWords(query.query), bias))
        // The same comparison `adopt` makes, and for the same reason: a branch takes
        // a fold's place only when it is *smaller* (`foldSuperseded` has to mean
        // "beaten on bytes", not "adopted"). No fixture in this directory reaches
        // the refusal below — the compressor drops lines while the fold merges a
        // shared prefix, so wherever it applies it comes out smaller — which is why
        // the rule is stated in code rather than inferred from that measurement: a
        // change to the compressor's keep policy must not be able to ship a bigger
        // rendering than the fold it replaced just because nobody looked.
        if (search.value.applied && Buffer.byteLength(search.value.compressed, 'utf8') / bytes <= minRatio
          && (!fold.applied || Buffer.byteLength(search.value.compressed, 'utf8') < foldBytes)) {
          search.commit()
          if (fold.applied) this.foldSuperseded += 1
          return { text: search.value.compressed, credit: { kind: 'search', originalBytes: bytes, output: search.value.compressed } }
        }
        // The deferred fold, exactly as Stage 2 settles one: it is what the section
        // gets when the compressor does not beat it, and it is better than the
        // section verbatim.
        if (fold.applied) {
          this.foldSettled += 1
          return { text: fold.output, credit: { kind: 'lossless', originalBytes: bytes, output: fold.output } }
        }
        return { text: section.content }
      }
      case 'text': {
        const protectedProse = protectTags(section.content, false)
        const prose = stagedWrites(store, candidate => crushText(protectedProse.cleaned, TEXT_CRUSHER_DEFAULTS, candidate, query.query))
        if (prose.value.applied) {
          const restored = restoreTags(prose.value.compressed, protectedProse.blocks)
          if (Buffer.byteLength(restored, 'utf8') / bytes <= minRatio) {
            prose.commit()
            return { text: restored, credit: { kind: 'prose', originalBytes: bytes, output: restored } }
          }
        }
        return { text: section.content }
      }
      default:
        return { text: section.content }
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
        if (payload !== undefined) return payload
        // The entry is process-local and expires; the Harness's spill store is not.
        // An archived answer is a retrieval that succeeded, so it is deliberately
        // not counted as a miss: the miss counter exists to show the promise
        // decaying, and this is the opposite of decay.
        const archived = await this.archive.recover(args.hash)
        if (archived !== undefined) return archived
        const locator = await this.archive.locatorFor(args.hash)
        this.retrieveMisses += 1
        if (locator !== undefined) {
          // Archived but not readable here: name the locator rather than claim the
          // bytes are gone, because they are not — the model can read the artifact
          // with the file tools the marker's own hint points at.
          throw new Error(`The original for hash "${args.hash}" is no longer held in memory (expired or evicted), and its archived copy at ${locator} could not be read back here. Read it at that locator, or re-run the original tool.`)
        }
        // Tombstone instead of a bare error: the model learns the original
        // is gone for good (TTL/capacity eviction) and must re-run the tool
        // rather than retrying the same hash in a doom loop.
        throw new Error(`The original for hash "${args.hash}" is no longer stored (expired or evicted). The compressed summary you have is all that remains; re-run the original tool if you need the full content again.`)
      },
      presentCall: (args: { readonly hash: string }) => ({ card: 'generic', title: `Retrieve original (hash ${args.hash})` }),
    }))
    this.ctx.effect(() => dispose, 'freecodego: headroom_retrieve tool')
  }
}

/**
 * The call an original is archived for, or `undefined` when the seam carries no
 * agent (a direct or test call). Read the same way the Harness's own spill policy
 * reads it, so both park artifacts under the one owning session.
 */
function archiveOwner(exec: unknown): SpillArchiveOwner | undefined {
  const sessionId = (exec as { readonly agent?: { readonly session?: { readonly header?: { readonly id?: unknown } } } })
    .agent?.session?.header?.id
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const call = exec as { readonly name?: unknown; readonly callId?: unknown }
  return {
    sessionId: sessionId as SessionId,
    toolName: typeof call.name === 'string' && call.name !== '' ? call.name : 'headroom',
    callId: typeof call.callId === 'string' && call.callId !== '' ? call.callId : 'headroom-original',
  }
}

function joinText(content: readonly ContentBlock[]): string {
  return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n')
}

// Re-export for tests and future callers.
export { scoreBatch }
