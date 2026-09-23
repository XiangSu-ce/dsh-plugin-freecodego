import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findUpstreamAgentPresets,
  installFreeCodeGoAgentPresets,
  type AgentPresetDefinition,
} from '../src/agent-preset-install.ts'

const directories: string[] = []
const previousHome = process.env.DSH_HOME

beforeEach(() => {
  // `delete`, not `= undefined`: assigning `undefined` stores the literal
  // string "undefined" and the harness then resolves its home to `<cwd>/undefined`.
  delete process.env.DSH_HOME
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'freecodego-preset-registry-'))
  directories.push(home)
  process.env.DSH_HOME = home
  return home
}

/** A roster service that records declarations, like the harness registry. */
function fakeRegistry(row: { readonly declared?: readonly string[]; readonly rejectIds?: readonly string[] } = {}) {
  const registered: AgentPresetDefinition[] = []
  const removed: string[] = []
  const service = {
    list: async (): Promise<readonly { readonly id: string }[]> => (row.declared ?? []).map(id => ({ id })),
    register: async (definition: AgentPresetDefinition): Promise<() => Promise<void>> => {
      if ((row.rejectIds ?? []).includes(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
      registered.push(definition)
      return async (): Promise<void> => { removed.push(definition.id) }
    },
  }
  return { service, registered, removed }
}

function contextWith(service: unknown): { get: (name: string) => unknown } {
  return { get: (name: string): unknown => (name === 'agentPresets' ? service : undefined) }
}

describe('FreeCodeGo agent presets on the harness registry', () => {
  it('declares both bundled presets through the composed registry', async () => {
    await freshHome()
    const registry = fakeRegistry()
    const install = installFreeCodeGoAgentPresets(contextWith(registry.service))
    await install.done

    expect(registry.registered.map(definition => definition.id)).toEqual(['freecodego', 'augmentcode'])
    const claude = registry.registered[0]!
    expect(claude.name).toBe('Claude 模式')
    expect(claude.order).toBe(5)
    expect(typeof claude.description).toBe('string')
    // The child rows are the bundled composition, not a placeholder.
    expect(claude.plugins.some(row => row.name === '@deepseek-ai/dsh-persona')).toBe(true)
    install.release()
  })

  it('resolves the bundled !!js platform rows instead of failing the parse', async () => {
    await freshHome()
    const registry = fakeRegistry()
    const install = installFreeCodeGoAgentPresets(contextWith(registry.service))
    await install.done

    // `disabled: !!js process.platform === 'win32'` is a boolean per platform;
    // an unparsed tag would have thrown and left the roster empty.
    const rows = registry.registered[0]!.plugins
    const disabled = rows.filter(row => typeof row.disabled === 'boolean')
    expect(disabled.length).toBeGreaterThan(0)
    expect(disabled.map(row => row.disabled)).toContain(process.platform === 'win32')
    install.release()
  })

  it('writes no roster directory when the registry is composed', async () => {
    const home = await freshHome()
    const registry = fakeRegistry()
    const install = installFreeCodeGoAgentPresets(contextWith(registry.service))
    await install.done

    // 0.1.7 scans no directory, so writing one would be dead weight the user
    // could mistake for the live roster.
    expect(existsSync(join(home, '.agent-presets'))).toBe(false)
    install.release()
  })

  it('leaves a preset the deployment already declares to the deployment', async () => {
    await freshHome()
    const registry = fakeRegistry({ declared: ['freecodego'] })
    const install = installFreeCodeGoAgentPresets(contextWith(registry.service))
    await install.done

    // The registry owns a declared id's composition; a second declaration throws.
    expect(registry.registered.map(definition => definition.id)).toEqual(['augmentcode'])
    install.release()
  })

  it('still installs the other preset when the registry rejects one', async () => {
    await freshHome()
    const registry = fakeRegistry({ rejectIds: ['freecodego'] })
    const install = installFreeCodeGoAgentPresets(contextWith(registry.service))
    await install.done

    expect(registry.registered.map(definition => definition.id)).toEqual(['augmentcode'])
    install.release()
  })

  it('releases every declaration it made', async () => {
    await freshHome()
    const registry = fakeRegistry()
    const install = installFreeCodeGoAgentPresets(contextWith(registry.service))
    await install.done
    install.release()

    expect(registry.removed).toEqual(['freecodego', 'augmentcode'])
  })

  it('hands the row straight back when release ran before registration settled', async () => {
    await freshHome()
    const registry = fakeRegistry()
    const install = installFreeCodeGoAgentPresets(contextWith(registry.service))
    // Unload races the in-flight install: no disposer exists to collect yet.
    install.release()
    await install.done

    expect(registry.removed).toEqual(['freecodego', 'augmentcode'])
  })

  it('decides the mechanism only after the Loader settles', async () => {
    await freshHome()
    const registry = fakeRegistry()
    let settled = false
    let registryVisibleWhenRead: boolean | undefined
    const ctx = {
      root: { loader: { await: async (): Promise<void> => { await Promise.resolve(); settled = true } } },
      get: (name: string): unknown => {
        if (name !== 'agentPresets') return undefined
        registryVisibleWhenRead = settled
        // The provider row activates after this plugin, so the service only
        // exists once the Loader has settled — reading earlier sees nothing.
        return settled ? registry.service : undefined
      },
    }
    const install = installFreeCodeGoAgentPresets(ctx)
    await install.done

    expect(registryVisibleWhenRead).toBe(true)
    expect(registry.registered.map(definition => definition.id)).toEqual(['freecodego', 'augmentcode'])
    install.release()
  })

  it('still installs when the Loader never settles', async () => {
    const home = await freshHome()
    const ctx = {
      root: { loader: { await: async (): Promise<void> => { throw new Error('settle failed') } } },
      get: (): unknown => undefined,
    }
    const install = installFreeCodeGoAgentPresets(ctx)
    await install.done

    expect(existsSync(join(home, '.agent-presets', 'freecodego', 'agent.cordis.yml'))).toBe(true)
    install.release()
  })

  it('falls back to the directory roster when no registry is composed', async () => {
    const home = await freshHome()
    const install = installFreeCodeGoAgentPresets(contextWith(undefined))
    await install.done

    expect(existsSync(join(home, '.agent-presets', 'freecodego', 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(home, '.agent-presets', 'augmentcode', 'agent.cordis.yml'))).toBe(true)
    install.release()
  })
})

describe('findUpstreamAgentPresets', () => {
  it('ignores a context with no service and a service missing the seam', () => {
    expect(findUpstreamAgentPresets(undefined)).toBeUndefined()
    expect(findUpstreamAgentPresets({})).toBeUndefined()
    expect(findUpstreamAgentPresets({ get: () => ({ list: async () => [] }) })).toBeUndefined()
  })

  it('ignores a lookup that throws while a realm tears down', () => {
    expect(findUpstreamAgentPresets({ get: () => { throw new Error('inactive context') } })).toBeUndefined()
  })

  it('returns the service when both members are present', () => {
    const registry = fakeRegistry()
    expect(findUpstreamAgentPresets(contextWith(registry.service))).toBe(registry.service)
  })
})
