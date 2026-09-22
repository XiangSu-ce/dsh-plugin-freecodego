/**
 * Cache format version: a document written by an older version is ignored rather than resumed.
 */
export const SDK_SESSION_CACHE_VERSION = 2

type SessionCache = {
  readonly version: typeof SDK_SESSION_CACHE_VERSION
  readonly sessions: Readonly<Record<string, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read only cache entries written after third-party bare-mode support. 
 * @param value - the parsed cache document, of unknown shape.
 * @param runtimeSessionId - the Harness session whose SDK session id is wanted.
 * @returns the SDK session id this version cached, or `undefined` when the entry is absent or unusable.
 */
export function sdkSessionFromCache(value: unknown, runtimeSessionId: string): string | undefined {
  if (!isRecord(value) || value.version !== SDK_SESSION_CACHE_VERSION || !isRecord(value.sessions)) return undefined
  const sessionId = value.sessions[runtimeSessionId]
  return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : undefined
}

/** Replace legacy caches rather than resuming sessions created with old auth behavior. 
 * @param value - the existing cache document, of unknown shape.
 * @param runtimeSessionId - the Harness session the recorded id belongs to.
 * @param sdkSessionId - the SDK session id to record.
 * @returns the cache document to persist, with entries that are not usable ids dropped.
 */
export function withSdkSessionCache(value: unknown, runtimeSessionId: string, sdkSessionId: string): SessionCache {
  const previous = isRecord(value) && value.version === SDK_SESSION_CACHE_VERSION && isRecord(value.sessions)
    ? Object.fromEntries(Object.entries(value.sessions).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''))
    : {}
  return { version: SDK_SESSION_CACHE_VERSION, sessions: { ...previous, [runtimeSessionId]: sdkSessionId } }
}
