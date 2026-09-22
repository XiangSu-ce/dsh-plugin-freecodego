/**
 * One declaration for how this plugin reads an untrusted body and how it reads a
 * failed upstream status.
 *
 * Why
 * ---
 * Both facts were copied rather than shared, and in both cases a copy had already
 * drifted before anyone counted:
 *
 * - The plain-object test was declared **eighteen times in seventeen files** under
 *   six names, with two different defaults — and the copies that disagreed were the
 *   ones nobody read twice.
 * - The status → `LlmError` code ladder was written out four times, and the copy in
 *   the **generic gateway adapter** mapped `403` to `AUTH`, so the route most turns
 *   take told a user their key was invalid over a plan gate. That ladder had no test
 *   at all; the two providers that *were* tested were the two that agreed.
 *
 * Behaviour alone cannot hold either fact down: two copies that agree produce
 * identical output, so only the day someone edits one of them can any assertion
 * tell them apart. So the first half of this gate reads the **source** — the
 * declaration exists once, the callers call it, and the two known exceptions are
 * named rather than tolerated — and the second half pins the **behaviour** the
 * shared table promises, including on the two paths that had none: the gateway's
 * status ladder and its `403`.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/upstream-contract-single-source
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError, MessageId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { OpenAiCompatibleAdapter } from '../src/openai-compatible-adapter.ts'
import { asNumber, asRecord, asString, isRecord, maybeRecord } from '../src/untrusted-json.ts'
import { llmCodeForUpstreamStatus, upstreamStatusCategory } from '../src/upstream-status-code.ts'
import { sourceFiles } from './support/source-files.ts'

/** The module allowed to declare the plain-object test. */
const COERCION_MODULE = 'untrusted-json.ts'

/** The module allowed to decide what a failed status means. */
const STATUS_MODULE = 'upstream-status-code.ts'

/** The one predicate, in the two operand orders the copies had drifted into. */
const PREDICATE_FORMS = [
  "typeof value === 'object' && value !== null && !Array.isArray(value)",
  "value !== null && typeof value === 'object' && !Array.isArray(value)",
]

/**
 * Modules where the predicate reads in a branch rather than a declaration, so the
 * gate can keep the list exactly as long as the reason for each entry.
 */
const INLINE_PREDICATE_USES: readonly { readonly path: string; readonly reason: string }[] = [
  {
    path: 'engine-council.ts',
    reason: 'narrows to `Partial<CouncilSettings>`, a type of its own; a record of `unknown` would need the cast this module removes',
  },
  {
    path: 'headroom/smart-crusher.ts',
    reason: 'tests a `JsonValue` and hands it straight back to a `JsonValue` field',
  },
]

/** Every provider whose failure path must report the shared code. */
const STATUS_CONSUMERS = [
  'agnes.ts',
  'cline.ts',
  'openai-compatible-adapter.ts',
  'workbuddy-intl.ts',
]

/** Source with comments removed: a gate that counts prose reports the comment explaining it. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|\s)\/\/[^\n]*/gu, '$1 ')
}

/** A comparison against a status, in the shapes a ladder is written in. */
const STATUS_COMPARISON = /status\s*(?:===|==)\s*(?:401|402|403|429)|status\s*>=\s*5\d\d/gu

/** The `LlmError` codes a ladder yields, as source text. */
const CODE_LITERALS = [/'AUTH'/u, /'RATE_LIMIT'/u, /'SERVER'/u]

/**
 * Whether source decides an error code from a status anywhere but the shared table.
 *
 * Read on collapsed text with a window rather than line by line, because a ladder is
 * written wrapped: the adapter's drifted copy put `status === 401` and `'AUTH'`
 * fifty characters apart on two different lines, and a line-oriented check would
 * have called that clean.
 */
function decidesCodeFromStatus(text: string): boolean {
  const collapsed = codeOnly(text).replace(/\s+/gu, ' ')
  for (const match of collapsed.matchAll(STATUS_COMPARISON)) {
    const at = match.index ?? 0
    const window = collapsed.slice(Math.max(0, at - 160), at + 160)
    if (CODE_LITERALS.some(literal => literal.test(window))) return true
  }
  return false
}

/** The module that answers in the error-kind vocabulary. */
const KIND_MODULE = 'provider-error-classify.ts'

/**
 * The kinds that module answers in: the vocabulary a status must not be turned into
 * anywhere else, because the kind decides what the client is told.
 */
