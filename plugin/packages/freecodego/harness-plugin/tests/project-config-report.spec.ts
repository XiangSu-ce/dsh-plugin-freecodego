/**
 * The project tier of configuration, as the settings surface reports it.
 *
 * `src/project-config.ts` was written, documented, unit-tested — and never read
 * by anything. A repository could declare its own `mcpServers` or `skillRoots`
 * in `.freecodego/config.json` and no code path opened the file, which is the
 * defect class this suite exists to pin: the tier's own header names the settings
 * surface as its consumer, and there was no such caller.
 *
 * Two properties are asserted here rather than in `project-config.spec.ts`,
 * because they are properties of the *wiring* and not of the parser:
 *
 * 1. **The gate is asked before the file is opened.** The case proves it with an
 *    unparseable document: an untrusted read answers `skipped`, not
 *    `not valid JSON`, which is only possible if nothing read the bytes.
 * 2. **The report is cached, and the cache expires.** A surface that re-read on
 *    every render would make a slow disk a per-render cost; one that cached
 *    forever would show a repository author the `ignored` list they just fixed.
 *
 * Each case is a mutation probe: unwire the Remote, drop the gate, drop the
 * `ignored` list, or drop the TTL, and the matching case fails.
 */

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { provideHostService, provideHostServiceAs, registrationHandle, sessionAt, settingsValue, type AgentEnginesFace, type CommandsFace } from './support/host-services.ts'
import { PROJECT_CONFIG_RELATIVE_PATH, PROJECT_CONFIG_WHITELIST } from '../src/project-config.ts'
import { FOLDER_TRUST_ENV } from '../src/trust.ts'

const CWD = '/workspace'

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

interface ReportHarness {
  readonly plugin: FreeCodeGoHarnessPlugin
  /** The workspace the repository is built in. */
  readonly workspace: string
  /** Write the repository's project tier. */
  readonly writeProjectConfig: (text: string) => Promise<void>
  readonly dispose: () => Promise<void>
}

/**
 * The real plugin, booted against a throwaway home and a throwaway repository.
 *
 * The home is what makes the trust answer deterministic: the grant record lives
 * under `DSH_HOME`, so an isolated one starts with no entries and the gate
 * answers `no-record` — which is the untrusted branch, without the test having
 * to write a record to get there.
 */
async function reportHarness(): Promise<ReportHarness> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'freecodego-projectcfg-home-')))
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'freecodego-projectcfg-repo-')))
  const previousHome = process.env.DSH_HOME
  const previousTrust = process.env[FOLDER_TRUST_ENV]
  process.env.DSH_HOME = home
  delete process.env[FOLDER_TRUST_ENV]
  execFileSync('git', ['init', '--quiet', workspace], { stdio: 'ignore' })
  const ctx = new Context()
  await ctx.plugin((scope: Context) => {
    provideHostService(scope, 'agents', { list: () => [], get: () => undefined })
    provideHostServiceAs<AgentEnginesFace>(scope, 'agentEngines', { setAvailability: () => undefined })
    provideHostService(scope, 'sessions', { get: () => sessionAt(CWD), list: () => [] })
    provideHostService(scope, 'settings', {
      register: () => ({
        get: () => settingsValue({ engineeringEnabled: true, engineeringMemoryEnabled: true, advisorProvider: 'opencode', advisorModel: 'auto' }),
        watch: () => () => undefined,
        update: async () => undefined,
        replace: async () => undefined,
      }),
    })
    provideHostService(scope, 'llm', {
      registerAdapter: () => registrationHandle(),
      stream(_generation: GenerateOptions): AsyncIterable<StreamChunk> {
        return (async function* empty(): AsyncGenerator<StreamChunk> { /* the boot makes no request */ })()
      },
    })
    provideHostService(scope, 'tools', { register: () => () => undefined, guard: () => () => undefined, schemas: () => [] })
    provideHostServiceAs<CommandsFace>(scope, 'commands', { register: () => () => undefined })
    provideHostService(scope, 'systemPrompt', { section: () => () => undefined })
  })
  const plugin = new FreeCodeGoHarnessPlugin(ctx, {})
  return {
    plugin,
    workspace,
    writeProjectConfig: async (text) => {
      await mkdir(join(workspace, '.freecodego'), { recursive: true })
      await writeFile(join(workspace, PROJECT_CONFIG_RELATIVE_PATH), text, 'utf8')
    },
    dispose: async () => {
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
      // Retried rather than raced. The plugin seeds its trust record and reads
      // its managed policy on fire-and-forget writes that its disposal does not
      // await, so for a moment after `fiber.dispose()` the home is still being
      // written — and on Windows a single `rm` over that sees ENOTEMPTY or
      // EBUSY. The writes are a few hundred bytes; retrying is the whole fix.
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
      rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousTrust === undefined) delete process.env[FOLDER_TRUST_ENV]
      else process.env[FOLDER_TRUST_ENV] = previousTrust
    },
  }
}

