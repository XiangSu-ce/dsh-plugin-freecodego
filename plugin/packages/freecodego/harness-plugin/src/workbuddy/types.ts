/**
 * Type definitions for WorkBuddy integration.
 * Modified for international edition (workbuddy.ai) only.
 * Supports multiple accounts and automatic credit-based switching.
 *
 * @module workbuddy/types
 */

/** Always use international edition */
export type WorkBuddyRegion = 'global'

export type UpstreamErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client'

export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
  reasoning?: WorkBuddyModelReasoning
  billing?: WorkBuddyModelBilling
}

export interface WorkBuddyModelReasoning {
  supports: boolean
  onlyReasoning: boolean
  supportedEfforts?: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  canDisableThinking: boolean
}

export interface WorkBuddyModelBilling {
  credits?: string
  badges?: readonly string[]
  free: boolean
}

export interface WorkBuddyCreditAccount {
  packageName: string
  remain: number
  size: number
}

export interface WorkBuddyCredits {
  total: number
  accounts: readonly WorkBuddyCreditAccount[]
}

export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

export type WorkBuddyChatResult = { ok: true; response: Response } | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

/** Browser-safe account state for multi-account support */
export type WorkBuddyAccountState = {
  readonly id: string          // Unique account identifier
  readonly name: string        // Display name (e.g., email or account label)
  readonly accessToken: string // Bearer token for API requests
  readonly refreshToken: string // Refresh token for token rotation
  readonly expiresAt: number   // Token expiry timestamp (ms since epoch)
  readonly creditTotal: number // Total available credit (updated from API)
  readonly lastChecked: number // When credit was last checked
  readonly domain?: string     // Optional domain hint
}

/** Multi-account manager configuration */
export interface WorkBuddyAccountManagerOptions {
  /** List of WorkBuddy accounts */
  accounts: WorkBuddyAccountState[]
  /** Credit check interval in milliseconds */
  checkIntervalMs?: number
  /** Callback when active account changes */
  onAccountChanged?: (accountId: string | null) => void
}

/** Account manager for automatic credit-based switching */
export interface WorkBuddyAccountManager {
  /** Get current active account */
  getCurrent(): WorkBuddyAccountState | undefined
  /** Get all accounts */
  getAll(): readonly WorkBuddyAccountState[]
  /** Add or update an account */
  addAccount(account: WorkBuddyAccountState): void
  /** Remove an account */
  removeAccount(accountId: string): boolean
  /** Get account for a request (may switch if current exhausted) */
  getAccountForRequest(requiredCredit?: number): WorkBuddyAccountState | undefined
  /** Update credit for an account after API call */
  updateCredit(accountId: string, newCredit: number): void
  /** Mark account as exhausted after hard credit error */
  markAccountExhausted(accountId: string): void
}

/** Free model filter options */
export interface WorkBuddyModelFilter {
  /** Only show free models (rateMultiplier === 0) */
  onlyFree?: boolean
  /** All models (default) */
  all?: boolean
}

/** Free model info with billing details */
export interface WorkBuddyFreeModelInfo extends WorkBuddyUpstreamModel {
  /** True if the model is currently free (x0.00) */
  isFree: boolean
}
