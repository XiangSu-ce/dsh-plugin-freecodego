/**
 * Media generation pipeline for the FreeCodeGo Harness plugin: the generic
 * media tools, per-provider fallback execution, route resolution, and the
 * shared gateway transport used by every image, video, and audio request.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/media-generation
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { MODELS_SETTINGS_ENTRY, peerSettings } from './peer-settings.ts'
import fs from 'node:fs/promises'
import path from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ContentBlock, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FreeCodeGoManagedRuntime } from '@deepseek-ai/dsh-freecodego-api'
import type { AgnesClient } from './agnes.ts'
import { AGNES_VIDEO_SECONDS } from './agnes.ts'
import type { FreeCodeGoCapabilityRegistry } from './capabilities.ts'
import type { OpenAiCompatibleConnection } from './openai-compatible-adapter.ts'
import { backendNotConfigured } from './account-utils.ts'
import { isCredentialPath } from './tool-guards.ts'
import { asRecord as record, asString as text } from './untrusted-json.ts'
import { KLING_ACCESS_KEY_REF, KLING_SECRET_KEY_REF, dataUrlImage, defaultMediaAuthScheme, defaultMediaBaseURL, defaultMediaCredentialRef, gatewayModelId, generatedVideoResult, guessImageMediaType, imageEndpointMayBeResponses, imageEndpointUnavailable, imagesViaGenerationBody, inferMediaCategory, isKlingProvider, mediaFailureBelongsToRequest, mediaCategoryOverrideKey, mediaFallbackAllowed, MediaRouteCapabilityRefusal, MediaRouteLimitation, mediaSelection, mediaVideoRequest, redactMediaDetail, referenceImageUrls, signKlingJwt, sizeToAspectRatio, sleepForMedia, unknownImageParameter, videoStatusEndpoint, videoSecondsRefusal, visibleMediaSelection, type MediaCategory, type MediaRoute, type MediaVideoArgs, type MediaVideoRequest } from './media-utils.ts'
import { LOGFARE_MODEL_PREFIX, logfareMediaCategory, logfareSelectionId, mediaCategoryForManagedModel } from './managed-catalog-utils.ts'
import { toolDefinition as rawAgnesTool, type ToolDefinitionShape } from './tool-definition.ts'
import type { LogfareModel } from './managed-catalog-utils.ts'
import type { FreeCodeGoManagedCatalog } from './types.ts'
// Type-only: the canonical settings scope already carries the guard toggles this
// module reads (`envReadGuardEnabled`), and re-declaring the intersection here is
// how the transcription check silently lost the field.
import type { FreeCodeGoSettingsReadPort } from './policy.ts'

/**
 * Narrow view of the plugin surface required by the media generation cluster.
 * The plugin satisfies it through its `mediaHost` accessor; members that map
 * to plugin methods delegate back to the live instance so instance-level
 * overrides keep working.
 */
export interface MediaGenerationHost {
  readonly ctx: Context
  readonly credentials: CredentialProvider | undefined
  /**
   * The settings this runtime reads. A read port, not the registered scope: the
   * write path belongs to the settings surface, and handing this runtime the
   * scope would let it write a user's document from inside a media call.
   */
  readonly policy: FreeCodeGoSettingsReadPort
  readonly capabilities: FreeCodeGoCapabilityRegistry
  readonly requireAgnes: () => AgnesClient
  readonly groqWhisperTranscribe: (audioBase64: string, mimeType: string, language?: string) => Promise<{ readonly text: string; readonly model: string }>
  readonly readManagedCatalogCache: () => Promise<FreeCodeGoManagedCatalog | undefined>
  readonly logfareApiKey: () => Promise<string | undefined>
  readonly logfareModels: () => Promise<readonly LogfareModel[]>
  readonly configuredProviderRoute: (model: string) => { readonly provider: string; readonly model: string } | undefined
  readonly directConnection: (model: string | undefined, allowExternalProviders?: boolean) => Promise<{ connection: Omit<OpenAiCompatibleConnection, 'apiKey'>; runtime: FreeCodeGoManagedRuntime } | undefined>
  readonly managedRuntime: (model?: string) => Promise<FreeCodeGoManagedRuntime & { readonly routeKey?: string; readonly protocol?: string }>
  /** Host account recovery for gateway media requests; a direct/configured
   * provider keeps its own credential and never enters this path. */
  readonly recoverGatewayAuth?: <T>(run: () => Promise<T>) => Promise<T>
  readonly mediaRoute: (selection: string) => MediaRoute
  readonly gatewayMediaJson: (model: string, endpoint: string | readonly string[], body: Record<string, unknown>, signal: AbortSignal, options?: MediaRequestOptions) => Promise<unknown>
  readonly generateImageWithFallback: (args: ImageGenerationArgs, signal: AbortSignal) => Promise<unknown>
  readonly generateVideoWithFallback: (args: MediaVideoArgs, signal: AbortSignal) => Promise<unknown>
  readonly generateAudioWithFallback: (args: { input: string; voice?: string; format?: string; speed?: number }, cwd: string | undefined, signal: AbortSignal) => Promise<unknown>
}

/**
 * The caller-facing arguments one image request may carry. `images` is a
 * distinct role from a video's first frame: with sources attached the request
 * becomes an edit/fusion call on the providers that accept them.
 */
export interface ImageGenerationArgs {
  readonly prompt: string
  readonly size?: string
  readonly quality?: string
  readonly n?: number
  readonly images?: readonly string[]
}

interface ConfiguredMediaConnection {
  readonly baseURL: string
  readonly apiKey?: string
  readonly headers: Readonly<Record<string, string>>
  readonly api?: string
  /** A signed token that replaces the static key on providers that mint one
   * per request (Kling). */
  readonly jwt?: string
}

/** A downloaded provider image may occupy this many bytes at most. */
const GENERATED_IMAGE_DOWNLOAD_LIMIT = 20 * 1_024 * 1_024

/**
 * Fetch one provider-hosted generated image and return its bytes. URL-only
 * results would otherwise be invisible in the tool view, so the Host pulls the
 * bytes into attachment storage just like base64 results. Providers hand back
 * CDN links, so only plain http(s) URLs are accepted.
 */
