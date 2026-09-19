/**
 * The memory pipeline's *wiring*: the five modules under `src/memory/` are only a
 * feature if something gates them, leases them, renders their index, and counts
 * what happened.
 *
 * Two halves, deliberately separated by cost:
 *
 * - **The pipeline as a consumer.** Every port is injected, so each assertion is
 *   about the decision the pipeline made — which stage suppressed the model call,
 *   what a shadow pass wrote, whether the lease serialised two passes — rather
 *   than about a database or a disk.
 * - **The plugin as the host.** The last block constructs the real plugin and
 *   proves the wiring exists end to end: the stage is read from the settings
 *   document, the model is called with no tools, the topic and `MEMORY.md` land on
 *   disk, and the outcome reaches the Host log as a `memory.*` record.
 *
 * Every case here is a mutation probe: each one names, in its own comment, the
 * source change it was written to catch.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { provideHostService, provideHostServiceAs, registrationHandle, sessionAt, settingsValue, type AgentEnginesFace } from './support/host-services.ts'
import {
  acquireDreamLease,
  DREAM_LEASE_FILENAME,
  MAX_OBSERVATION_PROMPT_CHARS,
  type ConsolidationRequest,
  type DreamIo,
  type MemoryObservation,
  type TopicProposal,
} from '../src/memory/dream.ts'
import { hashEvidence, type ForgetContext } from '../src/memory/forget.ts'
import { MEMORY_MANIFEST_FILENAME, renderMemoryManifest } from '../src/memory/manifest.ts'
import { MEMORY_TOPICS_DIRECTORY, MemoryPipeline, memoryConsolidationCaveat, type MemoryPipelineHost } from '../src/memory/memory-pipeline.ts'
import { isCollectableTelemetryValue, type MemoryTelemetryRecord } from '../src/memory/telemetry.ts'

const CWD = '/workspace'
/**
 * The pipeline harness's memory home for `CWD`, and the strings the pipeline
 * derives from it.
 *
 * Forward slashes, because the pipeline appends to the home rather than joining
 * it: `dream.ts` names a topic `${directory}/${slug}.md`, so the index and the
 * file map have to be compared in the same spelling the module under test uses.
 */
const HOME = '/home/workspace'
const TOPICS = `${HOME}/${MEMORY_TOPICS_DIRECTORY}`
/** The key a topic is written under, exactly as `commitTopics` builds it. */
const topicKey = (slug: string): string => `${TOPICS}/${slug}.md`
/** The key the index is written under, and the key the lease is written under. */
const INDEX_KEY = `${HOME}/${MEMORY_MANIFEST_FILENAME}`
const LEASE_KEY = `${HOME}/${DREAM_LEASE_FILENAME}`
/** A record id in the store's own grammar, so a double cannot pass a shape the store would refuse. */
const OBSERVATION_ID = `mem_${'a'.repeat(32)}`

/**
 * An in-memory file system for the lease, the topics, and the index.
 *
 * `rename` is a real move between keys rather than a copy, so a topic that was
 * staged and then moved is indistinguishable from one written in place — the
 * tests assert the end state, and the sequence is `dream.ts`'s own concern.
 */
function memoryIo(initial: Record<string, string> = {}): { io: DreamIo; files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    io: {
      read: path => files.get(path),
      write: (path, contents) => void files.set(path, contents),
      rename: (from, to) => {
        const staged = files.get(from)
        if (staged === undefined) throw new Error(`no staged file at ${from}`)
        files.delete(from)
        files.set(to, staged)
      },
      remove: path => void files.delete(path),
    },
  }
}

interface PipelineHarness {
  readonly pipeline: MemoryPipeline
  readonly files: Map<string, string>
  readonly records: MemoryTelemetryRecord[]
  readonly requests: ConsolidationRequest[]
}

/**
 * A pipeline whose every host port is a local value.
 *
 * The home is `/home/<workspace>` so a path assertion is readable, and the clock
 * is injected so the lease-expiry case can move time without waiting. `topics` is
 * derived from the files present rather than from a static list: the port stands
 * in for a directory listing, and a static list would let the index describe a
 * topic that was never written.
 */
function pipelineHarness(options: {
  readonly stage?: string
  readonly observations?: readonly MemoryObservation[]
  readonly topics?: readonly string[]
  readonly initialFiles?: Record<string, string>
  readonly plan?: (request: ConsolidationRequest) => Promise<readonly TopicProposal[] | undefined>
  readonly now?: number
} = {}): PipelineHarness {
  const { io, files } = memoryIo(options.initialFiles ?? {})
  const records: MemoryTelemetryRecord[] = []
  const requests: ConsolidationRequest[] = []
  let now = options.now ?? 1_000
  const home = (cwd: string): string => `/home/${cwd.replace(/^\//, '')}`
  const host: MemoryPipelineHost = {
    stage: () => options.stage,
    home,
    io,
    observations: () => options.observations ?? [],
    topics: (cwd) => {
      const prefix = `${home(cwd)}/${MEMORY_TOPICS_DIRECTORY}/`
      const onDisk = [...files.keys()]
        .filter(key => key.startsWith(prefix) && key.endsWith('.md'))
        .map(key => key.slice(prefix.length, -'.md'.length))
      return [...new Set([...(options.topics ?? []), ...onDisk])].sort()
    },
    ...(options.plan === undefined ? {} : {
      plan: (request: ConsolidationRequest) => {
        requests.push(request)
        return options.plan!(request)
      },
    }),
    telemetry: (record) => { records.push(record) },
    now: () => now,
    owner: 'pass-1',
  }
  return { pipeline: new MemoryPipeline(host), files, records, requests }
}

