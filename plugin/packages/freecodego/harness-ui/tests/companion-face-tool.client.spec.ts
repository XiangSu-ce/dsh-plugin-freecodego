/**
 * One contract spanning two packages: the tool the model calls, and the faces this client
 * can draw.
 *
 * Why this file exists
 * --------------------
 * The request travels as a tool call, and the two halves that have to agree about it live
 * in different packages. They cannot share a running value — this package may import the
 * plugin's *types* and its browser entry, and the plugin may not import this one at all —
 * so the plugin declares the vocabulary the model is shown, this package maps those names
 * onto outlines, and **this spec is the tie**: it imports the plugin's declaration and
 * holds it against the table the renderer uses.
 *
 * Both directions are asserted, because the two failures are different. A name the tool
 * offers and this client cannot draw is a request that does nothing at all (the model asks
 * for a face the character does not have, and the call reads as a success). A name this
 * client can draw that the tool never offers is a shape nothing can reach — which is
 * exactly why `EYE_EXPRESSIONS` is short and every entry is a shape a pose already draws.
 *
 * A test-only import of another package's source is deliberate here and not a pattern to
 * spread: it is the one place where two spellings of one fact are cheaper than a shared
 * module, and the tie costs a test that runs in this lane already.
 */

import { describe, expect, it } from 'vitest'
import {
  COMPANION_FACES,
  COMPANION_FACE_TOOL_NAME,
} from '@deepseek-ai/dsh-freecodego-harness-plugin/src/companion/tool.ts'
import { COMPANION_FACE_TOOL_NAME as CLIENT_TOOL_NAME } from '../src/client/companion/activity.ts'
import { EYE_EXPRESSIONS, isExpressionName } from '../src/client/companion/eyes/faces.ts'

describe('the face tool and the faces this client draws', () => {
  it('spells the tool name the same way on both sides of the wire', () => {
    // The client matches calls by this name; a rename on one side is a request the model
    // makes and the character never hears.
    expect(CLIENT_TOOL_NAME).toBe(COMPANION_FACE_TOOL_NAME)
  })

  it('offers exactly the names this client can draw, and none it cannot', () => {
    expect([...COMPANION_FACES].sort()).toEqual(Object.keys(EYE_EXPRESSIONS).sort())
    for (const face of COMPANION_FACES) expect(isExpressionName(face), face).toBe(true)
  })

  it('draws each of them from the vocabulary the poses already use', () => {
    // Every expression names an outline, in the same table the poses are drawn from: a
    // request can therefore only ask for a shape someone has looked at.
    for (const [name, outline] of Object.entries(EYE_EXPRESSIONS)) {
      expect(outline.length > 0, name).toBe(true)
    }
    // And they are not all the same shape, which a table of names would not have caught.
    expect(new Set(Object.values(EYE_EXPRESSIONS)).size).toBeGreaterThan(3)
  })
})
