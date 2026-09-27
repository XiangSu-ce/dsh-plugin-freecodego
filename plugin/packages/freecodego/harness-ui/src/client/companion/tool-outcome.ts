/**
 * Whether one tool result says the call failed.
 *
 * Why this is a module of its own
 * -------------------------------
 * The companion's second face vocabulary is fed by the session: a tool that came back a
 * failure is the instant inside a running turn where "still working" and "this is not
 * cooperating" are different pictures, so `activity.ts` has to answer one question about
 * every `tool/result` it sees — did that work? The answer turned out to have two shapes,
 * and getting it wrong is invisible (the character simply never winces), which is exactly
 * the kind of reading that deserves its own file and its own spec rather than a condition
 * buried in a switch.
 *
 * The two shapes
 * --------------
 * 1. **`isError` on the message.** The core sets it when the *tool* did not complete: a
 *    file that was not there, a permission that was refused, a tool that threw. Measured
 *    on a live session: `{"content":[{"type":"text","text":"Error: cannot read …"}],
 *    "isError":true}` beside `data.error = {name: "FsError", code: "FS_NOT_FOUND"}`.
 * 2. **A nonzero exit in the rendered text.** A shell tool *does* complete when the
 *    command it ran exits nonzero — the tool answered, the command failed — and the
 *    harness renders that as a trailing `[exit code: N]` rather than as `isError`.
 *    Measured on the same session, for the command `fcg-not-a-real-binary --x`:
 *    `{"content":[{"type":"text","text":"[stderr]\n…\n[exit code: 1]"}],"isError":false}`.
 *
 * Reading only the first shape is not a smaller version of this: it misses every failing
 * command a shell tool runs, which is the majority of what "a tool failed" means in
 * practice. That was the state of this feature before the live run, and it is why the
 * second shape is here rather than left to a later pass.
 *
 * The exit marker is not this module's invention and not this module's convention: it is
 * the harness's own rendering, read with the same pattern and the same "last marker wins"
 * rule the plugin applies to the same text in `freecodego/harness-plugin/src/
 * shell-loader-failure.ts` (`reportedExitCode`). The two readers live in packages that
 * cannot share a running value, so the tie is a test:
 * `tests/companion-tool-outcome.client.spec.ts` holds this reader against the plugin's and
 * fails if either drifts. Nothing here re-parses a command's output to guess: an exit code
 * of 0 is not a failure, and a result with no marker is not one either.
 * @module client/companion/tool-outcome
 */

/**
 * The shell's exit marker, as the harness renders it.
 *
 * The same pattern the plugin reads with, on purpose — see the module note. Its capture is
 * `-?\d+` by construction, so only codes a renderer produced can be read out of it.
 */
const EXIT_MARKER = /\[exit code: (-?\d+)\]/gu

/**
 * The text of one result's content blocks, as this module reads them.
 *
 * Non-text blocks are named rather than dropped, which is the plugin's own reader's rule
 * and it applies here for the same reason: a marker that happens to appear inside an image,
 * a file, or any other block's caption is not a shell reporting its exit code, and naming
 * the block keeps it from being read as one.
 * @param content - the result's content, as the event window supplies it.
 * @returns the text to search, joined the way the renderer separates blocks.
 */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const typed = block as { readonly type?: unknown; readonly text?: unknown }
      if (typed.type !== 'text') return `[${String(typed.type)}]`
      // A text block whose `text` is not a string is not text a renderer wrote, so it
      // contributes nothing: stringifying it would put `[object Object]` where the shell's
      // own output goes, and the only thing that can come of that is a marker invented
      // out of a block nobody rendered.
      return typeof typed.text === 'string' ? typed.text : ''
    })
    .join('\n')
}

/**
 * The exit code one result's text reports, when it reports one.
 *
 * The *last* marker wins, because a rendered result can hold several — a script that runs
 * two commands renders two — and the one that describes the call is its final command's.
 * @param text - the result's text.
 * @returns the reported code, or `undefined` when the text reports none.
 */
function reportedExitCode(text: string): number | undefined {
  let last: number | undefined
  // `matchAll` copies the pattern but carries `lastIndex` over, so the reset is what keeps
  // two calls over the same text reading the same markers.
  EXIT_MARKER.lastIndex = 0
  for (const match of text.matchAll(EXIT_MARKER)) last = Number(match[1])
  return last
}

/**
 * Whether a tool result message says the call it answers failed.
 *
 * Every unreadable input is `false` rather than a throw, and the reason is where this runs:
 * inside the feed's own subscriber, where an exception is caught and logged but takes the
 * published reading with it — so a payload nobody expected would stop the character
 * updating at all rather than merely leave one face unworn.
 * @param message - the `message` of a `tool/result` event, as the window supplies it.
 * @returns whether that call failed, by either of the two shapes the session uses.
 */
export function toolResultFailed(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const result = message as { readonly isError?: unknown; readonly content?: unknown }
  if (result.isError === true) return true
  const exitCode = reportedExitCode(resultText(result.content))
  return exitCode !== undefined && exitCode !== 0
}
