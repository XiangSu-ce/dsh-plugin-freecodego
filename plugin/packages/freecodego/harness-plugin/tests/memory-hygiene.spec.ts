import { describe, expect, it } from 'vitest'
import { scanForSecrets } from '../src/secret-scan.ts'
import {
  MEMORY_FRESH_MS,
  MEMORY_RECENT_MS,
  MEMORY_STALE_MS,
  describeMemoryAge,
  memoryFreshnessNote,
} from '../src/memory/memory-age.ts'
import {
  MEMORY_REDACTION_MARKER,
  containsMemoryRedaction,
  looksLikeMemorySecretValue,
  sanitizeMemoryIdentifier,
  sanitizeMemoryText,
  screenMemoryForPersistence,
} from '../src/memory/memory-security.ts'

describe('memory identifier sanitization', () => {
  it('reduces a title to a lowercase separator-joined identifier', () => {
    expect(sanitizeMemoryIdentifier('Fix Build Failure!')).toBe('fix-build-failure')
    expect(sanitizeMemoryIdentifier('  already-safe  ')).toBe('already-safe')
    // Runs of separators collapse, and a leading separator never survives.
    expect(sanitizeMemoryIdentifier('--a___b   c')).toBe('a-b-c')
  })

  it('strips a separator left behind by truncation', () => {
    // `abc-def` cut at four characters would otherwise end in a dash.
    expect(sanitizeMemoryIdentifier('abc def', 4)).toBe('abc')
    expect(sanitizeMemoryIdentifier('abcdef', 4)).toBe('abcd')
  })

  it('refuses a value with nothing usable left rather than returning an empty identifier', () => {
    expect(() => sanitizeMemoryIdentifier('')).toThrow(/no characters that can be used in an identifier/)
    // Non-ASCII normalizes away entirely instead of reaching a filesystem.
    expect(() => sanitizeMemoryIdentifier('构建失败')).toThrow(/no characters that can be used in an identifier/)
  })
})

describe('memory text normalization', () => {
  it('unifies newlines, drops control characters, and keeps tabs', () => {
    expect(sanitizeMemoryText('a\r\nb\rc')).toBe('a\nb\nc')
    expect(sanitizeMemoryText('a\u0000b\u0007c')).toBe('abc')
    expect(sanitizeMemoryText('a\tb')).toBe('a\tb')
    // The C1 range corrupts a JSON string and a terminal alike.
    expect(sanitizeMemoryText('a\u0085b')).toBe('ab')
  })

  it('strips trailing whitespace per line and collapses blank-line runs', () => {
    expect(sanitizeMemoryText('a   \nb\t\n')).toBe('a\nb')
    expect(sanitizeMemoryText('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('truncates only when the text exceeds the limit', () => {
    expect(sanitizeMemoryText('abcdef', 3)).toBe('abc')
    expect(sanitizeMemoryText('abc', 3)).toBe('abc')
  })

  it('never cuts a character in half', () => {
    // The cap counts UTF-16 code units, so a boundary landing inside a surrogate
    // pair leaves half a character behind — and that half is what a JSON encoder
    // writes as an unpaired escape and every downstream reader shows as a
    // replacement glyph: in the stored body, in the injected excerpt, and in the
    // export file the user opens.
    const text = sanitizeMemoryText(`${'a'.repeat(5)}\u{1F600}`, 6)
    expect(text).toBe('aaaaa')
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)).toBe(false)
  })
})

describe('memory redaction detection', () => {
  it('recognizes the marker this plugin writes', () => {
    expect(containsMemoryRedaction(`token was ${MEMORY_REDACTION_MARKER} here`)).toBe(true)
    expect(containsMemoryRedaction('nothing scrubbed')).toBe(false)
  })
})

describe('opaque credential heuristics', () => {
  it('flags a long hex blob and a mixed-case opaque token', () => {
    expect(looksLikeMemorySecretValue('9f2c4a7b1d8e3f5061728394a5b6c7d8')).toBe(true)
    expect(looksLikeMemorySecretValue('aB3dEf4Gh1Jk2Lm3No4Pq5Rs')).toBe(true)
  })

  it('does not flag prose, an ordinary word, or an absent value', () => {
    expect(looksLikeMemorySecretValue('')).toBe(false)
    expect(looksLikeMemorySecretValue('   ')).toBe(false)
    expect(looksLikeMemorySecretValue('the build needs flag X before release')).toBe(false)
    // Long but not hex, and not carrying all three character classes.
    expect(looksLikeMemorySecretValue('abcdefghijklmnopqrstuvwxyzabcdef')).toBe(false)
    expect(looksLikeMemorySecretValue('ABCDEFGHIJKLMNOPQRSTUVWXYZABCD')).toBe(false)
    expect(looksLikeMemorySecretValue('123456789012345678901234567890')).toBe(false)
  })
})

