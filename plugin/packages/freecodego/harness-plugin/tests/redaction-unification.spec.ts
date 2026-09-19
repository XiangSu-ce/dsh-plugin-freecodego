/**
 * The credential shapes with no vendor prefix, and the four private copies that
 * had each learned a different subset of them.
 *
 * Why this file exists
 * --------------------
 * `secret-scan.ts` was already the authority for the *vendor-prefixed* shapes,
 * and every redaction helper in the plugin called it. What it did not own was
 * the prefix-less half — `Bearer <opaque>`, `https://user:<password>@host`,
 * `token-<opaque>`, `access_token=<value>` — so four surfaces had grown their own
 * chain for it: `media-utils.ts`, `workbuddy-intl.ts`, `agnes.ts` and
 * `openai-compatible-adapter.ts`. They had already drifted. The media chain
 * knew `sk-`/`key-`/`token-` prefixes and the account surface did not; the
 * WorkBuddy chain knew the `access_token`/`refresh_token` pair and the media
 * chain did not; two of the four wrote `Bearer <redacted>` and the other two
 * renamed it. Fixing a shape in one of them left the other three leaking.
 *
 * So the union moved into `secret-scan.ts` as `TRANSPORT_SHAPE_RULES`, applied
 * by `redactCredentialShapes` alone, and two of the four chains were deleted.
 * This file pins the three things that makes true:
 *
 * - **The copies are gone.** Asserted against the source text, because a
 *   behavioural test cannot tell a deleted copy from a copy that still agrees
 *   with the shared rule — and a copy that agrees today is the drift of
 *   tomorrow.
 * - **The migration changed nothing it was not meant to.** The pre-migration
 *   chains are reconstructed here from the shared pieces that still exist, and
 *   every input the two surfaces handled before is asserted byte-identical.
 * - **The shapes it was meant to change, changed.** The new coverage, and the
 *   one defect the old chain had (a bearer token whose own bytes were a known
 *   shape was spliced twice, leaving `Bearer <redacted> credential]`).
 *
 * The two adapters (`agnes.ts`, `openai-compatible-adapter.ts`) are not migrated
 * by this change and are not asserted here; their chains are the same defect and
 * belong to their own owner.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/redaction-unification
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { redactMediaDetail } from '../src/media-utils.ts'
import { SECRET_RULES, TRANSPORT_SHAPE_RULES, containsSecret, redactCredentialShapes, redactSecretSpans, scanForSecrets } from '../src/secret-scan.ts'
import { parseWorkBuddyLoginPoll } from '../src/workbuddy-intl.ts'

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file: string): string => readFileSync(join(PACKAGE, file), 'utf8')

/** Long enough and mixed enough for the bearer rule; four local chains masked it. */
const OPAQUE_BEARER = 'aB3dE5fG7hI9jK1lM3nO5pQ7'
const GITHUB_PAT = `ghp_${'A'.repeat(36)}`
const ANTHROPIC_KEY = `sk-ant-api03-${'z'.repeat(40)}`
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

/**
 * The shared masking as it stood before the migration.
 *
 * Reconstructed from the two exported pieces that still exist rather than
 * copied from the old source, because those two pieces are exactly what the
 * migrated chain shares: `redactCredentialShapes` was, and still is, this call.
 * Comparing the migrated helper against it isolates the only thing that
 * changed — the local regexes that were deleted.
 */
function legacySharedMask(value: string): string {
  return redactSecretSpans(value, scanForSecrets(value, { minimumConfidence: 'medium' }).findings)
}

/**
 * The `redactMediaDetail` chain before the migration, frozen.
 *
 * Dead code on purpose. A regression test that re-derives its expectation from
 * the implementation it is testing asserts nothing about the migration.
 */
function legacyMediaChain(value: string): string {
  return legacySharedMask(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/\b(?:sk|key|token)[-_][a-z0-9._-]{12,}\b/gi, '<redacted>')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 1_000)
}

