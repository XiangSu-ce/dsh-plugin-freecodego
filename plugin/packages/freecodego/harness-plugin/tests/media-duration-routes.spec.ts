/**
 * A video route is asked only for lengths it can render.
 *
 * The tool's own schema promised this — "a route whose own range is narrower is
 * skipped rather than failed" — and two things stood in the way:
 *
 * 1. **Kling and xAI quantized the value into their window.** Measured before this
 *    fix: `seconds: 7` on Kling went out as `duration: '10'`, and `seconds: 30` on
 *    xAI as `duration: 10`. The video that came back was not the length that was
 *    asked for, nothing in the result said so, and — because the call *succeeded* —
 *    the ladder stopped there, so a route further down that could have rendered the
 *    real length was never asked. That last half is the expensive one: with
 *    `[kling, volcengine]` configured, a 30-second request returned a 10-second
 *    video from Kling and never reached Seedance.
 * 2. **Only Agnes declared a window.** It refused outside its own range and the
 *    ladder moved on, which is the behaviour the schema described for every route.
 *
 * The fix declares the windows this repository can actually justify — Kling's two
 * lengths, xAI's 2-10, Agnes' own list — and refuses outside them as a **route**
 * limitation, naming the lengths that route does accept so the caller can ask again.
 * Routes whose window this repository does not encode keep the value as given: the
 * third block below pins that on purpose, because inventing a window turns a request
 * a provider *can* serve into a refusal, and a refusal skips the route.
 */

import { describe, expect, it } from 'vitest'
import { generateVideoWithFallback } from '../src/media-generation.ts'
import { KLING_VIDEO_SECONDS, MediaRouteLimitation, mediaVideoRequest, videoSecondsAcceptance, videoSecondsRefusal } from '../src/media-utils.ts'

const route = (provider: string, model = 'video-model'): { selection: string; provider: string; model: string } => ({ selection: `${provider}/${model}`, provider, model })

interface Call { readonly selection: string; readonly body: Record<string, unknown> }

/**
 * A host whose video routes are `routes` in order, with a resolvable transport and
 * a recorded create call. The transport has to resolve because a create call is
 * followed by `pollGeneratedVideo`, which builds one before it reads the payload.
 */
function ladderHost(routes: readonly { readonly provider: string; readonly model: string }[], calls: Call[]): unknown {
  const profiles = Object.fromEntries(routes.map(entry => [entry.provider, { baseURL: `https://${entry.provider}.example/v1` }]))
  return {
    ctx: {
      get: (name: string) => name === 'llm'
        ? {
          listProviders: () => routes.map(entry => ({ id: entry.provider })),
          listModels: async (id: string) => routes.filter(entry => entry.provider === id).map(entry => ({ id: entry.model, name: entry.model })),
        }
        : name === 'settings' ? { get: () => ({ providers: profiles }) } : undefined,
    },
    capabilities: { configuration: () => ({ modelCategories: {} }) },
    policy: { get: () => ({ mediaDefaults: { video: `${routes[0]?.provider ?? ''}/${routes[0]?.model ?? ''}` } }) },
    readManagedCatalogCache: async () => undefined,
    logfareApiKey: async () => undefined,
    logfareModels: async () => [],
    requireAgnes: () => ({ agnesMediaModels: async () => [] }),
    credentials: { resolve: async () => ({ value: 'media-key' }) },
    mediaRoute: (selection: string) => {
      const found = routes.find(entry => `${entry.provider}/${entry.model}` === selection) ?? routes[0]
      return { selection, provider: found?.provider ?? '', model: found?.model ?? '' }
    },
    directConnection: async () => undefined,
    managedRuntime: async () => undefined,
    gatewayMediaJson: async (selection: string, _endpoint: string, body: Record<string, unknown>) => {
      calls.push({ selection, body })
      return { data: [{ url: 'https://cdn.example/out.mp4' }] }
    },
  }
}

