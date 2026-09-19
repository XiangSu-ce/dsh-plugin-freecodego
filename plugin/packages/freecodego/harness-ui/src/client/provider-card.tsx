/**
 * One card per provider on the "Accounts and providers" page.
 *
 * The page previously hand-built each section, so the four providers drifted
 * into four different layouts, four ways of stating status, and — in two cases
 * — a hand-typed model roster that contradicted the live directory. This owns
 * a single shape instead: identity and status, an optional cloud of the models
 * the provider actually offers right now, then whatever controls the caller
 * supplies.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-ui/client/provider-card
 */

import { useState, type ReactNode } from 'react'
import css from './provider-card.module.css'

export type ProviderStatusTone = 'live' | 'idle' | 'warn'

export interface ProviderCardProps {
  /** Provider glyph. Decorative — the name beside it carries the meaning. */
  readonly icon?: ReactNode | undefined
  /** Provider name, e.g. `logfare`. */
  readonly name: string
  /** What the section is for, e.g. `API Key`. */
  readonly title: string
  readonly status: { readonly label: string; readonly tone: ProviderStatusTone }
  /** One-line fact under the name, e.g. `基础 12 · 高级 9`. */
  readonly summary?: string | undefined
  /**
   * Model names to show as tags. These are display strings, already resolved
   * by the caller from live data. An empty array renders no cloud at all
   * rather than an empty box.
   */
  readonly models?: readonly string[] | undefined
  /** Render tags in the mono face — for ids that are not prose. */
  readonly modelsAreIdentifiers?: boolean | undefined
  readonly description?: string | undefined
  readonly notice?: string | undefined
  readonly actions?: ReactNode | undefined
  readonly children?: ReactNode | undefined
  readonly language: 'zh' | 'en'
}

/** How many tags a collapsed cloud shows before the expander appears. */
export const MODEL_TAG_LIMIT = 6

/**
 * Split model names into what fits and how many are held back.
 *
 * `hiddenCount === 0` is the caller's signal to omit the expander entirely:
 * a "show all" control that reveals nothing is worse than no control.
 */
export function collapseModelLabels(models: readonly string[], limit = MODEL_TAG_LIMIT): { readonly visible: readonly string[]; readonly hiddenCount: number } {
  if (limit < 0) return { visible: [], hiddenCount: models.length }
  return { visible: models.slice(0, limit), hiddenCount: Math.max(0, models.length - limit) }
}

/** Every model name, with duplicates removed but order preserved. */
export function uniqueModelLabels(models: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const model of models) {
    const name = model.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** Decorative provider marks. Deliberately generic geometry rather than
 * redrawn third-party logos: these identify a section inside our own settings
 * panel, and shipping recognisable brand marks we do not own would be a
 * licensing problem for a purely decorative gain. */
export type ProviderGlyphKind = 'logfare' | 'sensenova' | 'nvidia' | 'agnes' | 'cline' | 'workbuddy' | 'vyce' | 'generic'

export function ProviderGlyph({ kind, size = 18 }: { readonly kind: ProviderGlyphKind; readonly size?: number }): ReactNode {
  const common = { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true as const }
  if (kind === 'logfare') {
    return <svg {...common}><path d="M4 15.5 10 4l6 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M6.8 12.6h6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
  }
  if (kind === 'sensenova') {
    return <svg {...common}><path d="M10 3.4l1.9 4.7 4.7 1.9-4.7 1.9L10 16.6l-1.9-4.7L3.4 10l4.7-1.9z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
  }
  if (kind === 'nvidia') {
    return <svg {...common}><path d="M3.4 10h13.2M10 3.4v13.2M5.2 5.2l9.6 9.6M14.8 5.2l-9.6 9.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
  }
  if (kind === 'cline') {
    return <svg {...common}><rect x="3.4" y="4.4" width="13.2" height="11.2" rx="2.4" stroke="currentColor" strokeWidth="1.5" /><path d="M7.2 9.2 9.6 11l-2.4 1.8M11.2 13h3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
  }
  if (kind === 'workbuddy') {
    return <svg {...common}><circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" /><path d="M6.6 8.4c1-.9 2.3-1 3.2-.2.9-.8 2.2-.7 3.2.2M6.4 11.8h7.2M8 13.6c1.3.8 2.7.8 4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
  }
  if (kind === 'vyce') {
    return <svg {...common}><path d="M4.4 4.6 10 15.4 15.6 4.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M12.2 4.6h3.4v3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
  }
  if (kind === 'agnes') {
    return <svg {...common}><circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6" /><ellipse cx="10" cy="10" rx="7.4" ry="3.4" stroke="currentColor" strokeWidth="1.4" transform="rotate(-28 10 10)" /></svg>
  }
  return <svg {...common}><rect x="4" y="4" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.6" /></svg>
}

export function ProviderCard(input: ProviderCardProps): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const models = uniqueModelLabels(input.models ?? [])
  const { visible, hiddenCount } = collapseModelLabels(models)
  const shown = expanded ? models : visible
  const toneClass = input.status.tone === 'live' ? css.statusLive : input.status.tone === 'warn' ? css.statusWarn : css.statusIdle

  return (
    <section className={css.card} aria-label={input.name}>
      <header className={css.head}>
        <div className={css.identity}>
          {input.icon === undefined ? null : <span className={css.mark} aria-hidden="true">{input.icon}</span>}
          <div className={css.names}>
            <strong className={css.name}>{input.name}</strong>
            <small className={css.title}>{input.title}</small>
          </div>
        </div>
        <span className={css.status} data-tone={input.status.tone}>
          <span className={`${css.statusDot} ${toneClass}`} aria-hidden="true" />
          {input.status.label}
        </span>
      </header>
      {input.summary === undefined ? null : <div className={css.summary}>{input.summary}</div>}
      {models.length === 0 ? null : <div className={css.cloud}>
        {shown.map(model => <span className={input.modelsAreIdentifiers === true ? `${css.tag} ${css.tagMono}` : css.tag} key={model} title={model}>{model}</span>)}
        {hiddenCount === 0 ? null : <button className={css.more} type="button" aria-expanded={expanded} onClick={() => { setExpanded(open => !open) }}>
          {expanded
            ? input.language === 'zh' ? '收起' : 'Show fewer'
            : input.language === 'zh' ? `显示全部 ${models.length} 个模型` : `Show all ${models.length} models`}
        </button>}
      </div>}
      {input.description === undefined ? null : <small className={css.description}>{input.description}</small>}
      {input.notice === undefined ? null : <div className={css.notice} role="note"><span className={css.noticeDot} aria-hidden="true" />{input.notice}</div>}
      {input.children === undefined ? null : <div className={css.body}>{input.children}</div>}
      {input.actions === undefined ? null : <div className={css.actions}>{input.actions}</div>}
    </section>
  )
}
