/**
 * G7 — the hook surface.
 *
 * The tests that matter here are the ones that pin the *rules* rather than the
 * parsing: only an explicit deny blocks, and the four ways a hook can break do
 * not. Everything else is fixture work.
 */

import { describe, expect, test } from 'vitest'

import {
  CURSOR_EVENT_ALIASES,
  HOOK_EVENTS,
  HOOK_INPUT_REWRITE_REFUSAL,
  MAX_HOOK_TIMEOUT_MS,
  collectHookHandlers,
  defaultHookTimeoutMs,
  dispatchHooks,
  matchesHookMatcher,
  parseClaudeHooks,
  parseCursorHooks,
  parseHookDocument,
  parseNativeHooks,
  selectHookHandlers,
  toolNameCandidates,
  type HookDispatchResult,
  type HookEvent,
  type HookHandler,
  type HookInvocation,
  type HookRunner,
} from '../src/hooks/surface.ts'

/** A runner that always returns the same invocation, counting calls. */
function constantRunner(invocation: HookInvocation): { run: HookRunner; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    run: async (handler: HookHandler) => {
      calls.push(handler.command)
      return invocation
    },
  }
}

/** A runner that answers per command. */
function scriptedRunner(table: Record<string, () => Promise<HookInvocation>>): HookRunner {
  return async (handler: HookHandler) => table[handler.command]!()
}

/** Build one handler for a direct dispatch test. */
function handler(event: HookEvent, command = 'run', matcher = ''): HookHandler {
  return { event, matcher, kind: 'command', command, sources: ['project'] }
}

/** Dispatch with a one-handler set for the given event. */
async function dispatchOne(event: HookEvent, invocation: HookInvocation | (() => Promise<HookInvocation>)): Promise<HookDispatchResult> {
  const run: HookRunner = typeof invocation === 'function' ? async () => invocation() : async () => invocation
  return dispatchHooks({ handlers: [handler(event, 'hook')], event, payload: { ok: true }, run })
}

describe('the fifteen events', () => {
  test.each(HOOK_EVENTS.map(event => [event] as const))('%s dispatches and reports its payload', async (event) => {
    const { run, calls } = constantRunner({ exitCode: 0, stdout: '', stderr: '' })
    const result = await dispatchHooks({ handlers: [handler(event)], event, payload: { event }, run })
    expect(calls).toEqual(['run'])
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.status).toBe('ok')
    expect(result.blocked).toBe(false)
  })

  test('there are exactly fifteen, with no duplicates', () => {
    expect(HOOK_EVENTS).toHaveLength(15)
    expect(new Set(HOOK_EVENTS).size).toBe(15)
  })

  test('only events that can gate something use the long timeout', () => {
    // A five-second cap on `Stop` would make the event useless for the build a
    // user writes it to run.
    expect(defaultHookTimeoutMs('Stop')).toBe(600_000)
    expect(defaultHookTimeoutMs('PostToolUse')).toBe(600_000)
    expect(defaultHookTimeoutMs('SessionStart')).toBe(5_000)
  })

  test('every event a tool seam dispatches gets the long timeout, not only the successful one', () => {
    // `seams.ts` installs one `tools/post-execute` listener for *two* events,
    // chosen by `isError`, and hands both the same cancellation. They are one
    // handler with one job, so a five-second budget on the failure spelling
    // would mean a test suite that passes gets ten minutes while the run that
    // *failed* is killed before its hook can say why.
    expect(defaultHookTimeoutMs('PostToolUseFailure')).toBe(600_000)
    // `PreToolUse` is the other tool seam, and the one seam that can refuse.
    // A short cap there is the failure `declaredHookTimeoutMs` warns about: a
    // timed-out hook fails open, so a five-second deadline does not shorten a
    // guard hook, it disables it.
    expect(defaultHookTimeoutMs('PreToolUse')).toBe(600_000)
    // The observing seams gate nothing, and keep the short default.
    expect(defaultHookTimeoutMs('PermissionDenied')).toBe(5_000)
    expect(defaultHookTimeoutMs('Notification')).toBe(5_000)
    expect(defaultHookTimeoutMs('StopFailure')).toBe(5_000)
    expect(defaultHookTimeoutMs('UserPromptSubmit')).toBe(5_000)
  })
})

