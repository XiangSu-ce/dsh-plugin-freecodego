/**
 * Give the user's own third-party API routes a thinking-level control.
 *
 * Why this write exists
 * ---------------------
 * Every other route this build serves comes with a catalog behind it: `llm-pi-ai`
 * ships model entries that already state whether a model reasons and which
 * efforts it takes, so the picker's effort row appears by itself. A **custom
 * third-party API** is different — the user declares it on the Harness Models
 * page, so its models are hand-written entries with an id and nothing else.
 * `catalog.ts`'s `resolveModelReasoning` reads exactly that as "does not reason"
 * (`reasoning: false`), and `adapter.ts`'s `reasoningInfo` then reports no
 * reasoning at all, which is what the surface reads as "no effort row". The
 * selector is not hidden by a bug; it is hidden because nobody ever said the
 * model can think.
 *
 * The one channel that says so is `PiAiModelProfile.reasoningEfforts`: a dict of
 * the offered levels and their wire spellings. The plugin therefore declares
 * `off`/`low`/`medium`/`high` on each hand-declared model, which makes `off` mean
 * "send nothing" (the parameter's absence, the correct wire for a model that
 * should not think) and each other level send its own spelling.
 *
 * Where the write goes, and why not the package default
 * ----------------------------------------------------
 * The declaration is written into the **user's own `llm-pi-ai` settings
 * document**, through the settings service's path mutation, rather than into the
 * package's schema defaults. A default would apply to every deployment that
 * installs this plugin — including one whose custom endpoint rejects an
 * unexpected `reasoning_effort` — and it would also rewrite the meaning of a
 * field the Models page owns. The user's document is the layer that is actually
 * theirs, and `mutate` is the API that edits it without restating it (a
 * wholesale `replace` built from a redacted descriptor would delete the API keys
 * the descriptor never returned).
 *
 * Additive and idempotent
 * -----------------------
 * Three rules keep this from ever fighting its owner:
 *
 * - an entry that states its own `reasoningEfforts` — including `false` — is left
 *   alone, so a deliberate answer always wins;
 * - a model the live adapter already reports reasoning for is left alone, so a
 *   catalog-backed route is never narrowed to the four levels below;
 * - nothing is ever unset. There is no "off switch" for this module beyond
 *   removing the declaration, which the user does on the Models page.
 *
 * A run that finds nothing to declare writes nothing at all, which is also what
 * makes running on every settings change safe: the mutation it would perform
 * emits `settings/document-updated` again, and the next pass sees its own work
 * and stops.
 *
 * Best-effort throughout, like every other write this plugin makes: a locked or
 * absent settings service is logged and skipped, never allowed to fail a boot or
 * a session.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/custom-api-reasoning
 */

import type { Context } from '@deepseek-ai/cordis'
import { MODELS_SETTINGS_ENTRY } from './peer-settings.ts'
import { maybeRecord } from './untrusted-json.ts'

/**
 * The levels declared on a hand-declared model, in escalation order.
 *
 * Deliberately the four a plain OpenAI-compatible endpoint can be expected to
 * understand. `minimal`, `xhigh` and `max` are pi-ai levels with vendor-specific
 * wires, and declaring them for an arbitrary endpoint would offer the user a
 * choice whose spelling the provider is likely to reject.
 *
 * `off` maps to `null` — supported, send nothing — which is the wire for "do not
 * think" on every protocol this build speaks.
 */
const DECLARED_REASONING_EFFORTS: Readonly<Record<string, string | null>> = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
}

/**
 * The provider-level default level written alongside them.
 *
 * `off` because it is the level that sends nothing: a request that never picked
 * an effort on a route this plugin only just declared has to stay byte-for-byte
 * what it was before the declaration existed. It also gives the described model a
 * default the selector can name, instead of leaving the surface to show whatever
 * the provider's own default happens to be.
 */
const DECLARED_DEFAULT_LEVEL = 'off'

/** One path-addressed edit, as `packages/settings/settings` spells it. */
type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/**
 * The settings service, as this module reads it.
 *
 * Structural rather than imported: the settings service is a Host peer this
 * plugin must keep loading without, and only two of its methods are used.
 */
interface SettingsEditor {
  describe(): readonly { readonly ns: string; readonly value: unknown }[]
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/**
 * The `llm` service's exact-model read, as this module reads it.
 *
 * `reasoning` is the field that decides the whole module: its presence is the
 * adapter saying the model already offers efforts, and its absence is the only
 * reason to declare any.
 */
interface LlmModelResolver {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ readonly reasoning?: unknown }>
}

