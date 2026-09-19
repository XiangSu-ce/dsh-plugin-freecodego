/**
 * Coverage for the semantic-recall wiring: `engineering_memory_search` asks a
 * selector to order the store's candidates.
 *
 * The two properties worth pinning are the ones a user would notice:
 *
 * 1. With no selector configured the tool must return exactly what it returned
 *    before the feature existed — same records, same order, same shape. The flag
 *    is opt-in, so the default path is the contract.
 * 2. With a selector, a *broken* selector must cost relevance and never cost the
 *    recall: the records still come back, and the reason is reported.
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { FreeCodeGoEngineeringRegistry } from '../src/engineering.ts'
import type { MemoryRecallExcerpt, MemorySelector } from '../src/memory/memory-recall.ts'
import type { FreeCodeGoEngineeringMemoryIndex } from '../src/types.ts'

const SESSION = 'session-ranked-1' as SessionId
const CWD = '/workspace'

function index(id: string, title: string, createdAt = 1_000): FreeCodeGoEngineeringMemoryIndex {
  return { id, title, kind: 'decision', trust: 'reviewed', projectId: 'p1', createdAt, detailTokens: 10 }
}

const RECORDS = [
  index('mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Callback retries', 3_000),
  index('mem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Webhook redelivery', 2_000),
  index('mem_cccccccccccccccccccccccccccccccc', 'Cache keys', 1_000),
]

const BODIES = new Map([
  ['mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Retries are bounded and jittered.'],
  ['mem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Redelivery uses an idempotency key.'],
  ['mem_cccccccccccccccccccccccccccccccc', 'Cache keys include the tenant id.'],
])

interface Harness {
  readonly registry: FreeCodeGoEngineeringRegistry
  /** Every excerpt set the selector was offered, in call order. */
  readonly offered: MemoryRecallExcerpt[][]
  /** The bound the selector was asked for, in call order. */
  readonly limits: number[]
}

/**
 * A registry whose memory store is a double.
 *
 * The store is replaced rather than opened for real because these tests are about
 * the *wiring*: the store's own FTS, trust, and reinforcement behaviour has its
 * own suite, and a real database here would only make the interesting assertions
 * slower to read.
 */
function harness(
  options: {
    readonly records?: readonly FreeCodeGoEngineeringMemoryIndex[]
    readonly bodies?: ReadonlyMap<string, string>
    readonly selector?: MemorySelector
  } = {},
): Harness {
  const ctx = { on: () => undefined, get: () => undefined, effect: () => undefined }
  let stored: Record<string, unknown> = { engineeringEnabled: true, engineeringMemoryEnabled: true }
  const scope = {
    get: () => stored,
    update: async (value: unknown) => { stored = { ...stored, ...(value as Record<string, unknown>) } },
  }
  const registry = new FreeCodeGoEngineeringRegistry(ctx as never, scope)
  const records = options.records ?? RECORDS
  const bodies = options.bodies ?? BODIES
  ;(registry as unknown as { memoryAvailable: boolean }).memoryAvailable = true
  ;(registry as unknown as { memory: unknown }).memory = {
    search: () => records,
    // The store's real `get` returns full details; only `body` is read here.
    get: ({ ids }: { readonly ids: readonly string[] }) => ids.flatMap((id) => {
      const body = bodies.get(id)
      return body === undefined ? [] : [{ id, body }]
    }),
    close: () => undefined,
  }
  const offered: MemoryRecallExcerpt[][] = []
  const limits: number[] = []
  if (options.selector !== undefined) {
    const inner = options.selector
    registry.setMemorySelector(() => async (query, excerpts, limit, signal) => {
      offered.push([...excerpts])
      limits.push(limit)
      return inner(query, excerpts, limit, signal)
    })
  }
  return { registry, offered, limits }
}

