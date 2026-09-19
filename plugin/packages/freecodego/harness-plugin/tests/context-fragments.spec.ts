import { describe, expect, it } from 'vitest'
import {
  ContextFragmentLog,
  digestText,
  planFragment,
  renderFragments,
  type ContextSection,
  type SectionInput,
} from '../src/context-fragments.ts'

// `ContextSection<unknown>`, matching how the plugin declares its own sections
// (`injectPlanModeGuidance`): the log is typed over `SectionInput<unknown>` so a
// session can hold sections of different value types, and a `ContextSection<string>`
// is not assignable to it — a narrower `render` parameter cannot accept the wider
// value the log hands it.
const memorySection: ContextSection<unknown> = {
  id: 'memory',
  markers: ['<memory>', '</memory>'],
  render: value => String(value),
  replacementNotice: 'This memory section replaces all previously provided memory.',
  removalNotice: 'The previously provided memory no longer applies.',
}

const repoMapSection: ContextSection<unknown> = {
  id: 'repo-map',
  markers: ['<repo-map>', '</repo-map>'],
  render: value => String(value),
}

describe('differential context fragments', () => {
  it('sends a section the model has never seen', () => {
    const fragment = planFragment({ section: memorySection, value: 'prefer pnpm' }, { kind: 'absent' })
    expect(fragment?.kind).toBe('content')
    expect(fragment?.text).toBe('<memory>\nprefer pnpm\n</memory>')
  })

  it('sends nothing when the value is unchanged, which is where the saving lives', () => {
    const fragment = planFragment({ section: memorySection, value: 'prefer pnpm' }, { kind: 'known', value: 'prefer pnpm' })
    expect(fragment).toBeUndefined()
  })

  it('announces a removal instead of silently omitting the section', () => {
    // Omitting is not how you retract an instruction: a model told to prefer
    // pnpm keeps preferring it if the sentence merely disappears.
    const fragment = planFragment({ section: memorySection, value: undefined }, { kind: 'known', value: 'prefer pnpm' })
    expect(fragment?.kind).toBe('removal')
    expect(fragment?.text).toBe('The previously provided memory no longer applies.')
  })

  it('stays silent when an empty section was never sent', () => {
    expect(planFragment({ section: memorySection, value: undefined }, { kind: 'absent' })).toBeUndefined()
  })

  it('marks a change as a replacement so two contradicting versions cannot both win', () => {
    const fragment = planFragment({ section: memorySection, value: 'prefer npm' }, { kind: 'known', value: 'prefer pnpm' })
    expect(fragment?.kind).toBe('replacement')
    expect(fragment?.text.startsWith('This memory section replaces all previously provided memory.')).toBe(true)
    expect(fragment?.text).toContain('prefer npm')
  })

  it('treats an unknown previous state as possibly-held and re-sends with a notice', () => {
    // After a resume or compaction we cannot know what the model saw; sending a
    // bare body would leave two versions live with no way to tell them apart.
    const changed = planFragment({ section: memorySection, value: 'prefer npm' }, { kind: 'unknown' })
    expect(changed?.kind).toBe('replacement')
    const cleared = planFragment({ section: memorySection, value: undefined }, { kind: 'unknown' })
    expect(cleared?.kind).toBe('removal')
  })

  it('declares when a section was shortened to fit a budget', () => {
    const fragment = planFragment({ section: memorySection, value: 'first 3 of 40 records', incomplete: true }, { kind: 'absent' })
    expect(fragment?.incomplete).toBe(true)
    expect(fragment?.text).toContain('partial view')
  })
})

