/**
 * The settings seam, on its own.
 *
 * What is left to test here is small and worth stating plainly, because it is the
 * whole contract: one read that always asks the registered scope, one write that
 * goes to that same scope, and an `undefined` answer (rather than a crash) when
 * the composition has no settings service at all.
 *
 * The per-call behaviour is the part with a real failure mode: a policy that read
 * the scope once and cached it would serve a user's settings change out of stale
 * memory for the lifetime of the process, and every consumer of this port would
 * inherit that staleness without a single call site being wrong.
 */

import { describe, expect, it } from 'vitest'
import { FreeCodeGoPolicy, type FreeCodeGoEngineSettings, type FreeCodeGoSettingsPort, type FreeCodeGoSettingsReadPort } from '../src/policy.ts'
import type { FreeCodeGoEngineSettingsScope } from '../src/managed-catalogs.ts'

/** A registered scope whose document the test owns. */
function scopeFor(document_: FreeCodeGoEngineSettings | undefined): {
  readonly scope: FreeCodeGoEngineSettingsScope
  readonly patches: object[]
  readonly set: (next: FreeCodeGoEngineSettings | undefined) => void
} {
  const state = { document: document_ }
  const patches: object[] = []
  const scope = {
    get: () => state.document,
    update: async (patch: object) => { patches.push(patch) },
  } as unknown as FreeCodeGoEngineSettingsScope
  return { scope, patches, set: (next) => { state.document = next } }
}

/** A document with one field set, so an assertion can name something. */
function documentWithRollout(stage: 'off' | 'active'): FreeCodeGoEngineSettings {
  return { memoryRollout: stage } as unknown as FreeCodeGoEngineSettings
}

describe('FreeCodeGoPolicy', () => {
  it('reads the resolved document from the registered scope', () => {
    const { scope } = scopeFor(documentWithRollout('active'))
    expect(new FreeCodeGoPolicy(scope).get()?.memoryRollout).toBe('active')
  })

  it('reports an absent settings service rather than failing', () => {
    // The composition may have no settings service — headless SDK trees and the
    // runtimes' own tests are both real cases — and the policy is still
    // constructible so no consumer has to branch on its existence.
    const policy = new FreeCodeGoPolicy(undefined)
    expect(policy.configured).toBe(false)
    expect(policy.get()).toBeUndefined()
  })

  it('reports a settings service as configured even when it answers nothing yet', () => {
    const policy = new FreeCodeGoPolicy(scopeFor(undefined).scope)
    expect(policy.configured).toBe(true)
    expect(policy.get()).toBeUndefined()
  })

  it('re-reads on every call, so a settings change is visible without rebuilding', () => {
    // Mutation: returning a document captured on the first call makes this case
    // fail on the second assertion, and no call site would have had to be wrong.
    const { scope, set } = scopeFor(documentWithRollout('off'))
    const policy = new FreeCodeGoPolicy(scope)
    expect(policy.get()?.memoryRollout).toBe('off')
    set(documentWithRollout('active'))
    expect(policy.get()?.memoryRollout).toBe('active')
  })

  it('writes the patch straight to the registered scope', async () => {
    // There is one layer, so the assertion is that the gesture reaches it
    // unmodified — a policy that swallowed or reshaped a patch would be editing a
    // document nobody reads.
    const { scope, patches } = scopeFor(documentWithRollout('off'))
    await new FreeCodeGoPolicy(scope).update({ memoryRollout: 'active' })
    expect(patches).toStrictEqual([{ memoryRollout: 'active' }])
  })

  it('accepts a user gesture with no settings service instead of throwing', async () => {
    await expect(new FreeCodeGoPolicy(undefined).update({ memoryRollout: 'active' })).resolves.toBeUndefined()
  })

  it('satisfies both ports structurally, which is how consumers are typed', () => {
    // The classes that collaborate with the plugin are typed against `{ get(): T }`
    // rather than against this class, so the compatibility is asserted here rather
    // than assumed: a signature change that breaks it would otherwise surface as
    // eleven separate call sites failing to compile.
    const read: FreeCodeGoSettingsReadPort = new FreeCodeGoPolicy(undefined)
    const readWrite: FreeCodeGoSettingsPort = new FreeCodeGoPolicy(undefined)
    expect(read.get()).toBeUndefined()
    expect(readWrite.get()).toBeUndefined()
  })
})
