/**
 * Hunk-level change tracking.
 *
 * The three cases the plan asks for are the first three suites: one call per
 * region with correct attribution, a single-hunk revert that leaves another
 * call's edit alone, and an explicit policy for overlapping hunks. The rest are
 * the ways a *coordinate* goes wrong — an edit above the hunk, an edit outside the
 * tracker, identical-looking lines, a pure deletion — because a revert that
 * splices into the wrong place is worse than one that refuses.
 */

import { describe, expect, it } from 'vitest'

import { diffLines, hunkTargetPaths, HunkTracker, normalizeHunkFile, type HunkRevertResult } from '../src/hunk-tracker.ts'

/** The detail of a refusal, or an empty string for one that has none. */
const detailOf = (result: HunkRevertResult): string => (!result.ok && result.reason === 'drifted' ? result.detail : '')

const lines = (text: string): readonly string[] => text.split('\n')

describe('line diff', () => {
  it('reports nothing for identical revisions', () => {
    expect(diffLines(lines('a\nb\n'), lines('a\nb\n'))).toEqual([])
  })

  it('pairs the lines an insertion did not touch', () => {
    // The failure this rules out: an index-wise comparison reports every line
    // after an insertion at the top as changed.
    expect(diffLines(lines('a\nb\n'), lines('x\na\nb\n'))).toEqual([
      { offset: 0, removed: [], added: ['x'] },
    ])
  })

  it('reports a replacement as the region, not the whole file', () => {
    expect(diffLines(lines('a\nb\nc\n'), lines('a\nB\nc\n'))).toEqual([
      { offset: 1, removed: ['b'], added: ['B'] },
    ])
  })

  it('keeps two separated regions apart', () => {
    expect(diffLines(lines('a\nb\nc\nd\n'), lines('a\nB\nc\nD\n'))).toHaveLength(2)
  })

  it('degrades to one region rather than allocating a table it cannot afford', () => {
    const before = Array.from({ length: 2_100 }, (_, index) => `before ${String(index)}`)
    const after = Array.from({ length: 2_100 }, (_, index) => `after ${String(index)}`)
    const changes = diffLines(before, after)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.removed).toHaveLength(2_100)
    expect(changes[0]?.added).toHaveLength(2_100)
  })
})

describe('attribution', () => {
  it('records one hunk per call, each naming its call', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\nd\ne\n', after: 'a\nB\nc\nd\ne\n' })
    tracker.record({ file: 'src/a.ts', callId: 'call-2', before: 'a\nB\nc\nd\ne\n', after: 'a\nB\nc\nD\ne\n' })

    const hunks = tracker.hunks()
    expect(hunks).toHaveLength(2)
    expect(hunks.map(hunk => [hunk.callId, hunk.offset, hunk.added])).toEqual([
      ['call-1', 1, ['B']],
      ['call-2', 3, ['D']],
    ])
  })

  it('records nothing for an edit that changed nothing', () => {
    const tracker = new HunkTracker()
    expect(tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\n', after: 'a\n' })).toEqual([])
    expect(tracker.hunks()).toEqual([])
  })

  it('records two hunks when one call touched two regions', () => {
    const tracker = new HunkTracker()
    const created = tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\nd\n', after: 'a\nB\nc\nD\n' })
    expect(created).toHaveLength(2)
    expect(created.every(hunk => hunk.callId === 'call-1')).toBe(true)
  })

  it('names a file the way the caller did, so a path cannot leak out of it', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src\\nested\\a.ts', callId: 'call-1', before: 'a\n', after: 'b\n' })
    expect(tracker.hunks()[0]?.file).toBe('src/nested/a.ts')
  })

  it('filters by file and by call', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'a.ts', callId: 'call-1', before: 'a\n', after: 'b\n' })
    tracker.record({ file: 'b.ts', callId: 'call-2', before: 'a\n', after: 'b\n' })
    expect(tracker.hunks({ file: 'b.ts' })).toHaveLength(1)
    expect(tracker.hunks({ callId: 'call-1' })).toHaveLength(1)
    expect(tracker.hunks({ callId: 'call-9' })).toEqual([])
  })
})

