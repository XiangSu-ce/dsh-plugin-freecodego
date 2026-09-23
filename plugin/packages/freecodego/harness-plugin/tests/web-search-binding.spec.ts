import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { bridgeRouteIdOf } from '../src/claude-protocol-bridge.ts'
import { provideHostService, provideHostServiceAs, type AgentEnginesFace } from './support/host-services.ts'
import {
  WEB_SEARCH_API_KEY_REF,
  WEB_SEARCH_SETTINGS_NAMESPACE,
  repairWebSearchBinding,
  webSearchBindingStatus,
  type WebSearchBindingRepairDeps,
  type WebSearchStoredSection,
} from '../src/web-search-binding.ts'
import type { FreeCodeGoWebSearchBinding } from '../src/types.ts'

const BRIDGE_ROUTE = '11111111-2222-3333-4444-555555555555'

function bridgeBinding(overrides: Partial<FreeCodeGoWebSearchBinding> = {}): FreeCodeGoWebSearchBinding {
  return {
    provider: 'vyce',
    model: 'deepseek-v4.1',
    baseURL: `http://127.0.0.1:45999/anthropic/${BRIDGE_ROUTE}/v1`,
    apiKeyEnv: WEB_SEARCH_API_KEY_REF,
    apiKey: 'sk-bridge-fresh',
    durable: false,
    ...overrides,
  }
}

/** A saved section naming one of this plugin's own bindings. */
function sectionOf(binding: FreeCodeGoWebSearchBinding): WebSearchStoredSection {
  return { model: binding.model, baseURL: binding.baseURL, apiKeyEnv: binding.apiKeyEnv, maxSearchesPerRequest: 5 }
}

function deps(
  section: WebSearchStoredSection | undefined,
  overrides: Partial<WebSearchBindingRepairDeps> = {},
): WebSearchBindingRepairDeps & { readonly writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    readSection: async () => section,
    servesBridgeRoute: () => false,
    remembered: { provider: 'vyce', model: 'deepseek-v4.1' },
    bind: async () => bridgeBinding(),
    writeCredential: async (ref, value) => { writes.push(`credential:${ref}=${value}`) },
    writeSection: async (patch) => { writes.push(`section:${patch.model}@${patch.baseURL}#${patch.apiKeyEnv}`) },
    ...overrides,
  }
}

describe('webSearchBindingStatus', () => {
  it('reports a saved route this process serves as a live bridge binding', async () => {
    const binding = bridgeBinding()
    const reads = { readSection: async () => sectionOf(binding), servesBridgeRoute: (id: string) => id === BRIDGE_ROUTE }
    await expect(webSearchBindingStatus({ ...reads, remembered: undefined }))
      .resolves.toEqual({ state: 'bridge', alive: true })
    // A dead route id leaves the state alone and flips only the answer that makes the
    // page offer the pick again.
    await expect(webSearchBindingStatus({ ...reads, servesBridgeRoute: () => false, remembered: undefined }))
      .resolves.toEqual({ state: 'bridge', alive: false })
  })

  it('treats a provider serving its own API as durable rather than as someone else', async () => {
    // The section was written by this plugin — its private reference says so — and a
    // stock https endpoint cannot be a route of a per-process loopback bridge, so a
    // restart has nothing to repair. Reading it as `other` would make the page treat
    // the user's own saved choice as a foreign binding.
    const durable = { model: 'claude-sonnet-4-6', baseURL: 'https://api.example.test/v1', apiKeyEnv: WEB_SEARCH_API_KEY_REF }
    await expect(webSearchBindingStatus({ readSection: async () => durable, servesBridgeRoute: () => false, remembered: undefined }))
      .resolves.toEqual({ state: 'durable', alive: true })
  })

  it('reports the user\'s own key, an unserved namespace, and the remembered pair', async () => {
    const reads = deps(undefined)
    await expect(webSearchBindingStatus(reads)).resolves.toEqual({
      state: 'none',
      alive: true,
      remembered: { provider: 'vyce', model: 'deepseek-v4.1' },
    })
    // A section naming the provider's own reference is the user's key for the official
    // endpoint, never this plugin's binding, whatever its URL looks like.
    const official = { model: 'deepseek-chat', baseURL: `http://127.0.0.1:1/anthropic/${BRIDGE_ROUTE}/v1`, apiKeyEnv: 'DEEPSEEK_API_KEY' }
    await expect(webSearchBindingStatus({ ...deps(official), remembered: undefined }))
      .resolves.toEqual({ state: 'other', alive: true })
  })
})

