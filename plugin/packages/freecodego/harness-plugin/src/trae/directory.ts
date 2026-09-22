/**
 * The TRAE SOLO configuration table.
 *
 * SOLO does not publish a model list; it publishes the *configurations* its
 * client may ask for, and the conversation body names one of them. The table is
 * therefore the directory: `config_name` is the id every request states, and
 * `display_config.display_name` is what a picker shows. It is read from the
 * conversation host with the same headers a turn uses, so an account that can
 * talk can also enumerate — and one that cannot gets the same refusal here,
 * which is what lets the card say why the picker is empty instead of showing a
 * list that could not be used.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/directory
 */

import { asRecord, asString } from '../untrusted-json.ts'
import { buildTraeSoloHeaders } from './bridge.ts'
import { TRAE_DIRECTORY_TIMEOUT_MS, TRAE_FUNCTION, traeModelsUrl } from './endpoints.ts'
import { TraeUpstreamError } from './errors.ts'
import type { TraeAccount, TraeModel } from './types.ts'

/**
 * Parse the configuration table.
 *
 * Empty rows are dropped rather than named after their index: a configuration
 * without a `config_name` cannot be asked for, so carrying it would put a row
 * in the picker that fails when it is chosen.
 *
 * Every row is kept, including the ones a picker must not offer — see
 * {@link selectableTraeModels}, which is the separate question of what a user
 * may choose. Realm routing reads this list, and a session stored before the
 * filter existed may still name a hidden configuration; knowing which realm
 * serves it is worth more there than tidiness.
 * @param payload - the untrusted directory document.
 * @returns the parsed models, by display name.
 */
export function parseTraeModels(payload: unknown): readonly TraeModel[] {
  const document = asRecord(payload)
  const list = document.config_info_list
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const models: TraeModel[] = []
  for (const item of list) {
    const row = asRecord(item)
    const id = asString(row.config_name)?.trim() ?? ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const named = asString(asRecord(row.display_config).display_name)?.trim() ?? ''
    models.push({
      id,
      displayName: named === '' ? id : named,
      selectable: traeRowSelectable(row, named),
    })
  }
  return models.sort((left, right) => left.displayName.localeCompare(right.displayName))
}

/**
 * Whether one upstream row may be offered by a picker.
 *
 * See {@link selectableTraeModels} for what each rule is guarding against; the
 * decisions live here because this is where the upstream's own fields are still
 * readable.
 * @param row - the untrusted configuration row.
 * @param named - the display name the row carried, empty when it carried none.
 * @returns whether a picker may offer this configuration.
 */
function traeRowSelectable(row: Record<string, unknown>, named: string): boolean {
  if (row.is_invisible_to_user === true) return false
  if (Array.isArray(row.custom_models) && row.custom_models.length > 0) return false
  if (named === '') return false
  return asString(asRecord(row.display_config).model_capability) !== undefined
}

/**
 * The configurations a user may be offered.
 *
 * SOLO's table is the client's whole wiring, not a menu: measured against a real
 * account (44 rows), it carries internal aliases, sub-agent routes, a
 * conversation-summary configuration and the BYOK slots the IDE fills from the
 * user's own provider keys. Three of those are recognizable from the row itself,
 * and each one is a row that either cannot be asked for or would be a promise
 * this connector cannot keep:
 *
 * - `is_invisible_to_user` — the upstream's own flag. It is what hides the
 *   sub-agent routes (`browser_use_subagent`, `computer_use_subagent`) and the
 *   alias rows (`glm-5`, `glm-5-turbo`, `Doubao-Seed-2.0-Code`, …) that exist to
 *   serve an older client build.
 * - a BYOK slot — a row with `custom_models`, whose actual model is chosen
 *   inside the IDE against a key the connector does not hold. Sending the slot's
 *   name from here asks the upstream for a model nobody selected.
 * - no display name — the row is an internal id (`custom_model_1M`, …) whose
 *   label would otherwise be its own config name.
 *
 * A row that declares no `model_capability` is dropped too: that is what the
 * table's non-model entries look like (`summary`), and a picker that offers them
 * offers a configuration no turn is meant to run on.
 * @param models - the parsed directory.
 * @returns the rows a picker may show, in the order they arrived.
 */
export function selectableTraeModels(models: readonly TraeModel[]): readonly TraeModel[] {
  return models.filter(model => model.selectable)
}

/**
 * Read the configuration table through one account's session.
 * @param account - the account whose token authorizes the read.
 * @param signal - aborts the read.
 * @param timeoutMs - how long the read may take when the caller brings no signal.
 * @returns the parsed directory.
 */
export async function fetchTraeModels(
  account: TraeAccount,
  signal?: AbortSignal,
  timeoutMs = TRAE_DIRECTORY_TIMEOUT_MS,
): Promise<readonly TraeModel[]> {
  // The table is served by the account's own realm and, because the product
  // identity is part of the request, what the table contains depends on the
  // realm's declared build: the same international account reads the current
  // model roster as SOLO and a truncated one as the classic client.
  const response = await fetch(traeModelsUrl(account.realm, account.userRegion), {
    method: 'POST',
    headers: buildTraeSoloHeaders(account, false),
    // The IDE's own request: it asks for every configuration, with no prompt to
    // evaluate, in the mode that returns the whole table.
    body: JSON.stringify({
      function: TRAE_FUNCTION,
      config_names: null,
      need_prompt: false,
      current_config_info: null,
      poly_prompt: true,
      mode_type: null,
      agent_type: null,
    }),
    ...(signal === undefined ? { signal: AbortSignal.timeout(timeoutMs) } : { signal }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new TraeUpstreamError(response.status, detail.slice(0, 300))
  }
  return parseTraeModels(await response.json().catch(() => ({})))
}
