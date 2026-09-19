/**
 * Credential masking for text that crosses between the Host and an isolated
 * native worker.
 *
 * One implementation, three boundaries. The rule set below had been copied
 * verbatim into the Host supervisor and into both engine workers, and the copies
 * had already drifted the way copies do: three names for one function
 * (`redactRuntimeDetail`, `redactAppServerDetail`, `redactClaudeSdkDetail`) and a
 * different set of exits covered by each — so a Host tool failure reached the
 * model through both workers unmasked, while a worker's own stderr was masked.
 *
 * It lives in this package because every side already depends on it: the
 * supervisor and both workers import the framing helpers, and `root-agent` — which
 * owns the bridge that *produces* the error text — depends on it too.
 *
 * The second owner
 * ----------------
 * `harness-plugin/src/secret-scan.ts` masks credentials on the Host side, for
 * text that is shown, logged or persisted there. That module cannot be imported
 * here — `harness-plugin` depends on *this* package, not the other way round — so
 * the shape vocabulary has two owners by necessity, and the two had already
 * diverged in both directions: this masker knew `Basic <credential>` and a
 * labelled query-string secret (`?api_key=…`, `?token=…`, `?secret=…`) that the
 * Host side did not mask, while the Host side knew seventeen vendor prefixes
 * (AWS, Slack, Stripe, npm, GitLab, SendGrid, GCP, pypi, a JWT, a PEM blob) that
 * a worker's stderr went through unmasked. A credential shape only one boundary
 * knows about is a credential that leaks out of the other one, and the direction
 * that mattered most here was the worker's: its text is the last hop before Host
 * text becomes model context.
 *
 * A later pass found the same defect one shape further out: the Host's
 * `cline.ts` knew an OAuth `client_secret` label that neither list masked, so
 * the worker boundary leaked it too. It is adopted on both sides, with a parity
 * sample, rather than left to the one exit that wrote the pattern down.
 *
 * The next pass found the third instance of the pattern, one label over from the
 * second: `api_key` was known only where a `?`/`&` anchored it, so the JSON-body
 * spelling `client_secret` had just been fixed for still carried it readable.
 *
 * So the vendor shapes were adopted here rather than re-derived, and the two sets
 * are now held equal by `harness-plugin/tests/cross-boundary-credential-parity.spec.ts`,
 * which masks one sample per shape with both implementations and fails when
 * either list grows without the other. Masking is always the safe direction: a
 * false positive costs one redacted word, a missed shape costs a live token in a
 * transcript, so this list is deliberately the broader of the two (its bearer
 * rule takes any scheme-adjacent token, where the Host's asks for twelve
 * characters and a digit so that prose about authentication stays readable).
 *
 * @module @deepseek-ai/dsh-freecodego-native-runtime-protocol/redact
 */

/** What replaces a credential, whatever shape or value it had. */
const REDACTED = '<redacted>'

/**
 * Values shorter than this are never treated as secrets.
 *
 * A caller that hands over every environment value in reach will eventually hand
 * over a one-character one, and replacing that wherever it appears turns a
 * diagnostic into noise. Nothing this plugin handles is this short: the loopback
 * bridge token is 43 characters, and provider keys are longer.
 */
const MINIMUM_SECRET_LENGTH = 8

/**
 * One credential shape, as data rather than as a chained `replace`.
 *
 * The table exists so the vocabulary has a name a test can compare against, and
 * so a shape carries its own replacement: the first two rules keep the text that
 * identifies *which* credential leaked (`Bearer <redacted>`, `api_key=<redacted>`)
 * while a bare key is replaced whole.
 */
export interface CredentialShape {
  /** Stable id, for a parity sample and for a future opt-out by name. */
  readonly id: string
  /** Regex source; compiled once, lazily. */
  readonly source: string
  /** Flags; `g` is required so one pass masks every occurrence. */
  readonly flags: string
  /**
   * Replacement for the whole match.
   *
   * Defaults to the marker. `$1` restores a captured prefix, which is how a rule
   * masks the credential and keeps the scheme or parameter name that makes the
   * diagnostic worth reading.
   */
  readonly replace?: string
}

