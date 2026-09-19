import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isBridgedCall, nativeCallsFromPermission, nativeToolCall, nativeToolDenial, nativeToolName } from '../src/native-tool-guard.ts'
import { DoomLoopGuard, freeCodeGoToolGuard } from '../src/tool-guards.ts'
// From its owner, not from `tool-guards.ts`: that module imports the compiled policy
// without re-exporting it, so importing it from there resolved to `undefined` and
// left the guards' own `?? COMPILED_BUILT_IN_COMMAND_POLICY` fallback to supply the
// value. The suites passed either way, which is why nothing caught it until the test
// project was type-checked — and a test that relies on a fallback for its own input
// stops measuring the input the moment the fallback changes.
import { COMPILED_BUILT_IN_COMMAND_POLICY } from '../src/command-policy.ts'

/**
 * These pin the projection, not the guards themselves: a native engine's tool
 * names and argument keys are its own, and every rule the plugin already has is
 * written against the Harness vocabulary. If the projection drifts, the guards
 * silently stop matching and a native engine quietly regains the ability to read
 * `.env` or delete files during Plan Mode.
 */
describe('native tool projection', () => {
  it('maps each engine spelling onto the name the guards match on', () => {
    // Claude Agent SDK's built-in tool names.
    expect(nativeToolName('Bash')).toBe('bash')
    expect(nativeToolName('Read')).toBe('read')
    expect(nativeToolName('Write')).toBe('write')
    expect(nativeToolName('Edit')).toBe('edit')
    expect(nativeToolName('MultiEdit')).toBe('multi_edit')
    expect(nativeToolName('NotebookEdit')).toBe('notebook_edit')
    // Codex App Server names that are already snake_case pass through.
    expect(nativeToolName('apply_patch')).toBe('apply_patch')
    expect(nativeToolName('exec_command')).toBe('exec_command')
    // A name no rule knows is not an error; it simply matches nothing.
    expect(nativeToolName('mcp__docs__search')).toBe('mcp_docs_search')
    expect(nativeToolName('  Glob ')).toBe('glob')
  })

  it("re-keys the engine's path argument into the harness key", () => {
    // The credential guard reads `path ?? file_path`; Claude sends `file_path`.
    expect(nativeToolCall('Read', { file_path: '/work/.env', offset: 0 }).arguments)
      .toEqual({ file_path: '/work/.env', offset: 0, path: '/work/.env' })
    expect(nativeToolCall('NotebookEdit', { notebook_path: '/work/a.ipynb' }).arguments.path).toBe('/work/a.ipynb')
    // An existing `path` wins and is not overwritten.
    expect(nativeToolCall('apply_patch', { path: '/work/.git-credentials' }).arguments.path).toBe('/work/.git-credentials')
    // A stringy payload must not bypass the guard, as in the Harness pipeline.
    expect(nativeToolCall('Read', '{"file_path":"/work/.env"}').arguments.path).toBe('/work/.env')
    expect(nativeToolCall('Read', undefined).arguments).toEqual({})
  })

  it('projects a Claude permission request from its tool name and input', () => {
    expect(nativeCallsFromPermission({ toolName: 'Bash', method: 'permission/requested', detail: { toolName: 'Bash', input: { command: 'ls' } } }))
      .toEqual([{ name: 'bash', arguments: { command: 'ls' } }])
  })

  it('projects a Codex App Server approval from its method and params', () => {
    // The newer method sends one command string.
    expect(nativeCallsFromPermission({ method: 'item/commandExecution/requestApproval', detail: { command: 'ls -la', cwd: '/work' } }))
      .toEqual([{ name: 'shell', arguments: { command: 'ls -la', cwd: '/work' } }])
    // The older one sends argv.
    expect(nativeCallsFromPermission({ method: 'execCommandApproval', detail: { command: ['git', 'push', '--force'] } }))
      .toEqual([{ name: 'shell', arguments: { command: 'git push --force' } }])
    // A file-change approval is judged once per changed path, plus the write root.
    expect(nativeCallsFromPermission({
      method: 'applyPatchApproval',
      detail: { grantRoot: '/work/src', fileChanges: { '/work/a.ts': {}, '/work/b.ts': {} } },
    })).toEqual([
      { name: 'apply_patch', arguments: { path: '/work/src' } },
      { name: 'apply_patch', arguments: { path: '/work/a.ts' } },
      { name: 'apply_patch', arguments: { path: '/work/b.ts' } },
    ])
  })

  it('leaves a request it cannot read to the engine approval', () => {
    // No schema-shaped meaning to project: guessing a tool name here could
    // refuse a call for the wrong reason.
    expect(nativeCallsFromPermission({ method: 'item/permissions/requestApproval', detail: { permissions: {} } })).toEqual([])
    expect(nativeCallsFromPermission({ method: 'attestation/generate', detail: {} })).toEqual([])
    expect(nativeCallsFromPermission({ method: 'item/commandExecution/requestApproval', detail: { command: null } })).toEqual([])
    expect(nativeCallsFromPermission({})).toEqual([])
  })
})

