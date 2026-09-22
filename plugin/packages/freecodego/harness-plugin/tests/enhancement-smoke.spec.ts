/**
 * The enhancement smoke baseline.
 *
 * Plan §8.2 asks for six end-to-end paths, and this file is all six. It exists
 * because the plan touches five *cross-cutting* capabilities — settings, sandbox,
 * hooks, trust, policy — and unit tests for each of them prove nothing about what
 * happens when they run together. A guard that is individually correct and wired
 * in the wrong order still lets a call through.
 *
 * What "end-to-end" means here is deliberate and worth stating, because it is not
 * a live Host. Each path composes the real modules in the order the plugin
 * composes them, over a temporary workspace, and asserts the observable outcome
 * — the refusal message, the injected text, the cwd the child got, the records
 * written. The three paths whose contracts live in the wiring itself (the guard
 * order, the disposal list, the unref'd timers) assert against `src/index.ts` and
 * the other sources directly: that is the only place those contracts are
 * expressed, and an assertion that skipped them would be green while the wiring
 * was wrong.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/enhancement-smoke
 */

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { COMPILED_BUILT_IN_COMMAND_POLICY, type CompiledCommandPolicy } from '../src/command-policy.ts'
import { FreeCodeGoHookRuntime, type HookRecord } from '../src/hooks/runtime.ts'
import { installHookSeams, type HookSeamHost } from '../src/hooks/seams.ts'
import { HOOK_EVENTS, type HookDocument, type HookInvocation } from '../src/hooks/surface.ts'
import { collectInspectReport, type JsonValue } from '../src/inspect/collect.ts'
import { buildInspectCollectors, type InspectHostPort } from '../src/inspect/host.ts'
import type { PersonaDefinition } from '../src/persona/contract.ts'
import { PersonaRuns, personaToolDefinitions, type PersonaToolDeps } from '../src/persona/tools.ts'
import { PlanModeStore, planModeGuidanceText, planModeRefusal, planModeSessionKey } from '../src/plan-mode.ts'
import { installRehydration, rehydrationText } from '../src/rehydration.ts'
import { denyRefusal } from '../src/sandbox/profiles.ts'
import { startSuspendWatch } from '../src/system-power.ts'
import { tokensFromChars } from '../src/token-estimate.ts'
import { credentialRealpathDenial, freeCodeGoToolGuard } from '../src/tool-guards.ts'
import { sessionWorktreePlan } from '../src/worktree/tools.ts'

/** Workspaces created by a test, removed when it ends. */
const created: string[] = []

/**
 * A fresh temporary workspace, with forward slashes.
 *
 * Forward slashes because the inspect collectors build project paths as
 * `${workspace}/${relative}`: on Windows a backslash-rooted string would make
 * those paths unreadable to the assertion, which is the assertion's problem, not
 * the collector's.
 * @returns the workspace root.
 */
async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-smoke-'))
  created.push(directory)
  return directory.replace(/\\/gu, '/')
}

afterEach(async () => {
  while (created.length > 0) await rm(created.pop() as string, { recursive: true, force: true })
})

/**
 * One tool call, as the guards read it.
 *
 * Structural rather than imported: the guards type their input structurally, and
 * a smoke test that pulled in the tools package would test the package rather
 * than the wiring.
 */
interface GuardCall {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { readonly id?: string }
}

/** Hand a structural call to a guard that declares the registry's narrower type. */
function asCall(call: GuardCall): never {
  return call as never
}

/** The slice of a Host context the smoke paths install onto. */
interface ContextLike {
  on(event: string, handler: (...args: never[]) => unknown): unknown
  readonly agents?: { get?: (id: string) => unknown }
}

// ---------------------------------------------------------------------------
// 1. New session → assembled request
// ---------------------------------------------------------------------------

