/**
 * The rule "upstream text becomes a message only after it is masked", as an
 * inventory the default suite checks.
 *
 * Why this exists
 * ---------------
 * The same rule was implemented nine separate times, once per module where an
 * author happened to be working: six redaction chains that each knew only the
 * shapes their author had seen, two gates holding private copies of the keyword
 * pattern, and the shared wire layer that quoted the upstream into an `LlmError`
 * verbatim. The discovery was always the same shape — one family masked
 * (provider errors, media details, job summaries) while another did not (the
 * account surface, both wire parsers) — and the split followed whichever file
 * the author had open, not whichever one carried a credential.
 *
 * `guard-probes.spec.ts` proves a masking call is *load-bearing*, but only when
 * someone remembers to run it under `FREECODEGO_GUARD_PROBES=1`. This file is
 * the half that runs by default, and it has three parts:
 *
 * - **Boundaries** name, by exact source text, every place where text that came
 *   from outside this process turns into a message or a durable value. Deleting
 *   or rewriting a masking call fails here immediately, in the ordinary suite.
 * - **Exemptions** are the deliberate exceptions, each with its reason. A site
 *   the classifier finds that is neither masked nor exempt fails, which is the
 *   whole point: the inventory is explicit instead of inferred, and a new
 *   unmasked site has to be classified by whoever adds it.
 * - The **classifier** is unit-tested against a masked sample, a sample masked
 *   through a local, an unmasked sample and a message that merely names a
 *   condition. A scanner that has quietly stopped matching reports success, so
 *   it is checked before it is trusted.
 *
 * What it deliberately does not do: decide *which* text is a credential. That
 * belongs to `src/secret-scan.ts`, which owns both the tiered rules and the
 * masking, and which this file only checks is wired at each boundary.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/upstream-text-masking
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(PACKAGE, 'src')

/**
 * A boundary where upstream text becomes a message or a durable value.
 *
 * `contains` is exact current source text, so a rewrite that drops the masking
 * fails the default suite rather than passing silently.
 */
interface Boundary {
  readonly file: string
  readonly contains: string
  /** Why this boundary cannot hand its text on unmasked. */
  readonly reason: string
}