const ERROR_KINDS = [
  'rate-limit', 'overloaded', 'auth', 'quota', 'context-overflow',
  'timeout', 'cancelled', 'content', 'invalid-request', 'unknown',
] as const

/** A kind named anywhere, to be judged as a decision or as a comparison by position. */
const KIND_LITERAL_SOURCE = `'(?:${ERROR_KINDS.join('|')})'`

/**
 * Whether a piece of text answers a status with a kind, as opposed to reading one.
 *
 * The distinction is the whole point: `upstreamStatusCategory(status) === 'quota'` reads
 * the shared table and is what this gate wants, while `verdict('quota', …)` and a ternary's
 * `? 'quota'` answer a status by themselves. So a kind counts as a decision unless it is the
 * right-hand side of a comparison or a `case` label — the two spellings that read a
 * vocabulary rather than declare one.
 *
 * Judging by position rather than by the four output spellings (`verdict(`, `return`, `:`, `=`)
 * is deliberate: the natural way to add a fourth branch is `status === 402 ? 'quota' : …`,
 * which none of those spellings matches.
 */
function answersWithKind(text: string): boolean {
  for (const match of text.matchAll(new RegExp(KIND_LITERAL_SOURCE, 'gu'))) {
    const before = text.slice(0, match.index ?? 0).replace(/\s+$/u, '')
    if (/(?:===|!==|==|!=|<=|>=|<|>|case)$/u.test(before)) continue
    return true
  }
  return false
}

/**
 * A test against a hundred-series status, in the spellings a ladder is written in: the
 * ternary, the `if`, and the `case` of a `switch` on the number.
 *
 * Wider than {@link STATUS_COMPARISON}, which looks for the codes a provider throws;
 * this half is looking for the classifier's own decisions, and a `switch (status)`
 * spelled as `case 401:` is one of them.
 */
const STATUS_NUMBER_TEST_SOURCE = String.raw`\b(?:status|code)\s*(?:===|==|!==|>=|<=|<|>)\s*[1-5]\d{2}\b|case\s+[1-5]\d{2}\s*:`

/** The lines of a module that turn a status into a kind. */
function statusToKindLines(text: string): string[] {
  const statusTest = new RegExp(STATUS_NUMBER_TEST_SOURCE, 'u')
  return codeOnly(text).split('\n')
    .filter(line => statusTest.test(line) && answersWithKind(line))
    .map(line => line.trim())
}

/** The lines of a module that test a status number at all, kind or not. */
function statusNumberLines(text: string): readonly string[] {
  const statusTest = new RegExp(STATUS_NUMBER_TEST_SOURCE, 'u')
  return codeOnly(text).split('\n').filter(line => statusTest.test(line)).map(line => line.trim())
}

/**
 * How many status tests sit within one statement of a kind the text answers with.
 *
 * The windowed half of the same question, on collapsed text: a ladder wrapped over
 * three lines puts its status on one line and its kind on another, and the line check
 * above would call that clean.
 */
function statusKindWindows(text: string): number {
  const collapsed = codeOnly(text).replace(/\s+/gu, ' ')
  let count = 0
  for (const match of collapsed.matchAll(new RegExp(STATUS_NUMBER_TEST_SOURCE, 'gu'))) {
    const at = match.index ?? 0
    const window = collapsed.slice(Math.max(0, at - 160), at + 160)
    if (answersWithKind(window)) count += 1
  }
  return count
}

/**
 * The lines that turn a status into a kind inside the classifier, each with the reason
 * it is its own decision rather than the shared table's.
 *
 * Held as source text rather than as line numbers so that moving one fails the gate:
 * a mutation that matches nothing would otherwise pass as a mutation that found
 * nothing to change.
 */
const STATUS_TO_KIND_SITES: readonly { readonly line: string; readonly reason: string }[] = [
  {
    line: "if (status === 529) return verdict('overloaded', message)",
    reason: "529 is Anthropic's overload: a protocol fact with its own retryable wire type, not a statement about the account",
  },
  {
    line: "if (status === 413) return verdict('context-overflow', message)",
    reason: 'a body too large for the route is a fact about the request, and the kind names the only action that works',
  },
  {
    line: "return status >= 400 ? verdict('invalid-request', message) : verdict('unknown', message)",
    reason: 'the fallback for a status the shared table calls `other`, which still has to tell a 4xx from a 5xx',
  },
]

