import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AUDIO_FORMATS, gatewayMediaJson, generateAudioWithFallback, generateVideoWithFallback, persistGeneratedImages, pollGeneratedVideo, registerMediaTools, renderGeneratedImages } from '../src/media-generation.ts'
import { MediaRouteLimitation, mediaFallbackAllowed } from '../src/media-utils.ts'

afterEach(() => vi.restoreAllMocks())

describe('persistGeneratedImages', () => {
  it('downloads a URL-only image into attachment storage', async () => {
    const saved: Array<{ name?: string; mediaType: string }> = []
    const attachment: ImageAttachmentRef = { attachmentId: 'att-url-1' as never, mediaType: 'image/png', bytes: 8, width: 1, height: 1 }
    const attachments = { saveImage: vi.fn(async (input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) => { saved.push({ ...input.name === undefined ? {} : { name: input.name }, mediaType: input.mediaType }); return attachment }) }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { status: 200 }))
    const result = await persistGeneratedImages('image-model', { data: [{ url: 'https://cdn.example/generated.png' }] }, attachments as never)
    expect(result.images).toEqual([{ url: 'https://cdn.example/generated.png', attachment }])
    expect(saved[0]?.name).toBe('image-model-1.png')
  })

  it('keeps the URL as a render fallback when the download fails', async () => {
    const attachments = { saveImage: vi.fn(async () => { throw new Error('storage unavailable') }) }
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    const result = await persistGeneratedImages('image-model', { data: [{ url: 'https://cdn.example/generated.png' }] }, attachments as never)
    expect(result.images).toEqual([{ url: 'https://cdn.example/generated.png' }])
  })

  it('refuses to download non-http URL schemes', async () => {
    const attachments = { saveImage: vi.fn() }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const result = await persistGeneratedImages('image-model', { data: [{ url: 'file:///etc/passwd' }] }, attachments as never)
    expect(result.images).toEqual([{ url: 'file:///etc/passwd' }])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(attachments.saveImage).not.toHaveBeenCalled()
  })

  it('marks bytes no image format can be read from as this route failing to deliver', async () => {
    // Another configured route may return a format the plugin can persist, so
    // this belongs to the route rather than to the request -- which is why it
    // is raised as the ladder's own signal and not as a plain error.
    const attachments = { saveImage: async (input: { readonly data: Uint8Array; readonly mediaType: string }) => ({ attachmentId: 'att-sniffed', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }) }
    const error = await persistGeneratedImages('image-model', { data: [{ b64_json: Buffer.from('an HTML error page').toString('base64') }] }, attachments as never).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(MediaRouteLimitation)
    expect(mediaFallbackAllowed(error, new AbortController().signal)).toBe(true)
  })

  it('marks malformed base64 as this route failing to deliver', async () => {
    const attachments = { saveImage: async (input: { readonly data: Uint8Array; readonly mediaType: string }) => ({ attachmentId: 'att-sniffed', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }) }
    const error = await persistGeneratedImages('image-model', { data: [{ b64_json: 'not base64 !!!' }] }, attachments as never).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(MediaRouteLimitation)
    expect(mediaFallbackAllowed(error, new AbortController().signal)).toBe(true)
  })
})

describe('renderGeneratedImages', () => {
  it('emits a visible text block for a URL entry without an attachment', () => {
    const blocks = renderGeneratedImages({ model: 'image-model', images: [{ url: 'https://cdn.example/generated.png' }] })
    expect(blocks).toEqual([
      { type: 'text', text: '{"model":"image-model","images":[{"url":"https://cdn.example/generated.png"}]}' },
      { type: 'text', text: 'Generated image: https://cdn.example/generated.png' },
    ])
  })

  it('emits an image block for an attachment entry', () => {
    const attachment = { attachmentId: 'att-1' as never, mediaType: 'image/png' as const, bytes: 4, width: 1, height: 1 }
    const blocks = renderGeneratedImages({ model: 'image-model', images: [{ attachment }] })
    expect(blocks).toEqual([
      { type: 'text', text: '{"model":"image-model","images":[{"attachmentId":"att-1"}]}' },
      { type: 'image', attachment },
    ])
  })
})