describe('1. a new session assembles its request', () => {
  /** An inspect port over a fixed workspace, recording what was read. */
  function port(root: string, trusted: boolean, files: Readonly<Record<string, string>>, reads: string[]): InspectHostPort {
    return {
      workspace: () => root,
      // Deliberately *outside* the workspace: the user's own config lives here,
      // and the assertion below is about which repository paths were opened.
      home: () => `${root}-home`,
      dataHome: () => `${root}-data`,
      trust: async () => ({ enabled: true, trusted, reason: trusted ? 'granted' : 'no grant recorded', root }),
      claudeHookDialect: () => 'plugin' as const,
      capabilities: async () => ({ skills: [], mcpServers: [], mcpTools: [] }),
      sandbox: () => ({ profile: 'workspace', deny: [] }),
      engines: () => ({ graphify: false, codegraph: false }),
      readFile: async (path) => {
        reads.push(path)
        return files[path]
      },
      // No change set and no sizes: the scan section reports that it could not
      // read one, which is the state this smoke path is not about. It reads no
      // file to answer, so it adds nothing to `reads` either.
      changes: async () => undefined,
      fileSize: async () => undefined,
      repositoryRoot: async () => root,
      listDir: async (path) => {
        reads.push(path)
        return []
      },
    }
  }

  /** The `rules` section's entries, as objects a test can assert on. */
  function rulesEntries(report: { readonly sections: readonly { readonly id: string; readonly data: JsonValue }[] }): readonly { readonly path: string; readonly tokens: number; readonly chars: number }[] {
    const section = report.sections.find(candidate => candidate.id === 'rules')
    return (section?.data as { readonly entries: readonly { readonly path: string; readonly tokens: number; readonly chars: number }[] }).entries
  }

  test('project instructions reach the request only when the folder is trusted', async () => {
    const root = await workspace()
    const instructions = '# House rules\n\nRun the gates before saying a task is done.\n'
    const files = { [`${root}/AGENTS.md`]: instructions }

    const trustedReads: string[] = []
    const trusted = await collectInspectReport(buildInspectCollectors(port(root, true, files, trustedReads)))
    expect(rulesEntries(trusted).map(entry => entry.path)).toEqual([`${root}/AGENTS.md`])
    // And the instruction text really was the source, not an empty file that
    // happened to be listed.
    expect(rulesEntries(trusted)[0]?.chars).toBe(instructions.length)

    // The gate runs before the read: an untrusted repository's file is not opened
    // at all, so the counts cannot be derived from content the user never granted.
    const untrustedReads: string[] = []
    const untrusted = await collectInspectReport(buildInspectCollectors(port(root, false, files, untrustedReads)))
    expect(rulesEntries(untrusted)).toEqual([])
    // No path inside the untrusted workspace was opened at all. The user's own
    // config paths (hooks, personas) are read either way — they are the user's
    // files, not the repository's — so the invariant is scoped to the workspace.
    expect(untrustedReads.filter(path => path.startsWith(`${root}/`))).toEqual([])
  })

  test('the token count is the one prompt composition would report', async () => {
    const root = await workspace()
    const instructions = 'x'.repeat(1_234)
    const reads: string[] = []
    const report = await collectInspectReport(buildInspectCollectors(port(root, true, { [`${root}/AGENTS.md`]: instructions }, reads)))
    const entry = rulesEntries(report)[0]
    expect(entry?.chars).toBe(1_234)
    // Same entry point `prompt-composition` uses, so the two surfaces cannot
    // disagree about the size of one file.
    expect(entry?.tokens).toBe(tokensFromChars(1_234))
    // Same order of magnitude as the reported character count — the property that
    // survives a density change, which an equality with a hardcoded number would
    // not.
    expect(entry?.tokens).toBeGreaterThan(1_234 / 16)
    expect(entry?.tokens).toBeLessThan(1_234)
  })

  test('the report carries the caller\'s timestamp, and adds no second clock', async () => {
    const root = await workspace()
    const reads: string[] = []
    const now = 1_700_000_000_000
    const report = await collectInspectReport(buildInspectCollectors(port(root, true, {}, reads)), now)
    expect(report.generatedAt).toBe(now)
    // The date line belongs to the Harness's own system prompt. A second one here
    // would be a second answer to what today is, and the two could disagree.
    const guidance = planModeGuidanceText(false)
    expect(guidance).not.toMatch(/\d{4}-\d{2}-\d{2}/u)
  })
})

// ---------------------------------------------------------------------------
// 2. Tool call → guards → result
// ---------------------------------------------------------------------------