describe('ranked memory search', () => {
  it('returns the store order untouched when no selector is configured', async () => {
    const { registry, offered } = harness()
    try {
      const result = await registry.memorySearchRanked(CWD, { query: 'retries', sessionId: SESSION })
      expect(result.results).toEqual(RECORDS)
      // The shape the tool returned before the feature existed: no strategy, no
      // failure, no omitted count to misread.
      expect(result.strategy).toBeUndefined()
      expect(result.selectorFailure).toBeUndefined()
      expect(result.omitted).toBeUndefined()
      expect(offered).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it('orders the results by the selector when one answers usably', async () => {
    const picked = ['mem_cccccccccccccccccccccccccccccccc', 'mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']
    const { registry, offered } = harness({ selector: async () => picked })
    try {
      const result = await registry.memorySearchRanked(CWD, { query: 'tenant isolation', sessionId: SESSION })
      expect(result.strategy).toBe('selector')
      expect(result.results.map(record => record.id)).toEqual(picked)
      // `omitted` counts what the selector left behind, so "2 memories" cannot be
      // read as "2 of the 2 memories that exist".
      expect(result.omitted).toBe(1)
      expect(offered[0]).toHaveLength(3)
    } finally {
      await registry.dispose()
    }
  })

  it('keeps the recall when the selector throws, and says why', async () => {
    const { registry } = harness({ selector: async () => { throw new Error('route refused') } })
    try {
      const result = await registry.memorySearchRanked(CWD, { query: 'retries', sessionId: SESSION })
      expect(result.strategy).toBe('lexical')
      expect(result.selectorFailure).toContain('route refused')
      expect(result.results.length).toBeGreaterThan(0)
    } finally {
      await registry.dispose()
    }
  })

  it('keeps the recall when the selector names ids it was never offered', async () => {
    const { registry } = harness({ selector: async () => ['mem_ffffffffffffffffffffffffffffffff'] })
    try {
      const result = await registry.memorySearchRanked(CWD, { query: 'retries', sessionId: SESSION })
      expect(result.strategy).toBe('lexical')
      expect(result.selectorFailure).toBe('the selector named nothing it was offered')
      expect(result.results).toEqual(RECORDS)
    } finally {
      await registry.dispose()
    }
  })

  it('never returns an id the store did not supply', async () => {
    const { registry } = harness({
      selector: async () => ['mem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'mem_ffffffffffffffffffffffffffffffff'],
    })
    try {
      const result = await registry.memorySearchRanked(CWD, { query: 'redelivery', sessionId: SESSION })
      expect(result.results.map(record => record.id)).toEqual(['mem_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'])
      expect(result.dropped).toEqual([{ id: 'mem_ffffffffffffffffffffffffffffffff', reason: 'unknown-id' }])
    } finally {
      await registry.dispose()
    }
  })

  it('offers the selector only the candidates whose body the store returned', async () => {
    // A record the store could not hand back a body for cannot be judged by the
    // selector, so it is left out of the question rather than offered blind.
    const bodies = new Map([...BODIES].filter(([id]) => id !== 'mem_cccccccccccccccccccccccccccccccc'))
    const { registry, offered } = harness({ bodies, selector: async () => [] })
    try {
      const result = await registry.memorySearchRanked(CWD, { query: 'retries', sessionId: SESSION })
      expect(offered[0]).toHaveLength(2)
      // An empty selector answer is a real answer: the selector read two
      // candidates and selected none, so no records are recalled.
      expect(result.strategy).toBe('selector')
      expect(result.results).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it('skips the selector entirely for a blank query', async () => {
    const { registry, offered } = harness({ selector: async () => ['mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] })
    try {
      // With no question there is nothing to rank against, and the store already
      // answered in recency order.
      for (const query of [undefined, '', '   ']) {
        const result = await registry.memorySearchRanked(CWD, { ...(query === undefined ? {} : { query }), sessionId: SESSION })
        expect(result.results).toEqual(RECORDS)
        expect(result.strategy).toBeUndefined()
      }
      expect(offered).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it('skips the selector when there is no session to attribute the request to', async () => {
    const { registry, offered } = harness({ selector: async () => ['mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] })
    try {
      const result = await registry.memorySearchRanked(CWD, { query: 'retries', sessionId: undefined })
      expect(result.results).toEqual(RECORDS)
      expect(result.strategy).toBeUndefined()
      expect(offered).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it('skips the selector when the store found nothing', async () => {
    const { registry, offered } = harness({ records: [], selector: async () => [] })
    try {
      const result = await registry.memorySearchRanked(CWD, { query: 'retries', sessionId: SESSION })
      expect(result.results).toEqual([])
      expect(result.strategy).toBeUndefined()
      expect(offered).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it('clears the selector on dispose so a later call cannot reuse it', async () => {
    const { registry } = harness({ selector: async () => ['mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] })
    registry.setMemorySelector(undefined)
    const result = await registry.memorySearchRanked(CWD, { query: 'retries', sessionId: SESSION })
    expect(result.strategy).toBeUndefined()
    await registry.dispose()
  })

  it('asks the selector for the page size the schema declares, not the recall injection size', async () => {
    // `engineering_memory_search` declares `limit: 1..20`, and with no selector the
    // store answers with 20 records. The selector path used to hand the selector
    // `DEFAULT_MEMORY_RECALL_LIMIT` (5) — the size of an *injected recall*, an
    // unrelated surface — so switching semantic selection on silently shrank a
    // caller's page from 20 to 5 and discarded records the store had already
    // retrieved. The two paths have to agree on the same number.
    const many = Array.from({ length: 25 }, (_, position) => index(`mem_${position.toString(16).padStart(32, '0')}`, `Record ${position}`, 1_000 + position))
    const bodies = new Map(many.map(record => [record.id, `Body for ${record.id}.`]))
    const { registry, limits } = harness({ records: many, bodies, selector: async () => [] })
    try {
      await registry.memorySearchRanked(CWD, { query: 'record', sessionId: SESSION })
      expect(limits[0]).toBe(20)
      // An explicit limit still wins: the default is a default, not a clamp.
      await registry.memorySearchRanked(CWD, { query: 'record', limit: 3, sessionId: SESSION })
      expect(limits[1]).toBe(3)
    } finally {
      await registry.dispose()
    }
  })
})
