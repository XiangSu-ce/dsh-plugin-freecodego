/**
 * The FreeCodeGo guards, applied to a *native engine's own* tool calls.
 *
 * Why this exists
 * ---------------
 * Every guard this plugin installs hangs on the Harness tool registry
 * (`ctx.get('tools').guard(...)`), so it only ever sees calls the Host
 * dispatches. A native engine — the Claude Agent SDK, the Codex App Server —
 * ships its own file and shell tools, and those run *inside the engine*: they
 * never pass through the registry, so the credential-path shield, the command
 * policy, and Plan Mode refusal were all silently skipped on both native
 * engines. The only seam those calls do cross is the engine's permission
 * callback, and that is where this module is consulted.
 *
 * The engine names its tools for its own model, not for the Harness registry
 * (`Bash` vs `bash`, `MultiEdit` vs `multi_edit`, `Read{file_path}` vs
 * `read{path}`). {@link nativeToolCall} projects one native call into the shape
 * the existing guards already read, so the guards themselves keep exactly one
 * implementation and cannot disagree with the names they protect.
 *
 * Deny-only by construction: this module can refuse a call, never authorize
 * one. A call it leaves alone still goes on to the normal engine approval, so
 * adding a rule here can only remove a prompt, never a protection.
 *
 * The doom-loop tier was left out at first, because its fingerprints are keyed
 * per agent and shared across the whole tool surface, so folding native calls in
 * looked like it would let a native call suppress a Harness one. Re-examining it
 * turned that around: the fact that both paths share one fingerprint space is
 * the *correct* semantics. A loop is the agent's behaviour, not the transport's
 * — the same file written three times with the same arguments is the same
 * repetition whether the call arrived through the registry or through the
 * engine's own tool, and the two are the same Agent, so they land on the same
 * key. Only the exemption list needed checking, and it names polling tools
 * (`wait`, `sleep`, `job_output`) that have no native equivalent to exempt.
 *
 * One thing that tier must NOT do is count a call twice. A Harness tool invoked
 * from a native session travels the plugin's own MCP bridge, which executes it
 * through `ctx.tools.execute` — so the registry guard already judged it and
 * already counted it. Counting it here as well would halve the effective
 * threshold and turn a legitimate third identical read into a denial. Bridged
 * calls are therefore excluded from the count by name (`mcp__…`, which is what
 * an MCP tool call is called on every transport), and the exclusion is about the
 * count only: the monotonic tiers above still judge every call.
 *
 * @module @deepseek-ai/dsh-freecodego/native-tool-guard
 */

import { commandPolicyDenial, COMPILED_BUILT_IN_COMMAND_POLICY, type CompiledCommandPolicy } from './command-policy.ts'
import { planModeRefusal, type PlanMode } from './plan-mode.ts'
import { PATH_ARGUMENT_KEYS, denyRealpathRefusal, denyRefusal } from './sandbox/profiles.ts'
import { bashCommandOf, credentialReadDenial, credentialRealpathDenial, projectCommandPolicyDenial } from './tool-guards.ts'

/** One native engine call, named the way the Harness guards read tools. */
export interface NativeToolCall {
  /** Harness-vocabulary tool name (`bash`, `read`, `multi_edit`). */
  readonly name: string
  /** Arguments with the harness key (`path`) filled in from the engine's own. */
  readonly arguments: Record<string, unknown>
}

