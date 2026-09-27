/**
 * The companion's face tool: everything this package contributes to it.
 *
 * Why this file exists
 * --------------------
 * The tool has no host service, no side effect, and no state of its own — its whole
 * behaviour is a schema, an answer, and a refusal. That is exactly the shape of tool a
 * suite skips, so the three things it can still get wrong are asserted here rather than
 * left to the one place it is used:
 *
 * - **the name**, because the client matches calls by it and a rename would be a tool that
 *   answers the model and moves nothing on screen (`companion/tool.ts` states the
 *   prefix rule; the client's own spec holds the other end of the spelling);
 * - **the vocabulary**, because a name offered in the schema that the character has no
 *   face for is a request that silently does nothing — the failure mode this whole
 *   feature is easiest to ship by accident;
 * - **the refusal**, because a caller that ignores the schema must be told what exists
 *   instead of being obeyed.
 */

import { describe, expect, it } from 'vitest'
import {
  COMPANION_FACES,
  COMPANION_FACE_TOOL_NAME,
  companionFaceToolDefinition,
  isCompanionFace,
} from '../src/companion/tool.ts'

/** The definition, with the members the registry types as opaque read as the tests read them. */
const tool = companionFaceToolDefinition()

/** @returns what a call with these arguments answers. */
function run(args: unknown): unknown {
  return (tool.execute as (value: unknown) => unknown)(args)
}

describe('the companion face tool', () => {
  it('is named under the prefix Harness classifies deferred tools and Plan Mode by', () => {
    expect(tool.name).toBe(COMPANION_FACE_TOOL_NAME)
    expect(tool.name.startsWith('freecodego_')).toBe(true)
  })

  it('offers the vocabulary in the schema the model is shown', () => {
    const parameters = tool.parameters as {
      readonly required?: readonly string[]
      readonly additionalProperties?: boolean
      readonly properties: { readonly face: { readonly enum: readonly string[] } }
    }
    expect(parameters.required).toEqual(['face'])
    expect(parameters.additionalProperties).toBe(false)
    // In order, so the description's own list and the enum cannot disagree about it.
    expect(parameters.properties.face.enum).toEqual([...COMPANION_FACES])
  })

  it('says what it does to a caller that asked for a face it has', () => {
    const answer = run({ face: 'happy' }) as { readonly kind: string; readonly face: string; readonly note: string }
    expect(answer.kind).toBe('face')
    expect(answer.face).toBe('happy')
    // The note is the contract a caller reads: the face changes and the words do not. A
    // model that believed otherwise would use this as a status channel, and the label it
    // would be contradicting is derived from the session.
    expect(answer.note).toContain('face only')
  })

  it('refuses a name it does not have, and says which ones it does', () => {
    const answer = run({ face: 'smug' }) as { readonly kind: string; readonly available: readonly string[] }
    expect(answer.kind).toBe('refused')
    expect(answer.available).toEqual(COMPANION_FACES)
    // A call with nothing to go on refuses for the same reason: the schema is what a
    // well-behaved caller is held to, and this is what a caller that ignored it is held to.
    expect((run({}) as { readonly kind: string }).kind).toBe('refused')
    expect((run({ face: 'constructor' }) as { readonly kind: string }).kind).toBe('refused')
  })

  it('takes a name only when it is one of the vocabulary\'s own keys', () => {
    for (const face of COMPANION_FACES) expect(isCompanionFace(face), face).toBe(true)
    // The two strings on every object: a lookup that walked the prototype chain would
    // accept them, and both would then be offered as expressions nothing can draw.
    expect(isCompanionFace('constructor')).toBe(false)
    expect(isCompanionFace('toString')).toBe(false)
    expect(isCompanionFace(undefined)).toBe(false)
    expect(isCompanionFace(0)).toBe(false)
  })

  it('labels the call with the face it asked for, so the transcript reads as itself', () => {
    const presented = (tool.presentCall as (args: unknown) => { readonly title: string })({ face: 'focused' })
    expect(presented.title).toContain('focused')
  })
})