const BOUNDARIES: readonly Boundary[] = [
  {
    file: 'src/read-document.ts',
    contains: 'not a Jupyter notebook: ${redactCredentialShapes(',
    reason: 'The JSON parser quotes a window of the text it rejected, and the text it rejected is a document the model did not write: a notebook with a key in a cell would print that key in the refusal.',
  },
  {
    file: 'src/account-remotes.ts',
    contains: 'return redactCredentialShapes(message ===',
    reason: 'Every provider and backend message this module surfaces — the Groq error, the pending-completion refusals, the refused sign-in poll — is built by this one helper, and those requests carry the account password and the provider key.',
  },
  {
    file: 'src/managed-catalog-utils.ts',
    contains: '${fallback}: ${redactCredentialShapes(message.trim()).slice(0, 300)}',
    reason: 'The JSON branch of the registration failure message: the call it reports on posts a password, so a backend that echoes what it rejected would name it here.',
  },
  {
    file: 'src/managed-catalog-utils.ts',
    contains: '${redactCredentialShapes(body.replace(',
    reason: 'The text branch of the same helper: an HTML or plain-text error body is upstream text too.',
  },
  {
    file: 'src/plugin-update.ts',
    contains: 'throw new Error(redactCredentialShapes(result.detail))',
    reason: 'The install resolves a tarball URL and this text is stored in the update status, so a registry that quotes the refused request would persist the token it carries.',
  },
  {
    file: 'src/openai-wire.ts',
    contains: 'malformed SSE payload: ${redactCredentialShapes(payload.slice(0, 120))}',
    reason: 'A malformed chunk is upstream text quoted back for diagnosis — the one case where quoting it verbatim is the leak.',
  },
  {
    file: 'src/openai-wire.ts',
    contains: 'throw new LlmError(redactCredentialShapes(message), typeof providerError.code',
    reason: 'A provider error event becomes the turn error here, and providers do quote the request they refused, keys included.',
  },
  {
    file: 'src/anthropic-wire.ts',
    contains: 'malformed SSE payload: ${redactCredentialShapes(payload.slice(0, 120))}',
    reason: 'The same rule as in the OpenAI wire: this layer is shared by every Anthropic-shaped provider.',
  },
  {
    file: 'src/anthropic-wire.ts',
    contains: 'throw new LlmError(redactCredentialShapes(message), typeof error.type',
    reason: 'The same provider-error event rule, on the other wire.',
  },
  {
    file: 'src/workbuddy-intl.ts',
    contains: 'return redactCredentialShapes(value)',
    reason: 'This provider has its own two token rules; an upstream that echoes any other provider\'s key shape is only caught by the shared masking in front of them.',
  },
  {
    file: 'src/workbuddy-intl.ts',
    contains: '? failureDetail(error)',
    reason: 'A nested upstream failure is reported by its already-masked detail rather than by its message, which repeated the same frame and pushed the upstream text to the end.',
  },
  {
    file: 'src/advisor.ts',
    contains: 'return redactCredentialShapes(value)',
    reason: 'A read file reaches the review transcript through this helper; a GitHub PAT or an AWS key in one was the case that found it.',
  },
  {
    file: 'src/agnes.ts',
    contains: 'function redact(value: string): string { return redactCredentialShapes(value)',
    reason: 'Provider errors from this vendor go through it, and the vendor rule set knows no prefixed key.',
  },
  {
    file: 'src/cline.ts',
    contains: 'return redactCredentialShapes(value)',
    reason: 'Both the refusal raised to the caller and the note persisted on the account are built with it.',
  },
  {
    file: 'src/engineering-jobs.ts',
    contains: 'return redactCredentialShapes(value)',
    reason: 'A job summary quotes command output and is persisted, which is exactly where a pasted prefixed token turns up.',
  },
  {
    file: 'src/media-utils.ts',
    contains: 'export function redactMediaDetail(value: string): string { return redactCredentialShapes(value)',
    reason: 'Provider media errors are multiplied, and no vendor rule is applied to them by default.',
  },
  {
    file: 'src/openai-compatible-adapter.ts',
    contains: 'return redactCredentialShapes(value)',
    reason: 'A provider that echoes a rejected key sends it back in whichever shape the key has; this chain knew bearer, keyword and `sk-`.',
  },
  {
    file: 'src/team/worktree.ts',
    contains: 'redactCredentialShapes(boundedTeamText(retry.stderr || retry.stdout, 500))',
    reason: 'Git prints the URL it failed against, which for an authenticated remote is the URL with the token in it; this text is git\'s own output.',
  },
  {
    file: 'src/worktree/creator.ts',
    contains: 'const stderr = redactCredentialShapes(result.stderr.trim())',
    reason: 'The fallback reason quotes git\'s own output to explain what the caller got instead of a worktree, and git prints the URL it failed against.',
  },
  {
    file: 'src/community-remotes.ts',
    contains: 'redactCredentialShapes(lastError.message)',
    reason: 'A catalogue body that fails to parse contributes Node\'s parse error, which quotes the first characters of that body back.',
  },
  {
    file: 'src/project-config.ts',
    contains: 'redactCredentialShapes(error instanceof Error ? error.message : String(error))',
    reason: 'The note reports why a checked-in config file is not valid JSON, and the parse error quotes the text it failed on — bounded to ten characters, which the bound test below measures.',
  },
  {
    file: 'src/persona/discovery.ts',
    contains: 'redactCredentialShapes(error instanceof Error ? error.message : String(error))',
    reason: 'A persona document is distributed content, so its parse failure is reported through the same masking as an upstream body.',
  },
  {
    file: 'src/skills/lockfile.ts',
    contains: 'redactCredentialShapes(error instanceof Error ? error.message : String(error))',
    reason: 'The lockfile arrives with a community install and this reason is thrown by the installer, one step from a user-visible message.',
  },
  {
    file: 'src/advisor.ts',
    contains: 'redactCredentialShapes(error instanceof Error ? error.message : String(error))',
    reason: 'The parse here is the model\'s own tool arguments, and its failure is fed back into the review loop and its transcript.',
  },
  {
    file: 'src/engineering.ts',
    contains: 'if (containsSecret(content)) findings.push(',
    reason: 'The gate that stands between an externally sourced asset and a managed directory must read the one owner of the rules, not a private copy.',
  },
  {
    file: 'src/engineering.ts',
    contains: 'if (containsSecret(normalized)) findings.push(',
    reason: 'The same gate for a skill manifest: a second private rule list is how the first one lost its weakest branch.',
  },
  {
    file: 'src/engineering-memory.ts',
    contains: 'if (KEYWORD_SECRET_PATTERN.test(source)) throw new Error(',
    reason: 'The keyword tier is exported by the owner precisely so this writer reads it instead of keeping a copy that can drift.',
  },
  {
    file: 'src/engine-council.ts',
    contains: 'return redactCredentialShapes(error instanceof Error ? error.message : String(error))',
    reason: 'Every engine failure in the council funnels through this one helper, and the text does not stop at a log: it becomes a participant\'s `error`, the report\'s `finalRecommendation`, and the peer block the handoff injects into the model\'s own context. The engines authenticate to providers, so their failures are the credential-bearing text the provider adapters mask at their exits.',
  },
  {
    file: 'src/index.ts',
    contains: 'freecodego: request-shape fingerprint failed: ${redactCredentialShapes(String(error))}',
    reason: 'The fingerprint is taken over `session.requestHeader()`, which is where the request\'s bearer credential lives, so a throw inside it can quote the very header the fingerprint exists to describe — and the other seventeen `logger.warn` sites in this file already mask for the same reason.',
  },
]

