/**
 * Two maskers guard two halves of one pipeline, and until this spec existed
 * nothing compared them.
 *
 * `harness-plugin/src/secret-scan.ts` masks credentials in Host text — what is
 * shown, logged and persisted. `native-runtime-protocol/src/redact.ts` masks the
 * text that crosses the Host↔worker boundary — a tool failure, a worker's stderr,
 * a bridge error — and it cannot import the Host module, because the Host package
 * depends on *that* one. So the vocabulary has two owners by necessity, and the
 * two had already drifted in both directions:
 *
 * - the worker masker knew `Basic <credential>` and a labelled query-string secret
 *   (`?api_key=…`, `?token=…`, `?secret=…`) that the Host masker did not
 * - the Host masker knew seventeen vendor prefixes — AWS, Slack, Stripe, npm,
 *   GitLab, SendGrid, GCP, pypi, a JWT, a PEM blob — that a worker's stderr went
 *   straight through
 *
 * The second direction is the one that matters: worker text is the last hop before
 * Host text becomes model context, so a shape only the Host knew was unmasked at
 * the exit least likely to be watched.
 *
 * What this holds. For every shape in either list there is a sample below, and
 * each sample is checked four ways: the shape's *own* pattern matches the sample
 * (so a sample cannot silently cover for a pattern that stopped working), the
 * other implementation's list names a rule for it, and **both** maskers remove the
 * credential from a diagnostic sentence. A shape added to either list without a
 * sample fails the coverage assertions in both directions, which is the moment to
 * adopt it on the other side.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/cross-boundary-credential-parity
 */

import { describe, expect, it } from 'vitest'
// By package name rather than by relative path: a relative path into another
// project's `src` is an import TypeScript refuses to rewrite (TS2878), and the
// two sibling suites that need another package's code import it the same way.
import { CREDENTIAL_SHAPES, redactCredentialShapes as maskAtWorkerBoundary } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'
import { SECRET_RULES, TRANSPORT_SHAPE_RULES, redactCredentialShapes as maskAtHostBoundary } from '../src/secret-scan.ts'

interface Sample {
  /** What leaked, for the failure message. */
  readonly what: string
  /** The credential inside {@link text}; masking has to remove every occurrence. */
  readonly secret: string
  /** A diagnostic-shaped sentence carrying it, the way a tool would report it. */
  readonly text: string
  /**
   * Every worker-boundary shape this sample is evidence for.
   *
   * Plural because a text can match several: the adopted vendor mirrors
   * (`github-pat` beside the masker's own `github-token`) are narrower restatements
   * of a shape the masker already knows, and listing both keeps the two
   * vocabularies comparable by id.
   */
  readonly workerShapes: readonly string[]
  /** Host-side rules that must also mask it (curated or transport). */
  readonly hostRules: readonly string[]
}

const BEARER = 'Abcdefgh12345678xyz'
const GITHUB_PAT = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const GITHUB_FINE_GRAINED = `github_pat_11ABCDEFG0123456789${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'}`
const PROVIDER_KEY_UPPER = `sk-${'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'}`
const PROVIDER_KEY_LOWER = `sk-${'abcdefghijklmnopqrstuvwxyz012345'}`
const GCP_API_KEY = `AIzaSyA1234567890${'abcdefghijklmnopqrstuv'}`
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'
const BASIC_CREDENTIAL = 'YWRtaW46cGFzczEyMw=='
const PEM_BLOB = `MII${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'}`
const QUERY_SECRET = 'zzZ1234567890'
/**
 * A Stripe-shaped live key. The prefix is written out because the rule it feeds
 * matches on it; the body is interpolated because GitHub's push protection
 * refuses a push carrying the literal `sk_live_…`, fixtures included, and it
 * reads the committed bytes rather than the runtime value.
 */
const STRIPE_LIVE_KEY = 'sk_live_' + 'abcdefghijklmnopqrstuvwx'

