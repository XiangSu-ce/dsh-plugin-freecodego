/**
 * The companion's animation clock.
 *
 * One clock serves every mounted companion. The engine is a pure function of
 * time, so all a clock has to be is a monotonic seconds counter that stops when
 * nothing is watching — there is no per-instance loop and no per-instance timing
 * state to drift apart.
 *
 * Three behaviours are deliberate:
 *
 * - **A hidden document does not advance it.** A backgrounded tab arms nothing,
 *   and because the counter is paused rather than reset, coming back never
 *   produces a time skip: the picture continues from the frame it was on. This is
 *   also why the arbiter is fed this clock rather than the wall clock — dwell time
 *   and animation time stay the same time.
 * - **The first subscriber arms it, the last one disarms it.** A companion that
 *   is not on screen costs nothing.
 * - **A browser without `requestAnimationFrame` still animates.** There is a fixed
 *   interval behind it, so a test or a non-browser realm gets frames too.
 */

/** A monotonic seconds counter with subscribers, shared by every companion. */
export interface CompanionClock {
  /** Seconds accumulated while the clock was armed. Monotonic. */
  nowSeconds: () => number
  /**
   * Observe clock ticks.
   * @param listener - called once per frame while subscribed.
   * @returns an unsubscribe function.
   */
  subscribe: (listener: () => void) => () => void
}

/** Fallback frame interval, used only where `requestAnimationFrame` is absent. */
const FALLBACK_INTERVAL_MS = 1000 / 60

class SharedClock implements CompanionClock {
  private readonly listeners = new Set<() => void>()
  private seconds = 0
  private lastTickMs = 0
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined

  nowSeconds(): number {
    return this.seconds
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.attach()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.detach()
    }
  }

  /** Start following the document and, unless it is hidden, run. */
  private attach(): void {
    addVisibilityListener(this.onVisibilityChange)
    if (!isHidden()) this.arm()
  }

  /** Stop following the document and stop running. */
  private detach(): void {
    removeVisibilityListener(this.onVisibilityChange)
    this.disarm()
  }

  private readonly onVisibilityChange = (): void => {
    if (isHidden()) {
      this.disarm()
      return
    }
    // Sealing the gap here is what keeps the counter honest: the paused interval
    // is not added back, so a resume continues rather than jumps.
    this.lastTickMs = now()
    this.arm()
  }

  /** Start emitting frames. */
  private arm(): void {
    if (this.frame !== 0 || this.timer !== undefined) return
    this.lastTickMs = now()
    if (typeof requestAnimationFrame === 'function') {
      const loop = (): void => {
        this.tick()
        this.frame = requestAnimationFrame(loop)
      }
      this.frame = requestAnimationFrame(loop)
    } else {
      this.timer = setInterval(() => { this.tick() }, FALLBACK_INTERVAL_MS)
    }
  }

  /** Stop emitting frames, whichever way they were being emitted. */
  private disarm(): void {
    if (this.frame !== 0) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame)
      this.frame = 0
    }
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private readonly tick = (): void => {
    const nowMs = now()
    this.seconds += Math.max(0, nowMs - this.lastTickMs) / 1000
    this.lastTickMs = nowMs
    for (const listener of [...this.listeners]) listener()
  }
}

/** @returns monotonic milliseconds, or `Date.now()` where the fine clock is absent. */
function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/** @returns whether the document is currently hidden (false without a document). */
function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function addVisibilityListener(listener: () => void): void {
  if (typeof document === 'undefined') return
  document.addEventListener('visibilitychange', listener)
}

function removeVisibilityListener(listener: () => void): void {
  if (typeof document === 'undefined') return
  document.removeEventListener('visibilitychange', listener)
}

let shared: CompanionClock | undefined

/**
 * The process-wide companion clock, created on first use.
 * @returns the shared clock.
 */
export function companionClock(): CompanionClock {
  shared ??= new SharedClock()
  return shared
}