/** Modules allowed to turn a status into a kind, each with the reason for its entry. */
const STATUS_TO_KIND_MODULES: readonly { readonly path: string; readonly reason: string }[] = [
  { path: STATUS_MODULE, reason: 'the shared table itself: the one place a status becomes an account fact' },
  { path: KIND_MODULE, reason: 'the three protocol and fallback lines named above, and nothing else' },
]

describe('a status becomes an error kind in one place', () => {
  it('lets only the shared table and the classifier decide a kind from a status', async () => {
    const files = await sourceFiles()
    const deciding = files.filter(file => statusKindWindows(file.text) > 0).map(file => file.path).sort()
    expect(deciding).toEqual(STATUS_TO_KIND_MODULES.map(entry => entry.path).sort())
  })

  it('names every status-to-kind line in the classifier', async () => {
    const file = (await sourceFiles()).find(candidate => candidate.path === KIND_MODULE)
    expect(file, KIND_MODULE).toBeDefined()
    expect(statusToKindLines(file?.text ?? '').sort())
      .toEqual(STATUS_TO_KIND_SITES.map(site => site.line).sort())
  })

  it('counts the windows too, so a ladder wrapped over three lines cannot hide', async () => {
    const file = (await sourceFiles()).find(candidate => candidate.path === KIND_MODULE)
    expect(statusKindWindows(file?.text ?? '')).toBe(STATUS_TO_KIND_SITES.length)
  })

  it('lets no status test in the classifier stand outside the table or the named lines', async () => {
    // The kind half of this gate cannot see a decision that answers in booleans —
    // `return status === 402 || status === 403` is the old reading of the two gates
    // spelled without a kind literal — so the question is asked one level up: every
    // status test in this file is either one of the three named lines or a line that
    // reads the shared table.
    const file = (await sourceFiles()).find(candidate => candidate.path === KIND_MODULE)
    const named = new Set(STATUS_TO_KIND_SITES.map(site => site.line))
    const stray = statusNumberLines(file?.text ?? '')
      .filter(line => !named.has(line) && !line.includes('upstreamStatusCategory('))
    expect(stray).toEqual([])
  })

  it('keeps the classifier consulting the shared table rather than a copy of it', async () => {
    const files = await sourceFiles()
    const declaring = files
      .filter(file => codeOnly(file.text).includes('export function upstreamStatusCategory'))
      .map(file => file.path)
    expect(declaring).toEqual([STATUS_MODULE])
    const classifier = files.find(candidate => candidate.path === KIND_MODULE)
    expect(classifier?.text, 'the classifier must read the shared category')
      .toContain('upstreamStatusCategory(')
  })
})

describe('the plain-object test is declared once', () => {
  it('is written in the shared module and in the two named branches only', async () => {
    const files = await sourceFiles()
    const holding = files
      .filter(file => PREDICATE_FORMS.some(form => codeOnly(file.text).includes(form)))
      .map(file => file.path)
      .sort()
    expect(holding).toEqual([...INLINE_PREDICATE_USES.map(use => use.path), COERCION_MODULE].sort())
  })

  it('leaves the six local names and the second default out of the tree', async () => {
    const files = await sourceFiles()
    // The names the copies used, each as a declaration of its own.
    const declarations = /function (?:record|object|plainRecord|recordOf|isDecision|isRecord)\(/gu
    const offenders = files
      .filter(file => file.path !== COERCION_MODULE && declarations.test(codeOnly(file.text)))
      .map(file => file.path)
    expect(offenders).toEqual([])
  })
})

describe('a failed status is read in one place', () => {
  it('lets no other module decide an error code from a status', async () => {
    const files = await sourceFiles()
    const offenders = files
      .filter(file => file.path !== STATUS_MODULE && decidesCodeFromStatus(file.text))
      .map(file => file.path)
    expect(offenders).toEqual([])
  })

  it('routes every provider failure path through the shared table', async () => {
    const files = await sourceFiles()
    const missing = STATUS_CONSUMERS.filter(path => {
      const file = files.find(candidate => candidate.path === path)
      return file === undefined || !file.text.includes('llmCodeForUpstreamStatus(')
    })
    expect(missing).toEqual([])
  })
})

afterEach(() => vi.restoreAllMocks())

describe('the shared status table', () => {
  it('keeps 401 for the credential and reports the gates as a rate limit', () => {
    expect(llmCodeForUpstreamStatus(401)).toBe('AUTH')
    for (const status of [402, 403, 429]) expect(llmCodeForUpstreamStatus(status)).toBe('RATE_LIMIT')
    for (const status of [500, 502, 503, 599]) expect(llmCodeForUpstreamStatus(status)).toBe('SERVER')
    expect(llmCodeForUpstreamStatus(400)).toBe('HTTP_400')
    expect(llmCodeForUpstreamStatus(404)).toBe('HTTP_404')
  })

  it('calls a 500 the upstream failure and not the account', () => {
    expect(upstreamStatusCategory(500)).toBe('server')
    expect(llmCodeForUpstreamStatus(503)).not.toBe('AUTH')
  })

  it('separates the gate that costs an hour from the one that costs a minute', () => {
    expect(upstreamStatusCategory(402)).toBe('quota')
    expect(upstreamStatusCategory(403)).toBe('quota')
    expect(upstreamStatusCategory(429)).toBe('rate-limit')
    expect(upstreamStatusCategory(401)).toBe('auth')
    expect(upstreamStatusCategory(404)).toBe('other')
  })
})

const REQUEST: GenerateOptions = {
  provider: 'gateway',
  model: 'gateway/test-model',
  maxTokens: 64,
  messages: [{
    id: MessageId('m1'),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'hello' }],
  }],
}

