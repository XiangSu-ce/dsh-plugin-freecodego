/**
 * `edit_and_run` — change a file and run the check that proves the change, in one call.
 *
 * Why
 * ---
 * The repair loop is `edit` → read the result → `bash` → read the result: two tool
 * calls and two round trips for one logical step, and a task that edits and
 * re-checks ten times pays twenty. This tool makes the second call a parameter of
 * the first.
 *
 * Why it delegates instead of editing itself
 * ------------------------------------------
 * The composition already has an `edit` tool and a `bash` tool, and both are
 * wrapped in policy the model depends on: the filesystem sandbox, per-call
 * escalation modes, the fs-observation policy that requires a read before an edit,
 * and the shell sandbox. Re-implementing either here would bypass all of it, and
 * would also mean re-deriving literal-match editing semantics that already exist.
 *
 * So this tool owns no file and no process. It dispatches nested calls through
 * `ctx.tools.execute()` — the same entry point the agent loop uses — which runs the
 * full pipeline (materialize, guards, pre-execute, dispatch, post-execute). The
 * nested dispatch passes the outer execution's `token` as `parent`, which is the
 * registry's documented way to identify a sub-dispatch, and propagates `rootCallId`
 * so the whole tree is still one root model-requested call.
 *
 * What is deliberately NOT copied
 * -------------------------------
 * SoL-Pi's Action Fusion re-hashes the file before running the command and skips if
 * it changed underneath. The builtin `edit` refuses when `old_string` no longer
 * matches, so that race is already the edit's own failure — there is nothing left
 * for a second hash to catch, and a hash taken here would only be checking a file
 * this process just wrote. The rule that does survive is the important one: **if the
 * edit did not land, the command does not run.** A check against an unchanged file
 * reports on the previous state of the world, and a model that reads its failure
 * concludes something false about a change that never happened.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/edit-and-run
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolDefinition, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

import { toolDefinition } from './tool-definition.ts'

/** Registered name of the composite tool. */
export const EDIT_AND_RUN_TOOL_NAME = 'edit_and_run'

/**
 * Marker that the verification command was skipped.
 *
 * Named after the same token in SoL-Pi's Action Fusion, because the meaning is the
 * same and a shared name is worth more than a nicer one.
 */
export const THEN_RUN_SKIPPED = '[then_run:skipped]'

/**
 * Prompt-section order for this tool's guidance.
 *
 * A literal rather than `getSectionOrder(...)`: the order table is a closed set of
 * names, and this composite belongs immediately after the builtin `edit` guidance
 * (1300) rather than to a name of its own.
 */
const GUIDANCE_SECTION_ORDER = 1301

/** The edit tool this delegates to, tried in order. */
const EDIT_TOOL_CANDIDATES: readonly string[] = ['edit']

/** The shell tool this delegates to, tried in order — Windows compositions may ship `pwsh` only. */
const SHELL_TOOL_CANDIDATES: readonly string[] = ['bash', 'pwsh']

/**
 * The registry slice the composite needs: register its own tool, look up the tools
 * it delegates to, and dispatch nested calls through policy.
 *
 * Declared structurally so the module stays testable without a live registry.
 */
export interface EditAndRunRegistry {
  register(definition: ToolDefinition): () => void
  get(name: string): unknown
  execute(input: {
    readonly callId: ToolCallId
    readonly rootCallId: ToolCallId
    readonly name: string
    readonly arguments: unknown
    readonly parent: ToolExecutionToken
    readonly signal: AbortSignal
    readonly agent?: Agent
  }): Promise<ToolExecutionResult>
}

/** The model-facing outcome of the composite, phase by phase. */
export interface EditAndRunPhase {
  readonly name: string
  readonly isError: boolean
  readonly content: readonly ContentBlock[]
}

/** How the verification command ended. */
export type EditAndRunCheck = 'passed' | 'failed' | 'not-run'