/** The guard settings and mode view a native call is evaluated against. */
export interface NativeToolGuardDeps {
  readonly settings: () => {
    readonly envReadGuardEnabled?: boolean
    readonly commandPolicyEnabled?: boolean
    readonly planModeEnabled?: boolean
    readonly doomLoopGuardEnabled?: boolean
  } | undefined
  /** Compiled command policy; the built-in rules when omitted. */
  readonly policy?: CompiledCommandPolicy
  /**
   * The repository's own command policy for this call's workspace, when that
   * checkout declared `permissionRules`.
   *
   * A value rather than a resolver, unlike the Harness guard: a native permission
   * request carries the Agent it belongs to, so the caller already closes over the
   * workspace and resolves one policy for the whole request. Evaluated beside the
   * built-in policy, so it can only add denials.
   */
  readonly projectPolicy?: CompiledCommandPolicy
  /**
   * Sandbox profile deny globs.
   *
   * A value rather than a provider, unlike `settings`: the deny list is a settings
   * read that the caller already performs once per request, and a native permission
   * request carries several calls that must all be judged against one list rather
   * than against whatever the document says between them.
   */
  readonly deny?: readonly string[]
  /** Plan Mode view for this call's agent; when absent, Plan Mode is not enforced. */
  readonly planMode?: { readonly mode: PlanMode | undefined; readonly policy?: CompiledCommandPolicy }
  /**
   * The doom-loop guard.
   *
   * Wired here and *only* here: a native engine's tools run inside the engine's
   * process, so they never cross `tools/pre-execute`, and the Harness's advisory
   * `dsh-repeat-tool-reminder` cannot count what it cannot see. Calls the Host
   * does dispatch are that guard's to judge, which is why
   * `freeCodeGoToolGuard` carries no loop tier for them.
   *
   * It is called with the projected call only. The caller closes over the agent
   * the request belongs to, because the guard keys its fingerprints by agent and
   * this module has no view of which Agent opened the native session. Omitted
   * entirely when the caller has no guard, which is how a composition without one
   * keeps this tier disabled rather than inventing it.
   */
  readonly doomLoop?: {
    deny(call: { readonly name: string; readonly arguments: Record<string, unknown> }): string | undefined
  }
}

/**
 * Filesystem keys engines use for the same idea, in the order we prefer them.
 *
 * The judgment list from `sandbox/profiles.ts` rather than a copy of it. The copy
 * this replaced had `notebook_path` while the judgment list did not, which made the
 * projection the only reason an engine's `NotebookEdit` was seen at all — and left
 * the same call from a Harness tool judged by nothing, since the Harness pipeline
 * never runs this projection. One vocabulary, so a key added for one surface is
 * added for every surface.
 */
const PATH_KEYS: readonly string[] = PATH_ARGUMENT_KEYS

/**
 * Project one native tool name into the Harness guard vocabulary.
 *
 * The engines label their tools for humans (`Bash`, `MultiEdit`,
 * `NotebookEdit`); the guard lists are snake_case. Every snake_case name
 * already passes through unchanged, so `apply_patch` (Codex) and `bash` behave
 * exactly as written. An unrecognized name is not an error: it simply matches
 * no rule, which is the same thing that happens to a Harness tool the guards do
 * not classify.
 *
 * @param raw - the engine's tool name.
 * @returns the snake_case name the guards match on.
 */
export function nativeToolName(raw: string): string {
  return raw
    .trim()
    // A camelCase hump is the engine's spelling of the same word.
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9_]+/gu, '_')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase()
}

/**
 * Project one native tool call into the shape the Harness guards read.
 *
 * Only the filesystem path is re-keyed: the credential guard reads
 * `path ?? file_path`, and the engines use `file_path`/`notebook_path`, so
 * filling `path` in is what makes one guard serve both vocabularies. The
 * engine's own keys are preserved, because a guard added later may read them.
 *
 * @param toolName - the engine's tool name.
 * @param input - the engine's argument object, as sent over its transport.
 * @returns the projected call.
 */
export function nativeToolCall(toolName: string, input: unknown): NativeToolCall {
  const raw = typeof input === 'string'
    // A stringy payload must not silently bypass the guard; the same defensive
    // decode the Harness pipeline uses.
    ? (() => { try { return JSON.parse(input) as unknown } catch { return undefined } })()
    : input
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const args: Record<string, unknown> = { ...source }
  if (typeof args.path !== 'string') {
    const path = PATH_KEYS.map(key => args[key]).find(value => typeof value === 'string' && value !== '')
    if (path !== undefined) args.path = path
  }
  return { name: nativeToolName(toolName), arguments: args }
}

