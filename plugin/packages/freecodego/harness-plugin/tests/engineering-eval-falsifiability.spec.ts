/**
 * A case that measures a copy of the logic it claims to check is decoration: it
 * scores 1 by construction and cannot move when the shipped code regresses. The
 * evaluation is shipped to users as a score, so such a case does not merely
 * waste a line — it reports coverage that does not exist.
 *
 * This gate reads the suite's own source and requires every case to reference at
 * least one production symbol imported into it. The five exceptions below are
 * cases whose subject cannot be measured as a unit (they live in a SQL query, in
 * a percentile over a session replay, or inside an event-driven runtime that
 * needs a full Host context). They are listed explicitly so the debt is visible
 * and cannot grow: adding a sixth means editing this test, which is the point.
 *
 * A second gate covers the same failure from the other side: a fixture fed
 * through `as never` is not checked against the production type it is handed to,
 * so the case keeps scoring after that type moves. Those cases are enumerated
 * below for the same reason — the list may only shrink.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const EVAL_SOURCE = new URL('../src/engineering-eval.ts', import.meta.url)

/**
 * Cases that restate a rule instead of calling it.
 *
 * Each entry names why the measured code is out of reach from a deterministic
 * unit; the real coverage for all five lives in the owning module's own spec
 * (`agent-progress.spec.ts`, `token-usage.spec.ts`, `engineering-memory.spec.ts`).
 */
const RESTATED_ONLY: ReadonlyMap<string, string> = new Map([
  ['memory.relation-via-inference', 'the ranking is a SQL join inside relatedMemories(database, ...)'],

  ['usage.percentile-is-nearest-rank', 'latencyPercentiles is private and only reachable through a session replay'],
  ['progress.stall-window-is-bounded', 'markStalled is private and only reachable through a live watchdog tick'],
  ['progress.idle-never-erases-terminal-state', 'observeStatus is private on an event-driven runtime'],
  ['progress.assistant-message-revives-stalled', 'reviveStalled is private on an event-driven runtime'],
])

/** JavaScript globals and keywords that are not production symbols. */
const NON_PRODUCTION: ReadonlySet<string> = new Set([
  'true', 'false', 'undefined', 'null', 'this', 'new', 'typeof', 'instanceof', 'return', 'const', 'let', 'function',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'Promise', 'Map', 'Set', 'Error', 'RegExp',
  'Symbol', 'BigInt', 'Intl', 'NaN', 'Infinity', 'isFinite', 'isNaN', 'isSafeInteger', 'parseInt', 'parseFloat', 'process',
  'length', 'join', 'split', 'slice', 'filter', 'map', 'some', 'every', 'find', 'flatMap', 'reduce', 'sort', 'includes',
  'indexOf', 'push', 'concat', 'keys', 'values', 'entries', 'toString', 'toFixed', 'padStart', 'replaceAll', 'replace',
  'trim', 'toLowerCase', 'toUpperCase', 'test', 'exec', 'match', 'matchAll', 'has', 'get', 'set', 'delete', 'then',
  'catch', 'finally', 'all', 'race', 'resolve', 'reject', 'now', 'min', 'max', 'round', 'floor', 'ceil', 'abs', 'random',
  'stringify', 'parse', 'at', 'repeat', 'startsWith', 'endsWith', 'substring', 'charCodeAt', 'from', 'isArray', 'freeze',
])

interface CaseSource {
  readonly id: string
  readonly body: string
}

/**
 * Split the suite source into per-case bodies, the way the runner assembles them.
 *
 * A case is an `id` immediately followed by its `suite`, which is the shape
 * {@link CaseSpec} requires and the shape every case in the suite is written in.
 * Matching the `id` line alone was not enough: a fixture object that happens to
 * carry a string `id` at the same indentation — a helper that builds one comment
 * or one report — was read as a case, and since a fixture calls no production
 * symbol it was then reported as a decorative case. It also swallowed the body of
 * the next real case, so the entry that appeared was not even the right one.
 */
function splitCases(source: string): readonly CaseSource[] {
  // `\r?` because the source is checked out with CRLF line endings: a pattern that
  // assumed a bare `\n` matched nothing at all, and a suite that parses as zero
  // cases is a gate that passes by measuring nothing.
  const starts = [...source.matchAll(/\r?\n {4}id: '([^']+)',\r?\n {4}suite: '/gu)]
  return starts.map((match, index) => {
    const from = match.index ?? 0
    const to = starts[index + 1]?.index ?? source.length
    const body = source.slice(from, to)
    const end = body.indexOf('\n  },')
    return { id: match[1] ?? '', body: end === -1 ? body : body.slice(0, end) }
  })
}

