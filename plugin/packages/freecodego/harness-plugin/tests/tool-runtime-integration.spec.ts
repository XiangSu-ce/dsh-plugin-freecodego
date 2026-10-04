/** Real Harness registration, discovery, validation, and scoped dispatch contracts. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it, vi } from 'vitest'

import { FreeCodeGoDesignRegistry } from '../src/design/registry.ts'
import { PLUGIN_TOOL_NAMES } from '../src/tool-manifest.ts'
import { registerShellAliasTools } from '../src/shell-alias.ts'
import { JSON_TOOL_OUTPUT } from '../src/tool-definition.ts'
import { readDocumentToolDefinition } from '../src/read-document.ts'
import { runtimeWorld as world } from './support/runtime-world.ts'

describe('deferred tools through Harness scopes and dispatch', () => {
  it('refuses an unfetched tool, then reveals and executes it only for the requesting agent', async () => {
    const w = await world()
    try {
      w.register('engineering_memory_search')
      const first = await w.create('first')
      const second = await w.create('second')
      expect(w.ctx.get('tools')!.schemas(first).map(tool => tool.name)).not.toContain('engineering_memory_search')
      expect(await w.call(first, 'engineering_memory_search')).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
      const fetched = await w.call(first, 'tool_search', { query: 'select:engineering_memory_search' })
      expect(fetched, JSON.stringify(fetched)).toMatchObject({ isError: false })
      expect(fetched.content).toEqual([expect.objectContaining({ text: expect.stringContaining('<function>') })])
      expect(await w.call(first, 'engineering_memory_search')).toMatchObject({ isError: false, value: { ok: true } })
      expect(await w.call(second, 'engineering_memory_search')).toMatchObject({ isError: true })
    } finally { await w.close() }
  })

  it('releases and restores live restrictions when the real policy setting changes', async () => {
    const w = await world({ deferredToolSchemasEnabled: true })
    try {
      w.register('engineering_memory_search')
      const agent = await w.create('live-toggle')
      expect(await w.call(agent, 'engineering_memory_search')).toMatchObject({ isError: true })
      await w.commit({ deferredToolSchemasEnabled: false })
      expect(w.deferred.status().enabled).toBe(false)
      expect(await w.call(agent, 'engineering_memory_search')).toMatchObject({ isError: false })
      await w.commit({ deferredToolSchemasEnabled: true })
      expect(await w.call(agent, 'engineering_memory_search')).toMatchObject({ isError: true })
      await w.call(agent, 'tool_search', { query: 'select:engineering_memory_search' })
      expect(await w.call(agent, 'engineering_memory_search')).toMatchObject({ isError: false })
    } finally { await w.close() }
  })

  it('tracks sessions created while deferral is off, so switching it on takes effect', async () => {
    const w = await world({ deferredToolSchemasEnabled: false })
    try {
      w.register('engineering_memory_search')
      const agent = await w.create('started-off')
      expect(await w.call(agent, 'engineering_memory_search')).toMatchObject({ isError: false })
      await w.commit({ deferredToolSchemasEnabled: true })
      expect(await w.call(agent, 'engineering_memory_search')).toMatchObject({ isError: true })
    } finally { await w.close() }
  })

  it('defers capabilities mounted after session creation and keeps fetched schemas stable', async () => {
    const w = await world()
    try {
      const agent = await w.create('late-mount')
      const remove = w.register('freecodego_design_craft')
      await Promise.resolve()
      expect(w.ctx.get('tools')!.schemas(agent).map(tool => tool.name)).not.toContain('freecodego_design_craft')
      expect(await w.call(agent, 'freecodego_design_craft')).toMatchObject({ isError: true })
      await w.call(agent, 'tool_search', { query: 'select:freecodego_design_craft' })
      expect(await w.call(agent, 'freecodego_design_craft')).toMatchObject({ isError: false })
      w.register('engineering_memory_search')
      await Promise.resolve()
      expect(await w.call(agent, 'freecodego_design_craft')).toMatchObject({ isError: false })
      expect(await w.call(agent, 'engineering_memory_search')).toMatchObject({ isError: true })
      remove()
      expect(await w.call(agent, 'freecodego_design_craft')).toMatchObject({ isError: true })
    } finally { await w.close() }
  })
})

describe('discovery branches and ownership through Harness', () => {
  it('validates every search response and keeps names-only listings unfetched', async () => {
    const w = await world()
    try {
      const agent = await w.create('search-branches')
      expect(await w.call(agent, 'tool_search')).toMatchObject({ isError: false, value: expect.stringContaining('No deferred tools') })
      w.register('engineering_memory_search')
      await Promise.resolve()
      for (const args of [{}, { query: 'list:all' }, { query: 'list:engineering_' }, { query: 'absent_xyz' }]) {
        expect(await w.call(agent, 'tool_search', args)).toMatchObject({ isError: false, value: expect.any(String) })
        expect(await w.call(agent, 'engineering_memory_search')).toMatchObject({ isError: true })
      }
      for (const query of ['memory', '+engineering_ memory', 'select:engineering_memory_search']) {
        expect(await w.call(agent, 'tool_search', { query })).toMatchObject({ isError: false, value: expect.stringContaining('<function>') })
      }
      expect(await w.call(agent, 'engineering_memory_search')).toMatchObject({ isError: false })
      for (const name of Array.from({ length: 21 }, (_, index) => `engineering_probe_${index}`)) w.register(name)
      await Promise.resolve()
      const selected = await w.call(agent, 'tool_search', { query: `select:${Array.from({ length: 21 }, (_, index) => `engineering_probe_${index}`).join(',')}` })
      expect(selected).toMatchObject({ isError: false })
      expect(String(selected.value).match(/<function>/gu)).toHaveLength(20)
      expect(await w.call(agent, 'engineering_probe_19')).toMatchObject({ isError: false })
      expect(await w.call(agent, 'engineering_probe_20')).toMatchObject({ isError: true })
      for (const args of [{ query: 42 }, { max_results: 0 }, { max_results: 21 }, { max_results: 1.5 }]) {
        const result = await w.call(agent, 'tool_search', args)
        expect(result, `${JSON.stringify(args)}: ${JSON.stringify(result)}`).toMatchObject({ isError: true })
      }
    } finally { await w.close() }
  })

  it('releases disposed agent scopes and never re-arms a disposed service', async () => {
    const w = await world()
    try {
      w.register('engineering_memory_search')
      const first = await w.create('disposed-first')
      const second = await w.create('disposed-second')
      expect(w.deferred.status().activeAgents).toBe(2)
      await w.release(first)
      expect(w.deferred.status().activeAgents).toBe(1)
      expect(await w.call(second, 'engineering_memory_search')).toMatchObject({ isError: true })
      w.deferred.dispose()
      w.deferred.dispose()
      w.register('engineering_probe_after_dispose')
      await w.commit({ deferredToolSchemasEnabled: true })
      await Promise.resolve()
      expect(w.deferred.status()).toMatchObject({ enabled: false, activeAgents: 0 })
      expect(await w.call(second, 'engineering_memory_search')).toMatchObject({ isError: false })
      expect(await w.call(second, 'engineering_probe_after_dispose')).toMatchObject({ isError: false })
    } finally { await w.close() }
  })
})

describe('design feature lifecycle through the real registry', () => {
  it('reveals, unmounts, and re-registers offline design tools for a live session', async () => {
    const settings: Record<string, unknown> = { designEnabled: true, designFeaturesEnabled: ['craft'] }
    const w = await world(settings)
    const design = new FreeCodeGoDesignRegistry(w.ctx, {
      get: () => settings,
      update: async (patch) => { Object.assign(settings, patch); await w.commit(patch as object) },
    })
    design.start()
    try {
      await design.setEnabled(true)
      const agent = await w.create('design-live-toggle')
      expect(await w.call(agent, 'freecodego_design_craft', { action: 'list' })).toMatchObject({ isError: true })
      expect(await w.call(agent, 'tool_search', { query: 'select:freecodego_design_craft' })).toMatchObject({ isError: false })
      expect(await w.call(agent, 'freecodego_design_craft', { action: 'list' })).toMatchObject({ isError: false })
      expect(await design.setEnabled(false)).toMatchObject({ designEnabled: false, registeredTools: [] })
      expect(await w.call(agent, 'freecodego_design_craft', { action: 'list' })).toMatchObject({ isError: true })
      await design.setEnabled(true)
      expect(await w.call(agent, 'tool_search', { query: 'select:freecodego_design_craft' })).toMatchObject({ isError: false })
      expect(await w.call(agent, 'freecodego_design_craft', { action: 'list' })).toMatchObject({ isError: false })
      await design.setFeatureEnabled('uiux-catalogue', true)
      expect(await w.call(agent, 'tool_search', { query: 'select:freecodego_uiux_search' })).toMatchObject({ isError: false })
      expect(await w.call(agent, 'freecodego_uiux_search', { query: 'accessible forms', domain: 'ux' })).toMatchObject({ isError: false })
      design.dispose()
      expect(await w.call(agent, 'freecodego_design_craft', { action: 'list' })).toMatchObject({ isError: true })
    } finally { design.dispose(); await w.close() }
  })
})

describe('the complete plugin on the real Harness tool registry', () => {
  it('registers and dispatches offline tools with model-readable outputs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-plugin-runtime-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    await promisify(execFile)('git', ['init', '--quiet', home], { windowsHide: true })
    const w = await world({
      engineeringEnabled: true, engineeringMemoryEnabled: true, engineeringSkillsEnabled: false,
      engineeringCodeGraphEnabled: true, engineeringQualityEnabled: true,
      designEnabled: true, designFeaturesEnabled: ['craft', 'uiux-catalogue'],
      advisorProvider: 'opencode', advisorModel: 'auto',
    }, true)
    try {
      await expect.poll(() => w.ctx.get('tools')!.schemas().map(tool => tool.name)).toContain('engineering_status')
      const agent = await w.create('full-plugin', home)
      expect(w.ctx.get('tools')!.schemas().map(tool => tool.name)).toEqual(expect.arrayContaining([
        'tool_search', 'read_document', 'engineering_status', 'engineering_plan_mode', 'engineering_inspect',
        'engineering_context_prompt', 'freecodego_design_craft', 'freecodego_uiux_search', 'freecodego_companion_face',
      ]))
      const mounted = w.ctx.get('tools')!.schemas().map(tool => tool.name)
      expect(mounted).not.toContain('inspect') // /inspect belongs to commands, not tools.
      expect(mounted.filter(name => !PLUGIN_TOOL_NAMES.includes(name))).toEqual([])
      const cases: readonly [string, object][] = [
        ['engineering_status', {}],
        ['engineering_doctor', {}],
        ['engineering_repo_map', {}],
        ['engineering_memory_search', { query: 'audit' }],
        ['engineering_memory_get', { ids: [] }],
        ['engineering_memory_export', {}],
        ['engineering_checkpoint_list', {}],
        ['engineering_hunks', {}],
        ['engineering_persona_list', {}],
        ['engineering_persona_list', { json: true }],
        ['engineering_worktree_status', {}],
        ['engineering_worktree_list', {}],
        ['engineering_review_rules', {}],
        ['engineering_review_status', {}],
        ['engineering_review_report', {}],
        ['engineering_team_report', {}],
        ['freecodego_schedule_plan', { cron: '0 9 * * *', count: 2 }],
        ['freecodego_recovery_status', {}],
        ['engineering_context_budget', {}],
        ['engineering_context_compact', {}],
        ['engineering_context_snip', {}],
        ['engineering_plan_mode', { action: 'status' }],
        ['engineering_inspect', { json: true }],
        ['engineering_inspect', {}],
        ['engineering_surface_report', {}],
        ['engineering_context_prompt', {}],
        ['freecodego_companion_face', { face: 'happy' }],
        ['freecodego_design_craft', { action: 'list' }],
        ['freecodego_design_craft', { action: 'get', sections: ['accessibility-baseline'] }],
        ['freecodego_design_craft', { action: 'resolve', requires: ['accessibility-baseline'] }],
        ['freecodego_uiux_search', { query: 'accessible forms', domain: 'ux' }],
      ]
      for (const [name, args] of cases) {
        const fetch = await w.call(agent, 'tool_search', { query: `select:${name}` })
        expect(fetch, `${name} discovery: ${JSON.stringify(fetch)}`).toMatchObject({ isError: false })
        const result = await w.call(agent, name, args)
        expect(result, `${name}: ${JSON.stringify(result)}`).toMatchObject({ isError: false })
        expect(result.content, name).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.any(String) })]))
        if (name === 'freecodego_design_craft' && 'action' in args) {
          if (args.action === 'list') expect(result.value).toMatchObject({ kind: 'catalogue', sections: expect.any(Array) })
          if (args.action === 'get') expect(result.value).toMatchObject({ kind: 'sections', sections: [expect.objectContaining({ slug: 'accessibility-baseline', text: expect.any(String) })] })
          if (args.action === 'resolve') expect(result.value).toMatchObject({ kind: 'plan', load: [expect.objectContaining({ slug: 'accessibility-baseline' })], misses: [] })
        }
        if (name === 'freecodego_uiux_search') expect(result.value).toMatchObject({ kind: 'searched', selection: { kind: 'domain', domain: 'ux' } })
        if (name === 'freecodego_companion_face') expect(result.value).toMatchObject({ kind: 'face', face: 'happy' })
      }
    } finally {
      await w.close()
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('persona delegation through an uninjected Agent scope', () => {
  it('finds the real scoped agent service and sends the child its persona brief', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-persona-runtime-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    await mkdir(join(home, 'personas'))
    await writeFile(join(home, 'personas', 'audit-reader.toml'), 'instructions = "Only review the supplied task."\n')
    const w = await world({ engineeringEnabled: false, advisorProvider: 'opencode', advisorModel: 'auto' }, true)
    try {
      w.ctx.get('tools')!.register({ name: 'skill', description: 'Host skill fixture', parameters: { type: 'object', properties: {} }, output: JSON_TOOL_OUTPUT, execute: async () => ({ ok: true }) })
      const parent = await w.create('persona-parent', home)
      expect(w.ctx.get('tools')!.schemas(parent).map(tool => tool.name)).not.toContain('skill')
      const child = await w.create('persona-child', home)
      const followup = vi.spyOn(child, 'followup').mockImplementation(() => undefined)
      const create = vi.spyOn(w.ctx.get('agents')!, 'create').mockResolvedValue({ agent: child, dispose: async () => undefined })
      expect(await w.call(parent, 'tool_search', { query: 'select:engineering_subagent_start' })).toMatchObject({ isError: false })
      const result = await w.call(parent, 'engineering_subagent_start', { persona: 'audit-reader', task: 'Report the public interfaces.' })
      expect(result, JSON.stringify(result)).toMatchObject({ isError: false, value: { persona: 'audit-reader', cwd: home } })
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ cwd: home, parentSession: 'persona-parent' }) }))
      expect(followup).toHaveBeenCalledWith(expect.objectContaining({
        content: [expect.objectContaining({ text: expect.stringContaining('Only review the supplied task.') })],
      }))
    } finally {
      vi.restoreAllMocks()
      await w.close()
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('read_document through the session runtime', () => {
  it('resolves the same relative notebook in each session workspace, not the Host launch directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-runtime-doc-'))
    const w = await world()
    try {
      w.ctx.get('tools')!.register(readDocumentToolDefinition())
      const path = join(directory, 'audit-relative.ipynb')
      await writeFile(path, JSON.stringify({ cells: [{ cell_type: 'code', source: 'session_only = 42' }], metadata: {} }))
      const agent = await w.create('document-session', directory)
      const result = await w.call(agent, 'read_document', { file_path: 'audit-relative.ipynb' })
      expect(result, JSON.stringify(result)).toMatchObject({
        isError: false, value: { path: await realpath(path), kind: 'notebook', lines: expect.arrayContaining(['session_only = 42']) },
      })
      expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('session_only = 42') })])
      const other = await w.create('other-document-session', tmpdir())
      expect(await w.call(other, 'read_document', { file_path: 'audit-relative.ipynb' })).toMatchObject({ isError: true })
      expect(await w.call(other, 'read_document', { file_path: path })).toMatchObject({ isError: false })
      expect(await w.call(agent, 'read_document', { file_path: '.ssh/id_ed25519' })).toMatchObject({ isError: true })
    } finally {
      await w.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('shell aliases through Harness argument validation', () => {
  it('accepts either advertised command spelling and retains nested policy checks', async () => {
    const w = await world()
    try {
      const calls: string[] = []
      w.ctx.get('tools')!.register({
        name: 'pwsh', description: 'Host shell fixture',
        parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } },
        output: JSON_TOOL_OUTPUT,
        execute: async (args) => { const command = (args as { command: string }).command; calls.push(command); return { command } },
      })
      registerShellAliasTools({ ctx: w.ctx, registry: w.ctx.get('tools')! })
      const agent = await w.create('aliases')
      for (const name of ['shell', 'bash']) {
        for (const args of [{ cmd: 'git status' }, { command: 'git status' }]) {
          expect(await w.call(agent, name, args), `${name} ${JSON.stringify(args)}`).toMatchObject({ isError: false })
        }
        expect(await w.call(agent, name, {})).toMatchObject({ isError: true })
      }
      expect(calls).toEqual(Array.from({ length: 4 }, () => 'git status'))
      const stop = w.ctx.get('tools')!.guard(exec => exec.name === 'pwsh' ? 'test policy refusal' : undefined)
      expect(await w.call(agent, 'shell', { command: 'git status' })).toMatchObject({ isError: true })
      expect(calls).toHaveLength(4)
      stop()
    } finally { await w.close() }
  })
})
