/**
 * The per-provider "what the model picker shows" controls.
 *
 * The chat picker is the stock Harness menu, and the Host registers every
 * adapter it can serve. So the only place a user can say "I do not want WorkBuddy
 * in my model list" is here, on the provider's own card, and the answer has to
 * reach the menu that is kept open in the chat surface beside it.
 *
 * The panel owns its own storage subscription instead of taking the decisions as
 * a prop: the setting belongs to the provider, not to whichever page happens to
 * render it, and a card can mount long after the preference was written.
 *
 * @module client/provider-model-visibility
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
// The shared settings stylesheet, like every other panel next to this one
// (`capability-detail`, `community-plugins`, `payment-dialog`,
// `token-usage-dashboard`). The provider switch in particular *is* the settings
// switch: a second, near-identical pill in a private stylesheet is how the two
// controls would drift apart.
import css from './settings-tab.module.css'
import { modelPriceClass, type ModelPriceClass } from './model-price.ts'
import {
  FREE_TIER_PROVIDERS,
  clearModelPickerVisibility,
  bareModelId,
  isModelVisible,
  isProviderVisible,
  readModelPickerVisibility,
  setModelVisible,
  setModelsVisible,
  setProviderVisible,
  subscribeModelPickerVisibility,
  writeModelPickerVisibility,
  type ModelPickerVisibility,
} from './model-picker-visibility.ts'

/**
 * One row of the checklist.
 *
 * `id` is the picker's own model id, because that is what a decision is stored
 * against, and it is also what the two surfaces have in common: the settings
 * page reads it from the picker's directory, the picker reads it from the
 * directory it is rendering. A label is what the user reads and is never used as
 * a key.
 */
export interface ProviderPickerModel {
  readonly id: string
  /** Display name; falls back to the id when the directory reports none. */
  readonly label?: string | undefined
  /**
   * The row's own description, which is where the adapter states its price.
   *
   * Carried because the price decides whether the row starts shown: a metered
   * route waits behind a click while a free one is offered straight away, and
   * the description is the only place the browser can read which it is.
   */
  readonly description?: string | undefined
}

/** One model per picker row, with the gateway's per-group rows collapsed.
 *
 * The gateway lists one row per (model, group) and the picker shows each as its
 * own row. A checklist that repeated "claude fable 5" once per group would look
 * like a bug and would let the user hide half a model: the decision is stored
 * against the bare id, so every pinned row moves together. Duplicates are
 * therefore removed by bare id, first label wins.
 * @param models - the picker rows to fold.
 * @returns the rows to render, one per bare model id.
 */
export function uniquePickerModels(models: readonly ProviderPickerModel[]): readonly ProviderPickerModel[] {
  const seen = new Set<string>()
  const out: ProviderPickerModel[] = []
  for (const model of models) {
    const id = model.id.trim()
    if (id === '') continue
    const key = bareModelId(id)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id,
      ...(model.label === undefined || model.label.trim() === '' ? {} : { label: model.label }),
      ...(model.description === undefined ? {} : { description: model.description }),
    })
  }
  return out
}

/**
 * Whether two rosters say the same thing.
 *
 * The retry below re-reads the directory and must not re-render when nothing
 * changed: a fresh array would be a new value to React, and the retry would feed
 * itself.
 * @param left - the rows already on screen.
 * @param right - the rows just read.
 * @returns whether they carry the same ids and labels in the same order.
 */
export function samePickerModels(left: readonly ProviderPickerModel[], right: readonly ProviderPickerModel[]): boolean {
  if (left.length !== right.length) return false
  // The description is compared too: it is where a price change arrives, and a
  // row that started costing money must re-render as hidden rather than keep the
  // default it was drawn with.
  return left.every((model, index) => {
    const other = right[index]
    return other !== undefined && model.id === other.id && (model.label ?? '') === (other.label ?? '') && (model.description ?? '') === (other.description ?? '')
  })
}

/** Whether a provider's rows are advertised as free by the plugin's own knowledge.
 * @param provider - provider id from the Host catalog.
 * @returns whether every route this provider offers is free to use.
 */
export function isFreeProvider(provider: string): boolean {
  return FREE_TIER_PROVIDERS.has(provider.trim().toLowerCase())
}