describe('hook failure output', () => {
  test('masks a credential the failed handler writes to stderr', async () => {
    const leaked = `ghp_${'A'.repeat(36)}`
    const result = await dispatchOne('PreToolUse', { exitCode: 1, stdout: '', stderr: `hook refused request carrying ${leaked}` })

    expect(result.results[0]!.message).toContain('hook refused request carrying')
    expect(result.results[0]!.message).not.toContain(leaked)
  })

  test('masks credentials in successful hook text that reaches the model or result log', async () => {
    const leaked = `ghp_${'A'.repeat(36)}`
    const result = await dispatchOne('PostToolUse', {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        reason: `reviewed with ${leaked}`,
        additionalContext: `context from ${leaked}`,
        replacement: `replacement from ${leaked}`,
      }),
    })

    expect(result.results[0]!.message).not.toContain(leaked)
    expect(result.results[0]!.additionalContexts.join('\n')).not.toContain(leaked)
    expect(result.results[0]!.replacement).not.toContain(leaked)
    expect(result.replacement).not.toContain(leaked)
    expect(result.additionalContexts.join('\n')).not.toContain(leaked)
  })
})

describe('dialects', () => {
  test("parses Claude Code's settings.json shape", () => {
    const parsed = parseClaudeHooks({
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 30 }] },
        { matcher: 'Read|Grep', hooks: [{ type: 'command', command: 'audit.sh' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'verify.sh' }] }],
    })
    expect(parsed.warnings).toEqual([])
    // `timeout: 30` is thirty SECONDS — the wire unit both dialects share, and
    // what the protocol's own runner multiplies by 1000. Reading it as
    // milliseconds gave this hook a 30ms deadline, which is not a shorter hook
    // run but a hook that never runs: killed before its shell could start,
    // recorded as a timeout, and failing open, so its `deny` was never applied.
    expect(parsed.handlers).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', kind: 'command', command: 'guard.sh', timeoutMs: 30_000, sources: ['config'] },
      { event: 'PreToolUse', matcher: 'Read|Grep', kind: 'command', command: 'audit.sh', sources: ['config'] },
      { event: 'Stop', matcher: '', kind: 'command', command: 'verify.sh', sources: ['config'] },
    ])
  })

  test('reads the unit from the key spelling, and never lets a deadline overflow', () => {
    const parsed = parseClaudeHooks({
      PreToolUse: [
        // The wire spelling is seconds; the explicit spelling is milliseconds and
        // wins when both are given, whatever order they arrive in.
        { hooks: [{ type: 'command', command: 'seconds.sh', timeout: 2 }] },
        { hooks: [{ type: 'command', command: 'millis.sh', timeoutMs: 250 }] },
        { hooks: [{ type: 'command', command: 'both.sh', timeout: 3, timeoutMs: 400 }] },
        { hooks: [{ type: 'command', command: 'absurd.sh', timeout: 300_000_000 }] },
      ],
    })
    expect(parsed.handlers.map(handler => [handler.command, handler.timeoutMs])).toEqual([
      ['seconds.sh', 2_000],
      ['millis.sh', 250],
      ['both.sh', 400],
      // A delay past the largest a timer can hold would fire *immediately* — the
      // smallest possible deadline out of the largest declared one — so it is
      // capped and said out loud rather than traded for its opposite.
      ['absurd.sh', MAX_HOOK_TIMEOUT_MS],
    ])
    expect(parsed.warnings).toEqual([
      expect.stringContaining('capped at 2147483647ms') as unknown as string,
    ])
  })

  test("parses Cursor's hooks.json camelCase shape", () => {
    const parsed = parseCursorHooks({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: './deny-rm.sh', matcher: 'Bash' }],
        afterFileEdit: [{ command: './format.sh' }],
        stop: [{ command: './verify.sh' }],
      },
    })
    expect(parsed.warnings).toEqual([])
    expect(parsed.handlers.map(entry => [entry.event, entry.matcher, entry.command])).toEqual([
      ['PreToolUse', 'Bash', './deny-rm.sh'],
      ['PostToolUse', '', './format.sh'],
      ['Stop', '', './verify.sh'],
    ])
  })

  test('skips unknown Cursor events without warning', () => {
    // A shared Cursor file carries events this host has no seam for; warning on
    // each one trains users to ignore the warnings that do matter.
    const parsed = parseCursorHooks({ hooks: { someFutureEvent: [{ command: 'x' }] } })
    expect(parsed.handlers).toEqual([])
    expect(parsed.warnings).toEqual([])
  })

  test('parses our own explicit-event shape, including a bare command string', () => {
    const parsed = parseNativeHooks([
      { event: 'PreToolUse', command: 'guard.sh', matcher: 'bash' },
      { event: 'SessionEnd', command: 'bye.sh' },
    ])
    expect(parsed.warnings).toEqual([])
    expect(parsed.handlers.map(entry => entry.event)).toEqual(['PreToolUse', 'SessionEnd'])
  })

  test('sniffs by structure rather than filename', () => {
    // Users copy and symlink these files; a settings.json under a hooks.json
    // name must still load.
    const claude = parseHookDocument({ source: 'config', path: 'hooks.json', value: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'g.sh' }] }] } } })
    expect(claude.handlers.map(entry => entry.event)).toEqual(['PreToolUse'])

    const cursor = parseHookDocument({ source: 'config', path: 'settings.json', value: { hooks: { beforeShellExecution: [{ command: 'g.sh' }] } } })
    expect(cursor.handlers.map(entry => entry.event)).toEqual(['PreToolUse'])

    const native = parseHookDocument({ source: 'config', path: 'x.json', value: [{ event: 'Stop', command: 'v.sh' }] })
    expect(native.handlers.map(entry => entry.event)).toEqual(['Stop'])
  })

  test('reports an unknown event name with the path that carried it', () => {
    const parsed = parseClaudeHooks({ NotARealEvent: [{ hooks: [{ command: 'x' }] }] }, 'project', '.freecodego/hooks.json')
    expect(parsed.warnings).toEqual(['.freecodego/hooks.json: skipped unknown hook event "NotARealEvent"'])
  })

  test("keeps every one of Cursor's aliases pointing at a real event", () => {
    for (const canonical of Object.values(CURSOR_EVENT_ALIASES)) {
      expect(HOOK_EVENTS).toContain(canonical)
    }
  })
})

