/**
 * The web-search page's missing control: which model answers the search.
 *
 * The stock page over `web-search-deepseek` edits the key, the endpoint, and the
 * search budget, and leaves the model at the schema default (`deepseek-v4-flash`
 * against DeepSeek's own Anthropic endpoint). That is the one part of the
 * provider a FreeCodeGo installation wants to change: nobody on this plugin pays
 * DeepSeek per search, and the routes they do pay for are registered here.
 *
 * So this section renders in the page's own detail slot — under its
 * configuration, where the page's blank lower half is — lists every model this
 * plugin routes, and writes the choice back into the same settings namespace the
 * page above edits. Nothing here is a second settings document: the section
 * reads and writes `web-search-deepseek` through the shared config-form service,
 * so the stock fields and this list can never disagree.
 *
 * The endpoint and the key come from the Host, via `webSearchBind`, because the
 * route decision and every provider key live there. The client asks for one
 * route, writes the credential it receives under the reference it is told, and
 * points the namespace at that reference; a binding that cannot be resolved
 * leaves the page's own fields untouched and says why.
 *
 * @module client/web-search-provider-section
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { FreeCodeGoWebSearchBinding, FreeCodeGoWebSearchBindingStatus } from '@deepseek-ai/dsh-freecodego-harness-plugin'
import css from './web-search-provider-section.module.css'

/**
 * The settings namespace the stock web-search page owns.
 *
 * Spelled here rather than imported: a client package must not depend on a Host
 * package, and the page spells it the same way for the same reason.
 */
export const WEB_SEARCH_NAMESPACE = 'web-search-deepseek'

/** The `plugins.item` id of the page this section contributes to. */
export const WEB_SEARCH_PAGE_ID = 'web-search'

/** Locale keys this section renders. */
export type WebSearchSectionLocaleKey =
  | 'searchProviderTitle' | 'searchProviderHint' | 'searchProviderCurrent' | 'searchProviderNone'
  | 'searchProviderUse' | 'searchProviderActive' | 'searchProviderReset' | 'searchProviderUnavailable'
  | 'searchProviderLoading' | 'searchProviderLoadFailed' | 'searchProviderSaving' | 'searchProviderSaved'
  | 'searchProviderSavedEphemeral' | 'searchProviderFailed' | 'searchProviderRefused'
  | 'searchProviderRebuilt' | 'searchProviderNeedsPick' | 'searchProviderRepairFailed'

/** One model this plugin can route, as the picker lists it. */
export interface WebSearchModelOption {
  /** Provider the row belongs to (`vyce`, `freecodego`, …). */
  readonly provider: string
  /** Model id the Host routes and the search request would carry. */
  readonly id: string
  /** Display name; falls back to {@link id}. */
  readonly label?: string | undefined
}

/** The search provider's namespace as this section reads it. */
export interface WebSearchNamespaceValue {
  readonly model?: string
  readonly baseURL?: string
  readonly apiKeyEnv?: string
}

/** Where the credential goes; the credentials domain, never the settings file. */
export interface WebSearchCredentialWriter {
  set(ref: string, value: string): Promise<unknown>
}

/** What the registration injects: the reads, the Host binding call, and the locale seat. */
export interface WebSearchProviderSectionFace {
  /** The page's subject: the section renders only for its own page. */
  readonly subject?: { readonly kind?: string; readonly id?: string } | undefined
  /** Every model this plugin routes. */
  readonly models: () => Promise<readonly WebSearchModelOption[]>
  /** Resolve one route into the endpoint, model, and key the search provider needs. */
  readonly bind: (input: { readonly provider: string; readonly model: string }) => Promise<RemoteResult<FreeCodeGoWebSearchBinding>>
  /** Ask the Host whose binding the page holds, and whether the endpoint behind it still answers. */
  readonly status: () => Promise<RemoteResult<FreeCodeGoWebSearchBindingStatus>>
  /**
   * Record the pair in this plugin's own settings, where the Host reads it back.
   *
   * The stock namespace has no field for it, and without the pair a restart cannot
   * rebuild a binding whose endpoint is process-local — so this write is what makes
   * the choice survivable, not a convenience.
   */
  readonly remember: (pair: { readonly provider: string; readonly model: string }) => Promise<void>
  /** The shared form over `web-search-deepseek`; undefined when the settings service is absent. */
  readonly form: () => ConfigForm<WebSearchNamespaceValue> | undefined
  /** The credentials domain; undefined when no client provides it. */
  readonly credentials: () => WebSearchCredentialWriter | undefined
  /** Localized copy for this plugin's namespace. */
  readonly t: (key: WebSearchSectionLocaleKey) => string
}

