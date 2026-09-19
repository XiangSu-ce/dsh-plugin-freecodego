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

/** Split the suite source into per-case bodies, the way the runner assembles them. */
function splitCases(source: string): readonly CaseSource[] {
  return source.split("\n    id: '").slice(1).map((chunk) => {
    const id = chunk.slice(0, chunk.indexOf("'"))
    const end = chunk.indexOf('\n  },')
    return { id, body: end === -1 ? chunk : chunk.slice(0, end) }
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
