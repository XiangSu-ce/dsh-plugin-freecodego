/**
 * The ceiling on one JSONL frame this worker writes to the Host, and what a frame
 * over it becomes.
 *
 * Why this module exists
 * ----------------------
 * Two other modules used to *assert* that "the JSONL worker protocols cap a frame
 * at 1 MB" — `harness-plugin/src/capabilities.ts` used that sentence to justify
 * never inlining image bytes, and `mcp-tool-result.ts` used it to explain why an
 * image can only cross as a reference. Nothing in either package enforced one:
 * a grep for a byte check found the comments and no code, and the worker's
 * `send()` wrote whatever it was handed. A defence whose whole content is a claim
 * about the other process is not a defence: a reply the Host's reader cannot take
 * is a tool call that never returns, and the plugin would not know why.
 *
 * What is enforced here, and what is not
 * --------------------------------------
 * This is a bound on *our* side of the wire. Everything the worker writes goes
 * through one function, so an oversized frame cannot leave the process. The Host's
 * own limit stays the Host's business; the honest statement about it is that this
 * worker stays under a documented number, not that the Host refuses anything
 * bigger.
 *
 * An over-budget frame is *replaced*, never truncated mid-line: a partial JSON
 * line is exactly the unreadable frame this module exists to prevent. A reply (an
 * `id` is present) becomes a `FRAME_TOO_LARGE` error naming both sizes, because
 * the caller asked a question and deserves an answer it can act on. An event (no
 * `id`) keeps its `method` and carries a notice instead of its payload, so the
 * Host sees an event it knows with a payload that says it was dropped rather than
 * a line it cannot parse.
 *
 * @module @deepseek-ai/dsh-freecodego-runtime-codex/frame-budget
 */

/** Hard ceiling for one frame the worker writes, in UTF-8 bytes. */
export const MAX_WORKER_FRAME_BYTES = 1_000_000

/**
 * Text budget for one projected tool result.
 *
 * Below {@link MAX_WORKER_FRAME_BYTES} on purpose: the frame carries a JSON
 * envelope (`id`, `result`, `content[]`) around the text, so a result that only
 * *just* fit its own bytes would be replaced by a `FRAME_TOO_LARGE` error at the
 * last step — losing everything instead of the tail. This gap is what keeps the
 * frame backstop unreachable for ordinary tool results.
 */
export const MAX_TOOL_RESULT_TEXT_BYTES = 900_000

/**
 * Smallest ceiling this module will honour.
 *
 * Below it no bounded substitute exists: the JSON envelope around a `FRAME_TOO_LARGE`
 * code is already larger than the ceiling, and a module that silently wrote the
 * line anyway would produce exactly the over-budget frame it exists to prevent.
 * A caller asking for an impossible ceiling therefore gets this one, and the clamp
 * is visible in the returned `line` rather than in a promise it cannot keep.
 */
export const MIN_FRAME_CEILING = 256

/** Code the Host sees when a reply could not be carried inside the ceiling. */
export const FRAME_TOO_LARGE = 'FRAME_TOO_LARGE'

/** One frame to write, and whether the message inside it was replaced. */
export interface WorkerFrame {
  /** A single line, newline included, never longer than the ceiling. */
  readonly line: string
  /** True when the message did not fit and a bounded substitute was written. */
  readonly replaced: boolean
  /** UTF-8 bytes the original message would have taken, newline included. */
  readonly originalBytes: number
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * How much text a projected tool result may carry before it is cut short.
 *
 * @param text - the text a projection produced.
 * @param budget - byte budget; defaults to {@link MAX_TOOL_RESULT_TEXT_BYTES}.
 * @returns the text, or a prefix plus a marker that names what was dropped.
 */
export function boundToolResultText(text: string, budget: number = MAX_TOOL_RESULT_TEXT_BYTES): string {
  const limit = Number.isFinite(budget) && budget > 0 ? Math.max(MIN_FRAME_CEILING, Math.floor(budget)) : MAX_TOOL_RESULT_TEXT_BYTES
  if (bytesOf(text) <= limit) return text
  // Cut on a character boundary: a byte slice through a multi-byte character
  // yields a replacement character, which reads like corruption rather than a
  // truncated result.
  const marker = '\n\n… [result truncated: this output exceeded the transport limit; ask for a narrower range, a page, or a filter to see the rest]'
  const markerBytes = bytesOf(marker)
  let kept = ''
  let used = 0
  for (const character of text) {
    const size = bytesOf(character)
    if (used + size + markerBytes > limit) break
    kept += character
    used += size
  }
  return `${kept}${marker}`
}

/**
 * The one frame the worker may write for a message.
 *
 * @param message - the reply or event to serialize.
 * @param maxBytes - frame ceiling; defaults to {@link MAX_WORKER_FRAME_BYTES}.
 * @returns the line to write and whether it is a substitute.
 */
export function workerFrame(message: unknown, maxBytes: number = MAX_WORKER_FRAME_BYTES): WorkerFrame {
  const ceiling = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.max(MIN_FRAME_CEILING, Math.floor(maxBytes)) : MAX_WORKER_FRAME_BYTES
  const line = `${JSON.stringify(message) ?? 'null'}\n`
  const originalBytes = bytesOf(line)
  if (originalBytes <= ceiling) return { line, replaced: false, originalBytes }

  const id = (message as { readonly id?: unknown } | null | undefined)?.id
  if (typeof id === 'string') {
    const reply = `${JSON.stringify({
      id,
      error: {
        code: FRAME_TOO_LARGE,
        message: `this reply is ${String(originalBytes)} bytes and the worker transport carries at most ${String(ceiling)}; ask for a narrower range, a page, or a filter and retry`,
      },
    })}\n`
    if (bytesOf(reply) <= ceiling) return { line: reply, replaced: true, originalBytes }
    return { line: `${JSON.stringify({ id, error: { code: FRAME_TOO_LARGE, message: 'the reply exceeded the frame ceiling' } })}\n`, replaced: true, originalBytes }
  }

  const method = (message as { readonly method?: unknown } | null | undefined)?.method
  const notice = `${JSON.stringify({
    ...(typeof method === 'string' ? { method } : {}),
    params: {
      truncated: true,
      originalBytes,
      reason: `this frame was ${String(originalBytes)} bytes, over the ${String(ceiling)}-byte ceiling this worker writes within, so its payload was dropped`,
    },
  })}\n`
  if (bytesOf(notice) <= ceiling) return { line: notice, replaced: true, originalBytes }
  return { line: `${JSON.stringify({ params: { truncated: true, originalBytes } })}\n`, replaced: true, originalBytes }
}
