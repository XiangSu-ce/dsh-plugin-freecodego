/**
 * Two sessions, one plan file.
 *
 * `safeSegment` turns a session id into one path segment, and it did it by
 * replacing everything unreserved with `_` — a mapping that is not injective:
 * `a/b` and `a_b` both became `a_b`, so two sessions shared one `plan.md`, A's
 * plan read back as B's, and `isPlanFile(B, A's path)` was true. The same
 * repository already contains an injective mapping for this exact job
 * (`spill-local`'s `encodeSegment`, whose module header says "distinct inputs
 * never collide"), which is what made the second one visible.
 *
 * The properties below are the ones that make a *derived filename* safe: distinct
 * ids stay distinct (checked over a corpus and by brute force), an id that is
 * already a legal segment is not mangled, and no output is a traversal or a name a
 * platform folds into another.
 */

import { describe, expect, it } from 'vitest'
import { PLAN_FILE_NAME, isPlanFile, planFilePath, safeSegment } from '../src/plan/plan-file.ts'

describe('safeSegment', () => {
  it('keeps distinct session ids distinct', () => {
    // Each pair is one id that needs escaping and one that is already a legal
    // segment, which is exactly the pair the old rule folded together.
    for (const [left, right] of [
      ['a/b', 'a_b'],
      ['s1:2', 's1_2'],
      ['sess A', 'sess_A'],
      ['a:b', 'a_b'],
      ['./etc', 'etc'],
    ] as const) {
      expect(safeSegment(left), `${left} vs ${right}`).not.toBe(safeSegment(right))
    }
  })

  it('never maps two different ids to one segment, over a brute-force corpus', () => {
    // The alphabet includes every character class the mapping treats specially:
    // the escape character itself, a separator, a space, a dot, and two
    // characters whose escapes are the same shape but different lengths — a
    // fixed-width escape is what keeps the last pair distinguishable from a
    // shorter escape followed by a literal digit.
    const alphabet = ['a', 'b', '/', '_', ':', ' ', '.', '~', '0', '\u1000', '\u{10000}']
    const inputs: string[] = ['']
    for (const first of alphabet) {
      inputs.push(first)
      for (const second of alphabet) {
        inputs.push(first + second)
        for (const third of alphabet) inputs.push(first + second + third)
      }
    }
    const seen = new Map<string, string>()
    for (const input of inputs) {
      const encoded = safeSegment(input)
      const previous = seen.get(encoded)
      expect(previous, `both ${JSON.stringify(previous)} and ${JSON.stringify(input)} map to ${JSON.stringify(encoded)}`).toBeUndefined()
      seen.set(encoded, input)
    }
  })

  it('leaves a session id that is already a legal segment alone', () => {
    // Readability is the reason the mapping is not a hash: a plan file has to stay
    // findable by name.
    for (const id of ['session-1', 'sess_01H8Z', 'a.b-c_d']) expect(safeSegment(id)).toBe(id)
    // The empty id keeps a segment of its own, and it is the one value no other id
    // can produce — a bare `~`, which never appears in a produced segment except as
    // the start of a six-digit escape. It used to be `_`, which is what the
    // perfectly ordinary id `_` maps to.
    expect(safeSegment('')).toBe('~')
    expect(safeSegment('_')).toBe('_')
  })

  it('never produces a separator, a traversal, or a name a platform would fold', () => {
    for (const id of ['../../etc/passwd', '..', '.', 'a/../b', 'C:/Windows', 'a.', 'a ', '~', '/']) {
      const segment = safeSegment(id)
      expect(segment, `${id} -> ${segment}`).not.toContain('/')
      expect(segment).not.toContain('\\')
      expect(segment).not.toBe('.')
      expect(segment).not.toBe('..')
      expect(segment).not.toBe('')
      // win32 drops a trailing dot or space from a path component, so a segment
      // ending in one is a second spelling of the segment without it.
      expect(segment.endsWith('.') || segment.endsWith(' '), `${id} -> ${segment}`).toBe(false)
    }
  })

  it('gives two colliding ids two plan files, and each names only its own', () => {
    // The consequence, on the paths that matter: the store is addressed by id, so
    // the collision was two sessions writing and reading one file.
    expect(planFilePath('a/b')).not.toBe(planFilePath('a_b'))
    expect(isPlanFile('a/b', planFilePath('a/b'))).toBe(true)
    expect(isPlanFile('a_b', planFilePath('a/b'))).toBe(false)
    expect(planFilePath('a/b').endsWith(PLAN_FILE_NAME)).toBe(true)
  })
})
