import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineeringMemoryStore, lexicalRelevance } from '../src/engineering-memory.ts'
import { ENGINEERING_MEMORY_KINDS } from '../src/types.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('memory reference graph', () => {
  const source = (sessionId: string, eventSequence: number, files: readonly string[], turn?: number) => ({
    sessionId, eventSequence, eventType: 'tool/call', filesRead: [], filesWritten: [...files], ...(turn === undefined ? {} : { turn }), capturedAt: Date.now(),
  })
  const capture = (store: EngineeringMemoryStore, cwd: string, title: string, generation: string, sessionId: string, files: readonly string[], turn?: number) =>
    store.saveCaptured({ cwd, sessionId, generation, kind: 'change', title, body: `${title} body.`, tags: [], sources: [source(sessionId, 1, files, turn)] })

  it('links two records that touched the same file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-graph-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const first = capture(store, directory, 'Edit retry policy', 'g1', 's1', ['src/retry.ts'])
    const second = capture(store, directory, 'Add retry test', 'g2', 's2', ['src/retry.ts'])
    const detail = store.get({ cwd: directory, ids: [first.id], includeCaptured: true })[0]
    const relation = detail?.related.find(entry => entry.id === second.id)
    expect(relation).toMatchObject({ relation: 'shared-file', via: 'src/retry.ts' })
    store.close()
  })

  it('falls back to a session link when the files differ', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-graph-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // Same session AND the same turn, but disjoint files: the turn link is the
    // stronger of the two session signals and must be the one reported.
    const first = capture(store, directory, 'First change', 'g1', 's1', ['src/a.ts'], 7)
    const second = capture(store, directory, 'Second change', 'g2', 's1', ['src/b.ts'], 7)
    const relation = store.get({ cwd: directory, ids: [first.id], includeCaptured: true })[0]?.related.find(entry => entry.id === second.id)
    expect(relation).toMatchObject({ relation: 'same-turn', via: 's1' })
    store.close()
  })

  it('falls back to a whole-session link when the turns differ', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-graph-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const first = capture(store, directory, 'Turn one', 'g1', 's1', ['src/a.ts'], 1)
    const second = capture(store, directory, 'Turn two', 'g2', 's1', ['src/b.ts'], 2)
    const relation = store.get({ cwd: directory, ids: [first.id], includeCaptured: true })[0]?.related.find(entry => entry.id === second.id)
    expect(relation).toMatchObject({ relation: 'same-session' })
    store.close()
  })

  it('never links across projects', async () => {
    const left = await mkdtemp(join(tmpdir(), 'freecodego-memory-graph-a-'))
    const right = await mkdtemp(join(tmpdir(), 'freecodego-memory-graph-b-'))
    directories.push(left, right)
    const store = new EngineeringMemoryStore(join(left, 'store'))
    await store.open()
    const first = capture(store, left, 'Left change', 'g1', 's1', ['src/shared.ts'])
    capture(store, right, 'Right change', 'g2', 's1', ['src/shared.ts'])
    expect(store.get({ cwd: left, ids: [first.id], includeCaptured: true })[0]?.related).toEqual([])
    store.close()
  })

  it('does not reach a rejected record through the graph', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-graph-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const first = capture(store, directory, 'Kept change', 'g1', 's1', ['src/x.ts'])
    const rejected = capture(store, directory, 'Rejected change', 'g2', 's2', ['src/x.ts'])
    store.review({ cwd: directory, id: rejected.id, trust: 'rejected' })
    const related = store.get({ cwd: directory, ids: [first.id], includeCaptured: true })[0]?.related ?? []
    expect(related.map(entry => entry.id)).not.toContain(rejected.id)
    store.close()
  })

  it('returns no edges for a record with no observations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-graph-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const draft = store.saveDraft({ cwd: directory, title: 'Unsourced note', body: 'No observation behind this.' })
    expect(store.getForReview({ cwd: directory, ids: [draft.id] })[0]?.related).toEqual([])
    store.close()
  })

  it('does not lower a neighbour score when it has repeated source rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-graph-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const first = capture(store, directory, 'Hub change', 'g0', 's1', ['src/shared.ts'])
    const single = capture(store, directory, 'Single evidence', 'g1', 's8', ['src/shared.ts'])
    const repeated = store.saveCaptured({
      cwd: directory,
      sessionId: 's9',
      generation: 'g2',
      kind: 'change',
      title: 'Repeated evidence',
      body: 'Repeated evidence body.',
      tags: [],
      sources: [source('s9', 1, ['src/shared.ts']), source('s9', 2, ['src/shared.ts'])],
    })
    const related = store.get({ cwd: directory, ids: [first.id], includeCaptured: true })[0]?.related ?? []
    const singleRelation = related.find(entry => entry.id === single.id)
    const repeatedRelation = related.find(entry => entry.id === repeated.id)
    // A shared-file edge is weight 2 regardless of how many source rows the
    // neighbour happens to carry; the old update formula gave 4 to one row but
    // oscillated to 2 after a second row for the same neighbour.
    expect(singleRelation).toMatchObject({ relation: 'shared-file', weight: 2 })
    expect(repeatedRelation).toMatchObject({ relation: 'shared-file', weight: 2 })
    store.close()
  })

  it('orders neighbours deterministically, strongest link first', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-graph-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const hub = capture(store, directory, 'Hub change', 'g0', 's1', ['src/shared.ts'])
    capture(store, directory, 'File neighbour', 'g1', 's9', ['src/shared.ts'])
    capture(store, directory, 'Session neighbour', 'g2', 's1', ['src/other.ts'])
    const related = store.get({ cwd: directory, ids: [hub.id], includeCaptured: true })[0]?.related ?? []
    expect(related[0]).toMatchObject({ relation: 'shared-file' })
    expect(related.map(entry => entry.title)).toEqual([...related.map(entry => entry.title)].sort((left, right) => {
      const leftEntry = related.find(entry => entry.title === left)!
      const rightEntry = related.find(entry => entry.title === right)!
      return rightEntry.weight - leftEntry.weight || left.localeCompare(right)
    }))
    store.close()
  })
})

