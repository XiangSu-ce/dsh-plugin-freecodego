/**
 * The title limit has to be in the same unit the schema promises.
 *
 * `engineering_memory_save` and `engineering_handoff_create` both declare
 * `title: { maxLength: 200 }`, and JSON Schema counts *code points*. The store
 * counted UTF-8 *bytes*, also at 200 — so a title of 67 CJK characters satisfied
 * every published rule and was still refused, with an error naming a limit the
 * caller had no way to see. A schema that accepts what the implementation rejects
 * is the same defect class as a guard narrower than the thing it guards; here the
 * guard was narrower than the contract.
 *
 * The store's cap is now the worst case for a 200-code-point string (four bytes
 * each), which keeps the byte bound as a real storage limit without contradicting
 * the published one.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineeringMemoryStore } from '../src/engineering-memory.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('memory title limit', () => {
  it('accepts a title the schema declares valid, in any script', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-title-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // 200 code points is exactly the schema's `maxLength`. In CJK that is 600
    // UTF-8 bytes, which a 200-*byte* cap refused.
    const title = '决'.repeat(200)
    const saved = store.saveDraft({ cwd: directory, title, body: 'A bounded decision.' })
    expect(saved.title).toBe(title)
    store.close()
  })

  it('accepts the schema maximum of astral characters too', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-title-astral-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // Four bytes each: the worst case the cap is sized for.
    const title = '𠀀'.repeat(200)
    const saved = store.saveDraft({ cwd: directory, title, body: 'A bounded decision.' })
    expect(saved.title).toBe(title)
    store.close()
  })

  it('still refuses a title past the byte cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-title-over-'))
    directories.push(directory)
    const store = new EngineeringMemoryStore(directory)
    await store.open()
    // Past the schema bound as well: the store keeps its own storage limit, it just
    // no longer fires on input the schema already accepted.
    expect(() => store.saveDraft({ cwd: directory, title: '决'.repeat(400), body: 'A bounded decision.' })).toThrow(/byte limit/)
    store.close()
  })
})
