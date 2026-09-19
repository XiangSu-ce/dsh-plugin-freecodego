/**
 * The Session the main view is showing.
 *
 * alpha.2 deleted `SessionListState.current` (and `currentAddress`):
 * "navigation belongs to view owners", so the selected Session now lives in the
 * view owner's own store and no global getter remains. A read of the old field
 * does not fail to compile while a hand-written cast covers it — it is simply
 * always `undefined`, which is how this plugin's model-menu badges, engine
 * seats, and Session-scoped settings panels went quietly blank after the
 * alpha.2 sync.
 *
 * The rule the renderer itself applies (`UiSession#publishMain`) is public on
 * every summary: local retention by the `mainView` reference source. That is
 * the fact read here, so a root-scoped surface asks the same question the
 * renderer answered, instead of a field that no longer exists.
 *
 * A surface rendered inside a Session scope should prefer the `sessionId` its
 * slot `inject` receives as its first argument — that one is exact for the
 * occurrence being rendered; this helper is for surfaces outside any Session
 * scope (settings sections, the shell overlay).
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the `Context.sessions` merge this reads through.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the `mainView` reference-source key out of the retain map.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

/**
 * Find the Session the main view retains, in Host-list order.
 * @param ctx - client root context carrying the Session Controller.
 * @returns the displayed Session id, or undefined while no Session is shown.
 */
export function mainViewSessionId(ctx: ClientContext): string | undefined {
  const list = ctx.sessions.list.getSnapshot()
  for (const id of list.ids) {
    if ((list.byId[id]?.retainedBy.mainView ?? 0) > 0) return id
  }
  return undefined
}
