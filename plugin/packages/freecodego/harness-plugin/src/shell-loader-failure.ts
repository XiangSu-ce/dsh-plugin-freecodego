/**
 * Windows shell loader-failure diagnosis.
 *
 * What this answers
 * -----------------
 * The desktop composition's shell failures arrive looking like this:
 *
 *     (no output)
 *     [exit code: 3221225794]
 *
 * `3221225794` is `0xC0000142`, `STATUS_DLL_INIT_FAILED` — an NTSTATUS, not a
 * command result. Windows failed the process *start* while the loader was
 * initializing it, so the command never ran and the empty output is not an
 * answer to anything. Reported bare, that signature reads as a defect in this
 * repository: it names no file, no argument and no output, and the one thing it
 * looks like — "the shell exited nonzero" — is the one thing it is not.
 *
 * Why the confined shell is the one that dies
 * -------------------------------------------
 * The Windows sandbox creates the shell under a `WRITE_RESTRICTED` token with a
 * Low integrity label. A third-party product that injects a hook DLL into new
 * processes (360 安全卫士's 主动防御 / `360Box64.sys` is the one seen on the
 * desktop host this was written for; the same shape ships in other AV/EDR
 * suites) is then the party that fails: the injected DLL cannot initialize
 * inside that token, and a failing `DllMain` fails the whole process start.
 * Nothing in this repository can prevent that — the injector is outside the
 * process — so the honest answer is to name the cause, keep the truth the model
 * already has, and leave the command re-runnable instead of silently reporting
 * an exit code that never happened.
 *
 * The evidence, so the claim is checkable rather than asserted: on the host
 * where this appeared, that same binary and argv exit 0 with the vendor's
 * user-mode engine stopped, and the same restricted-token child — both sandbox
 * modes, the Store app-execution alias and the real package path alike — exits
 * 0 from a console-less packaged-Electron host as well. What is left in the
 * difference is the host's own injector state, which is why this module treats
 * the signature as a host condition and says so, rather than as a repo input it
 * could validate.
 *
 * Everything exported here is total: it sits between a dispatched result and the
 * transcript, so a throw would fail a tool call that already ran.
 * @module freecodego/harness-plugin/shell-loader-failure
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { SHELL_TOOL_NAMES } from './tool-guards.ts'

/** `0xC0000142` `STATUS_DLL_INIT_FAILED`, as the unsigned NTSTATUS a process reports. */
export const STATUS_DLL_INIT_FAILED = 0xC0000142

/** The shell's exit marker: the harness renders a nonzero exit as a trailing `[exit code: N]`. */
const EXIT_MARKER = /\[exit code: (-?\d+)\]/gu

/**
 * The text blocks of one result, as this module reads them: non-text blocks are
 * named rather than dropped, so a marker in an image's caption cannot be
 * mistaken for one a shell wrote, and the join matches how the renderer
 * separates them.
 * @param content - the result content blocks.
 * @returns their text.
 */
function resultText(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
}

/**
 * The sentinel the appended note starts with, and the guard against appending it
 * twice: a result that already carries it was diagnosed on an earlier pass —
 * post-execute runs over every dispatch, including a replayed or re-rendered
 * one — and a second copy would claim twice what happened once.
 */
export const SHELL_LOADER_FAILURE_PREFIX = '[freecodego] the shell process died during initialization'

/** The remediation text appended after the result the call actually produced. */
const NOTE = `${SHELL_LOADER_FAILURE_PREFIX}, so this command never ran: the empty output below is not its result.
Exit code 3221225794 is 0xC0000142 STATUS_DLL_INIT_FAILED — Windows failed the process start while the loader was initializing the shell, which is a host condition rather than a command failure. The confined shell runs under a write-restricted, Low-integrity token, and the usual cause of a loader failure there is a third-party process-injection product (360 安全卫士's 主动防御 / 360Box64.sys, or another AV/EDR) whose hook DLL cannot initialize inside that token.
What helps, in order: retry (an injector that is starting or stopping fails only some launches); add this application and the shell executable to that product's trust list; or, if the command must run now, re-run the session under a permission preset that does not confine the shell and accept that downgrade. If retrying keeps failing with this code, the cause is on the host, not in the command: no change to the command will help.`

/**
 * The nonzero exit code a rendered shell result reports, when it reports one.
 *
 * Reads the same trailing marker the shell renderer writes, so this cannot fire
 * on text that merely *mentions* the code: a transcript, a document, or the
 * agent quoting this note back. The last marker wins, because a result that
 * carries several belongs to its final command.
 * @param text - the rendered text of a result.
 * @returns the reported exit code, or `undefined` when the text reports none.
 */
