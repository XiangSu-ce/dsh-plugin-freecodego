/**
 * The credential masker every side of the worker boundary shares.
 *
 * Moved here from `runtime-claude` when the rule set was consolidated: three
 * packages had carried an identical copy under three names, and the copies had
 * already diverged in what they covered, so a Host tool failure reached the model
 * unmasked while a worker's own stderr was masked. One copy means one spec.
 *
 * It also has to be pinned directly, because no call site can show it: the
 * worker's stderr projection truncates to 2000 characters, the Codex worker wraps
 * the text in an MCP tool result, and the bridge producer's text is one field of a
 * response frame. A regression in the shape list is invisible from all three, and
 * this is the last hop before Host text becomes model context.
 *
 * @module @deepseek-ai/dsh-freecodego-native-runtime-protocol/tests/redact
 */

import { describe, expect, it } from 'vitest'
import { redactCredentialShapes, redactSecrets } from '../src/redact.ts'

/** A credential this process holds that no shape rule would recognize. */
const HELD_VALUE = 'A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz0123456'

describe('redactCredentialShapes', () => {
  it.each([
    ['an authorization header', 'Authorization: Bearer abcdefghijklmnop', 'Authorization: Bearer <redacted>'],
    ['a basic authorization header', 'proxy said Basic dXNlcjpwYXNzd29yZA==', 'proxy said Basic <redacted>'],
    ['a GitHub token', 'env GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwx', 'env GITHUB_TOKEN=<redacted>'],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0123456789abcdef', '<redacted>'],
    ['an Anthropic key', 'key sk-ant-api03-abcdefghijklmnopqrstuv rejected', 'key <redacted> rejected'],
    ['a query-string token', 'https://h/v1?token=abc123&x=1', 'https://h/v1?token=<redacted>&x=1'],
    ['a snake-case API key', 'https://h/v1?api_key=zzz', 'https://h/v1?api_key=<redacted>'],
  ])('masks %s', (_case, input, expected) => {
    expect(redactCredentialShapes(input)).toBe(expected)
  })

  it('leaves a diagnostic that carries no credential untouched', () => {
    const message = 'Error: spawn codex ENOENT at /opt/runtime/codex'
    expect(redactCredentialShapes(message)).toBe(message)
  })

  it('masks the whole value, not just its head', () => {
    expect(redactCredentialShapes('sk-ant-api03-abcdefghijklmnopqrstuv')).toBe('<redacted>')
  })

  it('masks the same text the same way on a second call', () => {
    // Shared `g`-flagged regular expressions carry `lastIndex` between calls, so
    // a later refactor to one module-level table would start skipping matches.
    const text = 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuv'
    expect(redactCredentialShapes(text)).toBe('Authorization: Bearer <redacted>')
    expect(redactCredentialShapes(text)).toBe('Authorization: Bearer <redacted>')
  })
})

describe('redactSecrets', () => {
  it('masks a held value that no shape rule recognizes, wherever it appears', () => {
    expect(redactSecrets(`tool echoed ${HELD_VALUE} twice: ${HELD_VALUE}`, [HELD_VALUE]))
      .toBe('tool echoed <redacted> twice: <redacted>')
  })

  it('leaves the value alone when the caller does not hold it', () => {
    expect(redactSecrets(`tool echoed ${HELD_VALUE}`, [])).toBe(`tool echoed ${HELD_VALUE}`)
  })

  it('masks held values and shapes in one pass', () => {
    expect(redactSecrets(`${HELD_VALUE} and Bearer sk-ant-api03-abcdefghijklmnopqrstuv`, [HELD_VALUE]))
      .toBe('<redacted> and Bearer <redacted>')
  })

  it('ignores a value too short to be a credential, which would shred the text', () => {
    // Every environment value in reach is offered, and one of them is bound to be
    // this short: replacing it would turn a diagnostic into noise.
    expect(redactSecrets('value 1 of 1', ['1', 'of', ''])).toBe('value 1 of 1')
  })

  it('tolerates an optional variable the caller never checked', () => {
    expect(redactSecrets('plain diagnostic', [undefined, ''])).toBe('plain diagnostic')
  })
})
