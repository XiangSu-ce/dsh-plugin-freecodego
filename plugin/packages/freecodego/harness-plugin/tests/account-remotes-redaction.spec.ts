import { describe, expect, it } from 'vitest'
import { accountDetail } from '../src/account-remotes.ts'
import type { AccountRemotesHost } from '../src/account-remotes.ts'

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
