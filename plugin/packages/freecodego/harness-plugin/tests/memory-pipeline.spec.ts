/**
 * G4 — the memory pipeline.
 *
 * Four properties carry the weight here and each has a dedicated block below:
 * disabling fails closed, telemetry cannot hold free text, forgetting needs
 * exact evidence, and the consolidation pass runs with no tools at all.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { ROLLOUT_STAGES } from '../src/policy.ts'
import {
  acquireDreamLease,
  buildConsolidationRequest,
  commitTopics,
  DREAM_LEASE_FILENAME,
  releaseDreamLease,
  snapshotObservations,
  type ConsolidationPlan,
  type DreamIo,
  type MemoryObservation,
} from '../src/memory/dream.ts'
import { forgetObservation, hashEvidence, type ForgetContext } from '../src/memory/forget.ts'
import { MEMORY_ARCHIVES } from '../src/memory/memory-pipeline.ts'
import { renderMemoryManifest } from '../src/memory/manifest.ts'
import { memoryStageBehaviour, resolveMemoryRollout } from '../src/memory/rollout.ts'
import {
  buildMemoryTelemetry,
  isCollectableTelemetryValue,
  MEMORY_TELEMETRY_SCHEMA,
  type TelemetryFieldSpec,
} from '../src/memory/telemetry.ts'

/**
 * An in-memory file system for the lease and topic tests.
 *
 * `rename` is a real move between keys rather than a copy, so a topic that was staged
 * and then moved is indistinguishable from one written in place — which is the point:
 * the tests assert the end state, and the sequence is asserted separately by the
 * case that records operations.
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

describe('rollout stages', () => {
  test('there are four, ordered from silent to live', () => {
    expect(ROLLOUT_STAGES).toEqual(['off', 'record_only', 'shadow', 'active'])
  })

  test.each([
    ['off', false, false, false, false],
    ['record_only', true, false, false, false],
    ['shadow', true, true, false, false],
    ['active', true, true, true, true],
  ] as const)('%s permits the documented behaviour', (stage, capture, consolidate, commit, recall) => {
    expect(memoryStageBehaviour(stage)).toEqual({ capture, consolidate, commit, recall })
  })

  test('shadow consolidates but commits nothing', () => {
    // The stage that makes the feature safe to enable in production: the model
    // runs, and its plan is read rather than applied.
    const behaviour = memoryStageBehaviour('shadow')
    expect(behaviour.consolidate).toBe(true)
    expect(behaviour.commit).toBe(false)
  })

  test('the default stage is off', () => {
    const decision = resolveMemoryRollout({ user: undefined })
    expect(decision.stage).toBe('off')
    expect(decision.behaviour.capture).toBe(false)
    // An undeclared stage is not a bad value, so there is nothing to report.
    expect(decision.note).toBeUndefined()
  })

  test.each(ROLLOUT_STAGES.map(stage => [stage] as const))('the declared stage %s is the effective stage', (stage) => {
    // The settings document is the only input, so the decision is the declared
    // stage — not a default, and not something derived from it.
    const decision = resolveMemoryRollout({ user: stage })
    expect(decision.stage).toBe(stage)
    expect(decision.note).toBeUndefined()
  })

  test('an unrecognised user stage leaves the pipeline off rather than guessing', () => {
    // Fail-closed: not a permissive default, and not a crash at load.
    const decision = resolveMemoryRollout({ user: 'turbo' })
    expect(decision.stage).toBe('off')
    expect(decision.note).toContain('turbo')
    expect(decision.note).toContain('left off')
  })

  test.each(ROLLOUT_STAGES.map(stage => [stage] as const))('disabling %s does not fall back to any legacy path', (stage) => {
    // There is no legacy path to fall back to, and that is the invariant: the
    // behaviour table is total, so a disabled stage has no behaviour other than
    // its own.
    const behaviour = memoryStageBehaviour(stage)
    if (stage === 'off') {
      expect(Object.values(behaviour).every(allowed => allowed === false)).toBe(true)
    }
  })
})

describe('telemetry holds no free text', () => {
  test('every declared string is an enum member of its field', () => {
    for (const [event, fields] of Object.entries(MEMORY_TELEMETRY_SCHEMA)) {
      for (const [key, spec] of Object.entries(fields as Record<string, { kind: string; values?: readonly string[] }>)) {
        if (spec.kind !== 'enum') continue
        expect(spec.values, `${event}.${key} must declare its values`).toBeDefined()
        expect(spec.values!.length).toBeGreaterThan(0)
      }
    }
  })

  test('refuses an undeclared field', () => {
    // This is where `{ topic: 'the user's salary' }` dies.
    expect(() => buildMemoryTelemetry('memory.dream', { topic: 'anything' })).toThrow(/free-text fields are not collectable/)
  })

  test('refuses an undeclared string value', () => {
    expect(() => buildMemoryTelemetry('memory.dream', { outcome: 'the user asked about X' })).toThrow(/allowed values/)
  })

  test('refuses a negative or non-finite count', () => {
    expect(() => buildMemoryTelemetry('memory.dream', { observations: -1 })).toThrow(/non-negative finite/)
    expect(() => buildMemoryTelemetry('memory.dream', { observations: Number.NaN })).toThrow(/non-negative finite/)
  })

  test('refuses a string where a boolean belongs', () => {
    expect(() => buildMemoryTelemetry('memory.capture', { truncated: 'yes' })).toThrow(/must be a boolean/)
  })

  test('refuses an unknown event', () => {
    expect(() => buildMemoryTelemetry('memory.telepathy' as 'memory.dream', {})).toThrow(/unknown memory telemetry/)
  })

  test('a valid record round-trips and is frozen', () => {
    const record = buildMemoryTelemetry('memory.dream', { outcome: 'completed', observations: 3, durationMs: 1200, toolCalls: 0 })
    expect(record.event).toBe('memory.dream')
    expect(record.fields).toEqual({ outcome: 'completed', observations: 3, durationMs: 1200, toolCalls: 0 })
    expect(Object.isFrozen(record.fields)).toBe(true)
  })

  test('every value any record can hold passes the collectability check', () => {
    // The property the schema exists for: no record can carry arbitrary text.
    const record = buildMemoryTelemetry('memory.forget', { outcome: 'refused', refusal: 'stale-evidence' })
    for (const value of Object.values(record.fields)) {
      expect(isCollectableTelemetryValue(value)).toBe(true)
    }
    expect(isCollectableTelemetryValue('the user said something private')).toBe(false)
  })

  test('there is no field kind that can hold arbitrary text', () => {
    // The name-based version of this check is worse than useless — `topicsWritten`
    // is a count — so the property is asserted on the *kinds* instead: the only
    // kind that admits a string is `enum`, and every enum's value set is closed.
    const kinds = new Set<string>()
    for (const [event, fields] of Object.entries(MEMORY_TELEMETRY_SCHEMA)) {
      for (const [key, spec] of Object.entries(fields as Record<string, TelemetryFieldSpec>)) {
        kinds.add(spec.kind)
        if (spec.kind !== 'enum') continue
        for (const value of spec.values) {
          expect(typeof value, `${event}.${key} declares a non-string enum member`).toBe('string')
        }
      }
    }
    expect([...kinds].sort()).toEqual(['boolean', 'count', 'durationMs', 'enum'])
  })
})

describe('forgetting requires exact evidence', () => {
  const bytes = 'a memory worth keeping'
  const digest = hashEvidence(bytes)

  /** A context backed by one file, with counters the tests read. */
  function context(overrides: Partial<ForgetContext> = {}): { ctx: ForgetContext; events: string[] } {
    const events: string[] = []
    const ctx: ForgetContext = {
      root: '/home/state/memory',
      tombstoneRoot: '/home/state/memory/.tombstones',
      leaseActive: false,
      knownArchives: ['observations', 'topics', 'archive'],
      exists: () => true,
      isSymlink: () => false,
      read: (path) => {
        events.push(`read ${path}`)
        return bytes
      },
      write: (path, contents) => void events.push(`write ${path} ${JSON.stringify(contents.length)}`),
      append: (path, contents) => void events.push(`append ${path} ${JSON.stringify(contents.length)}`),
      remove: path => void events.push(`remove ${path}`),
      ...overrides,
    }
    return { ctx, events }
  }

  test('removes exactly the file whose bytes were read', () => {
    const { ctx, events } = context()
    const result = forgetObservation({ path: 'observations/01H.json', sha256: digest }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path).toBe('observations/01H.json')
    // Derived with `resolve` rather than written as POSIX text: the module
    // resolves the target against the root in native form (which on Windows
    // includes the drive), and a literal expectation would only hold on one
    // platform while saying nothing about the path actually being used.
    expect(events.filter(entry => entry.startsWith('remove'))).toEqual([
      `remove ${resolve('/home/state/memory', 'observations/01H.json')}`,
    ])
  })

  test('writes the tombstone and the audit record before deleting', () => {
    // A crash between the two must leave a record that someone asked; the
    // reverse order is indistinguishable from corruption.
    const { ctx, events } = context()
    forgetObservation({ path: 'observations/01H.json', sha256: digest }, ctx)
    const removeIndex = events.findIndex(entry => entry.startsWith('remove'))
    const writeIndex = events.findIndex(entry => entry.startsWith('write'))
    expect(writeIndex).toBeGreaterThanOrEqual(0)
    expect(removeIndex).toBeGreaterThan(writeIndex)
    expect(events.some(entry => entry.includes('audit.log'))).toBe(true)
  })

  test('the tombstone is content-free', () => {
    // It records that a path was forgotten and what it hashed to — never what
    // it said, which would make forgetting useless.
    const { ctx, events } = context()
    forgetObservation({ path: 'observations/01H.json', sha256: digest }, ctx)
    const written = events.filter(entry => entry.startsWith('write'))
    expect(written.join('\n')).not.toContain(bytes)
  })

  test('refuses a directory', () => {
    const { ctx } = context()
    const result = forgetObservation({ path: 'observations/', sha256: digest }, ctx)
    expect(result).toMatchObject({ ok: false, refusal: 'broad-request' })
  })

  test('refuses a glob', () => {
    const { ctx } = context()
    for (const pattern of ['observations/*.json', 'observations/**.md', 'obs/[0-9]*.json', 'obs/{a,b}.json']) {
      expect(forgetObservation({ path: pattern, sha256: digest }, ctx)).toMatchObject({ ok: false, refusal: 'broad-request' })
    }
  })

  test('refuses stale evidence', () => {
    const { ctx } = context()
    expect(forgetObservation({ path: 'observations/01H.json', sha256: hashEvidence('something else') }, ctx))
      .toMatchObject({ ok: false, refusal: 'stale-evidence' })
  })

  test('refuses stale evidence when the file is already gone', () => {
    const { ctx } = context({ exists: () => false })
    expect(forgetObservation({ path: 'observations/01H.json', sha256: digest }, ctx))
      .toMatchObject({ ok: false, refusal: 'stale-evidence' })
  })

  test('refuses path traversal', () => {
    const { ctx } = context()
    for (const path of ['../secrets.json', 'observations/../../etc/passwd', '/etc/passwd']) {
      expect(forgetObservation({ path, sha256: digest }, ctx)).toMatchObject({ ok: false, refusal: 'path-traversal' })
    }
  })

  test('forgets a file whose name merely begins with two dots', () => {
    // `..notes.json` is a legal name *inside* the root. The traversal guard used
    // to be a bare `startsWith('..')`, so this file was refused as traversal —
    // with a message about a root it had never left — and could therefore never
    // be forgotten.
    const { ctx, events } = context()
    const result = forgetObservation({ path: 'observations/..notes.json', sha256: digest }, ctx)
    expect(result).toMatchObject({ ok: true, path: 'observations/..notes.json' })
    expect(events.some(entry => entry.startsWith('remove'))).toBe(true)
  })

  test('names the root itself rather than calling it outside', () => {
    const { ctx } = context()
    const result = forgetObservation({ path: '.', sha256: digest }, ctx)
    expect(result).toMatchObject({ ok: false, refusal: 'path-traversal' })
    if (result.ok) throw new Error('the archive root must not be forgettable')
    expect(result.message).toContain('the archive root itself')
  })

  test('refuses a symlink, even one that points inside the root', () => {
    const { ctx } = context({ isSymlink: () => true })
    expect(forgetObservation({ path: 'observations/link.json', sha256: digest }, ctx))
      .toMatchObject({ ok: false, refusal: 'symlink' })
  })

  test('refuses a link that resolves outside the root', () => {
    const { ctx } = context({ realPath: path => (path.replace(/\\/g, '/').endsWith('observations/escape.json') ? '/etc/escape.json' : path) })
    expect(forgetObservation({ path: 'observations/escape.json', sha256: digest }, ctx))
      .toMatchObject({ ok: false, refusal: 'path-traversal' })
  })

  test('refuses a protected file', () => {
    const { ctx } = context()
    for (const name of ['MEMORY.md', 'manifest.json', 'schema.json']) {
      expect(forgetObservation({ path: name, sha256: digest }, ctx)).toMatchObject({ ok: false, refusal: 'protected' })
    }
  })

  test('refuses an archive this build does not know', () => {
    const { ctx } = context()
    expect(forgetObservation({ path: 'mystery/01H.json', sha256: digest }, ctx))
      .toMatchObject({ ok: false, refusal: 'unknown-archive' })
  })

  test('refuses while a dream holds the lease', () => {
    const { ctx, events } = context({ leaseActive: true })
    expect(forgetObservation({ path: 'observations/01H.json', sha256: digest }, ctx))
      .toMatchObject({ ok: false, refusal: 'lease-active' })
    expect(events).toEqual([])
  })

  test('never reads a file it is going to refuse for being outside the root', () => {
    const { ctx, events } = context()
    forgetObservation({ path: '../secrets.json', sha256: digest }, ctx)
    expect(events).toEqual([])
  })
})