export function reportedExitCode(text: string): number | undefined {
  let last: number | undefined
  // `matchAll` copies the pattern and carries its `lastIndex` over, so the reset
  // is what keeps two calls over the same text reading the same markers.
  EXIT_MARKER.lastIndex = 0
  // The pattern is the parser: its capture is `-?\d+` by construction, so the
  // only values read here are codes a shell rendered. Its own guard was dead code
  // (nothing non-numeric can match) and the branch gate found it.
  for (const match of text.matchAll(EXIT_MARKER)) last = Number(match[1])
  return last
}

/**
 * Whether one exit code is the Windows loader failure.
 *
 * Accepts both renderings of the same NTSTATUS: the unsigned form Node reports
 * for a Windows exit code, and the signed 32-bit form a POSIX-shaped reporter
 * (or a hand-written expectation) produces for the same value.
 * @param exitCode - the code to test, in either width.
 * @returns whether it is `STATUS_DLL_INIT_FAILED`.
 */
export function isLoaderFailureExitCode(exitCode: number): boolean {
  return exitCode === STATUS_DLL_INIT_FAILED || (exitCode | 0) === (STATUS_DLL_INIT_FAILED | 0)
}

/**
 * The result content with the loader-failure note appended, when this result is
 * one.
 *
 * Returns `undefined` for every other result, which is the answer the caller
 * needs to leave it untouched: a normal nonzero exit, a shell that ran and
 * reported nothing, a non-shell tool, and a result already carrying the note all
 * stay exactly as they were. The original blocks are preserved in order and the
 * note is appended as its own text block, so nothing the call actually produced
 * is rewritten or hidden — the diagnosis is added to the transcript, not put in
 * place of it.
 * @param toolName - the tool the result belongs to.
 * @param content - the result content blocks, as dispatched.
 * @returns the replacement blocks, or `undefined` when no note applies.
 */
export function withShellLoaderFailureNote(
  toolName: string,
  content: readonly ContentBlock[],
): ContentBlock[] | undefined {
  if (!SHELL_TOOL_NAMES.has(toolName)) return undefined
  const text = resultText(content)
  if (text.includes(SHELL_LOADER_FAILURE_PREFIX)) return undefined
  const exitCode = reportedExitCode(text)
  if (exitCode === undefined || !isLoaderFailureExitCode(exitCode)) return undefined
  return [...content, { type: 'text', text: NOTE }]
}

/**
 * The one post-execute decision shape this module reads and edits.
 *
 * Deliberately structural: the harness declares `PostToolDecision` as a union
 * whose `accept` arm either replaces `content` or `value`, and the module has to
 * tell those two apart without depending on the harness package's type identity
 * — the plugin is composed against a published Host, and a nominal import here
 * would be the one place a version skew becomes a TypeScript error instead of a
 * runtime decision this module already makes anyway.
 */
export interface ShellLoaderFailureDecision {
  /** The decision's arm: only `accept` is editable. */
  readonly kind: string
  /** Content a downstream hook already replaced, when it did. */
  readonly content?: readonly ContentBlock[]
  /** A structured replacement; its presence means the rendered content is not the surface to edit. */
  readonly value?: unknown
}

/** The logger surface the diagnosis reports through; `ctx.logger` satisfies it. */
export interface ShellLoaderFailureLogger {
  warn(message: string): void
}

/**
 * Answer one dispatched result at the `tools/post-execute` seam.
 *
 * Wired from the plugin entry as a single call, on purpose: the seam this sits
 * on is the harness's waterfall, so what it may do is narrow — it reads the
 * decision a later hook returned rather than deciding for it, edits only the
 * `accept`-and-no-`value` arm, and returns everything else untouched, including
 * a `block` (corrective feedback that is already the answer) and a `value`
 * replacement (where the rendered content is not what the caller reads).
 * @param toolName - the tool the result belongs to.
 * @param resultContent - the content as dispatched, used when no hook replaced it.
 * @param decision - the decision the seam's downstream hooks returned.
 * @param logger - where the diagnosis is reported for the host's own log; the
 *   result also carries it, so this is a record rather than the message.
 * @returns the decision, with the diagnosis appended to its content when this
 *   result is a shell loader failure.
 */
export function diagnoseShellLoaderFailure<T extends ShellLoaderFailureDecision>(
  toolName: string,
  resultContent: readonly ContentBlock[],
  decision: T,
  logger: ShellLoaderFailureLogger,
): T {
  if (decision.kind !== 'accept' || 'value' in decision) return decision
  const diagnosed = withShellLoaderFailureNote(toolName, decision.content ?? resultContent)
  if (diagnosed === undefined) return decision
  logger.warn(`freecodego: ${toolName} reports 0xC0000142 (the shell died during process initialization); the result carries the diagnosis`)
  return { ...decision, content: diagnosed } as T
}
