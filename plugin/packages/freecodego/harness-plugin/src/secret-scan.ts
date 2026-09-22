/**
 * Credential scanning for content that is about to be persisted or shared.
 *
 * Why
 * ---
 * Project memory is written from what the agent read. A file it read can contain
 * a real token — a `.npmrc`, a CI config, a pasted curl command in a README — and
 * a memory entry that captured that text outlives the session, gets re-injected
 * into later conversations, and (with team memory) can leave the machine. Our
 * existing redaction is keyed on *field names* (`MCP_SECRET_REDACTED` replaces
 * MCP `env`/`headers` values), which covers configuration we control and misses
 * a credential that appears in file text.
 *
 * Claude Code's team-memory scanner (`services/teamMemorySync/secretScanner.ts`)
 * makes one decision worth copying exactly: it uses a curated subset of gitleaks
 * rules — **only rules with a distinctive prefix and a near-zero false-positive
 * rate** — and deliberately omits the generic "keyword context" rules. A scanner
 * whose false positives make people disable it protects nothing.
 *
 * Two rules this module imposes on itself:
 *
 * 1. **Findings never contain the secret.** `redactSecret` keeps a short prefix
 *    and the length, which is enough to identify which credential leaked and not
 *    enough to use it. A scanner that returns the match turns its own report into
 *    the leak.
 * 2. **Confidence is part of the match.** The strong rules above are
 *    `high`; the shape-only rules that could plausibly match an ordinary
 *    identifier are `medium`, and the caller decides what to do with each.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/secret-scan
 */

export type SecretConfidence = 'high' | 'medium'

/** One curated credential pattern and the severity it reports at. */
export interface SecretRule {
  /** Rule id, so a finding names which pattern matched. */
  readonly id: string
  /** Regex source; compiled once, lazily. */
  readonly source: string
  readonly confidence: SecretConfidence
  /**
   * Marker this rule's own surfaces have always written, when it differs from
   * the caller's default.
   *
   * It exists so that moving a rule out of a private chain into this module can
   * be a behaviour-preserving change. Four separate chains wrote
   * `Bearer <redacted>`, and a shared implementation that renamed the marker
   * would turn a de-duplication into a visible edit of every message that
   * carried one — a refactor nobody asked for, in the exact place where a
   * changed message is hardest to notice.
   */
  readonly marker?: string
}

