import { describe, expect, it } from 'vitest'
import { SDK_SESSION_CACHE_VERSION, sdkSessionFromCache, withSdkSessionCache } from '../src/sdk-session-cache.ts'

describe('Claude SDK session cache', () => {
  it('does not resume legacy session ids created before bare-mode authentication', () => {
    expect(sdkSessionFromCache({ runtime: 'legacy-sdk-id' }, 'runtime')).toBeUndefined()
  })

  it('writes and reads only the versioned cache format', () => {
    const cache = withSdkSessionCache({ runtime: 'legacy-sdk-id' }, 'runtime', 'fresh-sdk-id')
    expect(cache).toEqual({ version: SDK_SESSION_CACHE_VERSION, sessions: { runtime: 'fresh-sdk-id' } })
    expect(sdkSessionFromCache(cache, 'runtime')).toBe('fresh-sdk-id')
  })
})