describe('repairWebSearchBinding', () => {
  it('leaves a live bridge route and a durable endpoint alone', async () => {
    const live = deps(sectionOf(bridgeBinding()), { servesBridgeRoute: id => id === BRIDGE_ROUTE })
    await expect(repairWebSearchBinding(live)).resolves.toEqual({ outcome: 'live' })
    const durable = deps({ model: 'claude-sonnet-4-6', baseURL: 'https://api.example.test/v1', apiKeyEnv: WEB_SEARCH_API_KEY_REF })
    await expect(repairWebSearchBinding(durable)).resolves.toEqual({ outcome: 'live' })
    expect([...live.writes, ...durable.writes]).toEqual([])
  })

  it('rebuilds a dead bridge route from the remembered pair, credential before section', async () => {
    const subject = deps(sectionOf(bridgeBinding()))
    await expect(repairWebSearchBinding(subject)).resolves.toEqual({ outcome: 'rebuilt' })
    // Order is load-bearing: a section pointing at a reference that holds nothing
    // turns every search into an authentication failure, which is the opposite of a
    // repair. The value written is the freshly minted key, not the one saved.
    expect(subject.writes).toEqual([
      'credential:FREECODEGO_WEB_SEARCH_API_KEY=sk-bridge-fresh',
      `section:deepseek-v4.1@${bridgeBinding().baseURL}#${WEB_SEARCH_API_KEY_REF}`,
    ])
  })

  it('writes both fields of the fresh binding, whichever provider the pair names', async () => {
    const subject = deps(sectionOf(bridgeBinding()), {
      remembered: { provider: 'opencode', model: 'qwen3.8-flash' },
      bind: async input => bridgeBinding({ provider: input.provider, model: 'qwen3.8-flash', baseURL: 'http://127.0.0.1:45999/anthropic/66666666-7777-8888-9999-000000000000/v1' }),
    })
    await expect(repairWebSearchBinding(subject)).resolves.toEqual({ outcome: 'rebuilt' })
    expect(subject.writes[1]).toBe(`section:qwen3.8-flash@http://127.0.0.1:45999/anthropic/66666666-7777-8888-9999-000000000000/v1#${WEB_SEARCH_API_KEY_REF}`)
  })

  it('reports a dead route with no recorded pair instead of guessing one', async () => {
    // A binding written before this plugin recorded its pair. Rebuilding from a guessed
    // provider would silently change which account the user pays with, so the page is
    // where the choice goes back to the user.
    const subject = deps(sectionOf(bridgeBinding()), { remembered: undefined })
    await expect(repairWebSearchBinding(subject)).resolves.toEqual({ outcome: 'no-memory' })
    expect(subject.writes).toEqual([])
  })

  it('reports a namespace the Host does not serve and someone else\'s binding as nothing to do', async () => {
    await expect(repairWebSearchBinding(deps(undefined))).resolves.toEqual({ outcome: 'unavailable' })
    const official = deps({ model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' })
    await expect(repairWebSearchBinding(official)).resolves.toEqual({ outcome: 'not-applicable' })
    // Our reference with no endpoint at all is a section this plugin cannot attribute,
    // so it is left for the page rather than rewritten at boot.
    const bare = deps({ apiKeyEnv: WEB_SEARCH_API_KEY_REF, model: 'deepseek-v4.1' })
    await expect(repairWebSearchBinding(bare)).resolves.toEqual({ outcome: 'not-applicable' })
    expect([...official.writes, ...bare.writes]).toEqual([])
  })

  it('reports a failed resolution and leaves the section exactly as it was', async () => {
    const failing = deps(sectionOf(bridgeBinding()), {
      bind: async () => { throw new Error('provider "vyce" has no route for "deepseek-v4.1"') },
    })
    await expect(repairWebSearchBinding(failing)).resolves.toEqual({
      outcome: 'failed',
      detail: 'provider "vyce" has no route for "deepseek-v4.1"',
    })
    expect(failing.writes).toEqual([])
  })

  it('reports a failed credential write without pointing the section at an empty reference', async () => {
    const failing = deps(sectionOf(bridgeBinding()), {
      writeCredential: async () => { throw new Error('the credentials service is not mounted') },
    })
    await expect(repairWebSearchBinding(failing)).resolves.toEqual({
      outcome: 'failed',
      detail: 'the credentials service is not mounted',
    })
    expect(failing.writes).toEqual([])
  })

  it('reports a failed section write rather than claiming the binding was rebuilt', async () => {
    const failing = deps(sectionOf(bridgeBinding()), {
      writeSection: async () => { throw new Error('the settings service is not mounted') },
    })
    await expect(repairWebSearchBinding(failing)).resolves.toEqual({
      outcome: 'failed',
      detail: 'the settings service is not mounted',
    })
  })

  it('reports a failing section read instead of throwing out of the start path', async () => {
    const subject = deps(undefined, { readSection: async () => { throw new Error('settings service unavailable') } })
    await expect(repairWebSearchBinding(subject)).resolves.toEqual({ outcome: 'failed', detail: 'settings service unavailable' })
  })

  it('accepts both spellings of a bridge endpoint and rejects anything else', async () => {
    // The settings document is hand-editable, and the two callers of a bridge endpoint
    // join `/v1` differently, so the parser has to read the id out of either.
    expect(bridgeRouteIdOf(`http://127.0.0.1:45999/anthropic/${BRIDGE_ROUTE}`)).toBe(BRIDGE_ROUTE)
    expect(bridgeRouteIdOf(`http://127.0.0.1:45999/anthropic/${BRIDGE_ROUTE}/v1`)).toBe(BRIDGE_ROUTE)
    expect(bridgeRouteIdOf('https://api.deepseek.com/anthropic/v1')).toBeUndefined()
    expect(bridgeRouteIdOf('not a url')).toBeUndefined()
  })
})

describe('webSearchBinding namespace', () => {
  it('addresses the page\'s own namespace, spelled as the page spells it', () => {
    expect(WEB_SEARCH_SETTINGS_NAMESPACE).toBe('web-search-deepseek')
  })
})

function AgentEngineRegistry(ctx: Context): void {
  provideHostServiceAs<AgentEnginesFace>(ctx, 'agentEngines', { setAvailability: () => undefined })
  provideHostService(ctx, 'agents', { list: () => [], get: () => undefined })
}

/**
 * The composition this file was written against.
 *
 * Both passes read the settings document through the policy, and a composition that
 * supplies a *partial* one is a state this program does reach — a bare context like
 * this, or a profile patch that named neither of the binding fields. Reading the pair
 * with the field's own type (`string`) crashed the boot pass on the missing value, and
 * because that pass is fire-and-forget the crash arrived as an unhandled rejection:
 * the process died instead of starting with an unrepairable binding. Asserted here so
 * the answer is the one the page needs — "nothing recorded to rebuild with" — rather
 * than a construction that only works when every field happens to be present.
 */
describe('web-search binding on a composition with a partial settings document', () => {
  it('answers the page and survives the boot pass', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-web-search-boot-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const ctx = new Context()
    await ctx.plugin(AgentEngineRegistry)
    try {
      const plugin = new FreeCodeGoHarnessPlugin(ctx, {})
      // No settings service is mounted here, so the namespace is not served at all and
      // there is no saved endpoint to report on.
      await expect(plugin.webSearchBindingStatus()).resolves.toEqual({ state: 'none', alive: true })
      // Disposed before the temporary home is removed: the pack holds stores under it
      // while it is running, and Windows refuses to unlink a file another handle has
      // open — an `rm` that retries forever is a test that hangs rather than fails.
      await ctx.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})