/**
 * High-confidence rules: each requires a distinctive vendor prefix, so a match is
 * a credential and not a coincidence.
 *
 * A rule whose body ends in an *open-ended* character class containing `-` must
 * close with `(?![A-Za-z0-9_-])` rather than `\b`. `-` is not a word character,
 * so a trailing `\b` has no boundary to match when the token itself ends in `-`:
 * the engine gives the quantifier back one character and stops *before* that
 * `-`, redacting the key but leaving its last character in the message. The
 * lookahead asserts what the rule means — "no further key characters follow" —
 * and the open-ended quantifier absorbs the separator, keeping the whole token
 * inside the match. A rule with an *exact* count keeps `\b`: its class cannot
 * absorb a separator, so the lookahead would refuse to match at all, and a
 * trailing `-` after a fixed-length key is a separator rather than key bytes.
 * Rules whose class is `[A-Za-z0-9]` or includes `_` are unaffected either way,
 * because those do end on a word character.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  { id: 'private-key-block', source: '-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----', confidence: 'high' },
  { id: 'aws-access-key-id', source: '\\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\\b', confidence: 'high' },
  { id: 'github-pat', source: '\\bghp_[A-Za-z0-9]{36}\\b', confidence: 'high' },
  { id: 'github-fine-grained-pat', source: '\\bgithub_pat_[A-Za-z0-9_]{50,}\\b', confidence: 'high' },
  { id: 'github-oauth', source: '\\bgh[ousr]_[A-Za-z0-9]{36}\\b', confidence: 'high' },
  // Slack's full prefix set: `xoxc-` (browser session) and `xoxd-` (the cookie
  // beside it) were missing from the class, so the two maskers that share this
  // vocabulary both walked past a live Slack credential.
  { id: 'slack-token', source: '\\bxox[abprscd]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])', confidence: 'high' },
  // `{35}` is an exact count, so the class cannot absorb a separator that
  // follows the key: the lookahead would see that `-` and refuse to match at
  // all. Google's key is exactly 35 characters, so a `-` after it is a
  // separator rather than part of the credential, and `\b` states that.
  { id: 'gcp-api-key', source: '\\bAIza[0-9A-Za-z_-]{35}\\b', confidence: 'high' },
  { id: 'google-oauth-access', source: '\\bya29\\.[0-9A-Za-z_-]{20,}(?![0-9A-Za-z_-])', confidence: 'high' },
  { id: 'stripe-secret-key', source: '\\bsk_live_[0-9A-Za-z]{20,}\\b', confidence: 'high' },
  { id: 'npm-token', source: '\\bnpm_[A-Za-z0-9]{36}\\b', confidence: 'high' },
  { id: 'pypi-token', source: '\\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])', confidence: 'high' },
  // Anthropic keys are `sk-ant-api<NN>-…` (e.g. `sk-ant-api03-`); the vendor and
  // version segments are what make this high confidence rather than another
  // `sk-` shape. The version digits are part of the prefix — a pattern that
  // expects `-` immediately after the letters silently matches nothing real.
  { id: 'anthropic-api-key', source: '\\bsk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])', confidence: 'high' },
  { id: 'sendgrid-token', source: '\\bSG\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])', confidence: 'high' },
  { id: 'gitlab-pat', source: '\\bglpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])', confidence: 'high' },
  // Shape-only rules: a JWT and a bare `sk-` key are credentials in context and
  // opaque identifiers out of it, so they are reported at lower confidence.
  { id: 'json-web-token', source: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])', confidence: 'medium' },
  { id: 'generic-secret-key', source: '\\bsk-[A-Za-z0-9]{32,}\\b', confidence: 'medium' },
  { id: 'pem-encoded-blob', source: '\\bMII[A-Za-z0-9+/]{60,}={0,2}', confidence: 'medium' },
]

/**
 * Shapes that announce themselves only in a transport context, and are ordinary
 * text outside one.
 *
 * Why these are not in {@link SECRET_RULES}
 * ----------------------------------------
 * The curated list's contract is that a match *is* a credential, which is what
 * lets `containsSecret` refuse text on a match alone. `Bearer <token>`,
 * `https://user:<password>@host`, `token-<opaque>` and `access_token=<value>`
 * cannot honour that contract: the first and the last appear verbatim in prose
 * documenting how to authenticate, and the URL form appears in a path that
 * merely starts with `@`. Asking a *persistence* decision to refuse on them
 * would turn documentation into a refusal, which is the failure mode that
 * teaches people to route around the scanner.
 *
 * They are not optional either. Four surfaces had each grown a private copy of
 * some subset — `media-utils.ts`, `workbuddy-intl.ts`, `agnes.ts` and
 * `openai-compatible-adapter.ts` — and the copies had already drifted: one had
 * lost the `sk-` alternative, one renamed the marker, and none of them was
 * reached by the other three. A credential shape that only one exit knows about
 * is a credential that leaks out of the other three. The same reading later
 * turned up a fifth private chain in `cline.ts`, which masked the OAuth
 * `client_secret` label that neither this list nor the worker masker knew:
 * {@link labelled-client-secret} is that shape, adopted here so every exit masks
 * it rather than the one that happened to write the pattern down.
 *
 * So the union lives here and is applied by {@link redactCredentialShapes}
 * alone: masking is always safe, because the cost of a false positive is one
 * redacted word, while the cost of a missed shape is a live token in a
 * transcript. {@link scanForSecrets} deliberately does not report them, so
 * `containsSecret` and the durable-memory screen keep the exact behaviour they
 * had.
 *
 * Each boundary is measured rather than assumed, and the measurement is why the
 * patterns are narrower than the local copies were:
 *
 * - a bearer token must be at least twelve characters and contain a digit, so
 *   `the bearer of good news` and `Bearer authentication is required` stay
 *   readable while a JWT or an opaque key is masked
 * - a URL password must contain a non-digit, because `host:443/@handle` is
 *   otherwise indistinguishable from `user:pass@host` and the second reading of
 *   a coordinates URL is not worth the first reading of a real password
 * - a `sk-`/`key-`/`token-` body must contain a digit, so `token-based-auth` and
 *   `key-value-pairs` are not masked as credentials
 * - a basic credential must be at least sixteen characters and contain a digit or
 *   a base64 symbol, so `Basic authentication` and `Basic authorization
 *   required` stay readable while a base64-encoded `user:password` is masked
 * - a labelled credential needs a separator and an eight-character value after
 *   the label, so `the client_secret field is required` stays readable while
 *   `"client_secret": "…"` and `client_secret=…` are masked — the same bound the
 *   two `access_token`-shaped labels above already carried, which is what makes
 *   each added label a widening rather than a new trade-off
 *
 * The other owner of this vocabulary
 * --------------------------------
 * `native-runtime-protocol/src/redact.ts` masks the same kind of text at the
 * worker boundary — the Host↔runtime hop — and it cannot import this module,
 * because this package depends on *that* one. The two lists had already diverged
 * in both directions (that masker knew `Basic …` and a labelled query-string
 * secret; this one knew seventeen vendor prefixes it did not), so
 * `cross-boundary-credential-parity.spec.ts` now masks one sample per shape with
 * both implementations and fails when either list grows without the other. Adding
 * a shape below means adding its sample there, and adopting the same shape in the
 * worker masker so the exit least likely to be seen is not the one that misses it.
 */
