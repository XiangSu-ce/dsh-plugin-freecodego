/**
 * The hook runners that touch the world.
 *
 * `hook-surface.spec.ts` tests the contract with an injected runner, which is what
 * makes the dispatch rules testable without a process. That injection is also what
 * left the two real runners — `commandHookRunner` and `httpHookRunner` — with no test
 * of their own, and they are where the failures a contract test cannot see live:
 *
 * 1. **A handler that prints without bound.** Output is accumulated by appending to a
 *    string, and a V8 string has a maximum length (~536M characters, measured) past
 *    which `+=` throws `RangeError`. That throw happens inside the stream's `data`
 *    handler, which is outside every promise in the module, so it is an uncaught
 *    exception that ends the agent process. The timeout bounds time, not bytes: a
 *    gating hook may run for ten minutes.
 * 2. **A handler that has to be stopped.** The deadline has to actually end the child
 *    (and, on Windows, its tree), and it has to be reported as a timeout rather than
 *    as a failure.
 *
 * The commands below are `node -e` one-liners so the cases need no fixture and no
 * platform-specific binary. The spawn happens inside the module under test; the
 * builtins imported here are only for the marker files those one-liners write,
 * because "the process was killed" and "the process never started" are different
 * claims and a returned value cannot tell them apart.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { commandHookRunner, httpHookRunner } from '../src/hooks/runtime.ts'
import { MAX_HOOK_OUTPUT_CHARS, dispatchHooks, type HookHandler } from '../src/hooks/surface.ts'

/** Wait, for the cases whose claim is about what did *not* happen afterwards. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * A one-liner that writes a marker file after a delay.
 *
 * The path arrives through the environment rather than the command text: a
 * Windows path inside a shell-quoted `node -e` is three layers of quoting, and
 * the interesting part of these cases is not the quoting.
 */
function markerCommand(delayMs: number): string {
  return `node -e "setTimeout(() => require('fs').writeFileSync(process.env.FREECODEGO_HOOK_MARKER, 'ran'), ${delayMs})"`
}

/** A command handler over one shell line. */
function commandHandler(command: string, timeoutMs?: number): HookHandler {
  return {
    event: 'PreToolUse',
    matcher: '',
    kind: 'command',
    command,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    // `global` is this vocabulary's name for the user's own files; the runners read
    // nothing about the source, so which tier declared the handler does not matter
    // to what these cases assert.
    sources: ['global'],
  }
}

/** A URL handler; the fetch is injected, so nothing here reaches the network. */
function httpHandler(command: string): HookHandler {
  return { event: 'PreToolUse', matcher: '', kind: 'http', command, sources: ['global'] }
}