describe('matchers', () => {
  test('matches tool names across agents through their families', () => {
    expect(matchesHookMatcher('Bash', 'bash', toolNameCandidates('bash'))).toBe(true)
    expect(matchesHookMatcher('bash', 'Bash', toolNameCandidates('Bash'))).toBe(true)
    expect(matchesHookMatcher('Read', 'read_file', toolNameCandidates('read_file'))).toBe(true)
    expect(matchesHookMatcher('Glob', 'list_dir', toolNameCandidates('list_dir'))).toBe(true)
    expect(matchesHookMatcher('Task', 'subagent', toolNameCandidates('subagent'))).toBe(true)
  })

  test('treats Edit, Write and MultiEdit as one family', () => {
    // grok's measured table collapses them; refusing to match `Write` for a
    // matcher of `Edit` would silently disable the guard the user wrote.
    for (const name of ['Edit', 'Write', 'MultiEdit', 'write_file']) {
      expect(matchesHookMatcher('Edit', name, toolNameCandidates(name))).toBe(true)
    }
  })

  test('matches the byte-patch editor tool this Host registers', () => {
    // `str_replace` is the `command` an editor tool takes; `str_replace_editor` is a
    // tool name this Host registers. A hook guarding file mutation with a matcher of
    // `Edit` has to fire for the latter, or the guard the user wrote is silently
    // absent for the one tool whose whole contract is a byte-exact patch.
    expect(matchesHookMatcher('Edit', 'str_replace_editor', toolNameCandidates('str_replace_editor'))).toBe(true)
    expect(matchesHookMatcher('str_replace_editor', 'write_file', toolNameCandidates('write_file'))).toBe(true)
  })

  test('matches the shell this platform registers, not only the POSIX spelling', () => {
    // Same root cause as the cache-cold list: win32 ships `tool-pwsh` and not
    // `tool-bash`, so a user's `Bash` matcher has to reach `pwsh` through the family.
    // The anchored form is the one that matters — `compileMatcher` anchors its
    // pattern, so without `pwsh` in the family a matcher of `^bash$` reaches nothing
    // on that platform at all.
    expect(matchesHookMatcher('Bash', 'pwsh', toolNameCandidates('pwsh'))).toBe(true)
    expect(matchesHookMatcher('^bash$', 'pwsh', toolNameCandidates('pwsh'))).toBe(true)
  })

  test('matches the Codex spelling of a shell, which the family reached only one of', () => {
    // The third shell. A native Codex session's shell approvals arrive as
    // `shell`/`exec_command` — the same pair `bashCommandOf` and its credential
    // screen carry — and `shell` was already a family member, so the family reached
    // one Codex spelling and not the other. The anchored matcher is the one that
    // shows it: `compileMatcher` anchors its pattern and never matches a prefix, so
    // without `exec_command` a matcher of `^bash$` reached nothing in such a session.
    expect(matchesHookMatcher('Bash', 'exec_command', toolNameCandidates('exec_command'))).toBe(true)
    expect(matchesHookMatcher('^bash$', 'exec_command', toolNameCandidates('exec_command'))).toBe(true)
    // The member that was already there, so the pair is asserted together rather
    // than the new name alone.
    expect(matchesHookMatcher('Bash', 'shell', toolNameCandidates('shell'))).toBe(true)
  })

  test('matches the reader this Host registers for the formats `read` cannot serve', () => {
    // Same reasoning as the write family's `str_replace_editor`, one family over:
    // `read_document` is a tool name this Host registers, not an alias of `read`, and
    // it is the only reader for a PDF or a notebook. A hook written as `Read` — to
    // audit, redact or refuse a file read — therefore reached every text format and
    // silently not those two, because `compileMatcher` anchors and cannot bridge it.
    expect(matchesHookMatcher('Read', 'read_document', toolNameCandidates('read_document'))).toBe(true)
    expect(matchesHookMatcher('^read$', 'read_document', toolNameCandidates('read_document'))).toBe(true)
    // The members that were already there, so the family is asserted as a set.
    expect(matchesHookMatcher('Read', 'read_file', toolNameCandidates('read_file'))).toBe(true)
  })

  test('matches the image reader the base bundle mounts the store for', () => {
    // `@deepseek-ai/dsh-tool-fs` registers `read_image` beside `read`, and the base
    // bundle mounts `attachment-local` (the store its `ctx.inject(['attachments'])`
    // waits on), so it is present in every app built on that bundle. It is the read
    // with the most reason to be guarded and the one a text-shaped matcher is least
    // likely to be written for, which is exactly why the family has to carry it.
    expect(matchesHookMatcher('Read', 'read_image', toolNameCandidates('read_image'))).toBe(true)
    expect(matchesHookMatcher('^read$', 'read_image', toolNameCandidates('read_image'))).toBe(true)
  })

  test('matches every delegation tool the shipped composition enables', () => {
    // Claude Code spells "start a subagent" as `Task`; the freecodego preset mounts
    // `dsh-tool-subagent` four times and names the providers `subagent` /
    // `subagent_fork` / `subagent_codex` / `subagent_claude_code`, with `workflow`
    // and `ralph` beside them. The family named only `subagent`, so a hook written
    // to guard delegation reached the one provider whose spelling it knew. The
    // disabled pair is carried deliberately — which providers are switched on is a
    // deployment's choice, and a member that never arrives costs nothing.
    for (const name of ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'workflow', 'ralph']) {
      expect(matchesHookMatcher('Task', name, toolNameCandidates(name)), `Task must reach ${name}`).toBe(true)
      expect(matchesHookMatcher('^task$', name, toolNameCandidates(name)), `^task$ must reach ${name}`).toBe(true)
    }
    // `send_message` and `interrupt_agent` steer an agent that already exists rather
    // than starting one, so they are deliberately not members: the family answers
    // "does this matcher guard the act of delegating", and a control call is not it.
    expect(matchesHookMatcher('Task', 'send_message', toolNameCandidates('send_message'))).toBe(false)
  })

  test('matches the mutating spellings the native projection actually produces', () => {
    // `native-tool-guard.ts` renames an engine's tool mechanically, so the names
    // that reach a hook are not only the Harness registry's: the Claude Agent SDK's
    // `NotebookEdit` arrives as `notebook_edit` and `tool-guards.ts` says of exactly
    // these names that they are "the spellings this guard is *actually* pointed at".
    // A hook written to guard file mutation reached the editor and the writer and
    // silently not the notebook writer or the deleting tool — the hole the write
    // family's own paragraph describes, one spelling further out.
    for (const name of ['multi_edit', 'notebook_edit', 'notebook_write', 'delete_file', 'move_file', 'fs_write', 'fs_edit']) {
      expect(matchesHookMatcher('Edit', name, toolNameCandidates(name)), `Edit must reach ${name}`).toBe(true)
      expect(matchesHookMatcher('^write$', name, toolNameCandidates(name)), `^write$ must reach ${name}`).toBe(true)
    }
  })

  test('matches every read spelling the sibling lists know, not only the registry\'s', () => {
    // The read half of the same fact. `READ_LIKE_TOOL_NAMES` is documented as "every
    // read-like tool spelling this port knows", and `CREDENTIAL_PATH_TOOLS` carries
    // `fs_read` for the reason its own note gives — the shield has to cover every way
    // a path becomes a file read. A `Read` matcher that reached `read` and not
    // `fs_read` or `view` was a guard the user believed they had.
    for (const name of ['read_file', 'file_read', 'read_document', 'read_image', 'fs_read', 'view', 'readfile', 'cat']) {
      expect(matchesHookMatcher('Read', name, toolNameCandidates(name)), `Read must reach ${name}`).toBe(true)
    }
    // The two families stay separate: a reader is not a mutator, so a hook written
    // to refuse mutation must not be triggered by a read.
    expect(matchesHookMatcher('Edit', 'read_image', toolNameCandidates('read_image'))).toBe(false)
  })

  test('matches the listing spelling the cold-cache list keeps on purpose', () => {
    // `CLEARABLE_TOOL_KINDS` keeps `list_files` because "they are spellings other
    // agents use, and a name with no registration here is inert while a missing one
    // is a hole". The glob family is where that hole would be for a listing matcher.
    expect(matchesHookMatcher('Glob', 'list_files', toolNameCandidates('list_files'))).toBe(true)
    expect(matchesHookMatcher('^glob$', 'list_files', toolNameCandidates('list_files'))).toBe(true)
  })

  test('treats a matcher as a regular expression when it compiles as one', () => {
    expect(matchesHookMatcher('Read|Grep', 'grep', toolNameCandidates('grep'))).toBe(true)
    expect(matchesHookMatcher('^bash$', 'bash', toolNameCandidates('bash'))).toBe(true)
    expect(matchesHookMatcher('^bash$', 'not-bash', toolNameCandidates('not-bash'))).toBe(false)
  })

  test('falls back to a literal when the matcher is not a valid expression', () => {
    expect(matchesHookMatcher('Bash(', 'Bash(', toolNameCandidates('Bash('))).toBe(true)
    expect(matchesHookMatcher('Bash(', 'bash', toolNameCandidates('bash'))).toBe(false)
  })

  test('an empty matcher and a star both match everything', () => {
    expect(matchesHookMatcher('', 'anything')).toBe(true)
    expect(matchesHookMatcher('*', 'anything')).toBe(true)
  })

  test('a compiled matcher does not carry state between calls', () => {
    // A shared RegExp with the `g` flag would match every other call; each name
    // must be tested with a fresh pattern.
    expect(matchesHookMatcher('bash', 'bash', toolNameCandidates('bash'))).toBe(true)
    expect(matchesHookMatcher('bash', 'bash', toolNameCandidates('bash'))).toBe(true)
  })

  test('narrowing by event still leaves the other events alone', () => {
    const handlers = [handler('PreToolUse', 'a', 'bash'), handler('PostToolUse', 'b', 'bash'), handler('Stop', 'c')]
    expect(selectHookHandlers(handlers, 'PreToolUse', 'bash', 'bash').handlers.map(entry => entry.command)).toEqual(['a'])
    expect(selectHookHandlers(handlers, 'PostToolUse', 'bash', 'bash').handlers.map(entry => entry.command)).toEqual(['b'])
  })

  test('a matcher on Stop or UserPromptSubmit is ignored and warned about', () => {
    const stop = selectHookHandlers([handler('Stop', 'c', 'bash')], 'Stop', '')
    expect(stop.handlers.map(entry => entry.command)).toEqual(['c'])
    expect(stop.warnings).toEqual(['a matcher on Stop cannot discriminate anything and was ignored'])

    const prompt = selectHookHandlers([handler('UserPromptSubmit', 'd', 'whatever')], 'UserPromptSubmit', '')
    expect(prompt.handlers).toHaveLength(1)
    expect(prompt.warnings).toHaveLength(1)
  })

  test('the matcher subject follows the event', () => {
    const handlers = [handler('Notification', 'n', 'permission_prompt'), handler('SubagentStart', 's', 'researcher')]
    expect(selectHookHandlers(handlers, 'Notification', 'permission_prompt').handlers).toHaveLength(1)
    expect(selectHookHandlers(handlers, 'Notification', 'idle').handlers).toHaveLength(0)
    expect(selectHookHandlers(handlers, 'SubagentStart', 'researcher').handlers).toHaveLength(1)
    expect(selectHookHandlers(handlers, 'SubagentStart', 'builder').handlers).toHaveLength(0)
  })
})