/**
 * Forget ports backed by the harness's in-memory files.
 *
 * `pipeline.forget` supplies the three facts only it knows and takes the rest from
 * its caller, so a pipeline test has to hand it the same file operations its own io
 * uses: without them the tombstone, the audit line, and the delete land on the real
 * filesystem, which is a test writing to the developer's disk.
 *
 * Paths are normalized because `forgetObservation` resolves them with `resolve()`,
 * which on Windows returns a backslash path with a drive prefix while the harness
 * keys its files from the root.
 */
function inMemoryForgetPorts(files: Map<string, string>): Partial<ForgetContext> {
  const key = (path: string): string => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')
  return {
    write: (path, contents) => void files.set(key(path), contents),
    append: (path, contents) => void files.set(key(path), `${files.get(key(path)) ?? ''}${contents}`),
    remove: (path) => void files.delete(key(path)),
    exists: path => files.has(key(path)),
    read: path => files.get(key(path)) ?? '',
    realPath: path => path,
  }
}

/** One observation in the shape the pipeline's port produces. */
function observation(overrides: Partial<MemoryObservation> = {}): MemoryObservation {
  return { id: OBSERVATION_ID, sha256: 'a'.repeat(64), capturedAt: 10, text: 'Retries are bounded.', ...overrides }
}

/** One topic in the shape the planner produces. */
function topic(overrides: Partial<TopicProposal> = {}): TopicProposal {
  return { slug: 'errors', title: 'Errors', markdown: 'Retries are bounded.', sources: [OBSERVATION_ID], ...overrides }
}

/** The dream records a harness emitted, in order. */
function dreamRecords(records: readonly MemoryTelemetryRecord[]): readonly MemoryTelemetryRecord[] {
  return records.filter(record => record.event === 'memory.dream')
}

/** A context whose only injected ports are the ones a refusal needs. */
function refusingContext(): Partial<ForgetContext> {
  return { exists: () => true, isSymlink: () => false, read: () => 'bytes' }
}

describe('the rollout gate is consulted before any work', () => {
  it('an off stage plans nothing, writes nothing, and says so', async () => {
    // Mutation: deleting the `if (!decision.behaviour.consolidate)` guard in
    // `consolidate` makes this case fail — the planner is called and the pass
    // reports `completed`.
    const planned = vi.fn(async () => [topic()])
    const harness = pipelineHarness({ stage: 'off', observations: [observation()], plan: planned })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(outcome).toMatchObject({ outcome: 'skipped', stage: 'off', topicsWritten: 0 })
    expect(planned).not.toHaveBeenCalled()
    expect(harness.files.size).toBe(0)
    // The gate is observable, not just effective: a deployment at `off` still
    // emits the record that says the pass was considered and declined.
    expect(dreamRecords(harness.records).map(record => record.fields.outcome)).toEqual(['skipped'])
  })

  it('record_only captures but does not consolidate', async () => {
    // The stage exists precisely to separate "we are recording" from "we are
    // thinking", so a pass here must not spend a model request.
    const planned = vi.fn(async () => [topic()])
    const harness = pipelineHarness({ stage: 'record_only', observations: [observation()], plan: planned })
    await expect(harness.pipeline.consolidate({ cwd: CWD })).resolves.toMatchObject({ outcome: 'skipped', stage: 'record_only' })
    expect(planned).not.toHaveBeenCalled()
  })

  it('an unrecognised stage lands on off rather than guessing', async () => {
    const planned = vi.fn(async () => [topic()])
    const harness = pipelineHarness({ stage: 'turbo', observations: [observation()], plan: planned })
    await expect(harness.pipeline.consolidate({ cwd: CWD })).resolves.toMatchObject({ outcome: 'skipped', stage: 'off' })
    expect(planned).not.toHaveBeenCalled()
    // The skew is reported by the rollout decision rather than swallowed.
    expect(harness.pipeline.rollout().note).toContain('turbo')
  })

  it('a stage below the model call skips before planning', async () => {
    // The gate is what makes `record_only` a promise rather than a label: the
    // stage itself decides whether the model is reached, so a deployment that
    // declares it cannot have a pass that quietly ran one.
    const planned = vi.fn(async () => [topic()])
    const harness = pipelineHarness({ stage: 'record_only', observations: [observation()], plan: planned })
    expect(harness.pipeline.rollout().stage).toBe('record_only')
    await expect(harness.pipeline.consolidate({ cwd: CWD })).resolves.toMatchObject({ outcome: 'skipped', stage: 'record_only' })
    expect(planned).not.toHaveBeenCalled()
  })

  it('an absent model is reported as skipped rather than failed', async () => {
    // No `plan` port at all: the deployment has the pipeline on and no route.
    const harness = pipelineHarness({ stage: 'active', observations: [observation()] })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(outcome).toMatchObject({ outcome: 'skipped', stage: 'active', observations: 1 })
    expect(outcome.problem).toContain('no consolidating model')
    // The lease was still taken and released, so the pass is not a no-op that
    // silently leaves the archive unmanaged.
    expect(harness.files.has(LEASE_KEY)).toBe(false)
  })
})

