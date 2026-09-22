/**
 * The Qoder rows the settings card and the picker read, and the thinking
 * contract behind them.
 *
 * These are the shapes that cross out of the Host: a stored account as the
 * browser may see it, and one directory route as the picker and the settings
 * checklist read it. They live apart from {@link ../qoder-intl} because that
 * module is the connector shell — the pool, the rotation, the wire — while these
 * are pure mappings from a parsed row to a browser-safe one, and the file's own
 * size limit is easier to hold when the two are not interleaved.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/qoder/rows
 */

import type { QoderAccount, QoderModel } from './types.ts'
import type { QoderAccountInfo, QoderModelInfo } from '../types.ts'

/** The route advertised before sign-in so the picker can show what sign-in adds. */
export const QODER_FALLBACK_MODEL: QoderModelInfo = {
  id: 'qmodel_38flash',
  displayName: 'Qwen 3.8 Flash (free)',
  isReasoning: false,
}

/**
 * The two thinking levels this connector can offer, and the only two it can.
 *
 * Qoder's chat body takes a boolean — `model_config.is_reasoning` — and nothing
 * else: no tier, no budget, no token allowance. The reference client that speaks
 * this protocol carries that one flag and no other reasoning parameter, so a
 * menu spelling "low / medium / high" would offer three levels the upstream
 * never receives. On and off are what the wire can express, so on and off are
 * what the menu says.
 */
export const QODER_REASONING_EFFORTS = ['off', 'on'] as const

/** The level preselected for a route whose thinking the user has not touched. */
export const QODER_REASONING_DEFAULT = 'on'

/**
 * Whether one request asked for thinking to be left off.
 *
 * The absent field is the same answer as `off`: `serializeRequest` drops an
 * `off` effort rather than spelling it, so a body that states no level is a
 * body that chose not to think. That is also the reading every other adapter
 * here gives the absence, which is what makes "no reasoning fields" mean "no
 * reasoning" instead of "ask the directory".
 * @param effort - the effort as it arrived on the wire body, if at all.
 * @returns true when this request must not think.
 */
export function reasoningDisabled(effort: unknown): boolean {
  if (effort === undefined) return true
  return typeof effort === 'string' && effort.trim().toLowerCase() === 'off'
}

/** Map one stored account to its browser-safe row. */
export function qoderAccountInfo(account: QoderAccount): QoderAccountInfo {
  return {
    id: account.id,
    region: account.region,
    ...(account.name === undefined ? {} : { name: account.name }),
    ...(account.email === undefined ? {} : { email: account.email }),
    ...(account.plan === undefined ? {} : { plan: account.plan }),
    ...(account.quota === undefined ? {} : { quota: account.quota }),
  }
}

/** Map one Qoder model to its browser-safe row. */
export function qoderModelInfo(model: QoderModel): QoderModelInfo {
  return {
    id: model.key,
    displayName: model.displayName,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxTokens: model.maxOutputTokens }),
    isReasoning: model.isReasoning,
    ...(model.priceFactor === undefined ? {} : { priceFactor: model.priceFactor }),
  }
}

/**
 * One route's price as the picker and the settings checklist read it.
 *
 * Qoder's directory states a `price_factor` per row, and zero is the free tier —
 * the same reading every other directory here gives a multiplier of zero. A row
 * the directory does not price is described without a marker rather than as
 * free: "no stated price" and "costs nothing" are different answers, and only
 * one of them is something this code can see.
 * @param model - the browser-safe row.
 * @returns the description string.
 */
export function qoderModelDescription(model: QoderModelInfo): string {
  const factor = model.priceFactor
  if (factor === undefined) return 'Qoder · 官方模型'
  return `Qoder · ×${factor} · ${factor === 0 ? 'free' : 'metered'}`
}