describe('the project tier reaches the settings surface', () => {
  let harness: ReportHarness | undefined
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  it.skipIf(!gitAvailable)('answers the gate before it opens the file, and names the gate when it refuses', async () => {
    harness = await reportHarness()
    // Deliberately unparseable. An untrusted read must never reach the parser, so
    // the note has to be the gate's refusal and not `is not valid JSON` — that
    // difference is the only observable proof that the bytes were never read, and
    // the whole point of resolving trust first.
    await harness.writeProjectConfig('{ this is not json')
    const report = await harness.plugin.projectConfigReport(harness.workspace)
    expect(report.trusted).toBe(false)
    expect(report.trustReason).toBe('no-record')
    expect(report.note).toContain('project configuration skipped')
    expect(report.note).not.toContain('not valid JSON')
    expect(report.accepted).toEqual({})
    expect(report.ignored).toEqual([])
  })

  it.skipIf(!gitAvailable)('reports the accepted keys and names every key the tier does not accept', async () => {
    harness = await reportHarness()
    // The gate is switched off rather than granted, so the accepted branch is
    // reachable without the test having to write a grant record — and it exercises
    // the same `resolveFolderTrust` path the granted branch does.
    process.env[FOLDER_TRUST_ENV] = '0'
    await harness.writeProjectConfig(JSON.stringify({
      mcpServers: [{ id: 'staging', serverName: 'staging', command: 'node', args: ['serve.js'], cwd: '', enabled: true }],
      skillRoots: [{ id: 'repo', path: '.claude/skills', enabled: true }],
      // Outside the whitelist, and reported rather than dropped: an author who
      // wrote it in good faith has to be told why nothing happened, or they
      // conclude the whole tier is broken.
      defaultModel: 'gpt-5.6',
      permissions: ['Bash(rm:*)'],
    }))
    const report = await harness.plugin.projectConfigReport(harness.workspace)
    expect(report.trusted).toBe(true)
    expect(report.trustReason).toBe('global-disabled')
    expect(Object.keys(report.accepted).sort()).toEqual(['mcpServers', 'skillRoots'])
    expect(report.ignored).toEqual(['defaultModel', 'permissions'])
    expect(report.note).toBeUndefined()
  })

  it.skipIf(!gitAvailable)('never lets a key outside the whitelist reach the accepted set', async () => {
    harness = await reportHarness()
    process.env[FOLDER_TRUST_ENV] = '0'
    // The hazard the whitelist exists for: a cloned repository choosing the
    // user's model or widening its own permissions. Every key here is one the
    // module's header names as unsafe to accept from a checkout.
    const dangerous = ['defaultModel', 'advisorModel', 'folderTrustEnabled', 'envReadGuardEnabled', 'mcpEnabled', 'skillEnabled']
    await harness.writeProjectConfig(JSON.stringify(Object.fromEntries(dangerous.map(key => [key, 'whatever']))))
    const report = await harness.plugin.projectConfigReport(harness.workspace)
    expect(report.accepted).toEqual({})
    expect(report.ignored).toEqual(dangerous)
    expect(Object.keys(report.accepted).every(key => (PROJECT_CONFIG_WHITELIST as readonly string[]).includes(key))).toBe(true)
  })

  it.skipIf(!gitAvailable)('reports a malformed document as a note instead of failing the surface', async () => {
    harness = await reportHarness()
    process.env[FOLDER_TRUST_ENV] = '0'
    await harness.writeProjectConfig('{ "mcpServers": [,] }')
    const report = await harness.plugin.projectConfigReport(harness.workspace)
    expect(report.note).toContain('is not valid JSON')
    expect(report.accepted).toEqual({})
  })

  it.skipIf(!gitAvailable)('serves a cached report, and re-reads once the window has passed', async () => {
    harness = await reportHarness()
    process.env[FOLDER_TRUST_ENV] = '0'
    await harness.writeProjectConfig(JSON.stringify({ skillRoots: [{ id: 'first', path: 'a', enabled: true }] }))
    const first = await harness.plugin.projectConfigReport(harness.workspace)
    expect(Object.keys(first.accepted)).toEqual(['skillRoots'])
    // The author fixes the file and re-opens the surface. A re-read per render
    // would make a slow disk a per-render cost, so the second call is served
    // from the cache...
    await harness.writeProjectConfig(JSON.stringify({ mcpServers: [{ id: 'second' }] }))
    const cached = await harness.plugin.projectConfigReport(harness.workspace)
    expect(Object.keys(cached.accepted)).toEqual(['skillRoots'])
    // ...and only after the window does the correction become visible, which is
    // the half that keeps the cache from being a permanent wrong answer.
    const clock = vi.spyOn(Date, 'now')
    const base = Date.now()
    clock.mockReturnValue(base + 6_000)
    const refreshed = await harness.plugin.projectConfigReport(harness.workspace)
    expect(Object.keys(refreshed.accepted)).toEqual(['mcpServers'])
  })
})