describe('2. the guards judge one call in a fixed order', () => {
  const settings = () => ({
    envReadGuardEnabled: true,
    commandPolicyEnabled: true,
    doomLoopGuardEnabled: true,
    planModeEnabled: true,
  })

  /** The composed guard, with the mode a caller asks for. */
  function guard(mode: 'plan' | 'execute', policy: CompiledCommandPolicy = COMPILED_BUILT_IN_COMMAND_POLICY) {
    return freeCodeGoToolGuard({
      settings,
      policy,
      planMode: { policy, modeFor: () => mode },
    })
  }

  test('credential protection runs before the command policy', () => {
    const refusal = guard('execute')(asCall({
      name: 'bash',
      // Both tiers have an opinion: it names a credential file *and* it dumps the
      // environment. The credential guard must be the one that answers, because a
      // message that mentions the wrong rule sends the user to the wrong setting.
      arguments: { command: 'cat ~/.ssh/id_rsa && printenv' },
      agent: { id: 'a1' },
    }))
    expect(refusal).toContain('credential guard')
  })

  test('the command policy runs before the plan fence', () => {
    const refusal = guard('plan')(asCall({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: { id: 'a1' } }))
    expect(refusal).toContain('command policy')
    expect(refusal).not.toContain('Plan Mode')
  })

  test('the plan fence refuses a mutating tool, naming the mode rather than the policy', () => {
    const refusal = guard('plan')(asCall({ name: 'write', arguments: { file_path: '/w/src/a.ts' }, agent: { id: 'a1' } }))
    expect(refusal).toContain('Plan Mode')
    expect(refusal).toContain('write')
  })

  test('a bash call the policy allows is not refused by the fence', () => {
    // The fence defers to the declarative policy for `bash` rather than keeping a
    // second keyword list, so a command the policy clears still runs while
    // planning. A keyword list here would drift from the policy and refuse reads.
    expect(guard('plan')(asCall({ name: 'bash', arguments: { command: 'git status' }, agent: { id: 'a1' } }))).toBeUndefined()
  })

  test('repetition is never refused on this path — the Harness owns the loop answer', () => {
    // This pipeline used to end in a doom-loop tier that refused the third
    // identical call. Every call it judges was dispatched by the Host, so the
    // Harness's advisory `dsh-repeat-tool-reminder` counts the same repeats and
    // is the answer the model gets; a second one here was split authority on one
    // call. The tier stays on the native engines' path — see the wiring test
    // below, and `native-tool-guard.spec.ts` for its behaviour.
    const judge = guard('execute')
    const call = asCall({ name: 'read', arguments: { file_path: '/w/src/a.ts' }, agent: { id: 'a1' } })
    for (let index = 0; index < 8; index += 1) expect(judge(call)).toBeUndefined()
    // The monotonic tiers are untouched by that removal: a repetition of a call
    // they refuse is still refused, and still as policy rather than as a loop.
    for (let index = 0; index < 4; index += 1) {
      expect(judge(asCall({ name: 'bash', arguments: { command: 'rm -rf build' }, agent: { id: 'a1' } }))).toContain('command policy')
    }
  })

  test('the sandbox deny list refuses a path no other rule knows about', () => {
    const denial = denyRefusal({ deny: ['/w/secrets/**'], args: { file_path: '/w/secrets/token.txt' } })
    expect(denial).toContain('FREECODEGO_SANDBOX_DENY')
    expect(denial).toContain('/w/secrets/**')
    // A call naming no file is out of scope by construction, not silently allowed
    // by accident: the module says so, and the report restates it.
    expect(denyRefusal({ deny: ['/w/secrets/**'], args: { command: 'ls' } })).toBeUndefined()
  })

  test('the realpath tier sees through a name that looks ordinary', async () => {
    const root = await workspace()
    const secret = `${root}/id_rsa`
    await writeFile(secret, 'PRIVATE KEY\n', 'utf8')
    const alias = `${root}/docs/notes.md`
    await symlink(secret, alias).catch(() => undefined)

    // The lexical tier answers for the name the model wrote.
    expect(await credentialRealpathDenial('read', { file_path: secret })).toContain('credential guard')
    // A non-credential name resolves somewhere that is not a credential file, so
    // this tier must not refuse it — an over-eager realpath rule would deny every
    // ordinary read.
    expect(await credentialRealpathDenial('read', { file_path: `${root}/src/a.ts` })).toBeUndefined()
  })

  test('index.ts registers them in the order the refusals above assume', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const composite = source.indexOf('guard(freeCodeGoToolGuard({')
    const deny = source.indexOf('guard(exec => denyRefusal(')
    const realpath = source.indexOf('await credentialRealpathDenial(')
    expect(composite).toBeGreaterThan(-1)
    expect(deny).toBeGreaterThan(composite)
    // The realpath tier lives on the waterfall, which the registry guards precede:
    // a call must be refused before the pre-execute handlers start side effects.
    expect(realpath).toBeGreaterThan(deny)
  })

  test('index.ts wires the loop tier to the engines only, and never to the registry', async () => {
    // The split is the fix: the Host-dispatched guard must not carry a loop tier
    // (the Harness already counts those calls), while the native seam must, because
    // nothing else can see an engine's own tools. Asserted on the wiring source
    // because no behavioural test can tell one composed object from another.
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const composite = source.slice(source.indexOf('guard(freeCodeGoToolGuard({'))
    const wiring = composite.slice(0, composite.indexOf('}))'))
    expect(wiring).not.toContain('doomLoop')
    const nativeWiring = source.slice(source.indexOf('await nativeToolDenial(call, {'))
    expect(nativeWiring.slice(0, nativeWiring.indexOf('}).catch('))).toContain('doomLoop')
    // And the remedy itself still exists to be wired: a deleted guard is a
    // different change from a guard moved off one path.
    expect(source).toContain('new DoomLoopGuard(')
  })

  test('index.ts registers the deny list’s resolution tier on the same waterfall', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const deny = source.indexOf('guard(exec => denyRefusal(')
    const resolved = source.indexOf('await denyRealpathRefusal(')
    const checkpoint = source.indexOf('checkpointAutoCapture')
    expect(deny).toBeGreaterThan(-1)
    // The registry guard answers about the name; this tier reads the file the
    // filesystem would open, and a link is the one construction that separates them.
    expect(resolved).toBeGreaterThan(deny)
    // Ahead of the checkpoint capture for the same reason the credential tier is: a
    // call that is about to be refused must not leave a checkpoint behind.
    expect(checkpoint).toBeGreaterThan(resolved)
    // The native engines never cross the registry, so the same judgment has to be
    // wired on their own path, after the lexical tier it complements.
    const native = await readFile(new URL('../src/native-tool-guard.ts', import.meta.url), 'utf8')
    const nativeLexical = native.indexOf('const denied = denyRefusal(')
    const nativeResolved = native.indexOf('await denyRealpathRefusal(')
    expect(nativeLexical).toBeGreaterThan(-1)
    expect(nativeResolved).toBeGreaterThan(nativeLexical)
  })
})

