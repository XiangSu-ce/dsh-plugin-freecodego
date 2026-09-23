import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MediaRouteLimitation, REFERENCE_IMAGE_LIMIT, dataUrlImage, defaultMediaAuthScheme, defaultMediaBaseURL, defaultMediaCredentialRef, generatedVideoResult, guessImageMediaType, imagesViaGenerationBody, mediaVideoProtocol, mediaVideoRequest, referenceImageUrls, signKlingJwt, videoStatusEndpoint } from '../src/media-utils.ts'
import { generateImageWithFallback, isNativeDashscopeRoute, mediaTransport } from '../src/media-generation.ts'
import { MODELS_SETTINGS_ENTRY } from '../src/peer-settings.ts'
import { settingsDescriptor } from './support/host-services.ts'

/** A one-pixel PNG signature, which is all the image writer needs to sniff. */
const PNG_BASE64 = 'iVBORw0KGgo='
const REFERENCE = 'https://cdn.example/ref.png'

const route = (provider: string, model = 'some-model') => ({ selection: `${provider}/${model}`, provider, model })

describe('mediaVideoProtocol', () => {
  it('classifies every vendor family the request layer speaks', () => {
    expect([
      mediaVideoProtocol('kling'),
      mediaVideoProtocol('volcengine'),
      mediaVideoProtocol('qwen'),
      mediaVideoProtocol('minimax'),
      mediaVideoProtocol('vidu'),
      mediaVideoProtocol('google'),
      mediaVideoProtocol('xai'),
      mediaVideoProtocol('openai'),
    ]).toEqual(['kling', 'ark', 'dashscope', 'minimax', 'vidu', 'gemini', 'xai', 'openai'])
  })

  it('keeps the gateway on the portable OpenAI shape whatever the model is called', () => {
    // The gateway adapts upstream itself: naming a vendor model must not make
    // the Host speak that vendor's wire format to the gateway.
    expect(mediaVideoProtocol('freecodego')).toBe('gateway')
    expect(mediaVideoProtocol('logfare')).toBe('gateway')
    expect(mediaVideoProtocol('agnes')).toBe('gateway')
  })

  it('leaves an OpenAI-compatible aggregator on the portable shape', () => {
    // A provider the plugin does not know is assumed to be OpenAI-compatible,
    // which is also what its create endpoint chain and status route assume.
    expect(mediaVideoProtocol('openrouter')).toBe('gateway')
  })
})

