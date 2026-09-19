import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MEMORY_RECALL_LIMIT,
  MAX_MEMORY_EXCERPT_CHARS,
  MAX_MEMORY_RECALL_LIMIT,
  MAX_MEMORY_SELECTOR_ANSWER,
  selectMemories,
  type MemoryRecallCandidate,
  type MemorySelector,
} from '../src/memory/memory-recall.ts'

const NOW = 1_700_000_000_000

function candidate(overrides: Partial<MemoryRecallCandidate> & { readonly id: string }): MemoryRecallCandidate {
  return {
    title: 'untitled',
    kind: 'decision',
    trust: 'reviewed',
    createdAt: NOW,
    body: '',
    ...overrides,
  }
}

/** A selector that always answers with the given ids. */
function answering(ids: readonly string[]): MemorySelector {
  return async () => ids
}

describe('memory recall request validation', () => {
  it('defaults the limit when the caller states none', async () => {
    const result = await selectMemories({ query: 'widget', candidates: [], now: NOW })
    expect(result.strategy).toBe('lexical')
    expect(result.ids).toEqual([])
    expect(DEFAULT_MEMORY_RECALL_LIMIT).toBe(5)
  })

  it('refuses a limit that is not a whole number of memories', async () => {
    await expect(selectMemories({ query: 'widget', candidates: [], limit: 2.5, now: NOW })).rejects.toThrow(
      `memory recall limit must be an integer between 1 and ${MAX_MEMORY_RECALL_LIMIT}`,
    )
  })

  it('refuses a limit below one', async () => {
    await expect(selectMemories({ query: 'widget', candidates: [], limit: 0, now: NOW })).rejects.toThrow('between 1 and')
  })

  it('refuses a limit above the ceiling', async () => {
    await expect(selectMemories({ query: 'widget', candidates: [], limit: MAX_MEMORY_RECALL_LIMIT + 1, now: NOW })).rejects.toThrow('between 1 and')
  })

  it('accepts the ceiling itself', async () => {
    const result = await selectMemories({ query: 'widget', candidates: [candidate({ id: 'mem_a' })], limit: MAX_MEMORY_RECALL_LIMIT, now: NOW })
    expect(result.ids).toEqual(['mem_a'])
  })
})

describe('memory recall excerpts', () => {
  it('windows the excerpt around the hit in the original text', async () => {
    // The search runs on a lowercased copy, and lowercasing is not
    // length-preserving (U+0130 lowercases to two code units). An offset taken
    // there is not an offset into the body, so with enough of those before the
    // match the window slides past the end and the excerpt stops containing the
    // very term that made the record relevant — a blank excerpt, reported as
    // evidence.
    const body = `${'İ'.repeat(400)} needle in the tail`
    const result = await selectMemories({ query: 'needle', candidates: [candidate({ id: 'mem_a', body })], now: NOW })
    const excerpt = result.excerpts[0]?.excerpt ?? ''
    expect(excerpt).toContain('needle')
    // Still a window: the text before the hit was dropped, and says so.
    expect(excerpt.startsWith('…')).toBe(true)
  })
})

describe('memory recall without a selector', () => {
  it('orders by relevance, then trust, then recency, then id', async () => {
    const candidates = [
      candidate({ id: 'mem_d', title: 'unrelated', trust: 'reviewed', createdAt: NOW - 5_000 }),
      candidate({ id: 'mem_c', title: 'widget', trust: 'draft', createdAt: NOW }),
      candidate({ id: 'mem_b', title: 'unrelated', trust: 'reviewed', createdAt: NOW }),
      candidate({ id: 'mem_a', title: 'unrelated', trust: 'reviewed', createdAt: NOW }),
      candidate({ id: 'mem_f', title: 'unrelated', trust: 'draft', createdAt: NOW }),
      candidate({ id: 'mem_g', title: 'unrelated', trust: 'retired-by-a-newer-build', createdAt: NOW }),
    ]
    const result = await selectMemories({ query: 'widget', candidates, limit: 6, now: NOW })
    // mem_c matches and leads. The rest score zero, so trust breaks the tie
    // (reviewed before draft before an unknown-trust value), recency breaks the
    // reviewed pair, and the id is the total-order tiebreak that keeps the
    // sequence reproducible.
    expect(result.ids).toEqual(['mem_c', 'mem_a', 'mem_b', 'mem_d', 'mem_f', 'mem_g'])
    expect(result.strategy).toBe('lexical')
    expect(result.selectorFailure).toBeUndefined()
  })

  it('collapses a duplicated candidate id and records why', async () => {
    const result = await selectMemories({
      query: 'widget',
      candidates: [candidate({ id: 'mem_a', title: 'first' }), candidate({ id: 'mem_a', title: 'second' })],
      now: NOW,
    })
    expect(result.ids).toEqual(['mem_a'])
    expect(result.excerpts[0]?.title).toBe('first')
    expect(result.dropped).toEqual([{ id: 'mem_a', reason: 'duplicate-candidate' }])
  })

  it('reports how many candidates the ordering had no room for', async () => {
    const candidates = ['mem_a', 'mem_b', 'mem_c'].map(id => candidate({ id }))
    const result = await selectMemories({ query: 'widget', candidates, limit: 1, now: NOW })
    expect(result.ids).toHaveLength(1)
    expect(result.omitted).toBe(2)
  })
})