/** What the last write did, as the status line reports it. */
type Notice =
  | { readonly kind: 'busy'; readonly key: string }
  | { readonly kind: 'done'; readonly durable: boolean; readonly baseURL: string }
  | { readonly kind: 'failed'; readonly message: string }

/** Drop a provider prefix so a comparison is about the model, not its spelling. */
function bareModelId(id: string): string {
  return id.trim().replace(/^[a-z0-9_-]+\//iu, '').toLowerCase()
}

/**
 * The web-search page's model list, under its own configuration.
 * @param props - the page's subject plus the reads, writes, and copy.
 * @returns the section, or null on every other plugin's page.
 */
export function WebSearchProviderSection(props: WebSearchProviderSectionFace): ReactNode {
  const relevant = props.subject?.kind === 'item' && props.subject.id === WEB_SEARCH_PAGE_ID
  const [options, setOptions] = useState<readonly WebSearchModelOption[] | undefined>(undefined)
  const [current, setCurrent] = useState<WebSearchNamespaceValue | undefined>(undefined)
  const [problem, setProblem] = useState<'unavailable' | 'offline' | undefined>(undefined)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  /** What the liveness check did, when a saved binding needed it. */
  const [recovery, setRecovery] = useState<'rebuilt' | 'needs-pick' | 'failed' | undefined>(undefined)
  // The inject closures are re-created by the renderer's slot inject; reading
  // them through a ref keeps the effects below keyed on the page, not on their
  // identity.
  const face = useRef(props)
  useEffect(() => { face.current = props })

  const subscribe = useCallback((): (() => void) | undefined => {
    const form = face.current.form()
    if (form === undefined) {
      setProblem('unavailable')
      return undefined
    }
    const publish = (): void => {
      const snapshot = form.getSnapshot()
      setCurrent(snapshot.value)
      setProblem(snapshot.status === 'unavailable' ? 'unavailable' : undefined)
    }
    publish()
    const off = form.subscribe(publish)
    return off
  }, [])

  useEffect(() => {
    if (!relevant) return
    let active = true
    const off = subscribe()
    void face.current.models().then((list) => {
      if (active) setOptions(list)
    }, () => {
      if (active) setProblem('offline')
    })
    return () => { active = false; off?.() }
  }, [relevant, subscribe])

  /**
   * Write one resolved binding into the page's namespace and this plugin's settings.
   *
   * The order is load-bearing: the key, then the pair the Host would rebuild from,
   * then the section that names both. The section is what makes the search provider
   * resolve the reference, so a section written first would be a search that fails
   * with an authentication error; and a pair recorded after it would be a binding a
   * crash could leave without a memory.
   */
  const writeBinding = useCallback(async (
    binding: FreeCodeGoWebSearchBinding,
    pair: { readonly provider: string; readonly model: string },
  ): Promise<void> => {
    const { form, credentials, remember, t } = face.current
    const writer = credentials()
    if (writer === undefined) { setNotice(undefined); setProblem('unavailable'); return }
    await writer.set(binding.apiKeyEnv, binding.apiKey)
    await remember(pair)
    const namespace = form()
    if (namespace === undefined) { setNotice(undefined); setProblem('unavailable'); return }
    const accepted = await namespace.mutate([
      { op: 'set', path: ['model'], value: binding.model },
      { op: 'set', path: ['baseURL'], value: binding.baseURL },
      { op: 'set', path: ['apiKeyEnv'], value: binding.apiKeyEnv },
    ])
    setNotice(accepted
      ? { kind: 'done', durable: binding.durable, baseURL: binding.baseURL }
      : { kind: 'failed', message: t('searchProviderRefused') })
  }, [])

  const apply = useCallback((option: WebSearchModelOption): void => {
    const pair = { provider: option.provider, model: option.id }
    setNotice({ kind: 'busy', key: `${option.provider}\u0000${option.id}` })
    void (async () => {
      const result = await face.current.bind(pair)
      if (!result.ok) { setNotice({ kind: 'failed', message: result.error.message }); return }
      await writeBinding(result.value, pair)
    })().catch((error: unknown) => {
      setNotice({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
  }, [writeBinding])

  /**
   * Check the saved binding once, and rebuild it when this process cannot serve it.
   *
   * A bridge endpoint's port, route id, and secret are minted per process, so a binding
   * saved before a restart is dead until it is re-resolved — the Host does that at
   * boot, and this is the second layer for the case it could not (no credentials
   * service, a write the profile refused). Whether the saved route is alive is a
   * question only the Host can answer: a fresh resolution mints a *new* id, so
   * comparing URLs would report every healthy binding as stale.
   */
  const verified = useRef(false)
  useEffect(() => {
    if (!relevant || verified.current) return
    // Wait for the first accepted section: before it there is nothing to check, and
    // an answer about a document that has not arrived yet would be about nothing.
    if (face.current.form()?.getSnapshot().status !== 'ready') return
    verified.current = true
    void (async () => {
      const answer = await face.current.status()
      if (!answer.ok) return
      const status = answer.value
      if (status.state !== 'bridge' || status.alive) return
      const pair = status.remembered
      // A binding whose pair was never recorded cannot be rebuilt from anything but
      // the user's own choice, and the list below is where they make it.
      if (pair === undefined) { setRecovery('needs-pick'); return }
      setNotice({ kind: 'busy', key: `${pair.provider}\u0000${pair.model}` })
      const binding = await face.current.bind(pair)
      if (!binding.ok) { setNotice(undefined); setRecovery('failed'); return }
      await writeBinding(binding.value, pair)
      setRecovery('rebuilt')
    })().catch(() => { setNotice(undefined); setRecovery('failed') })
  }, [relevant, current, writeBinding])

  const reset = useCallback((): void => {
    const namespace = face.current.form()
    if (namespace === undefined) { setProblem('unavailable'); return }
    setNotice({ kind: 'busy', key: '' })
    void namespace.mutate([
      { op: 'unset', path: ['model'] },
      { op: 'unset', path: ['baseURL'] },
      { op: 'unset', path: ['apiKeyEnv'] },
    ]).then((accepted) => {
      setNotice(accepted ? undefined : { kind: 'failed', message: face.current.t('searchProviderRefused') })
    }, (error: unknown) => {
      setNotice({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
  }, [])

  if (!relevant) return null
  const { t } = props
  const groups = new Map<string, WebSearchModelOption[]>()
  for (const option of options ?? []) {
    const list = groups.get(option.provider) ?? []
    list.push(option)
    groups.set(option.provider, list)
  }
  const activeId = current?.model === undefined ? undefined : bareModelId(current.model)
  return (
    <section className={css.section} data-freecodego-web-search-provider>
      <div className={css.head}>
        <h4 className={css.title}>{t('searchProviderTitle')}</h4>
        {current?.model === undefined ? null : (
          <button type="button" className={css.reset} onClick={reset}>{t('searchProviderReset')}</button>
        )}
      </div>
      <p className={css.hint}>{t('searchProviderHint')}</p>
      <p className={css.current}>
        {current?.model === undefined
          ? t('searchProviderNone')
          : `${t('searchProviderCurrent')}${current.model}${current.baseURL === undefined ? '' : ` · ${current.baseURL}`}`}
      </p>
      {problem === 'unavailable' ? <p className={css.problem}>{t('searchProviderUnavailable')}</p> : null}
      {problem === 'offline' ? <p className={css.problem}>{t('searchProviderLoadFailed')}</p> : null}
      {options === undefined && problem === undefined ? <p className={css.hint}>{t('searchProviderLoading')}</p> : null}
      {[...groups.entries()].map(([provider, rows]) => (
        <div key={provider} className={css.group}>
          <span className={css.provider}>{provider}</span>
          <div className={css.rows}>
            {rows.map((option) => {
              const active = activeId !== undefined && bareModelId(option.id) === activeId
              const busy = notice?.kind === 'busy' && notice.key === `${option.provider}\u0000${option.id}`
              return (
                <button
                  key={`${option.provider}/${option.id}`}
                  type="button"
                  className={active ? `${css.row} ${css.rowActive}` : css.row}
                  disabled={notice?.kind === 'busy'}
                  title={active ? t('searchProviderActive') : t('searchProviderUse')}
                  onClick={() => { apply(option) }}
                >
                  <span className={css.rowLabel}>{option.label ?? option.id}</span>
                  <span className={css.rowMeta}>{busy ? t('searchProviderSaving') : active ? t('searchProviderActive') : option.id}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {notice?.kind === 'done' ? (
        <p className={css.done}>{notice.durable ? t('searchProviderSaved') : t('searchProviderSavedEphemeral')}</p>
      ) : null}
      {notice?.kind === 'done' ? <p className={css.rowMeta}>{notice.baseURL}</p> : null}
      {recovery === 'rebuilt' ? <p className={css.done}>{t('searchProviderRebuilt')}</p> : null}
      {recovery === 'needs-pick' ? <p className={css.problem}>{t('searchProviderNeedsPick')}</p> : null}
      {recovery === 'failed' ? <p className={css.problem}>{t('searchProviderRepairFailed')}</p> : null}
      {notice?.kind === 'failed' ? <p className={css.problem}>{`${t('searchProviderFailed')}${notice.message}`}</p> : null}
    </section>
  )
}
