/** Locale namespace for inline delegated-Agent progress. */

export const NS = 'freecodego.agent-progress'

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

export type ProgressKey = keyof ProgressDictionary