/** The composite's canonical value: both phases, in order, with their own content intact. */
export interface EditAndRunValue {
  /** One-line status the model reads first. */
  readonly status: string
  readonly command: string
  readonly edited: boolean
  readonly check: EditAndRunCheck
  /** The edited path, when the edit reported one. */
  readonly path?: string
  readonly phases: readonly EditAndRunPhase[]
}

/** Arguments the composite accepts, exactly as the model sends them. */
export interface EditAndRunArgs {
  readonly file_path: string
  readonly old_string: string
  readonly new_string: string
  readonly replace_all?: boolean
  readonly command: string
  readonly timeout_ms?: number
}

/**
 * Validate one call's arguments before anything is dispatched.
 *
 * Failing here is the cheapest possible outcome: no file is touched and no process
 * starts. `new_string` is the one field allowed to be empty, because an empty
 * replacement is how a deletion is expressed.
 *
 * @param args - the model's arguments.
 * @returns the validated, narrowed arguments.
 * @throws when a required field is missing, empty, or the wrong type.
 */
export function parseEditAndRunArgs(args: unknown): EditAndRunArgs {
  const view = (args ?? {}) as Readonly<Record<string, unknown>>
  const requireText = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`invalid ${field}: expected a non-empty string`)
    return value
  }
  if (typeof view.new_string !== 'string') throw new Error('invalid new_string: expected a string (use an empty string to delete the match)')
  if (view.replace_all !== undefined && typeof view.replace_all !== 'boolean') throw new Error('invalid replace_all: expected a boolean')
  const timeoutMs = view.timeout_ms
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`invalid timeout_ms: expected a positive number, got ${JSON.stringify(timeoutMs)}`)
  }
  return {
    file_path: requireText(view.file_path, 'file_path'),
    old_string: requireText(view.old_string, 'old_string'),
    new_string: view.new_string,
    command: requireText(view.command, 'command'),
    ...(view.replace_all === undefined ? {} : { replace_all: view.replace_all }),
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
  }
}

/**
 * The nested `edit` call for these arguments.
 * @param args - validated composite arguments.
 * @returns arguments for the builtin edit tool's own schema.
 */
export function editCallArguments(args: EditAndRunArgs): Readonly<Record<string, unknown>> {
  return {
    file_path: args.file_path,
    old_string: args.old_string,
    new_string: args.new_string,
    ...(args.replace_all === undefined ? {} : { replace_all: args.replace_all }),
  }
}

/**
 * The nested shell call that verifies the edit.
 * @param args - validated composite arguments.
 * @returns arguments for the builtin shell tool's own schema.
 */
export function verifyCallArguments(args: EditAndRunArgs): Readonly<Record<string, unknown>> {
  return { command: args.command, ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }) }
}

/**
 * Whether the verification command may run.
 *
 * The whole rule, in one place: **the command runs only if the edit landed.** When
 * the edit failed, running a check would report on a file that did not change, and
 * its failure would be read as evidence about a change that never happened — the
 * exact confusion this tool exists to remove.
 *
 * @param edit - the settled nested edit result.
 * @returns `run: true`, or `run: false` with the note to show instead.
 */
export function verificationDecision(edit: ToolExecutionResult): { readonly run: true } | { readonly run: false; readonly note: string } {
  if (!edit.isError) return { run: true }
  return {
    run: false,
    note: `${THEN_RUN_SKIPPED} the edit did not land, so the verification command was not run: a check against an unchanged file says nothing about this change`,
  }
}

/** The edited path, when the edit's canonical value reported one. */
function editedPath(edit: ToolExecutionResult): string | undefined {
  if (edit.isError) return undefined
  const value = edit.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const path = (value as { readonly path?: unknown }).path
  return typeof path === 'string' && path !== '' ? path : undefined
}