describe('forgetting against the real filesystem', () => {
  // Every case above injects all six ports, which is what makes the refusal matrix
  // readable. It is also what left the ports' own fallbacks untested, and two of the
  // properties the module promises live exactly there.
  let directory: string

  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'freecodego-forget-')) })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  /** A record inside the root, ready to forget, with its evidence hash. */
  function record(root: string, name = 'a.json'): { path: string; bytes: string } {
    mkdirSync(join(root, 'observations'), { recursive: true })
    const bytes = '{"observation":"x"}'
    const path = join(root, 'observations', name)
    writeFileSync(path, bytes, 'utf8')
    return { path, bytes }
  }

  test('writes the tombstone and the audit record with no writer injected', () => {
    // The module's ordering argument is that a crash between the write and the delete
    // leaves a record that someone asked. Five of the six ports fall back to the real
    // filesystem when they are not injected; `write` did nothing at all, so a caller
    // that did not inject one got a `forgotten` result naming a tombstone and an audit
    // record that had never been created — the audit trail the ordering exists for,
    // absent, and reported as present.
    const root = join(directory, 'memory')
    const { path, bytes } = record(root)
    const result = forgetObservation(
      { path: 'observations/a.json', sha256: hashEvidence(bytes) },
      { root, tombstoneRoot: join(root, '.tombstones'), leaseActive: false },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(existsSync(result.tombstone)).toBe(true)
    expect(existsSync(result.audit)).toBe(true)
    // And the delete did happen, so the record is about a real removal rather than a
    // refusal that reported success.
    expect(existsSync(path)).toBe(false)
  })

  test('appends one audit line per forget instead of replacing the log', () => {
    // A truncating writer leaves the trail with a single entry, and that is
    // invisible until the second forget — by which point the first one's record is
    // gone. The log is the only place that says a removal was asked for.
    const root = join(directory, 'memory')
    const first = record(root, 'a.json')
    const second = record(root, 'b.json')
    const context = { root, tombstoneRoot: join(root, '.tombstones'), leaseActive: false }
    const one = forgetObservation({ path: 'observations/a.json', sha256: hashEvidence(first.bytes) }, context)
    const two = forgetObservation({ path: 'observations/b.json', sha256: hashEvidence(second.bytes) }, context)
    expect(one.ok && two.ok).toBe(true)
    if (!one.ok) return
    const lines = readFileSync(one.audit, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('observations/a.json')
    expect(lines[1]).toContain('observations/b.json')
  })

  test('refuses a linked directory whose name merely starts with the root\'s', () => {
    // The containment check compares the target's real path against the root's with
    // `startsWith`, and `/tmp/memory-backup/x` starts with `/tmp/memory`. A directory
    // link inside the archive pointing at such a sibling therefore passes the very
    // check that exists to stop it, and the file outside the root is deleted.
    const root = join(directory, 'memory')
    const { bytes } = record(root)
    const outside = join(directory, 'memory-backup')
    mkdirSync(outside, { recursive: true })
    const secret = join(outside, 'secret.json')
    writeFileSync(secret, '{"private":"yes"}', 'utf8')
    try {
      symlinkSync(outside, join(root, 'observations', 'link'), process.platform === 'win32' ? 'junction' : undefined)
    } catch (error: unknown) {
      throw new Error(`this environment cannot create the directory link the case needs: ${String(error)}`)
    }

    const escaped = forgetObservation(
      { path: 'observations/link/secret.json', sha256: hashEvidence('{"private":"yes"}') },
      { root, tombstoneRoot: join(root, '.tombstones'), leaseActive: false },
    )
    expect(escaped).toMatchObject({ ok: false, refusal: 'path-traversal' })
    expect(existsSync(secret)).toBe(true)

    // The control that keeps the assertion above honest: a record reached without a
    // link is still forgettable in the same tree, so a refusal there could not have
    // been a path-format artefact of this platform's temp directory.
    const inside = forgetObservation(
      { path: 'observations/a.json', sha256: hashEvidence(bytes) },
      { root, tombstoneRoot: join(root, '.tombstones'), leaseActive: false },
    )
    expect(inside.ok).toBe(true)
  })
})