const SAMPLES: readonly Sample[] = [
  {
    what: 'a bearer token in an authorization header',
    secret: BEARER,
    text: `tool failed: Authorization: Bearer ${BEARER}`,
    workerShapes: ['authorization-header'],
    hostRules: ['bearer-token'],
  },
  {
    what: 'a basic credential in an authorization header',
    secret: BASIC_CREDENTIAL,
    text: `proxy rejected: Authorization: Basic ${BASIC_CREDENTIAL}`,
    workerShapes: ['authorization-header'],
    hostRules: ['basic-auth'],
  },
  {
    what: 'a classic GitHub token',
    secret: GITHUB_PAT,
    text: `env GITHUB_TOKEN=${GITHUB_PAT} is set`,
    workerShapes: ['github-token', 'github-pat'],
    hostRules: ['github-pat'],
  },
  {
    what: 'a fine-grained GitHub token',
    secret: GITHUB_FINE_GRAINED,
    text: `git clone failed for ${GITHUB_FINE_GRAINED}`,
    workerShapes: ['github-fine-grained-token', 'github-fine-grained-pat'],
    hostRules: ['github-fine-grained-pat'],
  },
  {
    what: 'an opaque provider key',
    secret: PROVIDER_KEY_UPPER,
    text: `openai-compatible adapter rejected ${PROVIDER_KEY_UPPER}`,
    workerShapes: ['provider-key', 'generic-secret-key'],
    hostRules: ['generic-secret-key'],
  },
  {
    what: 'an Anthropic key',
    secret: ANTHROPIC_KEY,
    text: `messages call refused with ${ANTHROPIC_KEY}`,
    workerShapes: ['anthropic-api-key', 'provider-key'],
    hostRules: ['anthropic-api-key'],
  },
  {
    what: 'a labelled query-string secret',
    secret: QUERY_SECRET,
    text: `GET https://gateway.internal/v1/models?api_key=${QUERY_SECRET} returned 401`,
    workerShapes: ['labelled-query-secret'],
    hostRules: ['labelled-query-secret'],
  },
  {
    what: 'a URL password',
    secret: 'hunter2',
    text: 'remote https://admin:hunter2@example.test/repo.git refused',
    workerShapes: ['url-userinfo-credential'],
    hostRules: ['url-userinfo-credential'],
  },
  {
    what: 'a prefixed opaque key',
    secret: 'key-abcdef1234567890',
    text: 'workbuddy call failed with key-abcdef1234567890',
    workerShapes: ['prefixed-opaque-key'],
    hostRules: ['prefixed-opaque-key'],
  },
  {
    what: 'a labelled access token outside a query string',
    secret: 'abcdefgh12345678',
    text: 'refresh failed: access_token=abcdefgh12345678',
    workerShapes: ['labelled-access-token'],
    hostRules: ['labelled-access-token'],
  },
  {
    what: 'a labelled OAuth client secret',
    secret: 'abcdefgh12345678',
    // The shape neither list knew until `cline.ts`'s private chain was read, and
    // the spelling is the one it actually arrives in: a JSON body rather than a
    // query string, so nothing anchored on `?`/`&` reaches it.
    text: 'oauth exchange failed: {"error":"invalid_client","client_secret":"abcdefgh12345678"}',
    workerShapes: ['labelled-client-secret'],
    hostRules: ['labelled-client-secret'],
  },
  {
    what: 'a labelled API key in a JSON body',
    secret: 'abcdefgh12345678',
    // The third instance of the same shape. `client_secret` had just been adopted
    // because it arrives in a body rather than a query string, and `api_key`
    // arrives in exactly that place -- the registration response this plugin reads
    // is `payload.api_key` -- while only a `?`/`&` anchor knew it.
    text: 'registration returned {"api_key":"abcdefgh12345678"} and it was stored',
    workerShapes: ['labelled-api-key'],
    hostRules: ['labelled-api-key'],
  },
  {
    what: 'a private key block',
    secret: '-----BEGIN RSA PRIVATE KEY-----',
    text: 'pasted file began with -----BEGIN RSA PRIVATE KEY----- and was refused',
    workerShapes: ['private-key-block'],
    hostRules: ['private-key-block'],
  },
  {
    what: 'an AWS access key id',
    secret: 'AKIAIOSFODNN7EXAMPLE',
    text: 'aws cli reported AKIAIOSFODNN7EXAMPLE as its credential',
    workerShapes: ['aws-access-key-id'],
    hostRules: ['aws-access-key-id'],
  },
  {
    what: 'a GitHub OAuth token',
    secret: 'gho_abcdefghijklmnopqrstuvwxyz0123456789',
    text: 'gh auth failed for gho_abcdefghijklmnopqrstuvwxyz0123456789',
    workerShapes: ['github-oauth', 'github-token'],
    hostRules: ['github-oauth'],
  },
  {
    what: 'a Slack token',
    secret: 'xoxb-1234567890-abcdefghijkl',
    text: 'slack webhook refused xoxb-1234567890-abcdefghijkl',
    workerShapes: ['slack-token'],
    hostRules: ['slack-token'],
  },
  {
    what: 'a Slack browser session token',
    secret: 'xoxc-1234567890-abcdefghijkl',
    // The class carried `b`, `p`, `a`, `r` and `s`; Slack also issues `xoxc-` and
    // `xoxd-`, and a class that names five of seven prefixes is one a live token
    // walks through. Masking is the safe direction, so the class is the full set.
    text: 'slack session refused xoxc-1234567890-abcdefghijkl',
    workerShapes: ['slack-token'],
    hostRules: ['slack-token'],
  },
  {
    what: 'a Google API key',
    // The curated rule counts exactly 35 characters after `AIza`, so a sample one
    // character short would pass the masking assertions through a *different*
    // shape and stop being evidence for this one.
    secret: GCP_API_KEY,
    text: `gemini request used ${GCP_API_KEY}`,
    workerShapes: ['gcp-api-key'],
    hostRules: ['gcp-api-key'],
  },
  {
    what: 'a Google OAuth access token',
    secret: 'ya29.abcdefghijklmnopqrstuvwx',
    text: 'google api refused ya29.abcdefghijklmnopqrstuvwx',
    workerShapes: ['google-oauth-access'],
    hostRules: ['google-oauth-access'],
  },
  {
    what: 'a Stripe secret key',
    secret: STRIPE_LIVE_KEY,
    text: `stripe call failed with ${STRIPE_LIVE_KEY}`,
    workerShapes: ['stripe-secret-key'],
    hostRules: ['stripe-secret-key'],
  },
  {
    what: 'an npm token',
    secret: 'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    text: 'npm publish failed with npm_abcdefghijklmnopqrstuvwxyz0123456789',
    workerShapes: ['npm-token'],
    hostRules: ['npm-token'],
  },
  {
    what: 'a PyPI token',
    secret: `pypi-AgEIcHlwaS5vcmc${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'}`,
    text: `twine failed with pypi-AgEIcHlwaS5vcmc${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'}`,
    workerShapes: ['pypi-token'],
    hostRules: ['pypi-token'],
  },
  {
    what: 'a SendGrid token',
    secret: 'SG.abcdefghijklmnopqrstuv.abcd12345678efghijklmnop',
    text: 'mail send failed with SG.abcdefghijklmnopqrstuv.abcd12345678efghijklmnop',
    workerShapes: ['sendgrid-token'],
    hostRules: ['sendgrid-token'],
  },
  {
    what: 'a GitLab personal access token',
    secret: 'glpat-abcdefghijklmnopqrstuvwx',
    text: 'gitlab api refused glpat-abcdefghijklmnopqrstuvwx',
    workerShapes: ['gitlab-pat'],
    hostRules: ['gitlab-pat'],
  },
  {
    what: 'a JSON web token',
    secret: JWT,
    text: `session cookie carried ${JWT}`,
    workerShapes: ['json-web-token'],
    hostRules: ['json-web-token'],
  },
  {
    what: 'a bare generic secret key',
    secret: PROVIDER_KEY_LOWER,
    text: `read .npmrc and found ${PROVIDER_KEY_LOWER}`,
    workerShapes: ['generic-secret-key', 'provider-key'],
    hostRules: ['generic-secret-key'],
  },
  {
    what: 'a PEM encoded blob',
    secret: PEM_BLOB,
    text: `tail of the key was ${PEM_BLOB}`,
    workerShapes: ['pem-encoded-blob'],
    hostRules: ['pem-encoded-blob'],
  },
]

