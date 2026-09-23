/**
 * Installs the bundled FreeCodeGo agent presets into the harness roster.
 *
 * Two mechanisms, because the roster's owner changed underneath this plugin.
 *
 * Up to harness 0.1.6 the roster was a directory: the harness re-scanned
 * `<DSH_HOME>/.agent-presets/` on every read (`preset/agent-presets`'s
 * `discovery.ts`). 0.1.7 deleted that package and replaced it with a declared
 * registry — `preset/agent-preset-registry` publishes `ctx.agentPresets`, and
 * every preset is a `@deepseek-ai/dsh-agent-preset` declaration whose
 * `config.plugins` the registry mounts. Nothing scans `.agent-presets/` any
 * more, so a directory written there is invisible: the mode would silently
 * disappear from the picker.
 *
 * {@link installFreeCodeGoAgentPresets} therefore prefers the registry: when
 * `ctx.agentPresets` is composed it declares both bundled presets through it
 * (the service's own seam, so the roster reports them with their real
 * diagnostics) and writes no directory at all. Only a deployment with no
 * registry — an older harness — falls through to the directory sync below.
 *
 * A preset the deployment already declares wins: the registry owns its
 * composition by id, so this plugin skips an id that is already on the roster
 * rather than racing it with a duplicate.
 *
 * The choice is made after the Loader settles ({@link loaderSettled}), because a
 * plugin constructor runs before the rows declared after it: `ctx.get` would
 * report "no registry" on every cold start and take the dead directory path.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/agent-preset-install
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { harnessHomeDirectory } from './data-home.ts'
import { maybeRecord } from './untrusted-json.ts'

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
// The bundled npm artifact ships assets inside its dist/ directory next to
// bootstrap.js; the source package keeps them at the package root.
const BUNDLED_PRESETS_ROOT = [
  resolve(MODULE_DIRECTORY, 'assets/presets'),
  resolve(MODULE_DIRECTORY, '../assets/presets'),
  resolve(MODULE_DIRECTORY, '../../assets/presets'),
  resolve(MODULE_DIRECTORY, '../../../assets/presets'),
].find(existsSync) ?? resolve(MODULE_DIRECTORY, '../assets/presets')

/** The preset id this module owns for the Claude-style mode. */
export const FREECODEGO_AGENT_PRESET_ID = 'freecodego'
/** The preset id this module owns for the Augment-Code-style mode. */
export const AUGMENTCODE_AGENT_PRESET_ID = 'augmentcode'
/** Every preset this module syncs into the harness user roster. */
export const BUNDLED_PRESET_IDS = [FREECODEGO_AGENT_PRESET_ID, AUGMENTCODE_AGENT_PRESET_ID] as const
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const
/** Every file this module writes starts with this marker line. */
const OWNERSHIP_MARKER = 'freecodego-agent-preset'

/**
 * The roster directory a pre-0.1.7 harness scans for user-authored presets.
 *
 * `.agent-presets/` is Host-owned (the Host re-scans it), so this resolves
 * against the harness home rather than `FREECODEGO_HOME` — the single resolver
 * in `data-home.ts` is what keeps that distinction in one place. Harness 0.1.7
 * reads no such directory; see the module doc.
 * @param presetId - the preset id whose roster directory to resolve.
 * @returns the roster directory path.
 */
export function agentPresetDirectory(presetId: string): string {
  return join(harnessHomeDirectory(), '.agent-presets', presetId)
}

/** The FreeCodeGo preset's roster directory (kept for callers keyed to one id).
 * @returns the FreeCodeGo preset's roster directory path.
 */
export function freeCodeGoAgentPresetDirectory(): string {
  return agentPresetDirectory(FREECODEGO_AGENT_PRESET_ID)
}

/**
 * The bundled source/bundle directory for one preset id, when this package
 * ships it. A preset with no bundled directory is simply not installed.
 */
function presetSourceDirectory(presetId: string): string | undefined {
  const directory = join(BUNDLED_PRESETS_ROOT, presetId)
  return existsSync(directory) ? directory : undefined
}

/**
 * Copy one bundled preset file into the roster directory.
 *
 * Missing → write. Identical → no-op. Bearing our marker but outdated →
 * overwrite (a plugin update shipped a newer composition). Present without
 * our marker → the user hand-edited the copy; leave their version alone.
 */