export const TRANSPORT_SHAPE_RULES: readonly SecretRule[] = [
  // The scheme is part of the match so the marker can keep it, which is what the
  // four local copies wrote. The lookahead is the digit requirement above.
  { id: 'bearer-token', source: '\\bBearer\\s+(?=[A-Za-z0-9._~+/=-]*\\d)[A-Za-z0-9._~+/=-]{12,}', confidence: 'medium', marker: 'Bearer <redacted>' },
  // The lookbehind keeps the host readable: only the userinfo is the credential,
  // and a message that names which URL refused it is the point of masking it.
  { id: 'url-userinfo-credential', source: '(?<=https?://)[^\\s/:@]+:[^\\s/@:]*[A-Za-z._~%+!$-][^\\s/@:]*', confidence: 'medium' },
  // `sk-` below the curated rule's 32-character floor, plus the two prefixed
  // spellings no curated rule knows. Case-insensitive: the copy this replaces was.
  //
  // The second lookahead is F-08's fix: a tail that ends in a dotted label (`store-v2.json`,
  // `rotation-2026.log`) is a **file name**, not a key. Without it the rule masked the
  // repository's own paths — `tools/key-store-v2.json`, `src/token-usage-2026.json`,
  // `logs/key-rotation-2026.log` all came back as `<redacted>` — and those paths are the
  // payload of the diagnostic they appeared in: a message that cannot name the file that
  // failed is a message with no reason to exist. The dotted label is read as an extension
  // when it starts with a letter and is 1–12 characters long, which covers `.json`, `.log`,
  // `.tsx`, `.yaml`, `.properties`; a longer dotted run (`abc.def1234567890`) is still read
  // as key material, and a key whose tail is shaped exactly like a file name is left to the
  // vendor-prefix rules above rather than masked here at the cost of every real path.
  { id: 'prefixed-opaque-key', source: '\\b(?:sk|key|token)[-_](?=[a-z0-9._-]*\\d)(?![a-z0-9._-]*\\.[a-z][a-z0-9]{0,11}(?![a-z0-9._-]))[a-z0-9._-]{12,}(?![a-z0-9._-])', confidence: 'medium', marker: '<redacted>' },
  // The labelled pair a token refresh rotates, in the JSON, query and header
  // spellings the copies each knew one of. The label is part of the span because
  // that is the span the copy it replaces removed.
  { id: 'labelled-access-token', source: "\\b(?:access[_-]?token|refresh[_-]?token)(?:[\"'=:\\s]+)[a-z0-9._~+/=-]{8,}", confidence: 'medium', marker: '<redacted>' },
  // The OAuth client credential, which neither list knew until `cline.ts` was
  // read: its private chain masked `client[_-]?secret` while this one and the
  // worker masker both let it through, and the shape is a credential on every
  // exit rather than on the one. It is a *label* rule rather than a query rule
  // because the text it arrives in is a JSON error body or a config dump
  // (`"client_secret": "…"`), which no `?`/`&` anchor reaches. The label is
  // part of the span, as in the two rules above and for the same reason.
  { id: 'labelled-client-secret', source: "\\b(?:client[_-]?secret)(?:[\"'=:\\s]+)[a-z0-9._~+/=-]{8,}", confidence: 'medium', marker: '<redacted>' },
  // The provider credential named by its label instead of by a vendor prefix, in
  // the same place the rule above arrives in and for the same reason: the shape
  // is a credential on every exit, and only a `?`/`&` anchor knew it. The bound is
  // the one the rules above already carry, so a sentence naming the field stays
  // readable (`The api_key field is required`) while `api_key = "…"` does not.
  //
  // The span is the **value**, not the label — the one place in this table where
  // that is so, and the reason is `x-api-key`. The label here is not only a field
  // name this plugin writes; it is also the tail of a header name a provider
  // echoes back, and `x-api-key: <secret>` is what a refused turn actually says.
  // Keeping the label in the span turned that into `x-<redacted>`, which is
  // neither the readable half of the failure nor a complete header name — the
  // shape `claude-bridge-secret.spec.ts` pins by asserting the sentence survives
  // while the secret does not. A lookbehind moves the match to the value, so the
  // label survives in every position it can appear (header, JSON body,
  // assignment) while the secret is still masked. Bounded rather than
  // open-ended: an unbounded lookbehind is a backtracking cost on every scan, and
  // the separator run between a label and its value is never longer than four
  // characters.
  { id: 'labelled-api-key', source: "(?<=\\bapi[_-]?key[\"'=:\\s]{1,4})[a-z0-9._~+/=-]{8,}", confidence: 'medium', marker: '<redacted>' },
  // The other three quarters of the same shape: a credential named by its query
  // parameter rather than by a vendor prefix. `?token=<opaque>` was masked by the
  // worker masker and left readable here, which is the direction that matters —
  // this module's text is what gets shown, logged and persisted.
  { id: 'labelled-query-secret', source: '(?<=[?&])(?:api[_-]?key|token|secret|password)=[^&#\\s]{8,}', confidence: 'medium', marker: '<redacted>' },
  // A proxy's or a proxy-adjacent tool's `Authorization: Basic <base64>`. The lookahead
  // pair is the measurement described above: the length floor keeps a two-word
  // sentence out, and the digit-or-symbol requirement keeps an English phrase out
  // while a base64-encoded `user:password` has one or the other.
  { id: 'basic-auth', source: '\\bBasic\\s+(?=[A-Za-z0-9+/=._~-]{16,})(?=[A-Za-z0-9+/=._~-]*(?:\\d|[+/=]))[A-Za-z0-9+/=._~-]+', confidence: 'medium', marker: 'Basic <redacted>' },
]

