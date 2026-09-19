import { describe, expect, it } from 'vitest'
import { jsonArraysIn, jsonObjectsIn } from '../src/json-text.ts'

/**
 * The two consumers of this helper ask a model for a JSON object and read it back
 * out of prose, so the cases below are the prose shapes that actually appear: a
 * sentence before the object, a sentence after it, a brace quoted from the
 * untrusted text the model was asked to judge, and a brace inside the object's own
 * strings. The old greedy span (`/\{[\s\S]*\}/`) got the first three wrong.
 *
 * `jsonArraysIn` serves the two memory modules, which reached for the array
 * spelling of the same greedy span (`/\[[\s\S]*\]/`) and hit the same three
 * cases, so its block below mirrors this one.
 */
describe('jsonObjectsIn', () => {
  it('reads a bare object', () => {
    expect(jsonObjectsIn('{"verdict":"allow"}')).toEqual([{ verdict: 'allow' }])
  })

  it('reads an object that prose surrounds', () => {
    expect(jsonObjectsIn('I think {\n  "verdict": "deny",\n  "rationale": "outside the workspace"\n} here.'))
      .toEqual([{ verdict: 'deny', rationale: 'outside the workspace' }])
  })

  it('reads the verdict even when an object follows it in the same answer', () => {
    // The greedy reading captured `…}\n\nI ignored the {"note":"example"}` and
    // `JSON.parse` threw, so a real verdict was reported as `reviewer-failed`.
    const answer = '{"verdict":"allow","rationale":"read-only"}\n\nI ignored the {"note":"example"} left in the transcript.'
    expect(jsonObjectsIn(answer)[0]).toEqual({ verdict: 'allow', rationale: 'read-only' })
  })

  it('is not confused by a brace inside a string', () => {
    expect(jsonObjectsIn('{"verdict":"deny","rationale":"closes the } block"}'))
      .toEqual([{ verdict: 'deny', rationale: 'closes the } block' }])
  })

  it('is not confused by an escaped quote', () => {
    expect(jsonObjectsIn('{"note":"he said \\"no\\" and left"}')).toEqual([{ note: 'he said "no" and left' }])
  })

  it('reads a nested object as the outer object first and its own entry too', () => {
    const found = jsonObjectsIn('{"outer":{"inner":1}}')
    expect(found[0]).toEqual({ outer: { inner: 1 } })
    expect(found).toContainEqual({ inner: 1 })
  })

  it('finds every object in order of appearance', () => {
    expect(jsonObjectsIn('{"a":1} and {"b":2}').map(value => Object.keys(value)[0])).toEqual(['a', 'b'])
  })

  it('reports nothing for prose that only looks like an object', () => {
    expect(jsonObjectsIn('I cannot decide.')).toEqual([])
    expect(jsonObjectsIn('{not json}')).toEqual([])
    // Unbalanced: the opening brace never closes, so no span parses.
    expect(jsonObjectsIn('{"verdict":"al')).toEqual([])
    // A JSON array is not an object, and neither is a bare scalar.
    expect(jsonObjectsIn('[{"a":1}]')).toEqual([{ a: 1 }])
    expect(jsonObjectsIn('{"a":[1,2],"b":null}')).toEqual([{ a: [1, 2], b: null }])
  })
})

describe('jsonArraysIn', () => {
  it('reads a bare array', () => {
    expect(jsonArraysIn('["mem_a"]')).toEqual([['mem_a']])
  })

  it('reads an array that prose surrounds', () => {
    expect(jsonArraysIn('Sure! Here are the ids:\n["mem_a"]\nHope that helps.'))
      .toEqual([['mem_a']])
  })

  it('skips a bracketed word before the array instead of swallowing it', () => {
    // The greedy reading captured `[retry] decision; the ids are ["mem_a"]`,
    // `JSON.parse` threw, and a selection the model did produce was reported as a
    // failure — which is why neither memory module could rely on locating one.
    expect(jsonArraysIn('I weighed the [retry] decision; the ids are ["mem_a"].'))
      .toEqual([['mem_a']])
  })

  it('skips a bracketed word after the array', () => {
    expect(jsonArraysIn('["mem_a"]\n\n(see the [notes] section)')).toEqual([['mem_a']])
  })

  it('is not confused by a bracket inside a string', () => {
    expect(jsonArraysIn('["closes the ] cell"]')).toEqual([['closes the ] cell']])
  })

  it('reads a nested array as the outer array first and its own entry too', () => {
    const found = jsonArraysIn('[["a"],["b"]]')
    expect(found[0]).toEqual([['a'], ['b']])
    expect(found).toContainEqual(['a'])
  })

  it('reads an empty array, which is a real answer for both consumers', () => {
    expect(jsonArraysIn('[]')).toEqual([[]])
  })

  it('reports nothing for prose that only looks like an array', () => {
    expect(jsonArraysIn('I could not decide.')).toEqual([])
    expect(jsonArraysIn('[mem_a, mem_b]')).toEqual([])
    // Unbalanced: the opening bracket never closes, so no span parses.
    expect(jsonArraysIn('["mem_a"')).toEqual([])
  })
})