// ---------------------------------------------------------------------------
// 3. Turn end
// ---------------------------------------------------------------------------

describe('3. a turn ends', () => {
  /** A host that keeps its listeners so a test can call the one it means. */
  function host(): { listeners: Map<string, readonly ((...args: never[]) => unknown)[]>; seamHost: HookSeamHost } {
    const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
    return {
      listeners,
      seamHost: {
        on(event, handler) {
          const bucket = listeners.get(event) ?? []
          bucket.push(handler)
          listeners.set(event, bucket)
          return () => undefined
        },
      },
    }
  }

  /** A document declaring one command hook for an event. */
  function document(event: string, body: Record<string, unknown> = {}): HookDocument {
    return { source: 'project', path: '/w/.freecodego/settings.json', value: { hooks: { [event]: [{ hooks: [{ type: 'command', command: 'check', ...body }] }] } } }
  }

  /** A runtime whose named handlers answer with scripted output. */
  function runtime(outputs: Readonly<Record<string, string>>, documents: readonly HookDocument[], records: HookRecord[] = []): FreeCodeGoHookRuntime {
    return new FreeCodeGoHookRuntime({
      // Asynchronous on purpose: the runtime reads hook files, and the signature
      // is what keeps the first dispatch of a session from running without them.
      documents: async () => documents,
      run: async (handler): Promise<HookInvocation> => ({ exitCode: 0, stdout: outputs[handler.command] ?? '', stderr: '' }),
      record: (entry) => { records.push(entry) },
    })
  }

  test('a Stop hook continues the turn with its own words', async () => {
    const { listeners, seamHost } = host()
    const records: HookRecord[] = []
    installHookSeams(seamHost, {
      runtime: runtime({ check: '{"decision":"block","reason":"the tests have not been run"}' }, [document('Stop')], records),
      record: entry => records.push(entry),
    })
    const stopping = listeners.get('agent/turn-stopping') as readonly ((payload: unknown) => Promise<unknown>)[]
    expect(stopping).toHaveLength(1)

    const steered: unknown[] = []
    await stopping[0]?.({
      agent: { steer: (message: unknown) => { steered.push(message) }, session: { id: 's1' } },
      turn: 4,
    })
    expect(steered).toHaveLength(1)
    expect(JSON.stringify(steered[0])).toContain('the tests have not been run')
    // The invocation is written down, so a rule that keeps a turn going is
    // findable afterwards rather than being an invisible extra step.
    expect(records.some(entry => entry.event === 'Stop' && entry.phase === 'invoked')).toBe(true)
  })

  test('a turn that ends without a hook is left alone', async () => {
    const { listeners, seamHost } = host()
    installHookSeams(seamHost, { runtime: runtime({}, []), record: () => undefined })
    const steered: unknown[] = []
    // No document declares a Stop hook, so nothing steers and nothing throws: the
    // seam must pass an ordinary turn through untouched.
    await (listeners.get('agent/turn-stopping') as readonly ((payload: unknown) => Promise<unknown>)[])[0]?.({
      agent: { steer: (message: unknown) => { steered.push(message) }, session: { id: 's1' } },
      turn: 5,
    })
    expect(steered).toEqual([])

    // The idle transition is the other half of "the turn is over", and both
    // events derived from it are observed through the same seam.
    const observed: string[] = []
    const idle = new FreeCodeGoHookRuntime({
      documents: async () => [{ source: 'project', path: '/w/.freecodego/settings.json', value: { hooks: { StopCancelled: [{ hooks: [{ type: 'command', command: 'cancelled' }] }], Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }] } } }],
      run: async (): Promise<HookInvocation> => ({ exitCode: 0, stdout: '{}', stderr: '' }),
      record: (entry) => { if (entry.phase === 'invoked') observed.push(entry.event) },
    })
    const { listeners: idleListeners, seamHost: idleHost } = host()
    installHookSeams(idleHost, { runtime: idle, record: () => undefined })
    ;(idleListeners.get('agent/status') as readonly ((payload: unknown) => unknown)[])[0]?.({ agent: { session: { id: 's1' } }, status: 'idle' })
    await idle.settled()
    expect(observed).toEqual(expect.arrayContaining(['StopCancelled', 'Notification']))
  })

  test('the host pipeline finishes before hooks observe the result', async () => {
    const order: string[] = []
    const { listeners, seamHost } = host()
    installHookSeams(seamHost, {
      runtime: new FreeCodeGoHookRuntime({
        documents: async () => [document('PostToolUse')],
        run: async (): Promise<HookInvocation> => ({ exitCode: 0, stdout: '{}', stderr: '' }),
        record: (entry) => { if (entry.phase === 'invoked') order.push('hook') },
      }),
      record: () => undefined,
    })
    const post = listeners.get('tools/post-execute')
    expect(post).toBeDefined()
    await (post as readonly ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>)[])[0]?.(
      { name: 'read', arguments: {}, session: { id: 's1' } },
      { value: 'contents' },
      async () => {
        // Whatever the host does on the way out — including the headroom rewrite —
        // is finished here, which is what makes the hook's view of the result the
        // final one.
        order.push('next')
        return { kind: 'accept' }
      },
    )
    expect(order).toEqual(['next', 'hook'])
  })
})

