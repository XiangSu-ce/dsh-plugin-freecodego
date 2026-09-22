/**
 * Prose text crusher — TypeScript port of Headroom's
 * `crates/headroom-core/src/transforms/text_crusher/`, © Headroom
 * Maintainers, Apache-2.0.
 *
 * Extractive selection for long text tool output (READMEs, error reports,
 * generated documentation): the unit is a **line** — a paragraph that is one long
 * line is decomposed into sentences, and on a diff the unit is the *change*, see
 * below — units are scored on recency, salience
 * (digits, failure vocabulary, ALL-CAPS, dotted identifiers) and short-unit
 * preference, then selected in descending score order until the character budget
 * is spent and emitted in the original sequence. Every unit is emitted verbatim —
 * zero rewriting, zero merging.
 *
 * Line-preserving, and why that is the invariant
 * ----------------------------------------------
 * The **selection unit** used to be a sentence, split at `.`, `!`, `?` or a
 * newline with the terminator kept on the unit, and the rendering joined the
 * selected units with `''`. So a unit could be a bare `"\n"` — one line break,
 * competing with the prose for the same budget and dropped on its own — and any
 * `.` inside a line (a path, a version, an abbreviation) made the pieces of that
 * line independently selectable. Both are visible in the rendering:
 *
 * | payload (as the gates ship it) | before | after |
 * |---|--:|--:|
 * | 40 log records whose text carries a sentence | 2 lines, 1 whole | 20 lines, 20 whole |
 * | 64-line `git diff -U0` | 22/30 removals, 0/30 additions, no hunk header | 36 lines, all of them payload lines |
 * | 9-match `grep` result | 3/9 `path:line:` tokens whole, the rest glued | 4/9 whole, none glued |
 * | 60 lines of wrapped prose | 2 lines | 30 lines |
 * | 45 lines of CRLF text | 2 lines, endings gone | 22 lines, endings kept |
 *
 * The number that matters in that table is how many of the payload's lines arrive
 * *as lines*. Before, the rendering stated things the payload did not: a run of
 * records as one record, a diff with one side missing and no header locating it,
 * a search hit whose text had been glued to another hit's.
 *
 * So the unit is now **the line**, and the emitted text is built line by line:
 *
 * 1. A line whose content is at most {@link RECORD_LINE_CHARS} is one unit, kept
 *    whole or dropped whole. Record-shaped payloads — diffs, logs, search
 *    results, listings, markdown — are made of these.
 * 2. A longer line (a paragraph that happens to be a single long line) is
 *    decomposed into sentences, which may be selected individually. Without
 *    this, a one-line 7 KB document would be a single unit that blows the
 *    budget and nothing would ever be selected.
 * 3. Emission walks the payload's **lines** in order. A line contributes
 *    nothing if none of its units was selected, or the concatenation of its
 *    selected units if any was, and it always ends with its own terminator —
 *    which is stored on the line rather than inside its last unit, so a dropped
 *    final sentence can no longer take the line break with it.
 *
 * The invariant this buys, which the gates assert: the rendering's lines are a
 * subset of the payload's, in order, and no two payload lines are ever
 * concatenated — measured as zero lines in the rendering that the payload did not
 * contain, on every row of the table above (`text-crusher-line-preserving`).
 *
 * The unit is a change, when the payload is a diff
 * -----------------------------------------------
 * Lines are not always independent, and a diff is the case that matters: a `-`
 * line is half of a replacement — shown without its `+` it states a deletion the
 * payload never made — and a change line without the `@@` header above it cannot
 * be placed in the file at all. Keeping whole lines is not enough there, and the
 * rows of the table above say so from the other side: on the 64-line `git diff -U0`
 * the line rule kept 21 of 30 removals against 14 of 30 additions and no header.
 *
 * So on a payload {@link readDiffPairing} recognises, the unit is the change:
 * the removals and the additions of one change block are paired positionally,
 * the two halves are charged and selected together, and the lines that locate
 * them travel along, charged once. The line is still the unit of *output* — the
 * rendering is built from the payload's lines in order, so the invariant above is
 * untouched — and the marker still counts lines. The same fixture, with that rule
 * in place: 5652 -> 2832 bytes (0.50), "32 of 64 lines kept", made of 14 changes
 * — each one a removal with its addition — under the `@@` header that locates
 * them, with the `diff --git`/`--- `/`+++ ` header of the file they are in.
 *
 * A payload that merely contains `+`/`-` lines is untouched by that rule: the
 * pairing is only read when the payload really is a diff — at least one `@@`
 * header, and a change block to pair — so a listing, a lockfile diff inside prose
 * or a code sample stays on the line rule (measured: a 60-line listing with 20 `+`
 * lines still refuses).
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/headroom/text-crusher
 */

