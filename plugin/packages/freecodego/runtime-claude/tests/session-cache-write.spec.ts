import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query,
}))

import { openClaudeRootRuntime } from '../src/index.ts'
import { sdkSessionFromCache } from '../src/sdk-session-cache.ts'

/**
 * The resume cache is bookkeeping, not part of a turn's outcome.
 *
 * Once the SDK has produced its answer the turn is complete: these cases pin
 * that a cache write which cannot land still leaves the prompt resolved (the
 * Agent would otherwise record a finished turn as failed and drop the answer it
 * already streamed), and that the write is attempted at all — a cache that is
 * never written would make every later turn start a fresh SDK conversation.
 */

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  query.mockReset()
})

/** One successful SDK turn: init (which names the SDK session) then a result. */
function succeedingTurn() {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-session-1' }
      yield { type: 'result', subtype: 'success', result: 'the answer' }
    },
  }
}

async function openSession(stateDirectory: string, events: { readonly method: string; readonly params: Record<string, unknown> }[]) {
  return await openClaudeRootRuntime({ stateDirectory }, {
    harnessSessionId: 'claude-cache',
    // Pinned so the cache entry this turn writes can be read back by name.
    nativeSessionId: 'claude-cache-session',
    modelId: 'claude-test',
    provider: 'test',
    workspace: process.cwd(),
    artifactDigest: 'test-artifact',
    protocolAbi: 'freecodego-agent/1',
    onEvent: (event) => { events.push({ method: event.method, params: event.params }) },
  })
}

describe('Claude SDK session cache write', () => {
  it('keeps a completed turn completed when the cache file cannot be written', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'freecodego-claude-cache-'))
    created.push(stateDirectory)
    // `saveSdkSessionMap` writes through `<target>.<pid>.tmp`; a directory in
    // that exact place makes the write fail the way a full or read-only state
    // directory would, without needing to chmod anything.
    await mkdir(join(stateDirectory, `sdk-session-ids.json.${process.pid}.tmp`), { recursive: true })
    query.mockImplementation(() => succeedingTurn())
    const events: { readonly method: string; readonly params: Record<string, unknown> }[] = []
    const session = await openSession(stateDirectory, events)

    await expect(session.prompt('do the work')).resolves.toBeUndefined()
    // The turn announced both of these *before* the write was attempted, so a
    // prompt that fails on the write contradicts what it already reported.
    expect(events.find(entry => entry.method === 'session/completed')?.params).toMatchObject({ status: 'completed' })
    expect(events.find(entry => entry.method === 'assistant/final')?.params).toMatchObject({ text: 'the answer' })
  })

  it('writes the SDK session id of a completed turn for the next resume', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'freecodego-claude-cache-'))
    created.push(stateDirectory)
    query.mockImplementation(() => succeedingTurn())
    const session = await openSession(stateDirectory, [])

    await session.prompt('do the work')

    // Read it back through the production reader, so this case also covers the
    // file being where the next turn looks for it.
    const raw: unknown = JSON.parse(await readFile(join(stateDirectory, 'sdk-session-ids.json'), 'utf8'))
    expect(sdkSessionFromCache(raw, 'claude-cache-session')).toBe('sdk-session-1')
  })
})