/** The `redact` chain `workbuddy-intl.ts` carried before the migration, frozen. */
function legacyWorkBuddyChain(value: string): string {
  return legacySharedMask(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/(?:^|[\s"'=&?])(?:access[_-]?token|refresh[_-]?token|accessToken|refreshToken)(?:["'=:\s]+)[a-z0-9._~+/=-]{8,}/gi, '$1<redacted>')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 512)
}

/**
 * Drive the module-private `redact` through the one exported path that reads it.
 *
 * A refused sign-in poll carries the backend's own `msg` through it, which is
 * the same value the parked-account reason and the turn error are built from.
 */
function workBuddyRedact(text: string): string {
  const result = parseWorkBuddyLoginPoll({ code: 40_003, msg: text })
  if (result.kind !== 'failed') throw new Error('the poll was expected to be refused')
  return result.message
}

describe('the private copies are gone', () => {
  it('media-utils no longer carries its bearer or prefixed-key regex', () => {
    const source = read('src/media-utils.ts')
    // The delegation has to survive as well: a chain deleted without being
    // replaced would pass the two assertions below and mask nothing.
    expect(source).toContain('return redactCredentialShapes(value)')
    expect(source).not.toContain('replace(/Bearer')
    expect(source).not.toContain('(?:sk|key|token)')
  })

  it('workbuddy-intl no longer carries its bearer or token-pair regex', () => {
    const source = read('src/workbuddy-intl.ts')
    expect(source).toContain('return redactCredentialShapes(value)')
    expect(source).not.toContain('replace(/Bearer')
    expect(source).not.toContain('access[_-]?token')
  })

  it('keeps the prefix-less shapes out of the curated list, so no gate changed', () => {
    // The whole reason these live in a second list: `scanForSecrets` feeds
    // `containsSecret` and the durable-memory screen, where a match is a
    // refusal. A bearer token in a sentence documenting authentication must not
    // become a refusal, and moving a rule into the curated list would do that.
    const curated = new Set(SECRET_RULES.map(rule => rule.id))
    for (const rule of TRANSPORT_SHAPE_RULES) {
      expect(curated.has(rule.id), rule.id).toBe(false)
      expect(() => new RegExp(rule.source, 'gi')).not.toThrow()
    }
    const transport = TRANSPORT_SHAPE_RULES.map(rule => rule.id)
    expect(transport).toContain('bearer-token')
    expect(transport).toContain('url-userinfo-credential')
    expect(transport).toContain('prefixed-opaque-key')
    expect(transport).toContain('labelled-access-token')
  })
})

describe('the shapes the authority did not know', () => {
  it('masks a bearer token, which no curated rule ever saw', () => {
    // The report this file was written from: `redactCredentialShapes` alone left
    // the token in place, and only the four local chains removed it.
    const leaked = `HTTP 401: rejected Bearer ${OPAQUE_BEARER} for request`
    expect(legacySharedMask(leaked)).toContain(OPAQUE_BEARER)
    const masked = redactCredentialShapes(leaked)
    expect(masked).not.toContain(OPAQUE_BEARER)
    expect(masked).toBe('HTTP 401: rejected Bearer <redacted> for request')
  })

  it('masks the password in a URL, which nothing masked before', () => {
    // Not one of the four copies handled this shape, so it is the one credential
    // every exit leaked. Only the userinfo is the secret: a message that names
    // which host refused it is the point of masking it at all.
    const leaked = `proxy refused https://deploy:${GITHUB_PAT}@api.github.com/repos/x/y`
    const masked = redactCredentialShapes(leaked)
    expect(masked).not.toContain(GITHUB_PAT)
    expect(masked).toContain('https://[redacted credential]@api.github.com/repos/x/y')
  })

  it('masks a labelled access token, the shape only one copy knew', () => {
    const masked = redactCredentialShapes('refresh failed: access_token=abcdefghij')
    expect(masked).not.toContain('abcdefghij')
    expect(masked).toContain('refresh failed: <redacted>')
  })
})

describe('ordinary text is not harmed', () => {
  it('leaves prose, code and identifier-shaped words untouched', () => {
    // Every one of these is a string the local copies either masked or were
    // narrowed specifically to keep masking. Unification widened each rule's
    // reach to forty call sites, so a false positive here is forty times worse
    // than it was when one chain had it.
    const untouched = [
      'the bearer of good news',
      'Bearer authentication is required',
      'Set the token to the value you were issued, then restart.',
      'The api_key field is required by the provider and is stored in the vault.',
      // The prose form of the label `labelled-client-secret` adopted from
      // `cline.ts`. Its comment claims the same bound as the line above — a
      // sentence naming the field stays readable, the assignment does not — and
      // only the assignment half was pinned; the secret form is measured in
      // `cross-boundary-credential-parity.spec.ts`.
      'the client_secret field is required',
      'token-based authentication is common in HTTP APIs',
      'key-value pairs are useful for configuration',
      'npm run build && git commit -m "fix"',
      // A host:port followed by an @-prefixed path segment is not a userinfo
      // credential, and a maps URL is where the two are most easily confused.
      'https://maps.example.com:443/@37.7,-122.4,15z',
      'https://user@example.com/profile',
      'https://api.example.com:443/v1/chat',
      'Authorization: Bearer <redacted>',
    ]
    for (const text of untouched) {
      expect(redactCredentialShapes(text), text).toBe(text)
    }
  })

  it('keeps the two credential *decisions* exactly as they were', () => {
    // Masking widened; the gates did not. `containsSecret` refuses content that
    // is about to be written, and `scanForSecrets` reports what a durable entry
    // refuses, so neither may start firing on a shape that is merely documented.
    const bearer = `Authorization: Bearer ${OPAQUE_BEARER}`
    expect(scanForSecrets(bearer).findings).toEqual([])
    expect(scanForSecrets(bearer).blocked).toEqual([])
    expect(containsSecret(bearer)).toBe(false)
    expect(scanForSecrets('https://deploy:pass@host/x').findings).toEqual([])
    expect(containsSecret('https://deploy:pass@host/x')).toBe(false)
    // The curated tier is unchanged, which is what those two answers rest on.
    expect(containsSecret(`key=${ANTHROPIC_KEY}`)).toBe(true)
  })
})

describe('the media chain migration is behaviour-preserving', () => {
  const corpus: readonly string[] = [
    `HTTP 402: rejected key ${GITHUB_PAT}`,
    `Authorization: Bearer ${OPAQUE_BEARER}`,
    `upstream said: key=${ANTHROPIC_KEY}`,
    'token-abcdef1234567890',
    'sk-abcdefghij1234567890',
    `glpat-${'A'.repeat(20)}`,
    'no credential here at all',
    'line one\nline two\nline three',
    `mixed: ${GITHUB_PAT} and Bearer ${OPAQUE_BEARER} and token-abcdef1234567890`,
  ]

  it('produces the same bytes as the chain it replaced', () => {
    for (const input of corpus) {
      expect(redactMediaDetail(input), input).toBe(legacyMediaChain(input))
    }
  })

  it('still folds newlines and bounds the length, which stayed local', () => {
    expect(redactMediaDetail('a\nb')).toBe('a b')
    expect(redactMediaDetail('x'.repeat(2_000))).toHaveLength(1_000)
  })

  it('masks a shape the media chain never knew, because the union is shared', () => {
    // The `access_token` pair came from the WorkBuddy chain. Before the
    // migration the media exit leaked it; the point of one owner is that it no
    // longer has to be told about it separately.
    const leaked = `audio refused: access_token=abcdefghij`
    expect(legacyMediaChain(leaked)).toContain('abcdefghij')
    expect(redactMediaDetail(leaked)).not.toContain('abcdefghij')
  })

  it('no longer mangles a bearer token that is itself a known shape', () => {
    // The defect the deletion fixed: the shared pass replaced the JWT with a
    // marker, and the local bearer regex then matched the *marker's* first word,
    // leaving `Bearer <redacted> credential]` — half a credential-shaped word in
    // a message a user reads. One pass over both rules cannot do that.
    const input = `upstream 401 for Bearer ${JWT}`
    expect(legacyMediaChain(input)).toContain('credential]')
    const masked = redactMediaDetail(input)
    expect(masked).toBe('upstream 401 for Bearer <redacted>')
    expect(masked).not.toContain(JWT)
  })
})

describe('the workbuddy chain migration is behaviour-preserving', () => {
  // Deliberately no labelled-token input here: the chain this replaces wrote a
  // literal `$1` for them, which is asserted as a fix on its own below.
  const corpus: readonly string[] = [
    `invalid key ${ANTHROPIC_KEY}`,
    `Authorization: Bearer ${OPAQUE_BEARER}`,
    'authorization denied',
    'line one\nline two',
    `${GITHUB_PAT} was rejected`,
  ]

  it('produces the same bytes as the chain it replaced', () => {
    for (const input of corpus) {
      expect(workBuddyRedact(input), input).toBe(legacyWorkBuddyChain(input))
    }
  })

  it('no longer writes the literal `$1` its old replacement string produced', () => {
    // The defect the deletion fixed, found by this file rather than by reading:
    // the separator in the old pattern was a *non-capturing* group, so the
    // `$1` in its replacement string had no group to refer to and JavaScript
    // emitted it verbatim. Every message that carried a labelled token named
    // `$1` instead of the credential — and swallowed the separator with it.
    const input = 'refresh failed: access_token=abcdefghij'
    expect(legacyWorkBuddyChain(input)).toBe('refresh failed:$1<redacted>')
    expect(workBuddyRedact(input)).toBe('refresh failed: <redacted>')
  })

  it('masks a shape only the media chain knew, because the union is shared', () => {
    // The mirror image of the media case: the `sk-`/`key-`/`token-` prefix rule
    // came from the media chain, so this provider gained it too.
    const leaked = 'refresh refused for token-abcdef1234567890'
    expect(legacyWorkBuddyChain(leaked)).toContain('token-abcdef1234567890')
    expect(workBuddyRedact(leaked)).not.toContain('token-abcdef1234567890')
  })

  it('still folds newlines and bounds the length, which stayed local', () => {
    expect(workBuddyRedact('a\nb')).toBe('a b')
    expect(workBuddyRedact('x'.repeat(2_000))).toHaveLength(512)
  })
})