import type { CcrStore } from './ccr.ts'
import { computeKey } from './ccr.ts'
import { scoreBatch } from './relevance.ts'

/**
 * Tunables for extractive prose compaction: the size floor, the target ratio,
 * the per-feature weights, and the ratio the rendering must beat to be adopted.
 */
export interface TextCrusherConfig {
  /** Minimum characters before compression is attempted. */
  minBytes: number
  /** Target output as a fraction of the input. */
  targetRatio: number
  /** Weight of a unit's recency (position) in its score. */
  wRecency: number
  /** Weight of salience features. */
  wSalience: number
  /** Weight of short-unit preference. */
  wShort: number
  /** Weight of query relevance (BM25 term overlap). */
  wRelevance: number
  /** Accept only when the rendering is below this ratio of the original. */
  maxRatio: number
}

/** Default text-crusher tunables. */
export const TEXT_CRUSHER_DEFAULTS: TextCrusherConfig = {
  minBytes: 4_096,
  targetRatio: 0.5,
  wRecency: 1.0,
  wSalience: 1.0,
  wShort: 0.25,
  wRelevance: 1.5,
  maxRatio: 0.8,
}

/**
 * A hunk header, as `diff-compressor.ts` reads it: this stage must agree with
 * that module about what locates a change, or a pair could be kept under a header
 * the branch would not have written.
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u

/**
 * The two halves of the pairing this stage preserves on a diff-shaped payload: a
 * change is selected as a change, not as two independently scorable lines.
 */
interface DiffPairing {
  /** Payload line -> the line that is the other half of its change. */
  readonly partners: ReadonlyMap<number, number>
  /**
   * Payload line -> the lines that locate it (`diff --git`, `--- `/`+++ `, `@@`),
   * charged once each and emitted wherever they sit in the payload.
   */
  readonly locators: ReadonlyMap<number, readonly number[]>
}

/**
 * Read a payload's diff structure, if it has one.
 *
 * This is the module's only shape-specific rule, and it exists because a diff is
 * the one line-structured payload whose *lines are not independent*: a lone `-`
 * states a deletion the payload did not make (it is half of a replacement), and a
 * change line without the hunk header above it cannot be placed in the file. Both
 * relations are lost by scoring lines independently, which is what this stage did
 * before — measured on a 64-line `git diff -U0`: 21 of 30 removals against 14 of
 * 30 additions kept, and no `@@` line at all.
 *
 * Within one change block (the run of change lines between context lines), the
 * removals and the additions are paired **positionally**, which is how a unified
 * diff is read: the first removal and the first addition describe the same edit.
 * Whatever the shorter side leaves over is a plain deletion or insertion and needs
 * no partner. Only lines that are whole units participate — a line long enough to
 * be decomposed into sentences is not something a pairing can carry intact, and
 * the caller passes the set it can honour.
 * @returns the diff Pairing, or undefined when the payload is not a diff-shaped one with at least one change block.
 * @param lines - the payload's lines.
 * @param whole - indices of lines this stage may select as one unit.
 */