describe('native guard evaluation', () => {
  const settings = () => undefined

  it('refuses reading a credential file through the engine tool', async () => {
    const denial = await nativeToolDenial(nativeToolCall('Read', { file_path: '/work/project/.env' }), { settings })
    expect(denial).toContain('credential guard')
  })

  it('refuses every engine tool that names a credential path, not only Read', async () => {
    // The projection deliberately re-keys the engines' own argument keys
    // (`file_path`, `notebook_path`) so the credential guard can read them, and
    // the engines' write tools are what that re-keying exists for: MultiEdit and
    // NotebookEdit change a file exactly as `Write` does, and a Codex file-change
    // approval arrives as `apply_patch` with one path per changed file. A guard
    // whose tool list knows only `read`/`write`/`edit` is inert for all three.
    expect(await nativeToolDenial(nativeToolCall('MultiEdit', { file_path: '/work/.env' }), { settings }))
      .toContain('credential guard')
    expect(await nativeToolDenial(nativeToolCall('NotebookEdit', { notebook_path: '/home/u/.ssh/notes.ipynb' }), { settings }))
      .toContain('credential guard')
    const codex = nativeCallsFromPermission({
      method: 'item/fileChange/requestApproval',
      detail: { fileChanges: { '/work/src/a.ts': {}, '/work/.env': {} } },
    })
    const credentialChange = codex[1]
    if (credentialChange === undefined) throw new Error('the two-file change must project two tool calls')
    expect(await nativeToolDenial(credentialChange, { settings })).toContain('credential guard')
    // The same tools on an ordinary path stay left to the engine's approval.
    expect(await nativeToolDenial(nativeToolCall('MultiEdit', { file_path: '/work/src/a.ts' }), { settings })).toBeUndefined()
    expect(await nativeToolDenial(nativeToolCall('apply_patch', { path: '/work/src/a.ts' }), { settings })).toBeUndefined()
  })

  it('refuses a shell command that would dump credentials', async () => {
    expect(await nativeToolDenial(nativeToolCall('Bash', { command: 'printenv | grep TOKEN' }), { settings }))
      .toContain('credential guard')
    expect(await nativeToolDenial(nativeToolCall('Bash', { command: 'cat /home/u/.ssh/id_rsa' }), { settings }))
      .toContain('credential guard')
  })

  it('applies the command policy to every engine shell tool, not just the one it was written for', async () => {
    // `rm -rf` is forbidden by the built-in policy; a native shell call must be
    // refused for exactly the same reason a Harness `bash` call is. All three
    // names are pinned because the vocabulary now lives in one place: a name
    // dropped from it stops being policed on this path while the Harness path
    // keeps enforcing, which is the failure this test exists to catch.
    for (const tool of ['Bash', 'shell', 'exec_command']) {
      expect(await nativeToolDenial(nativeToolCall(tool, { command: 'rm -rf build' }), { settings }), tool)
        .toContain('command policy')
    }
    expect(await nativeToolDenial(nativeToolCall('shell', { command: 'sudo -u root ls' }), { settings }))
      .toContain('command policy')
    expect(await nativeToolDenial(nativeToolCall('Bash', { command: 'ls -la' }), { settings })).toBeUndefined()
  })

  it('judges a Codex approval as the method it declares, not the name the transport attached', async () => {
    // The producer fills `toolName` on every request — in `native-agent` it is
    // `detail.toolName ?? detail.method ?? 'native'` — and a Codex approval's
    // params carry neither key, so every Codex request reaches the guard named
    // `native` with its App Server method alongside it. Reading the name first put
    // the method out of reach: each of those calls was judged as an unknown tool
    // with no arguments, which left the command policy, the sandbox deny list and
    // Plan Mode inert on the whole Codex transport while the model was told they
    // applied. This is the shape `handleNativePermission` builds, not a shape a
    // test invented.
    const [shell] = nativeCallsFromPermission({
      toolName: 'native',
      method: 'item/commandExecution/requestApproval',
      detail: { command: 'rm -rf build', cwd: '/work' },
    })
    expect(shell).toEqual({ name: 'shell', arguments: { command: 'rm -rf build', cwd: '/work' } })
    if (shell === undefined) throw new Error('a Codex command approval must project one call')
    expect(await nativeToolDenial(shell, { settings })).toContain('command policy')
    const [patched] = nativeCallsFromPermission({
      toolName: 'native',
      method: 'item/fileChange/requestApproval',
      detail: { fileChanges: { '/work/.env': {} } },
    })
    if (patched === undefined) throw new Error('a Codex file approval must project one call per changed path')
    expect(await nativeToolDenial(patched, { settings })).toContain('credential guard')
    // Plan Mode is the protection that reads a *tool name*, so it is the one that
    // stays off longest when the projection goes wrong: an ordinary Codex write is
    // refused during Plan Mode exactly as a Harness `write` is.
    const [ordinary] = nativeCallsFromPermission({
      toolName: 'native',
      method: 'item/fileChange/requestApproval',
      detail: { fileChanges: { '/work/src/a.ts': {} } },
    })
    if (ordinary === undefined) throw new Error('an ordinary Codex file approval must project one call')
    expect(await nativeToolDenial(ordinary, { settings, planMode: { mode: 'plan' } })).toContain('Plan Mode')
    // The Claude shape is unaffected: it names a tool and sends no App Server
    // method, so the name is the only thing there is to judge by.
    expect(nativeCallsFromPermission({ toolName: 'Bash', detail: { toolName: 'Bash', input: { command: 'ls' } } }))
      .toEqual([{ name: 'bash', arguments: { command: 'ls' } }])
  })

  it('reads the command through the decode the Harness guard uses', async () => {
    // A stringy payload is the session-event shape, and the decode is what keeps
    // it from reading as "this call has no command" and going unpoliced.
    expect(await nativeToolDenial(nativeToolCall('Bash', '{"command":"rm -rf build"}'), { settings }))
      .toContain('command policy')
  })

  it('takes the shell vocabulary from the Harness guard rather than restating it', () => {
    // One policy, one list. This file's own contract is that its tiers mirror
    // `freeCodeGoToolGuard`, and the engine guard used to carry its own copy of
    // the three names — so a shell tool added to the Harness guard would have
    // left this path unpoliced. No behavioural test can see two lists agreeing,
    // so the agreement is asserted on the source instead.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'native-tool-guard.ts'), 'utf8')
    // No shell-tool name is compared here any more: the vocabulary and the
    // decode both belong to the helper.
    expect(source).not.toMatch(/===\s*'(?:bash|shell|exec_command)'/)
    expect(source).toContain('bashCommandOf(call.name, call.arguments)')
  })

  it('refuses file changes during Plan Mode', async () => {
    const planMode = { mode: 'plan' as const }
    expect(await nativeToolDenial(nativeToolCall('Write', { file_path: '/work/a.ts' }), { settings, planMode }))
      .toContain('Plan Mode')
    expect(await nativeToolDenial(nativeToolCall('apply_patch', { path: '/work/a.ts' }), { settings, planMode }))
      .toContain('Plan Mode')
    // Gathering truth stays allowed: reading is not a mutation.
    expect(await nativeToolDenial(nativeToolCall('Read', { file_path: '/work/a.ts' }), { settings, planMode })).toBeUndefined()
    // Outside Plan Mode the same write is left to the engine approval.
    expect(await nativeToolDenial(nativeToolCall('Write', { file_path: '/work/a.ts' }), { settings, planMode: { mode: 'execute' } })).toBeUndefined()
  })

  it('honours the same settings that disable the Harness guards', async () => {
    expect(await nativeToolDenial(nativeToolCall('Read', { file_path: '/work/.env' }), { settings: () => ({ envReadGuardEnabled: false }) }))
      .toBeUndefined()
    expect(await nativeToolDenial(nativeToolCall('Bash', { command: 'rm -rf build' }), { settings: () => ({ commandPolicyEnabled: false }) }))
      .toBeUndefined()
    expect(await nativeToolDenial(nativeToolCall('Write', { file_path: '/work/a.ts' }), {
      settings: () => ({ planModeEnabled: false }),
      planMode: { mode: 'plan' },
    })).toBeUndefined()
  })

  it('never refuses a call it has no rule for', async () => {
    expect(await nativeToolDenial(nativeToolCall('Grep', { pattern: 'TODO' }), { settings })).toBeUndefined()
    expect(await nativeToolDenial(nativeToolCall('WebFetch', { url: 'https://example.test' }), { settings })).toBeUndefined()
  })
})