// ---------------------------------------------------------------------------
// 4. Compaction
// ---------------------------------------------------------------------------

describe('4. a compaction runs', () => {
  /**
   * A context that records its listeners, enough for one install.
   *
   * `emit` awaits each listener in registration order, which is what a Host does
   * for a `session/event` that two subsystems both observe.
   * @returns the context to install onto, and a way to emit an event through it.
   */
  function context(): { ctx: ContextLike; emit: (event: string, ...args: unknown[]) => Promise<void> } {
    const listeners = new Map<string, ((...args: never[]) => unknown)[]>()
    const ctx: ContextLike = {
      on(event, handler) {
        const bucket = listeners.get(event) ?? []
        bucket.push(handler)
        listeners.set(event, bucket)
        return () => undefined
      },
      agents: { get: () => undefined },
    }
    return {
      ctx,
      emit: async (event, ...args) => {
        for (const handler of listeners.get(event) ?? []) await (handler as (...values: unknown[]) => Promise<unknown>)(...args)
      },
    }
  }

  test('PreCompact and PostCompact dispatch on their own boundaries, and on nothing else', async () => {
    const observed: string[] = []
    const listeners = new Map<string, readonly ((...args: never[]) => unknown)[]>()
    const runtime = new FreeCodeGoHookRuntime({
      documents: async () => [{
        source: 'project',
        path: '/w/.freecodego/settings.json',
        value: { hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'pre' }] }], PostCompact: [{ hooks: [{ type: 'command', command: 'post' }] }] } },
      }],
      run: async (): Promise<HookInvocation> => ({ exitCode: 0, stdout: '{}', stderr: '' }),
      record: (entry) => { if (entry.phase === 'invoked') observed.push(entry.event) },
    })
    installHookSeams({
      on(event, handler) {
        listeners.set(event, [...(listeners.get(event) ?? []), handler])
        return () => undefined
      },
    }, { runtime, record: () => undefined })

    // The `session/event` seam is one listener that filters by type, so an
    // ordinary session event dispatches nothing at all: a Compact hook firing on
    // every event would be a hook running constantly.
    const sessionEvent = listeners.get('session/event') as readonly ((...args: never[]) => unknown)[]
    for (const handler of sessionEvent) await (handler as (...values: unknown[]) => Promise<unknown>)({ session: { id: 's1' } }, { type: 'turn/end', data: {} })
    await runtime.settled()
    expect(observed).toEqual([])

    for (const handler of sessionEvent) await (handler as (...values: unknown[]) => Promise<unknown>)({ session: { id: 's1' } }, { type: 'compaction/start', data: { trigger: 'auto' } })
    for (const handler of sessionEvent) await (handler as (...values: unknown[]) => Promise<unknown>)({ session: { id: 's1' } }, { type: 'compaction/end', data: {} })
    await runtime.settled()
    expect(observed).toEqual(expect.arrayContaining(['PreCompact', 'PostCompact']))
  })

  test('a compacted session gets its task list back, and plan mode survives', async () => {
    const root = await workspace()
    const injected: unknown[] = []
    const { ctx, emit } = context()
    const session = {
      id: 's1',
      header: { cwd: root },
      snapshotEvents: () => [{ type: 'todo/write', data: { todos: [{ content: 'finish the gates', status: 'in_progress' }] } }],
    }
    // The same context, with a `agents.get` that reaches an injectable agent: that
    // is the only way the injection path can be observed, and installing onto a
    // second context would emit into listeners nothing had registered.
    const ctxWithAgent = {
      on: ctx.on,
      agents: { get: () => ({ inject: (message: unknown) => injected.push(message) }) },
    }
    installRehydration(ctxWithAgent as never, {
      enabled: () => true,
      recall: () => ({ projectId: 'p', records: [], tokenBudget: 0, usedTokens: 0 }),
      bodies: () => new Map(),
      planReminder: async () => 'Plan Mode is still on: gather truth, do not edit.',
    })
    await emit('session/event', session, { type: 'compaction/end', data: {} })
    const body = JSON.stringify(injected)
    expect(body).toContain('finish the gates')
    // The reminder is computed here rather than folded into the rehydrated body,
    // precisely so a session with nothing else to restore still gets it.
    expect(body).toContain('Plan Mode is still on')

    // And the mode itself is stored per conversation, so a compaction cannot end it.
    const store = new PlanModeStore(`${root}/modes`)
    await store.write('s1', 'plan')
    expect(await store.read('s1')).toBe('plan')
    expect(rehydrationText({ todos: [{ content: 'x', status: 'pending' }] })).toContain('Active task list')
  })

  test('the mode is keyed on the root conversation', () => {
    expect(planModeSessionKey({ id: 'child', session: { header: { parentSession: 'root' } } })).toBe(planModeSessionKey({ id: 'root' }))
  })
})

