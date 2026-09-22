/**
 * The FreeCodeGo companion: the agent's face, in two slots and three injections.
 *
 * The character is one thing. It is shown in the sidebar rail's own brand slot —
 * the same extension point the published official brand uses, registered one rank
 * below it so the rail shows the companion instead of the fallback mark — and in
 * the full-width strip above the composer described in `./bar.tsx`. Both seats
 * draw the same frame for the same session facts, because everything they share
 * lives in `./view.ts`; this file is the rail mark plus the single entry point
 * that seats all of them, including the surfaces the shell gives no slot for
 * (`./running-row.tsx`, `./step-row.tsx`, `./dot-row.tsx`).
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
import { createCompanionActivity, type CompanionSeatInjected } from './activity.ts'
import { CompanionSvg } from './render.tsx'
import { installCompanionBar } from './bar.tsx'
import { installDotFaces } from './dot-row.tsx'
import { installRunningRow } from './running-row.tsx'
import { installStepRows } from './step-row.tsx'
import { en, NS, zh } from './companion-locale.ts'
import { mainViewSessionId } from './signals.ts'
import { useCompanionObservation, useCompanionView } from './view.ts'

/** The rail mark's props: the brand seat's runtime props and the injected feed. */
export type FreeCodeGoCompanionProps = PropsRuntime<'sidebar.brand.mark'> & CompanionSeatInjected

/**
 * The rail mark. Reads the selected session through the global standard props, so
 * it needs no session scope of its own — the rail is outside any session.
 * @param props - the brand slot's runtime props: `size`, the global hooks, and the
 * live feed the plugin injects, which is the same instance every other seat reads.
 */
export function FreeCodeGoCompanion(props: FreeCodeGoCompanionProps) {
  // alpha.2 dropped `SessionListState.current`, so "which session is open" is
  // read as ownership now: the session the main view retains is the one on
  // screen. The rule itself lives in `./signals.ts`, where the transcript's
  // running row reads it too, so the seats cannot disagree about the visible
  // session.
  const sessionId = props.useSessions(mainViewSessionId)
  const view = useCompanionView(useCompanionObservation(props, sessionId, props.activity))
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
 * Seat the companion in the sidebar's brand slot, the composer's entry list, and
 * the transcript's three injected seats — the running turn's status row, the
 * running rows inside a turn, and the shell's own ongoing dot.
 *
 * The registrations are one entry point because they are one character: a build
 * that seated only the mark would leave the label namespace unreachable, a build
 * that seated only the strip would lose the rail's own mark, and the injected
 * seats (`./running-row.tsx`, `./step-row.tsx`, `./dot-row.tsx`) draw the same pose
 * in place of the shell's own loading animations — the sweeps, and the pixel chase
 * of an in-flight mark.
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
  // One feed for the whole plugin, created before the seats register and disposed
  // with this fiber. One instance is what makes the seats agree about a turn's
  // phases: a second one would bind at a different moment and miss the start of a
  // turn the others are already greeting. See `./activity.ts`.
  const activity = createCompanionActivity(ctx.sessions)
  ctx.effect(() => () => { activity.dispose() }, 'freecodego-ui: Companion activity')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({
      name: 'sidebar.brand.mark',
      priority: -1,
      registrant: 'freecodego-companion',
      inject: (): CompanionSeatInjected => ({ activity }),
    }, FreeCodeGoCompanion))
  installCompanionBar(ctx, activity)
  ctx.effect(() => installRunningRow(ctx, activity), 'freecodego-ui: Companion running row')
  ctx.effect(() => installStepRows(ctx, activity), 'freecodego-ui: Companion step rows')
  ctx.effect(() => installDotFaces(ctx, activity), 'freecodego-ui: Companion ongoing dots')
}
