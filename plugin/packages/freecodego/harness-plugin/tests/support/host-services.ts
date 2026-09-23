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
 * - `settings`: the face is a **form over the profile's entries** now — `configure`,
 *   `describe`, `update`, `replace`, `mutate` — and an entry's `Config` is its settings
 *   document, addressed by the profile entry id rather than by a namespace a plugin
 *   registered. Nothing therefore *reads* settings through this service any more, and a
 *   test drives the plugin by handing its constructor a {@link pluginConfig}; what is
 *   left for a fake is the write side, which {@link settingsSink} provides along with the
 *   profile entry a Loader would have created.
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
import type { Volatile } from '@deepseek-ai/cosmokit'
import type { Config } from '../../src/plugin-config.ts'
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
 * One entry of what `settings.describe()` answers.
 *
 * `SettingsDescriptor` is addressed by a branded entry id and carries a schema the
 * service owns; a test cannot build either, so this states the members the plugin reads
 * (`ns`, `value`) and stands in for the rest — the one part of this face a test cannot
 * build, which is why the record is asserted rather than declared.
 * @param ns - the profile entry id the descriptor answers for.
 * @param value - the entry's live settings document, as the plugin would read it.
 */
export function settingsDescriptor(ns: string, value: Record<string, unknown>): never {
  return { ns, autoGenerate: false, schema: {}, value, revision: 0, applies: 'live' } as never
}

/**
 * The profile entry id this plugin's settings are addressed by.
 *
 * `cordis.patch.yml` declares it, `settings-entry.spec.ts` in the UI package compares the
 * two, and this constant is the third place the same string is needed: the entry a test
 * attaches to the plugin's fiber, and the id a write is checked against.
 */
export const SETTINGS_ENTRY = 'freecodego-harness-plugin'

/** The write side of cosmokit's reference protocol, which is what `isVolatile` keys on. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * One live reference over a test record's field.
 *
 * Why it is not simply `{ get: () => value }`: a reference is recognized by the **write
 * symbol** the shared protocol carries, and `isVolatile` tests exactly that. A plain
 * getter object is therefore not a reference — the plugin's `{@link FreeCodeGoPolicy}`
 * would classify the field as deployment input and drop it from the settings document,
 * which is a test that drives nothing while looking like it does. Reading through the
 * record is what lets a case mutate the value it drives the plugin with, and a write lands
 * back in that same record, the way the Loader commits one into the running reference.
 */
function liveReference(values: Record<string, unknown>, key: string): Volatile<unknown> {
  // Asserted rather than declared: `Volatile<T>` is the read side of the protocol, and the
  // write member is the shared symbol `isVolatile` looks for — a shape the interface does
  // not name, so an object literal carrying it is an excess-property error.
  return {
    get: (): unknown => values[key],
    [VOLATILE_WRITE]: (value: unknown): void => { values[key] = value },
  } as Volatile<unknown>
}

/**
 * A plugin Config whose settings are live references over a test's own record.
 *
 * The plugin reads every setting from the Config it is constructed with, so a case drives
 * it by stating the document — a settings-service fake and a resolved-value stand-in are
 * both gone from the read path. Two arguments rather than one because the Config holds two
 * kinds of field and only the schema can tell them apart: `volatile()` marks a setting,
 * and a field without it is deployment input that the plugin reads as a plain value. The
 * helper cannot see the schema, so the caller states which is which — a value passed in
 * the second argument is handed back exactly as written.
 *
 * A key the record does not carry reads as `undefined` rather than as a reference. This is
 * the difference between the two kinds of field being *stated* rather than invented: a
 * consumer of deployment input tests it with `=== undefined` (`config.codexRuntimeDirectory
 * === undefined || …config.codexRuntimeDirectory.trim()…`), so a reference conjured for a
 * field no layer supplied is not a default but a crash. It is also what the `has` trap
 * below already answers, and a proxy whose `has` and `get` disagree about presence is a
 * trap of its own.
 * @param settings - the settings document the plugin should read.
 * @param composition - deployment input, read as plain values.
 * @returns a Config over those two layers.
 */
export function pluginConfig(
  settings: Record<string, unknown> = {},
  composition: Record<string, unknown> = {},
): Config {
  const references = new Map<string, Volatile<unknown>>()
  return new Proxy(settings, {
    get: (target, key) => {
      if (typeof key !== 'string') return Reflect.get(target, key)
      if (Object.hasOwn(composition, key)) return composition[key]
      if (!Object.hasOwn(target, key)) return Reflect.get(target, key)
      const existing = references.get(key)
      if (existing !== undefined) return existing
      const created = liveReference(settings, key)
      references.set(key, created)
      return created
    },
    has: (target, key) => typeof key === 'string' && Object.hasOwn(composition, key) ? true : Reflect.has(target, key),
  }) as unknown as Config
}

/**
 * A settings service fake whose writes land in the record a {@link pluginConfig} reads.
 *
 * The plugin writes through the service by *entry id* — `settings.update(entryId, patch)`,
 * the same call the settings page makes — so a test that asserts a persisted gesture needs
 * two things this returns together: the service fake, and `attach`, which gives a
 * constructed plugin the profile entry the Loader assigns to the fiber it creates it in.
 * A unit test mounts no Loader, and `fiber.entry` is the Loader's own record, so without
 * `attach` the write is dropped as it would be in an SDK tree.
 *
 * `configure` is here even though no test calls it, because the plugin does: it declares
 * its page policy in a `ctx.inject(['settings'], …)` effect, so a fake missing that member
 * turns a real call into a rejection inside the injected fiber. That is not a failure the
 * suite reports — the test it happens under still passes — which is exactly why the member
 * has to be present rather than left out.
 * @param ctx - the test's root context; the fake is provided here.
 * @param values - the record the plugin reads and writes, usually the same one handed to
 *   {@link pluginConfig}.
 * @param composition - deployment input for that Config.
 * @returns the record, its Config, and the entry assignment to apply to the plugin.
 */
export function settingsSink(
  ctx: Context,
  values: Record<string, unknown> = {},
  composition: Record<string, unknown> = {},
): { readonly values: Record<string, unknown>; readonly config: Config; readonly attach: (plugin: object) => void } {
  provideHostService(ctx, 'settings', {
    // The real member returns the effect that undoes the policy it recorded.
    configure: () => () => undefined,
    update: async (entry: string, patch: object): Promise<void> => {
      // The id is checked rather than ignored: a plugin writing to an entry that does not
      // exist is refused by the Host, and a fake that accepted anything would hide exactly
      // the wiring this suite exists to pin.
      if (entry !== SETTINGS_ENTRY) throw new Error(`No configurable plugin entry "${entry}"`)
      Object.assign(values, patch)
    },
  })
  return {
    values,
    config: pluginConfig(values, composition),
    attach: (plugin: object): void => {
      const owner = plugin as { readonly ctx: Context }
      ;(owner.ctx.fiber as { entry?: unknown }).entry = { options: { id: SETTINGS_ENTRY } }
    },
  }
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