/** Codex App Server approval methods that carry a shell command. */
const CODEX_COMMAND_APPROVALS = new Set(['item/commandExecution/requestApproval', 'execCommandApproval'])

/** Codex App Server approval methods that carry file changes or a write root. */
const CODEX_FILE_APPROVALS = new Set(['item/fileChange/requestApproval', 'applyPatchApproval'])

/**
 * Project one engine permission request into the calls a guard can judge.
 *
 * Two transports ask for permission in two different vocabularies. The Claude
 * Agent SDK names its tool and hands over its arguments; the Codex App Server
 * sends the method itself and a params object shaped per method (the command in
 * `command`, file changes as a path-keyed `fileChanges` map). Both become the
 * same Harness-vocabulary calls here, so the guard rules stay in one place.
 *
 * An empty result means "this request carries nothing a guard can judge", and
 * the caller must leave it to the engine's own approval. Guessing — inventing a
 * tool name for a method with no readable meaning — would risk refusing a call
 * for the wrong reason, and a wrong refusal is worse than a missing one when the
 * user is already being asked.
 *
 * A declared App Server method is read *before* the transport's tool name, not
 * after. The name is not always the engine's own: `native-agent` fills it on
 * every request (`detail.toolName ?? detail.method ?? 'native'`), and a Codex
 * approval's params carry neither key, so the entire Codex transport arrives
 * here named `native`. Reading the name first judged each of those calls as an
 * unknown tool with no arguments — which left the command policy, the sandbox
 * deny list and Plan Mode inert for Codex while the model was told they applied.
 * A Codex approval names what it is approving in its method and cannot be
 * ambiguous, so the method wins; the name is the fallback, not the priority.
 *
 * @param request - the transport's tool name (Claude) or method (Codex), plus its detail.
 * @returns one call per thing to judge; empty when nothing is classifiable.
 */
export function nativeCallsFromPermission(request: {
  readonly toolName?: unknown
  readonly method?: unknown
  readonly detail?: unknown
}): readonly NativeToolCall[] {
  const detail = request.detail !== null && typeof request.detail === 'object' && !Array.isArray(request.detail)
    ? request.detail as Record<string, unknown>
    : {}
  const method = typeof request.method === 'string' ? request.method.trim() : ''
  if (CODEX_COMMAND_APPROVALS.has(method)) {
    // `execCommandApproval` sends argv while the newer method sends one string.
    const command = typeof detail.command === 'string'
      ? detail.command
      : Array.isArray(detail.command) ? detail.command.filter((part): part is string => typeof part === 'string').join(' ') : undefined
    // The rest of the params travel with the call: a guard keyed on the working
    // directory or a network context must see the same request the engine sent.
    return command === undefined || command.trim() === '' ? [] : [nativeToolCall('shell', { ...detail, command })]
  }
  if (CODEX_FILE_APPROVALS.has(method)) {
    const paths = new Set<string>()
    if (typeof detail.grantRoot === 'string' && detail.grantRoot !== '') paths.add(detail.grantRoot)
    // `fileChanges` is a path-keyed map, so every changed file is judged — a
    // patch that touches one credential file among ten must not pass because the
    // first path happened to be innocent.
    if (detail.fileChanges !== null && typeof detail.fileChanges === 'object' && !Array.isArray(detail.fileChanges)) {
      for (const path of Object.keys(detail.fileChanges)) paths.add(path)
    }
    return [...paths].map(path => nativeToolCall('apply_patch', { path }))
  }
  if (typeof request.toolName === 'string' && request.toolName.trim() !== '') {
    return [nativeToolCall(request.toolName, detail.input)]
  }
  return []
}