describe('mediaFallbackAllowed', () => {
  it('allows fallback for payment, quota, and missing-image statuses', () => {
    expect(mediaFallbackAllowed(new Error('FreeCodeGo /images/generations failed with HTTP 402: payment required'), new AbortController().signal)).toBe(true)
    expect(mediaFallbackAllowed(new Error('FreeCodeGo /images/generations failed with HTTP 429: slow down'), new AbortController().signal)).toBe(true)
    expect(mediaFallbackAllowed(new Error('FreeCodeGo /images/generations failed with HTTP 503: try later'), new AbortController().signal)).toBe(true)
    expect(mediaFallbackAllowed(new Error('The selected image model returned no image data'), new AbortController().signal)).toBe(true)
    expect(mediaFallbackAllowed(new Error('insufficient balance for this account'), new AbortController().signal)).toBe(true)
    expect(mediaFallbackAllowed(new Error('quota exceeded on this route'), new AbortController().signal)).toBe(true)
  })

  it('keeps auth failures and bad prompts terminal', () => {
    expect(mediaFallbackAllowed(new Error('FreeCodeGo /images/generations failed with HTTP 401: bad key'), new AbortController().signal)).toBe(false)
    expect(mediaFallbackAllowed(new Error('FreeCodeGo /images/generations failed with HTTP 400: invalid prompt'), new AbortController().signal)).toBe(false)
    expect(mediaFallbackAllowed(new Error('Attachment storage is required'), new AbortController().signal)).toBe(false)
    expect(mediaFallbackAllowed(new Error('aborted'), new AbortController().signal)).toBe(false)
  })

  it('does not read a status number that merely appears in the text as the response status', () => {
    // Measured: the shared refusal list spells its numbers `\b(?:HTTP )?(?:400|422)\b`,
    // so any `400` anywhere in the text — here a task id inside the endpoint URL —
    // was read as a request refusal and the ladder stopped, even though the
    // provider had reported an outage. The refusal list keeps its loose form on
    // purpose (the task-side reader needs it), so the ladder checks the statuses
    // that a *route* class carries, in their exact `HTTP <code>` shape, first.
    const signal = new AbortController().signal
    expect(mediaFallbackAllowed(new Error('FreeCodeGo /v1/tasks/model-400/status failed with HTTP 503'), signal)).toBe(true)
    expect(mediaFallbackAllowed(new Error('FreeCodeGo /v1/tasks/model-422/status failed with HTTP 503'), signal)).toBe(true)
    // Controls: a refusal the provider actually reported stays terminal, so the
    // reordering cannot turn a rejected prompt into another paid attempt.
    expect(mediaFallbackAllowed(new Error('FreeCodeGo /images/generations failed with HTTP 400: invalid prompt'), signal)).toBe(false)
    expect(mediaFallbackAllowed(new Error('HTTP 401 unauthorized'), signal)).toBe(false)
    expect(mediaFallbackAllowed(new Error('HTTP 400 PROMPT_REQUIRED'), signal)).toBe(false)
  })

  it('lets the ladder route around a provider that cannot render the request', () => {
    // The classification that used to be missing. Agnes refuses any duration
    // outside 4..12 with its own message, which matched none of the terminal
    // patterns above — and an unmatched message falls through to the same `false`
    // default, so a route limitation became terminal by omission and a 30-second
    // video asked for through the tool schema's own 1..60 range failed with every
    // other configured route untried. The type is what decides now, so no future
    // provider has to word its refusal the way this regex list happens to expect.
    const signal = new AbortController().signal
    expect(mediaFallbackAllowed(new MediaRouteLimitation('agnes renders 4 through 12 seconds, not 30'), signal)).toBe(true)
    // Still terminal: the caller asking for something no route could serve.
    expect(mediaFallbackAllowed(new Error('FreeCodeGo /videos/generations failed with HTTP 400: invalid duration'), signal)).toBe(false)
    expect(mediaFallbackAllowed(new Error('AGNES_VIDEO_PROMPT_REQUIRED'), signal)).toBe(false)
  })
})