function readDiffPairing(lines: readonly SourceLine[], whole: ReadonlySet<number>): DiffPairing | undefined {
  const partners = new Map<number, number>()
  const locators = new Map<number, readonly number[]>()
  let fileHeader: readonly number[] = []
  let hunkHeader: number | undefined
  let removals: number[] = []
  let additions: number[] = []
  let sawHunk = false

  /** A change block ended: pair its halves and give every change its locators. */
  const closeBlock = (): void => {
    const locator = hunkHeader === undefined ? undefined : [...fileHeader, hunkHeader]
    const pairs = Math.min(removals.length, additions.length)
    for (let index = 0; index < pairs; index += 1) {
      const removed = removals[index]!
      const added = additions[index]!
      partners.set(removed, added)
      partners.set(added, removed)
    }
    if (locator !== undefined && locator.every(line => whole.has(line))) {
      for (const line of [...removals, ...additions]) locators.set(line, locator)
    }
    removals = []
    additions = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const content = lines[index]!.content
    const next = lines[index + 1]?.content
    if (content.startsWith('diff --git ') || content.startsWith('Index: ')) {
      closeBlock()
      fileHeader = [index]
      hunkHeader = undefined
      continue
    }
    // `--- ` opens a file header only when `+++ ` follows, which is the rule
    // `parseDiff` uses and the only reading under which a removal whose text
    // begins with `--` is not mistaken for one.
    if (content.startsWith('--- ') && next?.startsWith('+++ ') === true) {
      closeBlock()
      fileHeader = [...fileHeader, index, index + 1]
      hunkHeader = undefined
      index += 1
      continue
    }
    if (HUNK_HEADER.test(content)) {
      closeBlock()
      sawHunk = true
      hunkHeader = index
      continue
    }
    if (hunkHeader !== undefined && content.startsWith('-') && !content.startsWith('---')) {
      removals.push(index)
      continue
    }
    if (hunkHeader !== undefined && content.startsWith('+') && !content.startsWith('+++')) {
      additions.push(index)
      continue
    }
    // Context and metadata end the block: changes on either side of one are not
    // halves of the same edit.
    closeBlock()
  }
  closeBlock()
  if (!sawHunk || partners.size === 0) return undefined
  return { partners, locators }
}

/**
 * Longest line treated as one indivisible unit.
 *
 * Well above every record shape this stage sees (log lines, search matches,
 * diff lines, markdown at 80–100 columns) and well below one long paragraph, so
 * a line over it is prose that must stay splittable: a single-unit 7 KB line
 * cannot fit the budget and would make the stage a no-op for exactly the
 * documents it was written for.
 */
export const RECORD_LINE_CHARS = 512

/** One payload line: its content, and the terminator this stage always re-emits. */
interface SourceLine {
  readonly content: string
  /** `\n`, `\r\n`, or `''` for a final line with no terminator. */
  readonly terminator: string
}

/** Split into lines, each with its own terminator kept intact. */
function splitLines(text: string): readonly SourceLine[] {
  const lines: SourceLine[] = []
  for (const chunk of text.split(/(?<=\n)/u)) {
    if (chunk === '') continue
    const terminator = chunk.endsWith('\r\n') ? '\r\n' : chunk.endsWith('\n') ? '\n' : ''
    lines.push({ content: chunk.slice(0, chunk.length - terminator.length), terminator })
  }
  return lines
}

/**
 * Split a paragraph into sentences, each keeping its own terminal punctuation.
 *
 * The terminator is *not* part of the unit's content: it is re-emitted with the
 * line whether or not the sentence that carried it survived.
 */
function splitSentences(text: string): readonly string[] {
  const sentences: string[] = []
  let current = ''
  for (const ch of text) {
    current += ch
    if (ch === '.' || ch === '!' || ch === '?' || ch === '。' || ch === '！' || ch === '？') {
      sentences.push(current)
      current = ''
    }
  }
  if (current !== '') sentences.push(current)
  return sentences
}

/** Salience: failure vocabulary outweighs digits, ALL-CAPS, dotted identifiers. */
function salienceScore(sentence: string): number {
  const trimmed = sentence.trim()
  if (trimmed === '') return 0
  const words = trimmed.split(/\s+/u).filter(Boolean)
  if (words.length === 0) return 0
  let salient = 0
  for (const word of words) {
    if (/\b(?:error|fail(?:ed|ure)?|fatal|crash|critical|deprecated|todo|fixme|note|important|warning|must|never|always)\b/i.test(word)) salient += 3
    else if (/\d/u.test(word)) salient += 1
    else if (word.length > 2 && word === word.toUpperCase() && /[A-Z]/u.test(word)) salient += 1
    else if (/^[a-z][\w.]*\.[\w.]+$/iu.test(word)) salient += 1
  }
  return salient / words.length
}

/**
 * Outcome of one prose compaction: the rendering, whether it was adopted, and
 * the CCR key when the dropped text was stashed.
 */