async function downloadGeneratedImage(url: string): Promise<Uint8Array> {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error(`Generated image URL is not valid: ${redactMediaDetail(url)}`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Generated image URL must use http or https')
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Generated image download failed with HTTP ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('Generated image download returned no bytes')
  if (bytes.length > GENERATED_IMAGE_DOWNLOAD_LIMIT) throw new Error('Generated image download exceeds the 20 MB limit')
  return bytes
}

/**
 * Turn whatever shape the provider answered with into stored image attachments.
 *
 * Four vendor shapes arrive here — the Images API's `data[]`, Gemini's inline
 * parts, Imagen's `predictions`, DashScope's `choices[].message.content[].image`
 * and the Responses API's `output[].result` — and they are read in that order
 * rather than merged, so the first shape that carries anything wins and a body
 * that matches two of them cannot produce the same image twice.
 *
 * A URL-only result is downloaded and stored like a base64 one, because an image
 * the user cannot see is not an image: only a failed download keeps the URL. A
 * body carrying no image at all is an error rather than an empty success, which
 * is what makes the fallback ladder try the next route.
 * @param model - the selection the image came from, used to name the attachment.
 * @param value - the provider's response body, of unknown shape.
 * @param attachments - the Host's attachment store, required for any byte result.
 * @returns The model name and one entry per generated image, with its attachment.
 */
export async function persistGeneratedImages(model: string, value: unknown, attachments: AttachmentStore | undefined): Promise<{ readonly model: string; readonly images: readonly { readonly url?: string; readonly attachment?: ImageAttachmentRef }[] }> {
  const root = record(value)
  const safeModelName = model.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'generated-image'
  const geminiParts = (Array.isArray(root.candidates) ? root.candidates : []).flatMap((candidate) => {
    const content = record(record(candidate).content)
    return Array.isArray(content.parts) ? content.parts : []
  }).flatMap((part) => {
    const item = record(part)
    const inline = record(item.inlineData ?? item.inline_data)
    return typeof inline.data === 'string' ? [{ b64_json: inline.data }] : []
  })
  const imagenPredictions = (Array.isArray(root.predictions) ? root.predictions : []).flatMap((prediction) => {
    const item = record(prediction)
    const encoded = item.bytesBase64Encoded ?? item.bytes_base64_encoded
    return typeof encoded === 'string' ? [{ b64_json: encoded }] : []
  })
  // OpenAI Responses image generation returns an image_generation_call in
  // `output[].result` rather than the Images API's `data[].b64_json` shape.
  const responseImages = (Array.isArray(root.output) ? root.output : []).flatMap((output) => {
    const item = record(output)
    if (typeof item.result === 'string' && item.result.trim() !== '') return [{ b64_json: item.result }]
    const encoded = item.b64_json ?? item.b64Json ?? item.base64
    return typeof encoded === 'string' && encoded.trim() !== '' ? [{ b64_json: encoded }] : []
  })
  // DashScope's native image route answers with output.choices[].message.content[]
  // parts whose {image: url} entries are the generated images — the same shape
  // huobao-canvas' dashscope protocol adapter reads.
  const dashscopeParts = (Array.isArray(record(root.output).choices) ? record(root.output).choices as unknown[] : []).flatMap((choice) => {
    const message = record(record(choice).message)
    return Array.isArray(message.content) ? message.content : []
  }).flatMap((part) => {
    const image = record(part).image
    return typeof image === 'string' && image.trim() !== '' ? [{ url: image.trim() }] : []
  })
  const payload = Array.isArray(root.data) ? root.data : Array.isArray(root.images) ? root.images : geminiParts.length > 0 ? geminiParts : dashscopeParts.length > 0 ? dashscopeParts : imagenPredictions.length > 0 ? imagenPredictions : responseImages
  const images: Array<{ url?: string; attachment?: ImageAttachmentRef }> = []
  for (const [index, candidate] of payload.entries()) {
    const item = record(candidate)
    const url = [item.url, item.image_url, item.download_url].find(entry => typeof entry === 'string' && entry.trim() !== '') as string | undefined
    const encoded = [item.b64_json, item.b64Json, item.base64].find(entry => typeof entry === 'string' && entry.trim() !== '') as string | undefined
    if (encoded !== undefined) {
      if (attachments === undefined) throw new Error('Harness attachment storage is required for base64 image generation results')
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) throw new MediaRouteLimitation(`Generated image ${index + 1} is not valid base64`)
      const mediaType = generatedImageMediaType(bytes)
      const attachment = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType, name: `${safeModelName}-${index + 1}.${mediaType.split('/')[1]}` })
      images.push({ ...(url === undefined ? {} : { url }), attachment })
    } else if (url !== undefined) {
      // URL-only results must reach the user as a visible image, so download
      // the bytes and route them through the same attachment flow as base64
      // results. A failed download keeps the URL as the render fallback.
      if (attachments === undefined) { images.push({ url }); continue }
      try {
        const bytes = await downloadGeneratedImage(url)
        const mediaType = generatedImageMediaType(bytes)
        const attachment = await attachments.saveImage({ data: bytes, mediaType, name: `${safeModelName}-${index + 1}.${mediaType.split('/')[1]}` })
        images.push({ url, attachment })
      } catch {
        images.push({ url })
      }
    }
  }
  if (images.length === 0) throw new Error('The selected image model returned no image data')
  return { model, images }
}

function generatedImageMediaType(bytes: Uint8Array): ImageMediaType {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  throw new MediaRouteLimitation('The selected image model returned an unsupported image format')
}

/**
 * Render a persisted image result for the conversation.
 *
 * A text summary always comes first, so the model can read which model produced
 * what even in a transport that drops images; an attachment renders as an image,
 * and a URL that never became one renders as clickable text rather than as raw
 * JSON.
 * @param value - the persisted result the image tool returned.
 * @returns The content blocks to append, summary first.
 */
export function renderGeneratedImages(value: unknown): ContentBlock[] {
  const root = record(value)
  const images = Array.isArray(root.images) ? root.images.map(record) : []
  const summary = {
    model: typeof root.model === 'string' ? root.model : undefined,
    images: images.map(image => ({
      ...(typeof image.url === 'string' ? { url: image.url } : {}),
      ...(record(image.attachment).attachmentId === undefined ? {} : { attachmentId: record(image.attachment).attachmentId }),
    })),
  }
  return [
    { type: 'text', text: JSON.stringify(summary) },
    ...images.flatMap((image): ContentBlock[] => {
      if (record(image.attachment).attachmentId !== undefined) return [{ type: 'image', attachment: image.attachment as ImageAttachmentRef }]
      // A URL without an attachment (failed download, no attachment store) must
      // still surface as visible, clickable content instead of raw JSON.
      return typeof image.url === 'string' ? [{ type: 'text', text: `Generated image: ${image.url}` }] : []
    }),
  ]
}

function audioMimeType(file: string): string { const extension = path.extname(file).toLowerCase(); return extension === '.webm' ? 'audio/webm' : extension === '.ogg' || extension === '.opus' ? 'audio/ogg' : extension === '.wav' ? 'audio/wav' : extension === '.m4a' || extension === '.mp4' ? 'audio/mp4' : extension === '.flac' ? 'audio/flac' : 'audio/mpeg' }

/**
 * One group of registered media tools: the names it mounted, and its release.
 *
 * The names are read back off the definitions that were registered rather than
 * declared beside them, so "what is mounted right now" cannot name a tool some
 * registration does not use.
 */
export interface MediaToolRegistration {
  /** Names of the tools this registration mounted, in mount order. */
  readonly names: readonly string[]
  /** Releases every registration this group made. */
  readonly dispose: () => void
}

/**
 * The two names the image/video switch governs.
 *
 * One literal each, read by both the registration that mounts the tool and the status
 * the settings surface renders: the switch must not be able to claim a tool whose
 * registration spells it another way. `gated` in that status is about the capability —
 * which tools the switch owns — while the mounted names are reported separately, so a
 * profile that cannot mount the legacy aliases is not described as owning fewer tools.
 */
export const MEDIA_GENERATION_TOOL_NAMES = { image: 'freecodego_generate_image', video: 'freecodego_generate_video' } as const

/** What a Host with no tool registry yields: nothing mounted, nothing to release. */
const NO_MEDIA_TOOLS: MediaToolRegistration = { names: [], dispose: () => undefined }

