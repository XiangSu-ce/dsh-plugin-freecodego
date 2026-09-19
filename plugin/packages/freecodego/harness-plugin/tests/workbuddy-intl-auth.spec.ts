import { readFile, stat } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), stat: vi.fn() }))

import { importWorkBuddyDesktopCredential, parseWorkBuddyDesktopAuth, workbuddyDesktopAuthCandidates } from '../src/workbuddy-intl-auth.ts'

/** The `code` a Node filesystem rejection carries, as the import reads it. */
function fsFailure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('WorkBuddy desktop auth parsing', () => {
  it('parses the nested plugin OAuth shape', () => {
    const parsed = parseWorkBuddyDesktopAuth(JSON.stringify({
      auth: {
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresAt: 1_800_000_000_000,
        domain: 'workbuddy.ai',
      },
      account: { uid: 'u-1', enterpriseId: 'e-1', nickname: 'wb@test.dev' },
    }))
    expect(parsed).toMatchObject({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAtMs: 1_800_000_000_000,
      domain: 'workbuddy.ai',
      uid: 'u-1',
      enterpriseId: 'e-1',
      nickname: 'wb@test.dev',
    })
  })

  it('parses the flat panel shape and seconds-based expiry', () => {
    const parsed = parseWorkBuddyDesktopAuth(JSON.stringify({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiresAt: 1_800_000_000,
      domain: 'workbuddy.ai',
      uid: 'u-2',
    }))
    expect(parsed).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAtMs: 1_800_000_000_000, uid: 'u-2' })
    expect(parsed?.enterpriseId).toBeUndefined()
  })

  it('rejects documents without an access token or with a broken body', () => {
    expect(parseWorkBuddyDesktopAuth('{"refreshToken":"rt"}')).toBeUndefined()
    expect(parseWorkBuddyDesktopAuth('not json')).toBeUndefined()
    expect(parseWorkBuddyDesktopAuth('[]')).toBeUndefined()
  })

  it('probes platform-specific desktop auth paths', () => {
    const candidates = workbuddyDesktopAuthCandidates()
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      expect(candidate).toContain('CodeBuddyExtension')
      expect(candidate.endsWith('workbuddy-desktop-ai.info')).toBe(true)
    }
  })
})

describe('WorkBuddy desktop credential import', () => {
  afterEach(() => { vi.resetAllMocks() })

  it('imports the credential from a present file', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as unknown as Awaited<ReturnType<typeof stat>>)
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ accessToken: 'at-1', refreshToken: 'rt-1' }))
    const result = await importWorkBuddyDesktopCredential()
    expect(result).toMatchObject({ ok: true, credential: { accessToken: 'at-1', refreshToken: 'rt-1' } })
  })

  it('reports a file it cannot read instead of falling through to an older candidate', async () => {
    // A present-but-unreadable file is authoritative for its slot. Falling
    // through would let the next candidate import the credential the user is
    // replacing, and would report "not signed in" for a file that is right
    // there.
    vi.mocked(stat).mockRejectedValue(fsFailure('EACCES'))
    const result = await importWorkBuddyDesktopCredential()
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(vi.mocked(readFile)).not.toHaveBeenCalled()
  })

  it('does not read a candidate whose stat fails for any non-absence reason', async () => {
    vi.mocked(stat).mockRejectedValue(fsFailure('EPERM'))
    const result = await importWorkBuddyDesktopCredential()
    expect(result).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('still falls through when the file is absent, and reports no sign-in', async () => {
    vi.mocked(stat).mockRejectedValue(fsFailure('ENOENT'))
    const result = await importWorkBuddyDesktopCredential()
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, reason: 'not-signed-in' })
    expect(result.probed).toHaveLength(workbuddyDesktopAuthCandidates().length)
  })

  it('reports a present but unparsable file as unreadable', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as unknown as Awaited<ReturnType<typeof stat>>)
    vi.mocked(readFile).mockResolvedValue('not json')
    const result = await importWorkBuddyDesktopCredential()
    expect(result).toMatchObject({ ok: false, reason: 'unreadable' })
  })
})
