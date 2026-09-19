import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
})
