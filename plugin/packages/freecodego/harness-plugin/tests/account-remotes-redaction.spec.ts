import { describe, expect, it } from 'vitest'
import { accountDetail, readRememberedPassword } from '../src/account-remotes.ts'
import type { AccountRemotesHost } from '../src/account-remotes.ts'

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