/**
 * What one row costs, as far as anything here can say.
 *
 * The row's own description is asked first: it is the adapter's statement about
 * this exact route, so a metered route inside a free provider is read as metered.
 * Only a silent description falls back to the provider-level claim, which is what
 * keeps a whole-free provider's unpriced rows badged and offered exactly as they
 * were before per-row prices existed.
 * @param provider - provider id from the Host catalog.
 * @param model - the picker row.
 * @returns the row's price class.
 */
export function pickerModelPrice(provider: string, model: ProviderPickerModel): ModelPriceClass {
  const stated = modelPriceClass(model.description)
  if (stated !== 'unknown') return stated
  return isFreeProvider(provider) ? 'free' : 'unknown'
}

/**
 * Delays to re-read an empty directory list at.
 *
 * Bounded on purpose: the session directory arrives once when a session binds,
 * so a few retries cover the race between opening this page and the catalog
 * landing, and a poll for the life of the panel does not. The three delays span
 * roughly seven seconds, longer than a cold Host catalog read takes.
 */
const EMPTY_DIRECTORY_RETRY_MS = [800, 2_000, 4_000] as const

export interface ProviderModelVisibilityProps {
  /** Provider id from the Host catalog, e.g. `workbuddy`. */
  readonly provider: string
  /**
   * Every model this provider currently offers, as the picker lists them.
   *
   * A reader rather than an array: the directory that feeds the picker loads
   * asynchronously, so the panel has to be able to look again (see the retry
   * above) without the caller having to thread a subscription through.
   * @returns the provider's picker rows, or an empty list while unknown.
   */
  readonly models: () => readonly ProviderPickerModel[]
  readonly language: 'zh' | 'en'
}

/** Decorative gear marking the settings toggle. Generic geometry, like the
 * provider glyphs: it identifies a control inside our own settings panel. */
function SettingsGlyph(): ReactNode {
  return <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.14 12.94a7.14 7.14 0 0 0 .06-.94c0-.32-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.61.22L2.74 8.87a.5.5 0 0 0 .12.64l2.03 1.58a7.14 7.14 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.61.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z" /></svg>
}

