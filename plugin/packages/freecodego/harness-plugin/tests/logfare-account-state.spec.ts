/**
 * A Logfare account read has three outcomes, not two, and the middle one is why
 * this file exists.
 *
 * Upstream moved every account API behind a linked Discord account: an account
 * that registered before that gate answers `403 discord_migration_required` to
 * `GET /auth/me`, and the previous boolean probe collapsed that into "not opted
 * in". The settings card then offered a consent button that could never succeed
 * while hiding the single action that would clear it, and the premium rows it
 * gates read as "enable training-data consent" instead of "link Discord".
 *
 * These pins drive the real class against a stubbed fetch: the gate is its own
 * outcome, a dead session is not, and the reading is memoised because the status
 * projection and the directory load both ask for it on every refresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'
import {
  isLogfareDiscordMigrationRefusal,
  logfareAccountError,
  LOGFARE_DISCORD_MIGRATION_REQUIRED,
  LOGFARE_SESSION_REF,
} from '../src/managed-catalog-utils.ts'

const ACCOUNT_TTL_MS = 30_000
const SESSION = 'logfare_session=stub'

let fetchCalls = 0
let answer: () => Response = () => new Response('{}', { status: 200 })
let base = 0

const at = (offsetMs: number): void => { vi.setSystemTime(base + offsetMs) }

beforeEach(() => {
  base = Date.now()
  fetchCalls = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(base)
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls += 1
    return answer()
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** The class under test, with a vault that holds the session cookie (or none). */
function catalogs(session: string | null = SESSION): FreeCodeGoManagedCatalogs {
  return new FreeCodeGoManagedCatalogs({
    ctx: { emit: () => undefined, get: () => undefined },
    credentials: () => ({
      resolve: async (ref: unknown) => (ref === LOGFARE_SESSION_REF && session !== null ? { value: session } : undefined),
      set: async () => undefined,
      unset: async () => undefined,
    }),
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
}

const profile = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Logfare account state', () => {
  it('asks nothing when no session is stored', async () => {
    const instance = catalogs(null)
    expect(await instance.logfareAccount()).toEqual({ state: 'anonymous' })
    expect(fetchCalls).toBe(0)
  })

  it('keeps upstream’s Discord gate as its own outcome', async () => {
    answer = () => profile({ error: { message: 'Link your Discord account at /migrate before continuing to use this account.', type: 'discord_migration_required' }, migration_required: true }, 403)
    const account = await catalogs().logfareAccount()
    expect(account.state).toBe('migration-required')
    expect(account.state === 'migration-required' ? account.reason : '').toContain('/migrate')
    // Never counted as an opted-in account: the gate is what the card has to name.
    expect(await catalogs().logfarePremiumUnlocked()).toBe(false)
  })

  it('treats a session upstream no longer accepts as anonymous, not as gated', async () => {
    answer = () => profile({ error: { message: 'Not logged in', type: 'authentication_error' } }, 401)
    expect(await catalogs().logfareAccount()).toEqual({ state: 'anonymous' })
  })

  it('reads the training opt-in only from a session that answers', async () => {
    answer = () => profile({ training_opt_in: true })
    const active = catalogs()
    expect(await active.logfareAccount()).toEqual({ state: 'active', trainingOptIn: true })
    expect(await active.logfarePremiumUnlocked()).toBe(true)

    answer = () => profile({ user: { training_opt_in: false } })
    expect(await catalogs().logfareAccount()).toEqual({ state: 'active', trainingOptIn: false })
  })

  it('memoises the reading for the status refresh, and drops it on demand', async () => {
    answer = () => profile({ training_opt_in: true })
    const instance = catalogs()
    await instance.logfareAccount()
    await instance.logfarePremiumUnlocked()
    expect(fetchCalls).toBe(1)

    // The one event that changes the answer — the user clearing the Discord gate
    // in another window — has to become visible without a restart.
    instance.clearLogfareAccountCache()
    await instance.logfareAccount()
    expect(fetchCalls).toBe(2)

    at(ACCOUNT_TTL_MS + 1_000)
    await instance.logfareAccount()
    expect(fetchCalls).toBe(3)
  })
})

describe('Logfare account refusal classification', () => {
  it('recognises the gate from either shape upstream sends', async () => {
    expect(isLogfareDiscordMigrationRefusal(403, 'FreeCodeGo account profile failed: Link your Discord account at /migrate before continuing to use this account.')).toBe(true)
    expect(isLogfareDiscordMigrationRefusal(403, 'discord_migration_required')).toBe(true)
    expect(isLogfareDiscordMigrationRefusal(401, 'Link your Discord account at /migrate before continuing to use this account.')).toBe(false)
    expect(isLogfareDiscordMigrationRefusal(403, 'Invalid username or password')).toBe(false)
  })

  it('carries the gate as a sentinel the settings surface can branch on', async () => {
    const refused = await logfareAccountError(new Response(JSON.stringify({ error: { message: 'Link your Discord account at /migrate before continuing to use this account.' } }), { status: 403 }), 'FreeCodeGo training preference update failed')
    expect(refused.startsWith(`${LOGFARE_DISCORD_MIGRATION_REQUIRED}: `)).toBe(true)

    const other = await logfareAccountError(new Response(JSON.stringify({ error: { message: 'Invalid username or password' } }), { status: 401 }), 'FreeCodeGo account sign-in failed')
    expect(other).not.toContain(LOGFARE_DISCORD_MIGRATION_REQUIRED)
  })
})