/** One credential-shaped match, carrying enough to redact it but never the secret. */
export interface SecretFinding {
  readonly ruleId: string
  readonly confidence: SecretConfidence
  /** Index in the scanned text, so a caller can splice without re-searching. */
  readonly index: number
  /** Length of the matched secret; never the secret itself. */
  readonly length: number
  /** A short identifying prefix plus the length. Never usable as the credential. */
  readonly redacted: string
  /** Marker the rule asks for; absent means the caller's own. */
  readonly marker?: string
}

/** Everything one scan found, split by whether it blocks. */
export interface SecretScanResult {
  readonly clean: boolean
  readonly findings: readonly SecretFinding[]
  /** Findings at or above the requested confidence that make `clean` false. */
  readonly blocked: readonly SecretFinding[]
}

/**
 * Render a secret unusable while still identifying it.
 *
 * Four characters is enough to tell two credentials apart in a report and far too
 * few to reconstruct one.
 * @param match - the matched credential text.
 * @returns the identifying prefix and length, never usable as the secret.
 */
export function redactSecret(match: string): string {
  const head = match.slice(0, 4)
  return `${head}…(${match.length} chars)`
}

const compiled = new Map<string, RegExp>()

/**
 * The compiled regex for one rule under one flag set.
 *
 * Keyed by both, because {@link TRANSPORT_SHAPE_RULES} are compiled
 * case-insensitively while the curated rules are not, so the same rule id can
 * legitimately be needed twice.
 */
function ruleRegex(rule: SecretRule, flags: string): RegExp {
  const key = `${flags}:${rule.id}`
  const existing = compiled.get(key)
  if (existing !== undefined) return existing
  // Global so one pass finds every occurrence; a fresh state per scan is why the
  // regex is cloned rather than reused with lastIndex bookkeeping.
  const regex = new RegExp(rule.source, flags)
  compiled.set(key, regex)
  return regex
}

