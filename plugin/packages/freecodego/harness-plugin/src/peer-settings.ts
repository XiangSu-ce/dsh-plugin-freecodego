/**
 * Another plugin's live settings, read through the shared settings service.
 *
 * Why a peer read exists at all
 * -----------------------------
 * Two of this package's behaviour reads are about someone else's configuration: the
 * saved-model resolver asks the Harness Models entry which routes the user defined, and
 * media generation asks it for the Base URL and key reference of the provider it posts to.
 * Neither is a setting of ours, so neither is in {@link Config}, and both have to see what
 * the user actually configured.
 *
 * What changed, and why the read moved
 * ------------------------------------
 * A plugin's settings used to be a namespace the settings service owned, so a peer read
 * was `settings.get('llm-pi-ai')`. There are no namespaces now: an entry's `Config` *is*
 * its settings document, and the service is a form over the entries the profile declares.
 * The public read that remains is {@link SettingsForms.describe} — the same call the
 * settings page makes — which returns one descriptor per active entry carrying that
 * entry's live values, so the answer is `describe().find(descriptor => descriptor.ns ===
 * 'llm-pi-ai')?.value`.
 *
 * Reading it this way is deliberate rather than a workaround. The alternatives are both
 * worse: the profile patch on disk is the *input* layer (a deployment could set a value the
 * running entry never resolved), and asking the `llm` service gives provider ids without the
 * profile those providers were configured from. `describe()` is the service's own answer to
 * "what is configured", restricted to the fields each entry marks live, and it needs no
 * filesystem read.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/peer-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { maybeRecord } from './untrusted-json.ts'

/**
 * The profile entry id of the Harness Models plugin (`packages/bundle/base/cordis.patch.yml`,
 * `- id: llm-pi-ai`).
 *
 * The same string the old read used as a namespace: an entry id *is* its settings address
 * now, so the rename of the mechanism left this value alone.
 */
export const MODELS_SETTINGS_ENTRY = 'llm-pi-ai'

/** The settings service as this module reads it: the one method, stated structurally. */
interface SettingsReader {
  describe(): readonly { readonly ns: string; readonly value: unknown }[]
}

/**
 * One related plugin's live settings document, or `undefined` when it is not mounted.
 *
 * The absence is not an error: a composition without the Models entry, or one whose entry
 * has not finished activating, is a state both callers already handle by falling back to
 * their own defaults.
 * @param ctx - context carrying the settings service.
 * @param entryId - the profile entry id whose settings are wanted (`llm-pi-ai`).
 * @returns the entry's live values, or `undefined` when it is not mounted.
 */
export function peerSettings(ctx: Context, entryId: string): Record<string, unknown> | undefined {
  const settings = ctx.get('settings') as SettingsReader | undefined
  if (typeof settings?.describe !== 'function') return undefined
  try {
    const descriptor = settings.describe().find(row => row.ns === entryId)
    return descriptor === undefined ? undefined : maybeRecord(descriptor.value)
  } catch {
    // `describe()` walks the active entries and reflects over each one's schema; a
    // composition in a state it refuses to describe is a peer read that answers nothing,
    // and neither caller may fail a session or a media call over it.
    return undefined
  }
}