describe('mediaVideoRequest', () => {
  it('sends Ark content parts with the first-frame role and top-level specs', () => {
    expect(mediaVideoRequest(route('volcengine', 'doubao-seedance-2-0'), { prompt: 'a cat', seconds: 5, aspectRatio: '16:9', image: 'https://cdn.example/first.png' })).toEqual({
      endpoint: '/contents/generations/tasks',
      body: {
        model: 'doubao-seedance-2-0',
        content: [
          { type: 'text', text: 'a cat' },
          { type: 'image_url', image_url: { url: 'https://cdn.example/first.png' }, role: 'first_frame' },
        ],
        duration: 5,
        ratio: '16:9',
      },
    })
  })

  it('opts DashScope into async and nests prompt/media under input', () => {
    const request = mediaVideoRequest(route('qwen', 'wan3.0-video'), { prompt: 'a cat', seconds: 5, aspectRatio: '16:9', image: 'https://cdn.example/first.png' })
    expect(request.endpoint).toBe('/api/v1/services/aigc/video-generation/video-synthesis')
    // Without this header DashScope rejects the video route outright.
    expect(request.headers).toEqual({ 'X-DashScope-Async': 'enable' })
    expect(request.body).toEqual({
      model: 'wan3.0-video',
      input: { prompt: 'a cat', media: [{ type: 'first_frame', url: 'https://cdn.example/first.png' }] },
      parameters: { duration: 5, ratio: '16:9' },
    })
  })

  it('speaks MiniMax on the dedicated video_generation route', () => {
    expect(mediaVideoRequest(route('minimax', 'MiniMax-H3'), { prompt: 'a cat', seconds: 6, aspectRatio: '9:16' })).toEqual({
      endpoint: '/v2/video_generation',
      body: {
        model: 'MiniMax-H3',
        content: [{ type: 'text', text: 'a cat' }],
        duration: 6,
        ratio: '9:16',
      },
    })
  })

  it('picks the Vidu route by mode and carries the reference images as a list', () => {
    expect(mediaVideoRequest(route('vidu', 'viduq3-pro'), { prompt: 'a cat', seconds: 5 }).endpoint)
      .toEqual(['/ent/v2/text2video', '/ent/v2/img2video'])
    const imageToVideo = mediaVideoRequest(route('vidu', 'viduq3-pro'), { prompt: 'a cat', seconds: 5, image: 'https://cdn.example/first.png' })
    expect(imageToVideo.endpoint).toEqual(['/ent/v2/img2video', '/ent/v2/text2video'])
    expect(imageToVideo.body).toEqual({ model: 'viduq3-pro', prompt: 'a cat', images: ['https://cdn.example/first.png'], duration: 5 })
  })

  it('names the length duration for xAI and carries it through the accepted window', () => {
    // The compatible layer validates an integer of 2-10 seconds. A length inside
    // that window travels exactly as asked; one outside it is this route's own
    // limitation, refused by the builder instead of clamped into a shorter video
    // than the caller asked for. `media-duration-routes.spec.ts` pins both halves,
    // including the ladder asking a route that can render the real length.
    const request = mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'a cat', seconds: 8, image: 'https://cdn.example/first.png' })
    expect(request.endpoint).toEqual(['/videos/generations', '/videos'])
    expect(request.body).toMatchObject({ duration: 8, image: { url: 'https://cdn.example/first.png' } })
    expect(mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'a cat', seconds: 2 }).body).toMatchObject({ duration: 2 })
  })

  it('sends a bare image URL to xAI only inside the url object the API parses', () => {
    // `image` is `{url}|{file_id}`; a bare string fails request decoding.
    expect(mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'a cat', image: 'https://cdn.example/x.png' }).body.image)
      .toEqual({ url: 'https://cdn.example/x.png' })
  })

  it('keeps the portable seconds/aspect_ratio shape on the gateway', () => {
    expect(mediaVideoRequest(route('freecodego', 'kling-v2'), { prompt: 'a cat', seconds: 5, aspectRatio: '16:9', image: 'https://cdn.example/x.png' })).toEqual({
      endpoint: ['/videos/generations', '/videos'],
      body: { model: 'kling-v2', prompt: 'a cat', seconds: 5, aspect_ratio: '16:9', image: 'https://cdn.example/x.png' },
    })  })
})

