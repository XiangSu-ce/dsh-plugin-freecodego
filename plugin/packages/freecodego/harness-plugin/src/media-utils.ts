import { createHmac } from 'node:crypto'
import { redactCredentialShapes } from './secret-scan.ts'

export type MediaCategory = 'image' | 'video' | 'audio'

/**
 * A refusal that belongs to one route rather than to the request.
 *
 * A transport raises this when it cannot render what was asked for — a duration
 * outside the range that provider supports, say — as distinct from the caller
 * having asked for something no route could serve. The ladder reads the type
 * rather than the wording, because a route that cannot render the request must
 * not end the call while another configured route still could. Wording used to be
 * the only signal, and a provider's own range message matched none of the
 * terminal patterns — but fell through to the same `false` default anyway, so
 * being unmatched made it terminal by omission.
 */
export class MediaRouteLimitation extends Error {}

/**
 * A refusal the route itself declared, before spending anything.
 *
 * Both this and a plain {@link MediaRouteLimitation} mean the same thing to the
 * ladder — it steps around either one and both are named in the aggregate message
 * when no route could serve the request. What separates them is what they say
 * about the *provider*. A declaration costs nothing: not one byte leaves the
 * process, so it is no evidence about that route's health, and the breaker exists
 * to put a provider that just failed twice behind healthy routes for five
 * minutes. Counted as a failure, two requests for a length a route cannot render
 * demote the *configured default* route — measured, a 5-second request after two
 * 30-second ones went to the second route and never asked Kling at all, which
 * renders 5 seconds exactly.
 */
export class MediaRouteCapabilityRefusal extends MediaRouteLimitation {}
export interface MediaRoute { readonly selection: string; readonly provider: string; readonly model: string }

export function mediaSelection(provider: string, model: string): string {
  const normalized = provider.trim().toLowerCase()
  return normalized === 'freecodego' || model.toLowerCase().startsWith(`${normalized}/`) ? model : `${provider}/${model}`
}
/**
 * The key one model's media-category override is stored under.
 *
 * The settings page writes and reads these as `provider\u0000id` (its
 * `modelCategoryKey`), with the provider string and the id exactly as the catalog
 * row carries them: bare for a native directory model, and the prefixed selection
 * (`logfare/…`, `agnes/…`) for a gateway row. Two spellings of one key is how an
 * override the picker enforces ends up invisible to the runtime, so the rule lives
 * in one place and every reader of the setting calls it.
 */
