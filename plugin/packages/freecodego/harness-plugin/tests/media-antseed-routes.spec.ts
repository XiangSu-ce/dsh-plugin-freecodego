/**
 * The gateway's free image models are part of the image ladder.
 *
 * The plugin's model adapter deliberately files them nowhere near the chat
 * picker: an image row is generated media, and offering it as a conversation
 * would present a route that cannot answer one. They reach generation through
 * this ladder instead — the same door Agnes uses — so what is asserted here is
 * that door: the buyer's own directory becomes candidates, a request that
 * reaches it is answered and stored, and a request this transport cannot carry
 * is refused rather than quietly sent without the picture the caller attached.
 *
 * The two states a closed gateway produces — no directory, an unreadable one —
 * are asserted to be invisible to the ladder, because "the switch is off" is the
 * state the user chose, not a failure they should be shown.
 */

import { describe, expect, it } from 'vitest'
import { generateImageWithFallback, mediaCandidates } from '../src/media-generation.ts'

const SOURCE = 'https://cdn.example/source.png'

/** The eight-byte PNG signature, base64: the bytes `persistGeneratedImages` sniffs as an image. */
const PNG_BASE64 = 'iVBORw0KGgo='

interface ModelRow { readonly id: string; readonly name: string }

interface HostInput {
  readonly imageModels?: readonly ModelRow[]
  readonly directoryFailure?: Error
  readonly preferred?: string
}

interface Stub {
  readonly host: unknown
  /** Every call the buyer transport received. */
  readonly generated: { readonly model: string; readonly prompt: string }[]
  /** Every image the attachment store was handed. */
  readonly saved: { readonly mediaType: string }[]
}

/**
 * A host whose gateway directory is what the case says, and whose every other
 * route source is empty.
 *
 * The gateway transport throws if it is reached at all: a gateway route that
 * fell through to the buyer would still produce a picture here, and the test
 * would pass while the feature was wired to the wrong door.
 */
function antSeedHost(input: HostInput = {}): Stub {
  const generated: Stub['generated'] = []
  const saved: Stub['saved'] = []
  const host = {
    ctx: {
      get: (name: string) => {
        if (name === 'llm') return { listProviders: () => [{ id: 'antseed' }], listModels: async () => [] }
        if (name === 'attachments') {
          return {
            saveImage: async (image: { readonly data: Uint8Array; readonly mediaType: string }) => {
              saved.push({ mediaType: image.mediaType })
              return { attachmentId: 'att-1', mediaType: image.mediaType, bytes: image.data.length, width: 1, height: 1 }
            },
          }
        }
        return undefined
      },
    },
    capabilities: { configuration: () => ({ modelCategories: {} }) },
    policy: { get: () => ({ mediaDefaults: { image: input.preferred ?? 'antseed/flux-2-pro' } }) },
    readManagedCatalogCache: async () => undefined,
    logfareApiKey: async () => undefined,
    logfareModels: async () => [],
    requireAgnes: () => ({ agnesMediaModels: async () => [] }),
    credentials: { resolve: async () => undefined },
    antSeedImageModels: async () => {
      if (input.directoryFailure !== undefined) throw input.directoryFailure
      return input.imageModels ?? []
    },
    generateAntSeedImage: async (model: string, args: { readonly prompt: string }) => {
      generated.push({ model, prompt: args.prompt })
      return { data: [{ b64_json: PNG_BASE64 }] }
    },
    mediaRoute: (value: string) => {
      const slash = value.indexOf('/')
      return slash === -1
        ? { selection: value, provider: 'freecodego', model: value }
        : { selection: value, provider: value.slice(0, slash), model: value.slice(slash + 1) }
    },
    directConnection: async () => undefined,
    managedRuntime: async () => undefined,
    gatewayMediaJson: async () => { throw new Error('the gateway must not be asked for a free-model route') },
  }
  return { host, generated, saved }
}

const selections = (routes: readonly { readonly selection: string }[]): readonly string[] => routes.map(route => route.selection)

describe('the AntSeed buyer as an image route', () => {
  it('offers the free image models the buyer itself listed', async () => {
    // The directory is the authority: the card shows the user the same rows, and
    // a model that appears in one place and not the other is a promise the
    // settings page cannot keep.
    const { host } = antSeedHost({ imageModels: [{ id: 'flux-2-pro', name: 'FLUX 2 Pro' }, { id: 'qwen-image-3', name: 'Qwen Image 3' }] })
    const routes = await mediaCandidates(host as never, 'image', 'nowhere/none')
    expect(selections(routes)).toEqual(['nowhere/none', 'antseed/flux-2-pro', 'antseed/qwen-image-3'])
  })

  it('keeps the ladder usable when the gateway is shut or its directory is unreachable', async () => {
    // Both are the same non-event for a user who asked for a picture: the switch
    // is off, or the buyer is not answering. Neither is a route failure to report.
    const shut = antSeedHost({ imageModels: [] })
    expect(selections(await mediaCandidates(shut.host as never, 'image', 'freecodego/gpt-image-2'))).toEqual(['freecodego/gpt-image-2'])

    const unreachable = antSeedHost({ directoryFailure: new Error('ECONNREFUSED 127.0.0.1:8390') })
    expect(selections(await mediaCandidates(unreachable.host as never, 'image', 'freecodego/gpt-image-2'))).toEqual(['freecodego/gpt-image-2'])
  })

  it('generates through the buyer and stores the bytes it answered with', async () => {
    const { host, generated, saved } = antSeedHost({ imageModels: [{ id: 'flux-2-pro', name: 'FLUX 2 Pro' }] })
    const result = await generateImageWithFallback(host as never, { prompt: 'a cat' }, new AbortController().signal)

    expect(generated).toEqual([{ model: 'flux-2-pro', prompt: 'a cat' }])
    // The provider prefix is the selection the settings page stores and shows, so
    // the result names the route the user chose rather than the bare seller id.
    expect(result).toMatchObject({ model: 'antseed/flux-2-pro' })
    expect(saved).toEqual([{ mediaType: 'image/png' }])
  })

  it('refuses a request carrying a source image instead of dropping it', async () => {
    // This transport sends JSON and the endpoint that would take a source is
    // multipart, so the picture cannot travel. Answering anyway would return an
    // unrelated image as though the edit had been applied.
    const { host, generated } = antSeedHost({ imageModels: [{ id: 'flux-2-pro', name: 'FLUX 2 Pro' }] })
    const error = await generateImageWithFallback(host as never, { prompt: 'put the cat in a hat', images: [SOURCE] }, new AbortController().signal)
      .catch((cause: unknown) => cause)

    expect((error as Error).message).toContain('Reference images are unavailable on the private-key gateway media route')
    expect(generated).toEqual([])
  })
})
