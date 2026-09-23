/**
 * The one accessor every behaviour read of FreeCodeGo settings goes through.
 *
 * Why one seam
 * ------------
 * `settings.get()` used to be reached directly from the Host plugin and from the
 * runtimes that collaborate with it, which made every call site its own answer to
 * "what is configured". Routing every read through this class keeps that answer in
 * one place: a consumer never has to know which namespace, which scope, or which
 * defaults the value came from, and a rule that has to be added to reads — a
 * guard, a clamp, a migration — is added here rather than at eleven call sites,
 * where missing one is silent.
 *
 * What the seam reads now
 * -----------------------
 * The plugin's own `Config`. The settings service stopped registering a namespace per
 * plugin: an entry's Config *is* its settings document, and every setting in it is a
 * `volatile()` leaf, so a read is one `.get()` per field. The document this class
 * returns is that resolution — {@link FreeCodeGoEngineSettings}, the same shape
 * behaviour, `harness-ui`, and the agent runtimes already share.
 *
 * Which fields count as settings is not a list here. A live reference *is* the
 * distinction the loader uses: marking a field `volatile()` is what makes it editable
 * while the plugin runs, and a field without it is deployment input. Filtering on that
 * keeps the split in one place — {@link Config} — instead of adding a second list to
 * keep in step, and the schema assertion at the plugin class is what makes a settings
 * field that forgot the marker a compile error rather than a silent absence.
 *
 * Why the behaviour read is called `get`
 * --------------------------------------
 * Every collaborating class in this package is typed against a structural
 * `{ get(): T }` shape, which is what the harness surfaces and how every test double in
 * this package is written. Naming the seam `get` therefore lets a consumer accept a
 * resolved document or this policy interchangeably.
 *
 * The deployment-issued layer that used to be folded in here
 * ---------------------------------------------------------
 * `get()` was once the single place a *managed* (deployment-issued) layer was
 * folded into the user's document, able to make a setting stricter and never
 * looser. It was removed rather than disabled: nothing in this plugin, in
 * `freecodego-api`, or in any deployment could produce a managed document, so the
 * fold could only ever return its input. The file it was cached in
 * (`state/freecodego/managed-policy.json`) had no writer, which made the whole
 * tier unreachable rather than merely unused.
 *
 * The seam is kept, and this doc is kept, because that is the part that was worth
 * having: if a second configuration layer is ever introduced, it belongs in
 * {@link FreeCodeGoPolicy.get} and nowhere else, so that no consumer can honour it
 * on one surface and forget it on another. Adding it here touches no call site.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/policy
 */

import { isVolatile } from '@deepseek-ai/cosmokit'
import type { Config, FreeCodeGoEngineSettings } from './plugin-config.ts'

/** A user-originated change: any subset of the document. */
export type FreeCodeGoEngineSettingsPatch = Partial<FreeCodeGoEngineSettings>

/**
 * The read-and-write surface a collaborating runtime is given.
 *
 * Structural on purpose, and deliberately narrower than the Config: a consumer needs
 * the resolved value and a way to persist a user gesture, and nothing else. Handing
 * over the Config itself would also hand over deployment input and a way to watch or
 * replace it, which is how a second reader of the raw document appears.
 */
export interface FreeCodeGoSettingsReadPort {
  /** The settings a behaviour read must use. */
  get(): FreeCodeGoEngineSettings | undefined
}

/** The settings port a behaviour both reads and writes through. */
export interface FreeCodeGoSettingsPort extends FreeCodeGoSettingsReadPort {
  /** Merge a user-originated patch into the user layer. */
  update(patch: object): Promise<void>
}

/**
 * Where a settings write lands.
 *
 * Built by the plugin from the settings service and its own profile entry, so the
 * policy never has to know an entry id, a path, or which service owns persistence. It
 * is optional because a composition without the settings service still runs (headless
 * SDK trees, tests): such a plugin reads its Config and cannot persist a change.
 */