/**
 * One call, two guards, one verdict.
 *
 * The module's contract is that both paths judge a call the same way — the
 * registry guard for Harness tools, this module's tiers for the engines' own
 * tools — and nothing compared them. That is exactly where the projection bug
 * lived: the Codex transport was judged as an unknown tool with no arguments
 * while the registry denied the very same command, and both specs passed on their
 * own. Every row below is therefore expressed twice, once per vocabulary, and the
 * engine side is written in the *transport's* shape rather than as a projected
 * call, because the projection is one of the two things being compared.
 */
describe('the two guard paths agree', () => {
  const settings = () => undefined
  const planView = { modeFor: () => 'plan' as const }

  /** The registry verdict for one Harness call, through a fresh guard. */
  const registryVerdict = (name: string, args: Record<string, unknown>, plan = false): string | undefined =>
    freeCodeGoToolGuard({
      settings,
      doomLoop: new DoomLoopGuard(),
      policy: COMPILED_BUILT_IN_COMMAND_POLICY,
      ...(plan ? { planMode: { ...planView, policy: COMPILED_BUILT_IN_COMMAND_POLICY } } : {}),
    })({ name, arguments: args, callId: 'call-1' } as never)

  /** The engine verdict for the same call, from the request its transport sends. */
  const engineVerdict = async (
    request: { readonly toolName?: unknown; readonly method?: unknown; readonly detail?: unknown },
    plan = false,
  ): Promise<string | undefined> => {
    const [call] = nativeCallsFromPermission(request)
    if (call === undefined) return undefined
    return await nativeToolDenial(call, {
      settings,
      ...(plan ? { planMode: { mode: 'plan' as const, policy: COMPILED_BUILT_IN_COMMAND_POLICY } } : {}),
    })
  }

  const rows: readonly {
    readonly what: string
    readonly harness: { readonly name: string; readonly arguments: Record<string, unknown> }
    readonly engine: { readonly toolName?: unknown; readonly method?: unknown; readonly detail?: unknown }
    readonly plan?: boolean
    /** The text both verdicts must contain, or `undefined` when both must allow. */
    readonly refusal?: string
  }[] = [
    {
      what: 'reading a credential file',
      harness: { name: 'read', arguments: { path: '/work/.env' } },
      engine: { toolName: 'Read', detail: { toolName: 'Read', input: { file_path: '/work/.env' } } },
      refusal: 'credential guard',
    },
    {
      what: 'a command the policy forbids',
      harness: { name: 'bash', arguments: { command: 'rm -rf build' } },
      engine: { toolName: 'native', method: 'item/commandExecution/requestApproval', detail: { command: 'rm -rf build' } },
      refusal: 'command policy',
    },
    {
      what: 'a privilege escalation whose first argument is a program, not one of sudos own flags',
      harness: { name: 'bash', arguments: { command: 'sudo apt-get update' } },
      engine: { toolName: 'Bash', detail: { toolName: 'Bash', input: { command: 'sudo apt-get update' } } },
      refusal: 'command policy',
    },
    {
      what: 'a forbidden command behind a launcher word',
      harness: { name: 'bash', arguments: { command: 'timeout 30 rm -rf build' } },
      engine: { toolName: 'Bash', detail: { toolName: 'Bash', input: { command: 'timeout 30 rm -rf build' } } },
      refusal: 'command policy',
    },
    {
      what: 'that launcher word on the Codex transport',
      harness: { name: 'bash', arguments: { command: 'timeout 30 rm -rf build' } },
      engine: { toolName: 'native', method: 'item/commandExecution/requestApproval', detail: { command: 'timeout 30 rm -rf build' } },
      refusal: 'command policy',
    },
    {
      what: 'an environment dump behind a launcher word',
      harness: { name: 'bash', arguments: { command: 'time printenv' } },
      engine: { toolName: 'Bash', detail: { toolName: 'Bash', input: { command: 'time printenv' } } },
      refusal: 'credential guard',
    },
    {
      what: 'an environment dump behind a launcher with an operand',
      harness: { name: 'bash', arguments: { command: 'timeout 5 printenv' } },
      engine: { toolName: 'Bash', detail: { toolName: 'Bash', input: { command: 'timeout 5 printenv' } } },
      refusal: 'credential guard',
    },
    {
      what: 'a file change while planning',
      harness: { name: 'write', arguments: { path: '/work/a.ts' } },
      engine: { toolName: 'native', method: 'item/fileChange/requestApproval', detail: { fileChanges: { '/work/a.ts': {} } } },
      plan: true,
      refusal: 'Plan Mode',
    },
    {
      what: 'an ordinary read',
      harness: { name: 'read', arguments: { path: '/work/src/a.ts' } },
      engine: { toolName: 'Read', detail: { toolName: 'Read', input: { file_path: '/work/src/a.ts' } } },
    },
    {
      what: 'a tool no rule knows',
      harness: { name: 'some_tool', arguments: {} },
      engine: { toolName: 'SomeTool', detail: {} },
    },
  ]

  for (const row of rows) {
    it(`judges ${row.what} the same way on both paths`, async () => {
      const registry = registryVerdict(row.harness.name, row.harness.arguments, row.plan === true)
      const engine = await engineVerdict(row.engine, row.plan === true)
      if (row.refusal === undefined) {
        expect(registry, `registry: ${row.what}`).toBeUndefined()
        expect(engine, `engine: ${row.what}`).toBeUndefined()
        return
      }
      // Reported together: the failure this catches is the two paths diverging,
      // so which one allowed the call is the whole diagnosis.
      if (registry === undefined || engine === undefined) {
        throw new Error(`both paths must refuse ${row.what}: registry=${String(registry)} engine=${String(engine)}`)
      }
      expect(registry).toContain(row.refusal)
      expect(engine).toContain(row.refusal)
    })
  }
})

