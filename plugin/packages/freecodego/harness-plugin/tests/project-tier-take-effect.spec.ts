/**
 * The project tier, taking effect.
 *
 * What these cases protect
 * ------------------------
 * `project-config.spec.ts` proves the parser and `project-config-report.spec.ts`
 * proves the settings surface. Neither would notice the failure this suite exists
 * for: a repository declaring a hook or a command rule in `.freecodego/config.json`
 * and **nothing consuming it**. The keys were accepted, reported, and inert.
 *
 * Three wirings are asserted here, each at the seam that was actually missing:
 *
 * 1. **`hooks` reaches hook dispatch.** Read through the same private
 *    `hookDocumentsFor` the runtime calls, then through the real
 *    `collectHookHandlers` / `selectHookHandlers` — so the assertion is about the
 *    document set a `PreToolUse` dispatch would really see, not about a field.
 * 2. **`permissionRules` reach the synchronous guard lookup.** The guard runs on
 *    the pre-execute path and cannot read a file, so the compiled policy is filed
 *    when the tier is read; the case proves the lookup the guard performs finds it.
 * 3. **A trust transition takes effect at once.** Granting must make a
 *    repository's rules live before the next tool call, and the case proves it by
 *    looking the policy up immediately after the grant returns.
 */

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'

import type { CompiledCommandPolicy } from '../src/command-policy.ts'
import { collectHookHandlers, selectHookHandlers, type HookDocument } from '../src/hooks/surface.ts'
import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { provideHostService, provideHostServiceAs, registrationHandle, sessionAt, settingsValue, type AgentEnginesFace, type CommandsFace } from './support/host-services.ts'
import { PROJECT_CONFIG_RELATIVE_PATH } from '../src/project-config.ts'
import { projectCommandPolicyDenial } from '../src/tool-guards.ts'
import { FOLDER_TRUST_ENV } from '../src/trust.ts'
import type { ProjectTier } from '../src/project-tier.ts'

const CWD = '/workspace'

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** The private seams this suite has to reach, named in one place. */
interface PluginInternals {
  readonly hookDocumentsFor: (workspaceRoot?: string) => Promise<readonly HookDocument[]>
  readonly projectTierFor: (workspaceRoot?: string) => Promise<ProjectTier>
  readonly projectPolicyForAgent: (agent: unknown) => CompiledCommandPolicy | undefined
}

interface TierHarness {
  readonly plugin: FreeCodeGoHarnessPlugin
  readonly workspace: string
  readonly internals: PluginInternals
  readonly writeProjectConfig: (text: string) => Promise<void>
  readonly dispose: () => Promise<void>
}

/**
 * The real plugin, booted against a throwaway home and a throwaway repository.
 *
 * `folderTrustEnabled` is a parameter because the two halves of the tier need
 * opposite setups: the "it works" cases want the gate out of the way
 * (`FOLDER_TRUST_ENV=0` answers `global-disabled`, which is trusted), and the
 * trust-transition case needs the gate *on* so a grant is a real change of state.
 */
async function tierHarness(options: { readonly folderTrustEnabled?: boolean } = {}): Promise<TierHarness> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'freecodego-projecttier-home-')))
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'freecodego-projecttier-repo-')))
  const previousHome = process.env.DSH_HOME
  const previousTrust = process.env[FOLDER_TRUST_ENV]
  process.env.DSH_HOME = home
  delete process.env[FOLDER_TRUST_ENV]
  execFileSync('git', ['init', '--quiet', workspace], { stdio: 'ignore' })
  const settings = {
    engineeringEnabled: false,
    engineeringMemoryEnabled: false,
    advisorProvider: 'opencode',
    advisorModel: 'auto',
    mcpEnabled: false,
    skillEnabled: false,
    ...options.folderTrustEnabled === true ? { folderTrustEnabled: true } : {},
  }
  const ctx = new Context()
  await ctx.plugin((scope: Context) => {
    provideHostService(scope, 'agents', { list: () => [], get: () => undefined })
    provideHostServiceAs<AgentEnginesFace>(scope, 'agentEngines', { setAvailability: () => undefined })
    provideHostService(scope, 'sessions', { get: () => sessionAt(CWD), list: () => [] })
    provideHostService(scope, 'settings', { register: () => ({ get: () => settingsValue(settings), watch: () => () => undefined, update: async () => undefined, replace: async () => undefined }) })
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
  const internals = plugin as unknown as PluginInternals
  return {
    plugin,
    workspace,
    internals,
    writeProjectConfig: async (text) => {
      await mkdir(join(workspace, '.freecodego'), { recursive: true })
      await writeFile(join(workspace, PROJECT_CONFIG_RELATIVE_PATH), text, 'utf8')
    },
    dispose: async () => {
      await ctx.fiber.dispose()
      // Retried rather than raced, for the reason `project-config-report.spec.ts`
      // records: the plugin's fire-and-forget home writes can still be in flight.
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
      rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousTrust === undefined) delete process.env[FOLDER_TRUST_ENV]
      else process.env[FOLDER_TRUST_ENV] = previousTrust
    },
  }
}