export function mediaCategoryOverrideKey(provider: string, id: string): string { return `${provider}\u0000${id}` }
export function gatewayModelId(selection: string): string {
  const value = selection.trim()
  const match = /^model:[^:]+:(.+)$/iu.exec(value)
  return match?.[1]?.trim() || value
}
export function visibleMediaSelection(selection: string): string { return gatewayModelId(selection.replace(/^logfare\//i, 'freecodego/').replace(/^agnes\//i, '')) }
export function inferMediaCategory(value: string): MediaCategory | undefined {
  const normalized = value.toLowerCase()
  if (/(?:veo(?:\d|[-_.])|seedance|kling|可灵|sora|wan[-_.]?\d.*video|grok.*video|video[-_. ]?(?:gen|create|generation))/.test(normalized)) return 'video'
  if (/(?:gpt[-_.]?image|dall[-_.]?e|imagen|gemini.*image|imagegen|flux|sdxl|stable[-_. ]?diffusion|midjourney|ideogram|recraft|qwen[-_.]?image|grok.*image|image[-_. ](?:gen|edit|generation))/.test(normalized)) return 'image'
  if (/(?:tts|text[-_. ]?to[-_. ]?speech|speech[-_. ]?(?:gen|synth)|audio[-_. ]?(?:gen|speech))/.test(normalized)) return 'audio'
  // Standalone category tokens: provider ids may embed the media kind as a
  // plain word (`agnes-image-2.5-flash`, `agnes-video-2.5-flash`) without any
  // brand-specific marker, and live directories add such ids routinely.
  if (/(?:^|[-_.\s])videos?(?:[-_.\s]|\d|$)/u.test(normalized)) return 'video'
  if (/(?:^|[-_.\s])(?:images?|img)(?:[-_.\s]|\d|$)/u.test(normalized)) return 'image'
  if (/(?:^|[-_.\s])(?:transcri|whisper|asr)(?:[-_.\s]|\d|$)/u.test(normalized)) return 'audio'
  return undefined
}
/**
 * Failure wording that describes the *request* rather than the *route*: a wrong
 * credential fails identically everywhere, and a 400/422-class rejection is the
 * provider saying the request itself cannot be served.
 *
 * Two readers share this one list because they must never disagree: the ladder,
 * where a match is terminal, and `mediaFailureBelongsToRequest`, where a match is
 * what stops a provider-refused task from being re-asked of every other route at
 * the price of another paid video task each time. A second copy of it is how
 * those two answers would drift apart.
 */
export const MEDIA_REQUEST_REFUSAL_PATTERN = /\b(?:HTTP )?401\b|unauthorized|authentication required|invalid api key|\b(?:HTTP )?(?:400|422)\b|PROMPT_REQUIRED|prompt (?:is )?required|empty prompt|invalid (?:parameter|request|prompt|size|aspect|duration)|content policy/i
/**
 * The statuses that belong to a *route* rather than to a request, in the exact
 * `HTTP <code>` shape a status is reported in.
 *
 * The refusal list above spells its numbers loosely on purpose — the task-side
 * reader is handed a provider's own error body, where a bare `"code": 400` is the
 * only thing there is to read — so any `400` anywhere in a message matches it.
 * Measured: a task id inside an endpoint path
 * (`/v1/tasks/model-400/status failed with HTTP 503`) ended the ladder on a bare
 * `400`, and the provider's `503` was never read.
 *
 * This list therefore answers a different question than the refusal list, and is
 * read first by the ladder only: a status the provider *reported as a status*
 * outranks a number that merely appears in its text. It is not a second copy of
 * the refusal list, so the two cannot drift about which reasons belong to the
 * request. `401` and `400`/`422` are deliberately absent — those are refusals, and
 * putting a retryable status alongside them is what would turn a rejected prompt
 * into another paid attempt.
 */
export const MEDIA_ROUTE_STATUS_PATTERN = /\bHTTP (?:402|404|429|5\d\d)\b/i
export function mediaFallbackAllowed(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false
  // The one signal whose meaning is declared rather than guessed, so it is read
  // before any wording: the route itself said it cannot serve this request, which
  // is the case the ladder exists for.
  if (error instanceof MediaRouteLimitation) return true
  const message = error instanceof Error ? error.message : String(error)
  if (/attachment storage/i.test(message)) return false
  // Server-side rejections that another model may not share: exhausted
  // balance/quota, disabled or missing endpoints, rate limits, and outages.
  // Read before the refusal list, and in this exact shape, so that a status the
  // provider reported as a status is not overruled by a number that merely
  // appears in the same text (`.../model-400/status failed with HTTP 503`).
  if (MEDIA_ROUTE_STATUS_PATTERN.test(message)) return true
  // A wrong credential fails identically on every route, and so does a request
  // the provider refused outright: switching models cannot recover either, so
  // this whole class stays terminal while every other status class (payment,
  // missing route, rate limit, provider outage) may try the next one.
  if (MEDIA_REQUEST_REFUSAL_PATTERN.test(message)) return false
  return /no image data|returned no image|no video|not available|unavailable|insufficient|balance|quota|missing|required|sign in|reauth|not configured|no enabled route|no model options|timeout|transport|network|fetch failed|needs a base url/i.test(message)
}
/**
 * Does a provider's own failure text describe a decision about the *request*
 * rather than a failure of *this route*?
 *
 * The distinction decides whether a task a provider accepted and then failed may
 * be re-asked of the next configured route. Failing to deliver is this route's
 * business and the ladder's reason for existing; refusing what was asked for is
 * the one case where every other route returns the same answer, at the price of
 * another paid video task each time.
 *
 * It reads the shared request-side list, not the ladder's verdict: the ladder's
 * default is terminal, so asking it this question would make every reason it does
 * not recognise — including a plain "the task failed" from a provider that
 * declined to say why — belong to the request and end the call. Here the default
 * runs the other way. Only a reason that names a decision about the request
 * stops the ladder, and a provider that gave no reason at all gave the route's
 * problem, not the request's.
 */
export function mediaFailureBelongsToRequest(detail: string): boolean {
  return MEDIA_REQUEST_REFUSAL_PATTERN.test(detail)
}
export function unknownImageParameter(error: unknown): boolean { return /unknown parameter|unrecognized (?:parameter|field)|additional propert(?:y|ies)|unsupported parameter/i.test(error instanceof Error ? error.message : String(error)) }
export function imageEndpointUnavailable(error: unknown): boolean { return /failed with HTTP (?:404|405|501)\b/i.test(error instanceof Error ? error.message : String(error)) }
export function imageEndpointMayBeResponses(error: unknown): boolean { return unknownImageParameter(error) || imageEndpointUnavailable(error) }
/**
 * Scrub a media provider's own error text before it becomes a message.
 *
 * The credential shapes are the shared scanner's job. This function used to
 * carry two private regexes of its own — a bearer token and an `sk-`/`key-`/
 * `token-`-prefixed key — and neither was visible to the three other surfaces
 * that redact upstream text, so a shape added here protected one exit and left
 * the rest. Only the formatting stays local: a provider error body is
 * unbounded and multi-line, and this text is read by a person.
 */
export function redactMediaDetail(value: string): string { return redactCredentialShapes(value).replace(/[\r\n]+/gu, ' ').slice(0, 1_000) }
export function defaultMediaBaseURL(provider: string): string | undefined {
  const normalized = provider.trim().toLowerCase()
  if (normalized === 'openai') return 'https://api.openai.com/v1'
  if (normalized === 'dashscope' || normalized === 'qwen' || normalized === 'aliyun') return 'https://dashscope.aliyuncs.com'
  if (normalized === 'minimax' || normalized === 'hailuo') return 'https://api.minimaxi.com'
  if (normalized === 'vidu') return 'https://api.vidu.cn'
  if (normalized === 'xai' || normalized === 'grok') return 'https://api.x.ai/v1'
  if (normalized === 'google' || normalized === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta'
  if (normalized === 'kling' || normalized === 'kuaishou') return 'https://api-beijing.klingai.com/v1'
  if (normalized === 'volcengine' || normalized === 'ark' || normalized === 'seedance' || normalized === 'bytedance') return 'https://ark.cn-beijing.volces.com/api/v3'
  return undefined
}
export function defaultMediaCredentialRef(provider: string): string | undefined {
  const normalized = provider.trim().toLowerCase()
  if (normalized === 'openai') return 'OPENAI_API_KEY'
  if (normalized === 'dashscope' || normalized === 'qwen' || normalized === 'aliyun') return 'DASHSCOPE_API_KEY'
  if (normalized === 'minimax' || normalized === 'hailuo') return 'MINIMAX_API_KEY'
  if (normalized === 'vidu') return 'VIDU_API_KEY'
  if (normalized === 'xai' || normalized === 'grok') return 'XAI_API_KEY'
  if (normalized === 'google' || normalized === 'gemini') return 'GOOGLE_API_KEY'
  if (normalized === 'kling' || normalized === 'kuaishou') return 'KLING_API_KEY'
  if (normalized === 'volcengine' || normalized === 'ark' || normalized === 'seedance' || normalized === 'bytedance') return 'ARK_API_KEY'
  return undefined
}
/**
 * Authorization scheme a provider expects for its media routes. Almost every
 * API takes `Bearer`, but Vidu's OpenAPI is explicit that it takes
 * `Authorization: Token <key>` — sending `Bearer` there authenticates nothing
 * and the create call comes back as an opaque failure.
 */
export type MediaAuthScheme = 'bearer' | 'token'
export function defaultMediaAuthScheme(provider: string): MediaAuthScheme {
  const normalized = provider.trim().toLowerCase()
  if (normalized === 'vidu') return 'token'
  return 'bearer'
}
export function sizeToAspectRatio(size: string): string | undefined {
  const match = /^(\d{2,5})\s*[xX×]\s*(\d{2,5})$/u.exec(size.trim())
  const width = match?.[1] === undefined ? undefined : Number(match[1]); const height = match?.[2] === undefined ? undefined : Number(match[2])
  if (width === undefined || height === undefined || !Number.isInteger(width) || !Number.isInteger(height) || width === 0 || height === 0) return undefined
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b)
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}
export function sleepForMedia(milliseconds: number, signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { if (signal.aborted) { reject(new Error('Media request aborted by caller')); return }; const onAbort = (): void => { clearTimeout(timer); reject(new Error('Media request aborted by caller')) }; const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, milliseconds); signal.addEventListener('abort', onAbort, { once: true }) }) }

export function videoStatusEndpoint(route: MediaRoute, value: unknown, id: string, statusPath?: string): string | undefined {
  const protocol = mediaVideoProtocol(route.provider)
  const root = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  if (protocol === 'gemini' && typeof root.name === 'string') {
    const operation = root.name.replace(/^\/+/, '')
    if (/^[A-Za-z0-9._/-]+$/.test(operation) && !operation.split('/').includes('..')) return `/${operation}`
    return undefined
  }
  // Kling answers every mode from the create path it was given, so the caller
  // that chose the mode supplies that path; the text route is the default for a
  // call that did not go through the request builder.
  if (protocol === 'kling') return `${statusPath ?? '/videos/text2video'}/${encodeURIComponent(id)}`
  if (protocol === 'ark') return `/contents/generations/tasks/${encodeURIComponent(id)}`
  // DashScope answers the video-synthesis create call with output.task_id and
  // serves every task, video or not, from the flat /api/v1/tasks route.
  if (protocol === 'dashscope') return `/api/v1/tasks/${encodeURIComponent(id)}`
  // MiniMax Hailuo returns a task_id whose state is read from task.status on
  // the dedicated query route.
  if (protocol === 'minimax') return `/v2/query/video_generation/${encodeURIComponent(id)}`
  // Vidu polls every async task through /ent/v2/tasks/{task_id}/creations.
  if (protocol === 'vidu') return `/ent/v2/tasks/${encodeURIComponent(id)}/creations`
  if (protocol === 'openai' || protocol === 'xai') return `/videos/${encodeURIComponent(id)}`
  if (protocol === 'gateway') return `/videos/generations/${encodeURIComponent(id)}`
  return undefined
}

/**
 * Video wire protocols the request layer speaks. The vocabulary is taken from
 * two reference implementations rather than invented: huobao-canvas' protocol
 * adapter registry (`ark` content tasks, `dashscope` video-synthesis + task
 * polling, `async-video` for MiniMax and Vidu, `gemini` long-running
 * operations) and grok2api's OpenAI-compatible media layer, whose
 * `POST /videos/generations` answers `{request_id}` and is polled through
 * `GET /videos/{request_id}`.
 *
 * The protocol is chosen from the *provider*, never from the model id: a model
 * name describes what it does, not who serves it. The gateway
 * (`freecodego`/`logfare`/`agnes`) always speaks the portable OpenAI shape
 * because it adapts upstream itself, and an unrecognized provider keeps that
 * same shape — the create endpoint chain and the status route are the ones a
 * generic OpenAI-compatible server exposes.
 */
export type MediaVideoProtocol = 'kling' | 'ark' | 'dashscope' | 'minimax' | 'vidu' | 'gemini' | 'xai' | 'openai' | 'gateway'
export function mediaVideoProtocol(provider: string): MediaVideoProtocol {
  const normalized = provider.trim().toLowerCase()
  if (/(?:kling|kuaishou)/u.test(normalized)) return 'kling'
  if (/(?:volcengine|ark|seedance|bytedance|doubao)/u.test(normalized)) return 'ark'
  if (/(?:dashscope|aliyun|qwen|wanx)/u.test(normalized)) return 'dashscope'
  if (/(?:minimax|hailuo)/u.test(normalized)) return 'minimax'
  if (/vidu/u.test(normalized)) return 'vidu'
  if (/(?:google|gemini)/u.test(normalized)) return 'gemini'
  if (/(?:xai|grok)/u.test(normalized)) return 'xai'
  if (/openai/u.test(normalized)) return 'openai'
  return 'gateway'
}

/**
 * The lengths every Kling video route accepts, exactly: its create calls spell
 * the duration as the string `5` or `10` and reject anything else.
 */
export const KLING_VIDEO_SECONDS: readonly number[] = [5, 10]

/** What one route accepts for `seconds`, when the plugin knows. */
export type VideoSecondsAcceptance =
  | { readonly kind: 'one of'; readonly values: readonly number[] }
  | { readonly kind: 'between'; readonly min: number; readonly max: number }

/**
 * The durations a video route accepts, when the plugin knows them.
 *
 * `undefined` means **unknown**, and an unknown route is left alone: the request
 * carries the caller's value as given. That is a deliberate floor rather than an
 * oversight — inventing a window for a provider whose contract this repository
 * does not encode would turn a request the provider *can* serve into a refusal,
 * and a refusal skips the route. So only the windows this plugin actually knows
 * are declared, each with its evidence in the code around it:
 *
 * - Kling: its create calls spell the length as `5` or `10`, which the request
 *   builder already encoded before this table existed.
 * - xAI: `duration` is an integer of 2-10 seconds — the same window whose clamp
 *   its body carried.
 * - Agnes: its client's `AGNES_VIDEO_SECONDS` list. Declared by that caller rather
 *   than imported here, because this module is a wire-protocol module and
 *   `agnes.ts` is an HTTP client.
 *
 * What a declaration buys is the difference between *refusing* and *quantizing*:
 * a request outside the window is raised as a route limitation (the ladder tries
 * another route, and the message names what this one does accept) instead of being
 * clamped into the window and returned as a length the caller never asked for.
 */
export function videoSecondsAcceptance(provider: string): VideoSecondsAcceptance | undefined {
  const protocol = mediaVideoProtocol(provider)
  if (protocol === 'kling') return { kind: 'one of', values: KLING_VIDEO_SECONDS }
  if (protocol === 'xai') return { kind: 'between', min: 2, max: 10 }
  return undefined
}

/** How a declaration reads in a refusal: `5 or 10`, `4 through 12`, `2 through 10`. */
function describeSeconds(acceptance: VideoSecondsAcceptance): string {
  if (acceptance.kind === 'between') return `${String(acceptance.min)} through ${String(acceptance.max)}`
  const values = [...acceptance.values].sort((left, right) => left - right)
  const contiguous = values.every((value, index) => index === 0 || value === (values[index - 1] ?? value) + 1)
  return values.length > 2 && contiguous ? `${String(values[0])} through ${String(values[values.length - 1])}` : values.map(String).join(' or ')
}

/**
 * Why this route cannot render `seconds`, or `undefined` when it can (or when its
 * window is unknown).
 *
 * One rule with two callers: the request builder for the protocol routes, and the
 * Agnes route, whose window lives with its own client. The wording lives here with
 * the rule so both refusals read alike and the accepted durations are always named
 * — a caller told "5 or 10 seconds" can ask again if that is what it wanted, which
 * is what makes stepping aside better than quantizing.
 *
 * @param provider - the route's provider, named in the refusal.
 * @param seconds - the requested duration; `undefined` asks for the route default.
 * @param acceptance - the route's declaration; defaults to the protocol table.
 * @returns the refusal sentence, or `undefined` to let the value travel.
 */
export function videoSecondsRefusal(provider: string, seconds: number | undefined, acceptance: VideoSecondsAcceptance | undefined = videoSecondsAcceptance(provider)): string | undefined {
  if (seconds === undefined || acceptance === undefined) return undefined
  // A fractional length is outside every declaration: these providers take whole
  // seconds, and rounding one into the window would be the quantization this rule
  // exists to end.
  const served = Number.isInteger(seconds)
    && (acceptance.kind === 'between' ? seconds >= acceptance.min && seconds <= acceptance.max : acceptance.values.includes(seconds))
  return served ? undefined : `${provider} renders ${describeSeconds(acceptance)} seconds, not ${seconds}`
}

/**
 * A create call for one video protocol: the endpoint chain to try, the body it
 * expects, and any header the protocol requires on the create call only
 * (DashScope's async opt-in).
 */
export interface MediaVideoRequest {
  readonly endpoint: string | readonly string[]
  readonly body: Record<string, unknown>
  readonly headers?: Readonly<Record<string, string>>
  /** Path the task is polled through, when it depends on the create route this
   * call chose. The status route is then this path plus the task id. */
  readonly statusPath?: string
  /** False when the body already names the model under a field of its own, so
   * the transport must not inject a second `model` beside it. */
  readonly modelField?: false
}

/** The caller-facing arguments one video create call may carry. */
export interface MediaVideoArgs {
  readonly prompt: string
  readonly seconds?: number
  readonly aspectRatio?: string
  /** First frame. */
  readonly image?: string
  /** Last frame; only the protocols that declare one accept it. */
  readonly lastImage?: string
  /** Reference (subject/style) images — a different role from the first frame. */
  readonly images?: readonly string[]
  /** Source video URL, which turns the request into an edit or an extension. */
  readonly video?: string
}

/** Most reference images any one request may carry. */
export const REFERENCE_IMAGE_LIMIT = 8

/**
 * Validate the reference images attached to a generation request.
 *
 * Only `http(s)` and `data:image/...` URLs are accepted. A bare filesystem path
 * would have to be read by the Host and uploaded, which is a separately guarded
 * operation — and a path-shaped string that reached the provider as a "URL"
 * would fail there instead of here, where the caller can still fix it.
 */
export function referenceImageUrls(images: readonly string[] | undefined, field = 'reference images'): readonly string[] {
  if (images === undefined) return []
  const accepted = images.map(image => image.trim()).filter(image => image !== '')
  if (accepted.length > REFERENCE_IMAGE_LIMIT) throw new Error(`Invalid request: at most ${REFERENCE_IMAGE_LIMIT} ${field} are supported`)
  for (const image of accepted) {
    if (!/^(?:https?:\/\/|data:image\/)/iu.test(image)) throw new Error(`Invalid request: ${field} must be http(s) or data:image URLs`)
  }
  return accepted
}

/**
 * Kling takes a source frame as a bare base64 payload or as a URL. Its own SDK
 * always sends base64, so an inline data URL is unwrapped to exactly that; an
 * http(s) URL travels unchanged.
 */
export function klingMedia(value: string): string {
  const inline = dataUrlImage(value)
  return inline === undefined ? value : inline.data
}

/** The credential names Kling's key pair is stored under. */
export const KLING_ACCESS_KEY_REF = 'KLING_ACCESS_KEY'
export const KLING_SECRET_KEY_REF = 'KLING_SECRET_KEY'

/**
 * Whether a route belongs to Kling. An OpenAI-shaped reseller in front of Kling
 * accepts a single bearer key, so the pair is only tried when it is present.
 */
export function isKlingProvider(provider: string): boolean {
  return /(?:kling|kuaishou)/u.test(provider.trim().toLowerCase())
}

/**
 * Mint the HS256 token Kling authenticates with: the access key is the issuer
 * and the secret key signs the claim set, with the same 30 minute lifetime and
 * five second clock back-off its own SDK uses.
 */
export function signKlingJwt(accessKey: string, secretKey: string, nowSeconds = Math.floor(Date.now() / 1_000), ttlSeconds = 1_800): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const payload = encode({ iss: accessKey, exp: nowSeconds + ttlSeconds, nbf: nowSeconds - 5 })
  const signature = createHmac('sha256', secretKey).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

/**
 * Whether the family takes reference images inside the OpenAI-compatible
 * `/images/generations` body (`image: [...]`, the Seedream fusion contract)
 * rather than on the `/images/edits` endpoint. Ark's Seedream is the one family
 * whose image route is generation-shaped and still accepts sources; every other
 * OpenAI-shaped provider edits through its own endpoint.
 */
export function imagesViaGenerationBody(provider: string): boolean {
  return /(?:volcengine|ark|seedream|bytedance|doubao)/u.test(provider.trim().toLowerCase())
}

/**
 * Best-effort media type for a remote image URL, read from its extension. A
 * provider part that demands a media type only wants the hint: the bytes it
 * fetches are validated on its side, and image/png is the safe default.
 */
export function guessImageMediaType(url: string): string {
  const withoutQuery = url.split(/[?#]/u)[0] ?? ''
  if (/\.jpe?g$/iu.test(withoutQuery)) return 'image/jpeg'
  if (/\.webp$/iu.test(withoutQuery)) return 'image/webp'
  if (/\.gif$/iu.test(withoutQuery)) return 'image/gif'
  return 'image/png'
}

/**
 * Split a `data:` image URL into the base64 payload and media type an inline
 * provider part needs. Anything else has no inline form and returns undefined.
 */
export function dataUrlImage(value: string): { readonly mimeType: string; readonly data: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/iu.exec(value.trim())
  const mimeType = match?.[1]; const data = match?.[2]
  return mimeType === undefined || data === undefined ? undefined : { mimeType: mimeType.toLowerCase(), data }
}

export function mediaVideoRequest(route: MediaRoute, args: MediaVideoArgs): MediaVideoRequest {
  const protocol = mediaVideoProtocol(route.provider)
  // Reference media is validated for every protocol here, not only for the image
  // endpoint: a path-shaped string that reached a provider as a "URL" would fail
  // there instead of in front of the caller who can still fix it.
  const references = referenceImageUrls(args.images)
  // The single-frame arguments are validated for every protocol here — not only
  // for the image endpoint — and the trimmed values are what the bodies carry.
  const firstFrame = args.image === undefined ? undefined : referenceImageUrls([args.image], 'the first frame')[0]
  const lastFrame = args.lastImage === undefined ? undefined : referenceImageUrls([args.lastImage], 'the last frame')[0]
  // A first frame and a reference set are different roles in every protocol that
  // has both, and the vendor APIs reject the combination outright — so it is
  // caught before any provider quota is spent.
  if (firstFrame !== undefined && references.length > 0) throw new Error('Invalid request: pass either image (first frame) or images (reference set), not both')

  // A length this route cannot render is this route's limitation, not a bad
  // request: raised as `MediaRouteLimitation` so the ladder tries a route that
  // accepts it, instead of stopping on a 400 that only says so. Before this the
  // value was quantized into the route's window and the *shorter* video came back
  // as the answer to the longer request — while a route further down the ladder
  // that could render it was never asked. It sits before the source-video branch
  // below because an extension takes a duration exactly as a generation does.
  const unserved = videoSecondsRefusal(route.provider, args.seconds)
  if (unserved !== undefined) throw new MediaRouteCapabilityRefusal(unserved)
  // A source video means a different operation — edit or extend — which only the
  // provider families that expose such a route can take. Presenting the task at
  // the edit route rejects a duration outright (only an extension takes one), so
  // the presence of a length picks which of the two is tried first.
  if (args.video !== undefined) {
    if (!/^https?:\/\//iu.test(args.video.trim())) throw new Error('Invalid request: video must be an http(s) URL')
    if (protocol !== 'xai') throw new Error(`Video editing is unavailable on the "${route.provider}" media route`)
    return {
      endpoint: args.seconds === undefined ? ['/videos/edits', '/videos/extensions'] : ['/videos/extensions', '/videos/edits'],
      body: {
        model: route.model,
        prompt: args.prompt,
        video: { url: args.video },
        // Inside the 2-10 the route accepts, guaranteed by the refusal above.
        ...(args.seconds === undefined ? {} : { duration: args.seconds }),
      },
    }
  }
  if (protocol === 'kling') {
    const referenceSet = references.map(klingMedia)
    // Kling serves text, image, and multi-image generation from three separate
    // routes, and the frame roles live in the same body field names on each.
    // The status call then repeats the create path, so it is returned here
    // rather than reconstructed from the provider later.
    const [path, frames] = referenceSet.length > 0
      ? ['/videos/multi-image2video', { image_list: referenceSet, ...(lastFrame === undefined ? {} : { image_tail: klingMedia(lastFrame) }) }]
      : firstFrame === undefined
        ? ['/videos/text2video', {}]
        : ['/videos/image2video', { image: klingMedia(firstFrame), ...(lastFrame === undefined ? {} : { image_tail: klingMedia(lastFrame) }) }]
    return {
      endpoint: path,
      statusPath: path,
      // The body names the model `model_name`; an injected `model` beside it has
      // no place in that contract.
      modelField: false,
      body: {
        model_name: route.model,
        prompt: args.prompt,
        ...frames,
        // Every Kling video route spells its length as the string 5 or 10.
        duration: args.seconds === undefined ? '5' : String(args.seconds),
        // The image route infers its ratio from the frame, so it takes none.
        ...(args.aspectRatio === undefined || path === '/videos/image2video' ? {} : { aspect_ratio: args.aspectRatio }),
      },
    }
  }
  if (protocol === 'ark') return {
    endpoint: '/contents/generations/tasks',
    body: {
      model: route.model,
      // Ordered content parts; the role is what gives each image its meaning.
      content: [
        { type: 'text', text: args.prompt },
        ...(firstFrame === undefined ? [] : [{ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' }]),
        ...(lastFrame === undefined ? [] : [{ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' }]),
        ...references.map(url => ({ type: 'image_url', image_url: { url }, role: 'reference_image' })),
      ],
      ...(args.seconds === undefined ? {} : { duration: args.seconds }),
      ...(args.aspectRatio === undefined ? {} : { ratio: args.aspectRatio }),
    },
  }
  if (protocol === 'dashscope') {
    if (lastFrame !== undefined) throw new Error(`A last frame is unavailable on the "${route.provider}" media route`)
    const media = [
      ...(firstFrame === undefined ? [] : [{ type: 'first_frame', url: firstFrame }]),
      ...references.map(url => ({ type: 'reference_image', url })),
    ]
    return {
      endpoint: '/api/v1/services/aigc/video-generation/video-synthesis',
      // The route is asynchronous by contract: without this header it is
      // rejected outright, and the status call must not carry it.
      headers: { 'X-DashScope-Async': 'enable' },
      body: {
        model: route.model,
        input: { prompt: args.prompt, ...(media.length === 0 ? {} : { media }) },
        parameters: { ...(args.seconds === undefined ? {} : { duration: args.seconds }), ...(args.aspectRatio === undefined ? {} : { ratio: args.aspectRatio }) },
      },
    }
  }
  if (protocol === 'minimax') {
    // MiniMax declares a first frame only: a last frame or a reference set has
    // no field to travel in, so the route steps aside instead of dropping them.
    if (lastFrame !== undefined) throw new Error(`A last frame is unavailable on the "${route.provider}" media route`)
    if (references.length > 0) throw new Error(`Reference images are unavailable on the "${route.provider}" media route`)
    return {
      endpoint: '/v2/video_generation',
      body: {
        model: route.model,
        content: [
          { type: 'text', text: args.prompt },
          ...(firstFrame === undefined ? [] : [{ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' }]),
        ],
        ...(args.seconds === undefined ? {} : { duration: args.seconds }),
        ...(args.aspectRatio === undefined ? {} : { ratio: args.aspectRatio }),
      },
    }
  }
  if (protocol === 'vidu') {
    // Vidu splits every mode across its own route, and all of them carry their
    // frames as an `images` array: [first frame], [first, last], or the
    // reference set. The mode therefore picks the route, not just the body.
    const mode = lastFrame !== undefined
      ? { endpoint: ['/ent/v2/start-end2video', '/ent/v2/img2video'], images: [...(firstFrame === undefined ? [] : [firstFrame]), lastFrame] }
      : references.length > 0
        ? { endpoint: ['/ent/v2/reference2video', '/ent/v2/img2video'], images: [...references] }
        : firstFrame === undefined
          ? { endpoint: ['/ent/v2/text2video', '/ent/v2/img2video'], images: [] as string[] }
          : { endpoint: ['/ent/v2/img2video', '/ent/v2/text2video'], images: [firstFrame] }
    return {
      endpoint: mode.endpoint,
      body: {
        model: route.model,
        prompt: args.prompt,
        ...(mode.images.length === 0 ? {} : { images: mode.images }),
        ...(args.seconds === undefined ? {} : { duration: args.seconds }),
        // The official img2video route takes no aspect ratio: the frame decides it.
        ...(args.aspectRatio === undefined || (firstFrame !== undefined && lastFrame === undefined && references.length === 0) ? {} : { aspect_ratio: args.aspectRatio }),
      },
    }
  }
  if (protocol === 'gemini') {
    if (lastFrame !== undefined) throw new Error(`A last frame is unavailable on the "${route.provider}" media route`)
    if (references.length > 0) throw new Error(`Reference images are unavailable on the "${route.provider}" media route`)
    if (/veo/i.test(route.model)) return { endpoint: `/models/${encodeURIComponent(route.model)}:predictLongRunning`, body: { instances: [{ prompt: args.prompt, ...(firstFrame === undefined ? {} : { image: { uri: firstFrame } }) }], parameters: { ...(args.seconds === undefined ? {} : { durationSeconds: args.seconds }), ...(args.aspectRatio === undefined ? {} : { aspectRatio: args.aspectRatio }) } } }
  }
  if (protocol === 'xai') {
    if (lastFrame !== undefined) throw new Error(`A last frame is unavailable on the "${route.provider}" media route`)
    return {
      endpoint: ['/videos/generations', '/videos'],
      body: {
        model: route.model,
        prompt: args.prompt,
        // The length is `duration`, an integer of 2-10 seconds, and the value
        // arriving here is already inside that window: the request builder refuses
        // anything else as this route's limitation rather than clamping it into a
        // shorter video than the caller asked for.
        ...(args.seconds === undefined ? {} : { duration: args.seconds }),
        ...(args.aspectRatio === undefined ? {} : { aspect_ratio: args.aspectRatio }),
        // `image` is `{url}|{file_id}` — a bare string fails request decoding —
        // and it cannot be combined with the reference set.
        ...(firstFrame === undefined ? {} : { image: { url: firstFrame } }),
        ...(references.length === 0 ? {} : { reference_images: references.map(url => ({ url })) }),
      },
    }
  }
  if (protocol === 'openai') {
    // The OpenAI video create body has a single image field and no reference set: a
    // last frame or a source set has no field to travel in, so this route steps
    // aside — the rule MiniMax, Gemini and xAI follow above — instead of returning
    // a video generated from the prompt alone. The frame travels as `firstFrame`,
    // the validated and trimmed value; `args.image` was neither.
    if (lastFrame !== undefined) throw new Error(`A last frame is unavailable on the "${route.provider}" media route`)
    if (references.length > 0) throw new Error(`Reference images are unavailable on the "${route.provider}" media route`)
    return { endpoint: ['/videos', '/videos/generations'], body: { model: route.model, prompt: args.prompt, ...(args.seconds === undefined ? {} : { seconds: args.seconds }), ...(args.aspectRatio === undefined ? {} : { aspect_ratio: args.aspectRatio }), ...(firstFrame === undefined ? {} : { image: firstFrame }) } }
  }
  // The gateway adapts upstream itself, so a reference set travels in the shape
  // its OpenAI-compatible media layer reads. Everything else about this request
  // is byte-identical to what the gateway has always received.
  // A last frame is the one role the portable body has no field for, and this route
  // cannot be assumed to invent one. It steps aside so the ladder reaches a provider
  // that interpolates — Kling's `image_tail`, Ark's `last_frame` role, Vidu's
  // start-end route — rather than returning a video built from the prompt and the
  // first frame alone, which is what happened before: `lastImage` was accepted here
  // and silently dropped. The first frame travels as the validated value every other
  // protocol already carries.
  if (lastFrame !== undefined) throw new Error(`A last frame is unavailable on the "${route.provider}" media route`)
  return { endpoint: ['/videos/generations', '/videos'], body: { model: route.model, prompt: args.prompt, ...(args.seconds === undefined ? {} : { seconds: args.seconds }), ...(args.aspectRatio === undefined ? {} : { aspect_ratio: args.aspectRatio }), ...(firstFrame === undefined ? {} : { image: firstFrame }), ...(references.length === 0 ? {} : { reference_images: references.map(url => ({ url })) }) } }
}

export function generatedVideoResult(model: string, value: unknown): { readonly model: string; readonly videoId?: string; readonly status?: string; readonly url?: string; readonly error?: string; readonly result: unknown } {
  const root = object(value); const data = object(root.data); const output = object(root.output); const first = Array.isArray(root.data) ? object(root.data[0]) : {}; const taskResult = object(data.task_result ?? data.taskResult); const taskVideo = Array.isArray(taskResult.videos) ? object(taskResult.videos[0]) : {}; const googleResponse = object(root.response); const googleVideoResponse = object(googleResponse.generateVideoResponse ?? googleResponse.generate_video_response); const googleSample = Array.isArray(googleVideoResponse.generatedSamples) ? object(googleVideoResponse.generatedSamples[0]) : Array.isArray(googleVideoResponse.generated_samples) ? object(googleVideoResponse.generated_samples[0]) : {}; const googleVideo = object(googleSample.video); const videoObject = object(root.video); const creations = Array.isArray(root.creations) ? object(root.creations[0]) : {}; const task = object(root.task); const errorObject = object(root.error)
  // Task-id precedence follows the protocols: DashScope answers with
  // output.task_id, Gemini with the operation `name`, Kling/MiniMax/Vidu with a
  // top-level task_id, and xAI's compatible layer with request_id.
  const videoId = [output.task_id, data.task_id, root.task_id, root.taskId, root.request_id, data.request_id, root.id, data.id, root.name].find(item => typeof item === 'string' && item.trim() !== '') as string | undefined
  // root.task_status / root.taskStatus first: Kling/Kuaishou poll responses
  // carry the task state at the TOP level, and only the data-level copies were
  // checked before — a top-level `task_status: "failed"` read as "no status"
  // and a failed task masqueraded as a still-running one.
  const statusValue = [root.task_status, root.taskStatus, output.task_status, output.taskStatus, root.status, root.state, task.status, data.status, data.state, data.task_status, data.taskStatus].find(item => typeof item === 'string'); const rawStatus = statusValue?.toLowerCase(); const status = root.done === true ? 'completed' : rawStatus === undefined ? undefined : /(?:succeed|success|completed|done)/.test(rawStatus) ? 'completed' : /(?:fail|error|expired)/.test(rawStatus) ? 'failed' : /cancel/.test(rawStatus) ? 'cancelled' : rawStatus
  // task_status_msg is the Kling provider's failure detail field.
  // A provider may describe the failure as a string or as an `error` object
  // carrying code/message; both must reach the fallback chain as text.
  const error = [root.error, errorObject.message, root.task_status_msg, root.message, data.error, data.message, output.message, output.task_status_msg, task.error_message].find(item => typeof item === 'string' && item.trim() !== '') as string | undefined
  const url = ([root.url, root.video_url, root.output_url, data.url, data.video_url, data.output_url, output.url, output.video_url, videoObject.url, videoObject.video_url, creations.url, creations.video_url, first.url, first.video_url, taskVideo.url, googleVideo.uri].find(item => typeof item === 'string' && /^https?:\/\//i.test(item)) as string | undefined) ?? findGeneratedVideoUrl(value)
  return { model, ...(videoId === undefined ? {} : { videoId }), ...(status === undefined ? {} : { status }), ...(url === undefined ? {} : { url }), ...(error === undefined ? {} : { error }), result: value }
}
function object(value: unknown): Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {} }
function findGeneratedVideoUrl(value: unknown, depth = 0): string | undefined { if (depth > 6 || value === null || value === undefined) return undefined; if (Array.isArray(value)) return value.map(item => findGeneratedVideoUrl(item, depth + 1)).find(Boolean); if (typeof value !== 'object') return undefined; for (const [key, nested] of Object.entries(value as Record<string, unknown>)) if (typeof nested === 'string' && /(?:video|output|url|uri)/i.test(key) && /^https?:\/\//i.test(nested)) return nested; for (const nested of Object.values(value as Record<string, unknown>)) { const found = findGeneratedVideoUrl(nested, depth + 1); if (found !== undefined) return found }; return undefined }