describe('shadow consolidates and commits nothing', () => {
  it('runs the model and writes no topic and no index', async () => {
    // Mutation: building the plan with `commit: true` (instead of the stage's
    // answer) writes the topic, and this case fails.
    const harness = pipelineHarness({ stage: 'shadow', observations: [observation()], plan: async () => [topic()] })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(outcome).toMatchObject({ outcome: 'completed', stage: 'shadow', observations: 1, topicsWritten: 0 })
    expect(harness.requests).toHaveLength(1)
    // Mutation: calling `writeManifest` unconditionally instead of behind
    // `behaviour.commit` leaves `MEMORY.md` behind, and this assertion fails —
    // the index is a write, and shadow's promise is that it makes none.
    expect(harness.files.size).toBe(0)
    // The operator reads what the model *would* have written from the outcome.
    expect(outcome.problem).toContain('committed none')
  })
})

describe('active commits topics and the index describes what is stored', () => {
  it('writes the topic, skips an escaping slug, and points MEMORY.md at the file', async () => {
    const harness = pipelineHarness({
      stage: 'active',
      observations: [observation()],
      plan: async () => [topic(), topic({ slug: '../escape', title: 'Escape' })],
    })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(outcome).toMatchObject({ outcome: 'completed', topicsWritten: 1 })
    const topicPath = topicKey('errors')
    expect(harness.files.get(topicPath)).toContain('# Errors')
    expect(harness.files.get(topicPath)).toContain(`Derived from: ${OBSERVATION_ID}`)
    // The slug that could escape its directory is skipped by `commitTopics`, and
    // the pass reports one written topic rather than two planned.
    expect([...harness.files.keys()].some(key => key.includes('escape'))).toBe(false)
    const index = harness.files.get(INDEX_KEY)
    expect(index).toBeDefined()
    // Mutation: writing the slug (or a relative path) instead of the topic's
    // absolute path in `writeManifest` makes this fail — the index's whole
    // contract is that a reader can open what it names.
    expect(index).toContain(topicKey('errors'))
    expect(index).toContain('Errors')
  })

  it('lists a topic written by an earlier pass, not only the ones this pass planned', async () => {
    // The index is rendered from the topic files, so a hand-written or earlier
    // topic is described rather than dropped from the index it belongs in.
    const harness = pipelineHarness({
      stage: 'active',
      observations: [observation()],
      initialFiles: { [topicKey('earlier')]: '# Earlier heading\n\nBody.\n' },
      plan: async () => [topic()],
    })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(outcome).toMatchObject({ outcome: 'completed', topicsWritten: 1 })
    const manifest = harness.pipeline.writeManifest(CWD)
    expect(manifest.included).toBe(2)
    const index = harness.files.get(INDEX_KEY)
    expect(index).toContain('Earlier heading')
    expect(index).toContain('Errors')
  })

  it('reports a topic with no readable heading instead of dropping it', async () => {
    const harness = pipelineHarness({ stage: 'active', topics: ['ghost'] })
    const manifest = harness.pipeline.writeManifest(CWD)
    expect(manifest.included).toBe(1)
    expect(harness.files.get(INDEX_KEY)).toContain('topic file could not be read')
  })

  it('agrees with renderMemoryManifest on the rendered index', () => {
    // A cross-check rather than a restatement: the pipeline's job is to feed the
    // renderer real entries, and the renderer's own budget behaviour has its own
    // suite. This pins that the pipeline adds nothing and drops nothing.
    const harness = pipelineHarness({ stage: 'active', topics: ['a', 'b'] })
    const expected = renderMemoryManifest([
      { name: 'a', path: topicKey('a'), description: 'topic file could not be read' },
      { name: 'b', path: topicKey('b'), description: 'topic file could not be read' },
    ], { now: 1_000 })
    expect(harness.pipeline.writeManifest(CWD).markdown).toBe(expected.markdown)
  })
})

