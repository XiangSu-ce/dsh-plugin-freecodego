/**
 * Typed `ctx.provide` for Host service fakes.
 *
 * Why
 * ---
 * Cordis's typed `provide` overload wants the service's *instance* type, which
 * no test can build: Host services are classes carrying private state, so every
 * fake in this suite arrived as `as never`. That cast erased the service face
 * too, and a fake could then declare a member the Host never publishes while the
 * suite stayed green — `workspaceRegistry.forgetSession` and
 * `sessionPersistence.inspect` were both asserted that way for a long time while
 * doing nothing in production.
 *
 * What this keeps, and what it forbids
 * ------------------------------------
 * A fake may still omit members (a test stubs what its subject reads) and may
 * still stand in for an incomplete *value* with its own narrow cast, but it may
 * not invent a member of the service: an extra property reaches the compiler as
 * a fresh object literal checked against the service's declared face, so it
 * fails to build instead of silently degrading at runtime.
 *
 * Migrating a `ctx.provide('x', {…} as never)` site
 * ------------------------------------------------
 * Move it to {@link provideHostService} (or {@link provideHostServiceAs} for a
 * service the plugin publishes itself, which no `keyof Context` names). Four
 * facts about the real faces are what a fake usually has to be told, all of them
 * verified against the pinned Host:
 *
 * - `settings`: `SettingsScope<T>` is `get` + `watch` + `update` **+ `replace`**,
 *   so a fake that stops at `update` does not satisfy the registration. Its
 *   `get()` also returns the schema-resolved `T`, which only the plugin's own
 *   schema names, so a fake answers {@link settingsValue} of the record it holds.
 * - `credentials`: `resolve` answers `ResolvedCredential`, which is
 *   `{ value, source }` — a fake handing back a key states its source layer id
 *   (`'env'`, `'file'`, `'user-env'`) too.
 * - `llm`: `registerAdapter` returns `AdapterRegistrationHandle`, a *callable*
 *   with `replace(providers)`; `listProviders` answers `LlmProviderInfo`
 *   (`{ id, name }`).
 * - `systemPrompt`: `PromptSection` requires `order`, which a hand-written
 *   parameter type forgets. Annotate the fake's parameter as
 *   `Parameters<Context['systemPrompt']['section']>[0]` rather than restating it;
 *   its `text` may be a provider of one assembly context, so a test calling it
 *   narrows that call.
 * - `tools`: `register` takes a `ToolDefinition`, whose `output` is **required**
 *   and whose `execute(args, exec: ToolRunContext)` promises `unknown`, and whose
 *   `parameters` is a `JsonSchemaNode`. A test reads those with a documented view
 *   (`toolView` in `plugin.spec.ts`) and calls `execute` with the subset of
 *   `ToolRunContext` the tool reads ({@link runContext}).
 *
 * Three more things the suite-wide pass turned up, all visible at the fake:
 *
 * - Some services the plugin reads are **not declared on `Context`** in a spec's
 *   program at all — `commands`, `goals`, and `planMode` are reached through a
 *   guarded `ctx.get(...)` because the plugin states its own shape for them. Use
 *   {@link provideHostServiceAs} and prefer the plugin's own exported face where
 *   it has one (`UpstreamPlanMode`), otherwise mirror its declared statement
 *   ({@link GoalsFace} mirrors `GoalServiceLike`).
 * - `guard` answers a *disposer*, like `register`, so a fake that returns
 *   `undefined` does not satisfy the runtime.
 * - A `tools` fake that answers `schemas` must answer the Host's own type:
 *   a hand-written `readonly` row type is not assignable to `ToolSchema[]`.
 *
 * While migrating, quote enough of the closing form: rewriting a bare
 * `} as never)` also strips the cast from a non-service statement that happens to
 * end the same way (`…Alpha(undefined, { … } as never)`), which compiles until
 * the compiler sees the argument's real type.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** A service name this Host's Context publishes. */
type HostServiceName = keyof Context & string

/**
 * Provide one Host service fake, checked against that service's real face.
 * @param ctx - the test's root context.
 * @param name - the service name, which also selects the checked face.
 * @param fake - the members this test stands in for.
 */
export function provideHostService<Name extends HostServiceName>(
  ctx: Context,
  name: Name,
  fake: Partial<Context[Name]>,
): void {
  ctx.provide(name, fake as Context[Name])
}

/**
 * Provide a service fake whose contract is a named narrower interface rather
 * than the Host's own service type.
 *
 * The one caller this exists for is Session storage: the plugin reads it through
 * its own adapter types (`SessionEventsPersistence` / `SessionDeletionPersistence`),
 * which describe `stat` and `open` as the abstract `SessionPersistence` declares
 * them **plus** the two members only the shipped JSONL backend carries — its
 * private `locate`, and the `delete` alpha.2 made public. Stating that contract
 * by name keeps the fake checked (a typo in a member is still an error) while the
 * default overload keeps the Host's face as the contract everywhere else.
 *
 * @template Face - the declared contract of the fake.
 * @param ctx - the test's root context.
 * @param name - the service name to provide under.
 * @param fake - the members this test stands in for.
 */
export function provideHostServiceAs<Face extends object>(
  ctx: Context,
  name: string,
  fake: Partial<Face>,
): void {
  ctx.provide(name, fake as never)
}

