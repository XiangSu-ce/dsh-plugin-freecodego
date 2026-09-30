import { describe, expect, it, vi } from 'vitest'
import {
  ANTSEED_PLACEHOLDER_API_KEY,
  ANTSEED_PROVIDER_ID,
  antSeedLoopbackBaseUrl,
  isAntSeedPort,
  listAntSeedModels,
  listFreeAntSeedModels,
  parseAntSeedModelDirectory,
  readAntSeedCatalog,
  requestAntSeedImage,
  resolveAntSeedConnection,
  toAntSeedModelInfo,
} from '../src/antseed/provider.ts'

/** A fetch implementation returning one canned response. */
function answering(response: Partial<Response>): typeof fetch {
  return vi.fn(async () => response as Response)
}

/** A response carrying a JSON body. */
function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

/** One `/v1/models` entry with the offers given. */
function model(id: string, offers: readonly unknown[], name?: string): Record<string, unknown> {
  return { id, ...(name === undefined ? {} : { name }), peers: offers }
}

/** A directory body. */
function directory(...models: readonly unknown[]): Record<string, unknown> {
  return { data: models }
}

/**
 * The price shape the live network advertises, one entry per interesting case.
 *
 * `freeText` and `paidText` are real offers read off the network; `paidImage` is
 * the one that matters most — every image seller on the live network publishes
 * `inputUsdPerMillion: 0, outputUsdPerMillion: 0` and bills per picture, so a
 * reader that only looked at the token fields would call all 39 of them free.
 */
const freeText = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
const paidText = { inputUsdPerMillion: 0.000663, outputUsdPerMillion: 0.002658 }
const freeImage = { inputUsdPerMillion: 0, outputUsdPerMillion: 0, minImageUsdPerImage: 0, maxImageUsdPerImage: 0 }
const paidImage = { inputUsdPerMillion: 0, outputUsdPerMillion: 0, minImageUsdPerImage: 0.05, maxImageUsdPerImage: 0.05 }