/**
 * Build the composite's canonical value.
 *
 * Both phases are carried with their own content **verbatim**, never summarized.
 * The edit's message is the record of what changed and the command's output is the
 * only honest description of what it did; a paraphrase of a failing command is
 * exactly where the line that explains the failure goes missing.
 *
 * The value is returned even when the check failed or the edit did not land. A
 * failed check is not a malfunction of this tool — the tool did its job and is
 * reporting faithfully — and conflating the two would make the agent loop's error
 * accounting, retries included, treat a red test as a broken tool. The status line
 * carries the signal instead, and it is the first thing the model reads.
 *
 * @param input - the settled edit result, the command text, and the verify result when one ran.
 * @returns the canonical value describing both phases.
 */
export function composeEditAndRun(input: {
  readonly edit: ToolExecutionResult
  readonly command: string
  readonly verify: ToolExecutionResult | undefined
}): EditAndRunValue {
  const edited = !input.edit.isError
  const path = editedPath(input.edit)
  // `verify === undefined` and "the edit failed" are the same case: the orchestrator
  // asks `verificationDecision` first and only dispatches when it says to run.
  const check: EditAndRunCheck = input.verify === undefined ? 'not-run' : input.verify.isError ? 'failed' : 'passed'
  const where = path === undefined ? '' : ` ${path}`
  const status = check === 'not-run'
    ? `${THEN_RUN_SKIPPED} the edit did not land${where}, so the verification command was not run: ${input.command}`
    : `edit applied${where}; then ran: ${input.command} — check ${check === 'passed' ? 'passed' : 'FAILED'}`

  const phases: EditAndRunPhase[] = [{ name: 'edit', isError: input.edit.isError, content: input.edit.content }]
  if (input.verify !== undefined) phases.push({ name: 'verify', isError: input.verify.isError, content: input.verify.content })

  return { status, command: input.command, edited, check, ...(path === undefined ? {} : { path }), phases }
}

/**
 * Project the canonical value to model-facing content: the status line, then each
 * phase's own blocks in order.
 *
 * Pure and total so it can be the tool's `output.render` — a render that threw
 * would lose the very output the model needs.
 *
 * @param value - the composite's canonical value.
 * @returns the content blocks the model sees.
 */
export function renderEditAndRunValue(value: unknown): ContentBlock[] {
  if (value === null || typeof value !== 'object') return [{ type: 'text', text: String(value) }]
  const view = value as { readonly status?: unknown; readonly phases?: unknown }
  const content: ContentBlock[] = [{ type: 'text', text: typeof view.status === 'string' ? view.status : '' }]
  if (Array.isArray(view.phases)) {
    for (const phase of view.phases as readonly { readonly content?: unknown }[]) {
      if (!Array.isArray(phase?.content)) continue
      for (const block of phase.content as readonly ContentBlock[]) content.push(block)
    }
  }
  return content
}

/** What the composite forwards from the registry to its own body. */
interface EditAndRunExec {
  readonly callId: string
  readonly rootCallId: string
  readonly token: ToolExecutionToken
  readonly signal: AbortSignal
  readonly agent?: Agent
  deferContext?(context: UserMessage): void
}

/** The first candidate name the registry actually has registered. */
function pickRegistered(registry: EditAndRunRegistry, candidates: readonly string[]): string | undefined {
  for (const name of candidates) if (registry.get(name) !== undefined) return name
  return undefined
}

/**
 * Register `edit_and_run`, when this composition has the tools it delegates to.
 *
 * The tool is not registered at all when either delegate is missing: a registered
 * tool that always fails is worse than an absent one, because the model will keep
 * choosing it.
 *
 * @param deps - the plugin context and the tool registry.
 * @returns the exact disposer that unregisters the tool, or `undefined` when it was not registered.
 */