// ---------------------------------------------------------------------------
// 5. Subagent
// ---------------------------------------------------------------------------

describe('5. a child agent starts', () => {
  const persona: PersonaDefinition = {
    name: 'reviewer',
    description: 'reads a change and reports',
    instructions: 'Read before you judge.',
    defaultIsolation: 'worktree',
    inputs: [{ name: 'target', ioType: 'path', required: true }],
    outputs: [{ name: 'verdict', ioType: 'report', required: true }],
    source: 'project',
  }

  /** The start tool over an injected roster, with the spawn recorded. */
  function startTool(records: { spawns: unknown[]; isolated: string[] }) {
    const deps: PersonaToolDeps = {
      roster: async () => ({ personas: [persona], issues: [], shadowed: [] }),
      instructions: async () => persona.instructions,
      spawn: async (input) => { records.spawns.push(input) },
      isolate: async ({ workspaceRoot, sessionId }) => {
        const plan = sessionWorktreePlan({ workspaceRoot, sessionId })
        records.isolated.push(plan.path)
        return { path: plan.path, strategy: 'worktree' }
      },
      newSessionId: () => 'child-1',
      callerOf: () => ({ cwd: '/w', agent: { id: 'root' } }),
    }
    const tools = personaToolDefinitions(deps, new PersonaRuns())
    const start = tools.find(tool => tool.name === 'engineering_subagent_start')
    if (start === undefined) throw new Error('the start tool is missing')
    return start as unknown as { execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> }
  }

  test('a required input that was not supplied refuses the spawn', async () => {
    const records = { spawns: [] as unknown[], isolated: [] as string[] }
    const result = await startTool(records).execute({ persona: 'reviewer', task: 'review the diff' }, {})
    expect(result.missing).toEqual(['target'])
    expect(String(result.refused)).toContain('target')
    // Nothing was started: a refusal that still spawned would be a warning.
    expect(records.spawns).toEqual([])
  })

  test('isolation puts the child in its own checkout, and the parent fence covers it', async () => {
    const records = { spawns: [] as unknown[], isolated: [] as string[] }
    const result = await startTool(records).execute({ persona: 'reviewer', task: 'review the diff', inputs: { target: 'src/a.ts' } }, {})
    expect(records.isolated).toHaveLength(1)
    expect(result.cwd).toBe(records.isolated[0])
    expect(result.sessionId).toBe('child-1')
    // The child is created through the parent's context, which is the only way the
    // spawn port can reach the agents service at all.
    expect(JSON.stringify(records.spawns[0])).toContain('root')
    expect(String((records.spawns[0] as { session: { cwd: string } }).session.cwd)).toBe(records.isolated[0])

    // The fence belongs to the conversation, not to the worker: a child of a
    // planning session is refused the same mutating tools its parent is. This is
    // the assertion that a per-agent key would fail.
    const child = { id: 'child-1', session: { header: { parentSession: 'root' } } }
    expect(planModeSessionKey(child)).toBe(planModeSessionKey({ id: 'root' }))
    expect(planModeRefusal({ mode: 'plan', tool: 'write', args: { file_path: 'a.ts' } })?.reason).toBe('mutating-tool')
  })

  test('a child asked for isolation the composition cannot provide is refused, not unisolated', async () => {
    const deps: PersonaToolDeps = {
      roster: async () => ({ personas: [persona], issues: [], shadowed: [] }),
      instructions: async () => persona.instructions,
      spawn: async () => undefined,
      newSessionId: () => 'child-2',
      callerOf: () => ({ cwd: '/w', agent: { id: 'root' } }),
    }
    const start = personaToolDefinitions(deps, new PersonaRuns()).find(tool => tool.name === 'engineering_subagent_start') as unknown as { execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> }
    const result = await start.execute({ persona: 'reviewer', task: 'x', inputs: { target: 'a' } }, {})
    expect(String(result.refused)).toContain('worktree')
  })
})

