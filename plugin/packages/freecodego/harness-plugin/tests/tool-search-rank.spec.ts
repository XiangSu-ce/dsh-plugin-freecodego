/**
 * The `tool_search` ranker.
 *
 * Each case here is a way the scoring can quietly stop meaning anything: a term
 * that every tool carries deciding the order, a long description outbidding a
 * name, a repeated word outbidding a relevant one. The ordering assertions are
 * the ones that matter — a ranker that returns the right set in the wrong order
 * is a ranker the model has to read past.
 */

import { describe, expect, it } from 'vitest'

import { rankTools, tokenize, type RankableTool } from '../src/tool-search-rank.ts'

const names = (ranked: readonly { readonly tool: RankableTool }[]): readonly string[] =>
  ranked.map(entry => entry.tool.name)

/**
 * The best hit.
 *
 * Every case below is about which tool comes first, so reading the answer as a
 * list and indexing it would put a `possibly undefined` in the middle of each
 * assertion — noise that hides the one thing being asserted.
 */
function top(ranked: readonly { readonly tool: RankableTool; readonly score: number }[]): {
  readonly tool: RankableTool
  readonly score: number
} {
  const [first] = ranked
  if (first === undefined) throw new Error('expected at least one hit to rank')
  return first
}

/** Its score, for the cases that compare two scorings rather than two orders. */
const bestScore = (terms: readonly string[], corpus: readonly RankableTool[], limit: number): number =>
  top(rankTools(terms, corpus, limit)).score

describe('tokenization', () => {
  it('splits tool names on their separators', () => {
    expect(tokenize('engineering_memory_search')).toEqual(['engineering', 'memory', 'search'])
    expect(tokenize('mcp__slack__send')).toEqual(['mcp', 'slack', 'send'])
    expect(tokenize('Refresh-Token/Invalid')).toEqual(['refresh', 'token', 'invalid'])
  })

  it('is case-insensitive and drops punctuation', () => {
    expect(tokenize('MEMORY (durable).')).toEqual(['memory', 'durable'])
    expect(tokenize('')).toEqual([])
  })

  it('cuts CJK runs into both characters and bigrams', () => {
    // The bigrams are where the meaning is; the characters are what makes a
    // one-character query an exact hit rather than a prefix too short to allow.
    expect(tokenize('检查点')).toEqual(['检', '查', '点', '检查', '查点'])
    expect(tokenize('检')).toEqual(['检'])
  })
})

