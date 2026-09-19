/**
 * The Session-storage adapter reads a face the Harness declares, so the two
 * things worth pinning are the protocol (a handle's `read(0, undefined)` then
 * `close`) and the refusal when a backend answers neither probe — the shapes
 * this module used to carry could not be reached by a test at all.
 */

import { describe, expect, it, vi } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { deletePersistedSession, readPersistedEvents, type SessionDeletionPersistence, type SessionEventsPersistence } from '../src/session-storage-utils.ts'

const ID = SessionId('session-1')

describe('readPersistedEvents', () => {
  it('reads the whole log through the handle and closes it', async () => {
    // The adapter forwards whatever the log holds; spelling a full event per type
    // is the Host's own suite's business, so this stands in for the payload only.
    const events = [{ type: 'turn/start', data: {} }] as unknown as readonly SessionEvent[]
    const close = vi.fn(async () => {})
    const read = vi.fn(async () => events)
    const persistence: SessionEventsPersistence = {
      open: async (id, access) => {
        expect(id).toBe(ID)
        expect(access).toBe('read')
        return { read, close }
      },
    }
    await expect(readPersistedEvents(persistence, ID)).resolves.toEqual({ events })
    // Offset 0 and no length: the whole stored log, which is what the callers
    // fold; a partial window would silently drop the report they are looking for.
    expect(read).toHaveBeenCalledWith(0, undefined)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the handle even when the read fails', async () => {
    const close = vi.fn(async () => {})
    const persistence: SessionEventsPersistence = {
      open: async () => ({ read: async () => { throw new Error('corrupt') }, close }),
    }
    await expect(readPersistedEvents(persistence, ID)).rejects.toThrow('corrupt')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('reports absence rather than a TypeError when the backend cannot read', async () => {
    await expect(readPersistedEvents({}, ID)).rejects.toThrow('is not available')
  })
})

describe('deletePersistedSession', () => {
  it('prefers the storage delete alpha.2 added over the private locate fallback', async () => {
    const deleted: string[] = []
    const locate = vi.fn()
    const persistence: SessionDeletionPersistence = {
      delete: async (id) => { deleted.push(String(id)); return true },
      locate,
    }
    await deletePersistedSession(persistence, ID, undefined)
    expect(deleted).toEqual([String(ID)])
    expect(locate).not.toHaveBeenCalled()
  })

  it('refuses a backend with no removable session artifact', async () => {
    await expect(deletePersistedSession({}, ID, undefined))
      .rejects.toThrow('SESSION_DELETE_UNSUPPORTED')
  })

  it('falls through stat to a not-found refusal when no header can be derived', async () => {
    // `locate` is present (the shipped JSONL backend carries it privately) but
    // nothing can name the stored artifact: the live header is gone and `stat`
    // does not answer, which is the deleted-file case the Refusal must describe.
    const persistence: SessionDeletionPersistence = {
      locate: () => undefined,
      stat: async () => undefined,
    }
    await expect(deletePersistedSession(persistence, ID, undefined))
      .rejects.toThrow('SESSION_DELETE_NOT_FOUND')
  })
})