describe('reverting one hunk', () => {
  it('reverts only the named hunk and leaves the other call alone', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\nd\ne\n', after: 'a\nB\nc\nd\ne\n' })
    tracker.record({ file: 'src/a.ts', callId: 'call-2', before: 'a\nB\nc\nd\ne\n', after: 'a\nB\nc\nD\ne\n' })

    const first = tracker.hunks({ callId: 'call-1' })[0]
    const result = tracker.revert(first?.id ?? '', 'a\nB\nc\nD\ne\n')
    expect(result).toMatchObject({ ok: true, relocated: false })
    expect(result.ok && result.text).toBe('a\nb\nc\nD\ne\n')
  })

  it('reverts a whole call, every hunk of it', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\nd\n', after: 'a\nB\nc\nD\n' })
    const result = tracker.revertCall({ callId: 'call-1', file: 'src/a.ts', current: 'a\nB\nc\nD\n' })
    expect(result).toMatchObject({ ok: true, hunks: 2 })
    expect(result.ok && result.text).toBe('a\nb\nc\nd\n')
  })

  it('reverts a call with an edit from another call still in the file', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\nd\ne\n', after: 'a\nB\nc\nd\ne\n' })
    tracker.record({ file: 'src/a.ts', callId: 'call-2', before: 'a\nB\nc\nd\ne\n', after: 'a\nB\nc\nD\ne\n' })
    const result = tracker.revertCall({ callId: 'call-2', file: 'src/a.ts', current: 'a\nB\nc\nD\ne\n' })
    expect(result.ok && result.text).toBe('a\nB\nc\nd\ne\n')
  })

  it('keeps its coordinates for the next revert after one of them lands', () => {
    // A revert is an edit: the hunks below it move by the length delta. Without
    // that, the second revert still succeeds — but only by searching the file for
    // its own lines, which is the difference between knowing and looking.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'l1\nl2\nl3\nl4\nl5\nl6\n', after: 'l1\nl2\nl4\nl5\nl6\n' })
    tracker.record({ file: 'src/a.ts', callId: 'call-2', before: 'l1\nl2\nl4\nl5\nl6\n', after: 'l1\nl2\nl4\nL5\nl6\n' })
    const [first, second] = tracker.hunks()
    const undone = tracker.revert(first?.id ?? '', 'l1\nl2\nl4\nL5\nl6\n')
    expect(undone.ok && undone.text).toBe('l1\nl2\nl3\nl4\nL5\nl6\n')
    const next = tracker.revert(second?.id ?? '', undone.ok ? undone.text : '')
    expect(next).toMatchObject({ ok: true, relocated: false })
    expect(next.ok && next.text).toBe('l1\nl2\nl3\nl4\nl5\nl6\n')
  })

  it('refuses a whole call when one of its hunks is in the way', () => {
    // All-or-nothing: half a call is a state nobody asked for and nobody can name
    // afterwards, so the caller gets the failures instead of a partial file.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\nd\n', after: 'a\nB\nc\nD\n' })
    tracker.record({ file: 'src/a.ts', callId: 'call-2', before: 'a\nB\nc\nD\n', after: 'a\nB\nc\nE\n' })
    const result = tracker.revertCall({ callId: 'call-1', file: 'src/a.ts', current: 'a\nB\nc\nE\n' })
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.failures.map(failure => failure.reason)).toEqual(['superseded'])
  })

  it('refuses an id it never issued', () => {
    expect(new HunkTracker().revert('nope', 'a\n')).toEqual({ ok: false, reason: 'unknown-hunk', hunkId: 'nope' })
  })

  it('refuses to revert a call it never saw', () => {
    const result = new HunkTracker().revertCall({ callId: 'call-9', file: 'src/a.ts', current: 'a\n' })
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.failures[0]?.reason).toBe('unknown-hunk')
  })
})