/** Every finding one rule list produces, ordered by position then rule id. */
function findingsIn(text: string, rules: readonly SecretRule[], flags: string, skip: ReadonlySet<string>): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const rule of rules) {
    if (skip.has(rule.id)) continue
    const regex = ruleRegex(rule, flags)
    regex.lastIndex = 0
    for (const match of text.matchAll(regex)) {
      if (match.index === undefined || match[0] === '') continue
      findings.push({
        ruleId: rule.id,
        confidence: rule.confidence,
        index: match.index,
        length: match[0].length,
        redacted: redactSecret(match[0]),
        ...(rule.marker === undefined ? {} : { marker: rule.marker }),
      })
    }
  }
  findings.sort((left, right) => left.index - right.index || left.ruleId.localeCompare(right.ruleId))
  return findings
}

/** Knobs for one scan: the blocking threshold and rules to skip. */
export interface SecretScanOptions {
  /** Lowest confidence that counts as blocking. Defaults to `high`. */
  readonly minimumConfidence?: SecretConfidence
  /** Rules to skip, by id, for a caller that has already accepted a shape. */
  readonly allowRules?: readonly string[]
}

const RANK: Readonly<Record<SecretConfidence, number>> = { high: 2, medium: 1 }

/**
 * Scan text for credentials.
 *
 * Overlapping matches from different rules are reported once each — an AWS key
 * inside a PEM blob is two real findings, not a duplicate — but a rule never
 * reports the same span twice.
 * @param text - the text to scan.
 * @param options - the confidence threshold and rules to skip.
 * @returns the secret Scan Result.
 */
export function scanForSecrets(text: string, options: SecretScanOptions = {}): SecretScanResult {
  const minimum = options.minimumConfidence ?? 'high'
  const findings = findingsIn(text, SECRET_RULES, 'g', new Set(options.allowRules ?? []))
  const blocked = findings.filter(finding => RANK[finding.confidence] >= RANK[minimum])
  return { clean: blocked.length === 0, findings, blocked }
}

/**
 * Replace every reported credential with a marker.
 *
 * Replacements run last-to-first so earlier indices stay valid, which is also why
 * the findings carry their own index and length instead of a match object.
 *
 * Overlapping findings are merged before anything is spliced. Two rules can match
 * the same bytes — a credential inside a base64 blob is two real findings, which
 * `scanForSecrets` reports on purpose — and splicing them independently rewrites
 * the same offset twice, cutting a range that belongs to neither rule and leaving
 * part of a credential in the output.
 *
 * A finding may name its own marker, which is how a rule that moved here from a
 * private chain keeps the text that chain wrote. A merged span keeps the marker
 * of the range that starts first, because that is the range a reader would say
 * the span "is": `Bearer ghp_…` is a bearer credential that happens to carry a
 * vendor key, not the other way round.
 * @param text - the text to redact.
 * @param findings - the findings whose spans to replace.
 * @param marker - the fallback marker for findings that name none.
 * @returns the text with every reported credential replaced.
 */
export function redactSecretSpans(text: string, findings: readonly SecretFinding[], marker = '[redacted credential]'): string {
  const ranges = findings
    .map(finding => ({ start: finding.index, end: finding.index + finding.length, marker: finding.marker ?? marker }))
    .filter(range => range.end > range.start && range.start >= 0)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: { start: number; end: number; marker: string }[] = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  let result = text
  for (const range of merged.reverse()) {
    result = `${result.slice(0, range.start)}${range.marker}${result.slice(range.end)}`
  }
  return result
}

/** One-line summary for a log line or a memory-write refusal message.
 * @param findings - the findings to summarize.
 * @returns the one-line summary, safe to log.
 */
export function describeSecretFindings(findings: readonly SecretFinding[]): string {
  if (findings.length === 0) return 'no credential-shaped content found'
  const rules = [...new Set(findings.map(finding => finding.ruleId))].sort()
  return `${findings.length} credential-shaped match(es) for rule(s) ${rules.join(', ')}`
}

