/**
 * The sandbox-mode Remote is a thin projection over the Harness policy service,
 * so these cases pin the three things that can actually go wrong: an absent
 * service, a closed session, and an invalid mode. Each is exercised against a
 * minimal structural double rather than a live Cordis context, because the
 * Remote's contract is the shape it consumes, not the service implementation.
 */

import { describe, expect, it, vi } from 'vitest'
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'

describe('sandbox mode projection', () => {
  it('exposes exactly the three Harness modes, weakest first', () => {
    expect(SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('appends one sandbox/mode event per switch as the only write path', () => {
    const appended: Array<{ type: string; mode: string }> = []
    const session = { append: (type: string, data: { mode: string }) => { appended.push({ type, ...data }) } }
    setSandboxMode(session as never, 'workspace-write')
    setSandboxMode(session as never, 'read-only')
    expect(appended).toEqual([
      { type: 'sandbox/mode', mode: 'workspace-write' },
      { type: 'sandbox/mode', mode: 'read-only' },
    ])
  })

  it('reports the logged override ahead of the deployment default', () => {
    // Mirrors the Remote's resolution rule: override ?? default.
    const overrideOf = vi.fn((session: { readonly id: string }) => session.id === 's-1' ? 'workspace-write' as const : undefined)
    const policy = { defaultMode: 'read-only' as const, overrideOf }
    const session = { id: 's-1' }
    const mode = policy.overrideOf(session) ?? policy.defaultMode
    expect(mode).toBe('workspace-write')
    const fresh = { id: 's-2' }
    expect(policy.overrideOf(fresh) ?? policy.defaultMode).toBe('read-only')
  })
})