/** Drive the generic gateway route against one status and return what it raised. */
async function gatewayFailure(status: number): Promise<LlmError> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status }))
  const adapter = new OpenAiCompatibleAdapter({
    providerName: 'Gateway',
    listModels: async provider => [{ provider, id: 'test-model', name: 'Test Model' }],
    resolveConnection: async () => ({ baseURL: 'https://example.invalid/v1', apiKey: 'not-used' }),
  })
  const thrown = await (async () => { for await (const _chunk of adapter.stream(REQUEST)) { /* consume */ } })()
    .catch((error: unknown) => error)
  if (!(thrown instanceof LlmError)) throw new Error(`expected an LlmError, got ${String(thrown)}`)
  return thrown
}

describe('the gateway route the drift was found on', () => {
  it('does not report the plan gate as a rejected key', async () => {
    // The bug this gate was written for: `403` reached the user as `AUTH`, which is
    // the code that sends them to Settings to re-authorize a working credential.
    const failure = await gatewayFailure(403)
    expect(failure.failure).toMatchObject({ code: 'RATE_LIMIT', status: 403 })
  })

  it('still reports a rejected credential as one', async () => {
    const failure = await gatewayFailure(401)
    expect(failure.failure).toMatchObject({ code: 'AUTH', status: 401 })
  })

  it('is where a plan gate and an outage part company', async () => {
    expect((await gatewayFailure(402)).failure).toMatchObject({ code: 'RATE_LIMIT', status: 402 })
    expect((await gatewayFailure(429)).failure).toMatchObject({ code: 'RATE_LIMIT', status: 429 })
    expect((await gatewayFailure(503)).failure).toMatchObject({ code: 'SERVER', status: 503 })
  })

  it('keeps a status no rule claims in the code', async () => {
    expect((await gatewayFailure(404)).failure).toMatchObject({ code: 'HTTP_404', status: 404 })
  })
})

describe('the shared coercion of untrusted JSON', () => {
  it('reads a plain object as a record and nothing else', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord(null)).toEqual({})
    expect(asRecord([1, 2])).toEqual({})
    expect(asRecord('text')).toEqual({})
    expect(asRecord(undefined)).toEqual({})
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('text')).toBe(false)
  })

  it('keeps "absent" distinct from "empty" for the caller that asked', () => {
    expect(maybeRecord({})).toEqual({})
    expect(maybeRecord(null)).toBeUndefined()
    expect(maybeRecord([])).toBeUndefined()
  })

  it('reads a non-empty trimmed string and a finite number only', () => {
    expect(asString('  ok ')).toBe('ok')
    expect(asString('   ')).toBeUndefined()
    expect(asString(7)).toBeUndefined()
    expect(asString(null)).toBeUndefined()
    expect(asNumber(0)).toBe(0)
    expect(asNumber(Number.NaN)).toBeUndefined()
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(asNumber('7')).toBeUndefined()
  })
})