describe('overlapping hunks', () => {
  const overlapping = () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\n', after: 'a\nB\nc\n' })
    tracker.record({ file: 'src/a.ts', callId: 'call-2', before: 'a\nB\nc\n', after: 'a\nZ\nc\n' })
    return tracker
  }

  it('marks the covered hunk and says which hunk covered it', () => {
    const tracker = overlapping()
    const [first, second] = tracker.hunks()
    expect(first?.supersededBy).toBe(second?.id)
    expect(second?.supersededBy).toBeUndefined()
  })

  it('refuses to revert the covered hunk, naming the way forward', () => {
    const tracker = overlapping()
    const first = tracker.hunks()[0]
    expect(tracker.revert(first?.id ?? '', 'a\nZ\nc\n')).toEqual({
      ok: false,
      reason: 'superseded',
      hunkId: first?.id,
      by: tracker.hunks()[1]?.id,
    })
  })

  it('restores the covered state by reverting the call that covered it', () => {
    const tracker = overlapping()
    const result = tracker.revertCall({ callId: 'call-2', file: 'src/a.ts', current: 'a\nZ\nc\n' })
    expect(result.ok && result.text).toBe('a\nB\nc\n')
  })

  it('keeps the covered hunk flagged afterwards, because it was never re-armed', () => {
    // Documented as one-way rather than left to be discovered: the intent the flag
    // blocks is already served by the revert above.
    const tracker = overlapping()
    const first = tracker.hunks()[0]
    tracker.revertCall({ callId: 'call-2', file: 'src/a.ts', current: 'a\nZ\nc\n' })
    expect(tracker.revert(first?.id ?? '', 'a\nB\nc\n').ok).toBe(false)
  })

  it('treats an insertion next to a hunk as a shift, not a covering', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\n', after: 'a\nB\n' })
    tracker.record({ file: 'src/a.ts', callId: 'call-2', before: 'a\nB\n', after: 'a\nB\nc\n' })
    const first = tracker.hunks({ callId: 'call-1' })[0]
    expect(first?.supersededBy).toBeUndefined()
    expect(tracker.revert(first?.id ?? '', 'a\nB\nc\n').ok).toBe(true)
  })
})