describe('lexical relevance', () => {
  it('scores a full-coverage match above a partial one', () => {
    const tokens = ['retry', 'backoff']
    const full = lexicalRelevance(tokens, 'Retry backoff policy', 'Bounded retry with exponential backoff.')
    const partial = lexicalRelevance(tokens, 'Retry policy', 'Bounded retry on transient failures.')
    expect(full).toBeGreaterThan(partial)
  })

  it('ranks a title match above an equally dense body match', () => {
    const tokens = ['idempotency']
    const inTitle = lexicalRelevance(tokens, 'Idempotency key', 'Short note.')
    const inBody = lexicalRelevance(tokens, 'Short note', 'Idempotency key handling.')
    expect(inTitle).toBeGreaterThan(inBody)
  })

  it('is zero without a matched term and with no query at all', () => {
    expect(lexicalRelevance(['missing'], 'Unrelated title', 'Unrelated body')).toBe(0)
    expect(lexicalRelevance([], 'Any title', 'Any body')).toBe(0)
  })

  it('is deterministic for identical inputs', () => {
    const args = [['retry'], 'Retry', 'Bounded retry'] as const
    expect(lexicalRelevance(...args)).toBe(lexicalRelevance(...args))
  })
})

describe('engineering memory', () => {
  /** One verification turn for `sessionId`, the shape a session summary observation has. */
  const observation = (cwd: string, sessionId: string, generation: string, body: string, turn = 1) => ({
    cwd, sessionId, generation, kind: 'verification' as const, title: `Turn ${turn}`, body, tags: [],
    sources: [{ sessionId, eventSequence: 1, eventType: 'tool/call', turn, filesRead: [], filesWritten: [], capturedAt: Date.now() }],
  })

  it('makes AI-saved project memory available only after a review promotion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const draft = store.saveDraft({ cwd: directory, title: 'Retry decision', body: 'Use bounded retries after transient provider failures.', kind: 'decision', tags: ['retry'] })
    expect(draft.trust).toBe('draft')
    expect(store.search({ cwd: directory, query: 'retry' })).toHaveLength(0)
    expect(store.review({ cwd: directory, id: draft.id, trust: 'reviewed' }).trust).toBe('reviewed')
    expect(store.search({ cwd: directory, query: 'retry' })).toHaveLength(1)
    expect(store.get({ cwd: directory, ids: [draft.id] })[0]).toMatchObject({ id: draft.id, trust: 'reviewed', tags: ['retry'] })
    store.close()
  })


  it('consolidates one observation into atomic facts and reconciles repeats', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const base = { cwd: directory, sessionId: 's1', generation: 'g1', sources: [{ sessionId: 's1', eventSequence: 1, eventType: 'tool/call', turn: 1, filesRead: [], filesWritten: ['src/a.ts'], capturedAt: Date.now() }] }
    const body1 = 'Captured 2 structured tool events from turn 1.\nTool result status: 0 structured failures observed.'
    const first = store.consolidateObservation({ ...base, kind: 'change', title: 'Turn 1', body: body1, tags: [] })
    expect(first.items.some(item => item.action === 'added' && item.fact.includes('src/a.ts'))).toBe(true)
    const count = store.search({ cwd: directory, includeCaptured: true }).length
    expect(count).toBeGreaterThan(0)
    // Same content again -> NOOP, no duplicate records.
    const repeat = store.consolidateObservation({ ...base, kind: 'change', title: 'Turn 1', body: body1, tags: [] })
    expect(repeat.items.filter(item => item.action === 'noop').length).toBeGreaterThan(0)
    expect(store.search({ cwd: directory, includeCaptured: true }).length).toBe(count)
    // Same subject with changed content -> supersede, count stays stable.
    // The file fact body records the turn number, so a turn-2 write of the
    // same path must refresh (update) the prior turn-1 fact.
    const base2 = { ...base, sources: [{ ...base.sources[0]!, turn: 2 }] }
    const body2 = 'Captured 2 structured tool events from turn 2.\nFiles changed: src/a.ts with new content.\nTool result status: 1 structured failure observed.\nTools: write'
    const changed = store.consolidateObservation({ ...base2, kind: 'change', title: 'Turn 2', body: body2, tags: [] })
    expect(changed.items.some(item => item.action === 'updated' || item.action === 'superseded')).toBe(true)
    store.close()
  })

  it('keeps one verification per session instead of letting a newer session retire an older one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // Both sessions render the same verification title, but they are different
    // subjects: the second session's fact must be its own record, not a
    // replacement that quietly deletes the first one's evidence.
    expect(store.consolidateObservation(observation(directory, 's1', 'g1', 'Verification passed for turn 1.')).items[0]?.action).toBe('added')
    expect(store.consolidateObservation(observation(directory, 's2', 'g2', 'Verification passed for turn 9.', 9)).items[0]).toMatchObject({ action: 'added', supersededIds: [] })
    expect(store.search({ cwd: directory, includeCaptured: true })).toHaveLength(2)
    store.close()
  })

  it('retires a stale failure when the same session later verifies cleanly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // A failed and a passed verification render different titles but are one
    // subject: the outcome changed, so the failure must stop being current
    // knowledge rather than standing beside the pass forever.
    expect(store.consolidateObservation(observation(directory, 's1', 'g1', 'Verification failed: 2 checks red.')).items[0]?.fact).toMatch(/verification failed/i)
    const passed = store.consolidateObservation(observation(directory, 's1', 'g2', 'Verification passed for turn 2.', 2))
    expect(passed.items[0]?.action).toBe('updated')
    const current = store.search({ cwd: directory, includeCaptured: true })
    expect(current).toHaveLength(1)
    expect(current[0]?.title).toBe('Verification passed for the recorded turn')
    store.close()
  })

  it('reconciles a record that carries no subject by its title', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // A promoted draft has no subject, exactly like a row written before the
    // subject column existed: an upgrade must still fold a new fact onto it
    // instead of leaving the old statement live beside a duplicate.
    const legacy = store.saveDraft({ cwd: directory, title: 'Verification passed for the recorded turn', body: 'Recorded before facts carried a subject.' })
    store.review({ cwd: directory, id: legacy.id, trust: 'reviewed' })
    const items = store.consolidateObservation(observation(directory, 's1', 'g1', 'Verification passed for turn 4.', 4)).items
    expect(items[0]).toMatchObject({ action: 'superseded', supersededIds: [legacy.id] })
    expect(store.get({ cwd: directory, ids: [legacy.id], includeCaptured: true })).toEqual([])
    store.close()
  })

  it('reads a verification verdict from the status line rather than from the word failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // The turn compiler writes this sentence on every healthy turn, so a bare
    // "failure" seen anywhere in the body would record a green verification as a
    // failed one — durable knowledge that says the opposite of what happened.
    const clean = 'Captured 3 structured tool events from turn 1.\nTools: engineering_verify, read_file.\nTool result status: no structured failures observed.'
    expect(store.consolidateObservation(observation(directory, 's1', 'g1', clean)).items[0]?.fact).toBe('Verification passed for the recorded turn')
    // Prose that mentions an earlier failure must not become the verdict either.
    const prose = 'Verification passed after the retry failure was fixed.\nTool result status: no structured failures observed.'
    expect(store.consolidateObservation(observation(directory, 's2', 'g2', prose)).items[0]?.fact).toBe('Verification passed for the recorded turn')
    // The observed count still decides a real failure.
    expect(store.consolidateObservation(observation(directory, 's1', 'g3', 'Tool result status: 3 structured failures observed.', 2)).items[0]?.fact).toBe('Verification failed — see turn evidence')
    store.close()
  })

  it('upgrades a database written before facts carried a subject', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    // The project id the store hashes this directory to, read from a store that
    // keeps its file elsewhere: this directory's own file has to be written as
    // the older build wrote it, before anything opens it.
    const scratch = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-probe-'))
    directories.push(scratch)
    const probe = new EngineeringMemoryStore(scratch)
    await probe.open()
    const projectId = probe.recall({ cwd: directory, tokenBudget: 48 }).projectId
    probe.close()
    const file = join(directory, 'engineering-memory.sqlite')
    const legacy = new DatabaseSync(file)
    legacy.exec('CREATE TABLE engineering_memories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, trust TEXT NOT NULL, body TEXT NOT NULL, tags_json TEXT NOT NULL, source_engine TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL)')
    legacy.prepare('INSERT INTO engineering_memories(id, project_id, title, kind, trust, body, tags_json, source_engine, created_at, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('mem_ffffffffffffffffffffffffffffffff', projectId, 'Verification passed for the recorded turn', 'verification', 'reviewed', 'Recorded before facts carried a subject.', '[]', null, Date.now(), Date.now(), 'legacy')
    legacy.close()
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // Opening adds the missing column, and a new fact still folds onto the row
    // that predates it: an upgrade that duplicated it instead would leave two
    // live answers to one subject.
    const items = store.consolidateObservation(observation(directory, 's1', 'g1', 'Verification passed for turn 4.', 4)).items
    expect(items[0]).toMatchObject({ action: 'superseded', supersededIds: ['mem_ffffffffffffffffffffffffffffffff'] })
    expect(store.get({ cwd: directory, ids: ['mem_ffffffffffffffffffffffffffffffff'], includeCaptured: true })).toEqual([])
    store.close()
    const inspector = new DatabaseSync(file)
    const columns = inspector.prepare('PRAGMA table_info(engineering_memories)').all() as { readonly name?: unknown }[]
    inspector.close()
    expect(columns.some(column => column.name === 'subject')).toBe(true)
  })

  it('keeps the record it was replacing when the replacement cannot be written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    store.consolidateObservation(observation(directory, 's1', 'g1', 'Verification passed for turn 1.'))
    const live = store.search({ cwd: directory, includeCaptured: true })
    expect(live).toHaveLength(1)
    const recordId = live[0]?.id ?? ''
    // The second verification has a different body, so it reaches the
    // supersede path, and that body is unusable: everything private is stripped
    // before storage, which leaves nothing to write. The retirement must roll
    // back with it — a retired record whose replacement never landed is
    // knowledge that disappears from every search.
    expect(() => store.consolidateObservation(observation(directory, 's1', 'g2', '<private>\nVerification passed again for turn 2.\n</private>', 2))).toThrow(/observation body is required/i)
    expect(store.get({ cwd: directory, ids: [recordId], includeCaptured: true })[0]?.trust).toBe('captured')
    store.close()
  })

  it('keeps a saved draft pending until review accepts it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const draft = store.saveDraft({ cwd: directory, title: 'Handoff draft', body: 'Pending project handoff knowledge.', kind: 'handoff' })
    expect(draft.trust).toBe('draft')
    expect(store.list({ cwd: directory, trusts: ['draft'] }).records.map(record => record.id)).toEqual([draft.id])
    expect(store.timeline({ cwd: directory, id: draft.id, trusts: ['draft'] }).anchor).toMatchObject({ id: draft.id, trust: 'draft' })
    expect(store.getForReview({ cwd: directory, ids: [draft.id] })[0]).toMatchObject({ id: draft.id, trust: 'draft' })
    expect(store.review({ cwd: directory, id: draft.id, trust: 'reviewed' })).toMatchObject({ id: draft.id, trust: 'reviewed' })
    expect(store.list({ cwd: directory, trusts: ['reviewed'] }).records.map(record => record.id)).toEqual([draft.id])
    expect(() => store.review({ cwd: directory, id: draft.id, trust: 'rejected' })).toThrow(/pending draft or captured/i)
    const stale = store.saveDraft({ cwd: directory, title: 'Stale draft', body: 'Another pending draft.' })
    expect(store.purgeProject({ cwd: directory })).toMatchObject({ deleted: 1 })
    expect(store.getForReview({ cwd: directory, ids: [stale.id] })).toEqual([])
    store.close()
  })

  it('keeps reviewed knowledge through the default purge, and clears it only when asked', async () => {
    // The default purge is the one a person reaches by accident, so the half that
    // matters is what it *keeps* — and the existing case only counts deletions,
    // which passes even when reviewed knowledge is included. The set it clears is
    // derived from the shared trust vocabulary rather than written out here, so
    // this also pins that the derivation leaves exactly one state behind.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const reviewed = store.saveDraft({ cwd: directory, title: 'Reviewed knowledge', body: 'Durable project knowledge.' })
    store.review({ cwd: directory, id: reviewed.id, trust: 'reviewed' })
    const draft = store.saveDraft({ cwd: directory, title: 'Pending draft', body: 'Not yet reviewed.' })
    expect(store.purgeProject({ cwd: directory })).toEqual({ deleted: 1 })
    expect(store.list({ cwd: directory, trusts: ['reviewed'] }).records.map(record => record.id)).toEqual([reviewed.id])
    expect(store.list({ cwd: directory, trusts: ['draft'] }).records.map(record => record.id)).toEqual([])
    expect(store.list({ cwd: directory, trusts: ['captured'] }).records.map(record => record.id)).toEqual([])
    expect(draft.id).not.toBe(reviewed.id)
    expect(store.purgeProject({ cwd: directory, includeReviewed: true })).toEqual({ deleted: 1 })
    expect(store.list({ cwd: directory, trusts: ['reviewed'] }).records.map(record => record.id)).toEqual([])
    store.close()
  })

  it('carries every declared memory kind through a save and a read', async () => {
    // Two halves on purpose. The pinned list is the contract: the vocabulary is
    // the `engineering_memory_save` schema's `enum` and this store's column, so a
    // change to it has to be looked at in both places rather than drifting one
    // member at a time. The loop then proves the store accepts each one — a kind
    // the vocabulary declares and the write path refuses is a documented value
    // that throws.
    expect([...ENGINEERING_MEMORY_KINDS]).toEqual([
      'decision', 'discovery', 'bugfix', 'change', 'blocker', 'verification', 'handoff', 'note',
    ])
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-kinds-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    for (const kind of ENGINEERING_MEMORY_KINDS) {
      const saved = store.saveDraft({ cwd: directory, title: `${kind} record`, body: `A record of kind ${kind}.`, kind })
      expect(saved.kind).toBe(kind)
      // Read back through the review view: a draft is not part of the durable
      // read path until it is reviewed, which is the store's own rule.
      expect(store.getForReview({ cwd: directory, ids: [saved.id] })[0]).toMatchObject({ kind, trust: 'draft' })
    }
    store.close()
  })

  it('keeps every declared kind through the outbox, not only the ones it recognises', async () => {
    // `isMemoryKind` decides whether an observation keeps its name or is coerced to
    // `'note'`, and it spelled the eight names out a second time. A kind added to
    // the vocabulary would then be offered by the schema, accepted by the type,
    // written by `saveDraft` — and renamed on the way back through the outbox,
    // where nothing reports the loss. This goes through the queue rather than the
    // store so that the parsing half is the path under test.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-outbox-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const source = { sessionId: 'session-1', eventSequence: 1, eventType: 'turn/end', filesRead: [], filesWritten: [], capturedAt: Date.now() }
    for (const kind of ENGINEERING_MEMORY_KINDS) {
      store.enqueueObservation({ cwd: directory, sessionId: 'session-1', generation: `generation-${kind}`, kind, title: `${kind} observation`, body: `An observation of kind ${kind}.`, tags: [], sources: [source] })
    }
    expect(store.drainOutbox(50)).toEqual({ drained: ENGINEERING_MEMORY_KINDS.length, failed: 0 })
    const captured = store.list({ cwd: directory, trusts: ['captured'], limit: 100 }).records
    expect(captured.map(record => record.kind).sort()).toEqual([...ENGINEERING_MEMORY_KINDS].sort())
    store.close()
  })

  it('rejects suspected credential values before writing a draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    expect(() => store.saveDraft({ cwd: directory, title: 'Secret', body: 'api_key=abcdefghijklmnopqrstuvwxyz123456' })).toThrow(/suspected secret/i)
    store.close()
  })

  it('refuses a vendor-prefixed credential that carries no field name to announce it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // Nothing here says `token =`; the keyword rule is structurally blind to it,
    // so the curated vendor-prefix scan is the only thing that can catch it.
    expect(() => store.saveDraft({ cwd: directory, title: 'Release notes', body: 'Rotate ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij before the release.' })).toThrow(/suspected secret/i)
    store.close()
  })

  it('redacts a shape-only credential in place instead of refusing the entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // A JWT is a credential in context and an opaque identifier out of it, so the
    // entry is kept — but the token must not survive into a later conversation.
    const memory = store.saveDraft({ cwd: directory, title: 'Endpoint', body: 'The endpoint returned eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart before it failed.' })
    expect(memory.body).toContain('[redacted credential]')
    expect(memory.body).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(store.getForReview({ cwd: directory, ids: [memory.id] })[0]?.body).toContain('[redacted credential]')
    store.close()
  })

  it('redacts a shape-only credential in a captured observation too', async () => {
    // The captured path had no screen at all while the draft path had one, and the
    // captured path is the unattended one: it stores what the agent read, so a token
    // inside a log line lands here most easily. A store whose protection depends on
    // which write path a user happened to use is protected by accident.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const memory = store.saveCaptured({
      cwd: directory,
      sessionId: 's',
      generation: 'captured-shape-only',
      kind: 'change',
      title: 'Deploy log',
      body: 'The deploy log printed eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart once.',
      tags: [],
      sources: [{ sessionId: 's', eventSequence: 1, eventType: 'tool/result', filesRead: [], filesWritten: [], capturedAt: Date.now() }],
    })
    // `saveCaptured` returns a detail re-read from the store, so this is the
    // persisted body rather than the caller's own string.
    expect(memory.body).toContain('[redacted credential]')
    expect(memory.body).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    store.close()
  })

  it('refuses a captured observation whose text carries a labelled credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    expect(() => store.saveCaptured({
      cwd: directory,
      sessionId: 's',
      generation: 'captured-labelled',
      kind: 'change',
      title: 'Release notes',
      body: 'Rotate ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij before the release.',
      tags: [],
      sources: [{ sessionId: 's', eventSequence: 1, eventType: 'tool/result', filesRead: [], filesWritten: [], capturedAt: Date.now() }],
    })).toThrow(/suspected secret/i)
    store.close()
  })

  it('redacts a shape-only credential that landed in the title', async () => {
    // The screen used to redact the body only. The title is stored, listed and handed
    // to the recall selector on its own, so a token there is exactly what "redacted in
    // place" has to cover.
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const memory = store.saveDraft({
      cwd: directory,
      title: 'Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart',
      body: 'Rotate it before the release.',
    })
    expect(memory.title).toContain('[redacted credential]')
    expect(memory.title).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    store.close()
  })

  it('removes private sections before persisting long-term memory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const memory = store.saveDraft({ cwd: directory, title: 'Decision', body: 'Keep this <private>do not retain <private>nested</private></private> public fact.' })
    expect(memory.body).toBe('Keep this  public fact.')
    expect(store.getForReview({ cwd: directory, ids: [memory.id] })[0]?.body).toBe('Keep this  public fact.')
    store.close()
  })

  it('keeps long-term memory timeline, deletion, and export isolated to the current project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    const otherDirectory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-other-'))
    directories.push(directory, otherDirectory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const first = store.saveDraft({ cwd: directory, title: 'First decision', body: 'Record the first bounded decision.', kind: 'decision' })
    const second = store.saveDraft({ cwd: directory, title: 'Second verification', body: 'Record verification evidence.', kind: 'verification' })
    const foreign = store.saveDraft({ cwd: otherDirectory, title: 'Foreign draft', body: 'This must remain isolated.' })
    expect(store.review({ cwd: directory, id: first.id, trust: 'reviewed' }).trust).toBe('reviewed')
    expect(store.review({ cwd: directory, id: second.id, trust: 'reviewed' }).trust).toBe('reviewed')
    expect(store.list({ cwd: directory, limit: 1 }).records).toHaveLength(1)
    const timeline = store.timeline({ cwd: directory, id: first.id })
    expect([timeline.anchor, ...timeline.before, ...timeline.after].map(record => record.id)).toContain(second.id)
    expect(store.exportReviewed({ cwd: directory }).records.map(record => record.id)).toEqual(expect.arrayContaining([second.id, first.id]))
    expect(store.getForReview({ cwd: otherDirectory, ids: [first.id] })).toEqual([])
    expect(() => store.delete({ cwd: directory, id: foreign.id })).toThrow(/not found/i)
    expect(store.delete({ cwd: directory, id: second.id })).toEqual({ deleted: true })
    store.close()
  })

  it('drains idempotent observations with provenance and makes them long-term recallable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const input = {
      cwd: directory, sessionId: 'session-1', generation: 'session-1:4:1-3', kind: 'change' as const,
      title: 'Turn 4 tool observation', body: 'Captured structured file evidence.', tags: ['edit'], sourceEngine: 'codex',
      sources: [{ sessionId: 'session-1', eventSequence: 2, eventType: 'tool/result', turn: 4, engine: 'codex', filesRead: ['src/index.ts'], filesWritten: ['src/index.ts'], capturedAt: Date.now() }],
    }
    expect(store.enqueueObservation(input).queued).toBe(true)
    expect(store.enqueueObservation(input).queued).toBe(false)
    expect(store.drainOutbox()).toMatchObject({ drained: 1, failed: 0 })
    const captured = store.list({ cwd: directory, trusts: ['captured'] }).records[0]!
    expect(captured.trust).toBe('captured')
    expect(store.get({ cwd: directory, ids: [captured.id], includeCaptured: true })[0]).toMatchObject({ trust: 'captured', sources: [expect.objectContaining({ filesWritten: ['src/index.ts'] })] })
    expect(store.search({ cwd: directory, query: 'observation' })).toHaveLength(0)
    expect(store.search({ cwd: directory, query: 'observation', includeCaptured: true })).toHaveLength(1)
    expect(store.recall({ cwd: directory, tokenBudget: 1200 }).records).toEqual([])
    const draft = store.saveDraft({ cwd: directory, title: 'Reviewed index', body: 'A reviewed memory can be recalled.' })
    expect(store.review({ cwd: directory, id: draft.id, trust: 'reviewed' }).trust).toBe('reviewed')
    expect(store.recall({ cwd: directory, tokenBudget: 1200 }).records.map(record => record.id)).toEqual([draft.id])
    store.close()
  })

  it('ranks session-start recall by recency-weighted importance and reads chronologically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T00:00:00Z'))
    const promote = (title: string, body: string, kind: 'note' | 'blocker'): string => {
      const draft = store.saveDraft({ cwd: directory, title, body, kind })
      store.review({ cwd: directory, id: draft.id, trust: 'reviewed' })
      return draft.id
    }
    // Distinct ages so every score comparison is unambiguous:
    //  - freshBlocker (1h): 0.5^(1/168) × 1.5 ≈ 1.49 — recency plus durable bonus
    //  - note7d: 0.5^1 = 0.5 — plain recency
    //  - blocker14d: 0.5^2 × 1.5 = 0.375 — the durable bonus lifts it OVER the
    //    younger note12d (0.5^(12/7) ≈ 0.301), proving the bonus matters
    //  - note12d: ≈ 0.301 — oldest effective signal
    vi.setSystemTime(new Date('2025-05-18T00:00:00Z'))
    const blocker14d = promote('Old blocker', 'A still-relevant workaround for the flaky registry.', 'blocker')
    vi.setSystemTime(new Date('2025-05-20T00:00:00Z'))
    const note12d = promote('Mid note', 'A mid-age note about formatting conventions.', 'note')
    vi.setSystemTime(new Date('2025-05-25T00:00:00Z'))
    const note7d = promote('Week note', 'A week-old reviewed convention.', 'note')
    vi.setSystemTime(new Date('2025-05-31T23:00:00Z'))
    const freshBlocker = promote('Fresh blocker', 'The newest reviewed regression workaround.', 'blocker')
    vi.setSystemTime(new Date('2025-06-01T00:00:00Z'))
    const full = store.recall({ cwd: directory, tokenBudget: 4_000 })
    expect(full.records.map(record => record.id)).toHaveLength(4)
    expect(full.usedTokens).toBeLessThanOrEqual(4_000)
    // Presentation is chronological (session-start context reads that way).
    expect(full.records.map(record => record.id)).toEqual([blocker14d, note12d, note7d, freshBlocker])
    // Selection preference: a tiny budget keeps only the top-scored record.
    const tiny = store.recall({ cwd: directory, tokenBudget: 15 })
    expect(tiny.usedTokens).toBeLessThanOrEqual(15)
    expect(tiny.records.map(record => record.id)).toEqual([freshBlocker])
    store.close()
    vi.useRealTimers()
  })

  it('considers more than one page of records when packing session-start recall', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    vi.useFakeTimers()
    const ids: string[] = []
    for (let index = 0; index < 25; index += 1) {
      vi.setSystemTime(new Date(Date.UTC(2025, 0, 1 + index)))
      const draft = store.saveDraft({
        cwd: directory,
        title: `Record ${String(index).padStart(2, '0')}`,
        body: `Body ${index} `.repeat(20),
        // A durable kind on the oldest record: the bonus in `recallScore` exists
        // to lift an aged blocker over a younger note, which is unreachable when
        // the candidate pool is a recency window rather than the project's
        // knowledge. The store's own row bound used to be a page size of 20, so
        // only the newest 20 records were ever ranked and the oldest five — this
        // blocker among them — could not be packed at any budget.
        kind: index === 0 ? 'blocker' : 'note',
      })
      store.review({ cwd: directory, id: draft.id, trust: 'reviewed' })
      ids.push(draft.id)
    }
    vi.setSystemTime(new Date(Date.UTC(2025, 1, 1)))
    const recalled = store.recall({ cwd: directory, tokenBudget: 4_000 })
    // The budget holds every record several times over, so a shorter selection
    // would mean the candidate pool was cut rather than the packing refused.
    expect(recalled.usedTokens).toBeLessThan(2_000)
    expect(recalled.records.map(record => record.id)).toEqual(ids)
    // The agent-facing path still honours the page size it was asked for: the
    // bound that moved is the store's row bound, not the page size.
    expect(store.search({ cwd: directory, limit: 5 })).toHaveLength(5)
    store.close()
    vi.useRealTimers()
  })

  it('creates a consistent private backup and retains long-term memory during a sweep', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
    const old = store.saveCaptured({ cwd: directory, sessionId: 's', generation: 'old', kind: 'change', title: 'Old captured', body: 'Generated evidence.', tags: [], sources: [{ sessionId: 's', eventSequence: 1, eventType: 'tool/result', filesRead: [], filesWritten: [], capturedAt: Date.now() }] })
    const retained = store.saveDraft({ cwd: directory, title: 'Keep memory', body: 'Long-term project knowledge.' })
    vi.setSystemTime(new Date('2025-05-01T00:00:00Z'))
    const backup = await store.backup()
    expect(backup.bytes).toBeGreaterThan(0)
    expect((await readdir(join(directory, 'backups'))).some(file => file.includes(backup.id))).toBe(true)
    expect(store.retentionSweep(30)).toMatchObject({ retentionDays: 30, deletedMemories: 1 })
    expect(store.list({ cwd: directory, trusts: ['captured'] }).records.map(record => record.id)).not.toContain(old.id)
    expect(store.list({ cwd: directory, trusts: ['draft'] }).records.map(record => record.id)).toEqual([retained.id])
    expect(store.getForReview({ cwd: directory, ids: [retained.id] })[0]).toMatchObject({ id: retained.id, trust: 'draft' })
    expect(store.review({ cwd: directory, id: retained.id, trust: 'reviewed' }).trust).toBe('reviewed')
    vi.useRealTimers()
    store.close()
  })

  it('recalls a partial-match record that strict AND semantics would have dropped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // Mentions only "backoff"; a two-term AND query would exclude it entirely.
    const partial = store.saveDraft({ cwd: directory, title: 'Backoff tuning', body: 'Exponential backoff with jitter on transient provider failures.' })
    store.review({ cwd: directory, id: partial.id, trust: 'reviewed' })
    const hits = store.search({ cwd: directory, query: 'retry backoff' })
    expect(hits.map(record => record.id)).toContain(partial.id)
    store.close()
  })

  it('promotes the better-covered record above a bm25 favourite', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-engineering-memory-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const focused = store.saveDraft({ cwd: directory, title: 'Retry backoff policy', body: 'Bounded retry count with exponential backoff per attempt.' })
    const noisy = store.saveDraft({ cwd: directory, title: 'Retry retry retry', body: 'retry retry retry retry retry retry retry retry retry retry retry retry retry retry' })
    store.review({ cwd: directory, id: focused.id, trust: 'reviewed' })
    store.review({ cwd: directory, id: noisy.id, trust: 'reviewed' })
    const hits = store.search({ cwd: directory, query: 'retry backoff' })
    expect(hits[0]?.id).toBe(focused.id)
    store.close()
  })
})

