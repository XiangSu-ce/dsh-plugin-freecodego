import { describe, expect, it, vi } from 'vitest'
import { deviceSessions, revokeAllSessions, revokeDeviceSession } from '../src/account-remotes.ts'
import type { AccountRemotesHost } from '../src/account-remotes.ts'

/** Minimal host: every call runs against a fake api that records its inputs. */
function host(input: { readonly authenticated?: boolean } = {}): { host: AccountRemotesHost; calls: { readonly token: string }[] } {
  const calls: { readonly token: string }[] = []
  const value = {
    restoreAccount: async () => undefined,
    account: {
      withAccessToken: async <T>(run: (token: string) => Promise<T>): Promise<T> => {
        if (input.authenticated === false) throw new Error('FreeCodeGo authentication is required')
        calls.push({ token: 'host-token' })
        return run('host-token')
      },
    },
    api: {
      getDeviceSessions: vi.fn(async () => ({ currentDeviceId: 'device-1', sessions: [] })),
      revokeDeviceSession: vi.fn(async () => 'Device session revoked.'),
      revokeAllSessions: vi.fn(async () => 2),
    },
  }
  return { host: value as unknown as AccountRemotesHost, calls }
}

describe('device session remotes', () => {
  it('lists sessions through the host vault without exposing the token', async () => {
    const { host: remotesHost, calls } = host()
    await expect(deviceSessions(remotesHost)).resolves.toEqual({ currentDeviceId: 'device-1', sessions: [] })
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(await deviceSessions(remotesHost))).not.toContain('host-token')
  })

  it('revokes one session and returns the refreshed listing', async () => {
    const { host: remotesHost } = host()
    const api = remotesHost.api as unknown as { revokeDeviceSession: ReturnType<typeof vi.fn>; getDeviceSessions: ReturnType<typeof vi.fn> }
    await revokeDeviceSession(remotesHost, ' device-2 ')
    expect(api.revokeDeviceSession).toHaveBeenCalledWith({ accessToken: 'host-token', deviceId: 'device-2' })
    expect(api.getDeviceSessions).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty device id before reaching the backend', async () => {
    const { host: remotesHost, calls } = host()
    await expect(revokeDeviceSession(remotesHost, '   ')).rejects.toThrow('device id is required')
    expect(calls).toHaveLength(0)
  })

  it('reports how many sessions a revoke-all removed', async () => {
    const { host: remotesHost } = host()
    await expect(revokeAllSessions(remotesHost)).resolves.toBe(2)
  })

  it('surfaces the coordinator failure instead of a signed-out success', async () => {
    const { host: remotesHost } = host({ authenticated: false })
    await expect(deviceSessions(remotesHost)).rejects.toThrow('authentication is required')
  })
})