describe('placing a hunk that moved', () => {
  it('knows where the hunk went when the edit above it went through the tracker', () => {
    // The offset was shifted when the inserting call was recorded, so this needs no
    // search at all — which is the difference between tracking edits and guessing
    // at them after the fact.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\n', after: 'a\nB\nc\n' })
    tracker.record({ file: 'src/a.ts', callId: 'call-2', before: 'a\nB\nc\n', after: 't\na\nB\nc\n' })
    const first = tracker.hunks({ callId: 'call-1' })[0]
    expect(first?.offset).toBe(2)
    const result = tracker.revert(first?.id ?? '', 't\na\nB\nc\n')
    expect(result).toMatchObject({ ok: true, relocated: false })
    expect(result.ok && result.text).toBe('t\na\nb\nc\n')
  })

  it('searches for the hunk when the file moved behind the tracker', () => {
    // What the tracker never saw: something edited the file outside it, so the
    // recorded offset is stale and the only way to place the hunk is its content.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\n', after: 'a\nB\nc\n' })
    const hunk = tracker.hunks()[0]
    const result = tracker.revert(hunk?.id ?? '', 't\na\nB\nc\n')
    expect(result).toMatchObject({ ok: true, relocated: true })
    expect(result.ok && result.text).toBe('t\na\nb\nc\n')
  })

  it('refuses when the hunk cannot be found at all', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\n', after: 'a\nB\n' })
    const hunk = tracker.hunks()[0]
    const result = tracker.revert(hunk?.id ?? '', 'x\ny\n')
    expect(result).toMatchObject({ ok: false, reason: 'drifted' })
    expect(detailOf(result)).toContain('no longer in the file')
  })

  it('refuses rather than guess which of two identical regions is the one', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\n', after: 'x\na\n' })
    const hunk = tracker.hunks()[0]
    // Neither occurrence is at the recorded offset, so the module has to choose
    // between two identical regions — and chooses not to.
    const result = tracker.revert(hunk?.id ?? '', 'y\nx\nx\n')
    expect(result).toMatchObject({ ok: false, reason: 'drifted' })
    expect(detailOf(result)).toContain('2 times')
  })

  it('uses its own offset when the same lines also appear further down', () => {
    // The offset is a coordinate the tracker maintained, not a coincidence: when
    // the post-image is where it was recorded, a duplicate elsewhere is not a
    // reason to refuse.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\n', after: 'x\na\n' })
    const hunk = tracker.hunks()[0]
    const result = tracker.revert(hunk?.id ?? '', 'x\na\nx\n')
    expect(result).toMatchObject({ ok: true, relocated: false })
    expect(result.ok && result.text).toBe('a\nx\n')
  })

  it('refuses a deletion whose neighbours moved away', () => {
    // Two independent recordings: the drift check has to be reached with a hunk
    // that has not been applied yet, or the one-shot refusal answers first and this
    // stops testing drift at all.
    const recorded = (): HunkTracker => {
      const tracker = new HunkTracker()
      tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\n', after: 'a\nc\n' })
      return tracker
    }
    const atHome = recorded()
    expect(atHome.revert(atHome.hunks()[0]?.id ?? '', 'a\nc\n')).toMatchObject({ ok: true })
    const moved = recorded()
    expect(moved.revert(moved.hunks()[0]?.id ?? '', 'q\nr\n')).toMatchObject({ ok: false, reason: 'drifted' })
  })

  it('re-inserts a deleted line where it was', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\n', after: 'a\nc\n' })
    const hunk = tracker.hunks()[0]
    expect(hunk?.added).toEqual([])
    const result = tracker.revert(hunk?.id ?? '', 'a\nc\n')
    expect(result.ok && result.text).toBe('a\nb\nc\n')
  })

  it('reverts a deletion at the end of the file', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\n', after: 'a\n' })
    const hunk = tracker.hunks()[0]
    const result = tracker.revert(hunk?.id ?? '', 'a\n')
    expect(result.ok && result.text).toBe('a\nb\n')
  })

  it('keeps the file line endings it found', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\r\nb\r\n', after: 'a\r\nB\r\n' })
    const hunk = tracker.hunks()[0]
    const result = tracker.revert(hunk?.id ?? '', 'a\r\nB\r\n')
    expect(result.ok && result.text).toBe('a\r\nb\r\n')
  })

  it('keeps the endings of the lines it was not asked about', () => {
    // The case the ending above does not reach: a file's lines do not have to agree
    // with each other. One CRLF in an otherwise-LF file — a Windows editor, a paste,
    // a merge — is enough to make *that* separator the file's answer for every line,
    // so undoing one line rewrites all of them and reads as a whole-file diff.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nwin\r\nc\n', after: 'a\nB\nwin\r\nc\n' })
    const hunk = tracker.hunks()[0]
    const result = tracker.revert(hunk?.id ?? '', 'a\nB\nwin\r\nc\n')
    expect(result.ok && result.text).toBe('a\nb\nwin\r\nc\n')
  })

  it('restores the ending the line had before the call replaced it', () => {
    // The line being put back is the one line whose ending the call may itself have
    // replaced, so the file cannot be asked what it was: `b\r\n` became `B\n` as part
    // of the same region, and undoing the region has to undo that too. Recording the
    // ending is what makes the answer the pre-image's rather than the file's.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\r\nc\n', after: 'a\nB\nc\n' })
    const hunk = tracker.hunks()[0]
    expect(hunk?.removedEol).toBe('\r\n')
    const result = tracker.revert(hunk?.id ?? '', 'a\nB\nc\n')
    expect(result.ok && result.text).toBe('a\nb\r\nc\n')
  })

  it('gives an ending back to a line that stopped being the last one', () => {
    // The last line of a file has no separator by definition, and undoing a deletion
    // in front of it makes it not the last line any more: without an ending the line
    // that follows would run into it, and the pre-image would lose a newline instead
    // of gaining one.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc', after: 'a\nb' })
    const hunk = tracker.hunks()[0]
    const result = tracker.revert(hunk?.id ?? '', 'a\nb')
    expect(result.ok && result.text).toBe('a\nb\nc')
  })

  it('puts a whole-file rewrite back, endings included', () => {
    // Every line at once, which is what a deletion at the top of a file looks like to
    // a diff, and the one shape where all the endings come from the recorded hunk.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\n', after: '' })
    const hunk = tracker.hunks()[0]
    const result = tracker.revert(hunk?.id ?? '', '')
    expect(result.ok && result.text).toBe('a\nb\nc\n')
  })
})