describe('the manifest index', () => {
  const entries = [
    { name: 'zeta', path: '/home/state/topics/zeta.md', description: 'last alphabetically' },
    { name: 'alpha', path: '/home/state/topics/alpha.md', description: 'first alphabetically' },
  ]

  test('points at absolute paths', () => {
    const manifest = renderMemoryManifest(entries)
    expect(manifest.markdown).toContain('/home/state/topics/alpha.md')
    expect(manifest.included).toBe(2)
    expect(manifest.truncated).toBe(false)
  })

  test('orders entries stably so a regeneration is not a diff', () => {
    expect(renderMemoryManifest(entries).markdown.indexOf('alpha')).toBeLessThan(
      renderMemoryManifest(entries).markdown.indexOf('zeta'),
    )
  })

  test('drops whole lines on overflow and says how many were dropped', () => {
    const many = Array.from({ length: 40 }, (_unused, index) => ({
      name: `topic-${String(index).padStart(2, '0')}`,
      path: `/home/state/topics/topic-${index}.md`,
      description: 'a description that must not be cut in half',
    }))
    const manifest = renderMemoryManifest(many, { budgetChars: 600 })
    expect(manifest.truncated).toBe(true)
    expect(manifest.omitted).toBeGreaterThan(0)
    expect(manifest.markdown).toContain(`${manifest.omitted} more records`)
  })

  test('counts the overflow notice inside the budget it promises', () => {
    // The notice is part of the index, and it used to be appended outside the
    // budget — so the one case the budget exists for (more records than fit) was
    // the one case where the rendered index was longer than it claimed to be.
    const many = Array.from({ length: 40 }, (_unused, index) => ({
      name: `topic-${String(index).padStart(2, '0')}`,
      path: `/home/state/topics/topic-${index}.md`,
      description: 'a description that must not be cut in half',
    }))
    for (const budget of [600, 1_200, 4_000]) {
      const manifest = renderMemoryManifest(many, { budgetChars: budget })
      expect(manifest.markdown.length).toBeLessThanOrEqual(budget)
    }
  })

  test('never truncates a description to make it fit', () => {
    const long = [{ name: 'only', path: '/x/only.md', description: 'd'.repeat(400) }]
    const manifest = renderMemoryManifest(long, { budgetChars: 200 })
    // It did not fit, so it is absent entirely rather than present and wrong.
    expect(manifest.included).toBe(0)
    expect(manifest.markdown).not.toContain('ddd')
  })
})

