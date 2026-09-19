/**
 * The export cap has to be *named*, not just applied.
 *
 * `engineering_memory_export`'s description promises the tool "reports records it
 * had to skip". The store's own cap (`MAX_EXPORT_RECORDS`) reads at most 500
 * reviewed rows, and until this suite existed the 501st was neither read nor
 * named — so a project holding five hundred reviewed memories and a project
 * holding one thousand produced byte-identical reports. That is the same failure
 * mode `skipped`/`failed` exist to prevent, one layer further up: the caller
 * cannot tell "that is all there is" from "that is all I looked at".
 *
 * The rows are written straight into the store's file rather than through
 * `saveDraft` + `review`, because the subject under test is the read path's cap
 * and 501 round trips through the write path would spend seconds proving
 * something the write path is not being asked about. The store is opened first so
 * the schema is the current one, then closed before the raw insert.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineeringMemoryStore } from '../src/engineering-memory.ts'
import { planMemoryExport, writeMemoryExport } from '../src/memory/memory-export.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

/** The store's own cap, mirrored here so the fixture is one past it, not a guess. */
const EXPORT_CAP = 500

describe('memory export cap reporting', () => {
  it('names the reviewed records its cap kept it from reading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-export-cap-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // The project id is derived from the workspace, not from the row count, so a
    // throwaway store is the cheapest way to ask the same function the export asks.
    const projectId = store.recall({ cwd: directory, tokenBudget: 48 }).projectId
    store.close()

    const raw = new DatabaseSync(join(directory, 'engineering-memory.sqlite'))
    const insert = raw.prepare('INSERT INTO engineering_memories(id, project_id, title, kind, trust, body, tags_json, source_engine, created_at, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (let index = 0; index < EXPORT_CAP + 1; index += 1) {
      insert.run(
        `mem_${index.toString(16).padStart(32, '0')}`,
        projectId,
        `Reviewed decision ${index}`,
        'decision',
        'reviewed',
        `Body of reviewed decision ${index}.`,
        '[]',
        null,
        Date.now(),
        Date.now(),
        `hash-${index}`,
      )
    }
    raw.close()

    const reopened = new EngineeringMemoryStore(directory)
    await reopened.open()
    const exported = reopened.exportReviewed({ cwd: directory })
    reopened.close()

    expect(exported.records).toHaveLength(EXPORT_CAP)
    // The load-bearing assertion: one row past the cap, named. Without it the
    // caller sees a complete-looking export of a store that held more.
    expect(exported.omitted).toBe(1)
  })

  it('reports nothing omitted when the store holds exactly the cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-export-exact-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    const projectId = store.recall({ cwd: directory, tokenBudget: 48 }).projectId
    store.close()

    const raw = new DatabaseSync(join(directory, 'engineering-memory.sqlite'))
    const insert = raw.prepare('INSERT INTO engineering_memories(id, project_id, title, kind, trust, body, tags_json, source_engine, created_at, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (let index = 0; index < EXPORT_CAP; index += 1) {
      insert.run(`mem_${index.toString(16).padStart(32, '0')}`, projectId, `Reviewed decision ${index}`, 'decision', 'reviewed', `Body ${index}.`, '[]', null, Date.now(), Date.now(), `hash-${index}`)
    }
    raw.close()

    const reopened = new EngineeringMemoryStore(directory)
    await reopened.open()
    const exported = reopened.exportReviewed({ cwd: directory })
    reopened.close()

    // A project holding exactly the cap is not truncated, and calling it truncated
    // would be the mirror of the defect: it would teach a reader to distrust a
    // complete export. This is why the count is queried rather than inferred from
    // `rows.length === cap`.
    expect(exported.records).toHaveLength(EXPORT_CAP)
    expect(exported.omitted).toBe(0)
  })

  it('carries the store-level omission through to the write result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-export-carry-'))
    directories.push(directory)
    // The write path cannot recompute this — it never sees the rows the store did
    // not hand over — so the only way the number survives is by being passed in.
    const result = await writeMemoryExport(directory, planMemoryExport([], Date.now()), 7)
    expect(result.omittedByLimit).toBe(7)
    expect(result.written).toEqual(['INDEX.md'])
  })
})
