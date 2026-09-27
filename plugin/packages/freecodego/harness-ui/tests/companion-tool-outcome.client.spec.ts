/**
 * One reading spanning two packages: what a failed tool result looks like.
 *
 * Why this file exists
 * --------------------
 * The exit marker in a shell result is read on both sides of the wire, and neither can
 * import the other's value: the plugin reads it to diagnose a Windows loader failure
 * (`freecodego/harness-plugin/src/shell-loader-failure.ts`, at the `tools/post-execute`
 * seam), and this client reads it to decide whether the companion winces
 * (`../src/client/companion/tool-outcome.ts`). The two readers have to agree about what a
 * marker *is*, or the same result would be a failure for one and not the other — and the
 * client's disagreement is the silent kind: the character simply never winces, with
 * nothing anywhere to say why.
 *
 * The tie is asserted as agreement rather than as a copy of the pattern: for every sample
 * below, **the plugin's reader and this client's predicate must reach the same verdict**.
 * A change to either pattern, or to the `undefined`/zero rules around it, fails here.
 *
 * A test-only import of another package's source, for the reason
 * `companion-face-tool.client.spec.ts` gives: this is a place where two spellings of one
 * fact are cheaper than a shared module, and the tie costs a test that runs in this lane
 * already.
 */

import { describe, expect, it } from 'vitest'
import { reportedExitCode } from '@deepseek-ai/dsh-freecodego-harness-plugin/src/shell-loader-failure.ts'
import { toolResultFailed } from '../src/client/companion/tool-outcome.ts'

/** One result message whose only content is a text block, as the session writes it. */
function shellResult(text: string): unknown {
  return { role: 'tool', isError: false, content: [{ type: 'text', text }] }
}

const SAMPLES: readonly string[] = [
  // The measurement this feature was built on, taken from a live session's own window.
  '[stderr]\nfcg-not-a-real-binary: The term is not recognized\n[exit code: 1]',
  // A command that worked. The harness only renders the marker for a nonzero exit, but a
  // zero one is accepted here because "the renderer never writes it" is a claim about the
  // renderer, not about the reading.
  'done\n[exit code: 0]',
  // No marker at all, which is most results.
  'No files found',
  // Several markers: the last one describes the call, and both readers take it.
  'one\n[exit code: 2]\ntwo\n[exit code: 1]',
  // A marker in the middle of prose is still a marker for the plugin's reader, so this
  // client cannot be the stricter of the two — that is the drift this test exists for.
  'the note says [exit code: 1] somewhere in the middle',
  // The loader failure this plugin diagnoses, which is a failure here too.
  '(no output)\n[exit code: 3221225794]',
  // Shapes neither reader may fire on: a code that is not a number, and one that is not
  // the marker's own bracket form.
  '[exit code: 1.5]',
  'exit code: 1',
]

describe('what a failed tool result looks like', () => {
  it('agrees with the plugin about the exit marker, sample for sample', () => {
    for (const text of SAMPLES) {
      const pluginReads = reportedExitCode(text)
      const clientReads = toolResultFailed(shellResult(text))
      const expected = pluginReads !== undefined && pluginReads !== 0
      expect(clientReads, `text: ${JSON.stringify(text)}`).toBe(expected)
    }
  })

  it('reads the toll the tool itself reports: `isError` on the message', () => {
    // The other shape, and the one the plugin's reader knows nothing about — it is the
    // core's own flag for a tool that did not complete, so it is this side's to read.
    expect(toolResultFailed({ role: 'tool', isError: true, content: [] })).toBe(true)
    expect(toolResultFailed({ role: 'tool', isError: true })).toBe(true)
    // A truthy string is not the flag: `isError` is a boolean in the session's own type,
    // and reading anything truthy would make "false" and "0" failures in other shapes.
    expect(toolResultFailed({ role: 'tool', isError: 'yes' })).toBe(false)
  })

  it('drops a marker that is not in a text block', () => {
    // A block that is not text is named rather than searched, which is the plugin's rule
    // for the same reason: a code inside an image's caption or an attached file is not a
    // shell reporting its exit code.
    const image = { type: 'image', text: '[exit code: 1]' }
    expect(toolResultFailed({ isError: false, content: [image] })).toBe(false)
    expect(toolResultFailed({ isError: false, content: [null, 7, 'text', image] })).toBe(false)
    // But a text block beside it is read, and the join is not what makes it a marker.
    expect(toolResultFailed({ isError: false, content: [image, { type: 'text', text: '[exit code: 1]' }] })).toBe(true)
  })

  it('answers "no" rather than throwing for anything it cannot read', () => {
    // This predicate runs inside the feed's own subscriber, where a throw is caught and
    // logged but takes the published reading with it — so every unreadable payload has to
    // be a plain `false` instead of an exception.
    for (const message of [undefined, null, 'failed', 7, [], { content: 'no blocks' }]) {
      expect(toolResultFailed(message), JSON.stringify(message)).toBe(false)
    }
  })
})