const REPO_CONFIG = JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo repo-guard' }] }],
  },
  permissionRules: {
    rules: [{ pattern: ['terraform', 'apply'], decision: 'forbidden', justification: 'Apply from the review pipeline.' }],
  },
  mcpServers: [{ serverName: 'staging', command: 'node', args: ['serve.js'] }],
  skillRoots: [{ path: '.claude/skills' }],
})

describe('the project tier takes effect', () => {
  let harness: TierHarness | undefined
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  it.skipIf(!gitAvailable)('runs a hook the repository declared in its project tier', async () => {
    harness = await tierHarness()
    // The gate switched off rather than granted, so the trusted branch is
    // reachable without writing a grant record first.
    process.env[FOLDER_TRUST_ENV] = '0'
    await harness.writeProjectConfig(REPO_CONFIG)

    const documents = await harness.internals.hookDocumentsFor(harness.workspace)
    // The tier's block is a document with its own provenance and a path a reader
    // can act on, rather than being merged into the checkout's `hooks.json`.
    expect(documents.some(document => document.source === 'project' && document.path === `${PROJECT_CONFIG_RELATIVE_PATH}#hooks`)).toBe(true)

    const merged = collectHookHandlers(documents)
    const selected = selectHookHandlers(merged.handlers, 'PreToolUse', 'bash', 'Bash')
    expect(selected.handlers.map(handler => handler.command)).toContain('echo repo-guard')
    // …and it is a matcher-bearing handler, so the tool family ran: a hook written
    // for `Bash` must guard this Host's shell spellings too.
    expect(selectHookHandlers(merged.handlers, 'PreToolUse', 'zsh', 'shell').handlers.map(handler => handler.command)).toContain('echo repo-guard')
  })

  it.skipIf(!gitAvailable)('files the repository’s command policy where the synchronous guard reads it', async () => {
    harness = await tierHarness()
    process.env[FOLDER_TRUST_ENV] = '0'
    await harness.writeProjectConfig(REPO_CONFIG)

    // The guard cannot await a file read, so this is the ordering that matters:
    // the tier is read (a session's first hook lookup, the settings panel, boot),
    // and the compiled policy is then available to the synchronous lookup.
    const tier = await harness.internals.projectTierFor(harness.workspace)
    expect(tier.mcpServers).toHaveLength(1)
    expect(tier.skillRoots).toHaveLength(1)

    const policy = harness.internals.projectPolicyForAgent({ session: { header: { cwd: harness.workspace } } })
    expect(policy).toBeDefined()
    expect(projectCommandPolicyDenial(policy, 'terraform apply')).toContain('Apply from the review pipeline.')
    // A different workspace is a different repository: nothing leaks across.
    expect(harness.internals.projectPolicyForAgent({ session: { header: { cwd: `${harness.workspace}-other` } } })).toBeUndefined()
  })

  it.skipIf(!gitAvailable)('makes a repository’s rules live the moment trust is granted', async () => {
    harness = await tierHarness({ folderTrustEnabled: true })
    await harness.writeProjectConfig(REPO_CONFIG)
    // No grant yet: the gate is on and the record is empty, so the tier is inert —
    // the file is not even opened.
    expect(harness.internals.projectPolicyForAgent({ session: { header: { cwd: harness.workspace } } })).toBeUndefined()
    expect((await harness.internals.hookDocumentsFor(harness.workspace)).some(document => document.path === `${PROJECT_CONFIG_RELATIVE_PATH}#hooks`)).toBe(false)

    await harness.plugin.trustFolderGrant(harness.workspace)

    // Immediately, not on the next settings write: the grant is the event that
    // makes the repository's own rules this process's rules.
    const policy = harness.internals.projectPolicyForAgent({ session: { header: { cwd: harness.workspace } } })
    expect(policy).toBeDefined()
    expect(projectCommandPolicyDenial(policy, 'terraform apply')).toContain('Apply from the review pipeline.')
    expect((await harness.internals.hookDocumentsFor(harness.workspace)).some(document => document.path === `${PROJECT_CONFIG_RELATIVE_PATH}#hooks`)).toBe(true)
  })

  it.skipIf(!gitAvailable)('stops a repository’s rules the moment trust is withdrawn', async () => {
    harness = await tierHarness({ folderTrustEnabled: true })
    await harness.writeProjectConfig(REPO_CONFIG)
    await harness.plugin.trustFolderGrant(harness.workspace)
    expect(harness.internals.projectPolicyForAgent({ session: { header: { cwd: harness.workspace } } })).toBeDefined()

    await harness.plugin.trustFolderRevoke(harness.workspace)

    // The withdrawal is the strongest case for a cache-free answer: a repository
    // the user just distrusted must not still be adding denials — or, worse, be
    // the reason a command was refused — until something happens to re-read.
    expect(harness.internals.projectPolicyForAgent({ session: { header: { cwd: harness.workspace } } })).toBeUndefined()
    expect((await harness.internals.hookDocumentsFor(harness.workspace)).some(document => document.path === `${PROJECT_CONFIG_RELATIVE_PATH}#hooks`)).toBe(false)
  })
})