describe('a video route outside its declared window steps aside', () => {
  it('names the lengths the route does accept', () => {
    expect(() => mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat', seconds: 7 })).toThrow('kling renders 5 or 10 seconds, not 7')
    expect(() => mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat', seconds: 30 })).toThrow('kling renders 5 or 10 seconds, not 30')
    expect(() => mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'a cat', seconds: 30 })).toThrow('xai renders 2 through 10 seconds, not 30')
    expect(() => mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'a cat', seconds: 1 })).toThrow('xai renders 2 through 10 seconds, not 1')
  })

  it('raises the refusal as this route\'s limitation rather than a bad request', () => {
    // The type is what the ladder reads; a plain Error here would be terminal, and
    // the whole point is that another route gets the request.
    const error = (() => { try { mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat', seconds: 7 }); return undefined } catch (cause: unknown) { return cause } })()
    expect(error).toBeInstanceOf(MediaRouteLimitation)
  })

  it('carries a length inside the window unchanged, and refuses a fractional one', () => {
    expect(mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat', seconds: 5 }).body.duration).toBe('5')
    expect(mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat', seconds: 10 }).body.duration).toBe('10')
    expect(mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'a cat', seconds: 8 }).body).toMatchObject({ duration: 8 })
    // A fractional length is outside every declaration: these providers take whole
    // seconds, and rounding one into the window is the quantization this replaces.
    expect(() => mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'a cat', seconds: 6.5 })).toThrow(/xai renders 2 through 10 seconds, not 6.5/u)
  })

  it('keeps Kling\'s two lengths as the table\'s only source', () => {
    expect([...KLING_VIDEO_SECONDS]).toEqual([5, 10])
    expect(videoSecondsAcceptance('kling')).toEqual({ kind: 'one of', values: [5, 10] })
    expect(videoSecondsAcceptance('kuaishou')).toEqual({ kind: 'one of', values: [5, 10] })
  })
})

describe('a route whose window this repository does not encode is left alone', () => {
  // Each entry is `[provider, model, where the length lands in the body]`. These are
  // pinned as *unknown* on purpose: a future round that wants a declaration here has
  // to delete a case, which is the conversation it should be having.
  const unknowns: readonly (readonly [string, string, (body: Record<string, unknown>) => unknown])[] = [
    ['volcengine', 'doubao-seedance', body => body.duration],
    ['dashscope', 'wan3.0-video', body => (body.parameters as Record<string, unknown> | undefined)?.duration],
    ['vidu', 'viduq3-pro', body => body.duration],
    ['minimax', 'MiniMax-H3', body => body.duration],
    ['google', 'veo-3.1', body => (body.parameters as Record<string, unknown> | undefined)?.durationSeconds],
    ['openai', 'video-model', body => body.seconds],
    ['freecodego', 'video-model', body => body.seconds],
  ]

  it.each(unknowns)('carries 30 seconds to %s as given', (provider, model, read) => {
    expect(videoSecondsAcceptance(provider)).toBeUndefined()
    expect(videoSecondsRefusal(provider, 30)).toBeUndefined()
    expect(read(mediaVideoRequest(route(provider, model), { prompt: 'a cat', seconds: 30 }).body)).toBe(30)
  })

  it('has no declaration for a protocol it does not know either', () => {
    expect(videoSecondsAcceptance('some-reseller')).toBeUndefined()
    expect(videoSecondsRefusal('some-reseller', 61)).toBeUndefined()
  })
})

describe('the ladder reaches a route that can render the length', () => {
  it('asks the second route for 30 seconds instead of returning a 10-second video', async () => {
    const calls: Call[] = []
    const host = ladderHost([{ provider: 'kling', model: 'kling-v2-1' }, { provider: 'volcengine', model: 'doubao-seedance' }], calls)
    await expect(generateVideoWithFallback(host as never, { prompt: 'a long boat', seconds: 30 }, new AbortController().signal))
      .resolves.toMatchObject({ url: 'https://cdn.example/out.mp4' })
    // Not merely routed around: the route that cannot render it was never asked, so
    // no provider quota was spent on a length it would have changed.
    expect(calls.map(call => call.selection)).toEqual(['volcengine/doubao-seedance'])
    expect(calls[0]?.body).toMatchObject({ duration: 30 })
  })

  it('names every refusal when no route can render it, and spends nothing', async () => {
    const calls: Call[] = []
    const host = ladderHost([{ provider: 'kling', model: 'kling-v2-1' }, { provider: 'xai', model: 'grok-imagine-video' }], calls)
    await expect(generateVideoWithFallback(host as never, { prompt: 'a long boat', seconds: 30 }, new AbortController().signal))
      .rejects.toThrow(/No configured video model completed the request: .*kling\/kling-v2-1: kling renders 5 or 10 seconds, not 30 \| .*xai\/grok-imagine-video: xai renders 2 through 10 seconds, not 30/u)
    expect(calls).toEqual([])
  })
})