export interface TextCrushResult {
  readonly compressed: string
  readonly applied: boolean
  readonly cacheKey: string | undefined
}

/** One selection unit: a record line, or one sentence of a paragraph line. */
interface Unit {
  readonly text: string
  /** Index of the payload line this unit belongs to. */
  readonly line: number
  /** Position within its line, so a partly selected paragraph keeps its order. */
  readonly order: number
}

/**
 * Extractively compress long text without ever re-flowing it.
 *
 * Units are scored (recency + salience + query relevance + brevity), the top
 * ones are taken within the character budget, and the rendering is rebuilt from
 * the payload's own lines so that what arrives is a subset of the payload's
 * lines rather than a re-flow of its sentences. The full text travels with a
 * `hash=` marker whenever a store is mounted.
 * @param text - the text to process.
 * @param cfg - the text-crusher settings to apply.
 * @param store - the store to read, when one is mounted.
 * @param query - the caller's query, used to score unit relevance.
 * @returns the text compaction result.
 */
export function crushText(text: string, cfg: TextCrusherConfig, store: CcrStore | undefined, query = ''): TextCrushResult {
  const originalBytes = Buffer.byteLength(text, 'utf8')
  if (originalBytes < cfg.minBytes) return { compressed: text, applied: false, cacheKey: undefined }

  const lines = splitLines(text)
  const units: Unit[] = []
  /** Line index -> the unit that is that whole line, for lines kept as one. */
  const wholeLineUnit = new Map<number, number>()
  for (const [index, line] of lines.entries()) {
    if (line.content.length <= RECORD_LINE_CHARS) {
      wholeLineUnit.set(index, units.length)
      units.push({ text: line.content, line: index, order: 0 })
      continue
    }
    for (const [order, sentence] of splitSentences(line.content).entries()) {
      units.push({ text: sentence, line: index, order })
    }
  }
  if (units.length < 3) return { compressed: text, applied: false, cacheKey: undefined }

  // A diff's lines are paired, so the change — not the line — is the unit this
  // stage selects there. `readDiffPairing` returns nothing for anything else, so
  // this is inert on prose, logs and listings.
  const pairing = readDiffPairing(lines, new Set(wholeLineUnit.keys()))

  // Query-relevance per unit (original w_relevance; term-overlap proxy for the
  // shared BM25 scorer).
  const queryTerms = query.toLowerCase().match(/[a-z0-9_]{3,}/gu) ?? []
  const relevanceScores = queryTerms.length > 0
    ? scoreBatch(units.map(unit => unit.text), query)
    : undefined

  const budget = Math.floor(originalBytes * cfg.targetRatio)
  const scored = units.map((unit, index) => {
    // Recency is the *line's* position, not the unit's: for a paragraph split
    // into sentences, "how recent" is where the paragraph sits in the payload.
    const recency = (unit.line + 1) / Math.max(1, lines.length)
    const salience = salienceScore(unit.text)
    const chars = Array.from(unit.text).length
    const short = chars <= 120 ? 1 : 0
    const relevance = relevanceScores?.[index]?.score ?? 0
    const score = cfg.wRecency * recency + cfg.wSalience * salience + cfg.wShort * short + cfg.wRelevance * relevance
    return { unit, index, score, bytes: Buffer.byteLength(unit.text, 'utf8') }
  })

  // Near-duplicate suppression: skip a candidate that shares its 8-gram
  // signature with an already-selected unit.
  const shingle = (sentence: string): string => {
    const words = sentence.toLowerCase().split(/\s+/u).filter(Boolean)
    return words.slice(0, 8).join('\u0000')
  }
  const selected = new Set<number>()
  const seenShingles = new Set<string>()
  /** Lines whose bytes this budget has already paid for — a pair, or a locator. */
  const charged = new Set<number>()
  const bytesOfLine = (index: number): number => Buffer.byteLength(lines[index]!.content, 'utf8')
  let used = 0
  for (const candidate of [...scored].sort((a, b) => b.score - a.score || a.unit.line - b.unit.line || a.unit.order - b.unit.order)) {
    // Already taken, as the other half of a change or as a locator of one.
    if (selected.has(candidate.index)) continue
    // What a diff change costs: both halves (`partners`) and, once per payload,
    // the lines that say where the change sits (`locators`). A change is entered
    // by whichever half scores higher — the sort order is the score order — and
    // then charged for both, which is what makes it impossible to keep one side
    // and drop the other.
    const partner = pairing?.partners.get(candidate.unit.line)
    const travel = [...(partner === undefined || charged.has(partner) ? [] : [partner]), ...(pairing?.locators.get(candidate.unit.line) ?? []).filter(line => !charged.has(line))]
    const extraBytes = travel.reduce((total, line) => total + bytesOfLine(line), 0)
    if (used + candidate.bytes + extraBytes > budget) continue
    const signature = shingle(candidate.unit.text)
    if (seenShingles.has(signature)) continue
    selected.add(candidate.index)
    for (const line of travel) {
      const index = wholeLineUnit.get(line)
      if (index !== undefined) selected.add(index)
      charged.add(line)
    }
    charged.add(candidate.unit.line)
    seenShingles.add(signature)
    used += candidate.bytes + extraBytes
  }
  if (selected.size === 0) return { compressed: text, applied: false, cacheKey: undefined }

  // Rebuild from the payload's own lines: a line contributes its selected units
  // in order, then its own terminator. Lines with nothing selected contribute
  // nothing at all, and no line's content is ever appended to another's.
  const keptByLine = new Map<number, { order: number; text: string }[]>()
  for (const [index, item] of scored.entries()) {
    if (!selected.has(index)) continue
    const bucket = keptByLine.get(item.unit.line) ?? []
    bucket.push({ order: item.unit.order, text: item.unit.text })
    keptByLine.set(item.unit.line, bucket)
  }
  const compressedBody = lines
    .map((line, index) => {
      const kept = keptByLine.get(index)
      if (kept === undefined) return ''
      return `${kept.sort((a, b) => a.order - b.order).map(entry => entry.text).join('')}${line.terminator}`
    })
    .join('')
  if (store === undefined) {
    // Nothing to retrieve from, so no marker travels with the body and adoption is
    // the body's own ratio.
    const applied = Buffer.byteLength(compressedBody, 'utf8') / originalBytes < cfg.maxRatio
    return { compressed: applied ? compressedBody : text, applied, cacheKey: undefined }
  }
  // The marker is part of what ships, so it is part of the ratio that decides
  // whether anything ships. Measuring adoption *without* it left a dead band: the
  // body passed, the marker pushed the rendering back over `maxRatio`, and the
  // original was delivered while its entry was already in CCR with nothing in the
  // conversation naming it — the orphan `CcrStore.put` documents as unacceptable,
  // because it takes a slot an earlier result's live `hash=` marker still needs.
  //
  // Declining in that band also protects the opposite direction: adopting the
  // body alone would ship a shortened rendering with no `hash=` at all, which is
  // unrecoverable, and the marker exists precisely to prevent that.
  // What was dropped is part of what ships, not a detail kept internally.
  // A marker that names only the original's size tells the model the full text
  // exists somewhere; it does not tell it that the view in front of it is
  // partial. Two payload shapes make that the difference between a usable
  // rendering and a trap: a list of independent records (a search result) whose
  // subset reads as the whole answer, and a payload where the *count* is itself
  // the finding. So the marker counts the units: lines for a line-structured
  // payload, sentences when the payload is one long paragraph.
  const droppedNotice = lines.length > 1
    ? `${keptByLine.size} of ${lines.length} lines kept`
    : `${selected.size} of ${units.length} sentences kept`
  const cacheKey = computeKey(text)
  const withMarker = `${compressedBody}\n[Text compressed from ${originalBytes} bytes: ${droppedNotice}. Retrieve full text: hash=${cacheKey}]`
  if (Buffer.byteLength(withMarker, 'utf8') / originalBytes >= cfg.maxRatio) {
    return { compressed: text, applied: false, cacheKey: undefined }
  }
  // The rendering is lossy, so it ships only with its original stored. A refused
  // write — an attempt with no room left, see `StagedCcrStore.put` — means the
  // marker would name nothing, and a shortened text with no marker cannot be
  // recovered at all, so the rendering is declined instead.
  if (store.put(cacheKey, text) !== true) return { compressed: text, applied: false, cacheKey: undefined }
  return { compressed: withMarker, applied: true, cacheKey }
}