describe('round trips over generated texts', () => {
  // The promise the cases above reach one shape at a time, stated as a property: an
  // edit that only adds, removes or replaces lines must be undone byte for byte by
  // reverting the call that made it. Every line is generated with its own ending, so
  // these files disagree with themselves about line endings the way a real mixed file
  // does, and the rounds where a line starts or stops being the file's last one come
  // out of the generator rather than out of a case written by hand for it.
  //
  // What it is not: proof. It is 400 chances to be wrong, deterministic ones, and the
  // counterexample is printed with the failure so it can be added as a case.
  interface Spelled { readonly text: string; readonly separator: string }
  const ENDINGS = ['\n', '\r\n'] as const
  const WORDS = ['a', 'b', 'c', '', 'x', 'y'] as const

  /** A deterministic stream, so a failure here reproduces for anyone who runs it. */
  const stream = (seed: number): ((bound: number) => number) => {
    let state = seed
    return (bound: number): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return bound <= 0 ? 0 : state % bound
    }
  }
  const pick = <T>(items: readonly T[], rand: (bound: number) => number): T => items[rand(items.length)] ?? (items[0] as T)
  const respell = (entries: readonly Spelled[]): string => entries.map(entry => entry.text + entry.separator).join('')
  /** A line that no longer ends the file needs an ending of its own. */
  const mend = (entries: readonly Spelled[], rand: (bound: number) => number): readonly Spelled[] => entries.map((entry, index) =>
    index < entries.length - 1 && entry.separator === '' ? { text: entry.text, separator: pick(ENDINGS, rand) } : entry)

  it('reproduces the pre-image from every generated edit', () => {
    const rand = stream(20260919)
    const generated = (): readonly Spelled[] => {
      const count = 1 + rand(4)
      const entries: Spelled[] = []
      for (let index = 0; index < count; index += 1) entries.push({ text: pick(WORDS, rand), separator: pick(ENDINGS, rand) })
      entries.push({ text: pick(WORDS, rand), separator: rand(3) === 0 ? '' : pick(ENDINGS, rand) })
      return mend(entries, rand)
    }
    const edited = (entries: readonly Spelled[]): readonly Spelled[] => {
      const next = [...entries]
      const at = rand(next.length)
      const operation = rand(3)
      if (operation === 0) next.splice(at, 0, { text: pick(WORDS, rand), separator: pick(ENDINGS, rand) })
      else if (operation === 1) next.splice(at, 1, { text: pick(WORDS, rand), separator: pick(ENDINGS, rand) })
      else {
        next.splice(at, 1)
        if (rand(2) === 0) next.splice(rand(next.length + 1), 0, { text: pick(WORDS, rand), separator: pick(ENDINGS, rand) })
      }
      return next.length === 0 ? next : mend(next, rand)
    }

    let rounds = 0
    for (let round = 0; round < 400; round += 1) {
      const entries = generated()
      const before = respell(entries)
      const after = respell(edited(entries))
      if (before === after) continue
      const tracker = new HunkTracker()
      const hunks = tracker.record({ file: 'a.ts', callId: 'call-1', before, after })
      // A change of endings alone is not a line change, so it records nothing: the
      // hunks are regions of lines, which is the unit this module chose.
      if (hunks.length === 0) continue
      rounds += 1
      const named = `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`

      const whole = tracker.revertCall({ callId: 'call-1', file: 'a.ts', current: after })
      expect(whole.ok ? whole.text : JSON.stringify(whole), `the call as a whole: ${named}`).toBe(before)

      // A fresh tracker for each shape: an id is issued by the tracker that
      // recorded the hunk, and a revert against another one's id is `unknown-hunk`.
      if (hunks.length === 1) {
        const alone = new HunkTracker()
        const [fresh] = alone.record({ file: 'a.ts', callId: 'call-1', before, after })
        const one = alone.revert(fresh?.id ?? '', after)
        expect(one.ok ? one.text : JSON.stringify(one), `one hunk alone: ${named}`).toBe(before)
      }

      // Reverted one at a time, latest first: each revert shifts the offsets of the
      // hunks below it, so a tracker that forgot to would land the next one wrong.
      const stepwise = new HunkTracker()
      const again = stepwise.record({ file: 'a.ts', callId: 'call-1', before, after })
      let text = after
      for (const hunk of [...again].sort((left, right) => right.offset - left.offset)) {
        const one = stepwise.revert(hunk.id, text)
        expect(one.ok, `stepwise reverts: ${named}`).toBe(true)
        text = one.ok ? one.text : text
      }
      expect(text, `stepwise reverts: ${named}`).toBe(before)
    }

    // A generator that stopped producing edits to check would satisfy every
    // assertion above while testing nothing.
    expect(rounds).toBeGreaterThan(200)
  })
})