export function registerEditAndRunTool(deps: { readonly ctx: Context; readonly registry: EditAndRunRegistry }): (() => void) | undefined {
  const { ctx, registry } = deps
  const editToolName = pickRegistered(registry, EDIT_TOOL_CANDIDATES)
  const shellToolName = pickRegistered(registry, SHELL_TOOL_CANDIDATES)
  if (editToolName === undefined || shellToolName === undefined) {
    ctx.logger.debug?.(`freecodego: ${EDIT_AND_RUN_TOOL_NAME} was not registered because this composition has no ${editToolName === undefined ? `"${EDIT_TOOL_CANDIDATES[0]}"` : `shell tool (${SHELL_TOOL_CANDIDATES.join('/')})`} to delegate to`)
    return undefined
  }

  /** Dispatch one nested call as a sub-dispatch of this execution. */
  const nested = (exec: EditAndRunExec, name: string, suffix: string, args: Readonly<Record<string, unknown>>): Promise<ToolExecutionResult> =>
    registry.execute({
      callId: `${exec.callId}:${suffix}` as ToolCallId,
      rootCallId: exec.rootCallId as ToolCallId,
      name,
      arguments: args,
      parent: exec.token,
      signal: exec.signal,
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    })

  const dispose = registry.register(toolDefinition({
    name: EDIT_AND_RUN_TOOL_NAME,
    description: 'Edit a file and immediately run a command that checks the edit, as one call. Use this instead of calling edit and then ' + shellToolName + ' separately when the command exists to verify the change — a test, a typecheck, a lint, a build — because the two calls are one step of work and the command must not run if the edit did not land.',
    // A JSON Schema object, wrapped the way every other tool in this plugin
    // wraps one. This literal used to be the bare field map — `{ file_path: …,
    // command: … }` with no `type`, no `properties`, and `required: true` inside
    // each field — which is not a schema: `required` is a sibling array, not a
    // per-property flag, so the model was handed six parameters with **none of
    // them marked required**, and an `input_schema` with no `type` at all. An
    // `as unknown as ToolDefinition` cast is what let it through: it silenced
    // the one helper (`toolDefinition`) that checks this surface. The literal is
    // now passed through that helper, so a regression fails the build instead of
    // reaching the model.
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: 'Path to edit, resolved by the filesystem backend.' },
        old_string: { type: 'string', description: 'Literal text to replace. Must match exactly, as the edit tool requires.' },
        new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
        replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
        command: { type: 'string', description: 'The command that verifies the edit. It runs only if the edit landed.' },
        timeout_ms: { type: 'integer', minimum: 1, description: 'Timeout for the verification command in milliseconds.' },
      },
      required: ['file_path', 'old_string', 'new_string', 'command'],
    },
    output: {
      schema: { type: 'object' as const, additionalProperties: true },
      render: (_args: unknown, value: unknown) => renderEditAndRunValue(value),
    },
    execute: async (args: unknown, exec: unknown): Promise<unknown> => {
      const parsed = parseEditAndRunArgs(args)
      const scoped = exec as EditAndRunExec
      const edit = await nested(scoped, editToolName, 'edit', editCallArguments(parsed))
      // Forward whatever context a nested policy attached, so a composite does not
      // silently swallow an instruction the model was supposed to receive.
      for (const context of edit.additionalContexts ?? []) scoped.deferContext?.(context)
      const decision = verificationDecision(edit)
      const verify = decision.run ? await nested(scoped, shellToolName, 'verify', verifyCallArguments(parsed)) : undefined
      for (const context of verify?.additionalContexts ?? []) scoped.deferContext?.(context)
      return composeEditAndRun({ edit, command: parsed.command, verify })
    },
    // Annotated because the shape helper infers from the literal, and without a
    // contextual type the `card` tag widens to `string` — which is not one of the
    // three view variants the registry accepts. The cast this replaced hid that.
    presentCall: (): ToolCallView => ({ card: 'generic', title: 'Edit and verify' }),
  }))
  // The builtin edit tool also ships prompt guidance; without a line of our own the
  // model has no reason to prefer this composite over the two calls it knows.
  ctx.systemPrompt.section({
    name: `tool:${EDIT_AND_RUN_TOOL_NAME}`,
    order: GUIDANCE_SECTION_ORDER,
    text: `Use ${EDIT_AND_RUN_TOOL_NAME} when a change and the check that proves it are one step: give the edit and the verification command together. The command runs only if the edit landed, and both results come back in one call.`,
  })
  return dispose
}
