/**
 * `shell` and `bash`: the shell tool's other names, bridged to the one this host registers.
 *
 * Why
 * ---
 * Measured on one real desktop session (2026-09-25, `deepseek-v4.1` over two catalog
 * routes): 30 tool calls named `shell`, every one answered `unknown tool "shell"`,
 * while the same turn ran 41 `pwsh` calls successfully. Those calls carried
 * `{cmd, description, workdir}` — the spelling of the `shell` tool the model's own
 * prior knows — and this host's shell tool is `pwsh`, whose schema says `command`.
 * Nothing in the tool list answered to `shell`, so each of those calls cost a round
 * trip and taught the model nothing about what to do instead.
 *
 * The host already reads both spellings as the shell tool *everywhere else*:
 * `tool-guards.ts` (`SHELL_TOOL_NAMES`), `plan-mode.ts`, `headroom/runtime.ts` and
 * `cache-cold.ts` all treat a `shell` call as a command — risk tiers, command policy,
 * Plan Mode, cache-cold accounting — and `verify-on-stop.ts` files one as a turn that
 * can have changed the workspace. Dispatch was the one reader that disagreed, and a
 * policy that judges a call the registry cannot run never fires.
 *
 * `bash` is the same fact on the other side of another gate: OpenCode's free tier
 * requires `bash` in the request body (`managed-catalog-utils.ts`), a Windows request
 * has no `bash` to declare, and the adapter therefore appends a synthetic definition
 * that nothing can dispatch. Registering the name is what lets that gate be satisfied
 * by a tool that runs.
 *
 * How
 * ---
 * An alias is registered only when this composition has a shell tool and does not
 * already answer to that name. Its body dispatches the delegate through
 * `ctx.tools.execute()` — the entry point the agent loop uses — so the command is
 * judged by the pipeline the shell tool itself goes through: guards, command policy,
 * the project's own `permissionRules`, Plan Mode, the sandbox, approvals, Auto review.
 * Calling the delegate's `execute` directly would be a policy bypass wearing a
 * compatibility shim's clothes.
 *
 * The command is the one thing translated: `cmd` or `command`, whichever the caller
 * used, reaches the delegate as `command`, the field its schema declares. Every other
 * argument is forwarded exactly as it arrived, so a parameter this module has never
 * heard of — the sandbox escalation pair, a future shell parameter — is still judged
 * by the delegate's own schema rather than dropped here.
 *
 * What the hop does not preserve
 * ------------------------------
 * The name-keyed readers that pull a shell call's command text out of its arguments
 * (`bashCommandOf`, Plan Mode's `commandOf`) read the `command` field, so on the
 * *outer* alias call they find no command to judge; the nested dispatch is what they
 * judge, with the same command under the delegate's own name in any refusal. No policy
 * is skipped by that hop — every one of them runs again on the nested call — but a
 * refusal arrives naming the delegate.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/shell-alias
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolDefinition, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

import { SHELL_TOOL_NAMES } from './tool-guards.ts'
import { toolDefinition } from './tool-definition.ts'

/**
 * The registry slice the aliases need: register themselves, find the delegate, and
 * dispatch nested calls through policy.
 *
 * Declared structurally, like `edit-and-run.ts` declares its own, so the module stays
 * testable without a live registry.
 */
