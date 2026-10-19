/**
 * The real Harness world the runtime integration specs dispatch through.
 *
 * Why this lives in `support`
 * ---------------------------
 * `tool-runtime-integration.spec.ts` stood up a real Cordis tree — SessionStore,
 * AgentRegistry, SystemPrompt, ToolRuntime and a FreeCodeGoNativeAgent — so that a
 * tool was exercised the way the model reaches it (`tools.execute`) rather than by
 * calling a definition's `execute` directly. The closure work needs the same tree
 * for a different subject (memory drafts, checkpoints, worktrees), and a second
 * copy of an eighty-line harness is the duplication these gates exist to find.
 *
 * The world is deliberately the *smallest* real tree: no Loader, no settings
 * service, no bundle. `settings/document-updated` is emitted by hand the way a
 * live settings write would, because that event is the seam the deferred-tool
 * policy listens on and no unit test can produce a real one without a Loader.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/support/runtime-world
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { FreeCodeGoNativeAgent } from '@deepseek-ai/dsh-freecodego-root-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { FreeCodeGoDeferredTools } from '../../src/deferred-tools.ts'
import { FreeCodeGoHarnessPlugin } from '../../src/index.ts'
import { FreeCodeGoPolicy } from '../../src/policy.ts'
import { JSON_TOOL_OUTPUT } from '../../src/tool-definition.ts'
import { pluginConfig, provideHostServiceAs, type AgentEnginesFace } from './host-services.ts'

/** The real registry, with the handles a spec drives it through. */
export interface RuntimeWorld {
  readonly ctx: Context
  readonly deferred: FreeCodeGoDeferredTools
  /**
   * The mounted plugin, when `mountPlugin` was set.
   *
   * Some host operations are Remotes rather than tools — the user-only memory
   * review decision is the one the closure work needs — so a spec that must
   * drive the *real* path has to reach the plugin instance the Remote lives on
   * instead of re-implementing its call. `undefined` when only the deferred
   * layer is mounted, so a spec cannot mistake an unmounted plugin for a
   * missing Remote.
   */
  readonly plugin?: FreeCodeGoHarnessPlugin
  readonly create: (id: string, cwd?: string) => Promise<FreeCodeGoNativeAgent>
  readonly release: (agent: FreeCodeGoNativeAgent) => Promise<void>
  readonly call: (agent: FreeCodeGoNativeAgent, name: string, args?: object) => ReturnType<Context['tools']['execute']>
  readonly commit: (patch: object) => Promise<void>
  readonly register: (name: string) => () => void
  readonly close: () => Promise<void>
}

/**
 * Mount the real registry; no test calls a tool definition's execute directly.
 * @param settings - the plugin settings document, mutated in place by `commit`.
 * @param mountPlugin - mount the whole plugin (engineering, design, worktrees,
 *   prompt composition) instead of only the deferred-tool layer.
 * @param services - extra Host services the mounted plugin reads, keyed by the
 *   name `ctx.get` uses. Provided *before* the plugin is constructed, which is
 *   the only moment that matters: a constructor reads them through
 *   `ctx.get`, and a service provided afterwards is invisible to code that has
 *   already run. The deferred-only world ignores them.
 * @returns the world.
 */
export async function runtimeWorld(
  settings: Record<string, unknown> = {},
  mountPlugin = false,
  services: Readonly<Record<string, unknown>> = {},
): Promise<RuntimeWorld> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, {})
  const tools = ctx.get('tools')!
  const policy = new FreeCodeGoPolicy(pluginConfig(settings), {
    update: async (patch) => {
      Object.assign(settings, patch)
      ctx.emit('settings/document-updated', 'freecodego-harness-plugin' as never, 1)
    },
  })
  const deferred = new FreeCodeGoDeferredTools(ctx, policy)
  for (const [name, fake] of Object.entries(services)) provideHostServiceAs<object>(ctx, name, fake as object)
  let plugin: FreeCodeGoHarnessPlugin | undefined
  if (mountPlugin) {
    provideHostServiceAs<AgentEnginesFace>(ctx, 'agentEngines', { setAvailability: () => undefined })
    plugin = new FreeCodeGoHarnessPlugin(ctx, pluginConfig(settings))
  } else deferred.start()
  const releases = new Map<FreeCodeGoNativeAgent, () => Promise<void>>()
  let sequence = 0
  return {
    ctx,
    deferred,
    ...(plugin === undefined ? {} : { plugin }),
    create: async (id, cwd) => {
      const session = ctx.get('sessions')!.create(SessionId(id), cwd === undefined ? {} : { meta: { cwd } })
      const agent = new FreeCodeGoNativeAgent(ctx, session.id, {}, session)
      const detach = ctx.get('agents')!.enter(agent, undefined)
      releases.set(agent, async () => { detach(); await agent.scope.dispose() })
      await ctx.get('agents')!.announce(agent, 'startup')
      return agent
    },
    release: async (agent) => { await releases.get(agent)?.(); releases.delete(agent) },
    call: (agent, name, args = {}) => tools.execute({
      callId: ToolCallId(`audit-${++sequence}`), name, arguments: args,
      agent, signal: new AbortController().signal,
    }),
    commit: patch => policy.update(patch),
    register: name => tools.register({
      name, description: `Read ${name}`, parameters: { type: 'object', properties: {} },
      output: JSON_TOOL_OUTPUT, execute: async () => ({ ok: true, name }),
    }),
    close: async () => {
      for (const release of releases.values()) await release()
      releases.clear()
      deferred.dispose()
      await ctx.fiber.dispose()
    },
  }
}