describe('context fragment log', () => {
  const inputs = (values: readonly [string, string | undefined][]): readonly SectionInput<unknown>[] =>
    values.map(([id, value]) => ({ section: id === 'memory' ? memorySection : repoMapSection, value }))

  it('renders nothing on a repeat turn and everything on the first', () => {
    const log = new ContextFragmentLog()
    const first = log.plan(inputs([['memory', 'a'], ['repo-map', 'src/']]))
    expect(first).toHaveLength(2)
    log.commit(first)
    expect(log.plan(inputs([['memory', 'a'], ['repo-map', 'src/']]))).toHaveLength(0)
    expect(log.heldSections()).toEqual(['memory', 'repo-map'])
  })

  it('keeps the byte order deterministic so the cache prefix cannot drift', () => {
    const log = new ContextFragmentLog()
    const forward = log.plan(inputs([['memory', 'a'], ['repo-map', 'b']]))
    const reversed = new ContextFragmentLog().plan(inputs([['repo-map', 'b'], ['memory', 'a']]))
    expect(renderFragments(forward)).toBe(renderFragments(reversed))
  })

  it('does not advance what it believes the model holds until a commit happens', () => {
    // A cancelled turn that appended nothing must not make the log claim the
    // model was told something it never saw.
    const log = new ContextFragmentLog()
    const first = log.plan(inputs([['memory', 'a']]))
    expect(log.plan(inputs([['memory', 'a']]))).toHaveLength(1)
    log.commit(first)
    expect(log.plan(inputs([['memory', 'a']]))).toHaveLength(0)
  })

  it('records the body, so a second identical turn is not seen as a change', () => {
    const log = new ContextFragmentLog()
    const fragment = log.plan(inputs([['memory', 'prefer pnpm']]))
    log.commit(fragment)
    // The notice and markers must not become part of the snapshot, or the next
    // comparison would report a spurious change on every turn.
    expect(log.previousFor('memory')).toEqual({ kind: 'known', value: 'prefer pnpm' })
  })

  it('re-sends everything after the log is marked unknown', () => {
    const log = new ContextFragmentLog()
    log.commit(log.plan(inputs([['memory', 'a'], ['repo-map', 'src/']])))
    log.markUnknown()
    expect(log.plan(inputs([['memory', 'a'], ['repo-map', 'src/']])).map(fragment => fragment.kind)).toEqual(['replacement', 'replacement'])
  })

  it('reports a prefix digest that only moves when the held set moves', () => {
    const log = new ContextFragmentLog()
    log.commit(log.plan(inputs([['memory', 'a']])))
    const before = log.prefixDigest()
    log.commit(log.plan(inputs([['memory', 'a']])))
    expect(log.prefixDigest()).toBe(before)
    log.commit(log.plan(inputs([['memory', 'b']])))
    expect(log.prefixDigest()).not.toBe(before)
  })

  it('records the body after a replacement, so the next turn is not seen as a change', () => {
    // The first-send case above passes even when the recorded value is recovered
    // by parsing the rendered text: a `content` fragment is markers around the
    // body, so a parse keyed on the first and last newline happens to find it. A
    // `replacement` is `notice + markers + body`, so the same parse captures the
    // opening marker and the body together — a value that never compares equal to
    // the plain body, which re-sent the whole section on every later turn and kept
    // the prefix moving forever.
    const log = new ContextFragmentLog()
    log.commit(log.plan(inputs([['memory', 'v1']])))
    log.commit(log.plan(inputs([['memory', 'v2']])))
    expect(log.previousFor('memory')).toEqual({ kind: 'known', value: 'v2' })
    for (const turn of [4, 5, 6]) {
      expect(log.plan(inputs([['memory', 'v2']])), `turn ${turn}`).toHaveLength(0)
      log.commit(log.plan(inputs([['memory', 'v2']])))
    }
  })

  it('keeps the rendered bytes identical for a settled section, which is the whole point', () => {
    const log = new ContextFragmentLog()
    log.commit(log.plan(inputs([['memory', 'v1']])))
    log.commit(log.plan(inputs([['memory', 'v2']])))
    const settled = renderFragments(log.plan(inputs([['memory', 'v2']])))
    expect(settled).toBe('')
  })

  it('re-sends when a bounded view is later whole, because the model was given a partial one', () => {
    const log = new ContextFragmentLog()
    const partial = log.plan([{ section: memorySection, value: 'full text', incomplete: true }])
    log.commit(partial)
    // Same value, now complete: the model holds a shortened view and must be told.
    const complete = log.plan([{ section: memorySection, value: 'full text' }])
    expect(complete).toHaveLength(1)
    expect(complete[0]?.kind).toBe('replacement')
    expect(complete[0]?.incomplete).toBe(false)
    log.commit(complete)
    expect(log.plan([{ section: memorySection, value: 'full text' }])).toHaveLength(0)
  })

  it('stays silent on a repeat while the view is still bounded the same way', () => {
    const log = new ContextFragmentLog()
    const first = log.plan([{ section: memorySection, value: 'full text', incomplete: true }])
    log.commit(first)
    expect(log.plan([{ section: memorySection, value: 'full text', incomplete: true }])).toHaveLength(0)
  })

  it('drops a section from the held set when it is removed', () => {
    const log = new ContextFragmentLog()
    log.commit(log.plan(inputs([['memory', 'a']])))
    log.commit(log.plan(inputs([['memory', undefined]])))
    expect(log.heldSections()).toEqual([])
    expect(log.previousFor('memory')).toEqual({ kind: 'absent' })
  })

  it('hashes the same text to the same digest', () => {
    expect(digestText('a')).toBe(digestText('a'))
    expect(digestText('a')).not.toBe(digestText('b'))
  })
})