describe('mediaVideoRequest reference media', () => {
  it('names the Ark part roles for the last frame and the reference set', () => {
    const request = mediaVideoRequest(route('volcengine', 'doubao-seedance-2-0'), { prompt: 'a cat', lastImage: 'https://cdn.example/last.png', images: [REFERENCE] })
    expect(request.body.content).toEqual([
      { type: 'text', text: 'a cat' },
      { type: 'image_url', image_url: { url: 'https://cdn.example/last.png' }, role: 'last_frame' },
      { type: 'image_url', image_url: { url: REFERENCE }, role: 'reference_image' },
    ])
  })

  it('sends the DashScope reference set as reference_image media', () => {
    const request = mediaVideoRequest(route('qwen', 'wan2.7-r2v'), { prompt: 'a cat', images: [REFERENCE] })
    expect(request.body.input).toEqual({ prompt: 'a cat', media: [{ type: 'reference_image', url: REFERENCE }] })
  })

  it('moves the Vidu route with the mode and keeps every frame in images[]', () => {
    // The mode is not a body flag for Vidu: it names the endpoint.
    expect(mediaVideoRequest(route('vidu', 'viduq3-pro'), { prompt: 'a cat', image: 'https://cdn.example/first.png', lastImage: 'https://cdn.example/last.png' }).endpoint)
      .toEqual(['/ent/v2/start-end2video', '/ent/v2/img2video'])
    expect(mediaVideoRequest(route('vidu', 'viduq3-pro'), { prompt: 'a cat', image: 'https://cdn.example/first.png', lastImage: 'https://cdn.example/last.png' }).body)
      .toEqual({ model: 'viduq3-pro', prompt: 'a cat', images: ['https://cdn.example/first.png', 'https://cdn.example/last.png'] })
    expect(mediaVideoRequest(route('vidu', 'viduq3-mix'), { prompt: 'a cat', images: [REFERENCE] })).toMatchObject({
      endpoint: ['/ent/v2/reference2video', '/ent/v2/img2video'],
      body: { images: [REFERENCE] },
    })
  })

  it('carries the xAI reference set in the field the compatible layer reads', () => {
    expect(mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'a cat', images: [REFERENCE] }).body)
      .toMatchObject({ reference_images: [{ url: REFERENCE }] })
  })

  it('adds the reference set to the gateway body without disturbing the rest', () => {
    const withReferences = mediaVideoRequest(route('freecodego', 'kling-v2'), { prompt: 'a cat', seconds: 5, images: [REFERENCE] })
    expect(withReferences.body).toMatchObject({ model: 'kling-v2', prompt: 'a cat', seconds: 5, reference_images: [{ url: REFERENCE }] })
    // The reference-free request is exactly what the gateway has always received.
    expect(mediaVideoRequest(route('freecodego', 'kling-v2'), { prompt: 'a cat', seconds: 5 }).body).toEqual({ model: 'kling-v2', prompt: 'a cat', seconds: 5 })
  })

  it('steps aside instead of dropping media a protocol has no field for', () => {
    // A silently discarded reference image is worse than a route that fails:
    // the fallback chain then reaches a provider that can actually use it.
    expect(() => mediaVideoRequest(route('minimax', 'MiniMax-H3'), { prompt: 'a cat', lastImage: 'https://cdn.example/l.png' })).toThrow(/A last frame is unavailable/)
    expect(() => mediaVideoRequest(route('minimax', 'MiniMax-H3'), { prompt: 'a cat', images: [REFERENCE] })).toThrow(/Reference images are unavailable/)
    expect(() => mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'a cat', lastImage: 'https://cdn.example/l.png' })).toThrow(/A last frame is unavailable/)
    expect(() => mediaVideoRequest(route('google', 'veo-3.1'), { prompt: 'a cat', images: [REFERENCE] })).toThrow(/Reference images are unavailable/)
  })

  it('validates every protocol\'s source frames, not only the image endpoint', () => {
    expect(() => mediaVideoRequest(route('volcengine', 'doubao-seedance'), { prompt: 'a cat', image: 'C:/secrets/id_rsa' })).toThrow(/Invalid request: the first frame must be/)
    expect(() => mediaVideoRequest(route('qwen', 'wan3.0-video'), { prompt: 'a cat', images: ['/tmp/local.png'] })).toThrow(/Invalid request: reference images must be/)
    expect(() => mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'a cat', video: 'file:///tmp/in.mp4' })).toThrow(/Invalid request: video must be an http\(s\) URL/)
  })

  it('serves Kling from the route its frames call for', () => {
    // Kling splits text, image, and multi-image generation across three routes
    // and repeats the create path on the status call.
    const text = mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat', seconds: 5, aspectRatio: '16:9' })
    expect(text.endpoint).toBe('/videos/text2video')
    expect(text.statusPath).toBe('/videos/text2video')
    expect(text.body).toEqual({ model_name: 'kling-v2-1', prompt: 'a cat', duration: '5', aspect_ratio: '16:9' })
    // The body names the model itself, so the transport must not add `model`.
    expect(text.modelField).toBe(false)

    const image = mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat', image: 'https://cdn.example/first.png', aspectRatio: '16:9' })
    expect(image.endpoint).toBe('/videos/image2video')
    // The frame decides the ratio on this route, so no aspect_ratio travels.
    expect(image.body).toEqual({ model_name: 'kling-v2-1', prompt: 'a cat', image: 'https://cdn.example/first.png', duration: '5' })
  })

  it('unwraps an inline frame to the bare base64 Kling parses', () => {
    // Its own SDK sends base64, never a data URL.
    const request = mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat', image: `data:image/png;base64,${PNG_BASE64}` })
    expect(request.body.image).toBe(PNG_BASE64)
  })

  it('interpolates between two Kling frames through image_tail', () => {
    const request = mediaVideoRequest(route('kling', 'kling-v2-1'), {
      prompt: 'a cat',
      image: 'https://cdn.example/first.png',
      lastImage: 'https://cdn.example/last.png',
    })
    expect(request.endpoint).toBe('/videos/image2video')
    expect(request.body).toMatchObject({ image: 'https://cdn.example/first.png', image_tail: 'https://cdn.example/last.png' })
  })

  it('carries a Kling reference set on the multi-image route', () => {
    const request = mediaVideoRequest(route('kling', 'kling-v2-1'), {
      prompt: 'a cat',
      images: [REFERENCE, 'https://cdn.example/ref2.png'],
      lastImage: 'https://cdn.example/last.png',
    })
    expect(request.endpoint).toBe('/videos/multi-image2video')
    expect(request.body).toEqual({
      model_name: 'kling-v2-1',
      prompt: 'a cat',
      image_list: [REFERENCE, 'https://cdn.example/ref2.png'],
      image_tail: 'https://cdn.example/last.png',
      duration: '5',
    })
  })

  it('spells each Kling length as the string its routes accept', () => {
    // Both lengths the routes take, verbatim, plus the default when none is asked
    // for. Any other length never reaches this body: the builder refuses it as the
    // route's limitation so the ladder can ask a route that renders it, instead of
    // returning a video whose length was quietly changed.
    expect(mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat', seconds: 5 }).body.duration).toBe('5')
    expect(mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat', seconds: 10 }).body.duration).toBe('10')
    expect(mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'a cat' }).body.duration).toBe('5')
  })

  it('polls Kling through the route the create call chose', () => {
    expect(videoStatusEndpoint(route('kling', 'kling-v2-1'), {}, 'task-1', '/videos/image2video')).toBe('/videos/image2video/task-1')
    expect(videoStatusEndpoint(route('kling', 'kling-v2-1'), {}, 'task-1', '/videos/multi-image2video')).toBe('/videos/multi-image2video/task-1')
    // A call that did not come through the builder keeps the text route.
    expect(videoStatusEndpoint(route('kling', 'kling-v2-1'), {}, 'task-1')).toBe('/videos/text2video/task-1')
  })

  it('keeps video editing off the Kling routes', () => {
    // Kling extends by task id, not by URL, so a source URL has nowhere to go.
    expect(() => mediaVideoRequest(route('kling', 'kling-v2-1'), { prompt: 'longer', video: 'https://cdn.example/in.mp4' }))
      .toThrow(/Video editing is unavailable on the "kling"/)
  })

  it('turns a source video into an edit or an extension', () => {
    // The edit route rejects a duration; only an extension takes one, so the
    // presence of a length decides which route is tried first.
    expect(mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'make it night', video: 'https://cdn.example/in.mp4' })).toEqual({
      endpoint: ['/videos/edits', '/videos/extensions'],
      body: { model: 'grok-imagine-video', prompt: 'make it night', video: { url: 'https://cdn.example/in.mp4' } },
    })
    expect(mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'keep going', video: 'https://cdn.example/in.mp4', seconds: 8 })).toEqual({
      endpoint: ['/videos/extensions', '/videos/edits'],
      body: { model: 'grok-imagine-video', prompt: 'keep going', video: { url: 'https://cdn.example/in.mp4' }, duration: 8 },
    })
    // An extension takes a length exactly as a generation does, so a length beyond
    // the window is this route's limitation on the source-video path too: the
    // refusal sits before the branch that chooses between edit and extend, and it
    // is raised as a `MediaRouteLimitation` so the ladder may try another edit route.
    const refusal = (() => { try { mediaVideoRequest(route('xai', 'grok-imagine-video'), { prompt: 'keep going', video: 'https://cdn.example/in.mp4', seconds: 30 }); return undefined } catch (cause: unknown) { return cause } })()
    expect(refusal).toBeInstanceOf(MediaRouteLimitation)
    expect((refusal as Error).message).toBe('xai renders 2 through 10 seconds, not 30')
  })

  it('steps aside for a source video no other protocol can edit', () => {
    expect(() => mediaVideoRequest(route('freecodego', 'kling-v2'), { prompt: 'make it night', video: 'https://cdn.example/in.mp4' }))
      .toThrow(/Video editing is unavailable on the "freecodego"/)
  })

  it('refuses a first frame and a reference set in the same request', () => {
    // Both vendor families reject the combination, so it never reaches a provider.
    expect(() => mediaVideoRequest(route('volcengine', 'doubao-seedance-2-0'), { prompt: 'a cat', image: 'https://cdn.example/f.png', images: [REFERENCE] }))
      .toThrow(/either image \(first frame\) or images \(reference set\)/)
  })
})