/**
 * Presence-only stand-ins for the two live objects a test hands to the plugin.
 *
 * A Host service hands out its own class instances, so a test cannot build one
 * member-for-member; the cast is confined to the *value* (an Agent whose single
 * read is `status`, a Session whose single read is `header`) while the service
 * face itself stays checked, which is what stops a fake from declaring a member
 * the Host never publishes.
 */
export type HostAgent = NonNullable<ReturnType<Context['agents']['get']>>
/** A live Agent that reports itself idle — the one member the plugin reads. */
export const idleAgent = (): HostAgent => ({ status: 'idle' } as unknown as HostAgent)

/** A live Session object; the plugin reads its `header` when it needs one. */
export type HostSession = NonNullable<ReturnType<Context['sessions']['get']>>
/** A live Session, present but carrying nothing a presence check reads. */
export const liveSession = (): HostSession => ({} as unknown as HostSession)

/**
 * A live Session whose header reports `cwd` — the one member boot reads to key a
 * session to its project root.
 * @param cwd - the absolute workspace root the header must report.
 */
export const sessionAt = (cwd: string): HostSession => ({ header: { cwd } } as unknown as HostSession)

/**
 * A live Session carrying the members a test stands in for (an id, a header).
 * @param value - the real members; the rest of the Session belongs to the Host.
 */
export const sessionValue = (value: object): HostSession => value as unknown as HostSession

/**
 * A live Agent carrying the members a test stands in for (an id, a session, an
 * `inject`).
 * @param value - the real members; the rest of the Agent belongs to the Host.
 */
export const agentValue = (value: object): HostAgent => value as unknown as HostAgent

/**
 * Faces of the services this plugin publishes itself. They reach a test through
 * `ctx.get('…')`, so the compiler cannot derive them from `Context` and a fake
 * has to state them — these are the members the plugin actually calls.
 */
export type AgentEnginesFace = {
  setAvailability?(id: 'codex' | 'claude', availability: 'available' | 'unavailable' | 'updating'): void
}
/** The engine router's release path, which `sessionDelete` reaches for. */
export type EngineRouterFace = { disposeAgent?(sessionId: SessionId): Promise<boolean> }
/**
 * The command registry as this plugin reads it.
 *
 * `commands` is not part of the `Context` declaration this program sees — the
 * plugin reaches it through `ctx.get('commands')` and states the one member it
 * calls — so a fake is checked against that statement rather than the Host class.
 */
export type CommandsFace = {
  register(definition: {
    readonly definitionId?: string
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string }
    readonly handler: (invocation: { readonly rawInput: string }) => Promise<{ readonly kind: 'success' | 'error'; readonly text: string }>
  }): () => void
}

/**
 * The workspace registry as the plugin probes it. No pinned Harness line
 * declares a session-level forget, so this member is skipped on every supported
 * build; the navigation the user sees is updated by the `api-session/removed`
 * edge instead. It stays a probe so a build that grows one is used.
 */
export type WorkspaceRegistryFace = { forgetSession?(sessionId: SessionId): Promise<void> }

/**
 * The resolved value of a settings fake.
 *
 * `register`'s resolved type `T` is inferred from the schema the *plugin*
 * declares — an `intersect` over its own namespace — so no test can name it. A
 * fake answers the plain record it holds and states that it stands in for that
 * `T`: the one part of the settings face a test cannot build.
 * @param value - the record the test drives the plugin with.
 */
export function settingsValue(value: object): never {
  return value as never
}

/**
 * The Harness goal service as this plugin reads it.
 *
 * `goals` is not part of the `Context` declaration this program sees: the plugin
 * reaches it through `ctx.get('goals')` and states its own `GoalServiceLike`
 * shape, deliberately not depending on `dsh-goal` for a type. This mirrors the
 * members the plugin calls, with the agent argument left open.
 */
export type GoalsFace = {
  get(agent: unknown): object | undefined
  create(agent: unknown, request: { readonly objective: string; readonly maxGoalRounds?: number }): { readonly id: string }
  resume(agent: unknown, ref: { readonly id: string; readonly revision: number }): unknown
  pause(agent: unknown, ref: { readonly id: string; readonly revision: number }): unknown
  disarm(agent: unknown): unknown
  /** Optional in the plugin's own statement, so optional here. */
  edit?(agent: unknown, ref: { readonly id: string; readonly revision: number }, request: { readonly maxGoalRounds?: number }): unknown
}

/**
 * The `ToolRunContext` a recorded definition is called with.
 *
 * `ToolDefinition.execute` declares the whole context; the tools under test read
 * one or two fields of it (`signal`, `agent`), and a test builds those. The cast
 * stands for the rest of the context — the same subset the tool body reads.
 * @param fields - the context members the tool under test reads; omitted when the
 *   call under test is the one a session makes without a context.
 */
export function runContext(fields?: Record<string, unknown>): ToolRunContext {
  return fields as unknown as ToolRunContext
}

/**
 * The handle `llm.registerAdapter` answers with: callable to release the routes
 * it holds, and carrying `replace` for the route set.
 */
export function registrationHandle(): AdapterRegistrationHandle {
  return Object.assign(() => undefined, { replace: () => undefined })
}

/** A recorded definition, for the tests that read what the tool declared. */
export type RecordedTool = ToolDefinition
