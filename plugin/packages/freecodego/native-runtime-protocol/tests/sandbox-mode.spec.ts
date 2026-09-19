import { describe, expect, it } from 'vitest'
import { NATIVE_SANDBOX_MODES, effectiveSandboxMode, isNativeSandboxMode } from '../src/index.ts'

describe('native sandbox mode vocabulary', () => {
  it('lists the Harness sandbox modes narrowest first', () => {
    expect(NATIVE_SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('accepts exactly the three modes and drops everything else', () => {
    for (const mode of NATIVE_SANDBOX_MODES) expect(isNativeSandboxMode(mode)).toBe(true)
    // A value that arrived as JSON is `unknown`: the parser must not be talked
    // into a mode by case, whitespace, a near miss, or a non-string.
    for (const value of ['READ-ONLY', ' read-only', 'read_only', 'full-access', 'readonly', '', 0, 1, true, null, undefined, {}, ['read-only']]) {
      expect(isNativeSandboxMode(value)).toBe(false)
    }
  })
})

describe('effective sandbox mode', () => {
  it('carries the resolved session mode when nothing narrows it', () => {
    expect(effectiveSandboxMode({ sandboxMode: 'workspace-write' })).toBe('workspace-write')
    expect(effectiveSandboxMode({ sandboxMode: 'danger-full-access' })).toBe('danger-full-access')
    expect(effectiveSandboxMode({ sandboxMode: 'read-only' })).toBe('read-only')
  })

  it('resolves a disagreement toward the floor, never toward wider access', () => {
    // A council child declares `readOnly` and logs its own Harness mode; the two
    // can disagree in exactly this direction, and the floor has to win.
    expect(effectiveSandboxMode({ readOnly: true, sandboxMode: 'danger-full-access' })).toBe('read-only')
    expect(effectiveSandboxMode({ readOnly: true, sandboxMode: 'workspace-write' })).toBe('read-only')
    expect(effectiveSandboxMode({ readOnly: true })).toBe('read-only')
  })

  it('treats a non-true floor as no floor rather than as a mode', () => {
    // `readOnly` is wire data: only the boolean true narrows anything, and a
    // `false` must not be read as "danger-full-access".
    expect(effectiveSandboxMode({ readOnly: false, sandboxMode: 'workspace-write' })).toBe('workspace-write')
    expect(effectiveSandboxMode({ readOnly: 'true', sandboxMode: 'workspace-write' })).toBe('workspace-write')
    expect(effectiveSandboxMode({ readOnly: undefined, sandboxMode: 'workspace-write' })).toBe('workspace-write')
  })

  it('reports no policy rather than inventing one', () => {
    // `undefined` is load-bearing: the runtimes leave the engine's own default in
    // place, so a value this protocol cannot read must not become a restriction
    // the user never chose.
    expect(effectiveSandboxMode({})).toBeUndefined()
    expect(effectiveSandboxMode({ readOnly: false })).toBeUndefined()
    expect(effectiveSandboxMode({ sandboxMode: 'read_only' })).toBeUndefined()
    expect(effectiveSandboxMode({ sandboxMode: 7 })).toBeUndefined()
  })
})