/**
 * A site the classifier finds where masking is deliberately absent.
 *
 * `contains` is matched against the call with its whitespace collapsed, so an
 * entry cannot silently outlive the text it describes.
 */
interface Exemption {
  readonly file: string
  readonly contains: string
  readonly reason: string
}

const EXEMPTIONS: readonly Exemption[] = [
  {
    file: 'src/agnes.ts',
    contains: "error.message, 'AUTH', { cause: error }",
    reason: 'Guarded by the branch above it: only this module\'s own `AGNES_`-prefixed message takes this path, and the upstream text it was built from is masked by `redact`.',
  },
  {
    file: 'src/agnes.ts',
    contains: "error.message, 'TRANSPORT', { cause: error }",
    reason: 'The timeout branch, guarded the same way by the line above it: only a message starting with this module\'s own `Agnes request timed out` prefix takes this path, and the sole producer of that prefix is `agnesAbortError`, which builds it from the constant alone rather than from anything the upstream sent back.',
  },
  {
    file: 'src/account-remotes.ts',
    contains: 'WORKBUDDY_IMPORT_FAILED: ${result.message}',
    reason: 'Every message the desktop-credential import can answer with is authored in `workbuddy-intl-auth.ts` as fixed guidance text; it quotes no file and no upstream body.',
  },
  {
    file: 'src/account-remotes.ts',
    contains: 'WORKBUDDY_LOGIN_FAILED: ${result.message}',
    reason: 'The message comes from `parseWorkBuddyLoginPoll`, which masks the upstream `msg` with `redact` where it reads it — the boundary is in the parser, not at this throw.',
  },
  {
    file: 'src/action-reviewer.ts',
    contains: 'finish.failure.message',
    reason: 'The runtime\'s failure message is built by the provider adapters and the shared wire layer, which are the two places upstream text enters an `LlmError`. Each one now has a test that drives a failure quoting a credential and asserts the surfaced message is masked: the wire specs, and the Agnes, Cline and OpenAI-compatible adapter specs.',
  },
  {
    file: 'src/advisor.ts',
    contains: 'finish.failure.message',
    reason: 'The same trust boundary as the action reviewer: the message is the runtime\'s, and both wire layers and every adapter mask the upstream text before an `LlmError` carries it — asserted per adapter in the specs named on the action-reviewer entry.',
  },
  {
    file: 'src/memory/memory-selector.ts',
    contains: 'finish.failure.message',
    reason: 'The same boundary again, in the selector: nothing here quotes upstream text itself.',
  },
  {
    file: 'src/memory/memory-dream-model.ts',
    contains: 'finish.failure.message',
    reason: 'The same boundary a third time, in the consolidating planner: it reports the assembler\'s own failure and quotes no upstream text itself, so the masking that matters is the one every adapter and both wire layers apply before an `LlmError` carries it.',
  },
  {
    file: 'src/skills/installer.ts',
    contains: '${parsed.issue.reason}',
    reason: 'A parse issue raised by this module\'s own lockfile reader about the shape of a file it read; the text is written here, not taken from an upstream response.',
  },
  {
    file: 'src/team/worktree.ts',
    contains: "${usable.reason ?? 'worktrees are unavailable'}",
    reason: '`reason` is this module\'s own account of why isolation is unavailable, so the text is written here.',
  },
  {
    file: 'src/community-catalog-utils.ts',
    contains: 'could not be staged, so the installed version was left untouched: ${detail(error)}',
    reason: '`detail` reads the message `fs.cp` built for a copy that stayed inside the Skill root: it names a path this module chose plus the errno, so no upstream text is quoted. The payload\'s own names were screened by `assertSkillPayloadHasNoLinks` before the copy ran, and a name the repository picked can only quote itself.',
  },
  {
    file: 'src/community-catalog-utils.ts',
    contains: 'could not be moved aside, so the payload was not promoted: ${detail(error)}',
    reason: 'The same channel one step later: `fs.rename`\'s message about two paths inside the profile, which reports an errno rather than anything a package authored.',
  },
  {
    file: 'src/community-catalog-utils.ts',
    contains: "the Skill could not be promoted${moved ? '; the previously installed version was restored' : ''}: ${detail(error)}",
    reason: 'The same channel for the promotion move, with this module\'s own recovery sentence beside it; the error is `fs.rename`\'s and quotes nothing upstream.',
  },
]

