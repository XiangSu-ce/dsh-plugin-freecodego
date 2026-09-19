import type { FreeCodeGoAccountCoordinator } from '@deepseek-ai/dsh-freecodego-api'
import type { FreeCodeGoAccountSnapshot, FreeCodeGoRuntimePackage } from './types.ts'

/**
 * The account a pool keeps in front after writing one of its rows.
 *
 * Several pools (Cline, Agnes, WorkBuddy) store a list plus an `activeAccountId`
 * naming the account the panel reports and the default calls address. Writing a
 * row is not choosing an account: a background token refresh, a rate-limit park
 * or a failed self-check must leave the selection where the user left it — only
 * a deliberate authorization (`adopt`) or a pool that has no surviving
 * selection moves it. The WorkBuddy pool has always worked this way; the other
 * two recomputed the field from whichever row they happened to write last,
 * which silently switched the reported account.
 */
export function activeAccountIdAfterWrite(
  accounts: readonly { readonly id: string }[],
  input: { readonly previousActiveId: string | undefined; readonly writtenId: string; readonly adopt?: boolean },
): string {
  if (input.adopt === true) return input.writtenId
  const previous = input.previousActiveId
  if (previous !== undefined && accounts.some(account => account.id === previous)) return previous
  return input.writtenId
}

/**
 * The account a pool keeps in front after removing one of its rows.
 *
 * Removing an unrelated account must not move the selection; only losing the
 * selected account itself promotes a survivor (and an emptied pool records no
 * selection at all).
 */
export function activeAccountIdAfterRemoval(
  accounts: readonly { readonly id: string }[],
  previousActiveId: string | undefined,
): string | undefined {
  if (previousActiveId !== undefined && accounts.some(account => account.id === previousActiveId)) return previousActiveId
  return accounts[0]?.id
}

export function backendNotConfigured(): Error & { code: 'BACKEND_NOT_CONFIGURED' } {
  const error = new Error('FreeCodeGo backend is not configured') as Error & { code: 'BACKEND_NOT_CONFIGURED' }
  error.code = 'BACKEND_NOT_CONFIGURED'
  return error
}

export function accountSnapshot(value: ReturnType<FreeCodeGoAccountCoordinator['snapshot']> | undefined): FreeCodeGoAccountSnapshot {
  if (value === undefined || value.status === 'signed-out' || value.status === 'reauth-required') return { status: value?.status ?? 'signed-out' }
  if (value.status === 'mfa-required') return { status: value.status, emailMasked: value.emailMasked }
  const user = value.user
  return { status: value.status, user: { username: user.username, email: user.email, ...(user.avatarUrl === undefined ? {} : { avatarUrl: user.avatarUrl }), balance: user.balance } }
}

export function accountIdentity(user: { readonly id?: number; readonly username?: string; readonly email?: string; readonly avatarUrl?: string; readonly role?: string; readonly balance?: number; readonly status?: string }): { readonly id: number; readonly username: string; readonly email: string; readonly avatarUrl?: string; readonly role: string; readonly balance: number; readonly status: string } {
  const email = user.email?.trim()
  if (email === undefined || email === '') throw new Error('FreeCodeGo account profile did not include an email')
  if (user.balance === undefined || !Number.isFinite(user.balance)) throw new Error('FreeCodeGo account profile did not include a finite balance')
  const username = user.username?.trim()
  return {
    id: user.id ?? 0,
    username: username === undefined || username === '' ? email : username,
    email,
    ...(user.avatarUrl === undefined || user.avatarUrl.trim() === '' ? {} : { avatarUrl: user.avatarUrl.trim() }),
    role: user.role ?? '',
    balance: user.balance,
    status: user.status ?? 'active',
  }
}

export function runtimePackageView(input: FreeCodeGoRuntimePackage): FreeCodeGoRuntimePackage {
  return { ...input }
}

export function setEngineAvailability(agentEngines: { setAvailability?: (id: 'codex' | 'claude', availability: 'available' | 'unavailable' | 'updating') => void } | undefined, id: 'codex' | 'claude', availability: 'available' | 'unavailable' | 'updating'): void {
  try { agentEngines?.setAvailability?.(id, availability) } catch { /* optional router may not be mounted yet */ }
}
