/**
 * WorkBuddy International pool maintenance: credit snapshots.
 *
 * One fact about this product shapes the design: credits are granted per package
 * with their own expiry, so the pool has to read a snapshot rather than infer a
 * balance from usage. The snapshot is written back to the vault, which is what
 * lets the settings card render a credit position without querying upstream on
 * every page load.
 *
 * The sweep runs one account at a time, on purpose: these are free-tier accounts
 * behind one gateway, and firing N parallel sweeps is how a pool gets rate
 * limited as a group.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/workbuddy-pool
 */

import type { WorkBuddyCredits, WorkBuddyInternationalAccount } from './types.ts'
import type { WorkBuddyIntlClient } from './workbuddy-intl.ts'

/** How often the pool re-reads credits. */
export const WORKBUDDY_POOL_INTERVAL_MS = 30 * 60_000
/**
 * How long after boot the first sweep runs.
 *
 * The reference implementation verifies immediately at startup; a short delay
 * keeps boot (and the first paint of Settings) off the network while still
 * landing well inside the same minute.
 */
export const WORKBUDDY_POOL_STARTUP_DELAY_MS = 15_000

/** What one account's maintenance learned, ready to be persisted. */
export interface WorkBuddyAccountUpdate {
  readonly credits?: WorkBuddyCredits
}

/** One account's outcome inside a sweep, for diagnostics and the UI summary. */
export interface WorkBuddySweepResult {
  readonly accountId: string
  readonly credits?: WorkBuddyCredits
  readonly error?: string
}

/**
 * Host facilities the maintenance needs, all late-bound: the client is rebuilt
 * whenever the credential vault remounts, and the account list is the vault's
 * own document, not a snapshot taken at construction.
 */
export interface WorkBuddyPoolDeps {
  readonly client: () => WorkBuddyIntlClient | undefined
  readonly accounts: () => Promise<readonly WorkBuddyInternationalAccount[]>
  readonly persist: (accountId: string, update: WorkBuddyAccountUpdate) => Promise<void>
}

/**
 * Owns the pool's background credit sweep and the manual refresh.
 *
 * A sweep already in flight is shared rather than duplicated: the periodic timer
 * and the user's button are allowed to collide, and the second caller simply
 * waits for the answer instead of starting a parallel round.
 */
export class WorkBuddyPoolService {
  private startupTimer: NodeJS.Timeout | undefined
  private intervalTimer: NodeJS.Timeout | undefined
  private sweepTask: Promise<readonly WorkBuddySweepResult[]> | undefined

  constructor(private readonly deps: WorkBuddyPoolDeps) {}

  /** Start the unref'd background sweep used by desktop and web Hosts alike. */
  start(): void {
    if (this.startupTimer !== undefined) return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      void this.run().catch(() => undefined)
    }, WORKBUDDY_POOL_STARTUP_DELAY_MS)
    this.startupTimer.unref?.()
    this.intervalTimer = setInterval(() => void this.run().catch(() => undefined), WORKBUDDY_POOL_INTERVAL_MS)
    this.intervalTimer.unref?.()
  }

  /** Stop the timers during Host disposal; an in-flight sweep finishes on its own. */
  stop(): void {
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    if (this.intervalTimer !== undefined) clearInterval(this.intervalTimer)
    this.startupTimer = undefined
    this.intervalTimer = undefined
  }

  /** Whether a sweep is running right now. */
  get busy(): boolean {
    return this.sweepTask !== undefined
  }

  /** Run one sweep over the pool, or join the one already running. 
   * @returns the work Buddy Sweep Result rows, in backend order.
   */
  run(): Promise<readonly WorkBuddySweepResult[]> {
    const inFlight = this.sweepTask
    if (inFlight !== undefined) return inFlight
    const operation = this.sweep().finally(() => {
      if (this.sweepTask === operation) this.sweepTask = undefined
    })
    this.sweepTask = operation
    return operation
  }

  private async sweep(): Promise<readonly WorkBuddySweepResult[]> {
    const client = this.deps.client()
    if (client === undefined) return []
    const accounts = await this.deps.accounts()
    if (accounts.length === 0) return []
    const results: WorkBuddySweepResult[] = []
    for (const account of accounts) {
      let credits: WorkBuddyCredits | undefined
      let failure: string | undefined
      try {
        const snapshot = await client.credits(account)
        credits = snapshot.credits
        // A snapshot carrying upstream's own refusal is still a snapshot: it
        // records why the number is missing instead of pretending it is zero.
        failure = snapshot.credits.error
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      await this.deps.persist(account.id, credits === undefined ? {} : { credits }).catch(() => undefined)
      results.push({
        accountId: account.id,
        ...(credits === undefined ? {} : { credits }),
        ...(failure === undefined ? {} : { error: failure }),
      })
    }
    return results
  }
}
