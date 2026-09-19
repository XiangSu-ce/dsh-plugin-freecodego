/**
 * Project one Harness bridge result into an MCP tool result.
 *
 * The Host answers `tool/execute` with the tool's rendered content blocks. This
 * used to be `JSON.stringify`d whole, which hid the result twice over: the model
 * received one JSON document containing another, and `isError` was dropped — so a
 * *failed* Harness tool arrived as a successful-looking call, and a media tool's
 * generated image arrived as an attachment id inside that nested text.
 *
 * This is deliberately not the Claude-side projection (`projectToolContent` in
 * `runtime-claude`), because the two transports differ where it matters: the
 * in-process Claude session carries live objects and inlines real image bytes,
 * while every result crossing this worker's JSONL frame is capped at
 * {@link MAX_WORKER_FRAME_BYTES} — one image cannot fit — so an image here can
 * only ever be a reference. Sharing the module would mean adding a cross-package
 * dependency for one small function and
 * would still need the flag that distinguishes them; the two behaviours are
 * therefore pinned by their own tests instead.
 *
 * @module @deepseek-ai/dsh-freecodego-runtime-codex/mcp-tool-result
 */

/** One MCP content block this transport can return. */
import { boundToolResultText } from './frame-budget.ts'

export interface CodexToolContentBlock {
  readonly type: 'text'
  readonly text: string
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null)
}

/**
 * Convert one bridge result into MCP content plus its failure flag.
 *
 * A bridge that does not answer with content blocks — a Skill listing, for
 * example — keeps the previous whole-value JSON behaviour, and an unrecognized
 * block keeps its own JSON, so no part of a result is silently lost.
 *
 * @param value - the value returned by the Host bridge, or a thrown-free failure payload.
 * @returns the MCP result body.
 */
export function mcpToolResult(value: unknown): { readonly content: readonly CodexToolContentBlock[]; readonly isError?: boolean } {
  const result = record(value)
  const blocks = Array.isArray(result.content)
    ? result.content
    : []
  // Bounded here rather than at the frame: a result that is too big to cross the
  // transport is worth its prefix plus a marker, and the frame layer can only
  // answer a whole frame with an error. See `frame-budget.ts`.
  const content = blocks.flatMap(block => projectBlock(block)).map(block => ({ type: 'text' as const, text: boundToolResultText(block.text) }))
  const body = content.length === 0 ? [{ type: 'text' as const, text: boundToolResultText(stringify(value)) }] : content
  return { content: body, ...(isFailure(result) ? { isError: true } : {}) }
}

/**
 * Whether the bridge reported a failure, however it said so.
 *
 * The bridge is another process's JSON, so its failure flag arrives as whatever
 * it serialized: `true`, `1`, `"true"`, or an `error` payload with no flag at
 * all. Reading only the literal `true` re-opened the hole this module exists to
 * close — a *failed* tool call arriving as a successful-looking one — so every
 * affirmative shape counts. Only a genuinely empty flag is read as success.
 */
function isFailure(result: Record<string, unknown>): boolean {
  const error = result.error
  if (typeof error === 'string' ? error !== '' : error !== undefined && error !== null) return true
  const flag = result.isError
  if (flag === undefined || flag === null || flag === false || flag === 0 || flag === '') return false
  return true
}

function projectBlock(block: unknown): CodexToolContentBlock[] {
  const candidate = record(block)
  if (candidate.type === 'text' && typeof candidate.text === 'string') return [{ type: 'text', text: candidate.text }]
  if (candidate.type === 'image') {
    // Bytes cannot cross the 1 MB worker frame, so the reference is what travels
    // — the same fallback the Host renderer uses for a URL-only image.
    const attachment = record(candidate.attachment)
    return [{ type: 'text', text: typeof attachment.attachmentId === 'string'
      ? `Generated image attachment: ${attachment.attachmentId}`
      : 'Generated image (unavailable to this transport)' }]
  }
  try {
    return [{ type: 'text', text: JSON.stringify(block) }]
  } catch {
    return [{ type: 'text', text: String(block) }]
  }
}