describe('AntSeed provider', () => {
  describe('port rule', () => {
    it('accepts ports a normal user can bind', () => {
      expect(isAntSeedPort(1024)).toBe(true)
      expect(isAntSeedPort(8390)).toBe(true)
      expect(isAntSeedPort(65535)).toBe(true)
    })

    it('refuses privileged, out-of-range and non-integral values', () => {
      expect(isAntSeedPort(1023)).toBe(false)
      expect(isAntSeedPort(65536)).toBe(false)
      expect(isAntSeedPort(0)).toBe(false)
      expect(isAntSeedPort(8390.5)).toBe(false)
      expect(isAntSeedPort(Number.NaN)).toBe(false)
      expect(isAntSeedPort(Number.POSITIVE_INFINITY)).toBe(false)
    })
  })

  describe('loopback base URL', () => {
    it('names 127.0.0.1, not localhost', () => {
      // `localhost` resolves to ::1 first on some Windows configurations while
      // the buyer binds IPv4; naming the address skips that resolution.
      expect(antSeedLoopbackBaseUrl(8390)).toBe('http://127.0.0.1:8390/v1')
    })

    it('refuses a port it cannot build an endpoint for', () => {
      expect(() => antSeedLoopbackBaseUrl(80)).toThrow('is not a usable port number')
    })
  })

  describe('parseAntSeedModelDirectory', () => {
    it('reads the OpenAI directory shape', () => {
      expect(parseAntSeedModelDirectory(directory(
        model('deepseek-v4-flash', [freeText], 'DeepSeek V4 Flash'),
        model('gpt-oss-120b', [freeText], 'gpt-oss 120b'),
      ))).toEqual([
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', kind: 'text', free: true },
        { id: 'gpt-oss-120b', name: 'gpt-oss 120b', kind: 'text', free: true },
      ])
    })

    it('stamps the listing a row came from', () => {
      // The two listings are disjoint and shape-identical, so the request that
      // produced a row is the only thing that can say which it is.
      expect(parseAntSeedModelDirectory(directory(model('qwen-image-3', [freeImage])), 'images')).toEqual([
        { id: 'qwen-image-3', name: 'qwen-image-3', kind: 'images', free: true },
      ])
    })

    it('falls back to the id when a row has no name', () => {
      expect(parseAntSeedModelDirectory(directory(model('glm-4.7-flash', [freeText]), model('x', [freeText], '   ')))).toEqual([
        { id: 'glm-4.7-flash', name: 'glm-4.7-flash', kind: 'text', free: true },
        { id: 'x', name: 'x', kind: 'text', free: true },
      ])
    })

    it('skips rows a request could not address', () => {
      // A row without an id is worse than an absent row: selecting it fails at
      // the wire with a message about the model rather than about the directory.
      expect(parseAntSeedModelDirectory(directory(
        null,
        'nope',
        { name: 'no id' },
        { id: '' },
        { id: '  ' },
        { id: 7 },
        model('ok', [freeText]),
        model('ok', [freeText]),
      ))).toEqual([{ id: 'ok', name: 'ok', kind: 'text', free: true }])
    })

    it('answers an empty list for a body that is not a directory', () => {
      expect(parseAntSeedModelDirectory(null)).toEqual([])
      expect(parseAntSeedModelDirectory('[]')).toEqual([])
      expect(parseAntSeedModelDirectory({})).toEqual([])
      expect(parseAntSeedModelDirectory({ data: 'nope' })).toEqual([])
      expect(parseAntSeedModelDirectory({ data: [] })).toEqual([])
    })
  })

  describe('the price a row is judged by', () => {
    /** The row ids a body parsed as free. */
    function freeIds(body: unknown, kind: 'text' | 'images' = 'text'): readonly string[] {
      return parseAntSeedModelDirectory(body, kind).filter(row => row.free).map(row => row.id)
    }

    it('calls a text offer at zero for input and output free', () => {
      expect(freeIds(directory(model('a', [freeText])))).toEqual(['a'])
    })

    it('refuses a text offer that charges for either direction', () => {
      // Either half is enough to be billed for: a seller charging for input
      // alone still charges.
      expect(freeIds(directory(model('in', [{ inputUsdPerMillion: 0.001, outputUsdPerMillion: 0 }])))).toEqual([])
      expect(freeIds(directory(model('out', [{ inputUsdPerMillion: 0, outputUsdPerMillion: 1 }])))).toEqual([])
    })

    it('refuses a text offer that prices cache hits', () => {
      // The second turn of a conversation reads cached input, so a published
      // cache price above zero is a price.
      expect(freeIds(directory(model('cached', [{ ...freeText, cachedInputUsdPerMillion: 0.0001 }])))).toEqual([])
      expect(freeIds(directory(model('zero-cache', [{ ...freeText, cachedInputUsdPerMillion: 0 }])))).toEqual(['zero-cache'])
    })

    it('refuses a text offer that advertises no price at all', () => {
      // Unknown is not zero. A peer the buyer cannot price is one its zero
      // ceiling drops before ranking, so the row is not reachable either way.
      expect(freeIds(directory(model('unknown', [{ inputUsdPerMillion: 0 }])))).toEqual([])
      expect(freeIds(directory(model('silent', [{}])))).toEqual([])
      // No offers at all is the same answer for a different reason: there is
      // nothing to route to.
      expect(freeIds(directory(model('offerless', [])))).toEqual([])
      expect(freeIds(directory({ id: 'peers-missing' }))).toEqual([])
      expect(freeIds(directory({ id: 'peers-not-a-list', peers: 'nope' }))).toEqual([])
    })

    it('reads only a finite, non-negative number as a price', () => {
      // `null`, a negative, a string and a non-finite number are all "not
      // advertised": reading any of them as zero is how a paid offer would end
      // up in a list the user was told was free.
      expect(freeIds(directory(model('nulls', [{ inputUsdPerMillion: null, outputUsdPerMillion: null }])))).toEqual([])
      expect(freeIds(directory(model('negative', [{ inputUsdPerMillion: -1, outputUsdPerMillion: 0 }])))).toEqual([])
      expect(freeIds(directory(model('strings', [{ inputUsdPerMillion: '0', outputUsdPerMillion: '0' }])))).toEqual([])
      expect(freeIds(directory(model('nan', [{ inputUsdPerMillion: Number.NaN, outputUsdPerMillion: 0 }])))).toEqual([])
      expect(freeIds(directory(model('infinite', [{ inputUsdPerMillion: 0, outputUsdPerMillion: Number.POSITIVE_INFINITY }])))).toEqual([])
    })

    it('ignores an offer that is not an object', () => {
      expect(freeIds(directory(model('mixed', [null, 'nope', freeText])))).toEqual(['mixed'])
      expect(freeIds(directory(model('only-junk', [null, 'nope'])))).toEqual([])
    })

    it('keeps a text row one free offer is enough for', () => {
      // The buyer runs with a zero price ceiling and its router drops every
      // offer above it before ranking, so the paid offers in this row cannot be
      // selected: hiding the row would hide a model that works, for free.
      expect(freeIds(directory(model('deepseek-v4-flash', [paidText, freeText])))).toEqual(['deepseek-v4-flash'])
    })

    it('judges an image row by its price per picture, not by its token price', () => {
      // This is the live network's shape and the reason this rule exists: 39
      // image offers all read `0 / 0` on the token fields and bill per picture.
      expect(freeIds(directory(model('nano-banana-2', [paidImage])), 'images')).toEqual([])
      expect(freeIds(directory(model('free-image', [freeImage])), 'images')).toEqual(['free-image'])
    })

    it('refuses an image row whose dearest size is billed', () => {
      // A seller charging nothing for 512x512 and 0.05 for 1024x1024 publishes
      // both, and a request from here names no size — so the row can be billed
      // at the higher one.
      expect(freeIds(directory(model('sized', [{
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        minImageUsdPerImage: 0,
        maxImageUsdPerImage: 0.05,
      }])), 'images')).toEqual([])
    })

    it('refuses an image row that bills only its cheapest offer', () => {
      // Every offer has to be free here, because the buyer's ceiling compares
      // token prices and has no image equivalent: a paid image offer stays
      // routable, so a mixed row is a row that can charge.
      expect(freeIds(directory(model('mixed-images', [freeImage, paidImage])), 'images')).toEqual([])
      expect(freeIds(directory(model('all-free-images', [freeImage, freeImage])), 'images')).toEqual(['all-free-images'])
    })

    it('does not read an image price as a token price', () => {
      // The reverse of the live-network trap, and a limit of the listing that is
      // deliberate rather than overlooked: the range below is the peer's
      // cheapest and dearest picture across every protocol it publishes for
      // this service, while the peer's own free-or-paid decision is made for the
      // protocol the request selected. A priced picture on a chat row therefore
      // does not establish that a chat completion is billed, and the unit model
      // never travels in this listing, so refusing the row over the range would
      // hide free chat models. Both ends are read here: a row the peer's gate
      // disagrees about is refused as a payment request — an error, not a
      // charge.
      expect(freeIds(directory(model('text-with-image-price', [{ ...freeText, minImageUsdPerImage: 0.02 }])))).toEqual(['text-with-image-price'])
      expect(freeIds(directory(model('text-with-dearest-image-price', [{ ...freeText, maxImageUsdPerImage: 0.05 }])))).toEqual(['text-with-dearest-image-price'])
      expect(freeIds(directory(model('text-with-open-range', [{ ...freeText, minImageUsdPerImage: 0, maxImageUsdPerImage: 0.05 }])))).toEqual(['text-with-open-range'])
    })

    it('refuses an image offer that still charges per token', () => {
      // The seller's own test needs both halves — a zero token price *and* a
      // zero priced unit — so a free picture behind a paid token price is a
      // seller that asks for a payment channel.
      expect(freeIds(directory(model('paid-tokens', [{ ...freeImage, inputUsdPerMillion: 4.5 }])), 'images')).toEqual([])
    })

    it('reads a single advertised image price as both ends of the range', () => {
      expect(freeIds(directory(model('min-only', [{ inputUsdPerMillion: 0, outputUsdPerMillion: 0, minImageUsdPerImage: 0 }])), 'images')).toEqual(['min-only'])
      expect(freeIds(directory(model('min-only-paid', [{ inputUsdPerMillion: 0, outputUsdPerMillion: 0, minImageUsdPerImage: 0.03 }])), 'images')).toEqual([])
    })
  })

  describe('listAntSeedModels', () => {
    it('reads the directory over the loopback endpoint', async () => {
      const fetchImplementation = answering({ ok: true, json: async () => directory(model('a', [freeText])) })
      await expect(listAntSeedModels({ port: 8390, fetchImplementation })).resolves.toEqual([{ id: 'a', name: 'a', kind: 'text', free: true }])
      expect(fetchImplementation).toHaveBeenCalledWith('http://127.0.0.1:8390/v1/models?type=text', expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: `Bearer ${ANTSEED_PLACEHOLDER_API_KEY}` }),
      }))
    })

    it('reads the image listing when asked for it', async () => {
      const fetchImplementation = answering({ ok: true, json: async () => directory(model('flux-2-pro', [freeImage])) })
      await expect(listAntSeedModels({ port: 8390, kind: 'images', fetchImplementation })).resolves.toEqual([
        { id: 'flux-2-pro', name: 'flux-2-pro', kind: 'images', free: true },
      ])
      expect(fetchImplementation).toHaveBeenCalledWith('http://127.0.0.1:8390/v1/models?type=images', expect.anything())
    })

    it('hands back the priced rows as well, marked as priced', async () => {
      // The primitive reader is the directory as it answered, paid rows and
      // all: dropping them here would leave nothing that could say how many
      // were left out, and the readiness wait reads exactly that.
      const fetchImplementation = answering({ ok: true, json: async () => directory(model('paid', [paidText])) })
      await expect(listAntSeedModels({ port: 8390, fetchImplementation })).resolves.toEqual([
        { id: 'paid', name: 'paid', kind: 'text', free: false },
      ])
    })
  })

  describe('listFreeAntSeedModels', () => {
    it('keeps the free rows of one listing and drops the rest', async () => {
      const fetchImplementation = answering({ ok: true, json: async () => directory(
        model('free', [freeText]),
        model('paid', [paidText]),
        model('billed-per-picture', [paidImage]),
      ) })
      await expect(listFreeAntSeedModels({ port: 8390, kind: 'images', fetchImplementation })).resolves.toEqual([
        { id: 'free', name: 'free', kind: 'images', free: true },
      ])
    })
  })

  describe('readAntSeedCatalog', () => {
    it('merges both free listings, text first', async () => {
      const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => respond(
        String(input).includes('images')
          ? directory(model('flux-2-pro', [freeImage]), model('qwen-image-3', [freeImage]))
          : directory(model('deepseek-v4-flash', [freeText]), model('gpt-oss-120b', [freeText])),
      ))
      await expect(readAntSeedCatalog({ port: 8390, fetchImplementation })).resolves.toEqual({
        models: [
          { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', kind: 'text', free: true },
          { id: 'gpt-oss-120b', name: 'gpt-oss-120b', kind: 'text', free: true },
          { id: 'flux-2-pro', name: 'flux-2-pro', kind: 'images', free: true },
          { id: 'qwen-image-3', name: 'qwen-image-3', kind: 'images', free: true },
        ],
        paid: 0,
      })
    })

    it('counts the priced rows it leaves out', async () => {
      // The count is what tells a settings page why its image column is empty,
      // and what tells the readiness wait that a network serving only paid
      // models is still a network this buyer has answered on.
      const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => respond(
        String(input).includes('images')
          ? directory(model('nano-banana-2', [paidImage]), model('free-image', [freeImage]))
          : directory(model('glm-5.3-flash', [freeText]), model('claude-opus-4.8', [paidText])),
      ))
      await expect(readAntSeedCatalog({ port: 8390, fetchImplementation })).resolves.toEqual({
        models: [
          { id: 'glm-5.3-flash', name: 'glm-5.3-flash', kind: 'text', free: true },
          { id: 'free-image', name: 'free-image', kind: 'images', free: true },
        ],
        paid: 2,
      })
    })

    it('answers an empty catalog when nothing is free', async () => {
      const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => respond(
        String(input).includes('images') ? directory(model('nano-banana-2', [paidImage])) : directory(model('claude-opus-4.8', [paidText])),
      ))
      await expect(readAntSeedCatalog({ port: 8390, fetchImplementation })).resolves.toEqual({ models: [], paid: 2 })
    })

    it('keeps one row for an id both listings name', async () => {
      // The two listings are disjoint in practice, but a buyer that names one id
      // in both must not produce two rows: the card would show the model twice and
      // the picker would offer two entries for one route.
      const fetchImplementation = vi.fn(async () => respond(directory(model('shared-model', [freeText], 'Shared'))))
      await expect(readAntSeedCatalog({ port: 8390, fetchImplementation })).resolves.toEqual({
        models: [{ id: 'shared-model', name: 'Shared', kind: 'text', free: true }],
        paid: 0,
      })
    })

    it('counts a model both listings name once, even when it is priced', async () => {
      const fetchImplementation = vi.fn(async () => respond(directory(model('shared-paid', [paidText], 'Shared'))))
      await expect(readAntSeedCatalog({ port: 8390, fetchImplementation })).resolves.toEqual({ models: [], paid: 1 })
    })

    it('keeps the text listing when the image listing fails', async () => {
      // A buyer serving no image models and a buyer whose image read errored
      // look the same to someone who only wants to chat; neither empties the card.
      const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => String(input).includes('images')
        ? respond({}, 503)
        : respond(directory(model('deepseek-v4-flash', [freeText]))))
      await expect(readAntSeedCatalog({ port: 8390, fetchImplementation })).resolves.toEqual({
        models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', kind: 'text', free: true }],
        paid: 0,
      })
    })

    it('passes the caller\'s abort signal through', async () => {
      const controller = new AbortController()
      const fetchImplementation = answering({ ok: true, json: async () => directory() })
      await listAntSeedModels({ port: 8390, fetchImplementation, signal: controller.signal })
      expect(fetchImplementation).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }))
    })

    it('answers an empty list rather than failing a picker refresh', async () => {
      // Installed-but-not-started and just-switched-off are both normal states
      // on a settings page, and neither should surface as an error.
      await expect(listAntSeedModels({ port: 8390, fetchImplementation: answering({ ok: false, status: 503 }) })).resolves.toEqual([])
      await expect(listAntSeedModels({
        port: 8390,
        fetchImplementation: vi.fn(async () => { throw new Error('ECONNREFUSED') }),
      })).resolves.toEqual([])
    })

    it('abandons a read that never answers', async () => {
      const fetchImplementation = vi.fn(() => new Promise<Response>(() => undefined))
      await expect(listAntSeedModels({ port: 8390, fetchImplementation, timeoutMs: 5 })).resolves.toEqual([])
    })
  })

  describe('model projection', () => {
    it('files rows under the antseed route', () => {
      expect(toAntSeedModelInfo([{ id: 'a', name: 'A', kind: 'text', free: true }])).toEqual([{ provider: 'antseed', id: 'a', name: 'A' }])
      expect(ANTSEED_PROVIDER_ID).toBe('antseed')
    })

    it('lets a caller name the route explicitly', () => {
      expect(toAntSeedModelInfo([{ id: 'a', name: 'A', kind: 'text', free: true }], 'other')).toEqual([{ provider: 'other', id: 'a', name: 'A' }])
    })

    it('offers only text rows as model entries', () => {
      // An image row is generated media: it is reached through the media route,
      // so presenting it here would offer a chat route that cannot answer.
      expect(toAntSeedModelInfo([
        { id: 'flux-2-pro', name: 'FLUX 2 Pro', kind: 'images', free: true },
        { id: 'gpt-oss-120b', name: 'gpt-oss 120b', kind: 'text', free: true },
      ])).toEqual([{ provider: 'antseed', id: 'gpt-oss-120b', name: 'gpt-oss 120b' }])
    })

    it('drops a text row the network prices, however it arrived here', () => {
      // The projection is correct for any input rather than only for the one
      // caller that happens to pass filtered rows: this is the last place a paid
      // model could reach a picker.
      expect(toAntSeedModelInfo([
        { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', kind: 'text', free: false },
        { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', kind: 'text', free: true },
      ])).toEqual([{ provider: 'antseed', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }])
    })

    it('describes the connection without consulting any switch', () => {
      // The switch is checked by the caller: a resolver that could refuse on its
      // own would make "is the gateway closed?" a question with two answers.
      expect(resolveAntSeedConnection(8390, 'a')).toEqual({
        baseURL: 'http://127.0.0.1:8390/v1',
        apiKey: ANTSEED_PLACEHOLDER_API_KEY,
        model: 'a',
      })
    })
  })

  describe('requestAntSeedImage', () => {
    /** A transport that records the request and answers with one response. */
    function imageTransport(answer: Response): { readonly calls: Array<{ readonly url: string; readonly init: RequestInit }>; readonly fetchImplementation: typeof fetch } {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = []
      const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} })
        return answer
      }) as unknown as typeof fetch
      return { calls, fetchImplementation }
    }

    const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => JSON.parse(String(init?.body)) as Record<string, unknown>

    it('asks the buyer for base64 bytes at its own image endpoint', async () => {
      // Base64 rather than a URL: the answer then carries the picture itself, so
      // nothing downstream depends on a seller's CDN link still serving it.
      const { calls, fetchImplementation } = imageTransport(respond({ data: [{ b64_json: 'AAAA' }] }))
      await expect(requestAntSeedImage({ port: 8390, model: 'flux-2-pro', prompt: 'a cat', fetchImplementation }))
        .resolves.toEqual({ data: [{ b64_json: 'AAAA' }] })

      expect(calls[0]?.url).toBe('http://127.0.0.1:8390/v1/images/generations')
      expect(calls[0]?.init.method).toBe('POST')
      expect(calls[0]?.init.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${ANTSEED_PLACEHOLDER_API_KEY}` }))
      expect(bodyOf(calls[0]?.init)).toEqual({ model: 'flux-2-pro', prompt: 'a cat', n: 1, response_format: 'b64_json' })
    })

    it('carries a size, quality and count the caller named', async () => {
      const { calls, fetchImplementation } = imageTransport(respond({ data: [] }))
      await requestAntSeedImage({ port: 8390, model: 'flux-2-pro', prompt: 'a cat', size: '1024x1024', quality: 'high', n: 2, fetchImplementation })
      expect(bodyOf(calls[0]?.init)).toEqual({ model: 'flux-2-pro', prompt: 'a cat', n: 2, response_format: 'b64_json', size: '1024x1024', quality: 'high' })
    })

    it('quotes the seller when the request fails', async () => {
      // The refusal a priced-per-picture seller sends is the shape this reports:
      // `402 payment_required`, which the ladder has to see to try another route.
      const { fetchImplementation } = imageTransport(new Response('{"error":"payment_required"}   by   the seller', { status: 402 }))
      await expect(requestAntSeedImage({ port: 8390, model: 'flux-2-pro', prompt: 'a cat', fetchImplementation }))
        .rejects.toThrow('Image request failed with HTTP 402: {"error":"payment_required"} by the seller')
    })

    it('reports the status alone when the answer carried nothing', async () => {
      const { fetchImplementation } = imageTransport(new Response('   \n', { status: 502 }))
      await expect(requestAntSeedImage({ port: 8390, model: 'flux-2-pro', prompt: 'a cat', fetchImplementation }))
        .rejects.toThrow('Image request failed with HTTP 502')
    })

    it('reports the status when the answer body cannot be read at all', async () => {
      const unreadable = { ok: false, status: 500, text: async () => { throw new Error('stream closed') } } as unknown as Response
      const { fetchImplementation } = imageTransport(unreadable)
      await expect(requestAntSeedImage({ port: 8390, model: 'flux-2-pro', prompt: 'a cat', fetchImplementation }))
        .rejects.toThrow('Image request failed with HTTP 500')
    })

    it('gives up on a request that never answers', async () => {
      // A seller that took the work and then went quiet: the deadline is the only
      // thing that ends the wait, and the ladder then tries another route.
      const fetchImplementation = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch
      await expect(requestAntSeedImage({ port: 8390, model: 'flux-2-pro', prompt: 'a cat', fetchImplementation, timeoutMs: 5 }))
        .rejects.toThrow('Image request timed out after 5ms')
    })

    it("passes the caller's abort signal through", async () => {
      const controller = new AbortController()
      const { calls, fetchImplementation } = imageTransport(respond({ data: [] }))
      await requestAntSeedImage({ port: 8390, model: 'flux-2-pro', prompt: 'a cat', fetchImplementation, signal: controller.signal })
      expect(calls[0]?.init.signal).toBe(controller.signal)
    })

    it('reaches the real fetch when no transport is injected', async () => {
      // The default binding is the one the plugin runs with, and no other test
      // takes it.
      const read = vi.fn(async () => respond({ data: [] }))
      vi.stubGlobal('fetch', read)
      try {
        await expect(requestAntSeedImage({ port: 8390, model: 'flux-2-pro', prompt: 'a cat' })).resolves.toEqual({ data: [] })
        expect(read).toHaveBeenCalledWith('http://127.0.0.1:8390/v1/images/generations', expect.anything())
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('refuses a port it cannot build an endpoint for', async () => {
      await expect(requestAntSeedImage({ port: 80, model: 'flux-2-pro', prompt: 'a cat' })).rejects.toThrow('is not a usable port number')
    })
  })
})
