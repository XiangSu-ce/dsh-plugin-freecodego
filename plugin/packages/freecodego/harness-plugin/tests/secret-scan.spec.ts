import { describe, expect, it } from 'vitest'
import { inspectExternalEngineeringAsset } from '../src/engineering.ts'
import { logfareResponseError } from '../src/managed-catalog-utils.ts'
import { SECRET_RULES, containsSecret, describeSecretFindings, redactCredentialShapes, redactSecret, redactSecretSpans, scanForSecrets } from '../src/secret-scan.ts'

describe('credential rules', () => {
  it('catches each high-confidence vendor shape', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['aws-access-key-id', 'aws_access_key = "AKIAIOSFODNN7EXAMPLE"'],
      // A real PAT is 36 alphanumerics after the prefix; a shorter fixture would
      // test the fixture, not the rule.
      ['github-pat', `token: ghp_${'a'.repeat(36)}`],
      ['github-fine-grained-pat', `github_pat_${'a'.repeat(60)}`],
      ['slack-token', 'SLACK=xoxb-1234567890-abcdefghij'],
      ['gcp-api-key', `key=AIza${'b'.repeat(35)}`],
      ['stripe-secret-key', `sk_live_${'c'.repeat(24)}`],
      ['npm-token', `//registry.npmjs.org/:_authToken=npm_${'d'.repeat(36)}`],
      ['anthropic-api-key', `ANTHROPIC_API_KEY=sk-ant-api03-${'e'.repeat(40)}`],
      ['gitlab-pat', `glpat-${'f'.repeat(20)}`],
      ['private-key-block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...'],
    ]
    for (const [ruleId, text] of cases) {
      const result = scanForSecrets(text)
      expect(result.clean, `${ruleId} should match`).toBe(false)
      expect(result.blocked.map(finding => finding.ruleId)).toContain(ruleId)
    }
  })

  it('redacts the whole credential when its own bytes end in a separator', () => {
    // `-` is not a word character, so a rule that closed on `\b` had no boundary
    // to match when the token itself ended in `-`: the engine gave the
    // quantifier back one character and stopped *before* it, so the key was
    // masked but that separator survived in the message.
    //
    // Asserted on the rule's own match length rather than on the redacted text.
    // An Anthropic key is also matched by `prefixed-opaque-key`, whose span
    // covers the separator either way — so an output-level assertion passes on
    // the leaking form and proves nothing about the rule under test.
    const cases: readonly (readonly [string, string])[] = [
      ['anthropic-api-key', `sk-ant-api03-${'A'.repeat(40)}-`],
      ['gitlab-pat', `glpat-${'b'.repeat(20)}-`],
      ['pypi-token', `pypi-AgEIcHlwaS5vcmc${'c'.repeat(40)}-`],
      ['slack-token', `xoxb-${'d'.repeat(20)}-`],
      ['google-oauth-access', `ya29.${'e'.repeat(20)}-`],
      ['sendgrid-token', `SG.${'f'.repeat(20)}.${'g'.repeat(20)}-`],
    ]
    for (const [ruleId, secret] of cases) {
      const finding = scanForSecrets(secret).findings.find(candidate => candidate.ruleId === ruleId)
      expect(finding, `${ruleId} should match`).toBeDefined()
      expect(finding?.length, `${ruleId} stopped short of the separator it must consume`).toBe(secret.length)
    }
  })

  it('leaves ordinary source text and ordinary identifiers alone', () => {
    // A scanner whose false positives make people turn it off protects nothing,
    // which is why the generic keyword-context rules are absent by design.
    const clean = [
      'const apiKeyName = "STRIPE_SECRET_KEY";',
      'npm run build && git commit -m "fix"',
      'The README mentions gh-pages and yaml.',
      'sk-' + 'a'.repeat(10), // short: not a plausible key
      'Authorization: Bearer <redacted>',
      '-----BEGIN PGP SIGNATURE-----',
    ]
    for (const text of clean) {
      const result = scanForSecrets(text)
      expect(result.blocked, `should not block: ${text}`).toEqual([])
    }
  })

  it('reports a shape-only match at medium confidence without blocking it', () => {
    const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`
    const result = scanForSecrets(jwt)
    expect(result.clean).toBe(true)
    expect(result.blocked).toEqual([])
    expect(result.findings.map(finding => finding.confidence)).toEqual(['medium'])
    // Lowering the bar turns the same text into a block, so the threshold is the
    // caller's decision and not the rule's.
    expect(scanForSecrets(jwt, { minimumConfidence: 'medium' }).clean).toBe(false)
  })

  it('lets a caller allow a rule it has already accepted', () => {
    const text = `key=AIza${'b'.repeat(35)}`
    expect(scanForSecrets(text, { allowRules: ['gcp-api-key'] }).clean).toBe(true)
  })

  it('has unique rule ids, so a finding always names exactly one rule', () => {
    const ids = SECRET_RULES.map(rule => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const rule of SECRET_RULES) expect(() => new RegExp(rule.source, 'g')).not.toThrow()
  })
})

describe('findings never contain the secret', () => {
  it('keeps a four-character prefix and the length only', () => {
    const secret = `sk-ant-api03-${'z'.repeat(48)}`
    // Four characters are kept as an identifying prefix; the rest is never reported.
    const result = scanForSecrets(`KEY=${secret}`)
    expect(result.blocked).toHaveLength(1)
    const finding = result.blocked[0]!
    // The report is not allowed to be a leak vector, so the full secret must not
    // appear anywhere in it — not in the redacted form, not in the description.
    expect(finding.redacted).toBe(redactSecret(secret))
    expect(finding.redacted).not.toContain(secret)
    // Derived from the fixture rather than hardcoded, so a fixture change cannot
    // make this assertion test my arithmetic instead of the redaction.
    expect(finding.redacted).toContain(`(${secret.length} chars)`)
    expect(finding.length).toBe(secret.length)
    expect(describeSecretFindings(result.blocked)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('counts distinct rules in the summary instead of repeating one per match', () => {
    const text = 'a=AKIAIOSFODNN7EXAMPLE\nb=AKIAIOSFODNN7EXAMPLX'
    const summary = describeSecretFindings(scanForSecrets(text).blocked)
    expect(summary).toContain('2 credential-shaped match(es)')
    expect(summary).toContain('aws-access-key-id')
  })

  it('reports no findings for clean text', () => {
    expect(describeSecretFindings([])).toBe('no credential-shaped content found')
  })
})

describe('redaction spans', () => {
  it('splices last-to-first so earlier indices stay valid', () => {
    const first = 'AKIAIOSFODNN7EXAMPLE'
    const second = `ghp_${'a'.repeat(36)}`
    const text = `a=${first} b=${second} c=${first}`
    const result = scanForSecrets(text)
    const redacted = redactSecretSpans(text, result.findings)
    expect(redacted).not.toContain(first)
    expect(redacted).not.toContain(second)
    expect(redacted).toBe('a=[redacted credential] b=[redacted credential] c=[redacted credential]')
  })

  it('leaves non-blocking findings in place when only blocking ones are passed', () => {
    const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`
    const text = `aws=AKIAIOSFODNN7EXAMPLE jwt=${jwt}`
    const result = scanForSecrets(text)
    const redacted = redactSecretSpans(text, result.blocked)
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(redacted).toContain(jwt)
  })

  it('accepts a custom marker', () => {
    const text = 'k=AKIAIOSFODNN7EXAMPLE'
    expect(redactSecretSpans(text, scanForSecrets(text).findings, '<secret>')).toBe('k=<secret>')
  })

  it('merges overlapping findings instead of splicing the same region twice', () => {
    // Two rules matching one region is normal and deliberate: a credential inside
    // a base64 blob is two real findings. Splicing them independently rewrote the
    // same offset twice and produced text that belonged to neither rule — with
    // part of the credential still in it.
    const text = `k=${'M'.repeat(40)}!`
    const findings = [
      { ruleId: 'pem-encoded-blob', confidence: 'medium' as const, index: 2, length: 40, redacted: 'MMMM…(40 chars)' },
      { ruleId: 'aws-access-key-id', confidence: 'high' as const, index: 10, length: 20, redacted: 'MMMM…(20 chars)' },
    ]
    expect(redactSecretSpans(text, findings)).toBe('k=[redacted credential]!')
  })

  it('catches every vendor shape, and the one written down with a label', () => {
    // The gate both non-tiered surfaces call. This case exists because the two of
    // them used to hold private copies of the keyword pattern alone, and the
    // external-asset audit's copy had lost the `sk-` alternative the memory
    // writer's kept — so the audit passed every vendor-prefixed credential below
    // while the memory writer refused all of them.
    const shapes: readonly (readonly [string, string])[] = [
      ['anthropic key', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
      ['bare sk- key', `sk-${'a'.repeat(40)}`],
      ['below the curated floor', `sk-${'a'.repeat(22)}`],
      ['github pat', `ghp_${'A'.repeat(36)}`],
      ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
      ['slack token', `xoxb-${'1'.repeat(20)}-abcdefghijkl`],
      ['gitlab pat', `glpat-${'A'.repeat(20)}`],
      ['npm token', `npm_${'A'.repeat(36)}`],
      ['google api key', `AIza${'B'.repeat(35)}`],
      ['private key header', '-----BEGIN RSA PRIVATE KEY-----'],
      ['labelled key', 'api_key = "abcdefghijklmnop1234"'],
      ['labelled token', 'token: "abcdefghijklmnopqrst"'],
    ]
    for (const [name, text] of shapes) {
      expect(containsSecret(text), name).toBe(true)
      // The audit that gates externally sourced skills, MCP configurations and
      // catalogue entries must agree, because it is what stands between a
      // community asset and a managed directory.
      const findings = inspectExternalEngineeringAsset('probe', `---\nname: a\n---\n${text}`, true)
      expect(findings.some(finding => finding.rule === 'ENG_EXTERNAL_SECRET_PATTERN'), name).toBe(true)
    }
  })

  it('leaves prose that merely describes a field alone', () => {
    // The reason the curated list omits keyword-context matching: a rule set that
    // fires on documentation is a rule set people switch off. These are the shapes
    // a broad pattern would catch and the vendor rules deliberately do not.
    const prose = [
      'Set the token to the value you were issued, then restart.',
      'The api_key field is required by the provider and is stored in the vault.',
      'A password of at least 12 characters is recommended.',
    ]
    for (const text of prose) {
      expect(scanForSecrets(text).findings, text).toEqual([])
      // The audit is the broad one, and this is where its breadth is visible: a
      // sentence naming a field is refused as a labelled credential. That is the
      // deliberate trade — an asset is refused by a human, and the refusal names
      // the rule — while the memory writer takes the same text.
      expect(containsSecret(text), text).toBe(false)
    }
  })

  it('masks a vendor credential in text that is about to be shown or logged', () => {
    // Every redaction helper in the plugin prepends this, because each was written
    // for the shapes its author had seen and all of them missed a prefixed token.
    const leaked = `HTTP 401: rejected key ghp_${'A'.repeat(36)} for request`
    const masked = redactCredentialShapes(leaked)
    expect(masked).not.toContain('ghp_')
    expect(masked).toContain('[redacted credential]')
    expect(masked).toContain('HTTP 401: rejected key')
  })

  it('masks the backend text an error message is built from', async () => {
    // The registration path turns a backend body into a message with this one
    // helper, and that call posts a password. It bounded the text but never
    // masked it, while every sibling surface (provider errors, media details,
    // job summaries) already did — the split was which family the author was
    // editing, not which one carried a credential.
    const leaked = `npm_${'A'.repeat(36)}`
    const jsonFailure = await logfareResponseError(
      new Response(JSON.stringify({ error: { message: `invalid request: ${leaked}` } }), { status: 422, headers: { 'content-type': 'application/json' } }),
      'registration failed',
    )
    expect(jsonFailure).toContain('registration failed: invalid request')
    expect(jsonFailure).not.toContain(leaked)
    // The non-JSON branch is text from the same source, so it is masked too.
    const textFailure = await logfareResponseError(new Response(`<html>bad key ${leaked}</html>`, { status: 502 }), 'registration failed')
    expect(textFailure).toContain('HTTP 502')
    expect(textFailure).not.toContain(leaked)
  })

  it('keeps a partial overlap correct when the ranges cross rather than nest', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'
    const findings = [
      { ruleId: 'a', confidence: 'high' as const, index: 0, length: 10, redacted: 'abcd…(10 chars)' },
      { ruleId: 'b', confidence: 'high' as const, index: 5, length: 15, redacted: 'fghi…(15 chars)' },
    ]
    // The merged span runs 0..20, so exactly the last six characters survive.
    expect(redactSecretSpans(text, findings)).toBe('[redacted credential]uvwxyz')
  })
})
