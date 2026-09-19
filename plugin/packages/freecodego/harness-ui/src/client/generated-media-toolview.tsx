import { useEffect, useState, type ReactNode } from 'react'

type ImageAttachment = {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

type ToolBlock = {
  readonly kind?: string
  readonly isError?: boolean
  readonly content?: readonly { readonly type?: string; readonly text?: string; readonly attachment?: ImageAttachment }[]
  readonly call?: { readonly argsRaw?: string }
  readonly argsRaw?: string
}

type GeneratedMediaProps = {
  readonly toolName: string
  readonly block: ToolBlock
  readonly loadImage: (attachment: ImageAttachment) => Promise<string>
}

function imageRefs(block: ToolBlock): readonly ImageAttachment[] {
  return (block.content ?? []).flatMap(item => item.type === 'image' && item.attachment !== undefined ? [item.attachment] : [])
}

function summaryText(block: ToolBlock): string {
  return (block.content ?? []).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text!).join('\n')
}

function promptText(block: ToolBlock): string {
  const raw = block.call?.argsRaw ?? block.argsRaw ?? ''
  try {
    const value = JSON.parse(raw) as { prompt?: unknown }
    return typeof value.prompt === 'string' ? value.prompt : ''
  } catch {
    return ''
  }
}

function videoUrls(block: ToolBlock): readonly string[] {
  const urls = new Set<string>()
  const visit = (value: unknown, key = ''): void => {
    if (typeof value === 'string' && /(?:url|video|output|uri)/iu.test(key) && /^(?:https?:|blob:|data:)/iu.test(value)) {
      urls.add(value)
      return
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, key); return }
    if (value !== null && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, childKey)
  }
  for (const item of block.content ?? []) {
    if (item.type !== 'text' || typeof item.text !== 'string') continue
    try { visit(JSON.parse(item.text)) } catch { /* plain status text */ }
  }
  return [...urls]
}

/** Render generated image attachments for FreeCodeGo-owned media tools. */
export function GeneratedMediaToolView({ toolName, block, loadImage }: GeneratedMediaProps): ReactNode {
  const refs = imageRefs(block)
  const videos = toolName.includes('video') ? videoUrls(block) : []
  const [urls, setUrls] = useState<readonly (string | undefined)[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  // The attachment list is the stable identity of this block's media payload;
  // keying on the block object itself re-fires on every transcript re-render
  // because chat blocks are rebuilt per render pass.
  const mediaKey = refs.map(ref => ref.attachmentId).join('|')
  useEffect(() => {
    let active = true
    setError(undefined)
    setUrls([])
    void Promise.all(refs.map(ref => loadImage(ref))).then((values) => {
      if (active) setUrls(values)
    }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
    // `mediaKey` covers the refs identity, so this dependency list is deliberate.
  }, [mediaKey, loadImage])
  // Blob URLs returned by the shared image cache are owned by the cache, so
  // this view only revokes the ones it created itself (none today); the
  // dependent key above keeps one fetch per media payload instead of leaking
  // a fresh request per render.
  const isVideo = toolName.includes('video')
  const label = isVideo ? toolName.includes('agnes') ? '视频生成' : 'FreeCodeGo 视频生成' : toolName.includes('agnes') ? '图片生成' : 'FreeCodeGo 图片生成'
  const prompt = promptText(block)
  const text = summaryText(block)
  return <details open={refs.length > 0 || videos.length > 0} style={{ margin: '8px 0', border: '1px solid var(--fcg-line)', borderRadius: 'var(--fcg-radius-md)', overflow: 'hidden', background: 'var(--fcg-bg-layer-2)' }}>
    <summary style={{ cursor: 'pointer', padding: '8px 12px', color: 'var(--fcg-text-secondary)', fontSize: 13 }}>{label}{prompt === '' ? '' : ` · ${prompt.slice(0, 80)}`}</summary>
    <div style={{ padding: '8px 12px 12px' }}>
      {error === undefined ? null : <div style={{ color: 'var(--fcg-danger)', fontSize: 12 }}>图片加载失败：{error}</div>}
      {urls.map((url, index) => url === undefined ? null : <img key={`${refs[index]?.attachmentId ?? index}`} src={url} alt={`${label} ${index + 1}`} style={{ display: 'block', width: '100%', maxWidth: 720, maxHeight: 720, objectFit: 'contain', margin: index === 0 ? 0 : '10px 0 0', borderRadius: 'var(--fcg-radius-sm)' }} />)}
      {videos.map((url, index) => <video key={url} controls preload="metadata" src={url} aria-label={`${label} ${index + 1}`} style={{ display: 'block', width: '100%', maxWidth: 720, maxHeight: 720, margin: index === 0 ? 0 : '10px 0 0', borderRadius: 'var(--fcg-radius-sm)', background: 'var(--fcg-bg-tip)' }} />)}
      {refs.length === 0 && videos.length === 0 && text !== '' ? <div style={{ whiteSpace: 'pre-wrap', color: 'var(--fcg-text-secondary)', fontSize: 13 }}>{text}</div> : null}
    </div>
  </details>
}

/** Register both current and legacy image tool names without changing core UI. */
export function installGeneratedMediaToolviews(ctx: { readonly slots: { inject(name: string, setup: () => unknown): unknown; register(options: Record<string, unknown>, component: unknown): unknown } }): void {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'freecodego_generate_image' }, GeneratedMediaToolView))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'agnes_generate_image' }, GeneratedMediaToolView))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'freecodego_generate_video' }, GeneratedMediaToolView))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'agnes_generate_video' }, GeneratedMediaToolView))
}