/**
 * The config-shaped detector: a credential written down next to the word that
 * announces it.
 *
 * A *different job* from {@link SECRET_RULES}, and the reason it is a second
 * pattern rather than more rules. The curated list deliberately omits
 * keyword-context matching, because `token: …` in prose is the classic false
 * positive; and the whole point of that list is that a match is a credential. But
 * an asset or a memory entry whose text *is* `api_key = "…"` is a credential
 * written down, which no prefix rule sees. So the gate callers use "either", and
 * each half keeps its documented tradeoff:
 *
 * - this pattern is broad: `api_key`, `authorization`, `password`, `token`, a PEM
 *   header, and a bare `sk-` key of 20+ lowercase characters. It can fire on prose,
 *   which is why nothing uses it as a *finding*
 * - {@link SECRET_RULES} is narrow: every match names a vendor. It misses a
 *   credential with no distinctive prefix.
 *
 * The `sk-` alternative lives here as well as in the curated rules because a 20-31
 * character key sits below that rule's 32-character floor, and both gates that used
 * to own private copies of this pattern refused that shape.
 */
// Assembled from parts so no single source line is longer than the style budget
// allows; the expression itself is unchanged, and each alternative is one line of
// the reason it is here.
export const KEYWORD_SECRET_PATTERN = new RegExp(
  '(?:-----BEGIN [A-Z ]*PRIVATE KEY-----'
  + '|(?:sk-[a-z0-9]{20,}'
  + "|(?:api[_-]?key|authorization|password|token)\\s*[:=]\\s*['\"]?[a-z0-9_./+=-]{16,}))",
  'i',
)

/**
 * Whether text carries a credential by either detector.
 *
 * The gate for content that is about to be written somewhere, and the one call
 * every non-tiered surface makes. Before it existed, two surfaces each held a
 * private copy of {@link KEYWORD_SECRET_PATTERN} — and the external-asset audit's
 * copy had lost the `sk-` alternative the memory writer's kept — while neither
 * consulted {@link SECRET_RULES} at all. Measured on the twelve shapes in
 * `secret-scan.spec.ts`: a community skill containing an Anthropic key, a GitHub
 * PAT, an AWS access key, a Slack token, a GitLab PAT, an npm token or a Google API
 * key passed the audit that exists to stop exactly that, while the memory writer
 * refused every one of them.
 *
 * The curated half is asked at `high`, deliberately: a refusal should be a
 * credential, not a shape that might be an identifier. The keyword half is broad
 * because a written-down key with no vendor prefix has no other way of being seen.
 * @param text - the text about to be persisted or shared.
 * @returns true when either detector matches.
 */
export function containsSecret(text: string): boolean {
  return KEYWORD_SECRET_PATTERN.test(text) || scanForSecrets(text).blocked.length > 0
}

/** No rule is skipped for the transport shapes; they have no opt-out. */
const EMPTY_RULES: ReadonlySet<string> = new Set()

/**
 * Mask every credential shape in text, for the helpers that scrub upstream text
 * before it is shown, logged or persisted.
 *
 * This asks at `medium` while {@link containsSecret} asks at `high`, and the
 * asymmetry is the direction of the cost: a mask that fires on a shape which is only
 * probably a credential costs one redacted word, while a shape that survives costs a
 * live token in a transcript.
 *
 * Two rule lists are unioned here, and the second one is the reason this function
 * is the single owner of "what a credential looks like on its way out".
 * {@link SECRET_RULES} is the curated vendor-prefix list;
 * {@link TRANSPORT_SHAPE_RULES} is the prefix-less half — a bearer token, a URL's
 * userinfo, a labelled `access_token` — that four surfaces used to each
 * reimplement locally. Unioning them here is what makes adding a shape once
 * cover every exit: before this, a shape added to `media-utils.ts` was still
 * invisible to the account surface, the provider adapters and the media
 * generator, and the drift between the copies was already measurable.
 * @param text - the text to scrub.
 * @param marker - what each credential shape is replaced with, unless the rule
 *   that matched names a marker of its own.
 * @returns the text with every credential shape masked.
 */
export function redactCredentialShapes(text: string, marker = '[redacted credential]'): string {
  const findings = [
    ...scanForSecrets(text, { minimumConfidence: 'medium' }).findings,
    ...findingsIn(text, TRANSPORT_SHAPE_RULES, 'gi', EMPTY_RULES),
  ]
  return redactSecretSpans(text, findings, marker)
}