describe('which files a call named', () => {
  // The workspace is `.`, so these cases depend on neither where the suite runs
  // nor which separator the platform picked: containment is the property, and the
  // spellings below leave the workspace on either platform.
  const named = (args: unknown): readonly string[] => hunkTargetPaths(args, '.')
  const endingIn = (name: string) => new RegExp(`${name.replace('.', '\\.')}$`, 'u')

  it('finds the target under each name a write tool uses', () => {
    for (const key of ['path', 'file_path', 'filepath', 'target_file', 'notebook_path']) {
      const found = named({ [key]: 'src/a.ts' })
      expect(found).toHaveLength(1)
      expect(found[0]).toMatch(/src[\\/]a\.ts$/u)
    }
  })

  it('finds every target of a multi-file edit', () => {
    const found = named({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] })
    expect(found).toHaveLength(2)
    expect(found[0]).toMatch(endingIn('a.ts'))
    expect(found[1]).toMatch(endingIn('b.ts'))
  })

  it('refuses a target outside the workspace', () => {
    // The pre-image read is what would leak: these are the spellings a tool call
    // would need to make the journal hold a file that is not the workspace's.
    expect(named({ path: '../../etc/passwd' })).toEqual([])
    expect(named({ path: '/etc/shadow' })).toEqual([])
    expect(named({ path: 'sub/../../..' })).toEqual([])
  })

  it('answers nothing for arguments that name no file', () => {
    expect(named(undefined)).toEqual([])
    expect(named({ command: 'ls -la' })).toEqual([])
    expect(named({ path: '   ' })).toEqual([])
    expect(named('src/a.ts')).toEqual([])
  })

  it('never repeats a path or browses past its depth budget', () => {
    const twice = named({ files: [{ path: 'a.ts' }, { path: './a.ts' }] })
    expect(twice).toHaveLength(1)
    expect(named({ a: { b: { c: { d: { path: 'too-deep.ts' } } } } })).toEqual([])
  })

  it('caps how many files one call can put in the journal', () => {
    const many = named({ files: Array.from({ length: 20 }, (_, index) => ({ path: `f${String(index)}.ts` })) })
    expect(many).toHaveLength(8)
  })
})