describe('referenceImageUrls', () => {
  it('accepts empty and http(s)/data URLs, trimming each entry', () => {
    expect(referenceImageUrls(undefined)).toEqual([])
    expect(referenceImageUrls(['  https://cdn.example/a.png  ', '', 'data:image/png;base64,aGk='])).toEqual(['https://cdn.example/a.png', 'data:image/png;base64,aGk='])
  })

  it('rejects anything that is not a fetchable image URL', () => {
    // A bare path would have to be read by the Host and uploaded, which is a
    // separately guarded operation — and it must fail where the caller can fix it.
    expect(() => referenceImageUrls(['C:/secrets/id_rsa'])).toThrow(/must be http\(s\) or data:image URLs/)
    expect(() => referenceImageUrls(['file:///etc/passwd'])).toThrow(/must be http\(s\) or data:image URLs/)
    expect(() => referenceImageUrls(['data:text/plain;base64,aGk='])).toThrow(/must be http\(s\) or data:image URLs/)
    expect(() => referenceImageUrls(Array.from({ length: REFERENCE_IMAGE_LIMIT + 1 }, () => REFERENCE))).toThrow(/at most 8 reference images/)
  })

  it('splits an inline data URL and guesses a remote media type', () => {
    expect(dataUrlImage('data:image/png;base64,aGk=')).toEqual({ mimeType: 'image/png', data: 'aGk=' })
    expect(dataUrlImage('https://cdn.example/a.png')).toBeUndefined()
    expect(guessImageMediaType('https://cdn.example/a.jpeg?x=1')).toBe('image/jpeg')
    expect(guessImageMediaType('https://cdn.example/a.webp')).toBe('image/webp')
    expect(guessImageMediaType('https://cdn.example/a')).toBe('image/png')
  })

  it('only Seedream takes sources on its generations body', () => {
    expect(imagesViaGenerationBody('volcengine')).toBe(true)
    expect(imagesViaGenerationBody('ark')).toBe(true)
    expect(imagesViaGenerationBody('freecodego')).toBe(false)
    expect(imagesViaGenerationBody('logfare')).toBe(false)
    expect(imagesViaGenerationBody('openai')).toBe(false)
  })
})

