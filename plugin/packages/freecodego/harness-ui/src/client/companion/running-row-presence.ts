/**
 * Who is drawing the character right now: the strip above the composer, or the
 * running turn's own status row in the transcript.
 *
 * The two surfaces show one character, and one at a time is the point: while a
 * turn runs, the reader's eyes are at the end of the transcript, where the shell's
 * own loading row used to be, and a second copy of the same face above the composer
 * would only be a duplicate of what is already on screen. So the row *claims* the
 * drawing for as long as it is mounted, and the strip yields it.
 *
 * A claim is owned by a mount, not by a flag that someone has to remember to clear:
 * `claimRunningRowFace` returns the release for exactly that claim, and the strip
 * yields while any claim is outstanding. That is also why the count is a count —
 * a turn that ends and another that starts in the same frame leaves one live claim
 * either way, and no ordering of the two can drop the character entirely.
 *
 * What does *not* move: the strip's own row. It keeps its lane height and its words
 * for the whole session (see `./bar.tsx`), so yielding the drawing cannot shift the
 * composer stack above which it sits.
 */
import { useSyncExternalStore } from 'react'

/** Outstanding claims, one per mounted transcript row. */
let claims = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * Whether the transcript's running row is drawing the character.
 * @returns true while at least one such row is mounted.
 */
export function runningRowHasFace(): boolean {
  return claims > 0
}

/**
 * Take the drawing for one mounted row.
 * @returns the release for this claim; calling it twice is harmless.
 */
export function claimRunningRowFace(): () => void {
  claims += 1
  notify()
  let live = true
  return () => {
    if (!live) return
    live = false
    claims -= 1
    notify()
  }
}

/**
 * Follow who is drawing the character.
 * @returns true while the transcript's running row has it, so a seat can yield.
 */
export function useRunningRowFace(): boolean {
  return useSyncExternalStore(
    (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    runningRowHasFace,
  )
}