describe('a multi-file call, and a revert applied twice', () => {
  /** One call that changed two files whose content is identical. */
  const twoFiles = (): HunkTracker => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'a.ts', callId: 'call-1', before: 'x\n', after: 'X\n' })
    tracker.record({ file: 'b.ts', callId: 'call-1', before: 'x\n', after: 'X\n' })
    return tracker
  }

  it('reverts one file of a multi-file call, leaving the other file\'s hunks alone', () => {
    // Before the file was part of the question, every hunk of the call was
    // considered against whatever text it was handed — so this refused, because
    // b.ts's hunk could not be found in a.ts. Identical contents here are the
    // worst case of the old scope: the wrong file's pre-image is a valid splice.
    const tracker = twoFiles()
    const result = tracker.revertCall({ callId: 'call-1', file: 'a.ts', current: 'X\n' })
    expect(result).toMatchObject({ ok: true, hunks: 1 })
    expect(result.ok && result.text).toBe('x\n')
    expect(tracker.hunks({ file: 'b.ts' })).toHaveLength(1)
    expect(tracker.hunks({ file: 'b.ts' })[0]?.reverted).toBeUndefined()
  })

  it('still reverts the other file afterwards, as its own question', () => {
    const tracker = twoFiles()
    tracker.revertCall({ callId: 'call-1', file: 'a.ts', current: 'X\n' })
    const second = tracker.revertCall({ callId: 'call-1', file: 'b.ts', current: 'X\n' })
    expect(second.ok && second.text).toBe('x\n')
  })

  it('normalizes the file name the way a record does', () => {
    // A caller naming the file the way Windows spells it has to reach the same
    // hunk: the journal stores forward slashes, so the question is normalized too.
    const tracker = new HunkTracker()
    tracker.record({ file: 'dir/a.ts', callId: 'call-1', before: 'x\n', after: 'X\n' })
    expect(tracker.revertCall({ callId: 'call-1', file: 'dir\\a.ts', current: 'X\n' }).ok).toBe(true)
  })

  it('refuses a call whose hunks are in a file the caller did not name', () => {
    const tracker = twoFiles()
    const result = tracker.revertCall({ callId: 'call-1', file: 'c.ts', current: 'X\n' })
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.failures.map(failure => failure.reason)).toEqual(['unknown-hunk'])
  })

  it('refuses to apply the same deletion twice, which used to duplicate the line', () => {
    // A tail deletion keeps only a preceding neighbour to check against, and the
    // line it re-inserts satisfies that anchor — so the second application looked
    // valid and appended a second copy of the deleted line.
    const tracker = new HunkTracker()
    tracker.record({ file: 'a.ts', callId: 'call-1', before: 'line1\nline2', after: 'line1' })
    const hunk = tracker.hunks()[0]
    const once = tracker.revert(hunk?.id ?? '', 'line1')
    expect(once.ok && once.text).toBe('line1\nline2')
    const twice = tracker.revert(hunk?.id ?? '', once.ok ? once.text : '')
    expect(twice).toEqual({ ok: false, reason: 'already-reverted', hunkId: hunk?.id })
  })

  it('refuses a second application of an insertion too, rather than calling it drift', () => {
    // The old answer here was `drifted`, which reads as "something else edited the
    // file" and sends the caller looking for an edit that never happened.
    const tracker = new HunkTracker()
    tracker.record({ file: 'a.ts', callId: 'call-1', before: 'a\nb\n', after: 'a\nB\nb\n' })
    const hunk = tracker.hunks()[0]
    const once = tracker.revert(hunk?.id ?? '', 'a\nB\nb\n')
    expect(once.ok && once.text).toBe('a\nb\n')
    expect(tracker.revert(hunk?.id ?? '', 'a\nb\n')).toMatchObject({ ok: false, reason: 'already-reverted' })
  })

  it('refuses the whole call when one of its hunks was already reverted', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'a.ts', callId: 'call-1', before: 'a\nb\nc\nd\n', after: 'a\nB\nc\nD\n' })
    const [first] = tracker.hunks()
    tracker.revert(first?.id ?? '', 'a\nB\nc\nD\n')
    const result = tracker.revertCall({ callId: 'call-1', file: 'a.ts', current: 'a\nb\nc\nD\n' })
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.failures.map(failure => failure.reason)).toContain('already-reverted')
  })

  it('reports a reverted hunk as reverted, so a caller need not remember', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'a.ts', callId: 'call-1', before: 'a\n', after: 'b\n' })
    const hunk = tracker.hunks()[0]
    expect(hunk?.reverted).toBeUndefined()
    tracker.revert(hunk?.id ?? '', 'b\n')
    expect(tracker.hunks()[0]?.reverted).toBe(true)
  })
})

