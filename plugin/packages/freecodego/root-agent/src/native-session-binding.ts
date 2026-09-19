/** Durable native runtime identity used only for restoring a plugin-owned root agent. */

import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Native runtime identity; this deliberately excludes credentials and provider secrets. */
    'freecodego/native-session': {
      readonly engine: 'codex' | 'claude'
      readonly runtimeSessionId: string
      readonly artifactDigest: string
      readonly protocolAbi: string
    }
  }
}

/** Read the most recent native runtime identity compatible with the selected engine plan. */
export function nativeSessionBinding(
  session: Session,
  engine: 'codex' | 'claude',
  artifactDigest: string,
  protocolAbi: string,
): string | undefined {
  const event = session.snapshotEvents().findLast(candidate => candidate.type === 'freecodego/native-session')
  if (event === undefined) return undefined
  if (event.data.engine !== engine || event.data.artifactDigest !== artifactDigest || event.data.protocolAbi !== protocolAbi) {
    throw new Error(`session "${session.id}" native runtime binding does not match the selected engine plan`)
  }
  return event.data.runtimeSessionId
}

/** Persist a non-secret native runtime identity after the native session opened successfully. */
export function appendNativeSessionBinding(
  session: Session,
  binding: { readonly engine: 'codex' | 'claude'; readonly runtimeSessionId: string; readonly artifactDigest: string; readonly protocolAbi: string },
): void {
  const existing = nativeSessionBinding(session, binding.engine, binding.artifactDigest, binding.protocolAbi)
  if (existing === undefined) {
    session.append('freecodego/native-session', binding)
    return
  }
  if (existing !== binding.runtimeSessionId) throw new Error(`session "${session.id}" native runtime session id changed during restore`)
}

/** Persist a replacement identity after a crashed native process is reopened. */
export function replaceNativeSessionBinding(
  session: Session,
  binding: { readonly engine: 'codex' | 'claude'; readonly runtimeSessionId: string; readonly artifactDigest: string; readonly protocolAbi: string },
): void {
  // Validate the immutable engine/artifact contract before accepting only the
  // worker-issued runtime id as a new recovery checkpoint.
  nativeSessionBinding(session, binding.engine, binding.artifactDigest, binding.protocolAbi)
  session.append('freecodego/native-session', binding)
}