async function syncFile(source: string, target: string): Promise<void> {
  const bundled = await readFile(source, 'utf8')
  let existing: string | undefined
  try {
    existing = await readFile(target, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === bundled) return
  if (existing !== undefined && !existing.startsWith(`# ${OWNERSHIP_MARKER}`)) return
  // A crash mid-write must not leave a half-file the roster reports as broken.
  // The shared writer is what makes that true on Windows too — its bounded
  // retry over transient `EACCES`/`EBUSY`/`EPERM` covers the antivirus and
  // indexer interference that a bare `rename` loses to.
  // 0600: the roster copy is the user's own composition, never world-readable.
  await writeFileAtomic(target, bundled, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Ensure every bundled FreeCodeGo agent preset is present in the *directory*
 * roster (harness < 0.1.7).
 *
 * Best-effort: a read-only home or a locked file must never block boot. Harness
 * 0.1.7 and later read no directory, so this is only the fallback
 * {@link installFreeCodeGoAgentPresets} takes when no registry is composed.
 * @returns true when at least one bundled preset is in place afterwards.
 */
export async function ensureFreeCodeGoAgentPreset(): Promise<boolean> {
  try {
    let installedAny = false
    for (const presetId of BUNDLED_PRESET_IDS) {
      const source = presetSourceDirectory(presetId)
      if (source === undefined) continue
      installedAny = true
      const target = agentPresetDirectory(presetId)
      for (const file of PRESET_FILES) {
        await syncFile(join(source, file), join(target, file))
      }
    }
    // False when no preset ships in this layout, matching the previous
    // absent-directory answer so callers keep their existing fallbacks.
    return installedAny
  } catch {
    // The mode selector simply keeps whatever roster state is on disk.
    return false
  }
}

/** One plugin row inside a declared preset, as the bundled YAML spells it. */
type PresetRow = Record<string, unknown>

/** The declaration `@deepseek-ai/dsh-agent-preset` submits to the roster. */
export interface AgentPresetDefinition {
  /** Stable roster identifier; also the label's fallback. */
  readonly id: string
  /** Display name the picker shows. */
  readonly name?: string
  /** One sentence on what the preset is for. */
  readonly description?: string
  /** Roster sort key. */
  readonly order?: number
  /** Child plugin rows this preset mounts. */
  readonly plugins: readonly PresetRow[]
}

/**
 * The roster service, as this plugin consumes it.
 *
 * A structural copy rather than an import: the registry is a Host peer, not a
 * dependency of this package, and the plugin must keep loading when a
 * deployment composes an older harness that has no such service. Same shape as
 * `UpstreamPlanMode` in `plan-mode.ts`, for the same reason.
 */
export interface UpstreamAgentPresets {
  /** Every declared preset, including ones whose activation failed. */
  readonly list: () => Promise<readonly { readonly id: string }[]>
  /** Declare one preset; the returned function removes it again. */
  readonly register: (definition: AgentPresetDefinition) => Promise<() => Promise<void>>
}

/**
 * Wait until the Loader has settled every currently declared entry.
 *
 * Which roster mechanisms exist is only knowable then: `ctx.get` answers
 * `undefined` for a service whose providing entry has not activated yet, and a
 * plugin constructor runs before the rows declared after it. Reading the
 * registry at construction time would therefore report "no registry" on every
 * cold start and take the dead directory fallback. Same reason, and the same
 * `ctx.root.loader.await()` seam, as the harness settings service's own legacy
 * import (`packages/settings/settings/src/index.ts`, `importLegacyDocument`).
 *
 * A context that exposes no loader — a unit test's fake — settles immediately.
 * @param ctx - the cordis context to wait on.
 * @returns a promise that never rejects.
 */
async function loaderSettled(ctx: unknown): Promise<void> {
  const loader = (ctx as { readonly root?: { readonly loader?: { readonly await?: unknown } } } | undefined)
    ?.root?.loader
  if (typeof loader?.await !== 'function') return
  try { await (loader.await as () => Promise<unknown>).call(loader) } catch { /* a loader that failed to settle still leaves a usable roster */ }
}

/**
 * Resolve the harness roster service from a cordis context, if composed.
 *
 * `ctx.get` is total for a registered service and undefined otherwise, but it
 * can also throw while a realm is being torn down, so the lookup is guarded:
 * failing to find the registry falls back to the directory roster rather than
 * taking boot down.
 * @param ctx - the cordis context to resolve the service from.
 * @returns the upstream service, or `undefined` when it is not composed.
 */
export function findUpstreamAgentPresets(ctx: unknown): UpstreamAgentPresets | undefined {
  const get = (ctx as { readonly get?: unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  let candidate: unknown
  try { candidate = (get as (name: string) => unknown).call(ctx, 'agentPresets') } catch { return undefined }
  const view = candidate as Partial<UpstreamAgentPresets> | undefined
  return typeof view?.list === 'function' && typeof view?.register === 'function'
    ? view as UpstreamAgentPresets
    : undefined
}

/** The tag the cordis YAML dialect uses for an evaluated expression. */
const JS_EXPRESSION_TAG = 'tag:yaml.org,2002:js'

/**
 * The only `!!js` form the bundled presets ship: a platform comparison.
 *
 * The rows read `disabled: !!js process.platform === 'win32'` — one shim per
 * platform, exactly as the official bundle's own presets spell it. js-yaml has
 * no `!!js` type of its own, so without this schema a load of our own asset
 * throws `unknown tag`, and without the allow-list an asset could smuggle an
 * arbitrary expression into a registry that would evaluate it.
 */
const PLATFORM_EXPRESSION = /^process\.platform\s*(===|!==)\s*'([^']+)'$/

const presetSchema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type(JS_EXPRESSION_TAG, {
    kind: 'scalar',
    construct: (source: string): boolean => {
      const match = PLATFORM_EXPRESSION.exec(source.trim())
      if (match === null) throw new Error(`unsupported !!js expression in a bundled preset: ${source.trim()}`)
      return match[1] === '===' ? process.platform === match[2] : process.platform !== match[2]
    },
  }),
])

/**
 * Read one bundled preset as the registry's declaration shape.
 *
 * The asset directory is already exactly what the registry mounts — `preset.yml`
 * carries id/name/description/order, `agent.cordis.yml` carries the child rows —
 * so the same files serve both roster mechanisms.
 * @param presetId - the bundled preset id to read.
 * @returns the declaration, or `undefined` when this layout ships no such preset.
 */
async function readBundledAgentPreset(presetId: string): Promise<AgentPresetDefinition | undefined> {
  const source = presetSourceDirectory(presetId)
  if (source === undefined) return undefined
  const metadata = maybeRecord(yaml.load(await readFile(join(source, 'preset.yml'), 'utf8'), { schema: presetSchema }))
  const loaded = yaml.load(await readFile(join(source, 'agent.cordis.yml'), 'utf8'), { schema: presetSchema })
  if (!Array.isArray(loaded)) return undefined
  const plugins: PresetRow[] = []
  for (const row of loaded) {
    const record = maybeRecord(row)
    // A malformed row is the whole declaration's problem: the registry would
    // reject the list anyway, and half a preset is worse than none.
    if (record === undefined) return undefined
    plugins.push(record)
  }
  const name = metadata?.name
  const description = metadata?.description
  const order = metadata?.order
  return {
    id: presetId,
    ...(typeof name === 'string' && name !== '' ? { name } : {}),
    ...(typeof description === 'string' && description !== '' ? { description } : {}),
    ...(typeof order === 'number' && Number.isFinite(order) ? { order } : {}),
    plugins,
  }
}

/** What one roster install handed back to its caller. */
interface AgentPresetInstall {
  /** Settles when the roster holds every preset this deployment can install. */
  readonly done: Promise<void>
  /** Remove what this install declared; safe to call before {@link done}. */
  readonly release: () => void
}

/**
 * Put both bundled presets on the deployment's roster, by the mechanism the
 * composed harness actually reads.
 *
 * Registry first: a composed `ctx.agentPresets` is the authority, so the plugin
 * declares through it and skips the directory entirely — 0.1.7 scans none. An
 * id the deployment already declares is left alone, because the registry owns
 * that composition and a second declaration would throw.
 *
 * Directory otherwise: an older harness discovers `.agent-presets/` itself.
 *
 * Best-effort throughout. The roster is a convenience — a locked home, a
 * registry that rejects one preset, or no roster at all must never block boot.
 * @param ctx - the context whose composed services decide the mechanism.
 * @returns the in-flight install and a disposer that unregisters it.
 */
export function installFreeCodeGoAgentPresets(ctx: unknown): AgentPresetInstall {
  const disposers: Array<() => Promise<void>> = []
  let released = false
  const keep = (unregister: () => Promise<void>): void => {
    // Registration is async, so it can land after this plugin unloaded: hand the
    // roster row back immediately rather than leaving a preset whose owner is
    // gone and whose rows can never be collected.
    if (released) {
      void Promise.resolve(unregister()).catch(() => {})
      return
    }
    disposers.push(unregister)
  }
  const done = (async () => {
    await loaderSettled(ctx)
    const registry = findUpstreamAgentPresets(ctx)
    if (registry === undefined) {
      await ensureFreeCodeGoAgentPreset()
      return
    }
    let declared: ReadonlySet<string>
    try { declared = new Set((await registry.list()).map(row => row.id)) } catch { declared = new Set() }
    for (const presetId of BUNDLED_PRESET_IDS) {
      // The deployment's own declaration wins; see the module doc.
      if (declared.has(presetId)) continue
      const definition = await readBundledAgentPreset(presetId)
      if (definition === undefined) continue
      try { keep(await registry.register(definition)) } catch { /* the rest of the roster still installs */ }
    }
  })().catch(() => { /* no roster mechanism is not an error */ })
  return {
    done,
    release: () => {
      released = true
      for (const unregister of disposers.splice(0)) void Promise.resolve(unregister()).catch(() => {})
    },
  }
}
