/**
 * What the auto-checkpoint seam decides about a call, before it runs.
 *
 * The checkpoint is the one thing that makes a destructive call undoable, so the
 * tests are about the calls it must not skip. It used to be gated on the hunk
 * pass's own pattern — the question *"does this call name its targets in its
 * arguments?"* — which a shell never answers: `sed -i`, a formatter, a codegen
 * script and `rm -rf` carry a `command`, not a `path`. That pattern is right for
 * the hunk pass, where a pre-image needs a path; it is wrong here, where the whole
 * workspace is the capture and no path is needed at all. The gate and the hunk
 * pass sat adjacent on the same seam and shared one expression, and the narrower
 * question won.
 *
 * The store opens only on the reconcile path, which needs a real settings document
 * and a data home. This file is about the gate, so the flag is set and the capture
 * recorded rather than the whole store stood up — a store that cannot open would
 * answer every case here with "no checkpoint" for a reason that has nothing to do
 * with the gate.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { FreeCodeGoEngineeringRegistry } from '../src/engineering.ts'

/** The capture a stubbed store recorded, which is the gate's only observable. */
interface Capture {
  readonly cwd: string
  readonly label?: string
}

/** A registry whose host answers only the tool service, with checkpoints forced open. */
function registry(): {
  readonly engineering: FreeCodeGoEngineeringRegistry
  readonly captured: Capture[]
} {
  const ctx = {
    on: vi.fn(),
    effect: vi.fn(),
    get: (name: string) => (name === 'tools' ? { register: () => ({ dispose: () => undefined }) } : undefined),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as Context
  const engineering = new FreeCodeGoEngineeringRegistry(ctx, undefined)
  const captured: Capture[] = []
  const internals = engineering as unknown as {
    checkpointsAvailable: boolean
    checkpoints: { capture: (input: Capture) => Promise<unknown> }
  }
  internals.checkpointsAvailable = true
  internals.checkpoints.capture = async (input) => { captured.push(input); return undefined }
  return { engineering, captured }
}

describe('the auto-checkpoint seam', () => {
  it('captures before a call that mutates through the shell', async () => {
    // The hole this closes was silent: no pre-image meant `engineering_hunk_revert`
    // had nothing to revert and `engineering_checkpoint_restore` had nothing to go
    // back to, and the call that removed a directory was the one call with no
    // record. Every spelling the deployment can register is walked, because the
    // hole is per-name and `pwsh` is the only shell a Windows session has — the
    // base `cordis.patch.yml` disables `tool-bash` on win32.
    for (const tool of ['bash', 'pwsh', 'shell', 'exec_command', 'run_command', 'exec', 'local_shell']) {
      const { engineering, captured } = registry()
      await engineering.checkpointAutoCapture('.', tool)
      expect(captured.map(entry => entry.label), tool).toEqual([`auto: before ${tool}`])
    }
  })

  it('captures before a file tool, as it always did', async () => {
    const { engineering, captured } = registry()
    await engineering.checkpointAutoCapture('.', 'edit')
    expect(captured).toHaveLength(1)
  })

  it('still reaches an engine spelling this deployment does not register', async () => {
    // The union rather than a replacement: the pattern's reach over the spellings
    // of other engines (`rename`, `insert`, `remove`) is inert when wrong and
    // load-bearing when a child Agent runs under one of them.
    const { engineering, captured } = registry()
    await engineering.checkpointAutoCapture('.', 'rename')
    expect(captured).toHaveLength(1)
  })

  it('captures nothing for a read, and nothing without a workspace', async () => {
    const { engineering, captured } = registry()
    await engineering.checkpointAutoCapture('.', 'read')
    await engineering.checkpointAutoCapture('.', 'grep')
    await engineering.checkpointAutoCapture(undefined, 'bash')
    await engineering.checkpointAutoCapture('  ', 'bash')
    expect(captured).toEqual([])
  })
})
