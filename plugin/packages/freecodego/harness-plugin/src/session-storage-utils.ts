import fs from 'node:fs/promises'
import path from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/**
 * The two Session-storage shapes this module reads, written as the storage
 * declaration publishes them.
 *
 * `SessionPersistence` declares `create`/`open`/`flush`/`stat`/`list` and
 * nothing else — in alpha.1 and in alpha.2 alike — while the shipped JSONL
 * backend adds a public `delete` (alpha.2 gained it) and a `locate` that stays
 * private to that class. Both types used to carry an `inspect?(id)` as the
 * preferred first branch, which **no** upstream face has ever declared: the
 * optional chain skipped it silently, and a rename of the member it shadowed
 * would have stayed invisible the same way. Every member here is optional so a
 * backend that answers neither probe still fails with this module's sentence
 * rather than a TypeError.
 */
export type SessionDeletionPersistence = { delete?(id: SessionId): Promise<boolean>; stat?(id: SessionId): Promise<{ readonly header: SessionHeader } | undefined>; locate?(meta: SessionHeader): { readonly kind: string; readonly path: string } | undefined }
export type SessionEventsPersistence = { open?(id: SessionId, access: 'read', options?: { readonly signal?: AbortSignal }): Promise<{ readonly read: (offset?: number, length?: number, options?: { readonly signal?: AbortSignal }) => Promise<readonly SessionEvent[]>; readonly close: () => Promise<void> }> }

/** Read one session's whole event log through the storage handle. */
export async function readPersistedEvents(persistence: SessionEventsPersistence, id: SessionId): Promise<{ readonly events: readonly SessionEvent[] }> {
  if (persistence.open === undefined) throw new Error(`session "${id}" is not available`)
  const handle = await persistence.open(id, 'read')
  try { return { events: await handle.read(0, undefined) } } finally { await handle.close() }
}

export async function deletePersistedSession(persistence: SessionDeletionPersistence, id: SessionId, liveHeader: SessionHeader | undefined): Promise<void> {
  if (persistence.delete !== undefined) { await persistence.delete(id); return }
  if (persistence.locate === undefined) throw new Error('SESSION_DELETE_UNSUPPORTED: the configured session storage does not expose a removable session artifact')
  const snapshot = liveHeader === undefined && persistence.stat !== undefined ? await persistence.stat(id) : undefined
  const header = liveHeader ?? snapshot?.header
  if (header === undefined) throw new Error('SESSION_DELETE_NOT_FOUND: the session is no longer present in session storage')
  const location = persistence.locate(header)
  if (location?.kind !== 'jsonl' || !/^session\.jsonl(?:\.zstd)?$/.test(path.basename(location.path))) throw new Error('SESSION_DELETE_UNSUPPORTED: the configured session storage does not expose a JSONL session artifact')
  const directory = path.dirname(location.path)
  await Promise.all([fs.rm(path.join(directory, 'session.jsonl'), { force: true }), fs.rm(path.join(directory, 'session.jsonl.zstd'), { force: true })])
  // `unknown`, not `NodeJS.ErrnoException`: a rejected promise carries whatever
  // the platform rejected with, so the code is read through a checked narrowing
  // rather than asserted onto the callback parameter.
  await fs.rmdir(directory).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error
  })
}