describe('the dream lease', () => {
  const base = { directory: '/m', owner: 'pass-1', now: 1_000 }

  test('one acquire at a time', () => {
    const { io } = memoryIo()
    expect(acquireDreamLease({ ...base, io }).ok).toBe(true)
    const second = acquireDreamLease({ ...base, owner: 'pass-2', io })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.heldBy.owner).toBe('pass-1')
  })

  test('an expired lease is taken over and reported as superseded', () => {
    const { io } = memoryIo()
    acquireDreamLease({ ...base, ttlMs: 500, io })
    const takeover = acquireDreamLease({ ...base, owner: 'pass-2', now: 2_000, io })
    expect(takeover.ok).toBe(true)
    if (!takeover.ok) return
    expect(takeover.superseded?.owner).toBe('pass-1')
  })

  test('a malformed lease is treated as absent rather than disabling the feature forever', () => {
    const { io } = memoryIo({ [`/m/${DREAM_LEASE_FILENAME}`]: 'not json' })
    expect(acquireDreamLease({ ...base, io }).ok).toBe(true)
  })

  test('only the holder can release it', () => {
    const { io } = memoryIo()
    acquireDreamLease({ ...base, io })
    expect(releaseDreamLease({ ...base, owner: 'pass-2', io })).toBe(false)
    expect(releaseDreamLease({ ...base, io })).toBe(true)
  })
})

