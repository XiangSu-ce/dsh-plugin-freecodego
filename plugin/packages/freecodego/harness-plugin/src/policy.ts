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
 * Why the behaviour read is called `get`
 * --------------------------------------
 * Every collaborating class in this package is typed against a structural
 * `{ get(): T }` shape, because that is how the harness `SettingsScope` surfaces
 * itself and how every test double in this package is written. Naming the seam
 * `get` therefore lets a consumer accept the registered scope or this policy
 * interchangeably.
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

import type { FreeCodeGoEngineSettingsScope } from './managed-catalogs.ts'

/**
 * The resolved settings document.
 *
 * Derived from the registered scope rather than restated: the shape is already
 * described twice (the zod zip in `index.ts` and the intersection in
 * `managed-catalogs.ts`), and a third hand-written copy would be a third thing
 * to keep in step.
 */
export type FreeCodeGoEngineSettings = ReturnType<FreeCodeGoEngineSettingsScope['get']>

/** A user-originated change: any subset of the document. */
export type FreeCodeGoEngineSettingsPatch = Partial<FreeCodeGoEngineSettings>

/**
 * The read-and-write surface a collaborating runtime is given.
 *
 * Structural on purpose, and deliberately narrower than the registered scope:
 * a consumer needs the resolved value and a way to persist a user gesture, and
 * nothing else. Handing over the scope itself would also hand over `watch` and
 * `replace`, which is how a second reader of the raw document appears.
 */
export interface FreeCodeGoSettingsReadPort {
  /** The settings a behaviour read must use. */
  get(): FreeCodeGoEngineSettings | undefined
}

export interface FreeCodeGoSettingsPort extends FreeCodeGoSettingsReadPort {
  /** Merge a user-originated patch into the user layer. */
  update(patch: object): Promise<void>
}

export class FreeCodeGoPolicy implements FreeCodeGoSettingsPort {
  /**
   * @param settings - the registered namespace scope, or `undefined` when the
   *   composition has no settings service (headless SDK trees, tests). The
   *   policy is always constructible so consumers never branch on its presence;
   *   they branch on {@link configured} instead.
   */
  constructor(private readonly settings: FreeCodeGoEngineSettingsScope | undefined) {}

  /** Whether a settings service was available when the plugin was built. */
  get configured(): boolean {
    return this.settings !== undefined
  }

  /**
   * The settings a behaviour read must use.
   *
   * The only read of the registered scope in this package, which is what makes it
   * the place a second configuration layer would have to be applied — see the
   * module doc.
   * @returns the resolved document, or `undefined` when no settings service exists.
   */
  get(): FreeCodeGoEngineSettings | undefined {
    return this.settings?.get()
  }

  /**
   * Apply a user-originated change.
   *
   * Writes go to the registered scope, which is the only layer there is: nothing
   * a user gesture can reach edits a document other than their own.
   * @param patch - the fields to merge into the settings document. Typed as the
   *   harness types it (`object`) rather than as a `Partial` of the document,
   *   because a patch is a *merge*: the caller that owns one settings domain
   *   sends its own update shape, and narrowing this to the full document would
   *   force every caller to widen a patch it knows is already valid.
   */
  async update(patch: object): Promise<void> {
    await this.settings?.update(patch)
  }
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

export type RolloutStage = (typeof ROLLOUT_STAGES)[number]
