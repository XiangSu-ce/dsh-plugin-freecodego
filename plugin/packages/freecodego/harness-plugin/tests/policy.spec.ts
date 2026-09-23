/**
 * The settings seam, on its own.
 *
 * What is left to test here is small and worth stating plainly, because it is the
 * whole contract: one read that resolves the plugin's own `Config`, one write that goes
 * to the writer built from the settings service and this plugin's profile entry, and an
 * `undefined` answer (rather than a crash) when the composition supplies no configuration
 * at all.
 *
 * The per-call behaviour is the part with a real failure mode: a policy that resolved the
 * Config once and cached the document would serve a user's settings change out of stale
 * memory for the lifetime of the process, and every consumer of this port would inherit
 * that staleness without a single call site being wrong.
 */

import { describe, expect, it } from 'vitest'
import { FreeCodeGoPolicy, type FreeCodeGoSettingsPort, type FreeCodeGoSettingsReadPort, type FreeCodeGoSettingsWriter } from '../src/policy.ts'
import { pluginConfig } from './support/host-services.ts'

/** A settings record the test owns, so a read has something to resolve. */
function documentWithRollout(stage: string): Record<string, unknown> {
  return { memoryRollout: stage }
}

describe('FreeCodeGoPolicy', () => {
  it('resolves the settings document out of the configuration', () => {
    expect(new FreeCodeGoPolicy(pluginConfig(documentWithRollout('active'))).get()?.memoryRollout).toBe('active')
  })

  it('reports an absent configuration rather than failing', () => {
    // The composition may supply no configuration — headless SDK trees and the
    // runtimes' own tests are both real cases — and the policy is still
    // constructible so no consumer has to branch on its existence.
    const policy = new FreeCodeGoPolicy(undefined)
    expect(policy.configured).toBe(false)
    expect(policy.get()).toBeUndefined()
  })

  it('reports a configuration as configured even when it carries no settings', () => {
    const policy = new FreeCodeGoPolicy(pluginConfig())
    expect(policy.configured).toBe(true)
    expect(policy.get()).toStrictEqual({})
  })

  it('leaves deployment input out of the settings document', () => {
    // The Config holds two kinds of field and only one of them is a setting: the
    // volatile marker is the distinction, and a document that carried deployment
    // input would leak it into anything that spreads the document.
    const policy = new FreeCodeGoPolicy(pluginConfig(documentWithRollout('active'), { autoSubagentModelSelection: false }))
    expect(policy.get()).toStrictEqual({ memoryRollout: 'active' })
  })

  it('re-reads on every call, so a settings change is visible without rebuilding', () => {
    // Mutation: resolving the document on the first call and returning it makes this
    // case fail on the second assertion, and no call site would have had to be wrong.
    const stored = documentWithRollout('off')
    const policy = new FreeCodeGoPolicy(pluginConfig(stored))
    expect(policy.get()?.memoryRollout).toBe('off')
    stored.memoryRollout = 'active'
    expect(policy.get()?.memoryRollout).toBe('active')
  })

  it('writes the patch straight to the writer', async () => {
    // The writer is what the plugin builds from the settings service and its own
    // profile entry, so the assertion is that the gesture reaches it unmodified — a
    // policy that swallowed or reshaped a patch would be editing a document nobody
    // reads.
    const patches: object[] = []
    const writer: FreeCodeGoSettingsWriter = { update: async (patch) => { patches.push(patch) } }
    await new FreeCodeGoPolicy(pluginConfig(documentWithRollout('off')), writer).update({ memoryRollout: 'active' })
    expect(patches).toStrictEqual([{ memoryRollout: 'active' }])
  })

  it('accepts a user gesture with no writer instead of throwing', async () => {
    await expect(new FreeCodeGoPolicy(pluginConfig(), undefined).update({ memoryRollout: 'active' })).resolves.toBeUndefined()
  })

  it('accepts a user gesture with no configuration at all instead of throwing', async () => {
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
