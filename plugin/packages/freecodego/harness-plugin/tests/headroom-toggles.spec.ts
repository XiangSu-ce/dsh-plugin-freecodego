/**
 * The two opt-in Headroom knobs have to survive a full round trip.
 *
 * Both are real: `foldReads` lifts the byte-exact protection on gated read
 * tools and routes them through the lossless folder, and `headroomDedupEnabled`
 * gates the cross-turn verbatim dedup. But `status()` reported neither, so the
 * settings panel had no way to learn their state — it read the missing fields
 * through a cast, got `undefined`, rendered the switch as off, and every click
 * wrote a value the next read could not observe. The switch looked inert.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { FreeCodeGoHeadroomRuntime, type HeadroomSettings } from '../src/headroom/runtime.ts'

function runtimeWith(initial: HeadroomSettings): { readonly runtime: FreeCodeGoHeadroomRuntime; readonly set: (patch: Partial<HeadroomSettings>) => void } {
  let current = initial
  return {
    runtime: new FreeCodeGoHeadroomRuntime(new Context(), { get: () => current }),
    set: (patch) => { current = { ...current, ...patch } },
  }
}

const base: HeadroomSettings = { headroomEnabled: true, headroomThresholdChars: 1_200 }

describe('headroom toggle round trip', () => {
  it('reports the read-fold switch it is actually reading', () => {
    const off = runtimeWith({ ...base, headroomFoldReads: false })
    expect(off.runtime.status().foldReads).toBe(false)
    const on = runtimeWith({ ...base, headroomFoldReads: true })
    // The runtime consults this flag to lift byte-exact read protection, so a
    // status that omits it describes a different configuration than the one in
    // force.
    expect(on.runtime.status().foldReads).toBe(true)
  })

  it('reports the cross-turn dedup switch, including its default', () => {
    // Dedup defaults on when the key is absent (`!== false`), so the status
    // must say `true` rather than leaving the caller to guess.
    expect(runtimeWith(base).runtime.status().dedupEnabled).toBe(true)
    expect(runtimeWith({ ...base, headroomDedupEnabled: false }).runtime.status().dedupEnabled).toBe(false)
  })

  it('reflects a later settings write without being rebuilt', () => {
    // This is the exact shape of the bug: the panel writes through the remote
    // and re-reads `status()`. If status cannot see the write, the switch
    // appears to do nothing no matter how many times it is clicked.
    const { runtime, set } = runtimeWith({ ...base, headroomFoldReads: false })
    expect(runtime.status().foldReads).toBe(false)
    set({ headroomFoldReads: true })
    expect(runtime.status().foldReads).toBe(true)
    set({ headroomFoldReads: false })
    expect(runtime.status().foldReads).toBe(false)
  })

  it('keeps the enabled flag off when the runtime is disposed, regardless of settings', () => {
    const { runtime } = runtimeWith({ ...base, headroomEnabled: true })
    expect(runtime.status().enabled).toBe(true)
    runtime.dispose()
    expect(runtime.status().enabled).toBe(false)
  })
})