describe('memory detail lookup ceiling', () => {
  it('returns every id a caller declared rather than the first twenty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-ceiling-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const created = Array.from({ length: 25 }, (_value, index) => store.saveDraft({ cwd: directory, title: `Retry policy ${index}`, body: `Bounded retry count for subsystem ${index}.` }))
    for (const record of created) store.review({ cwd: directory, id: record.id, trust: 'reviewed' })
    const ids = created.map(record => record.id)
    // The pool the internal callers declare: `skillDraftGenerate` and the
    // consolidation pass both `list(… limit: 100)` and then look every id up
    // here, and post-compaction rehydration resolves the ids `recall` packed.
    // A ceiling of twenty in this lookup did not bound those callers, it
    // truncated them — silently, because the return type is a plain list and
    // nothing in it says a requested id was dropped.
    expect(store.list({ cwd: directory, trusts: ['reviewed'], limit: 100 }).records).toHaveLength(25)
    expect(store.getForReview({ cwd: directory, ids })).toHaveLength(25)
    store.close()
  })
})

describe('memory tag shape', () => {
  it('stores no tag the document view cannot read back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-taglen-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // The store's `normalizeTags` allowed 64 characters while the document view's
    // parser allowed 63, so the longer tag passed `saveDraft`, was written to
    // `tags_json`, and then made an export the parser refused — a document this
    // module rendered and could not read, which is what its "round-tripping is the
    // whole contract" header forbids. Both readers now share one pattern.
    //
    // `z`, not `a`: a 64-character run of `a` is a hex blob, so the credential
    // screen refuses it first and the tag-shape rule never gets to answer.
    const saved = store.saveDraft({ cwd: directory, title: 'Tag length boundary', body: 'Records the boundary of the shared tag shape.', tags: ['z'.repeat(63), 'z'.repeat(64)] })
    expect(saved.tags).toEqual(['z'.repeat(63)])
    store.close()
  })
})

