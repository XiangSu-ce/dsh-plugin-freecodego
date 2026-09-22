/** Locale namespace for inline delegated-Agent progress. */

export const NS = 'freecodego.agent-progress'

/**
 * The localized strings for delegated-Agent progress, keyed by message id.
 */
export interface ProgressDictionary {
  'summary.running': string
  'summary.finished': string
  'summary.failed': string
  queued: string
  running: string
  stalled: string
  idle: string
  completed: string
  failed: string
  cancelled: string
  waiting: string
  usingTool: string
  toolUses: string
  stop: string
  resume: string
  focusChain: string
}

/**
 * The message ids a progress dictionary must carry.
 */
export type ProgressKey = keyof ProgressDictionary