describe('the lease serialises passes', () => {
  it('a second pass while the first is running is refused, and counted', async () => {
    // Mutation: deleting the `if (!lease.ok)` guard lets the second pass read the
    // same archive and write the same topics — the case `dream.ts` exists for.
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const harness = pipelineHarness({
      stage: 'active',
      observations: [observation()],
      plan: async () => { await gate; return [topic()] },
    })
    const first = harness.pipeline.consolidate({ cwd: CWD })
    // The lease is on disk before the model call, which is the property: a second
    // process must be refused while the first is thinking, not only while it is
    // writing.
    await Promise.resolve()
    const second = await harness.pipeline.consolidate({ cwd: CWD })
    expect(second).toMatchObject({ outcome: 'lease-held', stage: 'active' })
    expect(second.problem).toContain('pass-1')
    release()
    await expect(first).resolves.toMatchObject({ outcome: 'completed' })
    expect(dreamRecords(harness.records).map(record => record.fields.outcome)).toEqual(['started', 'lease-held', 'completed'])
  })

  it('releases the lease even when the model fails', async () => {
    const harness = pipelineHarness({
      stage: 'active',
      observations: [observation()],
      plan: async () => { throw new Error('route refused') },
    })
    await expect(harness.pipeline.consolidate({ cwd: CWD })).resolves.toMatchObject({ outcome: 'failed', problem: 'route refused' })
    // A ttl is for a crash, not for an ordinary error: the next pass must not
    // have to wait out the lease.
    expect(harness.files.has(LEASE_KEY)).toBe(false)
    expect(harness.pipeline.leaseActive(CWD)).toBe(false)
  })

  it('treats an expired lease as absent', async () => {
    // Mutation: returning the lease from `readDreamLease` without comparing
    // `expiresAt` to now makes this case fail — a crashed pass would disable the
    // feature until someone deleted a file.
    const { io } = memoryIo()
    acquireDreamLease({ directory: HOME, owner: 'crashed', now: 1_000, ttlMs: 500, io })
    const records: MemoryTelemetryRecord[] = []
    const pipeline = new MemoryPipeline({
      stage: () => 'active',
      home: () => HOME,
      io,
      observations: () => [],
      topics: () => [],
      telemetry: record => { records.push(record) },
      now: () => 2_000,
    })
    expect(pipeline.leaseActive(CWD)).toBe(false)
    await expect(pipeline.consolidate({ cwd: CWD })).resolves.toMatchObject({ outcome: 'skipped' })
  })
})

describe('a recovered pass says so', () => {
  /** A lease left behind by a pass that died holding it: expired before the clock below. */
  const crashedLease = (owner: string): string => `${JSON.stringify({ owner, acquiredAt: 0, expiresAt: 500 })}\n`

  it('reports the lease it took over instead of assuming a clean start', async () => {
    // Mutation: dropping the `lease.superseded` read (or the `reported` wrapper it
    // feeds) leaves this result with no `problem` at all — which is the shape a
    // reader cannot tell from a workspace that never crashed, and the reason
    // `acquireDreamLease` returns the superseded lease in the first place.
    const harness = pipelineHarness({
      stage: 'active',
      observations: [observation()],
      plan: async () => [topic()],
      now: 1_000,
      initialFiles: { [LEASE_KEY]: crashedLease('dsh-9999') },
    })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(outcome).toMatchObject({ outcome: 'completed', topicsWritten: 1 })
    expect(outcome.problem).toContain('dsh-9999')
    expect(outcome.problem).toContain('took it over')
    // A takeover still releases its own lease, so the archive is not left
    // serialised against the next pass.
    expect(harness.files.has(LEASE_KEY)).toBe(false)
  })

  it('keeps the pass own reason beside the takeover', async () => {
    // Two facts, one field: a pass that recovered the lease *and* lost a topic to
    // the writer's refusal has to report both, or reporting either alone loses the
    // other.
    const harness = pipelineHarness({
      stage: 'active',
      observations: [observation()],
      plan: async () => [topic(), topic({ slug: '../escape', title: 'Escape' })],
      now: 1_000,
      initialFiles: { [LEASE_KEY]: crashedLease('dsh-9999') },
    })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(outcome.problem).toContain('refused')
    expect(outcome.problem).toContain('took it over')
  })

  it('says nothing about a takeover when the lease was released cleanly', async () => {
    // The control: the ordinary pass carries no caveat, so the line the Host logs
    // stays absent instead of becoming one line per pass.
    const harness = pipelineHarness({ stage: 'active', observations: [observation()], plan: async () => [topic()], now: 1_000 })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(outcome.outcome).toBe('completed')
    expect(outcome.problem).toBeUndefined()
    expect(memoryConsolidationCaveat(outcome)).toBeUndefined()
  })

  it('never prints a lease owner that could forge a second line', async () => {
    // The owner is text out of a file this process did not write, and the sentence
    // lands both in a log line and in the result a Remote returns.
    const harness = pipelineHarness({
      stage: 'active',
      observations: [observation()],
      plan: async () => [topic()],
      now: 1_000,
      initialFiles: { [LEASE_KEY]: crashedLease('dsh-9999\nwarn: nothing to see here') },
    })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(outcome.problem).not.toContain('\n')
    expect(outcome.problem).toContain('dsh-9999 warn: nothing to see here')
  })

  it('reads both halves of the one field that carries a pass caveat', () => {
    // The reader exists because the field had a single reader, gated on `failed`,
    // while `planProblem` writes it onto a `completed` pass.
    expect(memoryConsolidationCaveat({ outcome: 'failed', stage: 'active', observations: 0, topicsWritten: 0, durationMs: 1, problem: 'boom' })).toBe('failed: boom')
    expect(memoryConsolidationCaveat({ outcome: 'completed', stage: 'active', observations: 1, topicsWritten: 0, durationMs: 1, problem: '1 of 2 planned topic(s) were refused' })).toBe('completed with a caveat: 1 of 2 planned topic(s) were refused')
    // An ordinary skip is not a caveat: one line per quiet period would make the
    // log's rate the pass's trigger rate.
    expect(memoryConsolidationCaveat({ outcome: 'skipped', stage: 'off', observations: 0, topicsWritten: 0, durationMs: 0, problem: 'stage \"off\" does not consolidate' })).toBeUndefined()
    expect(memoryConsolidationCaveat({ outcome: 'completed', stage: 'active', observations: 1, topicsWritten: 1, durationMs: 1 })).toBeUndefined()
  })
})

