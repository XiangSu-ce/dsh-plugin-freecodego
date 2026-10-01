/**
 * The durable-session restore budget.
 *
 * Why these cases exist
 * --------------------
 * `restoring` is the state the panel shows while the stored session is being
 * rehydrated, and no surface renders a sign-in form in it. The state was also
 * unconditional: a credential that could not be restored — the refresh answered
 * through a proxy that stayed down, or a token the refresh guard read as
 * transport trouble rather than as invalid — reported `restoring` for the life
 * of the process, so the one thing the user could act on, the sign-in form, was
 * the one thing the panel would not show them. Nothing else on the panel
 * offered a way out, and the failure that put it there was not even displayed.
 *
 * The budget is what ends it, and these cases pin both halves of the trade: the
 * retries the state exists for still get their window, and the window closes
 * once the retries have stopped being evidence that anything will change —
 * without spending the credential, so the next successful restore still signs
 * the account in with nothing asked of the user.
 */

import { describe, expect, it } from 'vitest'
import { accountStatus, restoreAccount, RESTORE_FAILURE_BUDGET } from '../src/account-remotes.ts'
import type { AccountRemotesHost, AccountRemotesState } from '../src/account-remotes.ts'

/**
 * A host whose vault holds a session and whose refresh cannot be reached.
 *
 * The failure is a transport error, which is the case that made the old state
 * permanent: the coordinator keeps such a session and reports it as `signed-out`
 * rather than as needing reauthentication, because a network error is not
 * evidence about the credential. `reconnect` is the network coming back.
 *
 * `restoreAccount` is the real one, not a stub, because the streak this budget
 * counts is incremented by it.
 */
function unreachableHost(): {
  readonly host: AccountRemotesHost
  readonly state: AccountRemotesState
  readonly reconnect: () => void
} {
  const state: AccountRemotesState = {
    restorePromise: undefined,
    restoreCompleted: false,
    restoreFailureStreak: 0,
    pendingOAuthState: undefined,
  }
  let reachable = false
  const account = {
    withAccessToken: async <T>(run: (accessToken: string) => Promise<T>): Promise<T> => {
      if (!reachable) throw new Error('fetch failed')
      return run('host-token')
    },
    hasStoredSession: async () => true,
    snapshot: () => reachable
      ? { status: 'authenticated' as const, user: { username: 'u', email: 'a@b.c', balance: 0 } }
      : { status: 'signed-out' as const },
    setAuthenticated: () => undefined,
  }
  const api = {
    getCurrentUser: async () => ({ id: 1, username: 'u', email: 'a@b.c', role: 'user', balance: 0, status: 'active' }),
  }
  const host = {
    account,
    api,
    state,
    restoreAccount: () => restoreAccount(host as unknown as AccountRemotesHost),
  }
  return { host: host as unknown as AccountRemotesHost, state, reconnect: () => { reachable = true } }
}

describe('durable-session restore budget', () => {
  it('keeps reporting a restore in progress for the whole retry window', async () => {
    const { host } = unreachableHost()
    for (let attempt = 1; attempt <= RESTORE_FAILURE_BUDGET; attempt += 1) {
      await expect(accountStatus(host)).resolves.toEqual({ status: 'restoring' })
    }
  })

  it('reports a reauthentication instead of a restore in progress once the budget is spent', async () => {
    // `restoring` renders no sign-in form, so a session that never restores
    // parks the panel on a message with nothing to press. `reauth-required` is
    // the state that shows the form.
    const { host } = unreachableHost()
    for (let attempt = 1; attempt <= RESTORE_FAILURE_BUDGET; attempt += 1) {
      await expect(accountStatus(host)).resolves.toEqual({ status: 'restoring' })
    }
    await expect(accountStatus(host)).resolves.toEqual({ status: 'reauth-required' })
  })

  it('signs the account back in when the network returns, without asking for a password', async () => {
    // Ending the wait must not cost the credential: reporting the sign-in form
    // is only acceptable because a later restore still signs the user in on its
    // own. `hasStoredSession` staying true is what a failed restore that left
    // the vault alone looks like, and the reset streak is what lets the panel
    // stop reporting the spent budget.
    const { host, state, reconnect } = unreachableHost()
    for (let attempt = 0; attempt <= RESTORE_FAILURE_BUDGET; attempt += 1) await accountStatus(host)
    await expect(accountStatus(host)).resolves.toEqual({ status: 'reauth-required' })

    reconnect()
    await expect(accountStatus(host)).resolves.toMatchObject({ status: 'authenticated' })
    expect(state.restoreFailureStreak).toBe(0)
    expect(state.restoreCompleted).toBe(true)
  })
})