/**
 * Every credential shape masked at a worker boundary.
 *
 * Rule order is precedence: the first rule to match wins, and a later rule sees
 * whatever the earlier ones left behind. The scheme-preserving and
 * parameter-preserving rules therefore come first, so that the shape a reader can
 * still recognize survives.
 *
 * The vendor-prefix rules from `harness-plugin/src/secret-scan.ts`'s curated list
 * are copied verbatim, confidence and all — the confidence levels are not used
 * here (masking has no refusal to decide) but the comments in that module explain
 * why each source is written the way it is, and a re-derived pattern would be a
 * second measurement of the same thing.
 */
export const CREDENTIAL_SHAPES: readonly CredentialShape[] = [
  // Authorization headers, scheme preserved. Broader than the Host's measured
  // rule on purpose: `Bearer <anything non-space>` is a credential far more often
  // than it is prose, and the cost of being wrong is one redacted word.
  { id: 'authorization-header', source: '\\b(Bearer|Basic)\\s+[^\\s"\']+', flags: 'giu', replace: '$1 <redacted>' },
  { id: 'github-token', source: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\\b', flags: 'gu' },
  { id: 'github-fine-grained-token', source: '\\bgithub_pat_[A-Za-z0-9_]{20,}\\b', flags: 'gu' },
  { id: 'provider-key', source: '\\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\\b', flags: 'giu' },
  // The label is part of the span so it can be put back: `?api_key=<redacted>`
  // names the parameter that leaked, which is the whole value of the message.
  { id: 'labelled-query-secret', source: '([?&](?:access[-_]?token|refresh[-_]?token|api[-_]?key|token|secret|password)=)[^&#\\s]+', flags: 'giu', replace: '$1<redacted>' },
  // Shapes that announce themselves only in a transport context; the Host side
  // carries the same three, with the same ids.
  { id: 'url-userinfo-credential', source: '(?<=https?://)[^\\s/:@]+:[^\\s/@:]*[A-Za-z._~%+!$-][^\\s/@:]*', flags: 'giu' },
  // Kept character-for-character identical to the Host's rule of the same id, by
  // `cross-boundary-credential-parity.spec.ts`. The second lookahead excludes a
  // tail that ends in a dotted label, because that tail is a file name rather than
  // a key: the rule used to mask `tools/key-store-v2.json` and every other path
  // whose name merely starts with a credible prefix.
  { id: 'prefixed-opaque-key', source: '\\b(?:sk|key|token)[-_](?=[a-z0-9._-]*\\d)(?![a-z0-9._-]*\\.[a-z][a-z0-9]{0,11}(?![a-z0-9._-]))[a-z0-9._-]{12,}(?![a-z0-9._-])', flags: 'giu' },
  { id: 'labelled-access-token', source: '\\b(?:access[_-]?token|refresh[_-]?token)(?:["\'=:\\s]+)[a-z0-9._~+/=-]{8,}', flags: 'giu' },
  // The OAuth client credential, adopted from the Host side at the same time as
  // the rule there: `cline.ts` had the only pattern that knew it, so a
  // `"client_secret": "…"` in a worker's stderr reached the model readable. The
  // shape arrives in a JSON body rather than a query string, which is why it is a
  // label rule here as well.
  { id: 'labelled-client-secret', source: '\\b(?:client[_-]?secret)(?:["\'=:\\s]+)[a-z0-9._~+/=-]{8,}', flags: 'giu' },
  // The third instance of the same shape, and the reason the label rules exist at
  // all: `api_key` was masked only where a `?`/`&` anchored it, so the spelling a
  // JSON error body or a config dump actually carries -- the exact text
  // `client_secret` had just been fixed for -- went through readable. The Host
  // already reads that label as a credential (the registration response is taken
  // as `payload.api_key`, and the external-asset audit refuses a sentence that
  // assigns one), so it was the maskers, not the callers, that did not know it.
  { id: 'labelled-api-key', source: '\\b(?:api[_-]?key)(?:["\'=:\\s]+)[a-z0-9._~+/=-]{8,}', flags: 'giu' },
  // The curated vendor rules, adopted so the worker boundary knows every shape
  // the Host boundary knows.
  { id: 'private-key-block', source: '-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----', flags: 'gu' },
  { id: 'aws-access-key-id', source: '\\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\\b', flags: 'gu' },
  { id: 'github-pat', source: '\\bghp_[A-Za-z0-9]{36}\\b', flags: 'gu' },
  { id: 'github-fine-grained-pat', source: '\\bgithub_pat_[A-Za-z0-9_]{50,}\\b', flags: 'gu' },
  { id: 'github-oauth', source: '\\bgh[ousr]_[A-Za-z0-9]{36}\\b', flags: 'gu' },
  // Slack's own prefix set, not the five the class started with: `xoxc-` is a
  // browser session token and `xoxd-` the cookie beside it, and a class that
  // names five of seven prefixes is a class a live token walks through.
  { id: 'slack-token', source: '\\bxox[abprscd]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])', flags: 'gu' },
  { id: 'gcp-api-key', source: '\\bAIza[0-9A-Za-z_-]{35}\\b', flags: 'gu' },
  { id: 'google-oauth-access', source: '\\bya29\\.[0-9A-Za-z_-]{20,}(?![0-9A-Za-z_-])', flags: 'gu' },
  { id: 'stripe-secret-key', source: '\\bsk_live_[0-9A-Za-z]{20,}\\b', flags: 'gu' },
  { id: 'npm-token', source: '\\bnpm_[A-Za-z0-9]{36}\\b', flags: 'gu' },
  { id: 'pypi-token', source: '\\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])', flags: 'gu' },
  { id: 'anthropic-api-key', source: '\\bsk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])', flags: 'gu' },
  { id: 'sendgrid-token', source: '\\bSG\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])', flags: 'gu' },
  { id: 'gitlab-pat', source: '\\bglpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])', flags: 'gu' },
  { id: 'json-web-token', source: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])', flags: 'gu' },
  { id: 'generic-secret-key', source: '\\bsk-[A-Za-z0-9]{32,}\\b', flags: 'gu' },
  { id: 'pem-encoded-blob', source: '\\bMII[A-Za-z0-9+/]{60,}={0,2}', flags: 'gu' },
]