describe('the request the model is asked', () => {
  it('carries an empty tool list and the topics already on disk', async () => {
    const harness = pipelineHarness({
      stage: 'active',
      observations: [observation({ id: `mem_${'b'.repeat(32)}` })],
      topics: ['errors'],
      plan: async () => [],
    })
    await harness.pipeline.consolidate({ cwd: CWD })
    const request = harness.requests[0]!
    // The property the whole pass rests on, asserted at the call site that
    // actually builds the request: a consolidating model cannot read or change
    // the repository.
    expect(request.tools).toEqual([])
    expect(request.tools).toHaveLength(0)
    // Mutation: dropping `existingTopics` from the request makes this fail — a
    // pass that cannot see the topics already stored plans duplicates of them.
    expect(request.existingTopics).toEqual(['errors'])
    expect(request.prompt).toContain('Retries are bounded.')
  })

  it('snapshots before the model call, so a late arrival cannot join the pass', async () => {
    const observations: MemoryObservation[] = [observation()]
    // The record arrives *during* the pass, which is the case the snapshot
    // exists for: `dream.ts` freezes the inbox so a slow model cannot change what
    // the pass was asked. Mutation: reading the port after the model call (or
    // dropping `snapshotObservations`) makes this fail.
    const harness = pipelineHarness({
      stage: 'active',
      observations,
      plan: async () => {
        observations.push(observation({ id: `mem_${'c'.repeat(32)}` }))
        return []
      },
    })
    await harness.pipeline.consolidate({ cwd: CWD })
    expect(harness.requests[0]!.observations).toHaveLength(1)
  })
})

describe('telemetry is built, never assembled', () => {
  it('every record carries only values the schema can hold', async () => {
    // Mutation: replacing `buildMemoryTelemetry` with a plain object literal in
    // the pipeline's `emit` lets `{ topic: slug }` through, and this case fails —
    // the record is the one place a distilled note could leave the pipeline.
    const harness = pipelineHarness({ stage: 'active', observations: [observation()], plan: async () => [topic()] })
    await harness.pipeline.consolidate({ cwd: CWD })
    await harness.pipeline.forget(CWD, { path: 'topics/x.md', sha256: 'x' }, refusingContext())
    expect(harness.records.length).toBeGreaterThan(0)
    for (const record of harness.records) {
      for (const value of Object.values(record.fields)) {
        expect(isCollectableTelemetryValue(value), `${record.event} carried ${JSON.stringify(value)}`).toBe(true)
      }
    }
  })

  it('emits a forget record for a refusal, not only for a success', async () => {
    const harness = pipelineHarness({ stage: 'active' })
    const result = harness.pipeline.forget(CWD, { path: 'observations/*.json', sha256: 'x' }, refusingContext())
    expect(result).toMatchObject({ ok: false, refusal: 'broad-request' })
    expect(harness.records.map(record => record.event)).toEqual(['memory.forget'])
    expect(harness.records[0]!.fields).toMatchObject({ outcome: 'refused', refusal: 'broad-request' })
  })
})

describe('forgetting is refused while a dream holds the lease', () => {
  it('refuses with lease-active, and says so in telemetry', async () => {
    // Mutation: passing `leaseActive: false` in `MemoryPipeline.forget` deletes
    // the file mid-consolidation and this case fails — the refusal is the whole
    // reason the pipeline reads the lease rather than tracking it.
    const { io } = memoryIo()
    acquireDreamLease({ directory: HOME, owner: 'pass-1', now: 1_000, ttlMs: 10 * 60_000, io })
    const records: MemoryTelemetryRecord[] = []
    const pipeline = new MemoryPipeline({
      stage: () => 'active',
      home: () => HOME,
      io,
      observations: () => [],
      topics: () => [],
      telemetry: record => { records.push(record) },
      now: () => 2_000,
    })
    const result = pipeline.forget(CWD, { path: 'topics/x.md', sha256: hashEvidence('bytes') }, refusingContext())
    expect(result).toMatchObject({ ok: false, refusal: 'lease-active' })
    expect(records[0]!.fields).toMatchObject({ outcome: 'refused', refusal: 'lease-active' })
  })

  it('forgets the file it was given the hash of, and counts it', async () => {
    const bytes = 'a curated topic'
    const harness = pipelineHarness({ stage: 'active' })
    const events: string[] = []
    const result = harness.pipeline.forget(CWD, { path: 'topics/x.md', sha256: hashEvidence(bytes) }, {
      exists: () => true,
      isSymlink: () => false,
      read: () => bytes,
      write: (path, contents) => void events.push(`write ${path} ${String(contents.length)}`),
      append: path => void events.push(`append ${path}`),
      remove: path => void events.push(`remove ${path}`),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path).toBe('topics/x.md')
    // The tombstone and the audit line are written before the delete; the
    // reverse order is indistinguishable from corruption after a crash.
    expect(events.findIndex(entry => entry.startsWith('remove'))).toBeGreaterThan(events.findIndex(entry => entry.startsWith('write')))
    expect(harness.records[0]!.fields.outcome).toBe('forgotten')
  })

  it('refuses a protected file even in a workspace with no lease', async () => {
    const harness = pipelineHarness({ stage: 'active' })
    const result = harness.pipeline.forget(CWD, { path: MEMORY_MANIFEST_FILENAME, sha256: hashEvidence('bytes') }, refusingContext())
    expect(result).toMatchObject({ ok: false, refusal: 'protected' })
  })
})

// ─── The plugin as the host ──────────────────────────────────────────────────

/** A completion whose text is the answer, plus a finish reason. */
function completed(text: string, reason: FinishReason = { kind: 'stop' }): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason },
  ]
}

