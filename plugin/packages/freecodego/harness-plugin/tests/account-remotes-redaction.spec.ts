import { describe, expect, it } from 'vitest'
import { accountDetail, logfareSetKey, readRememberedPassword } from '../src/account-remotes.ts'
import type { AccountRemotesHost } from '../src/account-remotes.ts'
import { LOGFARE_SESSION_REF } from '../src/managed-catalog-utils.ts'

describe('remembered password', () => {
  it('answers nothing when the Host has no account surface', async () => {
    const host = { account: undefined } as unknown as AccountRemotesHost
    await expect(readRememberedPassword(host)).resolves.toEqual({})
  })

  it('reads what the coordinator remembers and reports none as an absent field', async () => {
    const host = { account: { rememberedPassword: async () => 'hunter2' } } as unknown as AccountRemotesHost
    await expect(readRememberedPassword(host)).resolves.toEqual({ password: 'hunter2' })
    // Not `{ password: undefined }`: the remote boundary carries the answers it
    // was given, and the form's "nothing remembered" is the empty object.
    const empty = { account: { rememberedPassword: async () => undefined } } as unknown as AccountRemotesHost
    await expect(readRememberedPassword(empty)).resolves.toEqual({})
  })
})

describe('logfare key storage', () => {
  /** A Host whose vault already holds `stored` as the Logfare access key. */
  function host(stored: string | undefined, unset: unknown[]): AccountRemotesHost {
    return {
      credentials: {
        set: async () => undefined,
        unset: async (ref: unknown) => { unset.push(ref) },
      },
      catalogs: {
        logfareApiKey: async () => stored,
        invalidateLogfareCatalog: () => undefined,
      },
      ctx: { emit: () => undefined },
      logfareStatus: async () => ({}) as never,
    } as unknown as AccountRemotesHost
  }

  it('keeps the stored session when the key is re-saved unchanged', async () => {
    const unset: unknown[] = []
    await logfareSetKey(host('lfu_same', unset), 'lfu_same')

    // Re-saving the key that is already stored is the same account, so its
    // consent session still belongs to it. Dropping the session here signed the
    // user out of the account they had just signed in to, which is exactly what
    // a login that "never persisted" looks like from the card.
    expect(unset).not.toContain(LOGFARE_SESSION_REF)
  })

  it('drops the session when the key actually changes', async () => {
    const unset: unknown[] = []
    await logfareSetKey(host('lfu_old', unset), 'lfu_new')

    // A pasted key may belong to another account, and reusing the previous
    // account's consent session with it is the one thing this must not do.
    expect(unset).toContain(LOGFARE_SESSION_REF)
  })
})

describe('accountDetail upstream errors', () => {
  it('does not return a credential echoed by the profile endpoint', async () => {
    const leaked = `ghp_${'A'.repeat(36)}`
    const host = {
      account: {
        withAccessToken: async (operation: (accessToken: string) => Promise<unknown>) => operation('access-token'),
      },
      api: {
        getCurrentUser: async () => { throw new Error(`profile rejected Authorization: Bearer ${leaked}`) },
      },
      restoreAccount: async () => undefined,
    } as unknown as AccountRemotesHost

    const detail = await accountDetail(host)
    expect(detail).toMatchObject({ status: 'error' })
    expect(detail).not.toMatchObject({ message: expect.stringContaining(leaked) })
  })
})