describe('ranking', () => {
  it('puts a name match above a description that mentions the word', () => {
    const ranked = rankTools(['memory'], [
      { name: 'advisor_notes', description: 'memory appears once, in passing' },
      { name: 'engineering_memory_search', description: 'Search durable memory' },
    ], 5)
    expect(names(ranked)[0]).toBe('engineering_memory_search')
  })

  it('prefers the short relevant description over the long one that mentions it', () => {
    // The old scoring gave both +1 and broke the tie alphabetically, so a tool
    // whose prose happened to contain the word beat the tool that describes it.
    const ranked = rankTools(['checkpoint'], [
      { name: 'restore', description: `checkpoint ${'filler '.repeat(30)}` },
      { name: 'restore_short', description: 'checkpoint' },
    ], 5)
    expect(names(ranked)[0]).toBe('restore_short')
  })

  it('weights a rare term above one the whole catalog carries', () => {
    const corpus: readonly RankableTool[] = [
      { name: 'a', description: 'shared rare' },
      { name: 'b', description: 'shared' },
      { name: 'c', description: 'shared' },
      { name: 'd', description: 'shared' },
    ]
    const rare = top(rankTools(['rare'], corpus, 5))
    const common = top(rankTools(['shared'], corpus, 5))
    expect(rare.score).toBeGreaterThan(common.score)
  })

  it('saturates, so repeating a word cannot outbid a real match', () => {
    const once = bestScore(['word'], [{ name: 'x', description: 'word here' }], 5)
    const repeated = bestScore(['word'], [{ name: 'x', description: Array.from({ length: 10 }, () => 'word').join(' ') }], 5)
    expect(repeated).toBeGreaterThan(once)
    expect(repeated).toBeLessThan(once * 3)
  })

  it('counts a prefix as a partial hit, and never as a whole one', () => {
    const exact = bestScore(['checkpoint'], [{ name: 'x', description: 'checkpoint' }], 5)
    const prefix = bestScore(['check'], [{ name: 'x', description: 'checkpoint' }], 5)
    expect(prefix).toBeGreaterThan(0)
    expect(prefix).toBeLessThan(exact)
  })

  it('refuses a prefix too short to mean anything', () => {
    // Substring matching scored `ch` as a hit on `checkpoint`, which is how a
    // two-character query returned half the catalog in arbitrary order.
    expect(rankTools(['ch'], [{ name: 'x', description: 'checkpoint' }], 5)).toEqual([])
  })

  it('drops candidates that match nothing instead of flooring them', () => {
    expect(rankTools(['kubernetes'], [{ name: 'advisor_notes', description: 'Read advisor notes.' }], 5)).toEqual([])
  })

  it('counts a repeated query term once', () => {
    const corpus: readonly RankableTool[] = [{ name: 'x', description: 'memory records' }]
    expect(bestScore(['memory', 'memory'], corpus, 5)).toBe(bestScore(['memory'], corpus, 5))
  })

  it('answers in the same order twice, breaking ties on the name', () => {
    const corpus: readonly RankableTool[] = [
      { name: 'b', description: 'shared' },
      { name: 'a', description: 'shared' },
    ]
    expect(names(rankTools(['shared'], corpus, 5))).toEqual(['a', 'b'])
    expect(names(rankTools(['shared'], [...corpus].reverse(), 5))).toEqual(['a', 'b'])
  })

  it('scores by name when a tool has no description at all', () => {
    const ranked = rankTools(['memory'], [{ name: 'engineering_memory_get' }], 5)
    expect(ranked).toHaveLength(1)
    expect(Number.isFinite(ranked[0]?.score ?? Number.NaN)).toBe(true)
  })

  it('bounds the answer and refuses a nonsensical bound', () => {
    const corpus: readonly RankableTool[] = [
      { name: 'a', description: 'shared' },
      { name: 'b', description: 'shared' },
      { name: 'c', description: 'shared' },
    ]
    expect(rankTools(['shared'], corpus, 2)).toHaveLength(2)
    expect(rankTools(['shared'], corpus, 0)).toHaveLength(1)
    expect(rankTools(['shared'], corpus, Number.NaN)).toHaveLength(1)
  })

  it('reads a longer query term as the same partial hit as a shorter one', () => {
    // `checkpoints` is how a model writes it as often as `checkpoint`, and the
    // forward-only rule answered the plural with nothing while the singular found
    // the tool. The discount is what keeps this from becoming fuzzy matching: a
    // name that *is* the term still outranks one that only contains it.
    const corpus: readonly RankableTool[] = [
      { name: 'engineering_checkpoint_restore', description: 'Restore a checkpoint' },
      { name: 'engineering_skill_list', description: 'List skills' },
    ]
    expect(names(rankTools(['checkpoints'], corpus, 5))).toEqual(['engineering_checkpoint_restore'])
    expect(names(rankTools(['skills'], corpus, 5))).toEqual(['engineering_skill_list'])
    expect(names(rankTools(['checkpoint'], corpus, 5))[0]).toBe('engineering_checkpoint_restore')
    // The limit of the rule, recorded so nobody reads it as a stemmer: an
    // inflection that is not a plain suffix (memory -> memories) still misses,
    // which is what a real stemmer would be needed to cover.
    expect(names(rankTools(['memories'], [{ name: 'engineering_memory_get', description: 'Read memory' }], 5))).toEqual([])
  })

  it('has nothing to rank without terms or candidates', () => {
    expect(rankTools([], [{ name: 'a', description: 'b' }], 5)).toEqual([])
    expect(rankTools(['a'], [], 5)).toEqual([])
    expect(rankTools([''], [{ name: 'a' }], 5)).toEqual([])
  })

  it('finds a CJK description from a keyword query in the same language', () => {
    const corpus: readonly RankableTool[] = [
      { name: 'engineering_memory_get', description: '读取记忆记录' },
      { name: 'engineering_checkpoint_restore', description: '恢复检查点' },
    ]
    expect(names(rankTools(['检查点'], corpus, 5))).toEqual(['engineering_checkpoint_restore'])
    // A single character is a legitimate question in a language without spaces.
    expect(names(rankTools(['点'], corpus, 5))).toEqual(['engineering_checkpoint_restore'])
  })
})
