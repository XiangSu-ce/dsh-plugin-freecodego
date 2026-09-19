/**
 * A save is (title, body, kind, tags) — not just its prose.
 *
 * `saveDraft` dedups on a content hash so a retried save does not become two
 * drafts. The hash used to cover only the project, the title, and the body, so a
 * second save that kept the prose but changed the kind or the tags matched the
 * first record and returned *its* detail: the tool answered with a record it had
 * not written, carrying the old kind and the old tags, and the new metadata went
 * nowhere. The caller had no way to tell — the returned detail is the only
 * evidence a save produces.
 *
 * The identity has to be as wide as the thing it identifies. `saveCaptured` makes
 * the same point in its own hash, where the generation is mixed in precisely so
 * that two observations of the same turn are not collapsed into one.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineeringMemoryStore } from '../src/engineering-memory.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function openStore(): Promise<{ readonly store: EngineeringMemoryStore; readonly directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-memory-save-identity-'))
  directories.push(directory)
  const store = new EngineeringMemoryStore(directory)
  await store.open()
  return { store, directory }
}

describe('draft save identity', () => {
  it('keeps the kind the caller asked for when the prose is unchanged', async () => {
    const { store, directory } = await openStore()
    const first = store.saveDraft({ cwd: directory, title: 'Rate limit', body: 'Cap retries at three.', kind: 'note' })
    const second = store.saveDraft({ cwd: directory, title: 'Rate limit', body: 'Cap retries at three.', kind: 'blocker' })
    // The second save states a different kind, so it is a different save. Returning
    // the first record's detail would have the tool report `note` for a call that
    // said `blocker`.
    expect(second.kind).toBe('blocker')
    expect(second.id).not.toBe(first.id)
    store.close()
  })

  it('keeps the tags the caller asked for when the prose is unchanged', async () => {
    const { store, directory } = await openStore()
    store.saveDraft({ cwd: directory, title: 'Retry policy', body: 'Use bounded retries.', tags: ['retry'] })
    const tagged = store.saveDraft({ cwd: directory, title: 'Retry policy', body: 'Use bounded retries.', tags: ['retry', 'network'] })
    expect([...tagged.tags].sort()).toEqual(['network', 'retry'])
    store.close()
  })

  it('still collapses a save that repeats every field, so a retry stays one draft', async () => {
    const { store, directory } = await openStore()
    const save = () => store.saveDraft({ cwd: directory, title: 'Backoff', body: 'Exponential with jitter.', kind: 'decision', tags: ['retry'] })
    const first = save()
    const retry = save()
    // The widening must not cost idempotence: an identical save is still one row,
    // and it is still the same row.
    expect(retry.id).toBe(first.id)
    expect(store.list({ cwd: directory, trusts: ['draft'] }).records).toHaveLength(1)
    store.close()
  })

  it('treats the same tags in a different order as the same save', async () => {
    const { store, directory } = await openStore()
    // Both spellings normalize to the same stored tag list, so they are the same
    // save — the identity follows the record the store would write, not the order
    // the caller happened to type.
    const first = store.saveDraft({ cwd: directory, title: 'Layers', body: 'Two layers.', tags: ['ui', 'core'] })
    const second = store.saveDraft({ cwd: directory, title: 'Layers', body: 'Two layers.', tags: ['core', 'ui'] })
    expect(second.id).toBe(first.id)
    store.close()
  })
})