describe('freecodego_transcribe_audio', () => {
  type TranscribeTool = { readonly name: string; execute: (args: { path: string }, exec: { agent: unknown }) => Promise<unknown> }
  // The workspace reaches the tool through the session header (`exec.agent`),
  // not through registration, so the fixture keeps the argument only to name the
  // workspace each case is about.
  const transcribeTool = async (_workspace: string, denyCredentials = true, onUpload?: (audioBase64: string) => void): Promise<TranscribeTool> => {
    const registered: TranscribeTool[] = []
    registerMediaTools({
      ctx: {
        get: (name: string) => name === 'tools' ? { register: (tool: typeof registered[number]) => { registered.push(tool); return () => undefined } } : undefined,
        effect: () => undefined,
      },
      policy: { get: () => ({ mediaDefaults: { image: '', video: '', audio: '' }, ...(denyCredentials ? {} : { envReadGuardEnabled: false }) }) },
      groqWhisperTranscribe: async (audioBase64: string) => { onUpload?.(audioBase64); return { text: 'transcribed' } },
      requireAgnes: () => { throw new Error('unused') },
    } as never)
    const tool = registered.find(entry => entry.name === 'freecodego_transcribe_audio')
    if (tool === undefined) throw new Error('transcribe tool was not registered')
    return tool
  }

  const inWorkspace = (workspace: string): { readonly session: { readonly header: { readonly cwd: string } } } =>
    ({ session: { header: { cwd: workspace } } })

  it('refuses a credential file inside the workspace before uploading it', async () => {
    // The credential guard itself covers read/write/edit/bash only, and this tool
    // hands bytes to a third-party endpoint — the path a workspace-relative check
    // cannot see (`.env` is inside the workspace and is still a secret).
    const workspace = await mkdtemp(join(tmpdir(), 'fcg-transcribe-'))
    try {
      await writeFile(join(workspace, '.env'), 'GROQ_API_KEY=secret')
      const tool = await transcribeTool(workspace)
      await expect(tool.execute({ path: '.env' }, { agent: inWorkspace(workspace) })).rejects.toThrow(/credential guard/)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('refuses a workspace symlink that resolves outside it', async () => {
    // Lexical containment passes for `link.mp3`; the filesystem does not, which is
    // how a planted symlink turned this tool into an uploader for any file the Host
    // process can read.
    const workspace = await mkdtemp(join(tmpdir(), 'fcg-transcribe-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'fcg-transcribe-outside-'))
    try {
      await writeFile(join(outside, 'secret.mp3'), 'not audio at all')
      await symlink(join(outside, 'secret.mp3'), join(workspace, 'link.mp3'))
      const tool = await transcribeTool(workspace)
      await expect(tool.execute({ path: 'link.mp3' }, { agent: inWorkspace(workspace) })).rejects.toThrow(/inside the active workspace/)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('transcribes an ordinary audio file in the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fcg-transcribe-ok-'))
    try {
      await writeFile(join(workspace, 'note.mp3'), 'audio bytes')
      const tool = await transcribeTool(workspace)
      await expect(tool.execute({ path: 'note.mp3' }, { agent: inWorkspace(workspace) })).resolves.toEqual({ text: 'transcribed' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('measures the file before reading it, so an oversized recording is never held in memory', async () => {
    // Reading first meant the whole file was allocated in order to refuse it, and
    // a file past the runtime's own read ceiling failed with
    // `RangeError: File size (...) is greater than 2 GiB` -- so the tool's own
    // message never reached the files that most needed it. A sparse file keeps the
    // case cheap and the evidence exact: the runtime will not read this one whole,
    // so reaching the tool's message at all proves no read came first.
    const workspace = await mkdtemp(join(tmpdir(), 'fcg-transcribe-huge-'))
    try {
      const huge = join(workspace, 'huge.mp3')
      await writeFile(huge, '')
      await truncate(huge, 2_200_000_000)
      const tool = await transcribeTool(workspace)
      await expect(tool.execute({ path: 'huge.mp3' }, { agent: inWorkspace(workspace) }))
        .rejects.toThrow(/exceeds the 27 MB transcription limit/)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('accepts a file exactly at the limit and keeps the payload inside the provider ceiling', async () => {
    // Two numbers name the same 27 MB: the tool's byte count and the provider
    // wrapper's base64 length. An off-by-one on either side turns a legal
    // recording into a refusal, and the payload here is the boundary itself.
    const workspace = await mkdtemp(join(tmpdir(), 'fcg-transcribe-limit-'))
    try {
      await writeFile(join(workspace, 'at-limit.mp3'), Buffer.alloc(27_000_000))
      const uploaded: string[] = []
      const tool = await transcribeTool(workspace, true, audioBase64 => uploaded.push(audioBase64))
      await expect(tool.execute({ path: 'at-limit.mp3' }, { agent: inWorkspace(workspace) })).resolves.toEqual({ text: 'transcribed' })
      expect(uploaded[0]?.length).toBe(36_000_000)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('generateAudioWithFallback', () => {
  const audioHost = (): unknown => ({
    ctx: { get: (name: string) => name === 'llm' ? { listProviders: () => [], listModels: async () => [] } : undefined },
    credentials: { resolve: async () => undefined },
    capabilities: { configuration: () => ({ modelCategories: {} }) },
    policy: { get: () => ({ mediaDefaults: { audio: 'audio-model' } }) },
    readManagedCatalogCache: async () => undefined,
    logfareApiKey: async () => undefined,
    requireAgnes: () => ({ agnesMediaModels: async () => [] }),
    mediaRoute: (selection: string) => ({ selection, provider: 'freecodego', model: 'audio-model' }),
    directConnection: async () => undefined,
    managedRuntime: async () => ({ openAIBaseUrl: 'https://gateway.example/v1', openAIToken: 'token', routeKey: 'rk' }),
  })

  it('writes every container the schema offers, instead of the fallback', async () => {
    // The schema's `enum` and the set that decides are one list with two readers,
    // and drift is silent in the worse direction: a format the schema offers and
    // the set does not know is not refused, it is *replaced*, so the caller gets a
    // different container than it asked for with nothing saying why. Asserting the
    // list rather than one member is what makes a future addition covered.
    for (const format of AUDIO_FORMATS) {
      const workspace = await mkdtemp(join(tmpdir(), 'fcg-audio-'))
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/octet-stream' } }))
      try {
        const result = await generateAudioWithFallback(audioHost() as never, { input: 'hello', format }, workspace, new AbortController().signal) as { readonly path: string }
        expect(result.path.endsWith(`.${format}`)).toBe(true)
        const sent = fetchMock.mock.calls[0]?.[1]?.body
        const parsed = typeof sent === 'string' ? JSON.parse(sent) as { readonly response_format?: string } : undefined
        expect(parsed?.response_format).toBe(format)
      } finally {
        await rm(workspace, { recursive: true, force: true })
        vi.restoreAllMocks()
      }
    }
  })

  it('never lets the requested format decide where the audio is written', async () => {
    // The schema's `enum` is a description, not a gate — the registry hands tools
    // their raw arguments — and this value builds a file name, so an unwhitelisted
    // one is a path. `format: "../../../../tmp/pwned"` used to resolve the write
    // clean out of the generated-media directory.
    const workspace = await mkdtemp(join(tmpdir(), 'fcg-audio-'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
    try {
      const result = await generateAudioWithFallback(
        audioHost() as never,
        { input: 'hello', format: '../../../../tmp/pwned' },
        workspace,
        new AbortController().signal,
      ) as { readonly path: string; readonly mimeType: string }
      const inside = relative(join(workspace, '.freecodego', 'generated-media'), result.path)
      expect(inside.startsWith('..')).toBe(false)
      expect(result.path.endsWith('.mp3')).toBe(true)
      expect(result.mimeType).toBe('audio/mpeg')
      // The provider is asked for the container that actually lands on disk.
      const sent = fetchMock.mock.calls[0]?.[1]?.body
      const parsed = typeof sent === 'string' ? JSON.parse(sent) as { readonly response_format?: string } : undefined
      expect(parsed?.response_format).toBe('mp3')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })
})

/**
 * The host an Agnes-preferred account sees.
 *
 * The first-party route is the configured default and a gateway video model is
 * the second candidate, which is what `llm` discovery contributes in production;
 * `withGateway: false` is the account whose only video route is Agnes.
 */
const videoHost = (input: { readonly withGateway: boolean; readonly createVideo: (args: unknown) => Promise<unknown> }): unknown => {
  const host: Record<string, unknown> = {
    ctx: {
      get: (name: string) => name === 'llm'
        ? { listProviders: () => (input.withGateway ? [{ id: 'gateway' }] : []), listModels: async () => (input.withGateway ? [{ id: 'veo-3', name: 'Veo 3' }] : []) }
        : { get: () => ({ providers: {} }) },
    },
    credentials: { resolve: async () => undefined },
    capabilities: { configuration: () => ({ modelCategories: {} }) },
    policy: { get: () => ({ mediaDefaults: { image: '', video: 'agnes/agnes-video-2.5-flash', audio: '' } }) },
    readManagedCatalogCache: async () => undefined,
    logfareApiKey: async () => undefined,
    logfareModels: async () => [],
    requireAgnes: () => ({ agnesMediaModels: async () => [], createVideo: input.createVideo }),
    mediaRoute: (selection: string) => selection.startsWith('agnes/')
      ? { selection, provider: 'agnes', model: 'agnes-video-2.5-flash' }
      : { selection, provider: 'freecodego', model: 'veo-3' },
    directConnection: async () => undefined,
    managedRuntime: async () => ({ openAIBaseUrl: 'https://gateway.example/v1', openAIToken: 'token', routeKey: 'rk' }),
  }
  // The fallback route's transport is the real one rather than a reimplementation,
  // so the case below travels the same gateway code path production uses.
  host.gatewayMediaJson = (selection: string, endpoint: string, body: Record<string, unknown>, signal: AbortSignal) =>
    gatewayMediaJson(host as never, selection, endpoint, body, signal)
  return host
}

describe('generateVideoWithFallback', () => {
  it('asks the first-party route for a duration inside its documented range', async () => {
    const asked: unknown[] = []
    const host = videoHost({
      withGateway: true,
      createVideo: async (args: unknown) => { asked.push(args); return { videoId: 'agnes-1', status: 'completed', url: 'https://cdn.example/agnes.mp4' } },
    })
    await expect(generateVideoWithFallback(host as never, { prompt: 'a boat', seconds: 8 }, new AbortController().signal))
      .resolves.toMatchObject({ videoId: 'agnes-1', status: 'completed' })
    expect(asked).toEqual([{ prompt: 'a boat', model: 'agnes-video-2.5-flash', seconds: '8', signal: expect.any(AbortSignal) }])
  })

  it('hands a duration the first-party route cannot render to the next route', async () => {
    // The whole defect in one call: the generic video tool advertises 1..60, so a
    // caller asking for 30 seconds is following the schema. Agnes renders 4..12.
    // Before the typed limitation this raised the provider's own error straight
    // out of the tool, so the gateway route below was never reached; now the
    // ladder treats it as this route's limit and the request still lands.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ data: [{ url: 'https://cdn.example/gateway.mp4' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const asked: unknown[] = []
    const host = videoHost({
      withGateway: true,
      createVideo: async (args: unknown) => { asked.push(args); return { videoId: 'agnes-refused' } },
    })
    await expect(generateVideoWithFallback(host as never, { prompt: 'a long boat', seconds: 30 }, new AbortController().signal))
      .resolves.toMatchObject({ url: 'https://cdn.example/gateway.mp4' })
    // Not merely routed around: the route that cannot serve it was never asked,
    // so no provider quota is spent on a request the transport would refuse.
    expect(asked).toEqual([])
  })

  it('reports the refusal through the ladder when no other route is configured', async () => {
    const asked: unknown[] = []
    const host = videoHost({
      withGateway: false,
      createVideo: async (args: unknown) => { asked.push(args); return { videoId: 'agnes-refused' } },
    })
    // The aggregate error is the discriminator: a terminal refusal would surface
    // the provider's message alone, so the presence of the ladder's own prefix
    // and of this route's reason together say the limitation was classified as a
    // route limit rather than as a bad request.
    await expect(generateVideoWithFallback(host as never, { prompt: 'a long boat', seconds: 30 }, new AbortController().signal))
      .rejects.toThrow(/No configured video model completed the request: .*agnes renders 4 through 12 seconds, not 30/)
    expect(asked).toEqual([])
  })
})

describe('pollGeneratedVideo', () => {
  const gatewayHost = (token: string, onResolve?: () => void): unknown => ({
    ctx: { get: () => ({ get: () => ({ providers: {} }) }) },
    credentials: { resolve: async () => undefined },
    mediaRoute: (selection: string) => ({ selection, provider: 'freecodego', model: 'kling-v2' }),
    directConnection: async () => undefined,
    managedRuntime: async () => { onResolve?.(); return { openAIBaseUrl: 'https://gateway.example/v1', openAIToken: token, routeKey: 'rk' } },
  })
  it('throws for a failed task carrying a provider error so fallback can take over', async () => {
    // This case used to assert less than its name claimed: the assertion only
    // proved the provider's text reached the message, and the payload was a
    // content refusal -- which the ladder treats as terminal, so fallback could
    // not have taken over. A task that failed without refusing the request is
    // what the claim actually needs.
    const route = { selection: 'kling/kling-v2', provider: 'kling', model: 'kling-v2' }
    const error = await pollGeneratedVideo(gatewayHost('token') as never, route, { task_id: 'task-failed-1', task_status: 'failed', task_status_msg: 'upstream render farm aborted' }, new AbortController().signal).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(MediaRouteLimitation)
    expect((error as Error).message).toBe('FreeCodeGo video task task-failed-1 failed: upstream render farm aborted')
    expect(mediaFallbackAllowed(error, new AbortController().signal)).toBe(true)
    // The classification the rest of the transport layer reads survives the
    // ladder's own signal underneath it.
    expect((error as { readonly cause?: unknown }).cause).toBeInstanceOf(LlmError)
  })

  it('keeps a task the provider refused by content terminal', async () => {
    // The other half of the split. Re-asking every configured route would buy
    // the same refusal, and each attempt creates another paid video task, so a
    // decision about the request must not be retried as if it were a route's.
    const route = { selection: 'kling/kling-v2', provider: 'kling', model: 'kling-v2' }
    const error = await pollGeneratedVideo(gatewayHost('token') as never, route, { task_id: 'task-failed-2', task_status: 'failed', task_status_msg: 'content policy' }, new AbortController().signal).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(LlmError)
    expect(mediaFallbackAllowed(error, new AbortController().signal)).toBe(false)
  })

  it('throws a generic error for a failed task without provider error text', async () => {
    const route = { selection: 'kling/kling-v2', provider: 'kling', model: 'kling-v2' }
    const error = await pollGeneratedVideo(gatewayHost('token') as never, route, { task_id: 'task-failed-3', task_status: 'failed' }, new AbortController().signal).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(MediaRouteLimitation)
    expect((error as Error).message).toBe('FreeCodeGo video task task-failed-3 failed')
    // A provider that declined to say why did not refuse the request.
    expect(mediaFallbackAllowed(error, new AbortController().signal)).toBe(true)
  })

  it('treats a task still running when the polling window closes as a route limitation', async () => {
    // The window exists so another configured route can still deliver. Driving
    // ten real minutes is not an option in a test, so the clock is what moves.
    vi.useFakeTimers()
    try {
      const route = { selection: 'kling/kling-v2', provider: 'kling', model: 'kling-v2' }
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ task_id: 'task-window', task_status: 'processing' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      const settled = pollGeneratedVideo(gatewayHost('token') as never, route, { task_id: 'task-window', task_status: 'submitted' }, new AbortController().signal).catch((cause: unknown) => cause)
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 4_000)
      const error = await settled
      expect(error).toBeInstanceOf(MediaRouteLimitation)
      expect((error as Error).message).toBe('FreeCodeGo video task task-window did not complete within the 10 minute polling window')
      expect(mediaFallbackAllowed(error, new AbortController().signal)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)

  it('reuses one transport resolution across ticks and tolerates two failed polls', async () => {
    let resolutions = 0
    const host = gatewayHost('token', () => { resolutions += 1 })
    const route = { selection: 'kling/kling-v2', provider: 'kling', model: 'kling-v2' }
    vi.spyOn(globalThis, 'fetch')
      // tick 1: transient network failure
      .mockRejectedValueOnce(new Error('fetch failed'))
      // tick 2: success, still running
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-3', task_status: 'processing' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      // tick 3: success, completed with a URL
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-3', task_status: 'succeed', task_result: { videos: [{ url: 'https://cdn.example/v.mp4' }] } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await pollGeneratedVideo(host as never, route, { task_id: 'task-3', task_status: 'submitted' }, new AbortController().signal)
    expect(result).toMatchObject({ videoId: 'task-3', status: 'completed', url: 'https://cdn.example/v.mp4' })
    expect(resolutions).toBe(1)
  }, 15_000)

  it('aborts after three consecutive failed polls', async () => {
    const host = gatewayHost('token')
    const route = { selection: 'kling/kling-v2', provider: 'kling', model: 'kling-v2' }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'))
    await expect(pollGeneratedVideo(host as never, route, { task_id: 'task-4', task_status: 'submitted' }, new AbortController().signal))
      .rejects.toThrow('fetch failed')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  }, 15_000)

  it('recovers a rejected token once through the shared account recovery path', async () => {
    let resolutions = 0
    let recoveries = 0
    const host = withAccountRecovery(gatewayHost('stale-token', () => { resolutions += 1 }), () => { recoveries += 1 })
    const route = { selection: 'kling/kling-v2', provider: 'kling', model: 'kling-v2' }
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'expired' }), { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-5', task_status: 'succeed', task_result: { videos: [{ url: 'https://cdn.example/v5.mp4' }] } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await pollGeneratedVideo(host as never, route, { task_id: 'task-5', task_status: 'submitted' }, new AbortController().signal)
    expect(result).toMatchObject({ status: 'completed', url: 'https://cdn.example/v5.mp4' })
    // One recovery, and the replay re-resolved the transport so the retry
    // carried the rotated token.
    expect(recoveries).toBe(1)
    expect(resolutions).toBe(2)
  }, 15_000)

  it('never retries a rejected token on its own', async () => {
    // Without the host recovery path a 401 is terminal: media generation must
    // not keep a private re-resolution that the account coordinator cannot see.
    const host = gatewayHost('stale-token')
    const route = { selection: 'kling/kling-v2', provider: 'kling', model: 'kling-v2' }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'expired' }), { status: 401, headers: { 'content-type': 'application/json' } }))
    await expect(pollGeneratedVideo(host as never, route, { task_id: 'task-6', task_status: 'submitted' }, new AbortController().signal))
      .rejects.toThrow('HTTP 401')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  }, 15_000)
})

/** Wrap a gateway host with the account recovery the plugin supplies. */
const withAccountRecovery = (base: unknown, onRecover: () => void): unknown => ({
  ...(base as object),
  recoverGatewayAuth: async <T>(run: () => Promise<T>): Promise<T> => {
    onRecover()
    try {
      return await run()
    } catch (error) {
      if ((error as { readonly status?: number }).status !== 401) throw error
      // A refreshed session is all the coordinator changes; the caller's own
      // closure re-resolves its transport.
      return run()
    }
  },
})

describe('gatewayMediaJson recovery', () => {
  const gatewayJsonHost = (input: { readonly direct?: boolean }): unknown => ({
    ctx: { get: () => ({ get: () => ({ providers: {} }) }) },
    credentials: { resolve: async () => undefined },
    mediaRoute: (selection: string) => input.direct
      ? { selection, provider: 'opencode', model: 'big-pickle' }
      : { selection, provider: 'freecodego', model: 'gpt-image-1' },
    directConnection: async () => input.direct
      ? { connection: { baseURL: 'https://opencode.example/v1', model: 'big-pickle', headers: {} }, runtime: { openAIToken: 'public', routeKeys: [] } }
      : undefined,
    managedRuntime: async () => ({ openAIBaseUrl: 'https://gateway.example/v1', openAIToken: 'gateway-token', routeKey: 'rk' }),
  })

  it('replays a rejected gateway POST once through the account recovery path', async () => {
    let recoveries = 0
    const host = withAccountRecovery(gatewayJsonHost({}), () => { recoveries += 1 })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'expired' }), { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: 'aGk=' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(gatewayMediaJson(host as never, 'freecodego/gpt-image-1', '/images/generations', { prompt: 'cat' }, new AbortController().signal))
      .resolves.toEqual({ data: [{ b64_json: 'aGk=' }] })
    expect(recoveries).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a direct provider credential out of the account recovery path', async () => {
    let recoveries = 0
    const host = withAccountRecovery(gatewayJsonHost({ direct: true }), () => { recoveries += 1 })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 401, headers: { 'content-type': 'application/json' } }))
    await expect(gatewayMediaJson(host as never, 'opencode/big-pickle', '/images/generations', { prompt: 'cat' }, new AbortController().signal))
      .rejects.toThrow('HTTP 401')
    expect(recoveries).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