describe('snapshot isolation', () => {
  const observations: readonly MemoryObservation[] = [
    { id: 'B', sha256: 'b', capturedAt: 20, text: 'second' },
    { id: 'A', sha256: 'a', capturedAt: 10, text: 'first' },
  ]

  test('orders by capture time and then id, regardless of arrival order', () => {
    expect(snapshotObservations(observations).map(entry => entry.id)).toEqual(['A', 'B'])
    expect(snapshotObservations([...observations].reverse()).map(entry => entry.id)).toEqual(['A', 'B'])
  })

  test('takes a copy, so a late arrival cannot join the pass', () => {
    const source: MemoryObservation[] = [...observations]
    const snapshot = snapshotObservations(source)
    source.push({ id: 'C', sha256: 'c', capturedAt: 30, text: 'late' })
    expect(snapshot.map(entry => entry.id)).toEqual(['A', 'B'])
  })
})

describe('the consolidation pass runs with no tools', () => {
  const observations: readonly MemoryObservation[] = [{ id: 'A', sha256: 'a', capturedAt: 1, text: 'something happened' }]

  test('the request carries an empty tool list', () => {
    // The property the whole pass rests on: a consolidating model cannot read or
    // change the repository, so its output can only be curated topics.
    const request = buildConsolidationRequest({ observations, existingTopics: ['errors'], instructions: 'Distill.' })
    expect(request.tools).toEqual([])
    expect(request.tools).toHaveLength(0)
  })

  test('the request still carries everything the pass needs', () => {
    const request = buildConsolidationRequest({ observations, existingTopics: ['errors'], instructions: 'Distill.' })
    expect(request.system).toBe('Distill.')
    expect(request.prompt).toContain('something happened')
    expect(request.existingTopics).toEqual(['errors'])
  })
})