const WORKER_SHAPES = new Map(CREDENTIAL_SHAPES.map(shape => [shape.id, shape]))
const HOST_RULES = new Map([...SECRET_RULES, ...TRANSPORT_SHAPE_RULES].map(rule => [rule.id, rule]))

describe('the credential vocabulary both maskers own', () => {
  it('covers every worker-boundary shape with a sample its own pattern matches', () => {
    const declared = new Set(SAMPLES.flatMap(sample => sample.workerShapes))
    const uncovered = [...WORKER_SHAPES.keys()].filter(id => !declared.has(id))
    expect(uncovered, 'add a parity sample for each new worker-boundary shape').toEqual([])
    for (const sample of SAMPLES) {
      for (const id of sample.workerShapes) {
        const shape = WORKER_SHAPES.get(id)
        expect(shape, `${id} is not a worker-boundary shape`).toBeDefined()
        expect(
          new RegExp(shape?.source ?? '', shape?.flags ?? 'gu').test(sample.text),
          `${id} claims ${sample.what} but its own pattern does not match it`,
        ).toBe(true)
      }
    }
  })

  it('covers every Host rule with a sample its own pattern matches', () => {
    const declared = new Set(SAMPLES.flatMap(sample => sample.hostRules))
    const uncovered = [...HOST_RULES.keys()].filter(id => !declared.has(id))
    expect(uncovered, 'add a parity sample for each new Host rule, and adopt the shape at the worker boundary').toEqual([])
    for (const sample of SAMPLES) {
      for (const id of sample.hostRules) {
        const rule = HOST_RULES.get(id)
        expect(rule, `${id} is not a Host rule`).toBeDefined()
        expect(
          new RegExp(rule?.source ?? '', 'gi').test(sample.text),
          `${id} claims ${sample.what} but its own pattern does not match it`,
        ).toBe(true)
      }
    }
  })

  it('masks every sample at both boundaries', () => {
    for (const sample of SAMPLES) {
      expect(sample.text, `${sample.what}: the sample does not carry its secret`).toContain(sample.secret)
      // The direction that matters most: this text is the last hop before model
      // context, and the worker masker used to know fewer shapes than the Host one.
      expect(
        maskAtWorkerBoundary(sample.text),
        `the worker-boundary masker left ${sample.what} readable`,
      ).not.toContain(sample.secret)
      expect(
        maskAtHostBoundary(sample.text),
        `the Host masker left ${sample.what} readable`,
      ).not.toContain(sample.secret)
    }
  })

  it('leaves an ordinary diagnostic alone on both sides', () => {
    // The other half of the contract: a masker that fires on prose is a masker
    // people route around, so nothing added here may widen into sentences.
    const diagnostics = [
      'Error: spawn codex ENOENT at /opt/runtime/codex',
      'token-based-auth and key-value-pairs are configuration names, not credentials',
      'retry after 250 ms; request id 8f2ab1e0',
      'worktree is clean; 3 files changed',
      // A file name is not a credential. These four are the repository's own paths,
      // and the `prefixed-opaque-key` rule masked every one of them before its
      // second lookahead existed — which is worse than it sounds, because naming the
      // file that failed is the entire payload of the diagnostic it appears in. Each
      // one is a *shape* the rule must keep sparing: a dotted tail is read as an
      // extension, whatever the prefix in front of it claims.
      'wrote tools/key-store-v2.json',
      'read src/token-usage-2026.json',
      'opened logs/key-rotation-2026.log',
      'the skill is at skills/token-budget-2026.md',
    ]
    for (const text of diagnostics) {
      expect(maskAtWorkerBoundary(text), `the worker-boundary masker rewrote: ${text}`).toBe(text)
      expect(maskAtHostBoundary(text), `the Host masker rewrote: ${text}`).toBe(text)
    }
  })

  it('spares authentication prose at the Host boundary, which is where the measured rules live', () => {
    // These two sentences are why the Host's bearer and basic rules carry a
    // length-and-digit requirement, and the requirement is measured against them.
    const prose = [
      'Authorization: Basic authentication is required',
      'The bearer of good news is that the token budget reset',
    ]
    for (const text of prose) {
      expect(maskAtHostBoundary(text), `the Host masker rewrote: ${text}`).toBe(text)
    }
  })

  it('masks that same prose at the worker boundary, which is the documented asymmetry', () => {
    // The worker masker takes any token after `Bearer`/`Basic`, so it rewrites
    // these sentences. That is deliberate and is the one place the two lists
    // differ by design: a worker's stderr is a diagnostic tail, not a document
    // read for prose, and its text is the last hop before model context — where
    // the cost of a missed key is a live token in the transcript and the cost of
    // over-masking is one mangled word. `runtime-claude` had pinned a digitless
    // bearer token (`Bearer abcdefghijklmnop`), which the measured rule spares; a
    // masker that must catch it cannot also spare every English phrase.
    expect(maskAtWorkerBoundary('Authorization: Basic authentication is required'))
      .toBe('Authorization: Basic <redacted> is required')
  })
})