interface PluginHarness {
  readonly plugin: FreeCodeGoHarnessPlugin
  readonly requests: GenerateOptions[]
  readonly logged: string[]
  readonly home: string
  readonly dispose: () => Promise<void>
}

/**
 * The real plugin, with the services its constructor needs and a settings
 * document whose `memoryRollout` is the caller's.
 *
 * The engineering registry's *store* is replaced with a double for the same
 * reason `memory-ranked-search.spec.ts` does it: the store's own behaviour has
 * its own suite, and this case is about whether the plugin wired the pipeline to
 * it at all.
 */
async function pluginHarness(options: {
  readonly memoryRollout?: string
  readonly completion: string
  readonly observations?: readonly MemoryObservation[]
}): Promise<PluginHarness> {
  const home = mkdtempSync(join(tmpdir(), 'freecodego-memory-pipeline-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const requests: GenerateOptions[] = []
  const logged: string[] = []
  const ctx = new Context()
  await ctx.plugin((scope: Context) => {
    provideHostService(scope, 'agents', { list: () => [], get: () => undefined })
    provideHostServiceAs<AgentEnginesFace>(scope, 'agentEngines', { setAvailability: () => undefined })
    provideHostService(scope, 'sessions', { get: () => sessionAt(CWD), list: () => [] })
    provideHostService(scope, 'settings', {
      register: () => ({
        get: () => settingsValue({
          memoryRollout: options.memoryRollout ?? 'off',
          engineeringEnabled: true,
          engineeringMemoryEnabled: true,
          advisorProvider: 'opencode',
          advisorModel: 'auto',
        }),
        watch: () => () => undefined,
        update: async () => undefined,
        replace: async () => undefined,
      }),
    })
    provideHostService(scope, 'llm', {
      // The plugin registers its own provider adapters during boot; the double
      // accepts them and does nothing, which is what an unmanaged install does.
      registerAdapter: () => registrationHandle(),
      stream(generation: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(generation)
        const chunks = completed(options.completion)
        return (async function* generate(): AsyncGenerator<StreamChunk> { for (const chunk of chunks) yield chunk })()
      },
    })
  })
  const plugin = new FreeCodeGoHarnessPlugin(ctx, {})
  const observations = options.observations ?? [observation()]
  const internals = plugin as unknown as { engineering: { memoryAvailable: boolean; memory: unknown } }
  internals.engineering.memoryAvailable = true
  internals.engineering.memory = {
    list: () => ({
      records: observations.map(entry => ({ id: entry.id, title: entry.text.split('\n')[0] ?? '', kind: 'note', trust: 'captured', projectId: 'p', createdAt: entry.capturedAt, detailTokens: 4 })),
    }),
    getForReview: ({ ids }: { readonly ids: readonly string[] }) => ids.flatMap(id => observations
      .filter(entry => entry.id === id)
      .map(entry => ({ id, title: entry.text.split('\n')[0] ?? '', body: entry.text, kind: 'note', trust: 'captured', projectId: 'p', createdAt: entry.capturedAt, detailTokens: 4, tags: [], sources: [], related: [] }))),
    close: () => undefined,
  }
  const inner = ctx.logger.info.bind(ctx.logger)
  vi.spyOn(ctx.logger, 'info').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(argument => String(argument)).join(' '))
    ;(inner as (...forwarded: unknown[]) => void)(...args)
  })
  return {
    plugin,
    requests,
    logged,
    home,
    dispose: async () => {
      vi.restoreAllMocks()
      await ctx.fiber.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

/** The single per-workspace memory home the plugin created under its data home. */
function memoryHomeSegments(home: string): readonly string[] {
  try {
    return readdirSync(join(home, 'freecodego', 'engineering', 'memory-home'))
  } catch {
    return []
  }
}

describe('the plugin host runs the pipeline it built', () => {
  let harness: PluginHarness | undefined
  afterEach(async () => { await harness?.dispose(); harness = undefined })

  it('reads the stage from settings, calls the model with no tools, and writes the topic and the index', async () => {
    // Mutation: replacing the plugin's `stage: () => this.policy.get()?.memoryRollout`
    // with a constant leaves the stage at `off`, and this case fails on the first
    // assertion — which is what makes the wiring, rather than the pipeline, the
    // thing under test here.
    harness = await pluginHarness({
      memoryRollout: 'active',
      completion: JSON.stringify([{ slug: 'retries', title: 'Retries', markdown: 'Bounded and jittered.', sources: [OBSERVATION_ID] }]),
    })
    const outcome = await harness.plugin.consolidateMemoryForTest(CWD, 'session-1')
    expect(outcome).toMatchObject({ outcome: 'completed', stage: 'active', topicsWritten: 1 })

    // The model was reached, and it was reached without tools: the property
    // `dream.ts` types into the request has to hold at the transport too.
    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]!.tools).toBeUndefined()
    const sent = (harness.requests[0]!.messages[0]!.content as readonly { readonly text?: string }[]).map(block => block.text ?? '').join('')
    expect(sent).toContain('Retries are bounded.')

    // The topic and the index are on disk under the plugin's own data home, so
    // the wiring is proved against real files rather than a double. The pointer is
    // spelled the way the pipeline spells it — the home joined, then `/slug.md`
    // appended — and the same string is used to read the file, so the assertion
    // also proves the index names something that exists.
    const segments = memoryHomeSegments(harness.home)
    expect(segments).toHaveLength(1)
    const memoryHome = join(harness.home, 'freecodego', 'engineering', 'memory-home', segments[0]!)
    // Built the way the pipeline builds it: the home joined, then `/topics/slug.md`
    // appended. Both spellings resolve to one file on Windows, so using the
    // pipeline's own spelling is what makes the last assertion meaningful.
    const topicFile = `${memoryHome}/${MEMORY_TOPICS_DIRECTORY}/retries.md`
    expect(existsSync(topicFile)).toBe(true)
    expect(readFileSync(topicFile, 'utf8')).toContain('# Retries')
    const index = readFileSync(join(memoryHome, MEMORY_MANIFEST_FILENAME), 'utf8')
    expect(index).toContain(topicFile)

    // …and the outcome reached the Host log as a schema-built record.
    expect(harness.logged.some(line => line.includes('memory.dream') && line.includes('"outcome":"completed"'))).toBe(true)
  })

  it('reports a completed pass caveat, not only a failed pass reason', async () => {
    // Measured: `runMemoryConsolidation` logged `outcome.problem` only when the
    // outcome was `failed`, while `planProblem` stamps the same field onto a
    // `completed` pass — so the sentence that exists to end a silent drop was
    // dropped one frame after it was written. Driven through the background entry
    // point rather than the test seam, because the seam is the half that was
    // already correct.
    harness = await pluginHarness({
      memoryRollout: 'active',
      completion: JSON.stringify([
        { slug: 'retries', title: 'Retries', markdown: 'Bounded and jittered.', sources: [OBSERVATION_ID] },
        { slug: '../escape', title: 'Escape', markdown: 'Not a filename.', sources: [OBSERVATION_ID] },
      ]),
    })
    const host = harness.plugin as unknown as { runMemoryConsolidation: (cwd: string, sessionId?: string) => Promise<void> }
    await host.runMemoryConsolidation(CWD, 'session-1')
    expect(harness.logged.some(line => line.includes('memory consolidation') && line.includes('refused'))).toBe(true)
  })

  it('writes nothing at all when the stage is off', async () => {
    // The default deployment. Mutation: removing the gate (or defaulting the
    // stage to `active`) makes the model get called and a topic appear.
    harness = await pluginHarness({
      memoryRollout: 'off',
      completion: JSON.stringify([{ slug: 'retries', title: 'Retries', markdown: 'x', sources: [] }]),
    })
    const outcome = await harness.plugin.consolidateMemoryForTest(CWD, 'session-1')
    expect(outcome).toMatchObject({ outcome: 'skipped', stage: 'off' })
    expect(harness.requests).toHaveLength(0)
    expect(memoryHomeSegments(harness.home)).toHaveLength(0)
  })

  it('renders the index on demand without spending a model request', async () => {
    harness = await pluginHarness({ memoryRollout: 'off', completion: '[]' })
    const manifest = harness.plugin.engineeringMemoryManifest('session-1')
    expect(manifest.included).toBe(0)
    expect(harness.requests).toHaveLength(0)
  })

  it('refuses a forget whose evidence names a glob, through the Remote surface', async () => {
    harness = await pluginHarness({ memoryRollout: 'off', completion: '[]' })
    const result = harness.plugin.engineeringMemoryForget('session-1', { path: 'topics/*.md', sha256: 'anything' })
    expect(result).toMatchObject({ ok: false, refusal: 'broad-request' })
    // The refusal is telemetry, not silence: an operator can see that someone
    // asked to forget something and was told why not.
    expect(harness.logged.some(line => line.includes('memory.forget'))).toBe(true)
  })
})

