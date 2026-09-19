export const SDK_SESSION_CACHE_VERSION = 2

type SessionCache = {
  readonly version: typeof SDK_SESSION_CACHE_VERSION
  readonly sessions: Readonly<Record<string, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read only cache entries written after third-party bare-mode support. */
export function sdkSessionFromCache(value: unknown, runtimeSessionId: string): string | undefined {
  if (!isRecord(value) || value.version !== SDK_SESSION_CACHE_VERSION || !isRecord(value.sessions)) return undefined
  const sessionId = value.sessions[runtimeSessionId]
  return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : undefined
}

/** Replace legacy caches rather than resuming sessions created with old auth behavior. */
export function withSdkSessionCache(value: unknown, runtimeSessionId: string, sdkSessionId: string): SessionCache {
  const previous = isRecord(value) && value.version === SDK_SESSION_CACHE_VERSION && isRecord(value.sessions)
    ? Object.fromEntries(Object.entries(value.sessions).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== ''))
    : {}
  return { version: SDK_SESSION_CACHE_VERSION, sessions: { ...previous, [runtimeSessionId]: sdkSessionId } }
}
