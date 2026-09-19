import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeSandboxModeForSession } from '../src/factory.ts'

const session = { id: 'session-1' } as unknown as SessionType

/** A Context whose only mounted service is the sandbox policy (or nothing). */
function contextWith(policy: unknown): Context {
  return { get: (name: string) => (name === 'sandboxPolicy' ? policy : undefined) } as unknown as Context
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function harnessSession(id: string, cwd?: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    ...(cwd === undefined ? {} : { cwd }),
  })
}

describe('nativeSandboxModeForSession', () => {
  it('prefers the session override over the deployment default', () => {
    // Same rule as the plugin's `sandboxModeStatus`, so the mode read back in the
    // UI and the mode handed to the engine cannot disagree.
    const policy = { defaultMode: 'workspace-write', overrideOf: () => 'read-only' }
    expect(nativeSandboxModeForSession(contextWith(policy), session)).toBe('read-only')
  })

  it('falls back to the deployment default when the session has no override', () => {
    const policy = { defaultMode: 'danger-full-access', overrideOf: () => undefined }
    expect(nativeSandboxModeForSession(contextWith(policy), session)).toBe('danger-full-access')
  })

  it('asks the policy about this session, not about any session', () => {
    const seen: unknown[] = []
    const policy = { defaultMode: 'read-only', overrideOf: (value: SessionType) => { seen.push(value); return undefined } }
    nativeSandboxModeForSession(contextWith(policy), session)
    expect(seen).toEqual([session])
  })

  it('drops a value outside the vocabulary instead of coercing it to a near miss', () => {
    // An unreadable override falls back to the default; an unreadable default
    // yields nothing. `undefined` is load-bearing: it leaves the engine's own
    // default in place, where a substituted value would be a policy nobody chose.
    expect(nativeSandboxModeForSession(contextWith({ defaultMode: 'read-only', overrideOf: () => 'READ-ONLY' }), session)).toBe('read-only')
    expect(nativeSandboxModeForSession(contextWith({ defaultMode: 'workspace-write', overrideOf: () => 'read_only' }), session)).toBe('workspace-write')
    expect(nativeSandboxModeForSession(contextWith({ defaultMode: 'nonsense', overrideOf: () => undefined }), session)).toBeUndefined()
    expect(nativeSandboxModeForSession(contextWith({ defaultMode: 3, overrideOf: () => undefined }), session)).toBeUndefined()
  })

  it('reports no mode when the sandbox policy service is not mounted', () => {
    expect(nativeSandboxModeForSession(contextWith(undefined), session)).toBeUndefined()
  })

  // The three tests above use a hand-written double, which only proves the rule
  // matches *that* double. These mount the real service, so the two members this
  // factory reads (`defaultMode`, `overrideOf`) are the ones the service actually
  // publishes, and the mode read here is the mode the Harness tools enforce.
  describe('against the mounted sandbox policy service', () => {
    async function mounted(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<Context> {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SandboxPolicyService, { mode })
      return ctx
    }

    it('reads the deployment default the service publishes', async () => {
      const ctx = await mounted('workspace-write')
      expect(nativeSandboxModeForSession(ctx, harnessSession('factory-default'))).toBe('workspace-write')
    })

    it('follows a mode the user switches after the session opened', async () => {
      // The write path the plugin's `sandboxModeSet` Remote uses: one logged
      // `sandbox/mode` event, read back here without a restart.
      const ctx = await mounted('workspace-write')
      const target = harnessSession('factory-switch', process.cwd())
      expect(nativeSandboxModeForSession(ctx, target)).toBe('workspace-write')
      setSandboxMode(target, 'read-only')
      expect(nativeSandboxModeForSession(ctx, target)).toBe('read-only')
    })

    it('keeps one session\'s switch off every other session', async () => {
      const ctx = await mounted('workspace-write')
      const narrowed = harnessSession('factory-narrowed')
      const untouched = harnessSession('factory-untouched')
      setSandboxMode(narrowed, 'read-only')
      expect(nativeSandboxModeForSession(ctx, narrowed)).toBe('read-only')
      expect(nativeSandboxModeForSession(ctx, untouched)).toBe('workspace-write')
    })
  })
})