describe('topic commits are all-or-nothing per topic', () => {
  const plan: ConsolidationPlan = {
    commit: true,
    topics: [{ slug: 'errors', title: 'Errors', markdown: 'Body.', sources: ['A'] }],
  }

  test('a shadow plan writes nothing', () => {
    const { io, files } = memoryIo()
    expect(commitTopics({ plan: { ...plan, commit: false }, directory: '/t', io })).toEqual([])
    expect(files.size).toBe(0)
  })

  test('a committing plan writes the topic and leaves no temporary behind', () => {
    const { io, files } = memoryIo()
    expect(commitTopics({ plan, directory: '/t', io })).toEqual(['errors'])
    expect([...files.keys()]).toEqual(['/t/errors.md'])
    expect(files.get('/t/errors.md')).toContain('# Errors')
    expect(files.get('/t/errors.md')).toContain('Derived from: A')
  })

  test('stages every topic and moves it, never writing the real name in place', () => {
    // The property the header promises: no reader can observe a partial topic under
    // its real name. It is asserted as a sequence because the end state cannot show
    // it — a direct write and a staged move leave the same map behind.
    const operations: string[] = []
    const files = new Map<string, string>()
    const io: DreamIo = {
      read: path => files.get(path),
      write: (path, contents) => { operations.push(`write ${path}`); files.set(path, contents) },
      rename: (from, to) => {
        operations.push(`rename ${from} -> ${to}`)
        files.set(to, files.get(from) ?? '')
        files.delete(from)
      },
      remove: path => void files.delete(path),
    }
    commitTopics({ plan, directory: '/t', io })
    // Never the target, which is the whole difference between atomic and not.
    expect(operations).toStrictEqual(['write /t/errors.md.tmp', 'rename /t/errors.md.tmp -> /t/errors.md'])
    expect(files.get('/t/errors.md')).toContain('# Errors')
  })

  test('a slug that could escape its directory is skipped', () => {
    const { io, files } = memoryIo()
    const escaped = commitTopics({
      plan: { commit: true, topics: [{ slug: '../escape', title: 'x', markdown: 'y', sources: [] }] },
      directory: '/t',
      io,
    })
    expect(escaped).toEqual([])
    expect(files.size).toBe(0)
  })
})

