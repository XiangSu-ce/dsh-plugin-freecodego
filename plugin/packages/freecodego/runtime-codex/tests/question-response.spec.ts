import { describe, expect, it } from 'vitest'
import { questionResponse } from '../src/question-response.ts'

// The shapes asserted here are the App Server's, read from
// `.tmp-codex-schema/ToolRequestUserInputResponse.json`: `answers` is an object
// keyed by question id, each value `{ answers: string[] }`. The Host's answer is
// an array of `{ id, selected, custom? }` records, so these cases pin the
// projection rather than restating the implementation.
describe('questionResponse', () => {
  it('keys the answers by question id, which is the only shape the App Server declares', () => {
    expect(questionResponse({ answers: [{ id: 'scope', selected: ['small'] }] }))
      .toEqual({ answers: { scope: { answers: ['small'] } } })
  })

  it('carries every selected label in order', () => {
    expect(questionResponse({ answers: [{ id: 'scope', selected: ['small', 'large'] }] }))
      .toEqual({ answers: { scope: { answers: ['small', 'large'] } } })
  })

  it('appends the free-text answer instead of dropping it', () => {
    // The composer clears `selected` for a single-select custom answer and keeps
    // both for a multi-select one, so one concatenation covers either case.
    expect(questionResponse({ answers: [{ id: 'scope', selected: [], custom: 'exactly 3 files' }] }))
      .toEqual({ answers: { scope: { answers: ['exactly 3 files'] } } })
    expect(questionResponse({ answers: [{ id: 'scope', selected: ['small'], custom: 'exactly 3 files' }] }))
      .toEqual({ answers: { scope: { answers: ['small', 'exactly 3 files'] } } })
  })

  it('answers a skipped question with an empty list rather than omitting the id', () => {
    expect(questionResponse({ answers: [{ id: 'scope', selected: [] }] }))
      .toEqual({ answers: { scope: { answers: [] } } })
  })

  it('keeps the ids it was given, one entry per question', () => {
    expect(questionResponse({ answers: [{ id: 'a', selected: ['1'] }, { id: 'b', selected: ['2'] }] }))
      .toEqual({ answers: { a: { answers: ['1'] }, b: { answers: ['2'] } } })
  })

  it('merges a repeated question id rather than letting one entry win', () => {
    expect(questionResponse({ answers: [{ id: 'a', selected: ['1'] }, { id: 'a', custom: 'two' }] }))
      .toEqual({ answers: { a: { answers: ['1', 'two'] } } })
  })

  it('answers with an empty map when the Host produced no answer at all', () => {
    // `{ answers: [] }` is what the Host sends when its question service failed,
    // and it must not become a frame the App Server cannot deserialize.
    expect(questionResponse({ answers: [] })).toEqual({ answers: {} })
    expect(questionResponse(undefined)).toEqual({ answers: {} })
    expect(questionResponse(null)).toEqual({ answers: {} })
    expect(questionResponse({ type: 'rejected' })).toEqual({ answers: {} })
    expect(questionResponse({ answers: 'scope=small' })).toEqual({ answers: {} })
  })

  it('ignores entries that carry no question id and values that are not labels', () => {
    expect(questionResponse({ answers: [{ selected: ['small'] }, { id: 'scope', selected: ['small', 7, null] }] }))
      .toEqual({ answers: { scope: { answers: ['small'] } } })
  })
})