describe('memory persistence screening', () => {
  it('passes an ordinary entry and reports why', () => {
    const verdict = screenMemoryForPersistence({ title: 'Build needs flag X', body: 'The release build requires flag X.' })
    expect(verdict).toEqual({
      ok: true,
      credentials: [],
      shapeOnly: [],
      opaqueFields: [],
      redacted: false,
      summary: 'no credential-shaped content found',
    })
  })

  it('blocks an entry carrying a vendor-prefixed credential', () => {
    const verdict = screenMemoryForPersistence({ title: 'deploy note', body: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789' })
    expect(verdict.ok).toBe(false)
    expect(verdict.credentials).toHaveLength(1)
    // The finding names the rule and never the secret.
    expect(verdict.credentials[0]).toMatchObject({ ruleId: 'github-pat', confidence: 'high' })
    expect(JSON.stringify(verdict)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('blocks the shape-only tier, which the transient scan merely reports', () => {
    // `generic-secret-key` is a `medium` rule, so `scanForSecrets` reports it and
    // does not block it — right for text about to be displayed, wrong for a
    // boundary whose output outlives the session. The shape is the `sk-` key of
    // the providers this plugin runs against, so it is a credential, not a
    // coincidence. Before this, the verdict said `ok` and the export wrote the
    // key into a plaintext document outside the workspace.
    const secret = `sk-${'aB3'.repeat(16)}`
    const transient = scanForSecrets(`use ${secret} here`)
    expect(transient.blocked).toEqual([])
    expect(transient.findings.map(finding => `${finding.ruleId}/${finding.confidence}`)).toEqual(['generic-secret-key/medium'])

    const verdict = screenMemoryForPersistence({ title: 'deploy note', body: `use ${secret} here` })
    expect(verdict.ok).toBe(false)
    expect(verdict.credentials).toEqual([])
    expect(verdict.shapeOnly).toHaveLength(1)
    expect(verdict.shapeOnly[0]).toMatchObject({ ruleId: 'generic-secret-key', confidence: 'medium' })
    // Rule 1 still holds at this tier: the verdict identifies the match, never the secret.
    expect(JSON.stringify(verdict)).not.toContain(secret)
  })

  it('blocks an entry whose whole field is an unnamed credential', () => {
    const title = screenMemoryForPersistence({ title: '9f2c4a7b1d8e3f5061728394a5b6c7d8', body: 'prose' })
    expect(title.ok).toBe(false)
    expect(title.opaqueFields).toEqual(['title'])
    expect(title.summary).toContain('1 field(s) look like a bare credential: title')

    expect(screenMemoryForPersistence({ title: 'note', body: '9f2c4a7b1d8e3f5061728394a5b6c7d8' }).opaqueFields).toEqual(['body'])

    const tagged = screenMemoryForPersistence({ title: 'note', body: 'prose', tags: ['ok', '9f2c4a7b1d8e3f5061728394a5b6c7d8'] })
    expect(tagged.ok).toBe(false)
    expect(tagged.opaqueFields).toEqual(['tags[1]'])
    expect(tagged.summary).toContain('tags[1]')
  })

  it('reports an entry that has already been scrubbed', () => {
    const verdict = screenMemoryForPersistence({ title: 'deploy note', body: `the key was ${MEMORY_REDACTION_MARKER}` })
    expect(verdict.ok).toBe(true)
    expect(verdict.redacted).toBe(true)
    expect(verdict.summary).toContain('the text already contains a redaction marker')
  })

  it('omits the tags clause when no tags are supplied', () => {
    expect(screenMemoryForPersistence({ title: 'note', body: 'prose', tags: [] }).opaqueFields).toEqual([])
  })
})

describe('memory age', () => {
  it('classifies each band at its boundary', () => {
    const now = 1_800_000_000_000
    expect(describeMemoryAge(now, now)).toMatchObject({ freshness: 'fresh', ageMs: 0 })
    expect(describeMemoryAge(now - MEMORY_FRESH_MS, now)).toMatchObject({ freshness: 'fresh' })
    expect(describeMemoryAge(now - MEMORY_FRESH_MS - 1, now)).toMatchObject({ freshness: 'recent' })
    expect(describeMemoryAge(now - MEMORY_RECENT_MS, now)).toMatchObject({ freshness: 'recent' })
    expect(describeMemoryAge(now - MEMORY_RECENT_MS - 1, now)).toMatchObject({ freshness: 'stale' })
    expect(describeMemoryAge(now - MEMORY_STALE_MS, now)).toMatchObject({ freshness: 'stale' })
    expect(describeMemoryAge(now - MEMORY_STALE_MS - 1, now)).toMatchObject({ freshness: 'ancient' })
  })

  it('clamps a future timestamp to zero rather than reporting a negative age', () => {
    const now = 1_800_000_000_000
    expect(describeMemoryAge(now + 60_000, now)).toMatchObject({ ageMs: 0, freshness: 'fresh', label: 'just now' })
  })

  it('labels the age with the coarsest unit that still reads precisely', () => {
    const now = 1_800_000_000_000
    expect(describeMemoryAge(now - 30_000, now).label).toBe('just now')
    expect(describeMemoryAge(now - 60_000, now).label).toBe('1 minute')
    expect(describeMemoryAge(now - 5 * 60_000, now).label).toBe('5 minutes')
    expect(describeMemoryAge(now - 3_600_000, now).label).toBe('1 hour')
    expect(describeMemoryAge(now - 5 * 3_600_000, now).label).toBe('5 hours')
    expect(describeMemoryAge(now - 86_400_000, now).label).toBe('1 day')
    expect(describeMemoryAge(now - 4 * 86_400_000, now).label).toBe('4 days')
  })

  it('offers a caveat only once a record is no longer fresh', () => {
    const now = 1_800_000_000_000
    expect(memoryFreshnessNote(describeMemoryAge(now - 1_000, now))).toBeUndefined()
    expect(memoryFreshnessNote(describeMemoryAge(now - 2 * 86_400_000, now))).toBe('Recorded 2 days ago; re-check anything that may have changed since.')
    expect(memoryFreshnessNote(describeMemoryAge(now - 60 * 86_400_000, now))).toBe('Recorded 60 days ago and may be out of date; verify before relying on it.')
  })
})
