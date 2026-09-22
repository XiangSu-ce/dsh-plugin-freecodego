/** Process-wide vocabulary for FreeCodeGo session records. */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

/** Every session event type this plugin appends or reads. */
export const freeCodeGoSessionEventTypes = [
  'agent-engine/selected',
  'freecodego/engine-executor',
  'freecodego/native-session',
  'advisor/state',
  'advisor/note',
  'advisor/delivery',
  'advisor/usage',
  'advisor/council',
  'freecodego/council-task',
  'freecodego/council',
  'freecodego/council-state',
  'freecodego/council-decision',
  'freecodego/council-implementation',
  'freecodego/council-verification',
  'freecodego/agent-progress',
  // Hook dispatch records. Deliberately *not* named `hook/*`: that namespace is
  // the Host bridge's log, and a user grepping session records should not have
  // to distinguish two writers. Fields follow `hook-protocol`'s
  // `hook/invoked` / `hook/result` shapes.
  'freecodego/hook-invoked',
  'freecodego/hook-result',
] as const

/** Must be called during profile bootstrap, before session persistence reads logs. */
export function registerFreeCodeGoSessionEventTypes(): void {
  const known = KNOWN_SESSION_EVENT_TYPES as Set<string>
  for (const eventType of freeCodeGoSessionEventTypes) known.add(eventType)
}