export interface ShellAliasRegistry {
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

/** What an alias forwards from the registry to its own body. */
interface ShellAliasExec {
  readonly callId: string
  readonly rootCallId: string
  readonly token: ToolExecutionToken
  readonly signal: AbortSignal
  readonly agent?: Agent
  deferContext?(context: unknown): void
}

/** The envelope the registry wraps a thrown failure's message in. */
const ERROR_ENVELOPE = 'Error: '

/**
 * The registered shell tool this composition actually has, if any.
 *
 * Read off `SHELL_TOOL_NAMES` rather than a list of its own: that set is already the
 * answer to "which names mean this host's shell tool", and a second copy of it is how
 * one reader ends up enforcing a vocabulary another reader has moved past. Order is the
 * set's own — `bash` before `pwsh` — so a host that registers both keeps the delegate
 * its own tool list offered first.
 *
 * @param registry - the tool registry to look the names up in.
 * @returns the delegate's name, or `undefined` when no shell tool is registered.
 */
export function resolveShellToolName(registry: ShellAliasRegistry): string | undefined {
  for (const name of SHELL_TOOL_NAMES) if (registry.get(name) !== undefined) return name
  return undefined
}

/** The command string one alias call carries, under either spelling. */
function commandOf(view: Readonly<Record<string, unknown>>): string | undefined {
  for (const field of ['cmd', 'command']) {
    const value = view[field]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * The delegate's arguments for one alias call.
 *
 * The command is renamed to the field the delegate declares and `timeout_ms` — the
 * spelling the same callers use for the same idea — is renamed with it. Everything else
 * is forwarded verbatim, so the delegate's schema, not this module, decides what a
 * parameter means.
 *
 * @param args - the model's arguments, of unknown shape.
 * @returns arguments for the delegate's own schema.
 * @throws Error when the call names no command at all, before anything is dispatched.
 */
export function shellAliasArguments(args: unknown): Readonly<Record<string, unknown>> {
  const view = (args ?? {}) as Readonly<Record<string, unknown>>
  const command = commandOf(view)
  if (command === undefined) {
    throw new Error('invalid command: expected the command to run as `cmd` (or `command`)')
  }
  const forwarded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(view)) {
    // Both spellings of the command become the one field the delegate declares, and
    // `timeout_ms` becomes the delegate's own name for it. Nothing else is touched.
    if (key === 'cmd' || key === 'command') continue
    forwarded[key === 'timeout_ms' ? 'timeoutMs' : key] = value
  }
  return { command, ...forwarded }
}

/**
 * The delegate's failure, as this call's failure.
 *
 * The delegate's error content is already model-facing text with the envelope on it, so
 * the envelope is removed before this layer adds its own — otherwise the model reads
 * `Error: Error: …`. A failure that carried no text gets a sentence that says so rather
 * than an empty error.
 *
 * @param result - the nested call's outcome.
 * @returns the message to fail this call with.
 */
export function shellAliasFailure(result: ToolExecutionResult): string {
  const parts: string[] = []
  for (const block of result.content) if (block.type === 'text') parts.push(block.text)
  const text = parts.join('\n').trim()
  const message = text.startsWith(ERROR_ENVELOPE) ? text.slice(ERROR_ENVELOPE.length) : text
  return message === '' ? 'the host shell tool refused this command' : message
}

/**
 * How one alias call is shown while it runs.
 *
 * A `terminal` view, because that is what the call is: a command string and a working
 * directory. A UI that cannot draw one falls back to a generic card whose body is the
 * fenced output. The view is derived from the arguments alone — a UI may call it during
 * live streaming *and* on a replayed session log — so nothing here reads state.
 *
 * @param args - the model's arguments, of unknown shape.
 * @returns the pending presentation for this call.
 */
export function shellAliasCallView(args: unknown): ToolCallView {
  const view = (args ?? {}) as Readonly<Record<string, unknown>>
  const command = commandOf(view)
  // A call with no readable command cannot be titled by one, and the terminal card has
  // no other title slot; the generic card is the honest fallback for it.
  if (command === undefined) return { card: 'generic', title: 'Run shell command', kind: 'execute' }
  const description = view.description
  const workdir = view.workdir
  return {
    card: 'terminal',
    title: command,
    ...(typeof description === 'string' && description !== '' ? { description } : {}),
    ...(typeof workdir === 'string' && workdir !== '' ? { cwd: workdir } : {}),
  }
}

/** The `output` declaration both aliases share: the delegate's content, forwarded. */
const FORWARDED_OUTPUT = {
  schema: { type: 'object' as const, additionalProperties: true },
  render: (_args: unknown, value: unknown): ContentBlock[] => {
    const content = (value as { readonly content?: unknown } | null)?.content
    return Array.isArray(content) ? content as ContentBlock[] : []
  },
}

/** The body both aliases share: dispatch the delegate, then forward its answer. */
async function dispatchAlias(
  registry: ShellAliasRegistry,
  delegate: string,
  suffix: string,
  args: unknown,
  exec: unknown,
): Promise<unknown> {
  const scoped = exec as ShellAliasExec
  const result = await registry.execute({
    callId: `${scoped.callId}:${suffix}` as ToolCallId,
    rootCallId: scoped.rootCallId as ToolCallId,
    name: delegate,
    arguments: shellAliasArguments(args),
    // The registry's documented way to identify a sub-dispatch: the tree stays one root
    // model-requested call, and policy that walks the tree can see the nesting.
    parent: scoped.token,
    signal: scoped.signal,
    ...(scoped.agent === undefined ? {} : { agent: scoped.agent }),
  })
  // Forward whatever context a nested policy attached, so the alias does not silently
  // swallow an instruction the model was supposed to receive.
  for (const context of result.additionalContexts ?? []) scoped.deferContext?.(context)
  if (result.isError) throw new Error(shellAliasFailure(result))
  // The delegate's own blocks, verbatim: a paraphrase of a command's output is exactly
  // where the line that explains a failure goes missing.
  return { content: result.content }
}

/**
 * Register the shell tool's other names, delegating to the one this host has.
 *
 * A name is skipped when the host already registers it: a real `bash` (every POSIX
 * composition) is a better answer than a shim, and a second registration of one name is
 * not a registration at all.
 *
 * @param deps - the plugin context and the tool registry.
 * @returns the disposers that unregister what this call registered, in registration order.
 */
export function registerShellAliasTools(deps: {
  readonly ctx: Context
  readonly registry: ShellAliasRegistry
}): readonly (() => void)[] {
  const { ctx, registry } = deps
  const delegate = resolveShellToolName(registry)
  if (delegate === undefined) {
    ctx.logger.debug?.(`freecodego: no shell alias was registered because this composition has none of ${[...SHELL_TOOL_NAMES].join('/')}`)
    return []
  }
  const registered: (() => void)[] = []
  // Both names are registration *literals* rather than entries in a loop over a list:
  // the manifest's sweep reads this package's source for exactly this shape, and a name
  // assembled at runtime would be a registration no reader — and no gate — can find.
  /* jscpd:ignore-start -- one registration per name, deliberately spelled out so the
     manifest sweep can see both; the two differ only in name and parameter spelling. */
  if (registry.get('shell') === undefined) {
    registered.push(registry.register(toolDefinition({
      name: 'shell',
      description: `Run a shell command. This is the same tool as \`${delegate}\` — same sandbox, same policy, same result — registered under the name a \`shell\` tool is normally called: pass the command as \`cmd\` (\`command\` is accepted too).`,
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The command to execute.' },
          command: { type: 'string', description: 'The command to execute, under the host shell tool\u2019s own field name. Accepted in place of `cmd`.' },
          description: { type: 'string', description: 'Clear, concise description of what this command does in active voice (shown in the UI).' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap.' },
          timeout_ms: { type: 'number', description: 'The same timeout, under the snake_case spelling some callers use.' },
          workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace.' },
          run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately.' },
        },
        required: ['cmd'],
      },
      output: FORWARDED_OUTPUT,
      execute: (args: unknown, exec: unknown) => dispatchAlias(registry, delegate, 'shell', args, exec),
      presentCall: (args: unknown): ToolCallView => shellAliasCallView(args),
    })))
  }
  if (registry.get('bash') === undefined) {
    registered.push(registry.register(toolDefinition({
      name: 'bash',
      description: `Run a shell command. This is the same tool as \`${delegate}\` — same sandbox, same policy, same result — registered under the name a \`bash\` tool is normally called: pass the command as \`command\` (\`cmd\` is accepted too).`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute.' },
          cmd: { type: 'string', description: 'The command to execute, under the short spelling some callers use. Accepted in place of `command`.' },
          description: { type: 'string', description: 'Clear, concise description of what this command does in active voice (shown in the UI).' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap.' },
          timeout_ms: { type: 'number', description: 'The same timeout, under the snake_case spelling some callers use.' },
          workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace.' },
          run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately.' },
        },
        required: ['command'],
      },
      output: FORWARDED_OUTPUT,
      execute: (args: unknown, exec: unknown) => dispatchAlias(registry, delegate, 'bash', args, exec),
      presentCall: (args: unknown): ToolCallView => shellAliasCallView(args),
    })))
  }
  /* jscpd:ignore-end */
  if (registered.length === 0) {
    ctx.logger.debug?.(`freecodego: no shell alias was registered because this composition already answers to ${delegate}`)
  }
  return registered
}