/**
 * The guard refusal for one native engine call, or `undefined` to leave it to
 * the engine's own approval.
 *
 * Ordering mirrors `freeCodeGoToolGuard`: credential material first (a call
 * that reads a secret is refused whatever else it does), then the command
 * policy, then Plan Mode, then the sandbox deny list. Each tier is skipped by
 * the same setting that disables it on the Harness pipeline, so one user
 * preference controls both.
 *
 * One tier is this path's alone — the doom loop, last. The Harness pipeline has
 * no loop tier left to mirror: every call it judges was dispatched, so
 * `dsh-repeat-tool-reminder` already counts it.
 *
 * @param call - a call from {@link nativeToolCall}.
 * @param deps - the plugin's guard settings, policy, and Plan Mode view.
 * @returns the refusal message to show the model, or `undefined` when allowed.
 */
export async function nativeToolDenial(call: NativeToolCall, deps: NativeToolGuardDeps): Promise<string | undefined> {
  const settings = deps.settings()
  if (settings?.envReadGuardEnabled !== false) {
    const denial = credentialReadDenial(call.name, call.arguments)
    if (denial !== undefined) return denial
    // The lexical tier answers about the name the engine wrote; only a
    // resolution can see that `docs/notes.md` is a link to `.ssh/id_rsa`.
    // Fail-open: an unresolvable path stays with the lexical tier's answer.
    const resolved = await credentialRealpathDenial(call.name, call.arguments).catch(() => undefined)
    if (resolved !== undefined) return resolved
  }
  if (settings?.commandPolicyEnabled !== false) {
    // The same helper the Harness pipeline uses, not a second copy of the tool
    // names: this function's contract is that its tiers mirror
    // `freeCodeGoToolGuard`, and an inline list is how that stops being true.
    const command = bashCommandOf(call.name, call.arguments)
    if (command !== undefined) {
      const denial = commandPolicyDenial(deps.policy ?? COMPILED_BUILT_IN_COMMAND_POLICY, command)
        ?? projectCommandPolicyDenial(deps.projectPolicy, command)
      if (denial !== undefined) return denial
    }
  }
  // The sandbox profile's deny list sits with the credential shield rather than with
  // the monotonic tiers: it refuses a call because of *what the path is*, so it must
  // be reported as that reason and never as a loop.
  const denied = denyRefusal({ deny: deps.deny ?? [], args: call.arguments })
  if (denied !== undefined) return denied
  // …and its resolution tier, beside the shield's for the same reason: a junction or
  // a symlink into a denied directory passes every rule a *name* can be judged by.
  // Fail-open: an unresolvable path stays with the lexical tier's answer.
  const resolvedDenied = await denyRealpathRefusal({ deny: deps.deny ?? [], args: call.arguments }).catch(() => undefined)
  if (resolvedDenied !== undefined) return resolvedDenied
  if (settings?.planModeEnabled !== false && deps.planMode?.mode === 'plan') {
    const refusal = planModeRefusal({
      mode: 'plan',
      tool: call.name,
      args: call.arguments,
      ...(deps.planMode.policy === undefined ? {} : { policy: deps.planMode.policy }),
    })
    if (refusal !== undefined) return refusal.message
  }
  // Last, and after the monotonic tiers: a call refused for a policy reason must
  // be reported as that reason, never as a loop (the same ordering the Harness
  // pipeline uses). This is the plugin's only loop tier — see
  // `NativeToolGuardDeps.doomLoop`.
  if (settings?.doomLoopGuardEnabled !== false && deps.doomLoop !== undefined && !isBridgedCall(call)) {
    const denial = deps.doomLoop.deny({ name: call.name, arguments: call.arguments })
    if (denial !== undefined) return denial
  }
  return undefined
}

/**
 * Whether this call travelled the plugin's own MCP bridge, which means the
 * Harness registry already counted it.
 *
 * `mcp__<server>__<tool>` is how a model names an MCP tool on every transport
 * the plugin drives, and after projection it is `mcp_<server>_<tool>`.
 *
 * @param call - a projected call from {@link nativeToolCall}.
 * @returns true when the call is MCP-carried and must not be counted twice.
 */
export function isBridgedCall(call: NativeToolCall): boolean {
  return call.name.startsWith('mcp_')
}