/** Resolve the settings service from a context, or `undefined` when it is not up. */
function settingsEditor(ctx: Context): SettingsEditor | undefined {
  let candidate: unknown
  try { candidate = ctx.get('settings') } catch { return undefined }
  const view = candidate as Partial<SettingsEditor> | undefined
  // The second test reads `view` without `?.` on purpose: a passing function
  // check on the first field has already narrowed the view to non-undefined.
  return typeof view?.describe === 'function' && typeof view.mutate === 'function'
    ? view as SettingsEditor
    : undefined
}

/** Resolve the `llm` service from a context, or `undefined` when it is not up. */
function llmResolver(ctx: Context): LlmModelResolver | undefined {
  let candidate: unknown
  try { candidate = ctx.get('llm') } catch { return undefined }
  const view = candidate as Partial<LlmModelResolver> | undefined
  return typeof view?.resolveModelInfo === 'function' ? view as LlmModelResolver : undefined
}

/**
 * Whether the live adapter already offers reasoning efforts for one route.
 *
 * Read through the adapter rather than guessed from the entry, because the
 * installed catalog is the other place a model's reasoning can come from: a
 * hand-declared id that also exists in the catalog already reports its own
 * efforts, and redeclaring them here would narrow a model that already works.
 *
 * A route the resolver refuses — a provider whose entry is still activating, or
 * one whose configuration cannot be served — answers "no": the declaration is
 * additive and schema-validated, so the cost of an unnecessary one is an effort
 * row that sends a rejected parameter, while the cost of skipping a real custom
 * route is the missing control this module exists to provide. The next settings
 * change re-runs the pass.
 * @param llm - the `llm` service, when composed.
 * @param provider - the configured provider route key.
 * @param model - the hand-declared model id.
 * @returns true when the model already offers reasoning efforts.
 */
async function alreadyOffersReasoning(llm: LlmModelResolver | undefined, provider: string, model: string): Promise<boolean> {
  if (llm === undefined) return false
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return info.reasoning !== undefined && info.reasoning !== null
  } catch {
    return false
  }
}

/**
 * Declare the reasoning levels for every hand-declared third-party model that
 * has none, in the user's own `llm-pi-ai` settings.
 *
 * Safe to call as often as the caller likes: a pass that finds every model
 * already answered writes nothing.
 * @param ctx - the context carrying the settings and `llm` services.
 * @returns how many path operations were written, `0` when nothing needed one.
 */
export async function syncCustomApiReasoning(ctx: Context): Promise<number> {
  const settings = settingsEditor(ctx)
  if (settings === undefined) return 0
  let descriptor: { readonly ns: string; readonly value: unknown } | undefined
  try { descriptor = settings.describe().find(row => row.ns === MODELS_SETTINGS_ENTRY) } catch { return 0 }
  const providers = maybeRecord(maybeRecord(descriptor?.value)?.providers)
  if (providers === undefined) return 0
  const llm = llmResolver(ctx)
  const ops: SettingsPathOp[] = []
  for (const [provider, profileValue] of Object.entries(providers)) {
    if (provider.trim() === '') continue
    const profile = maybeRecord(profileValue)
    const models = profile?.models
    if (!Array.isArray(models)) continue
    let declaredAny = false
    for (const [index, entryValue] of models.entries()) {
      const entry = maybeRecord(entryValue)
      if (entry === undefined) continue
      // The entry's own answer wins, whichever answer it is: `false` is a model
      // its owner declared non-reasoning, and a dict is one they spelled out.
      if (entry.reasoningEfforts !== undefined) continue
      const id = entry.id
      if (typeof id !== 'string' || id.trim() === '') continue
      if (await alreadyOffersReasoning(llm, provider, id)) continue
      ops.push({
        op: 'set',
        path: ['providers', provider, 'models', String(index), 'reasoningEfforts'],
        // A fresh literal per op: the settings service clones what it is given,
        // but sharing one object across ops would make a later mutation of it a
        // process-wide surprise.
        value: { ...DECLARED_REASONING_EFFORTS },
      })
      declaredAny = true
    }
    // The default level rides along only when this pass declared something for
    // the provider, and only when the provider states none of its own.
    if (declaredAny && profile?.reasoning === undefined) {
      ops.push({ op: 'set', path: ['providers', provider, 'reasoning'], value: DECLARED_DEFAULT_LEVEL })
    }
  }
  if (ops.length === 0) return 0
  await settings.mutate(MODELS_SETTINGS_ENTRY, ops)
  return ops.length
}
