import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
// Imported from source, not `../lib/index.js`: the bundle carries no
// declarations (`tsdown` runs with `dts: false`), so a spec that imported it
// could not be type-checked at all. Vite 8 applies the class's legacy `@Remote`
// decorators in its SSR transform, so the source module is the same class.
import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import type { SessionDeletionPersistence } from '../src/session-storage-utils.ts'
import { idleAgent, liveSession, provideHostService, provideHostServiceAs, type EngineRouterFace } from './support/host-services.ts'

// The specs below build the Host through Object.create, so the capability
// registry set by the real constructor is stubbed with its public snapshot.
/**
 * The one registry member `sessionDelete` reads. The real `capabilities` field
 * is private, so the fixture states the single property it stands in for rather
 * than reconstructing a whole `FreeCodeGoCapabilityRegistry`.
 */
const capabilityStub = (sessionDeleteEnabled: boolean): { capabilities: { configuration: () => { readonly sessionDeleteEnabled: boolean } } } => ({
  capabilities: { configuration: () => ({ sessionDeleteEnabled }) },
})

/** The stored header a `stat` answers with; the plugin only forwards it to `locate`. */
const storedHeader = (id: string): SessionHeader => ({
  id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false, delegationDepth: 0,
})

describe('FreeCodeGoHarnessPlugin sessionDelete', () => {
  it('refuses to delete when the capability switch is disabled', async () => {
    const ctx = new Context()
    const plugin = Object.assign(Object.create(FreeCodeGoHarnessPlugin.prototype), {
      ctx,
      ...capabilityStub(false),
    }) as FreeCodeGoHarnessPlugin
    await expect(plugin.sessionDelete('any-session')).rejects.toThrow('Session delete is disabled in FreeCodeGo settings')
  })

  it('uses the alpha AgentFactory close capability before deleting an idle session', async () => {
    const ctx = new Context()
    let live = true
    const disposed: string[] = []
    const deleted: string[] = []
    provideHostService(ctx, 'agents', {
      get: (sessionId: string) => live && sessionId === 'idle-session' ? idleAgent() : undefined,
    })
    provideHostService(ctx, 'sessions', {
      get: (sessionId: string) => live && sessionId === 'idle-session' ? liveSession() : undefined,
    })
    provideHostServiceAs<EngineRouterFace>(ctx, 'freeCodeGoAgentEngineRouter', {
      disposeAgent: async (sessionId: SessionId) => {
        disposed.push(sessionId)
        live = false
        return true
      },
    })
    // The storage contract the plugin reads, not the abstract service: `delete` is
    // the JSONL backend's own member, which alpha.2 made public.
    provideHostServiceAs<SessionDeletionPersistence>(ctx, 'sessionPersistence', {
      delete: async (sessionId: string) => { deleted.push(sessionId); return true },
    })

    const plugin = Object.assign(Object.create(FreeCodeGoHarnessPlugin.prototype), { ctx, ...capabilityStub(true) }) as FreeCodeGoHarnessPlugin
    await expect(plugin.sessionDelete('idle-session')).resolves.toEqual({ deleted: true })
    expect(disposed).toEqual(['idle-session'])
    expect(deleted).toEqual(['idle-session'])
  })

  it('removes only the backend-located JSONL session artifact when the backend has no delete API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-session-delete-'))
    const directory = join(root, 'project', 'session-jsonl')
    const zstd = join(directory, 'session.jsonl.zstd')
    const other = join(root, 'project', 'keep.txt')
    await mkdir(directory, { recursive: true })
    await writeFile(zstd, 'session')
    await writeFile(other, 'keep')
    const ctx = new Context()
    provideHostService(ctx, 'agents', { get: () => undefined })
    provideHostService(ctx, 'sessions', { get: () => undefined })
    provideHostServiceAs<SessionDeletionPersistence>(ctx, 'sessionPersistence', {
      // The supported face for a backend without `delete`: the storage's own
      // `stat` for the header (an invented `inspect` used to stand here, which no
      // Harness line ever declared — COMPATIBILITY.md forbids carrying a branch
      // for one) plus the JSONL-private `locate`.
      stat: async () => ({ header: storedHeader('jsonl-session') }),
      locate: () => ({ kind: 'jsonl', path: zstd }),
    })
    const plugin = Object.assign(Object.create(FreeCodeGoHarnessPlugin.prototype), { ctx, ...capabilityStub(true) }) as FreeCodeGoHarnessPlugin
    try {
      await expect(plugin.sessionDelete('jsonl-session')).resolves.toEqual({ deleted: true })
      await expect(access(zstd)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(other)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the rc1 stat plus locate contract for historical zstd sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-session-delete-stat-'))
    const directory = join(root, 'project', 'session-jsonl')
    const zstd = join(directory, 'session.jsonl.zstd')
    await mkdir(directory, { recursive: true })
    await writeFile(zstd, 'session')
    const ctx = new Context()
    provideHostService(ctx, 'agents', { get: () => undefined })
    provideHostService(ctx, 'sessions', { get: () => undefined })
    provideHostServiceAs<SessionDeletionPersistence>(ctx, 'sessionPersistence', {
      stat: async () => ({ header: storedHeader('stat-session') }),
      locate: () => ({ kind: 'jsonl', path: zstd }),
    })
    const plugin = Object.assign(Object.create(FreeCodeGoHarnessPlugin.prototype), { ctx, ...capabilityStub(true) }) as FreeCodeGoHarnessPlugin
    try {
      await expect(plugin.sessionDelete('stat-session')).resolves.toEqual({ deleted: true })
      await expect(access(zstd)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