/**
 * The image request as the transport actually sends it: a stub host records the
 * endpoint and body of every call, so a protocol change is observable without
 * a network.
 */
const imageHost = (input: { provider: string; model: string; respond?: (endpoint: string, body: Record<string, unknown>) => unknown }): { readonly host: unknown; readonly calls: Array<{ readonly endpoint: string; readonly body: Record<string, unknown> }> } => {
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = []
  const host = {
    ctx: {
      get: (name: string) => name === 'attachments'
        ? { saveImage: async () => ({ attachmentId: 'att-1', mediaType: 'image/png', bytes: 8, width: 1, height: 1 }) }
        : name === 'llm' ? { listProviders: () => [], listModels: async () => [] } : undefined,
    },
    policy: { get: () => ({ mediaDefaults: { image: `${input.provider}/${input.model}` } }) },
    capabilities: { configuration: () => ({ modelCategories: {} }) },
    readManagedCatalogCache: async () => undefined,
    logfareApiKey: async () => undefined,
    requireAgnes: () => { throw new Error('Agnes is not configured') },
    mediaRoute: (selection: string) => ({ selection, provider: input.provider, model: input.model }),
    credentials: { resolve: async () => ({ value: 'test-key' }) },
    gatewayMediaJson: async (_model: string, endpoint: string | readonly string[], body: Record<string, unknown>): Promise<unknown> => {
      const name = typeof endpoint === 'string' ? endpoint : endpoint[0] ?? ''
      calls.push({ endpoint: name, body })
      return input.respond === undefined ? { data: [{ b64_json: PNG_BASE64 }] } : input.respond(name, body)
    },
  }
  return { host, calls }
}