describe('the stage has one source', () => {
  test('the decision is a pure function of the declared stage', () => {
    // The rollout used to clamp the declared stage against a deployment-issued
    // one. That layer is gone, and this is the property that replaces the
    // clamp's: for every declared value there is exactly one decision, and it is
    // the one the declared stage names — so no caller can obtain a different
    // answer for the same setting.
    const declared: readonly (string | undefined)[] = [...ROLLOUT_STAGES, undefined, 'turbo']
    for (const user of declared) {
      const first = resolveMemoryRollout({ user })
      const second = resolveMemoryRollout({ user })
      expect(second).toStrictEqual(first)
      expect(ROLLOUT_STAGES).toContain(first.stage)
    }
  })

  test('a stage the build does not define is never the effective stage', () => {
    // The failure this rules out is a future stage name from a newer deployment
    // being carried into the behaviour table, where `STAGE_BEHAVIOUR[value]` would
    // be `undefined` and every `behaviour.*` read after it would throw.
    const decision = resolveMemoryRollout({ user: 'active_from_the_future' })
    expect(decision.stage).toBe('off')
    expect(decision.behaviour).toBe(memoryStageBehaviour('off'))
  })
})

/**
 * Whether two spellings of one name are one file here.
 *
 * Probed rather than assumed, because the refusal below exists only where they are
 * one file: on a case-sensitive filesystem `memory.md` is a different file, and
 * refusing it would be a refusal about nothing. The probe writes a file and asks for
 * it in another case.
 */
const caseInsensitiveFilesystem = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'freecodego-memory-case-'))
  try {
    writeFileSync(join(probe, 'Probe.md'), 'x', 'utf8')
    return existsSync(join(probe, 'probe.md'))
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

describe('forget: the index the archive is named after', () => {
  let root = ''
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'freecodego-forget-index-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  test.skipIf(!caseInsensitiveFilesystem)('refuses the index through the spelling the filesystem resolves to it', () => {
    // The name check compares the spelling the request used. Where `memory.md` and
    // `MEMORY.md` are one file that is not enough: the bytes read through either
    // spelling are the same bytes, so the evidence check passes and the delete lands
    // on the index — the file every other record takes its name from. The archive
    // guard is asked afterwards and would refuse a root-level file only as
    // 'unknown-archive', i.e. by accident and for the wrong reason, which is why the
    // identity check is pinned with the pipeline's archive list supplied.
    //
    // Mutation: dropping the identity check leaves `ok: true` here and the index is
    // gone from disk.
    const bytes = '<!-- freecodego memory index -->\n'
    writeFileSync(join(root, 'MEMORY.md'), bytes, 'utf8')
    const result = forgetObservation({ path: 'memory.md', sha256: hashEvidence(bytes) }, {
      root,
      tombstoneRoot: join(root, '.tombstones'),
      leaseActive: false,
      knownArchives: MEMORY_ARCHIVES,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal).toBe('protected')
    expect(existsSync(join(root, 'MEMORY.md'))).toBe(true)
  })

  test('refuses a directory whether or not the request spells it with a slash', () => {
    // "A directory is a set, and a set has no evidence to check" is a refusal about
    // the request, not about one way of writing it. Without the directory branch the
    // trailing-slash spelling is refused and the natural one throws `EISDIR` out of
    // a function whose contract is that a refusal is an answer and not an exception.
    const context = { root, tombstoneRoot: join(root, '.tombstones'), leaseActive: false }
    mkdirSync(join(root, 'observations'), { recursive: true })
    const withSlash = forgetObservation({ path: 'observations/', sha256: hashEvidence('x') }, context)
    const withoutSlash = forgetObservation({ path: 'observations', sha256: hashEvidence('x') }, context)
    expect(withSlash.ok).toBe(false)
    expect(withoutSlash.ok).toBe(false)
    if (withoutSlash.ok || withSlash.ok) return
    expect(withoutSlash.refusal).toBe('broad-request')
    expect(withoutSlash.refusal).toBe(withSlash.refusal)
  })
})