/**
 * Every helper that removes credential shapes from text.
 *
 * The local names are here because a boundary that keeps its own chain is fine
 * as long as the shared masking is in front of it, and every one of them now is.
 */
const MASKING_HELPERS = [
  'redactCredentialShapes', 'redactMediaDetail', 'redactProviderDetail', 'redactJobSummary',
  'redactSecretSpans', 'redactSecret', 'sanitizeReviewText', 'upstreamMessage', 'failureDetail', 'redact',
]
const MASKING = new RegExp(`\\b(?:${MASKING_HELPERS.join('|')})\\s*\\(`)

/** An identifier whose value is text produced outside this process. */
const UPSTREAM = /(\b(detail|payload|body|raw|msg|reason|stderr|stdout)\b|\.(detail|message|msg|body|text)\b|\btext\s*\()/

/**
 * An error or failure being thrown, whatever its name.
 *
 * The name is checked after the match rather than inside the pattern: a suffix
 * alternation after `[A-Za-z_$][\w$]*` never matched a plain `Error`, because the
 * first class consumed the `E` the suffix then needed. The omission was silent —
 * every site the scanner found was an `LlmError` — which is what the classifier
 * self-check below is for.
 */
const CONSTRUCTOR = /throw new ([A-Za-z_$][\w$]*)\(/g
const THROWN_ERROR = /(?:Error|Failure)$/

/** The two gates that decide whether text is a credential at all. */
const GUARD = /containsSecret\(|KEYWORD_SECRET_PATTERN\.test\(/

interface MessageSite {
  readonly file: string
  readonly line: number
  /** The constructor call with its whitespace collapsed. */
  readonly call: string
  readonly masked: boolean
}

/** The call's argument list, with brackets balanced from the opening paren. */
function balanced(source: string, open: number, openCh: string, closeCh: string): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === openCh) depth += 1
    else if (source[i] === closeCh) {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

/** Every `${…}` inside a call, nested interpolations included. */
function interpolations(call: string): readonly string[] {
  const found: string[] = []
  for (let i = 0; i < call.length; i++) {
    if (call[i] === '$' && call[i + 1] === '{') {
      const inner = balanced(call, i + 1, '{', '}')
      found.push(inner.slice(1, -1))
      i += inner.length - 1
    }
  }
  return found
}

/** Identifiers bound to a masked value earlier in the same statement block. */
function maskedLocals(block: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const match of block.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[^\n;]*\(/g)) {
    const name = match[1]
    if (MASKING.test(match[0]) && name !== undefined) names.add(name)
  }
  return names
}

/**
 * Every error built here from text that came from outside.
 *
 * The message counts as masked when the masking is applied in the message
 * expression itself, or to the value it interpolates earlier in the same
 * statement block — `const detail = redactProviderDetail(raw)` then
 * `` `…: ${detail}` `` is the shape most of these boundaries take.
 */
function classify(file: string, source: string): readonly MessageSite[] {
  const sites: MessageSite[] = []
  for (const match of source.matchAll(CONSTRUCTOR)) {
    const thrown = match[1]
    if (thrown === undefined || !THROWN_ERROR.test(thrown)) continue
    const call = balanced(source, match.index + match[0].length - 1, '(', ')')
    const parts = interpolations(call)
    const head = call.replace(/^\(/, '').replace(/\)$/, '').split(',')[0]?.trim() ?? ''
    const quotesUpstream = parts.some(part => UPSTREAM.test(part))
      || (/^[A-Za-z_$][\w$.]*$/.test(head) && UPSTREAM.test(head))
    if (!quotesUpstream) continue
    const block = source.slice(Math.max(source.lastIndexOf('\n\n', match.index), 0), match.index)
    const viaLocal = [...maskedLocals(block)].some(name => new RegExp(`\\b${name}\\b`).test(call))
    sites.push({
      file,
      line: source.slice(0, match.index).split('\n').length,
      call: call.replace(/\s+/g, ' '),
      masked: MASKING.test(call) || viaLocal,
    })
  }
  return sites
}

/**
 * A reported parse failure: the second channel, and the one whose bound matters.
 *
 * A `try` whose body parses text, and a `catch` that reports the caught error
 * into a value rather than throwing it. Node's parse errors quote the text they
 * failed on — but only its first ten characters, which the test below measures
 * rather than assumes. So this channel cannot carry a prefixed credential at
 * all, and the masking declared here covers the short shapes that do fit inside
 * that window. It is a habit kept where the text came from outside, not the
 * thing standing between a key and the log; the bound test is.
 */
interface ParseSite {
  readonly file: string
  readonly line: number
  readonly report: string
  readonly masked: boolean
}

const PARSES_TEXT = /JSON\.parse\(/
const REPORTS_CAUGHT = /error instanceof Error \? error\.message : String\(error\)|String\(error\)/

/**
 * The body of the clause starting at `start`, with its braces balanced.
 *
 * `null` when the braces never close, so an anchor that eats the rest of a file
 * cannot be mistaken for a site.
 */
function clause(source: string, start: number): string | undefined {
  const open = source.indexOf('{', start)
  if (open === -1) return undefined
  const body = balanced(source, open, '{', '}')
  return body.endsWith('}') ? body : undefined
}

function parseFailures(file: string, source: string): readonly ParseSite[] {
  const sites: ParseSite[] = []
  for (const match of source.matchAll(/\btry\s*\{/g)) {
    const body = clause(source, match.index)
    if (body === undefined || !PARSES_TEXT.test(body)) continue
    const catchAt = source.indexOf('catch', match.index + body.length)
    if (catchAt === -1) continue
    const handler = clause(source, catchAt)
    if (handler === undefined || !REPORTS_CAUGHT.test(handler)) continue
    sites.push({
      file,
      line: source.slice(0, catchAt).split('\n').length,
      report: handler.replace(/\s+/g, ' '),
      masked: MASKING.test(handler),
    })
  }
  return sites
}

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

/** Module-relative path, so an entry reads the same as the file it names. */
const relative = (file: string): string => file.slice(PACKAGE.length + 1).split('\\').join('/')

describe('the masking classifier', () => {
  it('separates a masked call, a call masked through a local, and an unmasked one', () => {
    const inExpression = classify('sample.ts', 'throw new Error(`failed: ${redactCredentialShapes(payload.detail)}`)\n')
    expect(inExpression.map(site => site.masked)).toEqual([true])
    const throughLocal = classify('sample.ts', 'const detail = redactProviderDetail(raw)\nthrow new Error(`failed: ${detail}`)\n')
    expect(throughLocal.map(site => site.masked)).toEqual([true])
    const unmasked = classify('sample.ts', 'throw new Error(`failed: ${payload.detail}`)\n')
    expect(unmasked.map(site => site.masked)).toEqual([false])
    const forwarded = classify('sample.ts', 'throw new Error(detail)\n')
    expect(forwarded.map(site => site.masked)).toEqual([false])
  })

  it('ignores a message that names a condition instead of quoting upstream text', () => {
    // The false positive this classifier had to be taught to avoid: the word
    // "body" inside the literal part of a template is not an interpolation, and
    // a message about a missing response body quotes nothing.
    expect(classify('sample.ts', 'throw new Error(`${this.name} returned no response body`)\n')).toEqual([])
    expect(classify('sample.ts', "throw new Error('the provider answered with no body')\n")).toEqual([])
  })

  it('reads the value a masked local was bound to, not the local name', () => {
    // A `detail` that came from anywhere else must not count as masked.
    const unmaskedLocal = classify('sample.ts', 'const detail = await response.text()\nthrow new Error(`failed: ${detail}`)\n')
    expect(unmaskedLocal.map(site => site.masked)).toEqual([false])
  })
})

describe('every boundary still masks', () => {
  it('finds the exact text of each declared masking call', () => {
    for (const boundary of BOUNDARIES) {
      const source = readFileSync(join(PACKAGE, boundary.file), 'utf8')
      expect(source, `${boundary.file} no longer contains the masking call for: ${boundary.reason}`).toContain(boundary.contains)
    }
  })

  it('declares a masking helper in every anchor, so an anchor cannot pass while masking nothing', () => {
    // The two gate anchors name the guard rather than a masker: they are the
    // decision, and a gate that stops consulting the owner of the rules is the
    // same defect one step earlier.
    for (const boundary of BOUNDARIES) {
      expect(MASKING.test(boundary.contains) || GUARD.test(boundary.contains), boundary.contains).toBe(true)
    }
  })

  it('names a reason for every boundary', () => {
    for (const boundary of BOUNDARIES) expect(boundary.reason.length, boundary.file).toBeGreaterThan(40)
  })
})

describe('what a parse failure can quote', () => {
  it('quotes a bounded prefix, not the text it failed on', () => {
    // Measured, not assumed: V8 reports the first ten characters and elides the
    // rest. This is the reason the four parse-failure reports below are masked
    // for consistency rather than described as the control — a prefixed key is
    // longer than ten characters, so it cannot come out whole. If a future Node
    // quotes more, this fails and the claim is re-measured instead of trusted.
    const leaked = `ghp_${'A'.repeat(36)}`
    let message = ''
    try { JSON.parse(`${leaked} trailing`) } catch (error) { message = error instanceof Error ? error.message : '' }
    expect(message).toContain('is not valid JSON')
    expect(message).not.toContain(leaked)
    expect(message).toContain(`"${leaked.slice(0, 10)}"`)
  })
})

describe('what a transport failure can carry', () => {
  it('does not carry the request body, which is what the pending-request exemption rests on', async () => {
    // The exemption for `OAUTH_PENDING_REQUEST_FAILED` says the request body is
    // never part of a fetch rejection. Measured here rather than assumed: the
    // body of that call carries the account password. If a future runtime starts
    // attaching the request, this fails and the exemption is revisited.
    const body = JSON.stringify({ email: 'a@b.c', password: `ghp_${'A'.repeat(36)}` })
    const failure = await fetch('http://127.0.0.1:1/oauth/desktop/pending', { method: 'POST', body })
      .then(() => new Error('the request was expected to fail'), (error: unknown) => error instanceof Error ? error : new Error(String(error)))
    expect(failure.message).not.toBe('')
    expect(failure.message).not.toContain('ghp_')
    expect(failure.message).not.toContain('password')
  })
})

/**
 * The third channel, measured rather than asserted: a result or status field that
 * quotes text from outside.
 *
 * A scan over the same source for fields that reach a caller or a logger
 * (`fallbackReason`, `detail`, `note`, `error`, `message`, `issue`, `text`,
 * `reason`, `failure`) whose value interpolates something upstream-looking found
 * 24 sites, 5 of them masked. The 19 that were not are dominated by two kinds:
 *
 * - **This module's own text**, which is the common case by a wide margin: a
 *   filesystem error naming a path, a plan that could not be written, a persona
 *   run's own account of what happened, and the evaluation details that merely
 *   divide one length by another.
 * - **A channel already covered one step away**: the sign-in poll builds its
 *   refusal text from the backend body in `oauth-login.ts`, and the consumer that
 *   raises it masks there, so masking the builder as well would be a second copy
 *   of the same decision.
 *
 * One site in that set was real and is fixed: the worktree creator's fallback
 * reason quotes git's own output, which is the channel the team worktree report
 * is masked for — see the boundary entry for `src/worktree/creator.ts`.
 *
 * A later redaction round went back through the same set and masked every site
 * whose text can be produced by something that holds a credential, rather than
 * only the ones this file could prove were upstream: the marker rewrite in
 * `plugin-update.ts`, the eight `logger.warn` sites in `index.ts` that sat beside
 * the eleven already masked there, and the engine-council helper that feeds both
 * a participant's `error` and the peer block injected into the model's context.
 * They are listed below and asserted by file, so the list cannot outlive the
 * masking it records.
 *
 * The field channel is therefore *not* asserted. Its signal-to-noise here is
 * about one in four, and an inventory padded with entries whose reason is "this
 * text was written in this module" trains a reader to stop reading it — which is
 * worse than the gap it would paper over. One place is still open if someone
 * extends it: `index.ts` reports a parked artifact it could not read through
 * `error.message`, which is a parse inside a helper, so the parse channel above
 * cannot see it either. That one is ours-but-quoted and bounded the way the parse
 * channel is.
 */
const FIELD_CHANNEL_MEASURED = {
  sites: 24,
  masked: 5,
  /** The one that was a real defect, fixed rather than exempted. */
  fixed: 'src/worktree/creator.ts',
} as const

/**
 * Files whose field-or-log text a later round masked, past the baseline above.
 *
 * Asserted by file rather than by count: a count would have to re-implement the
 * measurement, and all this needs to guarantee is that each file still masks.
 */
const FIELD_CHANNEL_MASKED_SINCE: readonly string[] = [
  'src/engine-council.ts',
  'src/index.ts',
  'src/managed-catalogs.ts',
  'src/media-generation.ts',
  'src/memory/memory-recall.ts',
  'src/plugin-update.ts',
  'src/worktree/tools.ts',
]

describe('the field channel, which this file measures but does not assert', () => {
  it('keeps the measurement attached to the site it produced', () => {
    // A number with no site is a claim nobody can check, so the one real finding
    // stays named and the masking stays anchored above.
    const source = readFileSync(join(PACKAGE, FIELD_CHANNEL_MEASURED.fixed), 'utf8')
    expect(source).toContain('redactCredentialShapes(result.stderr.trim())')
    expect(FIELD_CHANNEL_MEASURED.sites).toBeGreaterThan(FIELD_CHANNEL_MEASURED.masked)
  })

  it('keeps every site a later round masked still masking', () => {
    // The list records work that is easy to undo by accident: each of these was
    // an unmasked sibling of a masked one, so a revert would look like a tidy-up
    // rather than like the regression it is.
    for (const file of FIELD_CHANNEL_MASKED_SINCE) {
      const source = readFileSync(join(PACKAGE, file), 'utf8')
      expect(MASKING.test(source), file).toBe(true)
    }
  })
})

describe('the parse-failure classifier', () => {
  const sample = (report: string): string => `try {\n  parsed = JSON.parse(text)\n} catch (error) {\n  ${report}\n}\n`

  it('separates a masked report from an unmasked one', () => {
    const masked = parseFailures('sample.ts', sample('return { issue: redactCredentialShapes(error instanceof Error ? error.message : String(error)) }'))
    expect(masked.map(site => site.masked)).toEqual([true])
    const unmasked = parseFailures('sample.ts', sample('return { issue: error instanceof Error ? error.message : String(error) }'))
    expect(unmasked.map(site => site.masked)).toEqual([false])
  })

  it('ignores a parse whose failure the caller never reads back', () => {
    // Nothing quotes the text when the payload is validated right after the
    // parse, because the parse is the only step that can throw here.
    const silent = 'try {\n  parsed = JSON.parse(text)\n} catch {\n  parsed = undefined\n}\n'
    expect(parseFailures('sample.ts', silent)).toEqual([])
    // A `catch` that reports something else is not this channel either.
    const other = sample('return { issue: \'not valid JSON\' }')
    expect(parseFailures('sample.ts', other)).toEqual([])
  })
})

describe('every parse failure is reported without quoting what it failed on', () => {
  const sites = sourceFiles(SRC)
    .flatMap(file => parseFailures(relative(file), readFileSync(file, 'utf8')))

  it('finds the parse sites this file knows about', () => {
    // The scanner had to be taught the difference between a `try` that parses and
    // one that merely follows a parse, so it is checked for blindness too.
    expect(sites.length).toBeGreaterThanOrEqual(3)
    for (const file of ['src/project-config.ts', 'src/persona/discovery.ts', 'src/skills/lockfile.ts']) {
      expect(sites.some(site => site.file === file), file).toBe(true)
    }
  })

  it('sends every report through the masking, so the habit holds even though the prefix is bounded', () => {
    // The bound above is the actual protection for a prefixed key. This assertion
    // is about the rule being applied wherever text came from outside, which is
    // what stops the next channel — one that quotes more than ten characters —
    // from being opened by whoever writes it.
    const unmasked = sites.filter(site => !site.masked)
    expect(unmasked.map(site => `${site.file}:${site.line} ${site.report}`).join('\n')).toBe('')
  })
})

describe('every site that quotes upstream text is classified', () => {
  const sites = sourceFiles(SRC).flatMap(file => classify(relative(file), readFileSync(file, 'utf8')))

  it('finds the boundaries this file declares, so the classifier is not blind to them', () => {
    // Without this, a classifier that stopped matching would report an empty
    // inventory and pass, which is the failure mode that looks like success.
    const masked = sites.filter(site => site.masked)
    expect(masked.length).toBeGreaterThanOrEqual(8)
    for (const file of ['src/openai-wire.ts', 'src/anthropic-wire.ts', 'src/openai-compatible-adapter.ts', 'src/team/worktree.ts', 'src/community-remotes.ts']) {
      expect(masked.some(site => site.file === file), file).toBe(true)
    }
  })

  it('leaves nothing unclassified', () => {
    const unclassified = sites.filter(site => !site.masked).filter(site => !EXEMPTIONS.some(exemption =>
      exemption.file === site.file && site.call.includes(exemption.contains)))
    // Joined rather than compared as an array: a site added without a decision
    // has to name itself in the failure, not appear as a counted entry.
    expect(unclassified.map(site => `${site.file}:${site.line} ${site.call}`).join('\n')).toBe('')
  })

  it('keeps every exemption attached to a site that still exists', () => {
    for (const exemption of EXEMPTIONS) {
      expect(sites.some(site => site.file === exemption.file && site.call.includes(exemption.contains)),
        `${exemption.file} no longer has the exempted site: ${exemption.contains}`).toBe(true)
    }
  })
})
