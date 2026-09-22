import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { installFreeCodeGoPluginConflictGuard, scanPluginResourceClaims } from '../src/plugin-conflicts.ts'
import { provideHostService } from './support/host-services.ts'

const startedKey = '__freecodegoPluginConflictStarts'

/** The labels the fixture plugins recorded, read back off `globalThis`. */
const startedInvocations = (): readonly string[] | undefined =>
  (globalThis as typeof globalThis & { [startedKey]?: string[] })[startedKey]

afterEach(() => {
  // The fixture's global is removed in place: there is no record to rebuild,
  // and leaving it behind would leak into the next spec file.
  // oxlint-disable-next-line no-dynamic-delete
  delete (globalThis as typeof globalThis & { [startedKey]?: string[] })[startedKey]
})

describe('FreeCodeGoPluginConflictGuard', () => {
  it('recognizes the exclusive resource registrations supported by the preflight scan', () => {
    const source = [
      "ctx.tools.register({ name: 'workspace.read' })",
      "ctx.commands.register({ name: 'workspace.open' })",
      "ctx.settings.register('workspace-plugin', SettingsSchema)",
      "ctx.webServer.register({ path: '/workspace' })",
      "ctx.llm.registerAdapter(['workspace-provider'], adapter)",
      "ctx.slots.register({ name: 'sidebar.footer.action', id: 'workspace-action' }, Component)",
    ].join('\n')

    expect(scanPluginResourceClaims(source)).toEqual(expect.arrayContaining([
      { resource: 'tool', resourceName: 'workspace.read' },
      { resource: 'command', resourceName: 'workspace.open' },
      { resource: 'settings', resourceName: 'workspace-plugin' },
      { resource: 'route', resourceName: '/workspace' },
      { resource: 'provider', resourceName: 'workspace-provider' },
      { resource: 'slot', resourceName: 'sidebar.footer.action:workspace-action' },
    ]))
  })

  it('disables a later duplicate entry before its plugin code starts and persists the repair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-plugin-conflict-'))
    const first = join(directory, 'first.mjs')
    const second = join(directory, 'second.mjs')
    const firstResource = join(directory, 'first-resource.mjs')
    const secondResource = join(directory, 'second-resource.mjs')
    const pluginSource = (label: string): string => [
      `import { claim } from './${label}-resource.mjs'`,
      'export function apply(ctx) {',
      `  globalThis.${startedKey} = [...(globalThis.${startedKey} ?? []), '${label}']`,
      '  claim(ctx)',
      '}',
      '',
    ].join('\n')
    const resourceSource = "export function claim(ctx) { ctx.tools.register({ name: 'duplicate-tool' }) }\n"
    await writeFile(first, pluginSource('first'))
    await writeFile(second, pluginSource('second'))
    await writeFile(firstResource, resourceSource)
    await writeFile(secondResource, resourceSource)

    const ctx = new Context()
    let stored: { pluginConflictProtectionEnabled: boolean; pluginConflictRecords: readonly unknown[] } = {
      pluginConflictProtectionEnabled: true,
      pluginConflictRecords: [],
    }
    const settings = {
      get: () => stored,
      update: async (patch: Partial<typeof stored>) => { stored = { ...stored, ...patch } },
    }
    provideHostService(ctx, 'tools', { register: () => () => undefined })
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(directory, 'loader.mjs')).href })
    installFreeCodeGoPluginConflictGuard(ctx, settings as never)

    try {
      await ctx.loader.root.update([
        { id: 'first', name: './first.mjs' },
        { id: 'second', name: './second.mjs' },
      ])
      await ctx.loader.await()

      expect(startedInvocations()).toEqual(['first'])
      const secondEntry = [...ctx.loader.entries()].find(entry => entry.id === 'second')
      expect(secondEntry?.disabled).toBe(true)
      expect(secondEntry?.fiber).toBeUndefined()
      // The start path really was intercepted, which is the other half of the
      // override and the probe the default case below reads in the negative.
      expect(Object.hasOwn(secondEntry as object, 'init')).toBe(true)
      expect(stored.pluginConflictRecords).toEqual([expect.objectContaining({
        resource: 'tool',
        resourceName: 'duplicate-tool',
        disabledEntryId: 'second',
        disabledModuleName: './second.mjs',
        keptEntryId: 'first',
        keptModuleName: './first.mjs',
      })])
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('leaves a duplicate entry to the Harness when nothing asked for the override', async () => {
    // The default: no settings file and no settings port, which is what a fresh
    // profile looks like. The second plugin starts, keeps its own fiber, and the
    // duplicate name is the Harness's own registry's business — its error names
    // the resource, and a refused `init()` fails that one entry. The guard must
    // also not have read either package: interception is what the switch turns on,
    // so a default deployment does not get this plugin watching every entry.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-plugin-conflict-default-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = directory
    const first = join(directory, 'first.mjs')
    const second = join(directory, 'second.mjs')
    const pluginSource = (label: string): string => [
      'export function apply(ctx) {',
      `  globalThis.${startedKey} = [...(globalThis.${startedKey} ?? []), '${label}']`,
      "  ctx.tools.register({ name: 'duplicate-tool' })",
      '}',
      '',
    ].join('\n')
    await writeFile(first, pluginSource('first'))
    await writeFile(second, pluginSource('second'))

    const ctx = new Context()
    provideHostService(ctx, 'tools', { register: () => () => undefined })
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(directory, 'loader.mjs')).href })
    const guard = installFreeCodeGoPluginConflictGuard(ctx)

    try {
      await ctx.loader.create({ name: './first.mjs' })
      await ctx.loader.create({ name: './second.mjs' })
      await ctx.loader.await()

      expect(startedInvocations()).toEqual(['first', 'second'])
      expect(guard.snapshot().pluginConflictProtectionEnabled).toBe(false)
      expect(guard.snapshot().pluginConflictRecords).toEqual([])
      // Both plugins really ran (the invocation list above), and neither was
      // disabled by this plugin: the duplicate is the Harness's to report.
      const entries = [...ctx.loader.entries()]
      const secondEntry = entries.find(entry => entry.id === 'second' || (entry.options as { name?: string }).name === './second.mjs')
      expect(secondEntry, `entries: ${entries.map(entry => entry.id).join(', ')}`).toBeDefined()
      expect(secondEntry?.disabled).not.toBe(true)
      expect(Object.hasOwn(secondEntry as object, 'init')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('allows duplicate entries when the user disables automatic repair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-plugin-conflict-disabled-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = directory
    const first = join(directory, 'first.mjs')
    const second = join(directory, 'second.mjs')
    const pluginSource = (label: string): string => [
      'export function apply(ctx) {',
      `  globalThis.${startedKey} = [...(globalThis.${startedKey} ?? []), '${label}']`,
      "  ctx.tools.register({ name: 'duplicate-tool' })",
      '}',
      '',
    ].join('\n')
    await writeFile(first, pluginSource('first'))
    await writeFile(second, pluginSource('second'))
    await writeFile(join(directory, 'settings.yaml'), 'freecodego-harness:\n  pluginConflictProtectionEnabled: false\n')

    const ctx = new Context()
    provideHostService(ctx, 'tools', { register: () => () => undefined })
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(directory, 'loader.mjs')).href })
    const guard = installFreeCodeGoPluginConflictGuard(ctx)

    try {
      // `create` takes `Omit<EntryOptions, 'id'>` — the tree derives the id from
      // the module name, so passing one only ever looked like it was honored.
      await ctx.loader.create({ name: './first.mjs' })
      await ctx.loader.create({ name: './second.mjs' })
      await ctx.loader.await()

      expect(startedInvocations()).toEqual(['first', 'second'])
      expect(guard.snapshot().pluginConflictRecords).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stops its own stand-in instead of the official module that claims the same tool', async () => {
    // The vendored team pair exists for a composition that never selected the
    // official team bundles. When both are mounted — which is what a live bundle
    // change produces, because the stand-down expression reads the launch-time
    // bundle list — the official plugin is the one the deployment asked for, so
    // the fallback is what has to go. Disabling the official one inverts the
    // deployment's intent and reports the Harness as the loser.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-plugin-conflict-official-'))
    const fallback = join(directory, 'fallback.mjs')
    const official = join(directory, 'node_modules', '@deepseek-ai', 'dsh-experimental-tool-agent-team')
    await mkdir(official, { recursive: true })
    const pluginSource = (label: string): string => [
      'export function apply(ctx) {',
      `  globalThis.${startedKey} = [...(globalThis.${startedKey} ?? []), '${label}']`,
      "  ctx.tools.register({ name: 'spawn_teammate' })",
      '}',
      '',
    ].join('\n')
    await writeFile(fallback, pluginSource('fallback'))
    await writeFile(join(official, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-experimental-tool-agent-team', version: '0.0.0', type: 'module', main: 'index.mjs',
    }))
    await writeFile(join(official, 'index.mjs'), pluginSource('official'))

    const ctx = new Context()
    let stored: { pluginConflictProtectionEnabled: boolean; pluginConflictRecords: readonly unknown[] } = {
      pluginConflictProtectionEnabled: true,
      pluginConflictRecords: [],
    }
    const settings = {
      get: () => stored,
      update: async (patch: Partial<typeof stored>) => { stored = { ...stored, ...patch } },
    }
    provideHostService(ctx, 'tools', { register: () => () => undefined })
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(directory, 'loader.mjs')).href })
    const guard = installFreeCodeGoPluginConflictGuard(ctx, settings as never)

    try {
      await ctx.loader.root.update([
        { id: 'freecodego-tool-agent-team', name: './fallback.mjs' },
        { id: 'tool-agent-team', name: '@deepseek-ai/dsh-experimental-tool-agent-team' },
      ])
      await ctx.loader.await()

      // Both apply calls ran: the fallback had already mounted by the time the
      // official entry started, which is exactly the ordering this rule exists for.
      expect(startedInvocations()?.join(',')).toBe('fallback,official')
      const fallbackEntry = [...ctx.loader.entries()].find(entry => entry.id === 'freecodego-tool-agent-team')
      expect(fallbackEntry?.disabled === true).toBe(true)
      // The Loader's enablement path unloads the running fallback without
      // clearing the fiber reference, so `uid: null` is its "no longer serving"
      // signal — the same one `seed()` reads.
      expect(fallbackEntry?.fiber === undefined || fallbackEntry.fiber.uid === null).toBe(true)
      const officialEntry = [...ctx.loader.entries()].find(entry => entry.id === 'tool-agent-team')
      expect(officialEntry?.fiber !== undefined && officialEntry.fiber.uid !== null).toBe(true)

      const snapshot = guard.snapshot()
      expect(snapshot.pluginConflictRecords.length).toBe(1)
      expect(JSON.stringify({ ...snapshot.pluginConflictRecords[0], id: undefined, detectedAt: undefined })).toBe(JSON.stringify({
        id: undefined,
        detectedAt: undefined,
        resource: 'tool',
        resourceName: 'spawn_teammate',
        disabledEntryId: 'freecodego-tool-agent-team',
        disabledModuleName: './fallback.mjs',
        keptEntryId: 'tool-agent-team',
        keptModuleName: '@deepseek-ai/dsh-experimental-tool-agent-team',
        yieldedToOfficial: true,
      }))
      // Stopped fallback plus running official is the state the record describes,
      // so it reports as in effect rather than as history.
      expect(snapshot.pluginConflictActiveRecords).toEqual([snapshot.pluginConflictRecords[0]?.id])
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('separates a live repair from stored history in one snapshot', async () => {
    // The store keeps every repair it ever wrote. A record whose stopped entry is
    // running again describes a state the Harness has since left, and the panel
    // reads that as "the official plugin lost" when the tree says it won.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-plugin-conflict-history-'))
    const first = join(directory, 'first.mjs')
    const second = join(directory, 'second.mjs')
    const pluginSource = (label: string): string => [
      'export function apply(ctx) {',
      `  globalThis.${startedKey} = [...(globalThis.${startedKey} ?? []), '${label}']`,
      "  ctx.tools.register({ name: 'duplicate-tool' })",
      '}',
      '',
    ].join('\n')
    await writeFile(first, pluginSource('first'))
    await writeFile(second, pluginSource('second'))

    const ctx = new Context()
    let stored: { pluginConflictProtectionEnabled: boolean; pluginConflictRecords: readonly unknown[] } = {
      pluginConflictProtectionEnabled: true,
      pluginConflictRecords: [{
        id: 'history-1',
        detectedAt: 1,
        resource: 'tool',
        resourceName: 'duplicate-tool',
        disabledEntryId: 'first',
        disabledModuleName: './first.mjs',
        keptEntryId: 'second',
        keptModuleName: './second.mjs',
      }],
    }
    const settings = {
      get: () => stored,
      update: async (patch: Partial<typeof stored>) => { stored = { ...stored, ...patch } },
    }
    provideHostService(ctx, 'tools', { register: () => () => undefined })
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(directory, 'loader.mjs')).href })
    const guard = installFreeCodeGoPluginConflictGuard(ctx, settings as never)

    try {
      await ctx.loader.root.update([
        { id: 'first', name: './first.mjs' },
        { id: 'second', name: './second.mjs' },
      ])
      await ctx.loader.await()

      const snapshot = guard.snapshot()
      // History is kept, and this boot's own repair is appended beside it.
      expect(snapshot.pluginConflictRecords.map(record => record.id)).toEqual(['history-1', expect.any(String)])
      const live = snapshot.pluginConflictRecords.find(record => record.id !== 'history-1')
      // `first` is running, so the old record's claim that it was stopped is stale.
      expect(snapshot.pluginConflictActiveRecords).toEqual([live?.id])
      expect(snapshot.pluginConflictActiveRecords).not.toContain('history-1')
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
