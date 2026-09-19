import { describe, expect, it } from 'vitest'
import { routeForModelDetail, selectModelOptionChoice } from '../src/engine-remotes.ts'
import type { EngineRemotesHost } from '../src/engine-remotes.ts'
import { SUPPORTED_WIRE_PROTOCOLS, WIRE_FOR_PROTOCOL, wireForProtocol } from '../src/openai-compatible-adapter.ts'

type Choice = {
  readonly enabled: boolean
  readonly routeKey: string
  readonly protocol?: string
  readonly zeroPrice?: boolean
  readonly rateMultiplier?: number
  readonly unlockRequired?: boolean
  readonly access?: string
  readonly locked?: boolean
  readonly groupId?: number
}

const choice = (over: Partial<Choice> & { readonly routeKey: string }): Choice => ({ enabled: true, ...over })

describe('selectModelOptionChoice backend default group', () => {
  it('serves the group the backend declares as the account default', () => {
    // `groups[].default` is the only authority for "which group serves when the
    // user picked none" — the Host no longer ranks by price, so a cheaper
    // sibling listed first must not win.
    expect(selectModelOptionChoice([
      choice({ routeKey: 'first', rateMultiplier: 0.1, groupId: 1 }),
      choice({ routeKey: 'declared', rateMultiplier: 1, groupId: 7 }),
    ], undefined, undefined, undefined, 7)?.routeKey).toBe('declared')
  })

  it('falls back to the backend order when the model is not in the default group', () => {
    expect(selectModelOptionChoice([
      choice({ routeKey: 'first', groupId: 1 }),
      choice({ routeKey: 'other', groupId: 2 }),
    ], undefined, undefined, undefined, 99)?.routeKey).toBe('first')
  })

  it('lets the user pin outrank the backend default', () => {
    expect(selectModelOptionChoice([
      choice({ routeKey: 'declared', groupId: 7 }),
      choice({ routeKey: 'picked', groupId: 3 }),
    ], undefined, undefined, 3, 7)?.routeKey).toBe('picked')
  })

  it('still fails loudly for an unsatisfiable pin instead of drifting to the default', () => {
    expect(selectModelOptionChoice([
      choice({ routeKey: 'a', groupId: 1 }),
    ], undefined, undefined, 5, 1)).toBeUndefined()
  })

  it('never honors a default group the account cannot use', () => {
    expect(selectModelOptionChoice([
      choice({ routeKey: 'locked', unlockRequired: true, groupId: 7 }),
      choice({ routeKey: 'open', groupId: 1 }),
    ], undefined, undefined, undefined, 7)?.routeKey).toBe('open')
  })
})

/**
 * The route key of the option the picker would serve.
 *
 * A test-local read of the real decision, because that is what the production
 * caller does: `selectModelOptionChoice` returns the option and the caller takes
 * `.routeKey` from it (or asks `routeForModelDetail`, which wraps the same
 * choice). This file used to exercise an exported one-line wrapper around
 * exactly this expression — eighteen assertions on a second entry point, none of
 * them on the call path. The helper keeps the assertions and drops the extra
 * export.
 */
const routeKeyOf = (
  choices: readonly ReturnType<typeof choice>[],
  preferredProtocols?: readonly string[],
  preferredRouteKey?: string,
): string | undefined => selectModelOptionChoice(choices, preferredProtocols, preferredRouteKey)?.routeKey