/** The output both media tool groups answer with when they have no renderer of their own. */
const GENERIC_MEDIA_OUTPUT: ToolDefinitionShape['output'] = {
  schema: { type: 'object' as const, additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/**
 * Register the image and video generation tools, and return their registration.
 *
 * A disposer rather than an `ctx.effect` because these two are the ones a settings
 * switch mounts and unmounts (`mediaGenerationEnabled`): a registration whose only
 * release was teardown would make that switch a one-way door. The caller owns the
 * lifetime, which is the contract `engineering.ts` already uses for the tools its own
 * switches select.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the mounted names and the disposer that releases them.
 */
export function registerGenerationTools(host: MediaGenerationHost): MediaToolRegistration {
  const tools = host.ctx.get('tools') as { register: (tool: ToolDefinitionShape) => () => void } | undefined
  if (tools === undefined) return NO_MEDIA_TOOLS
  const imageTool = rawAgnesTool({
    name: MEDIA_GENERATION_TOOL_NAMES.image,
    description: 'Generate an image with the user-selected default media model. Do not pass a model id. Pass images to edit or fuse existing pictures on the providers that accept sources. If that provider is unavailable, the Host safely tries another configured image model.',
    parameters: { type: 'object', properties: { prompt: { type: 'string', minLength: 1, maxLength: 20_000 }, size: { type: 'string' }, quality: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 4 }, images: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Optional source images to edit or fuse, as http(s) or data:image/... URLs. Providers that cannot take sources are skipped.' } }, required: ['prompt'], additionalProperties: false },
    output: {
      schema: GENERIC_MEDIA_OUTPUT.schema,
      render: (_args: unknown, value: unknown) => renderGeneratedImages(value),
    },
    execute: async (args: ImageGenerationArgs, exec: { readonly agent?: Agent; readonly signal: AbortSignal }) => {
      return host.generateImageWithFallback(args, exec.signal)
    },
    presentCall: (args: { prompt: string }) => ({ card: 'generic', title: `Generate image: ${args.prompt}` }),
  })
  const videoTool = rawAgnesTool({
    name: MEDIA_GENERATION_TOOL_NAMES.video,
    description: 'Generate a video with the user-selected default media model. Do not pass a model id. If that provider is unavailable before task creation, the Host safely tries another configured video model.',
    parameters: { type: 'object', properties: { prompt: { type: 'string', minLength: 1, maxLength: 20_000 }, seconds: { type: 'integer', minimum: 1, maximum: 60, description: 'Video duration in seconds. The upper bound is the widest any configured route accepts; a route whose known durations cannot render this value is skipped, and the error names the durations it does accept, rather than returning a different length.' }, aspectRatio: { type: 'string' }, image: { type: 'string', description: 'Optional first-frame image URL or data URL.' }, lastImage: { type: 'string', description: 'Optional last-frame image URL or data URL, for providers that interpolate between two frames.' }, images: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Optional subject/style reference images, as http(s) or data:image/... URLs. These are a different role from the first frame: providers that cannot take references are skipped.' }, video: { type: 'string', description: 'Optional source video URL to edit or extend instead of generating. Providers without such a route are skipped.' } }, required: ['prompt'], additionalProperties: false },
    output: GENERIC_MEDIA_OUTPUT,
    execute: async (args: MediaVideoArgs, exec: { readonly signal: AbortSignal }) => {
      return host.generateVideoWithFallback(args, exec.signal)
    },
    presentCall: (args: { prompt: string }) => ({ card: 'generic', title: `Generate video: ${args.prompt}` }),
  })
  const disposeImage = tools.register(imageTool)
  const disposeVideo = tools.register(videoTool)
  return { names: [imageTool.name, videoTool.name], dispose: () => { disposeImage(); disposeVideo() } }
}

/**
 * Register the audio generation and transcription tools, and return their registration.
 *
 * Unconditional, and separate from {@link registerGenerationTools} on purpose: the
 * settings switch is about producing a picture or a clip, while these two either write
 * a file into the active workspace or read one out of it. Nothing unmounts them before
 * teardown, so the caller keeps them under one `ctx.effect`.
 * @param host - the Host surface this remote call reaches its services through.
 * @returns the mounted names and the disposer that releases them.
 */
export function registerAudioTools(host: MediaGenerationHost): MediaToolRegistration {
  const tools = host.ctx.get('tools') as { register: (tool: ToolDefinitionShape) => () => void } | undefined
  if (tools === undefined) return NO_MEDIA_TOOLS
  const audioTool = rawAgnesTool({
    name: 'freecodego_generate_audio',
    description: 'Generate speech/audio with the user-selected default media model. Do not pass a model id. The Host can fall back to another configured audio model when the selected provider is unavailable.',
    parameters: { type: 'object', properties: { input: { type: 'string', minLength: 1, maxLength: 50_000 }, voice: { type: 'string' }, format: { type: 'string', enum: [...AUDIO_FORMATS] }, speed: { type: 'number', minimum: 0.25, maximum: 4 } }, required: ['input'], additionalProperties: false },
    output: GENERIC_MEDIA_OUTPUT,
    execute: async (args: { input: string; voice?: string; format?: string; speed?: number }, exec: { readonly agent?: Agent; readonly signal: AbortSignal }) => {
      return host.generateAudioWithFallback(args, exec.agent?.session.header.cwd, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Generate audio with FreeCodeGo' }),
  })
  const transcribeTool = rawAgnesTool({
    name: 'freecodego_transcribe_audio',
    description: 'Transcribe an audio file with the fixed free Groq whisper-large-v3-turbo model. The file must be inside the active workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, language: { type: 'string', maxLength: 32, description: 'Optional language hint for the transcriber, as the provider spells it; omitted means the provider auto-detects.' } }, required: ['path'], additionalProperties: false },
    output: GENERIC_MEDIA_OUTPUT,
    execute: async (args: { path: string; language?: string }, exec: { readonly agent?: Agent }) => {
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) throw new Error('Audio transcription requires an active workspace')
      const root = path.resolve(cwd); const requested = path.resolve(root, args.path); const relative = path.relative(root, requested)
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Audio path must remain inside the active workspace')
      // This tool hands file bytes to a third-party provider, so it applies the
      // two checks the credential guard gives `read`: the *lexical* path and the
      // path the filesystem actually resolves to. The guard itself only covers
      // read/write/edit/bash, and a workspace-relative check alone would pass a
      // symlink planted in the repo (`link.mp3` → `~/.ssh/id_rsa`) and ship the
      // bytes it points at to the transcription endpoint.
      if (host.policy.get()?.envReadGuardEnabled !== false) {
        if (isCredentialPath(args.path) || isCredentialPath(requested)) throw new Error(TRANSCRIBE_CREDENTIAL_DENIAL)
      }
      // realpath needs the leaf to exist; a missing file is left to `readFile`,
      // whose error names the path the model actually asked for.
      const file = await fs.realpath(requested).catch(() => requested)
      if (host.policy.get()?.envReadGuardEnabled !== false && isCredentialPath(file)) throw new Error(TRANSCRIBE_CREDENTIAL_DENIAL)
      // Both sides are resolved before they are compared: the workspace itself can
      // be reached through a symlink or an 8.3 short name (`C:\Users\ADMINI~1\…`),
      // and a resolved file never shares a prefix with an unresolved root — every
      // legitimate path would read as an escape.
      const realRoot = await fs.realpath(root).catch(() => root)
      const resolvedRelative = path.relative(realRoot, file)
      if (resolvedRelative === '' || resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
        throw new Error('Audio path must remain inside the active workspace: this path resolves through a symlink to a file outside it')
      }
      // The limit is measured against the open file, before its bytes are read:
      // a recording handed to this tool can be gigabytes, and reading first meant
      // holding all of it in memory to refuse it. Opening once and reading from
      // that same handle also means the size that was checked and the bytes that
      // are read cannot be two different files.
      const handle = await fs.open(file, 'r')
      let data: Buffer
      try {
        const size = (await handle.stat()).size
        if (size > TRANSCRIBE_LIMIT_BYTES) throw new Error(`Audio file exceeds the ${String(TRANSCRIBE_LIMIT_BYTES / 1_000_000)} MB transcription limit`)
        data = await handle.readFile()
      } finally {
        await handle.close()
      }
      // A file that grew between the size check and the read would slip past the
      // comparison above, and the provider's ceiling is the same number.
      if (data.length > TRANSCRIBE_LIMIT_BYTES) throw new Error(`Audio file exceeds the ${String(TRANSCRIBE_LIMIT_BYTES / 1_000_000)} MB transcription limit`)
      const mimeType = audioMimeType(file)
      return host.groqWhisperTranscribe(data.toString('base64'), mimeType, args.language)
    },
    presentCall: (args: { path: string }) => ({ card: 'generic', title: `Transcribe audio: ${args.path}` }),
  })
  const disposeAudio = tools.register(audioTool)
  const disposeTranscribe = tools.register(transcribeTool)
  return { names: [audioTool.name, transcribeTool.name], dispose: () => { disposeAudio(); disposeTranscribe() } }
}

/**
 * Generate an image, walking the configured routes until one delivers.
 *
 * The route's *provider* selects the transport, never a keyword in the model's
 * name: a gateway model whose id contains "image" is still the gateway's, and
 * sending it down the Agnes transport failed on every profile without an Agnes
 * credential.
 * @param host - the Host surface this remote call reaches its services through.
 * @param args - the prompt and any reference images the caller supplied.
 * @param signal - aborts the request when the caller cancels.
 * @returns The persisted image result, once a route has produced one.
 */
export async function generateImageWithFallback(host: MediaGenerationHost, args: ImageGenerationArgs, signal: AbortSignal): Promise<unknown> {
  return withMediaFallback(host, 'image', signal, async (route) => {
    // The Agnes transport is selected by *provider*, never by the model name.
    //
    // The predicate used to also accept any id whose text contained an image or
    // video keyword, which sent unrelated providers' models down the Agnes
    // transport: `gpt-image-2` belongs to the gateway, but its name matched, so
    // it failed with "Agnes credential service is not configured" on every
    // profile without an Agnes account. A model's name describes what it does,
    // not who serves it.
    const references = referenceImageUrls(args.images)
    if (route.provider === 'agnes') {
      // The Agnes transport takes no sources of its own, so a request that
      // carries them has to reach a provider that does rather than have them
      // silently dropped here.
      if (references.length > 0) throw new Error('Reference images are unavailable on the "agnes" media route')
      const result = await host.requireAgnes().generateImage({ prompt: args.prompt, model: route.model, ...(args.size === undefined ? {} : { size: args.size }), signal })
      return persistGeneratedImages(visibleMediaSelection(route.selection), { data: result.images.map(image => ({ ...(image.url === undefined ? {} : { url: image.url }), ...(image.b64Json === undefined ? {} : { b64_json: image.b64Json }) })) }, host.ctx.get('attachments'))
    }
    // A reference image lands somewhere different on every protocol: content
    // parts on DashScope, inline/file parts on Gemini, base64 instances on
    // Imagen, an `image` array on Seedream's generations body, and an edits
    // endpoint on the other OpenAI-shaped routes.
    const nativeGemini = await isNativeGeminiRoute(host, route)
    const nativeImagen = nativeGemini && /imagen/i.test(route.model)
    const nativeDashscope = !nativeGemini && await isNativeDashscopeRoute(host, route)
    const firstReference = references[0]
    // Imagen takes its source as base64 bytes, so only an inline data URL has a
    // form that protocol can read; a remote URL has no field to travel in.
    const imagenReference = firstReference === undefined ? undefined : dataUrlImage(firstReference)
    if (nativeImagen && references.length > 0 && (references.length > 1 || imagenReference === undefined)) throw new Error(`Reference images without an inline base64 payload are unavailable on the "${route.provider}" media route`)
    // Gemini reads an inline part for a data URL and a file reference otherwise.
    const geminiReferenceParts = references.map((url) => {
      const inline = dataUrlImage(url)
      return inline === undefined ? { fileData: { fileUri: url, mimeType: guessImageMediaType(url) } } : { inlineData: { mimeType: inline.mimeType, data: inline.data } }
    })
    const aspectRatio = args.size === undefined ? undefined : sizeToAspectRatio(args.size)
    const candidateCount = args.n === undefined ? undefined : Math.min(8, Math.max(1, Math.floor(args.n)))
    const generationsBody = {
      model: route.model,
      prompt: args.prompt,
      ...(args.size === undefined ? {} : { size: args.size }),
      ...(args.quality === undefined ? {} : { quality: args.quality }),
      n: args.n ?? 1,
      // GPT Image models return base64 data by default and reject the
      // legacy DALL-E-only response_format field.
      ...(/gpt[-_.]?image/i.test(route.model) ? {} : { response_format: 'b64_json' }),
    }
    // OpenAI-shaped routes carry reference images on /images/edits, whose JSON
    // contract takes the first source as `image` and the rest as `images[]`.
    const usesEditsEndpoint = references.length > 0 && !nativeGemini && !nativeImagen && !nativeDashscope && !imagesViaGenerationBody(route.provider)
    const endpoint = nativeImagen ? `/models/${encodeURIComponent(route.model)}:predict` : nativeGemini ? `/models/${encodeURIComponent(route.model)}:generateContent` : nativeDashscope ? '/api/v1/services/aigc/multimodal-generation/generation' : usesEditsEndpoint ? '/images/edits' : '/images/generations'
    const imageBody = nativeImagen
      ? { instances: [{ prompt: args.prompt, ...(imagenReference === undefined ? {} : { image: { bytesBase64Encoded: imagenReference.data, mimeType: imagenReference.mimeType } }) }], parameters: { sampleCount: args.n ?? 1, ...(aspectRatio === undefined ? {} : { aspectRatio }) } }
      : nativeGemini
        ? { contents: [{ role: 'user', parts: [{ text: args.prompt }, ...geminiReferenceParts] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(candidateCount === undefined ? {} : { candidateCount }) } }
        : nativeDashscope
          ? {
            // DashScope carries the prompt as a multimodal message part and the
            // specifications in parameters.*; the OpenAI shape is not accepted
            // on this route at all (huobao-canvas' dashscope protocol adapter,
            // whose size values are written 2048*2048).
            model: route.model,
            input: { messages: [{ role: 'user', content: [{ text: args.prompt }, ...references.map(url => ({ image: url }))] }] },
            parameters: { ...(candidateCount === undefined ? {} : { n: candidateCount }), ...(args.size === undefined ? {} : { size: args.size.replace(/[x×]/giu, '*') }), watermark: false },
          }
          : usesEditsEndpoint
            ? {
            model: route.model,
            prompt: args.prompt,
            ...(firstReference === undefined ? {} : { image: { url: firstReference } }),
            ...(references.length < 2 ? {} : { images: references.slice(1).map(url => ({ url })) }),
            ...(args.size === undefined ? {} : { size: args.size }),
            n: args.n ?? 1,
          }
            : { ...generationsBody, ...(references.length === 0 ? {} : { image: references }) }
    let value: unknown
    try {
      value = await host.gatewayMediaJson(route.selection, endpoint, imageBody, signal)
    } catch (error) {
      // Some OpenAI-compatible gateways reject optional image parameters
      // (or rewrite size into unsupported width/height fields). Retry once
      // with the Responses image-generation contract for gateway GPT Image
      // routes, then fall back to the portable model+prompt shape. Prompt
      // errors still propagate immediately.
      if (nativeGemini || nativeImagen || nativeDashscope || (!unknownImageParameter(error) && !imageEndpointUnavailable(error))) throw error
      // Every degraded retry below drops optional parameters — size, quality, `n`,
      // `response_format` — and that is what it is for: those are the fields an
      // OpenAI-compatible server most often refuses. None of them may drop the
      // *source images*. A retry without them does not retry this request; it
      // performs a different one and returns a plausible picture that answers a
      // question nobody asked, while the result says nothing about the sources
      // being ignored. Measured before this: on a generation-shaped reference route
      // (`volcengine` Seedream), a server that answered `unknown parameter: size`
      // was retried with `{ model, prompt }` — `image` gone — and that call
      // succeeded. The tool's own contract is "pass images to edit or fuse", and
      // `mediaVideoRequest` states the rule for the same situation: a route steps
      // aside rather than dropping media.
      const portableBody = (): Record<string, unknown> => ({ model: route.model, prompt: args.prompt, ...(references.length === 0 ? {} : { image: references }) })
      if (usesEditsEndpoint) {
        // A gateway without the edits route answers 404/405/501 (or rejects the
        // sources field); the same request then travels as a generation body
        // carrying them, which is the shape Seedream already uses.
        value = await host.gatewayMediaJson(route.selection, '/images/generations', { ...generationsBody, image: references }, signal)
      } else if (references.length > 0) {
        // A route that already took the sources in its generations body has only
        // one retry left that can carry them: the Responses attempt below sends its
        // source as an input part this call does not build, so it would generate
        // from the prompt alone. The portable shape keeps them, and a server that
        // refuses the field itself ends this route instead of quietly serving a
        // different request — the ladder then reaches a route that can use them.
        value = await host.gatewayMediaJson(route.selection, endpoint, portableBody(), signal)
      } else if (/gpt[-_.]?image/i.test(route.model) && imageEndpointMayBeResponses(error)) {
        try {
          value = await host.gatewayMediaJson(route.selection, '/responses', {
            model: route.model,
            input: [{ role: 'user', content: [{ type: 'input_text', text: args.prompt }] }],
            tools: [{ type: 'image_generation' }],
          }, signal)
        } catch (responseError) {
          if (!unknownImageParameter(responseError) && !imageEndpointUnavailable(responseError)) throw responseError
          value = await host.gatewayMediaJson(route.selection, endpoint, portableBody(), signal)
        }
      } else {
        value = await host.gatewayMediaJson(route.selection, endpoint, portableBody(), signal)
      }
    }
    return persistGeneratedImages(visibleMediaSelection(route.selection), value, host.ctx.get('attachments'))
  })
}

/**
 * Generate a video, walking the configured routes until one delivers.
 *
 * Same transport rule as images: the provider decides, so a gateway model with a
 * `-video` suffix stays on the gateway. A duration this route cannot render is
 * raised as a typed limitation rather than a failure, which is what lets the
 * ladder move on instead of ending the call.
 * @param host - the Host surface this remote call reaches its services through.
 * @param args - the prompt, duration and any reference material.
 * @param signal - aborts the request when the caller cancels.
 * @returns The provider's finished video result, after polling.
 */
export async function generateVideoWithFallback(host: MediaGenerationHost, args: MediaVideoArgs, signal: AbortSignal): Promise<unknown> {
  return withMediaFallback(host, 'video', signal, async (route) => {
    // Same rule as images: the provider decides the transport. A `-video` suffix
    // in a gateway model's name must not divert it to the Agnes transport.
    if (route.provider === 'agnes') {
      // Agnes renders only its documented range, and a duration outside it is this
      // route's limitation rather than a bad request: the generic video tool
      // advertises 1..60, so a request inside that range arriving here is the
      // caller following the schema. Raised as a typed limitation so the ladder
      // tries the next configured route instead of ending the call.
      // The window is declared here rather than imported: `media-utils.ts` owns the
      // rule and the wording (`videoSecondsRefusal`), while the numbers come from
      // this client's own list — the same list its tool schema offers. Agnes is the
      // one route whose window is declared by its caller instead of by the protocol
      // table, which is what keeps a wire-protocol module from depending on an HTTP
      // client.
      const unserved = videoSecondsRefusal(route.provider, args.seconds, { kind: 'one of', values: AGNES_VIDEO_SECONDS.map(Number) })
      if (unserved !== undefined) throw new MediaRouteCapabilityRefusal(unserved)
      return host.requireAgnes().createVideo({ prompt: args.prompt, model: route.model, ...(args.seconds === undefined ? {} : { seconds: String(args.seconds) }), ...(args.aspectRatio === undefined ? {} : { aspectRatio: args.aspectRatio }), ...(args.image === undefined ? {} : { images: [args.image] }), signal })
    }
    const target = mediaVideoRequest(route, args)
    // A protocol may require a header on its create call alone (DashScope
    // rejects video synthesis outright without X-DashScope-Async) or may name
    // the model under a field of its own (Kling's model_name); every other
    // protocol keeps the four-argument call.
    const options = mediaRequestOptions(target)
    const value = options === undefined
      ? await host.gatewayMediaJson(route.selection, target.endpoint, target.body, signal)
      : await host.gatewayMediaJson(route.selection, target.endpoint, target.body, signal, options)
    // Kling's status route is the create route it just chose, so the poll cannot
    // guess it from the provider alone.
    return pollGeneratedVideo(host, route, value, signal, target.statusPath)
  })
}

/**
 * Publish generated media in one atomic step: stage the bytes in a sibling and
 * rename them over the target.
 *
 * A direct write to the target is not equivalent. The caller already holds the
 * complete payload, so the interesting failure is the process dying mid-write
 * (or two generations of the same model racing): the target then exists as a
 * truncated container — a file whose header parses but whose payload is missing,
 * which downstream tools accept as a real asset. The rename is what makes the
 * target appear only once it is whole.
 *
 * The per-write random suffix is what keeps concurrent generations from sharing
 * one staging path: with a fixed name the loser's `rename` finds the file the
 * winner already moved away, and a lost write looks exactly like a successful
 * one. `trust.ts`'s record store stages its own writes the same way, for the same
 * reason.
 *
 * `@deepseek-ai/dsh-atomic-write` cannot serve this call. Its `writeFileAtomic`
 * accepts only a `string` and exposes no `encoding`, so binary content would have
 * to be handed over as a latin1 string that its internal `writeFile` then
 * re-encodes as UTF-8 — corrupting every byte >= 0x80. Passing the `Uint8Array`
 * straight to `writeFile` also avoids a second full-size copy of a file that may
 * be tens of megabytes.
 * @param file - final path receiving the media bytes.
 * @param bytes - the complete media payload.
 */
async function writeGeneratedMedia(file: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    // 0600: generated media belongs to the user who asked for it, not to every
    // local account that can read the workspace. `wx` refuses to follow a
    // symlink planted at the staging path and keeps a concurrent writer out.
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } catch (error) {
    // A failure before the rename must not leave an orphan staging file behind;
    // the target is still absent, so the caller sees a clean failure. Cleanup is
    // best-effort: a staging file this process cannot remove must not replace the
    // failure that actually stopped the write.
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Generate speech into a file in the workspace.
 *
 * The workspace is validated before any quota is spent, because a missing one can
 * never be recovered by trying another route. The format is validated here too:
 * it reaches both the request and the resulting filename, so a caller-supplied
 * `../` in it would resolve the write out of the workspace — the tool schema's
 * `enum` is a description, not a gate.
 * @param host - the Host surface this remote call reaches its services through.
 * @param args - the text to speak, and the voice, format and speed to use.
 * @param cwd - the workspace the audio file is written into.
 * @param signal - aborts the request when the caller cancels.
 * @returns The generated file's path and format, once it is written.
 */
export async function generateAudioWithFallback(host: MediaGenerationHost, args: { input: string; voice?: string; format?: string; speed?: number }, cwd: string | undefined, signal: AbortSignal): Promise<unknown> {
  // The workspace precondition can never recover by trying another route:
  // validate it before spending any provider quota on the request.
  if (cwd === undefined) throw new Error('Audio generation requires an active workspace')
  // The format reaches both the provider request and the generated file's name,
  // and the tool schema's `enum` is a description, not a gate: the registry hands
  // tools their raw arguments and each tool validates its own. Trusting the value
  // made `format: "../../../../tmp/pwned"` resolve the write out of the
  // generated-media directory — and out of the workspace with enough segments — so
  // the whitelist is what keeps the name a name. An unknown value degrades to mp3,
  // which is also what the provider is asked for, so the reported mime type still
  // describes the bytes on disk.
  const extension = args.format !== undefined && AUDIO_FORMAT_NAMES.has(args.format) ? args.format : 'mp3'
  return withMediaFallback(host, 'audio', signal, async (route) => {
    const response = await gatewayMediaFetch(host, route.selection, '/audio/speech', {
      model: route.model, input: args.input, voice: args.voice ?? 'alloy', response_format: extension, ...(args.speed === undefined ? {} : { speed: args.speed }),
    }, signal)
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    let bytes = new Uint8Array(await response.arrayBuffer())
    if (contentType.includes('json')) {
      // Some gateways answer /audio/speech with a JSON envelope carrying the
      // base64 audio instead of the raw binary stream. Extract the audio and
      // persist it exactly like a binary response.
      let payload: Record<string, unknown>
      try { payload = record(JSON.parse(new TextDecoder().decode(bytes))) } catch { throw new Error('FreeCodeGo /audio/speech returned invalid JSON') }
      const encoded = [payload.b64_json, payload.b64Json, payload.audio, payload.data].find(entry => typeof entry === 'string' && entry.trim() !== '') as string | undefined
      if (encoded === undefined) {
        if (payload.error !== undefined || payload.message !== undefined) throw new Error(`FreeCodeGo /audio/speech failed: ${redactMediaDetail(JSON.stringify(payload))}`)
        throw new Error('FreeCodeGo /audio/speech returned no audio data')
      }
      bytes = new Uint8Array(Buffer.from(encoded, 'base64'))
      if (bytes.length === 0) throw new Error('FreeCodeGo /audio/speech returned invalid base64 audio data')
    }
    const directory = path.join(cwd, '.freecodego', 'generated-media')
    await fs.mkdir(directory, { recursive: true })
    // Two calls can land in the same millisecond — the harness runs
    // parallel-capable tool calls in a pool — and a name built from the clock
    // alone then collides: both results reported the same path and the file held
    // whichever payload was written second, so the first result pointed at a
    // file that was not its audio. The timestamp stays for a readable directory
    // listing; the random suffix is what makes the name unique.
    const file = path.join(directory, `audio-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`)
    await writeGeneratedMedia(file, bytes)
    // A JSON envelope is not the audio's media type; report the decoded audio.
    const mimeType = contentType.includes('json') || contentType === '' ? `audio/${extension}` : contentType
    return { model: visibleMediaSelection(route.selection), path: file, mimeType, bytes: bytes.length }
  })
}

/**
 * Audio container formats the tool may write, in the order the schema offers
 * them; anything else degrades to mp3.
 *
 * One list, two readers: the tool schema's `enum` and the check that decides
 * whether a requested format is written at all. Drift is silent in the worse
 * direction — a format the schema offers and this list does not know is not
 * refused, it is *replaced*, so the caller receives a different container than
 * it asked for with nothing saying why.
 */
export const AUDIO_FORMATS: readonly string[] = ['mp3', 'wav', 'opus', 'aac', 'flac']
/** The same list as a lookup: a second binding, not a second list. */
const AUDIO_FORMAT_NAMES: ReadonlySet<string> = new Set(AUDIO_FORMATS)

/** Transcription refusal for a credential file, worded like the credential guard. */
/**
 * The provider's own ceiling, and the one this tool refuses on.
 *
 * It is a byte count because it is compared to a file's size, and one constant
 * feeds both the comparison and the message so the number a person reads cannot
 * drift away from the number that was enforced.
 */
const TRANSCRIBE_LIMIT_BYTES = 27_000_000

const TRANSCRIBE_CREDENTIAL_DENIAL = 'Blocked by the FreeCodeGo credential guard: this path looks like a credential or secret file. Ask the user for the needed value instead of reading it (envReadGuardEnabled in FreeCodeGo settings controls this guard).'

// ─── Per-provider circuit breaker ───────────────────────────────────────────

/** Consecutive failures before a route is skipped for the window. */
const CIRCUIT_FAILURE_THRESHOLD = 2
/** How long an open circuit stays open before a retry is allowed. */
const CIRCUIT_RESET_MS = 5 * 60_000

interface CircuitState {
  failures: number
  openUntil: number
}

/**
 * Session-scoped breaker memory: a provider that just failed twice is skipped
 * first on the next request within the window instead of being retried
 * ahead of healthy routes on every call (Advisor's backoff pattern, applied
 * to media fallback chains). Routes still get a retry after the window, so a
 * recovered provider rejoins automatically.
 */
const mediaCircuits = new Map<string, CircuitState>()

function circuitKey(route: MediaRoute): string {
  return `${route.provider}\u0000${route.model}`.toLowerCase()
}

function circuitOpen(route: MediaRoute, now: number): boolean {
  const state = mediaCircuits.get(circuitKey(route))
  return state !== undefined && state.openUntil > now
}

function circuitRecordFailure(route: MediaRoute, now: number): void {
  const key = circuitKey(route)
  const state = mediaCircuits.get(key) ?? { failures: 0, openUntil: 0 }
  state.failures += 1
  if (state.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntil = now + CIRCUIT_RESET_MS
    state.failures = 0
  }
  mediaCircuits.set(key, state)
  // Bound memory: the route set is small but a broken catalog could grow it.
  if (mediaCircuits.size > 256) {
    const oldest = mediaCircuits.keys().next().value
    if (oldest !== undefined) mediaCircuits.delete(oldest)
  }
}

function circuitRecordSuccess(route: MediaRoute): void {
  mediaCircuits.delete(circuitKey(route))
}

/**
 * Run one media request against the route ladder, with a per-route circuit.
 *
 * Two passes rather than one: routes whose circuit is open are tried after the
 * healthy ones, so traffic goes where it is likely to work while a recovered
 * provider is still discovered inside the same request. Only a route that failed
 * to *deliver* feeds the breaker — a route that declined by its own declaration
 * never sent anything, which is no evidence about that provider's health.
 * @param host - the Host surface this remote call reaches its services through.
 * @param category - the media category whose routes are walked.
 * @param signal - aborts the request when the caller cancels.
 * @param execute - the request to run against whichever route is selected.
 * @returns The first successful result, or an error naming every route's failure.
 */
export async function withMediaFallback<T>(host: MediaGenerationHost, category: MediaCategory, signal: AbortSignal, execute: (route: MediaRoute) => Promise<T>): Promise<T> {
  const preferred = mediaDefault(host, category)
  const candidates = await mediaCandidates(host, category, preferred)
  const failures: string[] = []
  const now = Date.now()
  // Two passes: skip open circuits first so healthy routes absorb the traffic,
  // then retry the skipped ones (circuit still open → they fail again, but a
  // recovered provider is found without a separate request).
  const ordered = [
    ...candidates.filter(route => !circuitOpen(route, now)),
    ...candidates.filter(route => circuitOpen(route, now)),
  ]
  for (const route of ordered) {
    if (signal.aborted) throw new Error('Media request aborted by caller')
    try {
      const result = await execute(route)
      circuitRecordSuccess(route)
      return result
    } catch (error) {
      if (!mediaFallbackAllowed(error, signal)) throw error
      // Only a route that failed to deliver feeds the breaker. A route that
      // declined by its own declaration — a length it cannot render — never sent
      // a request, so it is no evidence about that provider's health.
      if (!(error instanceof MediaRouteCapabilityRefusal)) circuitRecordFailure(route, Date.now())
      // Every other exit in this module that reports a provider body masks it
      // first, and this is the one a person actually reads: the aggregate
      // returned once every route has failed.
      failures.push(`${visibleMediaSelection(route.selection)}: ${redactMediaDetail(error instanceof Error ? error.message : String(error))}`)
    }
  }
  throw new Error(`No configured ${category} model completed the request${failures.length === 0 ? '' : `: ${failures.join(' | ')}`}`)
}

/**
 * Every route that could serve one media category, best first.
 *
 * The user's own category override outranks the automatic classification, and it
 * is consulted for every provider rather than only the native ones: the override
 * used to be read in one path, so a model a user moved into a category was still
 * never offered as a fallback. A provider whose model list cannot be read is
 * skipped rather than failing the ladder.
 * @param host - the Host surface this remote call reaches its services through.
 * @param category - the media category to collect routes for.
 * @param preferred - the selection to try first.
 * @returns The candidate routes, preferred first and duplicates removed.
 */
export async function mediaCandidates(host: MediaGenerationHost, category: MediaCategory, preferred: string): Promise<MediaRoute[]> {
  const selections = [preferred]
  const overrides = host.capabilities.configuration().modelCategories
  // The user's own category override outranks every automatic answer, and it is
  // keyed the way the settings page keys it. Only the native directory used to
  // consult it, so a model the user moved out of a category was still asked, and
  // one they moved into it was never offered as a fallback.
  const categoryOverride = (provider: string, id: string): string | undefined => overrides[mediaCategoryOverrideKey(provider, id)]
  const llm = host.ctx.get('llm') as { listProviders(): readonly { readonly id: string }[]; listModels(provider: string): Promise<readonly LlmModelInfo[]> } | undefined
  for (const provider of llm?.listProviders() ?? []) {
    try {
      for (const model of await llm!.listModels(provider.id)) {
        const configured = categoryOverride(provider.id, model.id)
        const inferred = inferMediaCategory(`${provider.id} ${model.id} ${model.name}`)
        if ((configured ?? inferred) === category) selections.push(mediaSelection(provider.id, model.id))
      }
    } catch { /* one unavailable provider must not remove other media routes */ }
  }
  const managed = await host.readManagedCatalogCache()
  for (const model of managed?.models ?? []) {
    const modelCategory = categoryOverride(model.provider, model.id) ?? mediaCategoryForManagedModel(model)
    if (model.availability === 'available' && modelCategory === category) selections.push(model.id)
  }
  const logfareKey = await host.logfareApiKey()
  if (logfareKey !== undefined) for (const model of await host.logfareModels()) {
    // The row the picker lists for a free model is `logfare/<id>`, and that is the
    // id its override is keyed by — the directory reports the bare one.
    const selection = logfareSelectionId(model.id)
    const modelCategory = categoryOverride('logfare', selection) ?? logfareMediaCategory(model)
    if (modelCategory === category && (!model.requiresTrainingOptIn || model.premiumUnlocked)) selections.push(selection)
  }
  // Agnes media routes follow the provider's live `/models` directory: every
  // image/video-capable id listed there becomes a fallback candidate without
  // a plugin update. A signed-out or unreachable directory simply yields no
  // candidates (the documented ids are already part of the live floor).
  try {
    for (const model of await host.requireAgnes().agnesMediaModels(category)) {
      const selection = mediaSelection('agnes', model)
      // The directory reports this category — and the override may take the model
      // back out of it. The other direction cannot be seen here: the accessor is
      // asked per category, so a model the user moved *into* this one is not in its
      // answer (see §46.7; as the configured default it still works).
      const override = categoryOverride('agnes', selection)
      if (override !== undefined && override !== category) continue
      selections.push(selection)
    }
  } catch { /* Agnes stays optional in the fallback chain */ }
  const seen = new Set<string>()
  const routes = selections.map(selection => host.mediaRoute(selection)).filter((route) => {
    const key = `${route.provider}\u0000${route.model}`.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const preferredRoute = routes[0]
  if (preferredRoute === undefined) return []
  return routes.map((route, index) => ({ route, index })).sort((left, right) => {
    if (left.index === 0) return -1
    if (right.index === 0) return 1
    const leftSameModel = left.route.model.toLowerCase() === preferredRoute.model.toLowerCase() ? 0 : 1
    const rightSameModel = right.route.model.toLowerCase() === preferredRoute.model.toLowerCase() ? 0 : 1
    return leftSameModel - rightSameModel || left.index - right.index
  }).map(item => item.route)
}

/**
 * The model this category is configured to use.
 * @param host - the Host surface this remote call reaches its services through.
 * @param category - the media category whose default is asked for.
 * @returns The configured selection, trimmed.
 */
export function mediaDefault(host: MediaGenerationHost, category: 'image' | 'video' | 'audio'): string {
  const model = host.policy.get()?.mediaDefaults?.[category]?.trim() ?? ''
  if (model === '') throw new Error(`No default ${category} model is selected in FreeCodeGo settings`)
  return model
}

/**
 * Work out which provider and transport one selection names.
 *
 * A model-directory route key is normalized to the model id the FreeCodeGo API
 * resolves by, and the original value is kept for diagnostics, so a selection that
 * arrived through one integration keeps working through it. When no configured
 * provider claims the prefix, the plugin's own prefixes decide, which is what
 * makes a bare `agnes-*` id keep its legacy mapping.
 * @param host - the Host surface this remote call reaches its services through.
 * @param selection - the selected model, in any of the shapes callers use.
 * @returns The provider, the model, and the selection it was read from.
 */
export function mediaRoute(host: MediaGenerationHost, selection: string): MediaRoute {
  const normalized = selection.trim()
  // Some Harness model-directory integrations expose the provider route key
  // (`model:<protocol>:<model>`) as the selected value. The FreeCodeGo API
  // resolves model options by the actual model id, so normalize that key
  // before looking up the gateway route while retaining the original value
  // for diagnostics and durable compatibility.
  const gatewayModel = gatewayModelId(normalized)
  if (gatewayModel !== normalized) return { selection: normalized, provider: 'freecodego', model: gatewayModel }
  const configured = host.configuredProviderRoute(normalized)
  if (configured !== undefined) return { selection: normalized, provider: configured.provider, model: configured.model }
  const provider = (host.ctx.get('llm') as { listProviders(): readonly { readonly id: string }[] } | undefined)?.listProviders()
    .map(item => item.id)
    .sort((left, right) => right.length - left.length)
    .find(id => normalized.toLowerCase().startsWith(`${id.toLowerCase()}/`))
  if (provider === undefined) {
    // `agnes/<model-id>` is the canonical selection shape emitted by the
    // managed catalog; bare `agnes-*` ids keep their legacy provider mapping.
    if (normalized.toLowerCase().startsWith('agnes/')) return { selection: normalized, provider: 'agnes', model: normalized.slice('agnes/'.length) }
    return { selection: normalized, provider: normalized.startsWith(LOGFARE_MODEL_PREFIX) ? 'logfare' : normalized.startsWith('agnes-') ? 'agnes' : 'freecodego', model: normalized.startsWith(LOGFARE_MODEL_PREFIX) ? normalized.slice(LOGFARE_MODEL_PREFIX.length) : normalized }
  }
  return { selection: normalized, provider, model: normalized.slice(provider.length + 1) }
}

/**
 * The connection a media route actually reaches: base URL and credential.
 *
 * Read from the Harness Models settings rather than from anything this plugin
 * owns, and falling back to the provider's known endpoint only where one exists —
 * so a provider that needs a Base URL says so instead of posting somewhere
 * arbitrary.
 * @param host - the Host surface this remote call reaches its services through.
 * @param route - the route whose connection is being resolved.
 * @returns The resolved base URL, credential reference and protocol.
 */
export async function configuredMediaConnection(host: MediaGenerationHost, route: MediaRoute): Promise<ConfiguredMediaConnection> {
  const profiles = record(record(peerSettings(host.ctx, MODELS_SETTINGS_ENTRY)).providers)
  const profile = record(profiles[route.provider])
  const baseURL = text(profile.baseURL) ?? defaultMediaBaseURL(route.provider)
  if (baseURL === undefined) throw new Error(`Media provider "${route.provider}" needs a Base URL in the Harness Models settings`)
  const reference = text(profile.apiKeyEnv) ?? defaultMediaCredentialRef(route.provider)
  // Kling's own API authenticates with a token minted from an access/secret
  // pair rather than with a static key, so a profile that carries the pair is
  // complete without one. A pair that is absent leaves the single key in charge,
  // which is what an OpenAI-shaped reseller in front of Kling expects.
  const jwt = isKlingProvider(route.provider) ? await klingJwt(host) : undefined
  const credential = reference === undefined ? undefined : await host.credentials?.resolve(credentialRef(reference))
  const apiKey = credential?.value.trim() || (reference === undefined ? undefined : process.env[reference]?.trim())
  if (jwt === undefined && reference !== undefined && (apiKey === undefined || apiKey === '')) throw new Error(`Media provider "${route.provider}" is missing its configured API key`)
  const headers = Object.fromEntries(Object.entries(record(profile.headers)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  return { baseURL, ...(apiKey === undefined ? {} : { apiKey }), ...(jwt === undefined ? {} : { jwt }), headers, ...(text(profile.api) === undefined ? {} : { api: text(profile.api)! }) }
}

/**
 * Read Kling's access/secret pair out of the credential store (or the process
 * environment) and mint the token, or undefined when the profile only carries
 * the single reseller key.
 */
async function klingJwt(host: MediaGenerationHost): Promise<string | undefined> {
  const read = async (reference: string): Promise<string | undefined> => {
    const stored = (await host.credentials?.resolve(credentialRef(reference)))?.value.trim()
    return stored === undefined || stored === '' ? process.env[reference]?.trim() : stored
  }
  const accessKey = await read(KLING_ACCESS_KEY_REF)
  const secretKey = await read(KLING_SECRET_KEY_REF)
  if (accessKey === undefined || accessKey === '' || secretKey === undefined || secretKey === '') return undefined
  return signKlingJwt(accessKey, secretKey)
}

/**
 * How long a provider video task is polled before the route is given up on.
 *
 * One constant for both the deadline and the wording that reports it, so the
 * message cannot promise a window the loop does not actually wait for.
 */
const VIDEO_POLL_WINDOW_MS = 10 * 60_000
/** Consecutive failed status polls tolerated before polling gives up. */
const VIDEO_POLL_FAILURE_LIMIT = 3

/**
 * Poll a provider video task to completion, reusing one transport resolution
 * for the whole window so a per-tick credential hiccup cannot cancel a task
 * that still has minutes to run. Only a credential the gateway actually rejects
 * (401) forces a re-resolution, and it goes through the same account recovery
 * path as every other gateway request; ordinary network failures retry until
 * three ticks miss.
 * @param host - the Host surface this remote call reaches its services through.
 * @param route - the route whose task is being polled.
 * @param initial - the response that started the task.
 * @param signal - aborts the request when the caller cancels.
 * @param statusPath - the endpoint to poll, when the provider's start response does not name one.
 * @returns The task's finished payload, once the provider reports one.
 */
export async function pollGeneratedVideo(host: MediaGenerationHost, route: MediaRoute, initial: unknown, signal: AbortSignal, statusPath?: string): Promise<unknown> {
  let current = initial
  const deadline = Date.now() + VIDEO_POLL_WINDOW_MS
  let transport = await mediaTransport(host, route.selection)
  let stale = false
  let failures = 0
  while (true) {
    const result = generatedVideoResult(visibleMediaSelection(route.selection), current)
    if (result.status === 'failed') {
      // A failed task must not masquerade as a finished result, and the provider
      // error must reach the user either way. Whether the ladder may route
      // around it is the provider's own text to say: a task the provider refused
      // for a reason of the request's own making is terminal, while a task it
      // accepted and then failed is this route failing to deliver. Raised as the
      // ladder's own signal in that case, with the `LlmError` kept underneath so
      // the classification the rest of the transport layer reads survives.
      const detail = redactMediaDetail(result.error ?? '')
      const message = `FreeCodeGo video task ${result.videoId ?? 'unknown'} failed${detail === '' ? '' : `: ${detail}`}`
      const failure = new LlmError(message, 'SERVER', { cause: result })
      throw mediaFailureBelongsToRequest(detail) ? failure : new MediaRouteLimitation(message, { cause: failure })
    }
    if (result.url !== undefined || result.status === 'completed' || result.status === 'cancelled' || result.videoId === undefined) return result
    if (Date.now() >= deadline) {
      // A still-running task must not masquerade as a success result, and a route
      // that ran out of time is not the request's fault: raised as the ladder's
      // own signal so another configured route is tried instead of ending the
      // call. This used to be a plain Error, whose wording matched none of the
      // ladder's retryable words — so the route was terminal by omission, which
      // is the failure mode `MediaRouteLimitation` exists to end.
      throw new MediaRouteLimitation(`FreeCodeGo video task ${result.videoId} did not complete within the ${String(VIDEO_POLL_WINDOW_MS / 60_000)} minute polling window`)
    }
    await sleepForMedia(2_000, signal)
    const endpoint = videoStatusEndpoint(route, current, result.videoId, statusPath)
    if (endpoint === undefined) {
      // Returning the raw task payload here would surface a URL-less stub as
      // a finished result; fail loudly so the caller can pick another route.
      throw new Error(`FreeCodeGo media provider "${route.provider}" exposes no video status route for task ${result.videoId}`)
    }
    try {
      const response = await gatewayResponse(host, transport.accountBacked, () => { stale = true }, async () => {
        // A replay after a rejected token must not reuse the credential this
        // window resolved first, so the reload happens inside the retried call.
        if (stale) { transport = await mediaTransport(host, route.selection); stale = false }
        return fetch(transport.url(endpoint), { headers: { ...transport.headers, accept: 'application/json' }, signal })
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`FreeCodeGo ${endpoint} failed with HTTP ${response.status}`)
      }
      current = await response.json()
      failures = 0
    } catch (error) {
      // Non-retryable failures (aborted, prompt problems, auth) abort
      // immediately; retryable ones survive up to three consecutive misses so
      // one bad tick does not cancel a task with minutes of work behind it.
      if (signal.aborted) throw error
      if (!mediaFallbackAllowed(error, signal)) throw error
      failures += 1
      if (failures >= VIDEO_POLL_FAILURE_LIMIT) throw error
    }
  }
}

/**
 * Whether a Google-family route speaks Gemini's native contract.
 *
 * Both the provider and the model have to name the family, because an OpenAI-
 * compatible proxy in front of Google models must keep the portable request shape:
 * the base URL is what decides which of the two it is.
 * @param host - the Host surface this remote call reaches its services through.
 * @param route - the route to classify.
 * @returns True when this route takes the native multimodal request.
 */
export async function isNativeGeminiRoute(host: MediaGenerationHost, route: MediaRoute): Promise<boolean> {
  if (!/(?:google|gemini)/i.test(route.provider) || !/(?:gemini|imagen)/i.test(route.model)) return false
  const connection = await configuredMediaConnection(host, route)
  return connection.api !== 'openai-completions' && !/\/openai\/?$/i.test(connection.baseURL)
}

/**
 * Whether a DashScope-family route speaks the vendor's native image contract.
 * DashScope also serves an OpenAI-compatible image endpoint under
 * /compatible-mode/v1, so a profile pointed there must keep the portable shape:
 * only a profile without that marker gets the native multimodal request.
 * @param host - the Host surface this remote call reaches its services through.
 * @param route - the route to classify.
 * @returns True when this route takes the vendor's native image request.
 */
export async function isNativeDashscopeRoute(host: MediaGenerationHost, route: MediaRoute): Promise<boolean> {
  if (!/(?:dashscope|aliyun|qwen|wanx)/i.test(route.provider)) return false
  const connection = await configuredMediaConnection(host, route)
  return connection.api !== 'openai-completions' && !/compatible-mode/i.test(connection.baseURL)
}

/** Shared transport resolution for media requests (direct, configured, or
 * managed gateway), including the gateway route-key headers.
 * @param host - the Host surface this remote call reaches its services through.
 * @param model - model id the turn runs.
 * @returns The URL builder, headers and flags one media request needs.
 */
export async function mediaTransport(host: MediaGenerationHost, model: string): Promise<{
  readonly url: (endpoint: string) => string
  readonly headers: Record<string, string>
  readonly googleNative: boolean
  readonly model: string
  /** True when the request authenticates with the account gateway token, so
   * the account recovery path may replay it after a 401. */
  readonly accountBacked: boolean
}> {
  const route = host.mediaRoute(model)
  const direct = route.provider === 'logfare' || route.provider === 'openrouter' || route.provider === 'opencode'
    ? await host.directConnection(route.selection)
    : undefined
  const configured = direct === undefined && route.provider !== 'freecodego' && route.provider !== 'agnes'
    ? await configuredMediaConnection(host, route)
    : undefined
  const runtime = direct?.runtime ?? (configured === undefined ? await host.managedRuntime(route.model) : undefined)
  const baseURL = configured?.baseURL ?? direct?.connection.baseURL ?? runtime?.openAIBaseUrl
  const token = configured?.apiKey ?? runtime?.openAIToken
  if (baseURL === undefined || (token === undefined && configured === undefined)) throw backendNotConfigured()
  const routeKey = runtime !== undefined && 'routeKey' in runtime && typeof runtime.routeKey === 'string' ? runtime.routeKey : undefined
  const googleNative = /generativelanguage\.googleapis\.com/i.test(baseURL) && configured?.api !== 'openai-completions'
  const prefix = baseURL.replace(/\/+$/u, '')
  // A configured provider authenticates with its own scheme: Vidu's OpenAPI
  // takes `Authorization: Token <key>` and answers 401 to `Bearer`, so the
  // scheme is a property of the provider, not of the request. A minted token
  // replaces the static key entirely.
  const authScheme = defaultMediaAuthScheme(route.provider)
  const bearer = configured?.jwt ?? token
  return {
    // Only the managed gateway authenticates with the vault access token; a
    // direct or configured provider must never be replayed through it.
    accountBacked: direct === undefined && configured === undefined,
    url: (endpoint: string): string => `${prefix}${endpoint}`,
    headers: {
      ...(bearer === undefined ? {} : googleNative ? { 'x-goog-api-key': bearer } : authScheme === 'token' ? { authorization: `Token ${bearer}` } : { authorization: `Bearer ${bearer}` }),
      accept: 'application/json',
      ...(direct?.connection.headers ?? {}),
      ...(configured?.headers ?? {}),
      ...(routeKey === undefined ? {} : { 'X-FreeCodeGo-Route-Key': routeKey, 'X-LiteAgent-Route-Key': routeKey }),
    },
    googleNative,
    model: direct?.connection.model ?? route.model,
  }
}

/**
 * Run one gateway request under the account's recovery semantics.
 *
 * A 401 means the gateway rejected the token *before* serving the request, so
 * the account coordinator may refresh once and replay it without duplicating
 * work. Every other status — including a 5xx that a generation POST could have
 * partially performed — is returned untouched to the caller.
 */
async function gatewayResponse(
  host: MediaGenerationHost,
  accountBacked: boolean,
  reloadTransport: () => void,
  run: () => Promise<Response>,
): Promise<Response> {
  const recover = host.recoverGatewayAuth
  if (!accountBacked || recover === undefined) return run()
  return recover(async () => {
    const response = await run()
    if (response.status !== 401) return response
    await response.body?.cancel().catch(() => undefined)
    reloadTransport()
    throw Object.assign(new Error('FreeCodeGo gateway rejected the access token'), { status: 401 })
  })
}

/**
 * Transport options for one media request. Only the create call of a protocol
 * that opts in asynchronously needs them — DashScope's video synthesis route
 * requires `X-DashScope-Async: enable`, and its status route must not carry it.
 */
export interface MediaRequestOptions {
  readonly headers?: Readonly<Record<string, string>>
  /** The body names the model under a field of its own, so the transport must
   * not add its `model` beside it (Kling's `model_name`). */
  readonly omitModel?: boolean
}

/**
 * The transport options one create call needs, or undefined when it needs none.
 * Every protocol that needs neither keeps the four-argument call, so no existing
 * transport suddenly receives an argument it has to ignore.
 */
function mediaRequestOptions(target: MediaVideoRequest): MediaRequestOptions | undefined {
  const headers = target.headers
  const omitModel = target.modelField === false
  if (headers === undefined && !omitModel) return undefined
  return { ...(headers === undefined ? {} : { headers }), ...(omitModel ? { omitModel: true } : {}) }
}

/**
 * Post one media request through the gateway, with endpoint fallback.
 *
 * `endpoint` may be a chain, and a 404, 405 or 501 moves to the next candidate —
 * a provider that serves generation on a different path says so with one of those,
 * not with a body. Retried material re-resolves its account when the gateway
 * reports the credential went stale, and the response body is masked before it is
 * put into an error, because a media body can quote the URL it was called with.
 * @param host - the Host surface this remote call reaches its services through.
 * @param model - model id the turn runs.
 * @param endpoint - the endpoint to post to, or a chain of candidates to try.
 * @param body - the request body to send.
 * @param signal - aborts the request when the caller cancels.
 * @param options - per-request header and body overrides.
 * @returns The first response that was not a routing miss.
 */
export async function gatewayMediaFetch(host: MediaGenerationHost, model: string, endpoint: string | readonly string[], body: Record<string, unknown>, signal: AbortSignal, options?: MediaRequestOptions): Promise<Response> {
  let transport = await mediaTransport(host, model)
  let stale = false
  const endpoints = typeof endpoint === 'string' ? [endpoint] : endpoint
  for (const [index, candidate] of endpoints.entries()) {
    const response = await gatewayResponse(host, transport.accountBacked, () => { stale = true }, async () => {
      if (stale) { transport = await mediaTransport(host, model); stale = false }
      return fetch(transport.url(candidate), {
        method: 'POST',
        headers: {
          ...transport.headers,
          'content-type': 'application/json',
          accept: 'application/json, audio/*',
          ...(options?.headers ?? {}),
        },
        body: JSON.stringify({ ...body, ...transport.googleNative || options?.omitModel === true ? {} : { model: transport.model } }),
        signal,
      })
    })
    if (response.ok) return response
    const detail = redactMediaDetail(await response.text())
    if (index < endpoints.length - 1 && (response.status === 404 || response.status === 405 || response.status === 501)) continue
    throw new Error(`FreeCodeGo ${candidate} failed with HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`)
  }
  throw new Error('No compatible media endpoint was available')
}



/**
 * The same request, with the JSON body parsed.
 *
 * A non-JSON content type is an error rather than a parse attempt: a media provider
 * that answers with HTML is a misconfigured Base URL, and reporting it as a JSON
 * failure would hide that.
 * @param host - the Host surface this remote call reaches its services through.
 * @param model - model id the turn runs.
 * @param endpoint - the endpoint to post to, or a chain of candidates to try.
 * @param body - the request body to send.
 * @param signal - aborts the request when the caller cancels.
 * @param options - per-request header and body overrides.
 * @returns The parsed response body, of unknown shape.
 */
export async function gatewayMediaJson(host: MediaGenerationHost, model: string, endpoint: string | readonly string[], body: Record<string, unknown>, signal: AbortSignal, options?: MediaRequestOptions): Promise<unknown> {
  const response = await gatewayMediaFetch(host, model, endpoint, body, signal, options)
  const contentType = response.headers.get('content-type') ?? ''
  // `endpoint` may be a fallback chain; name every candidate it tried rather
  // than stringifying the array into a comma-joined list.
  const attempted = typeof endpoint === 'string' ? endpoint : endpoint.join(', ')
  if (!contentType.toLowerCase().includes('json')) throw new Error(`FreeCodeGo ${attempted} returned a non-JSON response`)
  return response.json()
}