describe('memory recall excerpts', () => {
  it('keeps a short body whole', async () => {
    const result = await selectMemories({ query: 'widget', candidates: [candidate({ id: 'mem_a', body: 'short note' })], now: NOW })
    expect(result.excerpts[0]?.excerpt).toBe('short note')
  })

  it('windows a long body around the first query hit', async () => {
    const lead = 'x'.repeat(300)
    const tail = 'y'.repeat(500)
    const result = await selectMemories({
      query: 'needle',
      candidates: [candidate({ id: 'mem_a', body: `${lead} needle ${tail}` })],
      now: NOW,
    })
    const excerpt = result.excerpts[0]!.excerpt
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).toContain('needle')
    expect(excerpt.length).toBe(MAX_MEMORY_EXCERPT_CHARS + 2)
  })

  it('takes the earliest of several hits', async () => {
    // The hits are far enough apart that the 400-character window around the
    // first one cannot reach the second, which is what makes the choice visible.
    const body = `${'x'.repeat(200)} alpha ${'y'.repeat(400)} beta ${'z'.repeat(200)}`
    const result = await selectMemories({ query: 'beta alpha', candidates: [candidate({ id: 'mem_a', body })], now: NOW })
    const excerpt = result.excerpts[0]!.excerpt
    expect(excerpt).toContain('alpha')
    expect(excerpt).not.toContain('beta')
  })

  it('takes the head when nothing matches', async () => {
    const result = await selectMemories({ query: 'absent', candidates: [candidate({ id: 'mem_a', body: 'z'.repeat(600) })], now: NOW })
    const excerpt = result.excerpts[0]!.excerpt
    expect(excerpt.startsWith('…')).toBe(false)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).toBe(`${'z'.repeat(MAX_MEMORY_EXCERPT_CHARS)}…`)
  })

  it('keeps the head and elides only the tail when the hit is already at the start', async () => {
    const result = await selectMemories({
      query: 'needle',
      candidates: [candidate({ id: 'mem_a', body: `needle${'y'.repeat(600)}` })],
      now: NOW,
    })
    const excerpt = result.excerpts[0]!.excerpt
    expect(excerpt.startsWith('needle')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('drops the trailing ellipsis when the window already reaches the end', async () => {
    // 456 characters with the hit at 200: the window starts at 120 and covers
    // through 520, so the body ends inside it and only the lead is elided.
    const result = await selectMemories({
      query: 'needle',
      candidates: [candidate({ id: 'mem_a', body: `${'x'.repeat(200)}needle${'y'.repeat(250)}` })],
      now: NOW,
    })
    const excerpt = result.excerpts[0]!.excerpt
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(false)
  })

  it('dates every excerpt so the selector can weigh staleness', async () => {
    const result = await selectMemories({
      query: 'widget',
      candidates: [candidate({ id: 'mem_a', createdAt: NOW - 3 * 24 * 60 * 60 * 1_000 })],
      now: NOW,
    })
    expect(result.excerpts[0]?.freshness).toBe('recent')
    expect(result.excerpts[0]?.ageLabel).toBe('3 days')
  })
})

describe('memory recall with a selector', () => {
  it('returns the selector ordering and the matching excerpts', async () => {
    const candidates = [candidate({ id: 'mem_a', title: 'first' }), candidate({ id: 'mem_b', title: 'second' })]
    const result = await selectMemories({ query: 'widget', candidates, now: NOW }, answering(['mem_b', 'mem_a']))
    expect(result.strategy).toBe('selector')
    expect(result.ids).toEqual(['mem_b', 'mem_a'])
    expect(result.excerpts.map(excerpt => excerpt.title)).toEqual(['second', 'first'])
  })

  it('hands the selector only excerpts and the limit', async () => {
    const selector = vi.fn(answering(['mem_a']))
    await selectMemories({ query: 'widget', candidates: [candidate({ id: 'mem_a' })], limit: 3, now: NOW }, selector)
    expect(selector).toHaveBeenCalledWith('widget', [expect.objectContaining({ id: 'mem_a' })], 3, undefined)
  })

  it('accepts an empty answer as a deliberate "nothing was relevant"', async () => {
    const result = await selectMemories({ query: 'widget', candidates: [candidate({ id: 'mem_a' })], now: NOW }, answering([]))
    expect(result.strategy).toBe('selector')
    expect(result.ids).toEqual([])
    expect(result.selectorFailure).toBeUndefined()
    expect(result.omitted).toBe(1)
  })

  it('drops an id the selector was never shown and keeps the rest', async () => {
    const candidates = [candidate({ id: 'mem_a' }), candidate({ id: 'mem_b' })]
    const result = await selectMemories({ query: 'widget', candidates, now: NOW }, answering(['mem_b', 'mem_invented', 'mem_a']))
    expect(result.ids).toEqual(['mem_b', 'mem_a'])
    expect(result.dropped).toEqual([{ id: 'mem_invented', reason: 'unknown-id' }])
  })

  it('counts a repeated selection once', async () => {
    const result = await selectMemories({ query: 'widget', candidates: [candidate({ id: 'mem_a' })], now: NOW }, answering(['mem_a', 'mem_a']))
    expect(result.ids).toEqual(['mem_a'])
    expect(result.dropped).toEqual([{ id: 'mem_a', reason: 'duplicate-selection' }])
  })

  it('truncates an over-long selection and names the overflow', async () => {
    const candidates = ['mem_a', 'mem_b', 'mem_c'].map(id => candidate({ id }))
    const result = await selectMemories({ query: 'widget', candidates, limit: 2, now: NOW }, answering(['mem_a', 'mem_b', 'mem_c']))
    expect(result.ids).toEqual(['mem_a', 'mem_b'])
    expect(result.dropped).toEqual([{ id: 'mem_c', reason: 'over-limit' }])
    expect(result.omitted).toBe(1)
  })
})

describe('memory recall selector fallback', () => {
  it('falls back to lexical when the selector throws, and records the reason', async () => {
    const result = await selectMemories(
      { query: 'widget', candidates: [candidate({ id: 'mem_a', title: 'widget' })], now: NOW },
      async () => { throw new Error('model unreachable') },
    )
    expect(result.strategy).toBe('lexical')
    expect(result.ids).toEqual(['mem_a'])
    expect(result.selectorFailure).toBe('the selector failed: model unreachable')
  })

  it('stringifies a non-Error rejection', async () => {
    const result = await selectMemories(
      { query: 'widget', candidates: [], now: NOW },
      async () => { throw 'plain string' },
    )
    expect(result.selectorFailure).toBe('the selector failed: plain string')
  })

  it('blames an abort on the caller, not on the selector', async () => {
    const controller = new AbortController()
    const result = await selectMemories(
      { query: 'widget', candidates: [], now: NOW, signal: controller.signal },
      async () => { controller.abort(); throw new Error('aborted mid-flight') },
    )
    expect(result.strategy).toBe('lexical')
    expect(result.selectorFailure).toBe('the recall was aborted')
  })

  it('recalls nothing and says so when the request arrives aborted', async () => {
    const selector = vi.fn(answering(['mem_a']))
    const result = await selectMemories(
      { query: 'widget', candidates: [candidate({ id: 'mem_a' })], now: NOW, signal: AbortSignal.abort() },
      selector,
    )
    expect(selector).not.toHaveBeenCalled()
    expect(result.aborted).toBe(true)
    expect(result.ids).toEqual([])
    expect(result.omitted).toBe(1)
  })

  it('falls back when the answer is not an array', async () => {
    const result = await selectMemories({ query: 'widget', candidates: [], now: NOW }, (async () => 'mem_a') as unknown as MemorySelector)
    expect(result.selectorFailure).toBe('the selector did not return an array of ids')
  })

  it('falls back when the answer is implausibly long', async () => {
    const answer = Array.from({ length: MAX_MEMORY_SELECTOR_ANSWER + 1 }, (_value, index) => `mem_${index}`)
    const result = await selectMemories({ query: 'widget', candidates: [], now: NOW }, answering(answer))
    expect(result.selectorFailure).toBe(`the selector returned ${MAX_MEMORY_SELECTOR_ANSWER + 1} ids, more than the ${MAX_MEMORY_SELECTOR_ANSWER} a recall accepts`)
  })

  it('falls back when an entry is not a string', async () => {
    const result = await selectMemories({ query: 'widget', candidates: [], now: NOW }, (async () => ['mem_a', 7]) as unknown as MemorySelector)
    expect(result.selectorFailure).toBe('the selector returned an id that was not a string')
  })

  it('falls back when every id it named was invented', async () => {
    const result = await selectMemories({ query: 'widget', candidates: [candidate({ id: 'mem_a' })], now: NOW }, answering(['mem_x']))
    expect(result.strategy).toBe('lexical')
    expect(result.selectorFailure).toBe('the selector named nothing it was offered')
    expect(result.ids).toEqual(['mem_a'])
  })
})
