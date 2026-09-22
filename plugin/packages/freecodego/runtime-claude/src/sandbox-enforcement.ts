/**
 * What a session's Harness sandbox mode means for the Claude Agent SDK's own
 * built-in tools.
 *
 * The gap this closes
 * -------------------
 * The Harness sandbox confines the *Harness* tools. When the model runs on
 * Claude it also has the SDK's own `Write`/`Edit`/`Bash`, which no Harness
 * policy reaches — so a session the user put in `read-only` could still write
 * files through them, and the plugin reported a mode the engine ignored.
 * Codex has a sandbox switch for this; the SDK has none, so the enforcement has
 * to happen at the one choke point that sees every built-in call:
 * `canUseTool`.
 *
 * Why not `permissionMode`
 * ------------------------
 * The SDK's two non-default modes are both wrong here, and for opposite
 * reasons: `plan` is documented as "no execution of tools", which would refuse
 * reads as well — it is the *council reviewer* floor, deliberately built for a
 * child that only plans, and applying it to a user session would remove
 * capability the mode never asked to remove. `dontAsk` denies anything not
 * pre-approved, and this runtime passes `settingSources: []`, so there is no
 * pre-approval list to be on: it would deny reads too. Neither expresses "read
 * the filesystem, do not change it", which is what the Harness mode means.
 *
 * Why a deny list and not an allow list
 * -------------------------------------
 * The council floors a child with an allow list because a child may only have
 * the tools the review needs. A user session is the opposite: it should keep
 * everything the mode does not take away. A deny list of names whose effect is
 * a file write or an unconfined process removes exactly that and leaves every
 * read, plan, web, and harness tool on its existing path (the approval seam).
 *
 * `Bash` is on the list because the SDK cannot confine a subprocess: any command
 * may write, so a read-only session that permits Bash is read-only in name
 * only. The model is not left without a shell — the Harness `bash` tool is
 * mounted by the base composition and *is* confined — and the denial message
 * says so.
 *
 * Residual risks, stated rather than implied
 * ------------------------------------------
 * - `Task` (a subagent) is not denied: the SDK documents `canUseTool` as "called
 *   before each tool execution", so a subagent's `Write` is judged by this same
 *   rule. Were a future SDK to run subagents outside this callback, the Task
 *   path would be a hole. That is no wider than today for that path (nothing
 *   was denied before), and it is recorded here because only a read-only session
 *   that writes would reveal it.
 * - A tool this module does not recognize — a differently named built-in, or
 *   another MCP server's tool — keeps its existing approval path rather than
 *   being denied on a guess.
 *
 * @module @deepseek-ai/dsh-freecodego-runtime-claude/sandbox-enforcement
 */

import { effectiveSandboxMode, type NativeSessionSandboxFields } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'

/**
 * Claude Agent SDK built-in tools that can change the filesystem or run an
 * unconfined process. Names are the SDK's own; a rename in the SDK makes a tool
 * unrecognized here, which falls back to the approval path — the behaviour that
 * exists today — rather than failing open silently.
 */
const MUTATION_TOOLS: readonly string[] = ['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']

/**
 * The refusal message for one built-in call, or `undefined` when the call may
 * proceed to the ordinary permission flow.
 *
 * @param fields - The `readOnly` floor and resolved `sandboxMode` for this session.
 * @param toolName - The SDK tool name `canUseTool` was called with.
 * @returns the refusal text when a mutation tool meets a read-only floor, or `undefined` to continue to the ordinary permission flow.
 */
export function claudeSandboxDenial(fields: NativeSessionSandboxFields, toolName: string): string | undefined {
  if (effectiveSandboxMode(fields) !== 'read-only') return undefined
  if (!MUTATION_TOOLS.includes(toolName)) return undefined
  return `This session's sandbox mode is read-only, so ${toolName} is not available: it can write files without the Harness sandbox in the way. `
    + 'Use the Harness read tools (read, glob, grep) or the Harness bash tool, which the sandbox confines to read-only. '
    + "Change the session's sandbox mode in the app when this work genuinely needs to write."
}