/** The named symbols the suite imports from production modules. */
function importedSymbols(source: string): ReadonlySet<string> {
  const symbols = new Set<string>()
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/gu)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part.trim().split(' as ').at(-1)?.trim()
      if (name !== undefined && name !== '' && name !== 'type') symbols.add(name)
    }
  }
  return symbols
}

describe('evaluation case falsifiability', () => {
  it('every case measures production code, or is a listed exception', async () => {
    const source = await readFile(EVAL_SOURCE, 'utf8')
    const production = importedSymbols(source)
    const cases = splitCases(source)
    expect(cases.length, 'the suite source was not parsed').toBeGreaterThan(150)

    const restated: string[] = []
    for (const { id, body } of cases) {
      if (RESTATED_ONLY.has(id)) continue
      const local = new Set([...body.matchAll(/(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu)].map(match => match[1] ?? ''))
      const used = [...body.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)].map(match => match[0])
      const measured = used.some(name => production.has(name) && !local.has(name) && !NON_PRODUCTION.has(name))
      if (!measured) restated.push(id)
    }
    expect(restated, 'a case that calls no production symbol scores 1 no matter what the plugin does').toEqual([])
  })

  it('the exception list names cases that still exist, so a fixed one cannot linger', async () => {
    const ids = new Set(splitCases(await readFile(EVAL_SOURCE, 'utf8')).map(entry => entry.id))
    for (const id of RESTATED_ONLY.keys()) expect(ids.has(id), id).toBe(true)
    // Every exception must carry a reason: an unexplained exemption is how a
    // decorative case gets permanent cover.
    for (const [id, reason] of RESTATED_ONLY) expect(reason.length, id).toBeGreaterThan(20)
  })
})

/**
 * Cases whose fixture is still fed through `as never`, by case id.
 *
 * The cast switches the compiler off for that case: the fixture is shaped like
 * whatever its author had in mind, so when the production type it feeds moves,
 * nothing fails — the case goes on asserting something about a shape that no
 * longer exists. The refusal-identity cases were converted by naming the
 * parameter type, with one documented `invalidInput` channel for the inputs no
 * type can express; these entries are what is left.
 *
 * The list may only shrink, and each entry states what is cast and why, because
 * the reason is the thing a later reader needs in order to finish the job.
 */
const UNTYPED_FIXTURES: ReadonlyMap<string, string> = new Map([
  ['guard.doom-loop-detection', 'the tool-run context the guard reads, built field by field for two turns'],
  ['guard.doom-loop-exemption', 'the same tool-run context, for the exempted tool'],
  ['rehydration.stale-memory-is-flagged', 'the memory view the rehydration text builder takes'],
  ['catalog.gateway-status-mapping', 'status rows compared one at a time against the expected verdict'],
  ['catalog.logfare-media-detected-from-endpoints', 'a Logfare model row reduced to the three fields the detector reads'],
  ['community.install-target-resolution', 'a catalog row whose npm and url fields are absent'],
  ['account.snapshot-redacts-by-status', 'the coordinator snapshot, entered at one status per row'],
  ['adapter.image-content-detection', 'a message whose content parts are reduced to their type names'],
  ['routing.filters-unusable-models-and-dedups', 'the settings value the model filter reads'],
  ['routing.empty-catalog-is-authoritative-when-it-answers', 'the settings value the model filter reads'],
  ['routing.never-re-enables-an-explicit-opt-out', 'the settings value the model filter reads'],
  ['routing.no-write-when-nothing-changed', 'the settings value the model filter reads'],
  ['spec.task-derivation-order', 'the memory records the task list is derived from'],
])

describe('evaluation fixture typing', () => {
  it('names every case the compiler no longer checks, and no others', async () => {
    const source = await readFile(EVAL_SOURCE, 'utf8')
    // Comments are stripped first: one case's `as never` mentions only appear in
    // the note explaining that it was converted, which would otherwise give it
    // permanent residency on this list.
    const untyped = splitCases(source)
      .filter(({ body }) => /as never/u.test(body.replace(/(^|\s)\/\/.*$/gmu, '')))
      .map(({ id }) => id)
      .sort()
    // Equality rather than "no more than": a converted case has to drop its
    // entry, so the debt cannot be inherited silently by the next reader.
    expect(untyped, 'a case feeding a fixture through a cast is not checked by the compiler')
      .toEqual([...UNTYPED_FIXTURES.keys()].sort())
    for (const [id, reason] of UNTYPED_FIXTURES) expect(reason.length, id).toBeGreaterThan(20)
  })
})