describe('selectModelOptionChoice, read as a route key', () => {
  it('returns undefined when every choice is disabled', () => {
    expect(routeKeyOf([
      choice({ routeKey: 'a', enabled: false }),
      choice({ routeKey: 'b', enabled: false }),
    ])).toBeUndefined()
  })

  it('follows the backend order instead of ranking groups by price', () => {
    // The local "cheapest usable group" rule is gone. It looked helpful and was
    // not: the group is what the account is billed through, and a picker that
    // lists one row per group while the Host silently serves another makes those
    // rows meaningless. Without the backend's declared default group (see
    // `routeForModelDetail`), the backend's own choice order decides — so the
    // result tracks the payload, not a comparison this file invented.
    expect(routeKeyOf([
      choice({ routeKey: 'paid', rateMultiplier: 0.2, groupId: 1 }),
      choice({ routeKey: 'free', zeroPrice: true, groupId: 9 }),
    ])).toBe('paid')
    expect(routeKeyOf([
      choice({ routeKey: 'free', zeroPrice: true, groupId: 9 }),
      choice({ routeKey: 'paid', rateMultiplier: 0.2, groupId: 1 }),
    ])).toBe('free')
  })

  it('prefers an unlocked group over a locked cheaper one', () => {
    expect(routeKeyOf([
      choice({ routeKey: 'locked', zeroPrice: true, unlockRequired: true, groupId: 1 }),
      choice({ routeKey: 'open', rateMultiplier: 0.5, groupId: 2 }),
    ])).toBe('open')
  })

  it('refuses a model whose only enabled groups are locked', () => {
    // The backend refuses these groups, so returning one would only convert a
    // clear "locked" state into a request failure the caller cannot explain.
    expect(routeKeyOf([
      choice({ routeKey: 'locked-a', unlockRequired: true, groupId: 5 }),
      choice({ routeKey: 'locked-b', unlockRequired: true, groupId: 3 }),
    ])).toBeUndefined()
  })

  it('treats the backend access gate alone as locked', () => {
    expect(routeKeyOf([
      choice({ routeKey: 'gate-locked', access: 'locked', groupId: 1 }),
      choice({ routeKey: 'open', rateMultiplier: 1, groupId: 2 }),
    ])).toBe('open')
    expect(routeKeyOf([choice({ routeKey: 'gate-locked', access: 'locked', groupId: 1 })])).toBeUndefined()
  })

  it('does not let a pin reach a locked group', () => {
    expect(routeKeyOf([
      choice({ routeKey: 'locked', unlockRequired: true, groupId: 1 }),
      choice({ routeKey: 'open', rateMultiplier: 0.5, groupId: 2 }),
    ], undefined, 'locked')).toBe('open')
  })

  it('keeps the backend order between equal-rate groups', () => {
    // Group id is not a preference either: the backend publishes choices in the
    // order it wants them tried, and re-sorting by id would override that with a
    // number that only happens to be stable.
    const choices = [
      choice({ routeKey: 'g9', rateMultiplier: 1, groupId: 9 }),
      choice({ routeKey: 'g2', rateMultiplier: 1, groupId: 2 }),
    ]
    expect(routeKeyOf(choices)).toBe('g9')
    expect(routeKeyOf([...choices].reverse())).toBe('g2')
  })

  it('prefers a protocol the caller can speak over a cheaper incompatible one', () => {
    expect(routeKeyOf([
      choice({ routeKey: 'anthropic-free', protocol: 'anthropic', zeroPrice: true, groupId: 1 }),
      choice({ routeKey: 'openai-paid', protocol: 'openai_responses', rateMultiplier: 0.9, groupId: 2 }),
    ], ['openai_responses', 'openai_chat_completions'])).toBe('openai-paid')
  })

  it('keeps the deterministic order when no preferred protocol is supplied', () => {
    expect(routeKeyOf([
      choice({ routeKey: 'anthropic-free', protocol: 'anthropic', zeroPrice: true, groupId: 1 }),
      choice({ routeKey: 'openai-paid', protocol: 'openai_responses', rateMultiplier: 0.9, groupId: 2 }),
    ])).toBe('anthropic-free')
  })

  it('honors a pinned route while it stays enabled and ignores a stale pin', () => {
    const choices = [
      choice({ routeKey: 'free', zeroPrice: true, groupId: 1 }),
      choice({ routeKey: 'paid', rateMultiplier: 0.5, groupId: 2 }),
    ]
    expect(routeKeyOf(choices, undefined, 'paid')).toBe('paid')
    // A pin for a group that is no longer offered falls back to automatic choice.
    expect(routeKeyOf(choices, undefined, 'gone')).toBe('free')
    // A pin for a now-disabled group does not resurrect it.
    expect(routeKeyOf([choice({ routeKey: 'paid', enabled: false })], undefined, 'paid')).toBeUndefined()
  })

  it('accepts the backend short protocol spellings', () => {
    expect(routeKeyOf([
      choice({ routeKey: 'chat', protocol: 'chat', rateMultiplier: 1, groupId: 1 }),
      choice({ routeKey: 'anthropic', protocol: 'anthropic', rateMultiplier: 0.1, groupId: 2 }),
    ], ['openai_chat_completions'])).toBe('chat')
  })
})

/**
 * The router's accepted protocol set and the transport's wire mapping are one
 * fact, not two.
 *
 * The defect these pin: `openai_responses` was declared routable while the only
 * wire that existed was chat-completions, so a group the router happily selected
 * was sent whichever body the caller happened to serialize, with nothing in
 * either layer able to notice the disagreement.
 */