describe('a pass costs what there is to do', () => {
  it('does not reach the model, or write anything, when there is nothing to consolidate', async () => {
    // Measured: an empty snapshot used to spend one model call (with a zero-length
    // prompt) and rewrite the index, because the pipeline took the lease and built
    // a request before asking whether there was anything to put in it. The trigger
    // is every turn-stopping behind a 15s debounce, so a deployment with the
    // pipeline on and nothing captured paid a request per quiet period — and a
    // lease it held for the duration, which is what makes a concurrent forget on
    // that workspace refuse.
    let calls = 0
    const harness = pipelineHarness({
      stage: 'active',
      observations: [],
      plan: async () => { calls += 1; return [] },
    })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(calls).toBe(0)
    expect(harness.requests).toHaveLength(0)
    // Nothing written at all: no lease, no topic, no index.
    expect([...harness.files.keys()]).toStrictEqual([])
    expect(outcome).toMatchObject({ outcome: 'skipped', observations: 0, topicsWritten: 0 })
    expect(outcome.problem).toContain('no observations')
    // The pass is still visible: a skipped pass that emitted nothing would be
    // indistinguishable from a trigger that never fired.
    expect(harness.records.map(record => record.fields.outcome)).toStrictEqual(['skipped'])
  })

  it('bounds what one observation can put in the prompt, and says it did', async () => {
    // `MemoryObservation.text` comes from a stored body the store caps at 64 KiB,
    // and the port hands the pass up to 100 of them — so the prompt `dream.ts`
    // documents as "bounded per observation" reached 6.4 MB at worst, which is a
    // context overflow on every pass for a project with a few long notes.
    const long = 'x'.repeat(64 * 1024)
    const harness = pipelineHarness({
      stage: 'active',
      observations: [observation({ text: long })],
      plan: async () => [],
    })
    await harness.pipeline.consolidate({ cwd: CWD })
    const prompt = harness.requests[0]?.prompt ?? ''
    // Marked the way the rest of this subsystem marks a cut, so a reader can tell
    // a short observation from a truncated one.
    expect(prompt.endsWith('…')).toBe(true)
    expect(prompt.length).toBeLessThan(MAX_OBSERVATION_PROMPT_CHARS + 200)
    // Short enough to be read: a bound that keeps the whole body is not a bound.
    expect(prompt.length).toBeLessThan(long.length)
  })

  it('reports a topic the writer refused instead of dropping it silently', async () => {
    // `commitTopics` refuses a slug that is not a filename, which is the safe
    // direction, and the result carried no sign of it: a pass that planned two
    // topics and wrote one reported plain `completed`.
    const harness = pipelineHarness({
      stage: 'active',
      observations: [observation()],
      plan: async () => [topic(), topic({ slug: '../escape', title: 'Escape' })],
    })
    const outcome = await harness.pipeline.consolidate({ cwd: CWD })
    expect(outcome).toMatchObject({ outcome: 'completed', topicsWritten: 1 })
    expect(outcome.problem).toContain('1')
    expect(outcome.problem).toContain('refused')
  })

  it('forgets a topic out of the index too, because a pointer to nothing is not a pointer', async () => {
    // Measured: `forget` removed the topic file and left `MEMORY.md` naming it, so
    // the next reader opened a path that was not there — the one outcome
    // `manifest.ts` says an index must never produce ("when it reconstructs it
    // wrong it does not report a broken path; it reports having found nothing").
    // The pass that would regenerate the index is the one this round made cheaper,
    // which is why the two belong to the same fix.
    const harness = pipelineHarness({ stage: 'active', observations: [observation()], plan: async () => [topic()] })
    await harness.pipeline.consolidate({ cwd: CWD })
    expect(harness.files.get(INDEX_KEY)).toContain(topicKey('errors'))

    const bytes = harness.files.get(topicKey('errors')) ?? ''
    const forgotten = harness.pipeline.forget(CWD, { path: `${MEMORY_TOPICS_DIRECTORY}/errors.md`, sha256: hashEvidence(bytes) }, inMemoryForgetPorts(harness.files))
    expect(forgotten).toMatchObject({ ok: true })
    expect(harness.files.has(topicKey('errors'))).toBe(false)
    const index = harness.files.get(INDEX_KEY) ?? ''
    expect(index).not.toContain('errors.md')
    // A refusal changes nothing, so it must not rewrite anything either.
    const before = [...harness.files.entries()]
    expect(harness.pipeline.forget(CWD, { path: `${MEMORY_TOPICS_DIRECTORY}/gone.md`, sha256: 'x' }, inMemoryForgetPorts(harness.files))).toMatchObject({ ok: false })
    expect([...harness.files.entries()]).toStrictEqual(before)
  })

  it('consolidates one observation set once, and again when the set changes', async () => {
    // Nothing consumes an observation — the store's review path is the user's — so
    // the same captured records were re-planned on every pass for as long as they
    // stayed in the inbox, rewriting the same topics and paying for a model call
    // each time. `MemoryObservation.sha256` exists to tell a rewritten record from
    // an unchanged one and was read nowhere.
    const observations = [observation()]
    let calls = 0
    const harness = pipelineHarness({
      stage: 'active',
      observations,
      plan: async () => { calls += 1; return [topic()] },
    })
    const first = await harness.pipeline.consolidate({ cwd: CWD })
    expect(first.outcome).toBe('completed')
    const second = await harness.pipeline.consolidate({ cwd: CWD })
    expect(calls).toBe(1)
    expect(second).toMatchObject({ outcome: 'skipped' })
    expect(second.problem).toContain('already consolidated')
    expect(second.problem).toContain('unchanged')

    // A record the store rewrote in place is new input even though its id is not.
    observations[0] = observation({ sha256: 'b'.repeat(64), text: 'Retries are bounded and jittered.' })
    const third = await harness.pipeline.consolidate({ cwd: CWD })
    expect(third.outcome).toBe('completed')
    expect(calls).toBe(2)

    // And a failure is not progress: the next pass over the same set must try again.
    observations[0] = observation({ sha256: 'c'.repeat(64) })
    const failing = pipelineHarness({
      stage: 'active',
      observations: [observation({ sha256: 'd'.repeat(64) })],
      plan: async () => { throw new Error('the consolidation model returned no JSON array') },
    })
    expect((await failing.pipeline.consolidate({ cwd: CWD })).outcome).toBe('failed')
    expect((await failing.pipeline.consolidate({ cwd: CWD })).outcome).toBe('failed')
  })
})
