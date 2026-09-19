/**
 * What a turn capture reads out of the session log.
 *
 * `captureTurn` is handed the whole session log and has to decide where this
 * session's own work begins. A forked session (`agents.create({ seed,
 * inheritedEventCount })`, which the desktop's fork/rewind action uses) starts
 * its log with the parent's events, so a capture that begins at 0 records the
 * parent's tool calls as the fork's own evidence — an attribution the parent's
 * own session already made, duplicated under turn numbers that belong to the
 * fork, and impossible to tell apart from real work afterwards.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FreeCodeGoEngineeringRegistry } from '../src/engineering.ts'

const directories: string[] = []
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  // `delete`, not `= undefined`: an assigned `undefined` becomes the literal
  // string "undefined", which resolved the home to `<cwd>/undefined` and left
  // that directory in the repository after every run.
  delete process.env.DSH_HOME
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

interface LoggedEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

interface CapturedObservation {
  readonly body?: string
  readonly sources?: readonly { readonly eventSequence: number; readonly filesWritten: readonly string[] }[]
}

/**
 * A write followed by its result: the result is what carries the written path.
 *
 * The result is built in the shape `Session.append` validates — the call id on
 * `message.source.callId`, the failure flag on the tool-result content block. The
 * flattened `{ callId, message: { isError } }` these fixtures used to carry is
 * what made a reader that looked in exactly those two non-existent places look
 * correct here while matching no live event.
 */
function toolResult(callId: string, isError = false): { readonly type: string; readonly data: unknown } {
  return {
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [], isError }],
      },
    },
  }
}

function write(callId: string, seq: number, path: string): readonly LoggedEvent[] {
  return [
    { seq, type: 'tool/call', data: { callId, name: 'write', arguments: JSON.stringify({ path }) } },
    { seq: seq + 1, ...toolResult(callId) },
  ]
}

/** A read: it names a path too, but it mutates nothing and must not refresh the graph. */
function read(callId: string, seq: number, path: string): readonly LoggedEvent[] {
  return [
    { seq, type: 'tool/call', data: { callId, name: 'read_file', arguments: JSON.stringify({ path }) } },
    { seq: seq + 1, ...toolResult(callId) },
  ]
}

/** Let the fire-and-forget graph refresh reach the engines before asserting on it. */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Replace both code-graph engines with doubles that record what the automatic
 * refresh asks of them.
 *
 * The refresh is fire-and-forget inside `captureTurn`, so observing it means
 * observing the engine call. Which engine is asked is the engines' own answer:
 * `autoUpdateGraphEngine` refreshes only the one whose `status()` reports it as
 * installed, so a double is also how a test says which one that is.
 */
function graphEngines(registry: FreeCodeGoEngineeringRegistry, installed: boolean): { readonly calls: string[] } {
  const calls: string[] = []
  const status = (): Promise<{ readonly installed: boolean; readonly version: string }> => Promise.resolve({ installed, version: 'test' })
  ;(registry as unknown as { graphify: unknown }).graphify = {
    status,
    update: (cwd: string) => { calls.push(`graphify:update:${cwd}`); return Promise.resolve() },
  }
  ;(registry as unknown as { codeGraph: unknown }).codeGraph = {
    status,
    sync: (cwd: string) => { calls.push(`codegraph:sync:${cwd}`); return Promise.resolve() },
  }
  return { calls }
}

function harness(settings: Record<string, unknown> = {}): {
  registry: FreeCodeGoEngineeringRegistry
  captured: CapturedObservation[]
  ready: Promise<void>
} {
  const ctx = { on: () => undefined, get: () => undefined, effect: () => undefined }
  let stored: Record<string, unknown> = { engineeringEnabled: true, engineeringMemoryEnabled: true, ...settings }
  const scope = { get: () => stored, update: async (value: unknown) => { stored = { ...stored, ...(value as Record<string, unknown>) } } }
  const registry = new FreeCodeGoEngineeringRegistry(ctx as never, scope)
  const captured: CapturedObservation[] = []
  const ready = mkdtemp(join(tmpdir(), 'freecodego-capture-home-')).then((directory) => {
    directories.push(directory)
    process.env.DSH_HOME = directory
    // The capture path is memory-gated; this double records what would be
    // enqueued without standing up a store.
    ;(registry as unknown as { memoryAvailable: boolean }).memoryAvailable = true
    ;(registry as unknown as { memory: unknown }).memory = {
      enqueueObservation: (payload: CapturedObservation) => { captured.push(payload); return { queued: true, id: 'out_1' } },
      drainOutbox: () => ({ drained: 0, failed: 0 }),
      consolidateObservation: () => ({ projectId: 'p1', items: [] }),
      close: () => undefined,
    }
  })
  return { registry, captured, ready }
}