/**
 * The doom-loop tier, wired the way the plugin wires it: one guard instance
 * shared with the Harness pipeline, with the calling agent bound in.
 */
describe('native doom-loop tier', () => {
  const settings = () => undefined
  const agent = { id: 'agent-1' }

  /** Repeat one projected call through the real guard and report the first refusal. */
  async function repeat(call: ReturnType<typeof nativeToolCall>, times: number, guard: DoomLoopGuard, overrides: { doomLoopGuardEnabled?: boolean } = {}) {
    for (let index = 0; index < times; index += 1) {
      const denial = await nativeToolDenial(call, {
        settings: () => overrides,
        doomLoop: { deny: projected => guard.deny({ ...projected, agent } as never) },
      })
      if (denial !== undefined) return { denial, at: index + 1 }
    }
    return { denial: undefined, at: times }
  }

  it('refuses the third identical native call in the window', async () => {
    const guard = new DoomLoopGuard({ now: () => 0 })
    const { denial, at } = await repeat(nativeToolCall('Read', { file_path: '/work/a.ts' }), 3, guard)
    expect(at).toBe(3)
    expect(denial).toContain('Doom loop detected')
  })

  it('keeps a native call and a Harness call of the same tool on one fingerprint', async () => {
    // The property the tier exists for: a loop is the agent's behaviour, not the
    // transport's. Two native calls plus one registry call is three identical
    // repetitions by one agent, and must be caught as such.
    const guard = new DoomLoopGuard({ now: () => 0 })
    const native = nativeToolCall('Read', { file_path: '/work/a.ts' })
    await repeat(native, 2, guard)
    const registry = guard.deny({ name: native.name, arguments: native.arguments, agent } as never)
    expect(registry).toContain('Doom loop detected')
    // The reverse order too: the native tier is not a separate space.
    const other = new DoomLoopGuard({ now: () => 0 })
    other.deny({ name: 'read', arguments: { path: '/work/b.ts' }, agent } as never)
    const { at } = await repeat(nativeToolCall('Read', { file_path: '/work/b.ts' }), 2, other)
    expect(at).toBe(2)
  })

  it('does not count a call the plugin bridge already counted', async () => {
    // A Harness tool called from a native session travels the plugin's own MCP
    // bridge, which executes it through `ctx.tools.execute` — the registry guard
    // has already seen it. Counting it here too would halve the threshold and
    // deny a legitimate repeated read.
    const guard = new DoomLoopGuard({ now: () => 0 })
    const bridged = nativeToolCall('mcp__freecodego-host__freecodego_harness_read', { path: '/work/a.ts' })
    expect(isBridgedCall(bridged)).toBe(true)
    const { denial } = await repeat(bridged, 5, guard)
    expect(denial).toBeUndefined()
    // A built-in tool is not bridged, which is the distinction the test rests on.
    expect(isBridgedCall(nativeToolCall('Read', { file_path: '/work/a.ts' }))).toBe(false)
    // Where a bridged read of a credential file is judged: not here, but at the
    // registry, which sees the *inner* Harness name (the bridge strips the
    // `mcp__…` prefix before executing). The monotonic tiers run at this seam too
    // — they simply do not classify a mangled MCP name, and they do not need to.
    expect(await nativeToolDenial(nativeToolCall('mcp__freecodego-host__freecodego_harness_read', { path: '/work/.env' }), { settings }))
      .toBeUndefined()
    expect(await nativeToolDenial(nativeToolCall('read', { path: '/work/.env' }), { settings })).toContain('credential guard')
  })

  it('is skipped by the same switch that disables it on the Harness pipeline', async () => {
    const guard = new DoomLoopGuard({ now: () => 0 })
    const { denial } = await repeat(nativeToolCall('Read', { file_path: '/work/a.ts' }), 5, guard, { doomLoopGuardEnabled: false })
    expect(denial).toBeUndefined()
  })

  it('stays off when the composition has no guard to wire', async () => {
    // No `doomLoop` dep at all: this tier must not invent a guard, and the other
    // tiers must still work.
    expect(await nativeToolDenial(nativeToolCall('Read', { file_path: '/work/a.ts' }), { settings })).toBeUndefined()
    expect(await nativeToolDenial(nativeToolCall('Bash', { command: 'rm -rf build' }), { settings })).toContain('command policy')
  })

  it('reports a policy refusal as policy, never as a loop', async () => {
    // Ordering: the monotonic tiers answer first, so a denied command is never
    // described as a repetition and the model is not sent after the wrong fix.
    const guard = new DoomLoopGuard({ now: () => 0 })
    const call = nativeToolCall('Bash', { command: 'rm -rf build' })
    for (let index = 0; index < 4; index += 1) {
      const denial = await nativeToolDenial(call, { settings, doomLoop: { deny: projected => guard.deny({ ...projected, agent } as never) } })
      expect(denial).toContain('command policy')
      expect(denial).not.toContain('Doom loop')
    }
  })
})
