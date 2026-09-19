/**
 * The one definition of the project-memory context fence.
 *
 * The block is injected unsolicited at session start, so its fence is the only
 * thing telling a reader where untrusted stored history stops. It has three
 * readers — the model, the chat projection (`agent-progress.ts`), and the
 * turn-summary scrubber (`engineering.ts`) — and the text inside it is
 * model-written, so it can carry the closing tag itself. A fence whose closing
 * tag is a literal ends the section on a line the stored text chooses, and a
 * stripper written against one hands everything after that line back to the
 * caller as if the agent had produced it.
 *
 * Two rules close that, and both are needed:
 *
 * 1. the nonce the producer stamps on the opening tag is repeated on the closing
 *    tag, and {@link stripMemoryContextSections} ends a section only at the tag
 *    that repeats it — the same treatment `memory/memory-selector.ts` gives
 *    recall candidates;
 * 2. {@link neutralizeMemoryContextTags} escapes the delimiter in the text a
 *    producer interpolates, so the surviving tag pair is the only pair in the
 *    artifact even for a reader that pattern-matches naively (a model).
 *
 * A section whose closing tag never arrived (a truncated injection, or one
 * written by an older producer) is removed through the end of the value: the
 * failure direction of a fence is to hide too much, never to leak.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory-context
 */

import { randomBytes } from 'node:crypto'
import { neutralizeFenceTags } from './fence-text.ts'

const TAG = 'freecodego-memory-context'
/** Opening tag, capturing its attribute text. */
const OPEN = new RegExp(`<${TAG}\\b([^>]*)>`, 'gi')
/** Closing tag, capturing its attribute text. */
const CLOSE = new RegExp(`</${TAG}\\b([^>]*)>`, 'gi')
/** The attribute the producer puts on both tags of one injection. */
const NONCE = /\bdata-fcg-[0-9a-f]+\b/i

export interface MemoryContextFence {
  /** Opening tag, carrying the nonce. */
  readonly open: string
  /** Closing tag, carrying the same nonce. */
  readonly close: string
}

/** Mint the tag pair for one injection. The nonce is per call, so stored text
 *  cannot contain the closing tag this injection ends on. */
export function memoryContextFence(): MemoryContextFence {
  const nonce = `data-fcg-${randomBytes(6).toString('hex')}`
  return {
    open: `<${TAG} scope="project" managed="ai" ${nonce}>`,
    close: `</${TAG} ${nonce}>`,
  }
}

/** Escape the fence delimiters in text that is about to be interpolated into a
 *  fence, so the artifact contains exactly one opening and one closing tag. */
export function neutralizeMemoryContextTags(value: string): string {
  return neutralizeFenceTags(value, TAG)
}

/**
 * Remove every injected context section from `value`, including the text a
 * crafted body appended after a closing tag it brought along.
 */
export function stripMemoryContextSections(value: string): string {
  let output = ''
  let cursor = 0
  for (const match of value.matchAll(OPEN)) {
    const start = match.index ?? 0
    // Nested or already-removed openings inside a section end nothing: the
    // section they sit in was removed above.
    if (start < cursor) continue
    output += value.slice(cursor, start)
    const nonce = NONCE.exec(match[1] ?? '')?.[0]
    const end = sectionEnd(value, start + match[0].length, nonce)
    if (end === undefined) return output
    cursor = end
  }
  return output + value.slice(cursor)
}

/** Just past the closing tag of the section whose body starts at `from`. */
function sectionEnd(value: string, from: number, nonce: string | undefined): number | undefined {
  for (const match of value.matchAll(CLOSE)) {
    const index = match.index ?? 0
    if (index < from) continue
    const attributes = (match[1] ?? '').trim()
    // A tag that repeats this injection's nonce is the real end; for a fence
    // written without one (an older producer, a hand-built message), the bare
    // closing tag is all there is to go on.
    if (nonce === undefined ? attributes === '' : attributes.includes(nonce)) return index + match[0].length
  }
  return undefined
}
