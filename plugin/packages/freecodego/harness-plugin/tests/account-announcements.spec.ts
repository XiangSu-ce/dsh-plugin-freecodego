/**
 * The announcement remotes.
 *
 * Why these cases exist
 * --------------------
 * These two calls are the only plugin requests whose answer is optional: a
 * missing or unreachable announcement list is a client with nothing to show, not
 * an error the user can act on, and the notice bar sits over their conversation
 * — so the failure mode is pinned here. The read acknowledgement reports its own
 * outcome for the opposite reason: the client keeps a local fallback, and that
 * fallback is only worth having if it knows whether the account's record moved.
 */

import { describe, expect, it, vi } from 'vitest'
import { accountAnnouncements, accountMarkAnnouncementRead } from '../src/account-remotes.ts'
import type { AccountRemotesHost } from '../src/account-remotes.ts'

const announcement = {
  id: 12,
  title: '免费开放 gpt-5.6-terra',
  content: '本周福利',
  notifyMode: 'silent' as const,
  createdAt: '2026-09-28T00:00:00Z',
}

/** Minimal host: every call runs against a fake api that records its inputs. */
function host(input: { readonly authenticated?: boolean; readonly fails?: boolean } = {}): { host: AccountRemotesHost; calls: { readonly token: string }[] } {
  const calls: { readonly token: string }[] = []
  const value = {
    restoreAccount: async () => { if (input.fails === true) throw new Error('network down') },
    account: {
      withAccessToken: async <T>(run: (token: string) => Promise<T>): Promise<T> => {
        if (input.authenticated === false) throw new Error('FreeCodeGo authentication is required')
        calls.push({ token: 'host-token' })
        return run('host-token')
      },
    },
    api: {
      getAnnouncements: vi.fn(async () => [announcement]),
      markAnnouncementRead: vi.fn(async () => undefined),
    },
  }
  return { host: value as unknown as AccountRemotesHost, calls }
}

describe('announcement remotes', () => {
  it('reads through the host vault without exposing the token', async () => {
    const { host: remotesHost, calls } = host()
    const list = await accountAnnouncements(remotesHost)
    expect(list).toEqual([announcement])
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain('host-token')
  })

  it('answers an empty list for a signed-out account instead of failing the bar', async () => {
    const { host: remotesHost } = host({ authenticated: false })
    await expect(accountAnnouncements(remotesHost)).resolves.toEqual([])
  })

  it('answers an empty list when the backend cannot be reached', async () => {
    // The bar floats over the conversation: an error there would be an error the
    // user can neither read nor fix.
    const { host: remotesHost } = host({ fails: true })
    await expect(accountAnnouncements(remotesHost)).resolves.toEqual([])
  })

  it('acknowledges a read on the account and reports whether it landed', async () => {
    const { host: remotesHost } = host()
    const api = remotesHost.api as unknown as { markAnnouncementRead: ReturnType<typeof vi.fn> }
    await expect(accountMarkAnnouncementRead(remotesHost, 12)).resolves.toBe(true)
    expect(api.markAnnouncementRead).toHaveBeenCalledWith({ accessToken: 'host-token', announcementId: 12 })
  })

  it('reports a failed acknowledgement as false rather than throwing', async () => {
    const { host: remotesHost } = host()
    const api = remotesHost.api as unknown as { markAnnouncementRead: ReturnType<typeof vi.fn> }
    api.markAnnouncementRead.mockRejectedValueOnce(new Error('network down'))
    await expect(accountMarkAnnouncementRead(remotesHost, 12)).resolves.toBe(false)
  })
})
