/**
 * What one transcription request actually puts on the wire.
 *
 * `groqWhisperTranscribe` is the one media path that is not a ladder — the model
 * is fixed, there is no second route, and the caller's values reach a third-party
 * endpoint as a multipart form. Two of those values used to be rewritten on the
 * way out:
 *
 * 1. **The file name's extension came from a different list than the media type.**
 *    The tool derives `audio/flac` for a `.flac` recording, while the upload name
 *    was built by a chain of `includes` tests with `mp3` as its fallback — so the
 *    request said `type: audio/flac` and `filename: recording.mp3`. Measured before
 *    the fix: `audio/flac -> recording.mp3`, which is the pair an
 *    OpenAI-compatible transcriber reads the container from.
 * 2. **A language hint this module could not spell was dropped in silence.** The
 *    guard kept `[A-Za-z-]{2,16}`, which forwarded `chinese` (no provider reads
 *    that as a code) and discarded `zh_Hans`, `pt-BR ` and `  en` — measured:
 *    those three produced **no** `language` field at all, and the result said
 *    nothing, so the caller believed its hint had been used.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { groqWhisperTranscribe } from '../src/account-remotes.ts'

/** One transcription attempt, with the multipart body it produced. */
async function upload(mimeType: string, language?: unknown): Promise<{ readonly name: string; readonly type: string; readonly language: unknown }> {
  const host = { catalogs: { groqWhisperApiKey: async () => 'groq-key' } }
  let seen: FormData | undefined
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    seen = init?.body as FormData
    return new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const payload = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64')
  await groqWhisperTranscribe(host as never, payload, mimeType, language as string | undefined)
  const file = seen?.get('file') as File | null
  return { name: String(file?.name), type: String(file?.type), language: seen?.get('language') }
}

afterEach(() => { vi.restoreAllMocks() })

describe('the upload name and the media type describe one container', () => {
  // Exactly the media types the transcribe tool can derive from a file's
  // extension (`audioMimeType`), each with the extension that container actually
  // has. The name must not deny the type beside it: an OpenAI-compatible
  // transcriber reads the container off the name.
  const containers: readonly (readonly [string, string])[] = [
    ['audio/mpeg', 'mp3'],
    ['audio/wav', 'wav'],
    ['audio/webm', 'webm'],
    ['audio/ogg', 'ogg'],
    ['audio/mp4', 'm4a'],
    ['audio/flac', 'flac'],
  ]

  it.each(containers)('names a %s upload .%s', async (mimeType, extension) => {
    const uploaded = await upload(mimeType)
    expect(uploaded.type).toBe(mimeType)
    expect(uploaded.name).toBe(`recording.${extension}`)
  })
})

describe('the language hint is the caller\'s, not this module\'s', () => {
  it('forwards what the caller sent, trimmed', async () => {
    for (const hint of ['zh', 'en-US', 'zh_Hans', 'pt-BR ', '  en']) {
      expect((await upload('audio/mpeg', hint)).language, hint).toBe(hint.trim())
    }
  })

  it('adds no field for a hint that carries nothing', async () => {
    // The control: absent, empty and non-string values must stay absent — the
    // provider's own auto-detect is the documented behaviour for all three.
    for (const hint of [undefined, '', '   ', 42]) {
      expect((await upload('audio/mpeg', hint)).language, String(hint)).toBe(null)
    }
  })
})