/**
 * An agent double whose log is a forked session's: `inherited` events that came
 * from the parent session followed by the events this session produced itself.
 */
function forkedAgent(inherited: readonly LoggedEvent[], own: readonly LoggedEvent[]): Parameters<FreeCodeGoEngineeringRegistry['captureTurnForTest']>[0] {
  const log = [...inherited, ...own]
  return {
    id: 'fork-1',
    session: {
      id: 'fork-1',
      header: { cwd: '/workspace' },
      seq: log.length,
      inheritedEventCount: inherited.length,
      snapshotEvents: (fromSeq?: number) => log.slice(fromSeq ?? 0),
    },
    inject: () => undefined,
  }
}

describe('engineering turn capture', () => {
  it('records only the events a forked session produced itself', async () => {
    const { registry, captured, ready } = harness()
    await ready
    // The parent's work: already recorded on the parent's own session, and never
    // the fork's to claim.
    const agent = forkedAgent(write('parent-1', 0, 'src/inherited.ts'), write('fork-1', 2, 'src/own.ts'))
    try {
      await registry.captureTurnForTest(agent, 1)
      expect(captured).toHaveLength(1)
      expect(captured[0]?.sources?.map(source => source.eventSequence)).toEqual([2, 3])
      expect(captured[0]?.sources?.flatMap(source => [...source.filesWritten])).toEqual(['src/own.ts'])
      expect(captured[0]?.body).toContain('src/own.ts')
      expect(captured[0]?.body).not.toContain('src/inherited.ts')
    } finally {
      await registry.dispose()
    }
  })

  it('refreshes the code graph after a turn that wrote a file, at the session workspace', async () => {
    const { registry, ready } = harness()
    await ready
    const { calls } = graphEngines(registry, true)
    const agent = forkedAgent([], [...write('w-1', 0, 'src/written.ts')])
    try {
      await registry.captureTurnForTest(agent, 1)
      await flush()
      // The trigger is `observation.sources.some(source => source.filesWritten.length > 0)`.
      // `filesWritten` is filled only when a `tool/result` is matched back to the
      // `tool/call` that produced it, by the id the Harness stores on it — and it is
      // filled from that call's own paths. Reading the id from the top level matched
      // no live event, so the list stayed empty and this ran for no turn at all.
      expect(calls).toEqual(['codegraph:sync:/workspace'])
    } finally {
      await registry.dispose()
    }
  })

  it('does not refresh the code graph for a turn that only read', async () => {
    const { registry, ready } = harness()
    await ready
    const { calls } = graphEngines(registry, true)
    const agent = forkedAgent([], [...read('r-1', 0, 'src/read.ts')])
    try {
      await registry.captureTurnForTest(agent, 1)
      await flush()
      // A read names a path as well; "a file appeared in the payload" is not the
      // fact the refresh is gated on, and a trigger that could not tell the two
      // apart would rebuild the graph on every read.
      expect(calls).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it('refreshes nothing when neither engine reports itself installed', async () => {
    const { registry, ready } = harness()
    await ready
    const { calls } = graphEngines(registry, false)
    const agent = forkedAgent([], [...write('w-1', 0, 'src/written.ts')])
    try {
      await registry.captureTurnForTest(agent, 1)
      await flush()
      // The write is real and the trigger fires, but refreshing a graph that does not
      // exist yet would be a first full workspace scan nobody asked for — the reason
      // the refresh is gated on `installed` rather than on the write alone.
      expect(calls).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it('leaves the graph alone when the automatic refresh is switched off', async () => {
    const { registry, ready } = harness({ engineeringCodeGraphAutoUpdate: false })
    await ready
    const { calls } = graphEngines(registry, true)
    const agent = forkedAgent([], [...write('w-1', 0, 'src/written.ts')])
    try {
      await registry.captureTurnForTest(agent, 1)
      await flush()
      // The switch the panel renders has to be the switch this reads: a write is not
      // enough to refresh when the user turned the automatic refresh off, and the
      // graph engine being installed is not enough either.
      expect(calls).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it('still records a whole ordinary session from its first event', async () => {
    const { registry, captured, ready } = harness()
    await ready
    const agent = forkedAgent([], [
      ...write('a', 0, 'src/first.ts'),
      ...write('b', 2, 'src/second.ts'),
    ])
    try {
      await registry.captureTurnForTest(agent, 1)
      expect(captured[0]?.sources?.map(source => source.eventSequence)).toEqual([0, 1, 2, 3])
      expect(captured[0]?.sources?.flatMap(source => [...source.filesWritten])).toEqual(['src/first.ts', 'src/second.ts'])
    } finally {
      await registry.dispose()
    }
  })
})
