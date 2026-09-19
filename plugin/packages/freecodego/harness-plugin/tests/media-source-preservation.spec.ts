/**
 * Generated media keeps the sources the caller attached.
 *
 * The rule is stated twice in the plugin's own words — the image tool's
 * description ("pass images to edit or fuse existing pictures") and a test for
 * the video request builder ("a silently discarded reference image is worse than
 * a route that fails: the fallback chain then reaches a provider that can
 * actually use it"). Two paths did not follow it.
 *
 * 1. **The image retry ladder dropped the source images.** Its whole purpose is
 *    to drop *optional* parameters (size, quality, `n`, `response_format`) that an
 *    OpenAI-compatible server refuses — but the portable retry it fell back to was
 *    `{ model, prompt }` for every route, so on a generation-shaped reference route
 *    (`volcengine` Seedream) a server answering `unknown parameter: size` was
 *    retried with the sources gone, and that retry *succeeded*: a picture generated
 *    from the prompt alone, returned as the answer to "edit this image", with
 *    nothing in the result saying the sources were ignored. Measured before the
 *    fix, the second request body was `model,prompt` with `image: null`.
 * 2. **Two video bodies accepted roles they have no field for.** The OpenAI-shaped
 *    route has one image field and no reference set, and the portable gateway body
 *    has no last-frame field, so `lastImage` (both) and `images` (OpenAI) were
 *    accepted and silently dropped — measured `keys = model,prompt` for a request
 *    that asked for a first-to-last-frame interpolation. Every other protocol that
 *    cannot carry a role already steps aside; these two did not.
 *
 * Both cases are asserted on the *request bodies* that reached the transport, not
 * on flags: a retry that resolves while carrying a different request is the
 * failure being fixed.
 */

import { describe, expect, it } from 'vitest'
import { generateImageWithFallback } from '../src/media-generation.ts'
import { mediaVideoRequest } from '../src/media-utils.ts'

const SOURCE = 'https://cdn.example/source.png'
const LAST = 'https://cdn.example/last.png'

interface Call { readonly endpoint: string; readonly body: Record<string, unknown> }

/** A host whose only image route is `provider/model` and whose transport is recorded. */
function imageHost(input: { readonly provider: string; readonly model: string; readonly calls: Call[]; readonly fail: (index: number, endpoint: string) => Error | undefined }): unknown {
  const selection = `${input.provider}/${input.model}`
  return {
    ctx: { get: (name: string) => name === 'llm' ? { listProviders: () => [], listModels: async () => [] } : undefined },
    capabilities: { configuration: () => ({ modelCategories: {} }) },
    policy: { get: () => ({ mediaDefaults: { image: selection } }) },
    readManagedCatalogCache: async () => undefined,
    logfareApiKey: async () => undefined,
    logfareModels: async () => [],
    requireAgnes: () => ({ agnesMediaModels: async () => [] }),
    credentials: { resolve: async () => undefined },
    mediaRoute: (value: string) => ({ selection: value, provider: input.provider, model: input.model }),
    directConnection: async () => undefined,
    managedRuntime: async () => undefined,
    gatewayMediaJson: async (_selection: string, endpoint: string, body: Record<string, unknown>) => {
      input.calls.push({ endpoint, body })
      const refusal = input.fail(input.calls.length, endpoint)
      if (refusal !== undefined) throw refusal
      return { data: [{ url: 'https://cdn.example/out.png' }] }
    },
  }
}

const unknownParameter = (name: string, endpoint: string): Error => new Error(`FreeCodeGo ${endpoint} failed with HTTP 400: unknown parameter: ${name}`)

describe('the image retry ladder keeps the source images', () => {
  it('carries them into the portable retry instead of generating from the prompt alone', async () => {
    const calls: Call[] = []
    const host = imageHost({ provider: 'volcengine', model: 'doubao-seedream-3-0-t2i', calls, fail: (index, endpoint) => index === 1 ? unknownParameter('size', endpoint) : undefined })
    await generateImageWithFallback(host as never, { prompt: 'put the cat in a hat', images: [SOURCE] }, new AbortController().signal)
    expect(calls).toHaveLength(2)
    // The retry still drops what it is allowed to drop ...
    expect(calls[1]?.body).not.toHaveProperty('size')
    // ... and keeps what it may not: the caller asked to edit this picture.
    expect(calls[1]?.body).toMatchObject({ prompt: 'put the cat in a hat', image: [SOURCE] })
  })

  it('ends the route when the sources are what the server refuses, rather than serving another request', async () => {
    const calls: Call[] = []
    const host = imageHost({ provider: 'volcengine', model: 'doubao-seedream-3-0-t2i', calls, fail: (index, endpoint) => index === 1 ? unknownParameter('size', endpoint) : unknownParameter('image', endpoint) })
    await expect(generateImageWithFallback(host as never, { prompt: 'put the cat in a hat', images: [SOURCE] }, new AbortController().signal))
      .rejects.toThrow(/unknown parameter: image/u)
    expect(calls).toHaveLength(2)
  })

  it('still degrades to the bare portable shape for a request that attached no sources', async () => {
    // The control: the ladder is not disabled, only corrected. With nothing to
    // lose, the retry is exactly the shape it always was.
    const calls: Call[] = []
    const host = imageHost({ provider: 'volcengine', model: 'doubao-seedream-3-0-t2i', calls, fail: (index, endpoint) => index === 1 ? unknownParameter('size', endpoint) : undefined })
    await generateImageWithFallback(host as never, { prompt: 'a cat' }, new AbortController().signal)
    expect(calls[1]?.body).toEqual({ model: 'doubao-seedream-3-0-t2i', prompt: 'a cat' })
  })
})

describe('video bodies with no field for a role step aside', () => {
  const route = (provider: string): { selection: string; provider: string; model: string } => ({ selection: `${provider}/video-model`, provider, model: 'video-model' })

  it('refuses a last frame on the OpenAI-shaped route instead of dropping it', () => {
    expect(() => mediaVideoRequest(route('openai'), { prompt: 'a cat', lastImage: LAST })).toThrow(/A last frame is unavailable/u)
  })

  it('refuses a reference set on the OpenAI-shaped route instead of dropping it', () => {
    expect(() => mediaVideoRequest(route('openai'), { prompt: 'a cat', images: [SOURCE] })).toThrow(/Reference images are unavailable/u)
  })

  it('refuses a last frame on the portable gateway route instead of dropping it', () => {
    expect(() => mediaVideoRequest(route('freecodego'), { prompt: 'a cat', lastImage: LAST })).toThrow(/A last frame is unavailable/u)
  })

  it('keeps carrying a reference set on the gateway, which does have the field', () => {
    // The control for the rule above: stepping aside is for roles with no field,
    // not for media in general.
    const request = mediaVideoRequest(route('freecodego'), { prompt: 'a cat', images: [SOURCE] })
    expect(request.body).toMatchObject({ reference_images: [{ url: SOURCE }] })
  })

  it('sends the validated, trimmed first frame on both routes', () => {
    for (const provider of ['openai', 'freecodego']) {
      expect(mediaVideoRequest(route(provider), { prompt: 'a cat', image: `  ${SOURCE}  ` }).body).toMatchObject({ image: SOURCE })
    }
  })
})
