/**
 * The Qoder model directory.
 *
 * Qoder's `/algo/api/v2/model/list` document groups models under `assistant`,
 * `developer`, and `chat`; only enabled rows are usable. The product request
 * this connector serves is the free Qwen flash route, so {@link selectFreeQoderModels}
 * narrows the directory to exactly that model.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/qoder/directory
 */

import { asNumber, asRecord, asString } from '../untrusted-json.ts'
import { buildCosyHeaders, cosyPathSig } from './cosy.ts'
import { qoderEndpoints } from './endpoints.ts'
import type { QoderModel, QoderSession } from './types.ts'

/**
 * The only directory route this connector advertises, matched on the model's
 * key or display name. Qoder spells the route `qmodel_38flash`; the aliases
 * cover the display-name spellings so a rename on the product side does not
 * silently empty the picker. Every branch anchors on `flash`, so a sibling
 * route such as Qwen 3.8 Max is deliberately *not* advertised.
 */
const FREE_MODEL_PATTERN = /(?:qwen|qmodel)[\s._-]*3[\s._-]?8[\s._-]*flash|flash[\s._-]*3[\s._-]?8/iu

function extractModel(value: unknown): QoderModel | undefined {
  const row = asRecord(value)
  const key = asString(row.key)
  if (key === undefined || key === '') return undefined
  const displayName = asString(row.display_name) ?? key
  const isReasoning = row.is_reasoning === true
  let contextWindow = asNumber(row.max_input_tokens) ?? 0
  const contextConfig = Array.isArray(row.context_config) ? row.context_config : []
  const selected = contextConfig.map(asRecord).find(cfg => cfg.is_default === true) ?? contextConfig.map(asRecord)[0]
  const tokenCount = selected === undefined ? undefined : asNumber(selected.token_count)
  if (tokenCount !== undefined && tokenCount > 0) contextWindow = tokenCount
  const maxInputTokens = asNumber(row.max_input_tokens)
  const priceFactor = asNumber(row.price_factor)
  if (contextWindow === 0) contextWindow = maxInputTokens ?? 0
  return {
    key,
    displayName,
    enable: row.enable === true,
    isDefault: row.is_default === true,
    isReasoning,
    ...(contextWindow === 0 ? {} : { contextWindow }),
    maxOutputTokens: isReasoning ? 32768 : 16384,
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(priceFactor === undefined ? {} : { priceFactor }),
  }
}

/**
 * Parse the model-list document into enabled rows, default first then by name.
 * @param payload - the untrusted directory document.
 * @returns the parsed models.
 */
export function parseQoderCatalog(payload: unknown): readonly QoderModel[] {
  const document = asRecord(payload)
  for (const category of ['assistant', 'developer', 'chat']) {
    const raw = document[category]
    if (!Array.isArray(raw) || raw.length === 0) continue
    const models = raw
      .map(extractModel)
      .filter((model): model is QoderModel => model !== undefined && model.enable)
    if (models.length === 0) continue
    return [...models].sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1
      return left.displayName.localeCompare(right.displayName)
    })
  }
  return []
}

/**
 * Narrow the directory to the free Qwen flash route this connector serves.
 * @param models - the parsed directory.
 * @returns the matched models (empty when the product does not offer the route).
 */
export function selectFreeQoderModels(models: readonly QoderModel[]): readonly QoderModel[] {
  return models.filter(model => FREE_MODEL_PATTERN.test(`${model.key} ${model.displayName}`))
}

/**
 * Read the model directory through one signed session.
 * @param session - the account session.
 * @param signal - aborts the read.
 * @returns the parsed directory.
 */
export async function fetchQoderModels(session: QoderSession, signal?: AbortSignal): Promise<readonly QoderModel[]> {
  const url = qoderEndpoints(session.region).modelListUrl
  const headers = buildCosyHeaders(session, cosyPathSig(url), '', 'application/json')
  const response = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Qoder model list failed: HTTP ${response.status}`)
  return parseQoderCatalog(await response.json().catch(() => ({})))
}
