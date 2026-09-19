/**
 * The FreeCodeGo companion: the agent's face, in two seats.
 *
 * The character is one thing. It is shown in the sidebar rail's own brand slot —
 * the same extension point the published official brand uses, registered one rank
 * below it so the rail shows the companion instead of the fallback mark — and in
 * the full-width strip above the composer described in `./bar.tsx`. Both seats
 * draw the same frame for the same session facts, because everything they share
 * lives in `./view.ts`; this file is the rail mark plus the single entry point
 * that seats both.
 *
 * Where the pose comes from is deliberately not this file's business. The vendored
 * engine decides what a state looks like at a time, the arbiter decides which
 * state is called for, and the renderer draws one frame — each testable on its
 * own. The seat owns only its size and its slot.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotMap merge for `sidebar.brand.mark` and the global
// `useSessions` / `useSessionStatus` seats. Both are erased at build.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { CompanionSvg } from './render.tsx'
import { installCompanionBar } from './bar.tsx'
import { en, NS, zh } from './companion-locale.ts'
import { useCompanionObservation, useCompanionView } from './view.ts'

/**
 * The rail mark. Reads the selected session through the global standard props, so
 * it needs no session scope of its own — the rail is outside any session.
 * @param props - the brand slot's runtime props: `size` plus the global hooks.
 */
export function FreeCodeGoCompanion(props: PropsRuntime<'sidebar.brand.mark'>) {
  // alpha.2 dropped `SessionListState.current`, so "which session is open" is
  // read as ownership now: the session the main view retains is the one on
  // screen. Derived the way upstream derives it in its own `ui-layout/DocumentTitle`,
  // so the rail mark and the document title cannot disagree about the visible session.
  const sessionId = props.useSessions(state =>
    Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  const view = useCompanionView(useCompanionObservation(props, sessionId))
  return (
    <CompanionSvg
      frame={view.frame}
      size={props.size}
      state={view.state}
      ink="var(--fcg-text-primary, currentColor)"
      paper="var(--fcg-bg-base, #f9f9f9)"
      className="fcg-companion"
    />
  )
}

/**
 * Seat the companion in the sidebar's brand slot and the composer's entry list.
 *
 * The two registrations are one entry point because they are one character: a
 * build that seated only the mark would leave the label namespace unreachable, and
 * a build that seated only the strip would lose the rail's own mark.
 *
 * `priority: -1` is the sanctioned way to shadow a single slot: the default rank
 * is 0 and the lowest live entry renders, so this wins over the fallback mark
 * without taking anything else away from the surrounding shell. `slots.inject`
 * waits for each slot's declaration rather than assuming an apply order, and every
 * contribution leaves with this plugin's fiber.
 * @param ctx - client root context.
 */
export function installCompanion(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'freecodego-ui: Companion')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({ name: 'sidebar.brand.mark', priority: -1, registrant: 'freecodego-companion' }, FreeCodeGoCompanion))
  installCompanionBar(ctx)
}