export interface FreeCodeGoSettingsWriter {
  /** Merge a user-originated patch into this plugin's profile entry. */
  update(patch: object): Promise<void>
}

/** The one place behaviour reads and writes the FreeCodeGo settings document. */
export class FreeCodeGoPolicy implements FreeCodeGoSettingsPort {
  /**
   * @param config - the plugin's resolved configuration, or `undefined` when the
   *   composition supplies none (tests, a bare context). The policy is always
   *   constructible so consumers never branch on its presence; they branch on
   *   {@link configured} instead.
   * @param writer - the persistence step, absent when no settings service is mounted.
   */
  constructor(
    private readonly config: Config | undefined,
    private readonly writer: FreeCodeGoSettingsWriter | undefined = undefined,
  ) {}

  /** Whether a configuration was available when the plugin was built. */
  get configured(): boolean {
    return this.config !== undefined
  }

  /**
   * The settings a behaviour read must use.
   *
   * The only read of the Config in this package, which is what makes it the place a
   * second configuration layer would have to be applied — see the module doc.
   * @returns the resolved document, or `undefined` when no configuration exists.
   */
  get(): FreeCodeGoEngineSettings | undefined {
    return this.config === undefined ? undefined : resolveSettings(this.config)
  }

  /**
   * Apply a user-originated change.
   *
   * The write goes to this plugin's own profile entry, through the settings service that
   * owns validation, revisions, and the document write. A composition without that
   * service drops the patch rather than pretending to have stored it: the caller is a
   * user gesture whose failure the Web client reports from the RPC that carried it.
   * @param patch - the fields to merge into the settings document. Typed as the
   *   harness types it (`object`) rather than as a `Partial` of the document,
   *   because a patch is a *merge*: the caller that owns one settings domain
   *   sends its own update shape, and narrowing this to the full document would
   *   force every caller to widen a patch it knows is already valid.
   */
  async update(patch: object): Promise<void> {
    await this.writer?.update(patch)
  }
}

/**
 * The settings document, resolved out of the configuration.
 *
 * Composition keys are skipped because they are not settings: a document that carried
 * them would leak deployment input into anything that spreads it (a settings snapshot
 * for the Web client, for one), and the volatile marker is what distinguishes the two —
 * see the module doc.
 *
 * Why the result needs a cast, and why it is sound
 * ------------------------------------------------
 * The loop builds the document by *key word*, from `Object.entries`, so no compiler can
 * follow it back to {@link FreeCodeGoEngineSettings} — the two are related by the schema,
 * not by the loop. What makes the result total is the schema itself: every setting field
 * is a `volatile()` with a default, so the loader materialises a live reference per field
 * whether the profile patch named it or not, and a field the document is missing is not a
 * state this program can reach. The cast is where that claim lives, and it is one
 * direction only: a *setting* removed from the schema and left in the type is still a
 * compile error at `static Config`, because {@link Config} has to hold it.
 * @param config - the plugin's resolved configuration.
 * @returns every setting, as a plain value.
 */
function resolveSettings(config: Config): FreeCodeGoEngineSettings {
  const document: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(config)) {
    if (!isVolatile(entry)) continue
    document[key] = entry.get()
  }
  return document as unknown as FreeCodeGoEngineSettings
}

/**
 * How far an experimental behaviour is allowed to go.
 *
 * Ordered from silent to live. The order is the rollout's own vocabulary rather
 * than a comparison the code depends on: the memory pipeline maps a stage to a
 * total behaviour table (`memory/rollout.ts`) instead of deriving one stage from
 * another, so inserting a stage in the middle changes what each named stage does
 * only where the table says it does.
 */
export const ROLLOUT_STAGES = ['off', 'record_only', 'shadow', 'active'] as const

/** One named rollout stage, drawn from {@link ROLLOUT_STAGES}. */
export type RolloutStage = (typeof ROLLOUT_STAGES)[number]