/** Disclosure caret for the settings toggle; rotates when the panel opens. */
function ChevronGlyph(): ReactNode {
  return <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m6 8 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

/**
 * Provider switch plus a checkbox per model.
 *
 * The panel is folded to a settings button until the user asks for it: an
 * always-open checklist made every provider card tall enough to bury the next
 * one, and the decision it holds is one most users never change. Both controls
 * still default to shown — except a curated provider, whose unnamed rows start
 * hidden (see {@link model-picker-visibility}).
 *
 * Folding is presentational only: the stored decisions are untouched while the
 * panel is closed, so a collapsed card still shows the badge for what is hidden.
 * @returns the visibility panel for one provider card.
 */
export function ProviderModelVisibility({ provider, models, language }: ProviderModelVisibilityProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [visibility, setVisibility] = useState<ModelPickerVisibility>(() => readModelPickerVisibility())
  const [unique, setUnique] = useState<readonly ProviderPickerModel[]>(() => uniquePickerModels(models()))
  const modelsRef = useRef(models)
  modelsRef.current = models
  // The chat picker can hide a provider without this panel being mounted at all,
  // and another tab writes the same preference; both arrive as the store's
  // event, so the panel never shows a switch that disagrees with the menu.
  useEffect(() => subscribeModelPickerVisibility(() => { setVisibility(readModelPickerVisibility()) }), [])
  useEffect(() => {
    let cancelled = false
    // Typed from the timer itself, not as `number`: the client bundle and the
    // server-side typecheck see different `setTimeout` declarations, and the
    // Node one returns a `Timeout` object.
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const read = (attempt: number): void => {
      if (cancelled) return
      const next = uniquePickerModels(modelsRef.current())
      if (next.length > 0 || attempt >= EMPTY_DIRECTORY_RETRY_MS.length) {
        setUnique(previous => samePickerModels(previous, next) ? previous : next)
        return
      }
      timer = globalThis.setTimeout(() => { read(attempt + 1) }, EMPTY_DIRECTORY_RETRY_MS[attempt])
    }
    read(0)
    return () => {
      cancelled = true
      if (timer !== undefined) globalThis.clearTimeout(timer)
    }
  }, [provider])

  const providerVisible = isProviderVisible(visibility, provider)
  const modelRows = unique.map(model => ({ id: model.id, price: pickerModelPrice(provider, model) }))
  const hiddenCount = unique.filter((model, index) => !isModelVisible(visibility, provider, model.id, modelRows[index]!.price)).length
  const rows = unique.map((model, index) => ({
    model,
    label: model.label ?? bareModelId(model.id),
    price: modelRows[index]!.price,
    visible: isModelVisible(visibility, provider, model.id, modelRows[index]!.price),
  }))
  const zh = language === 'zh'
  // The folded button still has to say why the card is worth opening, so it
  // carries the sharpest fact: the provider is off, or how many of its rows are.
  const badge = !providerVisible
    ? (zh ? '已隐藏' : 'hidden')
    : hiddenCount > 0 ? (zh ? `隐藏 ${hiddenCount}` : `${hiddenCount} hidden`) : undefined

  const commit = (next: ModelPickerVisibility): void => {
    writeModelPickerVisibility(next)
    setVisibility(next)
  }

  return (
    <section className={css.pickerVisibilityPanel} data-open={open ? 'true' : 'false'} aria-label={zh ? '模型列表显示设置' : 'Model list visibility'}>
      <button className={css.pickerVisibilityToggle} type="button" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <span className={css.pickerVisibilityGear} aria-hidden="true"><SettingsGlyph /></span>
        <span className={css.pickerVisibilityToggleLabel}>{zh ? '模型列表显示设置' : 'Model list visibility'}</span>
        {badge === undefined ? null : <em className={css.pickerVisibilityBadge}>{badge}</em>}
        <span className={css.pickerVisibilityChevron} aria-hidden="true"><ChevronGlyph /></span>
      </button>
      {open ? <label className={css.pickerVisibilityMaster}>
        <input
          className={css.switch}
          type="checkbox"
          checked={providerVisible}
          onChange={(event) => { commit(setProviderVisible(visibility, provider, event.target.checked)) }}
        />
        <span className={css.pickerVisibilityText}>
          <strong>{zh ? '在模型列表中显示该提供商' : 'Show this provider in the model list'}</strong>
          <small>{zh
            ? '关闭后，此提供商的整组模型不会出现在对话框的模型选择弹窗中。'
            : 'When off, this provider\u2019s whole group disappears from the model picker in the composer.'}</small>
        </span>
      </label> : null}
      {open ? (unique.length === 0 ? <small className={css.pickerVisibilityEmpty}>
        {zh ? '尚未取得该提供商的模型目录；登录或配置后即可逐项选择。' : 'No model directory yet. Sign in or configure the provider to choose individual models.'}
      </small> : <>
        <div className={css.pickerVisibilityHead}>
          <small className={css.pickerVisibilityLabel}>{zh
            ? `显示哪些模型（共 ${unique.length} 个，已隐藏 ${hiddenCount} 个）`
            : `Which models to show (${unique.length} total, ${hiddenCount} hidden)`}</small>
          <div className={css.pickerVisibilityActions}>
            <button className={css.pickerVisibilityLink} type="button" onClick={() => { commit(setModelsVisible(visibility, provider, modelRows, true)) }}>{zh ? '全选' : 'All'}</button>
            <button className={css.pickerVisibilityLink} type="button" onClick={() => { commit(setModelsVisible(visibility, provider, modelRows, false)) }}>{zh ? '全不选' : 'None'}</button>
            <button className={css.pickerVisibilityLink} type="button" onClick={() => { setVisibility(clearModelPickerVisibility()) }}>{zh ? '恢复默认' : 'Reset'}</button>
          </div>
        </div>
        <div className={css.pickerVisibilityList} data-visible={providerVisible ? 'true' : 'false'}>
          {rows.map(row => <label className={css.pickerVisibilityRow} key={row.model.id} title={row.model.id}>
            <input
              className={css.pickerVisibilityCheck}
              type="checkbox"
              checked={row.visible}
              onChange={(event) => { commit(setModelVisible(visibility, provider, row.model.id, event.target.checked, row.price)) }}
            />
            <span className={css.pickerVisibilityName}>{row.label}</span>
            {/* The price is the row's own, not the provider's: a metered route
                inside a free provider is exactly the one the user needs told
                about before switching it on. */}
            {row.price === 'free' ? <em className={css.pickerVisibilityFree}>{zh ? '免费' : 'free'}</em> : null}
            {row.price === 'paid' ? <em className={css.pickerVisibilityPaid}>{zh ? '付费' : 'paid'}</em> : null}
          </label>)}
        </div>
      </>) : null}
    </section>
  )
}