describe('generateImageWithFallback', () => {
  it('keeps the gateway GPT Image request byte-identical when no source is attached', async () => {
    // The original protocol is not a fallback: with no reference images the
    // request is what the gateway has always received.
    const { host, calls } = imageHost({ provider: 'freecodego', model: 'gpt-image-2' })
    await generateImageWithFallback(host as never, { prompt: 'a cat' }, new AbortController().signal)
    expect(calls).toEqual([{ endpoint: '/images/generations', body: { model: 'gpt-image-2', prompt: 'a cat', n: 1 } }])
  })

  it('keeps the logfare request on the same generations shape', async () => {
    const { host, calls } = imageHost({ provider: 'logfare', model: 'gpt-image-1.5' })
    await generateImageWithFallback(host as never, { prompt: 'a cat', size: '1024x1024' }, new AbortController().signal)
    expect(calls[0]?.endpoint).toBe('/images/generations')
    expect(calls[0]?.body).toEqual({ model: 'gpt-image-1.5', prompt: 'a cat', size: '1024x1024', n: 1 })
  })

  it('edits through the OpenAI-shaped endpoint and falls back to a generation body', async () => {
    const { host, calls } = imageHost({
      provider: 'freecodego',
      model: 'gpt-image-2',
      // A gateway without the edits route answers 404/405/501.
      respond: (endpoint) => endpoint === '/images/edits'
        ? (() => { throw new Error('FreeCodeGo /images/edits failed with HTTP 404: not found') })()
        : { data: [{ b64_json: PNG_BASE64 }] },
    })
    await generateImageWithFallback(host as never, { prompt: 'a cat', images: [REFERENCE, 'https://cdn.example/ref2.png'] }, new AbortController().signal)
    expect(calls[0]?.endpoint).toBe('/images/edits')
    // The edits JSON contract: first source as `image`, the rest as `images[]`.
    expect(calls[0]?.body).toMatchObject({ image: { url: REFERENCE }, images: [{ url: 'https://cdn.example/ref2.png' }] })
    expect(calls[1]?.endpoint).toBe('/images/generations')
    expect(calls[1]?.body).toMatchObject({ image: [REFERENCE, 'https://cdn.example/ref2.png'] })
  })

  it('keeps Seedream on its own generations body and passes sources as image[]', async () => {
    const { host, calls } = imageHost({ provider: 'volcengine', model: 'doubao-seedream-4-0' })
    await generateImageWithFallback(host as never, { prompt: 'a cat', size: '2K', images: [REFERENCE] }, new AbortController().signal)
    expect(calls[0]?.endpoint).toBe('/images/generations')
    expect(calls[0]?.body).toMatchObject({ prompt: 'a cat', size: '2K', image: [REFERENCE] })
  })

  it('attaches DashScope sources as content parts and writes its own size form', async () => {
    const { host, calls } = imageHost({
      provider: 'qwen',
      model: 'qwen-image-3.0',
      respond: () => ({ output: { choices: [{ message: { content: [{ image: 'https://cdn.example/out.png' }] } }] } }),
    })
    // The result URL is remote, so the Host would normally pull its bytes; the
    // offline stub keeps the assertion on the parsed URL instead of the network.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    try {
      const result = await generateImageWithFallback(host as never, { prompt: 'a cat', size: '2048x2048', images: [REFERENCE] }, new AbortController().signal) as { readonly images: readonly { readonly url?: string }[] }
      expect(calls[0]?.endpoint).toBe('/api/v1/services/aigc/multimodal-generation/generation')
      expect(calls[0]?.body).toMatchObject({
        input: { messages: [{ role: 'user', content: [{ text: 'a cat' }, { image: REFERENCE }] }] },
        // DashScope spells its size with an asterisk.
        parameters: { size: '2048*2048', watermark: false },
      })
      // The DashScope-shaped answer is a real result, not a failed download.
      expect(result.images[0]?.url).toBe('https://cdn.example/out.png')
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('rejects a local file path before any provider is contacted', async () => {
    const { host, calls } = imageHost({ provider: 'freecodego', model: 'gpt-image-2' })
    await expect(generateImageWithFallback(host as never, { prompt: 'a cat', images: ['C:/secrets/id_rsa'] }, new AbortController().signal))
      .rejects.toThrow(/Invalid request/)
    expect(calls).toEqual([])
  })

  it('steps aside on the Agnes transport instead of dropping the sources', async () => {
    const { host, calls } = imageHost({ provider: 'agnes', model: 'agnes-image-2.5-flash' })
    await expect(generateImageWithFallback(host as never, { prompt: 'a cat', images: [REFERENCE] }, new AbortController().signal))
      .rejects.toThrow(/Reference images are unavailable on the "agnes" media route/)
    expect(calls).toEqual([])
  })
})

describe('videoStatusEndpoint', () => {
  it('routes each protocol to its own status route', () => {
    expect(videoStatusEndpoint(route('kling', 'kling-v2'), {}, 't1')).toBe('/videos/text2video/t1')
    expect(videoStatusEndpoint(route('volcengine', 'seedance'), {}, 't1')).toBe('/contents/generations/tasks/t1')
    expect(videoStatusEndpoint(route('qwen', 'wan3.0-video'), {}, 't1')).toBe('/api/v1/tasks/t1')
    expect(videoStatusEndpoint(route('minimax', 'MiniMax-H3'), {}, 't1')).toBe('/v2/query/video_generation/t1')
    expect(videoStatusEndpoint(route('vidu', 'viduq3-pro'), {}, 't1')).toBe('/ent/v2/tasks/t1/creations')
    expect(videoStatusEndpoint(route('xai', 'grok-imagine-video'), {}, 't1')).toBe('/videos/t1')
    expect(videoStatusEndpoint(route('freecodego', 'kling-v2'), {}, 't1')).toBe('/videos/generations/t1')
  })

  it('keeps the Gemini operation name as the absolute status route', () => {
    expect(videoStatusEndpoint(route('google', 'veo-3.1'), { name: 'models/veo-3.1/operations/abc' }, 't1')).toBe('/models/veo-3.1/operations/abc')
  })
})

describe('generatedVideoResult', () => {
  it('reads xAI request_id, pending/done status, and the nested video URL', () => {
    expect(generatedVideoResult('grok-imagine-video', { request_id: 'req_1' }).videoId).toBe('req_1')
    expect(generatedVideoResult('grok-imagine-video', { status: 'pending', model: 'grok-imagine-video', progress: 40 }).status).toBe('pending')
    expect(generatedVideoResult('grok-imagine-video', { status: 'done', progress: 100, video: { url: 'https://cdn.example/v.mp4' } }))
      .toMatchObject({ status: 'completed', url: 'https://cdn.example/v.mp4' })
  })

  it('surfaces the xAI error object as the failure detail', () => {
    expect(generatedVideoResult('grok-imagine-video', { status: 'failed', error: { code: 'invalid_argument', message: 'bad prompt' } }))
      .toMatchObject({ status: 'failed', error: 'bad prompt' })
  })

  it('reads DashScope output.task_id and output.task_status', () => {
    expect(generatedVideoResult('wan3.0-video', { request_id: 'req_2', output: { task_id: 'dash_1', task_status: 'PENDING' } }).videoId).toBe('dash_1')
    expect(generatedVideoResult('wan3.0-video', { output: { task_status: 'RUNNING' } }).status).toBe('running')
    expect(generatedVideoResult('wan3.0-video', { output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example/d.mp4' } }))
      .toMatchObject({ status: 'completed', url: 'https://cdn.example/d.mp4' })
    expect(generatedVideoResult('wan3.0-video', { output: { task_status: 'FAILED', message: 'content policy' } }))
      .toMatchObject({ status: 'failed', error: 'content policy' })
    expect(generatedVideoResult('wan3.0-video', { output: { task_status: 'CANCELED' } }).status).toBe('cancelled')
  })

  it('reads MiniMax task.status and Vidu state/creations', () => {
    expect(generatedVideoResult('MiniMax-H3', { task_id: 'mm_1' }).videoId).toBe('mm_1')
    expect(generatedVideoResult('MiniMax-H3', { task: { status: 'succeeded' } }).status).toBe('completed')
    expect(generatedVideoResult('MiniMax-H3', { task: { status: 'Fail' } }).status).toBe('failed')
    expect(generatedVideoResult('viduq3-pro', { task_id: 'vidu_1', state: 'success', creations: [{ url: 'https://cdn.example/v.mp4' }] }))
      .toMatchObject({ videoId: 'vidu_1', status: 'completed', url: 'https://cdn.example/v.mp4' })
    expect(generatedVideoResult('viduq3-pro', { state: 'processing' }).status).toBe('processing')
  })

  it('treats an expired Ark task as failed instead of polling it for ten minutes', () => {
    expect(generatedVideoResult('doubao-seedance-2-0', { id: 'ark_1', status: 'expired' }).status).toBe('failed')
  })
})

describe('provider defaults', () => {
  it('resolves a base URL and credential reference for each new family', () => {
    expect(defaultMediaBaseURL('qwen')).toBe('https://dashscope.aliyuncs.com')
    expect(defaultMediaBaseURL('dashscope')).toBe('https://dashscope.aliyuncs.com')
    expect(defaultMediaBaseURL('minimax')).toBe('https://api.minimaxi.com')
    expect(defaultMediaBaseURL('vidu')).toBe('https://api.vidu.cn')
    expect(defaultMediaCredentialRef('qwen')).toBe('DASHSCOPE_API_KEY')
    expect(defaultMediaCredentialRef('minimax')).toBe('MINIMAX_API_KEY')
    expect(defaultMediaCredentialRef('vidu')).toBe('VIDU_API_KEY')
  })

  it('authenticates Vidu with its Token scheme and everyone else with Bearer', () => {
    // Vidu answers 401 to `Bearer`; the scheme belongs to the provider.
    expect(defaultMediaAuthScheme('vidu')).toBe('token')
    expect(defaultMediaAuthScheme('qwen')).toBe('bearer')
    expect(defaultMediaAuthScheme('freecodego')).toBe('bearer')
  })
})

describe('isNativeDashscopeRoute', () => {
  // The provider profile comes from the Harness Models *entry*, not from a namespace this
  // plugin registered: a peer read is `describe()` filtered by entry id (see
  // `peer-settings.ts`), so the double answers that call and names the entry it is answering for.
  const host = (profile: Record<string, unknown>): unknown => ({
    ctx: { get: (name: string) => name === 'settings'
      ? { describe: () => [settingsDescriptor(MODELS_SETTINGS_ENTRY, { providers: { qwen: profile } })] }
      : undefined },
    credentials: { resolve: async () => ({ value: 'test-key' }) },
  })

  it('uses the native multimodal route for a DashScope profile', async () => {
    await expect(isNativeDashscopeRoute(host({}) as never, route('qwen', 'qwen-image-3'))).resolves.toBe(true)
  })

  it('keeps the portable shape for a compatible-mode or OpenAI-typed profile', async () => {
    // DashScope also serves an OpenAI-compatible endpoint; a profile pointed
    // there must not be sent the native multimodal body.
    await expect(isNativeDashscopeRoute(host({ baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }) as never, route('qwen', 'qwen-image-3'))).resolves.toBe(false)
    await expect(isNativeDashscopeRoute(host({ api: 'openai-completions' }) as never, route('qwen', 'qwen-image-3'))).resolves.toBe(false)
  })

  it('never claims a route from another provider family', async () => {
    await expect(isNativeDashscopeRoute(host({}) as never, route('google', 'gemini-3-pro-image'))).resolves.toBe(false)
    await expect(isNativeDashscopeRoute(host({}) as never, route('freecodego', 'qwen-image-3'))).resolves.toBe(false)
  })
})

describe('Kling authentication', () => {
  it('mints the HS256 token its own SDK mints', () => {
    const token = signKlingJwt('access-key', 'secret-key', 1_700_000_000)
    const [header, payload, signature] = token.split('.')
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))).toEqual({ iss: 'access-key', exp: 1_700_001_800, nbf: 1_699_999_995 })
    // The signature is the part the API verifies, so it is checked against the
    // same HMAC rather than against a recorded string.
    expect(signature).toBe(createHmac('sha256', 'secret-key').update(`${header}.${payload}`).digest('base64url'))
  })

  const klingHost = (): unknown => ({
    ctx: { get: (name: string) => name === 'settings'
      ? { describe: () => [settingsDescriptor(MODELS_SETTINGS_ENTRY, { providers: { kling: {} } })] }
      : undefined },
    credentials: { resolve: async () => undefined },
    mediaRoute: (selection: string) => ({ selection, provider: 'kling', model: 'kling-v2-1' }),
    directConnection: async () => undefined,
    managedRuntime: async () => ({ openAIBaseUrl: 'https://gateway.example/v1', openAIToken: 'gateway' }),
  })

  /** Run a case with exactly the Kling credentials it names in the environment. */
  const withKlingCredentials = async (values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> => {
    const names = ['KLING_ACCESS_KEY', 'KLING_SECRET_KEY', 'KLING_API_KEY']
    const saved = names.map(name => [name, process.env[name]] as const)
    try {
      for (const name of names) delete process.env[name]
      for (const [name, value] of Object.entries(values)) if (value !== undefined) process.env[name] = value
      await run()
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  it('bears a minted token when the key pair is configured', async () => {
    await withKlingCredentials({ KLING_ACCESS_KEY: 'ak', KLING_SECRET_KEY: 'sk' }, async () => {
      const transport = await mediaTransport(klingHost() as never, 'kling/kling-v2-1')
      expect(transport.url('/videos/text2video')).toBe('https://api-beijing.klingai.com/v1/videos/text2video')
      const token = /^Bearer (.+)$/u.exec(transport.headers.authorization ?? '')?.[1]
      expect(token).toBeDefined()
      // The access key is the issuer of the token the request carries.
      expect(JSON.parse(Buffer.from(token!.split('.')[1] ?? '', 'base64url').toString('utf8'))).toMatchObject({ iss: 'ak' })
    })
  })

  it('keeps the plain bearer form for a single-key reseller', async () => {
    await withKlingCredentials({ KLING_API_KEY: 'reseller-key' }, async () => {
      const transport = await mediaTransport(klingHost() as never, 'kling/kling-v2-1')
      expect(transport.headers.authorization).toBe('Bearer reseller-key')
    })
  })
})