describe('one file name, one spelling', () => {
  it('normalizes the spellings a caller and a platform produce', () => {
    expect(normalizeHunkFile('src/a.ts')).toBe('src/a.ts')
    expect(normalizeHunkFile('src\\nested\\a.ts')).toBe('src/nested/a.ts')
    expect(normalizeHunkFile('./src/a.ts')).toBe('src/a.ts')
    expect(normalizeHunkFile('  src/a.ts  ')).toBe('src/a.ts')
    expect(normalizeHunkFile('')).toBe('')
  })

  it('finds the same hunk whichever spelling a query uses', () => {
    // A listing that reports nothing for a file the revert then edits is the one
    // answer that makes the pair unusable, so both ends of the name go through the
    // same normalization.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src\\nested\\a.ts', callId: 'call-1', before: 'a\n', after: 'b\n' })
    expect(tracker.hunks()[0]?.file).toBe('src/nested/a.ts')
    expect(tracker.hunks({ file: 'src/nested/a.ts' })).toHaveLength(1)
    expect(tracker.hunks({ file: './src/nested/a.ts' })).toHaveLength(1)
    expect(tracker.hunks({ file: 'src\\nested\\a.ts' })).toHaveLength(1)
    expect(tracker.forget('./src/nested/a.ts')).toBe(1)
    expect(tracker.hunks()).toEqual([])
  })
})

describe('the journal is bounded', () => {
  it('drops the oldest hunk past the cap and counts it', () => {
    const tracker = new HunkTracker({ maxHunks: 2 })
    for (const call of ['call-1', 'call-2', 'call-3']) {
      tracker.record({ file: 'src/a.ts', callId: call, before: 'a\n', after: `${call}\n` })
    }
    expect(tracker.hunks().map(hunk => hunk.callId)).toEqual(['call-2', 'call-3'])
    expect(tracker.droppedCount).toBe(1)
  })

  it('refuses a nonsensical cap rather than keeping nothing', () => {
    const tracker = new HunkTracker({ maxHunks: 0 })
    for (const call of ['call-1', 'call-2']) {
      tracker.record({ file: 'src/a.ts', callId: call, before: 'a\n', after: `${call}\n` })
    }
    expect(tracker.hunks().length).toBeGreaterThan(1)
  })

  it('forgets a file that was replaced wholesale', () => {
    const tracker = new HunkTracker()
    tracker.record({ file: 'a.ts', callId: 'call-1', before: 'a\n', after: 'b\n' })
    tracker.record({ file: 'b.ts', callId: 'call-1', before: 'a\n', after: 'b\n' })
    expect(tracker.forget('a.ts')).toBe(1)
    expect(tracker.hunks().map(hunk => hunk.file)).toEqual(['b.ts'])
  })
})

describe('a call reverts wholly or not at all', () => {
  it('leaves the hunks it did revert un-consumed when a later one fails', () => {
    // The pre-checks catch the failures that are knowable before any splice. A
    // drift is not one of them: it is discovered by the splice itself, and the
    // pass below has already reverted the hunk with the higher offset by then.
    // Telling the caller nothing happened while having consumed that hunk is how
    // a call becomes permanently un-revertible — the retry after the file is
    // fixed is refused with `already-reverted`, which names a state the caller
    // never produced.
    const tracker = new HunkTracker()
    tracker.record({ file: 'src/a.ts', callId: 'call-1', before: 'a\nb\nc\nd\n', after: 'a\nB\nc\nD\n' })
    const [lower, upper] = tracker.hunks()
    // `c`'s neighbour was edited outside the tracker, so the lower region cannot
    // be placed while the upper one still can.
    const failed = tracker.revertCall({ callId: 'call-1', file: 'src/a.ts', current: 'a\nX\nc\nD\n' })
    expect(failed.ok).toBe(false)
    expect(failed.ok ? [] : failed.failures.map(failure => failure.reason)).toEqual(['drifted'])
    expect(tracker.hunks().filter(hunk => hunk.reverted === true)).toEqual([])
    // And the whole call is still there to be reverted once the file is back.
    const again = tracker.revertCall({ callId: 'call-1', file: 'src/a.ts', current: 'a\nB\nc\nD\n' })
    expect(again.ok && again.text).toBe('a\nb\nc\nd\n')
    expect(lower?.id).not.toBe(upper?.id)
  })
})