describe('memory tag screening', () => {
  it('refuses a credential in a tag, the one field the text screen never saw', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-tags-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const save = (tags: readonly string[]) => store.saveDraft({ cwd: directory, title: 'Provider setup', body: 'Configured the provider for this project.', tags })
    // `screenMemoryCredentials` builds its source from the title and the body
    // only, and `normalizeTags` is a shape filter — charset, length, dedup — not
    // a content check. All three of these pass that shape, and all three reached
    // `tags_json` verbatim while the same string in the title or the body was
    // refused.
    expect(() => save(['deadbeefdeadbeefdeadbeefdeadbeef'])).toThrow(/suspected secret in tags/u)
    // The vendor-prefix tier: reported by the scanner but *not* blocked by it, so
    // a guard that asked only `blocked` would have let this one through.
    expect(() => save(['sk-abcdefghijklmnopqrstuvwxyz012345'])).toThrow(/suspected secret in tags/u)
    expect(() => save(['ghp_abcdefghijklmnopqrstuvwxyz0123456789'])).toThrow(/suspected secret in tags/u)
    // A label still saves, and it saves as the caller wrote it: this is a content
    // rule, not a ban on tags.
    expect(save(['provider', 'setup']).tags).toEqual(['provider', 'setup'])
    store.close()
  })
})