const compiled = new Map<string, RegExp>()

/**
 * The compiled regex for one shape.
 *
 * Keyed by id, and reused: `String.prototype.replace` with a `g`-flagged
 * expression resets `lastIndex` itself, so a shared instance cannot skip a match
 * the way a shared `test`/`exec` loop would.
 */
function shapeRegex(shape: CredentialShape): RegExp {
  const existing = compiled.get(shape.id)
  if (existing !== undefined) return existing
  const regex = new RegExp(shape.source, shape.flags)
  compiled.set(shape.id, regex)
  return regex
}

/**
 * Mask credential **shapes** — text that looks like a credential no matter whose
 * it is: an authorization header, a provider key, a token in a query string.
 * @param value - the text to clean.
 * @returns the text with every credential-shaped span replaced.
 */
export function redactCredentialShapes(value: string): string {
  let masked = value
  for (const shape of CREDENTIAL_SHAPES) {
    // Every pass re-tests the current text, so a shape nested inside a span an
    // earlier shape already replaced cannot come back.
    masked = masked.replace(shapeRegex(shape), shape.replace ?? REDACTED)
  }
  return masked
}

/**
 * Mask the exact credential values the caller already holds, then the shapes.
 *
 * Shapes are not enough on their own: a tool that echoes its own environment
 * produces text no pattern recognizes, and only the process holding the value can
 * name it. Pass every value in reach — `undefined` entries are ignored, so an
 * optional variable can be handed over without checking it first.
 *
 * @param value - the text to clean.
 * @param knownValues - credentials this process holds, in any order.
 * @returns the text with known values and credential-shaped spans replaced.
 */
export function redactSecrets(value: string, knownValues: readonly (string | undefined)[] = []): string {
  let masked = value
  for (const secret of knownValues) {
    if (typeof secret !== 'string' || secret.length < MINIMUM_SECRET_LENGTH) continue
    masked = masked.replaceAll(secret, REDACTED)
  }
  return redactCredentialShapes(masked)
}