// ---------------------------------------------------------------------------
// 6. Session disposal
// ---------------------------------------------------------------------------

describe('6. a disposed session leaves nothing behind', () => {
  test('the interval that watches for suspends does not hold the process open', () => {
    const handles: ReturnType<typeof setInterval>[] = []
    const real = globalThis.setInterval
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = real(...args)
      handles.push(handle)
      return handle
    }) as typeof setInterval
    try {
      const stop = startSuspendWatch({ onSuspectSleep: () => undefined, readClock: () => ({ wallMs: 0, monoMs: 0 }) })
      stop()
    } finally {
      globalThis.setInterval = real
    }
    expect(handles).toHaveLength(1)
    // `hasRef()` is the property that actually matters: an un-unref'd interval is
    // the reason an otherwise idle Host cannot exit.
    expect((handles[0] as unknown as { hasRef?: () => boolean }).hasRef?.()).toBe(false)
  })

  test('every interval in the plugin source is unref\'d', async () => {
    const files = ['agent-progress.ts', 'plugin-update.ts', 'system-power.ts', 'workbuddy-pool.ts']
    for (const file of files) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')
      for (const match of source.matchAll(/(?:const\s+(\w+)|this\.(\w+))\s*=\s*setInterval\(/gu)) {
        const identifier = match[1] ?? match[2]
        expect(source, `${file}: ${identifier} must be unref'd`).toContain(`${identifier}.unref?.()`)
      }
    }
  })

  test('every per-session map in the plugin is released or bounded', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // Caches keyed by the workspace and released when the Host tears down, which
    // is a different lifetime from a conversation's: dropping them on one
    // session's disposal would throw away every other session's cached reads. The
    // label is the effect that clears each one, asserted below, so the exemption
    // cannot be taken by a map that is never cleared.
    const teardownCaches: Readonly<Record<string, string>> = {
      hookDocuments: 'freecodego: hook document cache',
      // Keyed by the workspace, so its lifetime is the Host's rather than one
      // conversation's. Cleared by its own teardown effect, and also by the trust
      // grant and revoke remotes — a trust answer cached past the change that
      // produced it is the two-authority bug this cache exists to avoid.
      projectConfigReports: 'freecodego: project config report cache',
      // The compiled command policy for the same file, and therefore the same
      // lifetime as the report above: keyed by the workspace, filled wherever
      // `projectTierFor` reads one, and cleared by that cache's teardown effect
      // (and by the trust grant and revoke remotes, which is what makes a policy
      // obtained before a grant unable to outlive it).
      projectCommandPolicies: 'freecodego: project config report cache',
    }
    const disposal = source.slice(source.indexOf("ctx.on('session/disposed'"), source.indexOf("'freecodego: per-session fragment and budget views'"))
    expect(disposal).not.toBe('')

    const declared = [...source.matchAll(/private readonly (\w+) = new Map</gu)].map(match => match[1])
    expect(declared.length).toBeGreaterThan(5)

    const unaccounted: string[] = []
    for (const name of declared) {
      // Released for the session it belongs to.
      if (disposal.includes(`this.${name}.delete(key)`) || disposal.includes(`this.${name}.forget(`)) continue
      // Bounded by its own eviction, which is what makes it safe to keep.
      if (source.includes(`while (this.${name}.size >`)) continue
      // Released at teardown, for a cache whose lifetime is the Host's.
      const teardown = teardownCaches[name!]
      if (teardown !== undefined) {
        expect(source, `${name} must be cleared at teardown`).toContain(`this.${name}.clear()`)
        expect(source, `${name} must be cleared by the effect it claims`).toContain(teardown)
        continue
      }
      // Keyed by the workspace rather than the session: a worktree cache and a
      // hook document cache outlive any one conversation, and a session's
      // disposal is not the moment to drop them.
      const firstSet = source.match(new RegExp(`this\\.${name}\\.set\\(([^,]+)`, 'u'))?.[1] ?? ''
      if (/workspace|Workspace|cwd/u.test(firstSet)) continue
      unaccounted.push(name!)
    }
    expect(unaccounted).toEqual([])

    // Not vacuous: the four views the disposal handler names explicitly are the
    // ones three separate leaks taught us to name.
    for (const name of ['planModeLogs', 'contextBudgetReports', 'lastShapeChange', 'promptCompositions']) {
      expect(declared).toContain(name)
      expect(disposal).toContain(`this.${name}.delete(key)`)
    }

    // The views that live in their own class cannot be found by scanning this
    // file for `new Map<`, so they are named: each one holds per-session state and
    // each must be released by the same handler. A persona contract was the one
    // missing — it is released when the child reports, and a child disposed
    // without reporting left an entry behind for the life of the process.
    // The loop guard is the one named here that a session can also leave by
    // ending its attempt rather than by being disposed — and a session disposed
    // mid-attempt never sends the `end` frame that would have dropped its
    // detector, which holds the attempt's accumulated text.
    for (const holder of ['contextBudget', 'requestShapes', 'cacheColdView', 'actionReview', 'personaRuns', 'assistantLoopGuard']) {
      expect(disposal, `${holder} must be released on disposal`).toContain(`this.${holder}.forget(`)
    }
  })

  test('a trust change clears the hook-document cache', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // The cache holds the *gated* document list, so a grant that did not clear it
    // would leave the project's hooks unloaded while the panel already says
    // granted, and a revoke would leave them running for the length of the window.
    // Three clears: the grant remote, the revoke remote, and the teardown effect.
    const clears = source.match(/this\.hookDocuments\.clear\(\)/gu) ?? []
    expect(clears.length).toBeGreaterThanOrEqual(3)
    const grant = source.indexOf("@Remote('trustFolderGrant')")
    const revoke = source.indexOf("@Remote('trustFolderRevoke')")
    expect(grant).toBeGreaterThan(-1)
    expect(revoke).toBeGreaterThan(grant)
    for (const boundary of [grant, revoke]) {
      // Within the remote's own body, before the next remote is declared.
      const body = source.slice(boundary, source.indexOf('@Remote(', boundary + 1))
      expect(body).toContain('this.hookDocuments.clear()')
    }
  })

  test('the teardown effects clear the surviving process-wide views', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    for (const view of ['contextBudget', 'requestShapes', 'cacheColdView']) {
      expect(source, `${view} must be cleared on teardown`).toContain(`${view}.clear()`)
    }
  })

  test('every hook event the contract declares has a seam', async () => {
    const { listeners } = (() => {
      const map = new Map<string, readonly ((...args: never[]) => unknown)[]>()
      const host: HookSeamHost = {
        on(event, handler) {
          map.set(event, [...(map.get(event) ?? []), handler])
          return () => undefined
        },
      }
      const installed = installHookSeams(host, {
        runtime: new FreeCodeGoHookRuntime({ documents: async () => [] }),
        record: () => undefined,
      })
      expect([...installed]).toEqual([...HOOK_EVENTS])
      return { listeners: map }
    })()
    for (const hostEvent of ['agent/created', 'agent/pre-step', 'tools/pre-execute', 'tools/post-execute', 'agent/turn-stopping', 'session/event', 'session/disposed', 'subagent/start', 'subagent/end']) {
      expect(listeners.has(hostEvent), `${hostEvent} must have a listener`).toBe(true)
    }
  })
})