describe('commandHookRunner', () => {
  it("reports a child's exit code and stdout", async () => {
    // The spawn path itself: `shell: true` on a one-liner that prints a decision.
    const invocation = await commandHookRunner(
      // Single-quoted TS strings holding a double-quoted shell argument: the escapes
      // are what the repo's quote rule allows, a template literal is not.
      commandHandler('node -e "process.stdout.write(JSON.stringify({decision:\'allow\'}))"'),
      { tool: 'edit' },
      20_000,
    )
    expect(invocation.exitCode).toBe(0)
    expect(JSON.parse(invocation.stdout)).toStrictEqual({ decision: 'allow' })
    // Reported as a fact rather than omitted, so a caller can read the field without
    // deciding what its absence would have meant.
    expect(invocation.truncated).toBe(false)
  })

  it('caps a handler that prints far more than a decision needs', async () => {
    // 2 MB, which is over the cap and nowhere near the engine's string limit: the
    // case asserts the cap, not the crash the cap exists to prevent.
    const invocation = await commandHookRunner(
      commandHandler('node -e "process.stdout.write(\'x\'.repeat(2000000))"'),
      {},
      30_000,
    )
    expect(invocation.stdout.length).toBe(MAX_HOOK_OUTPUT_CHARS)
    expect(invocation.truncated).toBe(true)
    // And the shortening is stated, so a hook author is not left guessing why the
    // rest of their payload had no effect.
    expect(invocation.stderr).toContain('discarded')
  })

  it('ends a handler that runs past its deadline, and says it was a timeout', async () => {
    // 200ms against a child that sleeps for five seconds: the margin is what keeps
    // this from being a test that fails on a busy machine.
    const started = Date.now()
    await expect(
      commandHookRunner(commandHandler('node -e "setTimeout(() => {}, 5000)"'), {}, 200),
    ).rejects.toThrow('hook timed out after 200ms')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('reports a shell that cannot start as a non-zero exit rather than a throw', async () => {
    // Fail open: a handler that cannot run is recorded, not propagated. 127 is the
    // shell's own "command not found", and nothing on PATH is named this.
    const invocation = await commandHookRunner(
      commandHandler('freecodego-no-such-program-for-this-test --please'),
      {},
      20_000,
    )
    expect(invocation.exitCode).not.toBe(0)
  })
})

describe('httpHookRunner', () => {
  it("reports a 2xx body as the handler's stdout", async () => {
    const invocation = await httpHookRunner(
      httpHandler('https://hooks.example/policy'),
      { tool: 'edit' },
      5_000,
      async () => new Response('{"decision":"allow"}', { status: 200 }),
    )
    expect(invocation).toMatchObject({ exitCode: 0, stdout: '{"decision":"allow"}' })
  })

  it('caps a body that is larger than any decision needs', async () => {
    // The same cap as the command runner, for the same reason: an endpoint that
    // streams megabytes would otherwise be buffered whole.
    const body = 'y'.repeat(MAX_HOOK_OUTPUT_CHARS + 1_000)
    const invocation = await httpHookRunner(
      httpHandler('https://hooks.example/policy'),
      {},
      5_000,
      async () => new Response(body, { status: 200 }),
    )
    expect(invocation.stdout.length).toBe(MAX_HOOK_OUTPUT_CHARS)
    expect(invocation.truncated).toBe(true)
    expect(invocation.stderr).toContain('discarded')
  })

  it('treats a non-2xx answer as a failure and not as a deny', async () => {
    // An unreachable policy service must not become a way to stop every tool call.
    const invocation = await httpHookRunner(
      httpHandler('https://hooks.example/policy'),
      {},
      5_000,
      async () => new Response('service unavailable', { status: 503 }),
    )
    expect(invocation.exitCode).toBe(1)
    expect(invocation.stderr).toContain('503')
  })
})

describe('a truncated handler in a dispatch', () => {
  it('names truncation rather than blaming the JSON', async () => {
    // The end of the path: a handler that overran has output that is not JSON, and
    // saying only that sends its author looking at their JSON rather than at the
    // volume of what they printed. Fail open either way — the turn continues.
    const result = await dispatchHooks({
      handlers: [httpHandler('https://hooks.example/policy')],
      event: 'PreToolUse',
      payload: {},
      run: async () => ({ exitCode: 0, stdout: 'z'.repeat(MAX_HOOK_OUTPUT_CHARS), stderr: '', truncated: true }),
    })
    expect(result.blocked).toBe(false)
    expect(result.results[0]?.status).toBe('malformed')
    expect(result.results[0]?.message).toContain('truncated')
    expect(result.results[0]?.message).toContain(String(MAX_HOOK_OUTPUT_CHARS))
  })
})

describe('the cap is enforced while reading, not after', () => {
  it('stops pulling a body at the cap instead of buffering it whole', async () => {
    // `await response.text()` reads the entire body into one string and *then*
    // lets anyone slice it — which is the buffering the cap exists to prevent,
    // and past the engine's string limit it is a throw inside the decode rather
    // than a shortened payload. Measured against a local endpoint streaming
    // 64 MiB, that path pulled all of it in. The assertions below are the ones a
    // slice-after-the-fact cannot satisfy: the stream is cancelled, and the
    // sender never gets to push everything it had.
    const CHUNK_BYTES = 64 * 1024
    const AVAILABLE_CHUNKS = 400
    let pulled = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= AVAILABLE_CHUNKS) { controller.close(); return }
        pulled += 1
        controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(0x79))
      },
      cancel() { cancelled = true },
    })
    const invocation = await httpHookRunner(
      httpHandler('https://hooks.example/policy'),
      {},
      10_000,
      async () => new Response(body, { status: 200 }),
    )
    expect(invocation.stdout.length).toBe(MAX_HOOK_OUTPUT_CHARS)
    expect(invocation.truncated).toBe(true)
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(AVAILABLE_CHUNKS)
  })
})

describe('a cancelled call', () => {
  it('never spawns a command handler it was already cancelled under', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'freecodego-hook-cancel-'))
    const marker = join(directory, 'spawned')
    const controller = new AbortController()
    controller.abort()
    try {
      await expect(
        commandHookRunner(commandHandler(markerCommand(0)), {}, 20_000, { FREECODEGO_HOOK_MARKER: marker }, controller.signal),
      ).rejects.toThrow(/cancelled/)
      // The stronger half: a rejection alone would also come from spawning and
      // then killing, and the claim is that no process existed to kill.
      await sleep(500)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('ends a running handler the moment the call is cancelled, well inside its deadline', async () => {
    // The gating default is ten minutes; the stop has to be what ends this, not
    // the deadline. The marker is the second claim: the child was killed, not
    // merely abandoned with its side effect still coming.
    const directory = mkdtempSync(join(tmpdir(), 'freecodego-hook-cancel-'))
    const marker = join(directory, 'survived')
    const controller = new AbortController()
    try {
      const started = Date.now()
      setTimeout(() => { controller.abort() }, 200)
      await expect(
        commandHookRunner(commandHandler(markerCommand(4_000)), {}, 600_000, { FREECODEGO_HOOK_MARKER: marker }, controller.signal),
      ).rejects.toThrow(/cancelled/)
      expect(Date.now() - started).toBeLessThan(3_000)
      await sleep(4_500)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('does not issue a request it was already cancelled under', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await expect(
      httpHookRunner(httpHandler('https://hooks.example/policy'), {}, 5_000, async () => {
        calls += 1
        return new Response('{}', { status: 200 })
      }, controller.signal),
    ).rejects.toThrow(/cancelled/)
    expect(calls).toBe(0)
  })
})