describe('backend protocol spellings and the wire that serves them', () => {
  it('serves both OpenAI dialects through the chat-completions wire', () => {
    // The catalog labels a group with the dialect its upstream channel speaks;
    // the public text route family for OpenAI groups is one, and the route key
    // (`model:openai_responses:gpt-5.6`) already carries the dialect. A protocol
    // with no body behind it is not routable.
    expect(wireForProtocol('openai_responses')).toBe('openai')
    expect(wireForProtocol('responses')).toBe('openai')
    expect(wireForProtocol('openai_chat_completions')).toBe('openai')
    expect(wireForProtocol('chat-completions')).toBe('openai')
    expect(wireForProtocol('anthropic')).toBe('anthropic')
    expect(wireForProtocol('gemini')).toBeUndefined()
  })

  it('derives the routable protocol set from the wire mapping', () => {
    expect([...SUPPORTED_WIRE_PROTOCOLS]).toEqual([...WIRE_FOR_PROTOCOL.keys()])
    for (const protocol of SUPPORTED_WIRE_PROTOCOLS) expect(wireForProtocol(protocol), protocol).toBeDefined()
  })

  it('still selects an openai_responses group and serves it as chat completions', () => {
    // The dialect has to stay in the speakable set: the cheaper `gemini` group
    // ahead of it is filtered out, so if `openai_responses` were dropped too the
    // pool would be empty and this model would have no route at all.
    const choices = [
      choice({ routeKey: 'unwired', protocol: 'gemini', zeroPrice: true, groupId: 1 }),
      choice({ routeKey: 'responses', protocol: 'openai_responses', rateMultiplier: 1, groupId: 2 }),
    ]
    expect(routeKeyOf(choices, SUPPORTED_WIRE_PROTOCOLS)).toBe('responses')
    expect(wireForProtocol('openai_responses')).toBe('openai')
  })
})

describe('routeForModelDetail', () => {
  const optionsHost = (options: readonly Choice[]): EngineRemotesHost => ({
    api: { getModelOptions: async () => [{ model: 'claude-3', options }] },
  }) as unknown as EngineRemotesHost

  it('carries the chosen group protocol so the caller can pick a wire', async () => {
    await expect(routeForModelDetail(optionsHost([
      choice({ routeKey: 'anthropic', protocol: 'anthropic', groupId: 1 }),
    ]), 'claude-3', 'token')).resolves.toEqual({ routeKey: 'anthropic', protocol: 'anthropic' })
  })

  it('sends a Claude model to a free Anthropic group rather than a paid OpenAI one', async () => {
    await expect(routeForModelDetail(optionsHost([
      choice({ routeKey: 'anthropic-free', protocol: 'anthropic', zeroPrice: true, groupId: 1 }),
      choice({ routeKey: 'openai', protocol: 'openai_responses', rateMultiplier: 1, groupId: 2 }),
    ]), 'claude-3', 'token')).resolves.toEqual({ routeKey: 'anthropic-free', protocol: 'anthropic' })
  })

  it('deprioritizes a group whose protocol has no wire, even when it is free', async () => {
    await expect(routeForModelDetail(optionsHost([
      choice({ routeKey: 'unwired', protocol: 'gemini', zeroPrice: true, groupId: 1 }),
      choice({ routeKey: 'openai', protocol: 'openai_responses', rateMultiplier: 1, groupId: 2 }),
    ]), 'claude-3', 'token')).resolves.toEqual({ routeKey: 'openai', protocol: 'openai_responses' })
  })

  it('chooses the group itself instead of reading a route override from settings', async () => {
    // Settings no longer pins a group. A leftover `modelRouteSelections` entry
    // must not decide the wire, or an account that lost a group would keep
    // sending requests at it.
    const host = {
      api: { getModelOptions: async () => [{ model: 'claude-3', options: [
        choice({ routeKey: 'free', zeroPrice: true, groupId: 1 }),
        choice({ routeKey: 'paid', rateMultiplier: 0.5, groupId: 2 }),
      ] }] },
      policy: { get: () => ({ modelRouteSelections: { 'claude-3': 'paid' } }) },
    } as unknown as EngineRemotesHost
    await expect(routeForModelDetail(host, 'claude-3', 'token')).resolves.toEqual({ routeKey: 'free', protocol: undefined })
  })
})
