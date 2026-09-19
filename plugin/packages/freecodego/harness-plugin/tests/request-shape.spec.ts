import { describe, expect, it } from 'vitest'
import { RequestShapeLog, describeShapeChange, diffRequestShape, fingerprintRequest } from '../src/request-shape.ts'
import type { RequestHeaderLike } from '../src/request-shape.ts'

// Typed as the module's own `RequestHeaderLike`, not `never`: the fixture has to
// satisfy the structural view the fingerprint reads, or a widened or renamed
// header field would stop being checked here.
const header = (overrides: RequestHeaderLike = {}): RequestHeaderLike => ({
  config: { provider: 'freecodego', model: 'deepseek-v4-flash', ...(overrides.config ?? {}) },
  system: 'You are a coding agent.',
  tools: [
    { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  ],
  ...overrides,
})

describe('request shape fingerprinting', () => {
  it('is stable across tool reordering and object key order', () => {
    // A schema rebuilt in a different key order is the same schema; treating it
    // as a change would send someone chasing a cache break that never happened.
    const forward = fingerprintRequest(header())
    const reordered = fingerprintRequest({
      config: { model: 'deepseek-v4-flash', provider: 'freecodego' },
      system: 'You are a coding agent.',
      tools: [
        { name: 'bash', description: 'Run a command', parameters: { properties: { command: { type: 'string' } }, type: 'object' } },
        { name: 'read', description: 'Read a file', parameters: { properties: { path: { type: 'string' } }, type: 'object' } },
      ],
    })
    expect(reordered.toolsHash).toBe(forward.toolsHash)
    expect(reordered.systemHash).toBe(forward.systemHash)
  })

  it('reports a reference cycle instead of overflowing the stack', () => {
    // A hand-written or third-party JSONSchema can contain one; the failure used
    // to be an unlabelled RangeError from inside the hashing helper.
    const cyclic: Record<string, unknown> = { type: 'object', properties: {} }
    ;(cyclic.properties as Record<string, unknown>).self = cyclic
    expect(() => fingerprintRequest({ config: { provider: 'p', model: 'm' }, tools: [{ name: 't', parameters: cyclic }] }))
      .toThrow(/reference cycle/u)
  })

  it('still fingerprints a schema that repeats a sub-schema in two places', () => {
    // Repetition is not a cycle: the guard tracks the current path, not every
    // object ever seen, so a shared sub-schema hashes normally.
    const shared = { type: 'string' }
    const shape = fingerprintRequest({
      config: { provider: 'p', model: 'm' },
      tools: [{ name: 't', parameters: { type: 'object', properties: { a: shared, b: shared } } }],
    })
    expect(shape.perTool).toHaveLength(1)
    expect(shape.perTool[0]?.hash).toMatch(/^[0-9a-f]{16}$/u)
  })

  it('names the tool whose description moved while the tool set stayed the same', () => {
    // The measured case this exists for: 77% of tool-schema cache breaks are
    // "same tool set, one description changed" — usually a tool that embeds a
    // dynamic list. A count of added/removed tools cannot see it.
    const before = fingerprintRequest(header())
    const after = fingerprintRequest(header({
      tools: [
        { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'bash', description: 'Run a command, or one of: git, rg, ls', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
      ],
    }))
    const change = diffRequestShape(before, after)
    expect(change.kind).toBe('tools')
    expect(change.changedTools).toEqual(['bash'])
    expect(change.addedTools).toEqual([])
    expect(change.removedTools).toEqual([])
    expect(change.cacheRelevant).toBe(true)
    expect(describeShapeChange(change)).toContain('tool schema changed with the same tool set: bash')
  })

  it('reports added and removed tools by count instead of listing every name', () => {
    const before = fingerprintRequest(header())
    const after = fingerprintRequest({ ...header(), tools: [{ name: 'read', description: 'Read a file', parameters: {} }] })
    const change = diffRequestShape(before, after)
    expect(change.addedTools).toEqual([])
    expect(change.removedTools).toEqual(['bash'])
    expect(describeShapeChange(change)).toContain('tool set changed (+0/-1)')
  })

  it('lists every independent cause rather than the loudest one', () => {
    const before = fingerprintRequest(header())
    const after = fingerprintRequest({
      config: { provider: 'freecodego', model: 'other-model' },
      system: 'You are a coding agent with extra guidance.',
      tools: header().tools,
    })
    const change = diffRequestShape(before, after)
    expect(change.kind).toBe('model')
    expect(change.causes).toHaveLength(2)
    expect(change.causes[0]).toContain('model changed')
    expect(change.causes[1]).toContain('(+20 chars)')
  })

  it('treats sampling scalars as cache-irrelevant', () => {
    // maxTokens changes what the reply may be, not what the provider cached.
    const before = fingerprintRequest(header())
    const after = fingerprintRequest({ ...header(), config: { provider: 'freecodego', model: 'deepseek-v4-flash', maxTokens: 8_192 } })
    const change = diffRequestShape(before, after)
    expect(change.kind).toBe('max-tokens')
    expect(change.cacheRelevant).toBe(false)
    expect(change.causes[0]).toContain('max tokens changed')
  })

  it('calls the first request initial rather than a break', () => {
    const change = diffRequestShape(undefined, fingerprintRequest(header()))
    expect(change.kind).toBe('initial')
    expect(change.cacheRelevant).toBe(false)
    expect(describeShapeChange(change)).toContain('nothing to compare')
  })

  it('reports an unchanged shape without inventing a cause', () => {
    const shape = fingerprintRequest(header())
    const change = diffRequestShape(shape, shape)
    expect(change.kind).toBe('none')
    expect(change.causes).toEqual([])
    expect(describeShapeChange(change)).toBe('request shape unchanged')
  })
})

// Latching flags ON for a session is the fix for a mid-session flip, and the
// plugin does not need one: nothing here contributes a per-request header or
// capability bit that can flip. The suite that used to live here exercised a
// `StickyFlagSet` class with no caller; when such a flag appears, the fix is to
// latch it at the point it is sent — the module doc says so — not to ship the
// latch first.

describe('request shape log', () => {
  it('diffs against the previous shape for the same key', () => {
    const log = new RequestShapeLog()
    expect(log.record('a', fingerprintRequest(header())).kind).toBe('initial')
    expect(log.record('a', fingerprintRequest(header())).kind).toBe('none')
    const changed = log.record('a', fingerprintRequest({ ...header(), system: 'different' }))
    expect(changed.kind).toBe('system')
  })

  it('keeps keys independent', () => {
    const log = new RequestShapeLog()
    log.record('a', fingerprintRequest(header()))
    // A subagent's first request must not be diffed against the parent's shape.
    expect(log.record('b', fingerprintRequest({ ...header(), system: 'other' })).kind).toBe('initial')
  })

  it('evicts the oldest key past the cap so agent keys cannot grow without bound', () => {
    const log = new RequestShapeLog(3)
    for (const key of ['a', 'b', 'c', 'd']) log.record(key, fingerprintRequest(header()))
    expect(log.peek('a')).toBeUndefined()
    expect(log.peek('d')).toBeDefined()
  })
})
