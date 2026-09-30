/**
 * Wait until the Loader has settled every currently declared entry.
 *
 * Which peer services exist is only knowable then: `ctx.get` answers `undefined`
 * for a service whose providing entry has not activated yet, and a plugin
 * constructor runs before the rows declared after it. Two modules in this package
 * need that answer before their first read — the agent-preset install, which has
 * to know whether a roster registry is composed at all, and
 * `custom-api-reasoning.ts`, which has to know whether the settings service is up
 * before it looks for the user's third-party routes — so the seam lives here
 * rather than in either of them.
 *
 * The same `ctx.root.loader.await()` seam is what the harness settings service
 * itself uses for its legacy import (`packages/settings/settings/src/index.ts`,
 * `importLegacyDocument`).
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/loader-settled
 */

/**
 * Wait for the composed Loader to settle.
 *
 * A context that exposes no loader — a unit test's fake — settles immediately,
 * and a loader that failed to settle still leaves whatever it managed to
 * activate, so the rejection is swallowed rather than propagated.
 * @param ctx - the cordis context to wait on.
 * @returns a promise that never rejects.
 */
export async function loaderSettled(ctx: unknown): Promise<void> {
  type LoaderOwner = { readonly root?: { readonly loader?: { readonly await?: unknown } } } | undefined
  const loader = (ctx as LoaderOwner)?.root?.loader
  if (typeof loader?.await !== 'function') return
  const settle = loader.await as () => Promise<unknown>
  // A loader that failed to settle still leaves whatever it managed to activate.
  try { await settle.call(loader) } catch { /* best-effort */ }
}