describe('merging handlers across sources', () => {
  test('dedupes an identical handler and remembers both sources', () => {
    const merged = collectHookHandlers([
      { source: 'global', path: 'g', value: [{ event: 'Stop', command: 'v.sh' }] },
      { source: 'project', path: 'p', value: [{ event: 'Stop', command: 'v.sh' }] },
    ])
    expect(merged.handlers).toHaveLength(1)
    expect(merged.handlers[0]!.sources).toEqual(['global', 'project'])
  })

  test('runs wider sources first so the most specific declaration has the last word', () => {
    const merged = collectHookHandlers([
      { source: 'config', path: 'c', value: [{ event: 'PreToolUse', command: 'config.sh' }] },
      { source: 'global', path: 'g', value: [{ event: 'PreToolUse', command: 'global.sh' }] },
      { source: 'project', path: 'p', value: [{ event: 'PreToolUse', command: 'project.sh' }] },
    ])
    expect(merged.handlers.map(entry => entry.command)).toEqual(['global.sh', 'project.sh', 'config.sh'])
  })

  test('a duplicate handler keeps the deadline the more specific declaration asked for', async () => {
    // Identity is event+matcher+kind+command, so the deadline is the one field a
    // merge has to decide — and it used to be decided by accident. The first
    // document in precedence order won, which is the *widest* declaration there is,
    // so a project's longer deadline for a command it shares with a global file was
    // silently replaced by the global one. A too-short deadline is not the safe pick
    // here: the hook is killed, recorded as a timeout, and fails open, so the guard
    // silently stops guarding — the same asymmetry `declaredHookTimeoutMs` documents
    // for the seconds/milliseconds reading.
    const merged = collectHookHandlers([
      { source: 'global', path: 'g', value: [{ event: 'Stop', command: 'v.sh', timeout: 30 }] },
      { source: 'project', path: 'p', value: [{ event: 'Stop', command: 'v.sh', timeout: 600 }] },
    ])
    // Still one handler: the identity is what stops a shared command running twice.
    expect(merged.handlers).toHaveLength(1)
    expect(merged.handlers[0]!.sources).toEqual(['global', 'project'])
    expect(merged.handlers[0]!.timeoutMs).toBe(600_000)
    // And the deadline the merge settled on is the one the runner is handed.
    const seen: number[] = []
    await dispatchHooks({
      handlers: merged.handlers,
      event: 'Stop',
      payload: {},
      run: async (_handler, _payload, timeoutMs) => {
        seen.push(timeoutMs)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    expect(seen).toEqual([600_000])
  })

  test('a specific declaration that names no deadline leaves the wider one in place', () => {
    // The other direction: the merge must not drop a declared deadline just because
    // the more specific file relied on the default. Reverting to the event default
    // would silently shorten a deadline that someone did write down.
    const merged = collectHookHandlers([
      { source: 'global', path: 'g', value: [{ event: 'Stop', command: 'v2.sh', timeout: 30 }] },
      { source: 'project', path: 'p', value: [{ event: 'Stop', command: 'v2.sh' }] },
    ])
    expect(merged.handlers[0]!.timeoutMs).toBe(30_000)
  })

  test('carries every document warning through the merge', () => {
    const merged = collectHookHandlers([
      { source: 'project', path: 'p', value: { Bogus: [{ hooks: [{ command: 'x' }] }] } },
    ])
    expect(merged.warnings).toEqual(['p: skipped unknown hook event "Bogus"'])
  })
})

describe('fail-open: nothing but an explicit deny blocks', () => {
  test('a non-zero exit does not block', async () => {
    const result = await dispatchOne('PreToolUse', { exitCode: 3, stdout: '', stderr: 'boom' })
    expect(result.blocked).toBe(false)
    expect(result.results[0]!.status).toBe('failed')
    expect(result.results[0]!.message).toBe('boom')
  })

  test('finds the decision after a log line that is itself JSON', async () => {
    // `lastJsonLine` exists for hooks that log and then decide, and the fast path
    // that tried the whole output first skipped it for anything starting with `{`.
    // A hook whose *log* line is JSON — `{"level":"debug",…}`, which is what a
    // structured logger prints — therefore made the whole output unparseable, the
    // decision in the last line was never read, and the handler was recorded as
    // `malformed`. That fails open, so a PreToolUse deny silently did not happen.
    const result = await dispatchOne('PreToolUse', {
      exitCode: 0,
      stdout: '{"level":"debug","msg":"checking"}\n{"decision":"deny","reason":"nope"}',
      stderr: '',
    })
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('nope')
    expect(result.results[0]!.status).toBe('ok')
  })

  test('does the same when the log object is pretty-printed', async () => {
    // The same defect one shape over: a pretty-printed log object also starts with
    // `{` and does not parse as one document with the decision that follows it.
    const result = await dispatchOne('PreToolUse', {
      exitCode: 0,
      stdout: '{\n  "level": "debug"\n}\n{\n  "decision": "deny",\n  "reason": "nope"\n}',
      stderr: '',
    })
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('nope')
  })

  test('still reads a decision that is one pretty-printed object', async () => {
    const result = await dispatchOne('PreToolUse', {
      exitCode: 0,
      stdout: '{\n  "decision": "deny",\n  "reason": "nope"\n}',
      stderr: '',
    })
    expect(result.blocked).toBe(true)
  })

  test('malformed JSON does not block', async () => {
    const result = await dispatchOne('PreToolUse', { exitCode: 0, stdout: 'not json at all', stderr: '' })
    expect(result.blocked).toBe(false)
    expect(result.results[0]!.status).toBe('malformed')
  })

  test('JSON that is not an object does not block', async () => {
    const result = await dispatchOne('PreToolUse', { exitCode: 0, stdout: '[1,2,3]', stderr: '' })
    expect(result.blocked).toBe(false)
    expect(result.results[0]!.status).toBe('malformed')
  })

  test('a throw does not block', async () => {
    const result = await dispatchOne('PreToolUse', () => Promise.reject(new Error('spawn failed')))
    expect(result.blocked).toBe(false)
    expect(result.results[0]!.status).toBe('unavailable')
  })

  test('a timeout does not block', async () => {
    const abort = new Error('timed out')
    abort.name = 'AbortError'
    const result = await dispatchOne('PreToolUse', () => Promise.reject(abort))
    expect(result.blocked).toBe(false)
    expect(result.results[0]!.status).toBe('timeout')
  })

  test('an empty stdout is a no-op, not a failure', async () => {
    const result = await dispatchOne('PreToolUse', { exitCode: 0, stdout: '   ', stderr: '' })
    expect(result.results[0]!.status).toBe('ok')
    expect(result.blocked).toBe(false)
  })

  test('a failing handler does not stop the handlers after it', async () => {
    const run = scriptedRunner({
      bad: async () => ({ exitCode: 1, stdout: '', stderr: 'nope' }),
      good: async () => ({ exitCode: 0, stdout: JSON.stringify({ additionalContext: 'seen' }), stderr: '' }),
    })
    const result = await dispatchHooks({
      handlers: [handler('PreToolUse', 'bad'), handler('PreToolUse', 'good')],
      event: 'PreToolUse',
      payload: {},
      run,
    })
    expect(result.results.map(entry => entry.status)).toEqual(['failed', 'ok'])
    expect(result.additionalContexts).toEqual(['seen'])
  })

  test('hooks that log before deciding are still understood', async () => {
    const run = constantRunner({ exitCode: 0, stdout: 'warming up...\n{"decision":"allow"}', stderr: '' })
    const result = await dispatchHooks({ handlers: [handler('PreToolUse')], event: 'PreToolUse', payload: {}, run: run.run })
    expect(result.results[0]!.status).toBe('ok')
  })
})

describe('explicit deny', () => {
  test.each([
    ['PreToolUse'],
    ['UserPromptSubmit'],
    ['Stop'],
  ] as const)('%s can deny', async (event) => {
    const result = await dispatchOne(event, { exitCode: 0, stdout: JSON.stringify({ decision: 'deny', reason: 'no' }), stderr: '' })
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('no')
  })

  test.each([
    // Both are past the moment a block could act on: `PostToolUseFailure` fires when
    // the tool has already failed, and `PermissionDenied` *is* the refusal. A deny
    // verdict on either used to be reported as a block while nothing was stopped —
    // the record said the hook refused and the call had already happened — and the
    // seams observe these two for the same reason (`hooks/seams.ts`). The verdict is
    // still kept, as the finding's message.
    ['PostToolUseFailure'],
    ['PermissionDenied'],
  ] as const)('%s keeps a deny as a finding without pretending to block', async (event) => {
    const result = await dispatchOne(event, { exitCode: 0, stdout: JSON.stringify({ decision: 'deny', reason: 'no' }), stderr: '' })
    expect(result.blocked).toBe(false)
    expect(result.blockReason).toBeUndefined()
    expect(result.results[0]!.message).toBe('no')
  })

  test('accepts the permissionDecision spelling', async () => {
    const result = await dispatchOne('PreToolUse', { exitCode: 0, stdout: JSON.stringify({ permissionDecision: 'deny' }), stderr: '' })
    expect(result.blocked).toBe(true)
  })

  test('a deny on an event that cannot block is recorded but does not block', async () => {
    const result = await dispatchOne('SessionStart', { exitCode: 0, stdout: JSON.stringify({ decision: 'deny' }), stderr: '' })
    expect(result.blocked).toBe(false)
  })

  test('`ask` escalates rather than blocking', async () => {
    const result = await dispatchOne('PreToolUse', { exitCode: 0, stdout: JSON.stringify({ decision: 'ask', reason: 'confirm' }), stderr: '' })
    expect(result.escalated).toBe(true)
    expect(result.blocked).toBe(false)
  })

  test('the first deny wins and later handlers still do not un-deny it', async () => {
    const run = scriptedRunner({
      first: async () => ({ exitCode: 0, stdout: JSON.stringify({ decision: 'deny', reason: 'first' }), stderr: '' }),
      second: async () => ({ exitCode: 0, stdout: JSON.stringify({ decision: 'allow' }), stderr: '' }),
    })
    const result = await dispatchHooks({
      handlers: [handler('PreToolUse', 'first'), handler('PreToolUse', 'second')],
      event: 'PreToolUse',
      payload: {},
      run,
    })
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('first')
  })
})

describe('result replacement', () => {
  test('a PostToolUse handler can replace the model-visible output', async () => {
    const result = await dispatchOne('PostToolUse', { exitCode: 0, stdout: JSON.stringify({ replacement: 'redacted' }), stderr: '' })
    expect(result.replacement).toBe('redacted')
    expect(result.blocked).toBe(false)
  })

  test('the last replacement wins', async () => {
    const run = scriptedRunner({
      one: async () => ({ exitCode: 0, stdout: JSON.stringify({ replacement: 'first' }), stderr: '' }),
      two: async () => ({ exitCode: 0, stdout: JSON.stringify({ replacement: 'second' }), stderr: '' }),
    })
    const result = await dispatchHooks({ handlers: [handler('PostToolUse', 'one'), handler('PostToolUse', 'two')], event: 'PostToolUse', payload: {}, run })
    expect(result.replacement).toBe('second')
  })

  test('additional context is collected from every handler', async () => {
    const run = scriptedRunner({
      one: async () => ({ exitCode: 0, stdout: JSON.stringify({ additionalContexts: ['a', 'b'] }), stderr: '' }),
      two: async () => ({ exitCode: 0, stdout: JSON.stringify({ additionalContext: 'c' }), stderr: '' }),
    })
    const result = await dispatchHooks({ handlers: [handler('PostToolUse', 'one'), handler('PostToolUse', 'two')], event: 'PostToolUse', payload: {}, run })
    expect(result.additionalContexts).toEqual(['a', 'b', 'c'])
  })
})

describe('updatedInput is refused loudly', () => {
  test('produces the explicit refusal rather than silently ignoring it', async () => {
    // The failure this prevents: a hook masking a secret with `updatedInput`
    // appears to have masked it, while the real arguments still ran.
    const result = await dispatchOne('PreToolUse', { exitCode: 0, stdout: JSON.stringify({ updatedInput: { command: 'safe' } }), stderr: '' })
    expect(result.results[0]!.status).toBe('unsupported')
    expect(result.results[0]!.refusedRewrite).toBe(true)
    expect(result.results[0]!.message).toBe(HOOK_INPUT_REWRITE_REFUSAL)
    expect(result.blockReason).toBe(HOOK_INPUT_REWRITE_REFUSAL)
    expect(result.blocked).toBe(true)
  })

  test('the refusal message says what to do instead', () => {
    expect(HOOK_INPUT_REWRITE_REFUSAL).toContain('does not support')
    expect(HOOK_INPUT_REWRITE_REFUSAL).toContain('Remove `updatedInput`')
  })

  test('a rewrite supplied alongside an allow still blocks', async () => {
    // Order matters: a hook that says "allow, and also rewrite" must not have
    // its rewrite dropped while its allow is honored.
    const result = await dispatchOne('PreToolUse', { exitCode: 0, stdout: JSON.stringify({ decision: 'allow', updatedInput: {} }), stderr: '' })
    expect(result.blocked).toBe(true)
  })
})

describe('every handler sees the original input', () => {
  test('the payload handed to each handler is the same object', async () => {
    const seen: unknown[] = []
    const payload = { tool: 'bash', command: 'rm -rf /' }
    const run: HookRunner = async (_handler, received) => {
      seen.push(received)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    await dispatchHooks({ handlers: [handler('PreToolUse', 'a'), handler('PreToolUse', 'b')], event: 'PreToolUse', payload, run })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(payload)
    expect(seen[1]).toBe(payload)
  })
})

describe('a cancelled call stops the dispatch', () => {
  /** A runner that reports the stop the real runners report for a cancellation. */
  const cancellingRunner = (onRun?: (command: string) => void): HookRunner => async (handler: HookHandler) => {
    onRun?.(handler.command)
    throw Object.assign(new Error(`the call this hook guarded was cancelled (${handler.command})`), { name: 'AbortError' })
  }

  test('an already-cancelled call starts no handler at all, and records none', async () => {
    // Not "runs it and then reports failure": a hook guarding a call nobody is
    // waiting for has nothing left to guard, and spawning it would produce a
    // process whose only outcome is a log line saying we declined it.
    const controller = new AbortController()
    controller.abort()
    const ran: string[] = []
    const result = await dispatchHooks({
      handlers: [handler('PreToolUse', 'one'), handler('PreToolUse', 'two')],
      event: 'PreToolUse',
      payload: {},
      run: cancellingRunner((command) => { ran.push(command) }),
      signal: controller.signal,
    })
    expect(ran).toEqual([])
    expect(result.results).toEqual([])
    // Fail open, always: a stop is not a refusal.
    expect(result.blocked).toBe(false)
  })

  test('cancellation while one handler runs is recorded as cancelled, and stops the next', async () => {
    // The distinction is the reader's: a timeout is a fact about the hook (slow,
    // or hung) and sends its author to a deadline; cancellation is a fact about
    // the turn, and no deadline would have helped. The moment that matters is the
    // one *between* two handlers, which is why the check is inside the loop.
    const controller = new AbortController()
    const ran: string[] = []
    const result = await dispatchHooks({
      handlers: [handler('PreToolUse', 'one'), handler('PreToolUse', 'two')],
      event: 'PreToolUse',
      payload: {},
      run: cancellingRunner((command) => { ran.push(command); controller.abort() }),
      signal: controller.signal,
    })
    // The first one ran and was told to stop; the second never started.
    expect(ran).toEqual(['one'])
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.status).toBe('cancelled')
    expect(result.blocked).toBe(false)
  })

  test('the same AbortError without a cancelled call is still a timeout', async () => {
    // The control: both reach the dispatch as an `AbortError`, and only the
    // caller knows which stop it was.
    const result = await dispatchHooks({
      handlers: [handler('PreToolUse', 'one')],
      event: 'PreToolUse',
      payload: {},
      run: cancellingRunner(),
    })
    expect(result.results[0]?.status).toBe('timeout')
  })
})
