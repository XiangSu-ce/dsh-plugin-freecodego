/**
 * The stop-time gate is only a check while something can satisfy it.
 *
 * `verify-on-stop.ts` reads a verdict out of its own evidence map, and for as
 * long as nothing wrote one the gate's single reachable outcome was the nudge —
 * a turn that ran `engineering_team_verify` and passed was still told it had
 * established nothing about its change. These tests pin the write side: the tool
 * that produces a verdict is the tool that reports it.
 */

import { describe, expect, it } from 'vitest'
import { registerAdvisorTools, type AgentToolsDeps } from '../src/agent-tools.ts'
import { compileCommandPolicy, type CompiledCommandPolicy } from '../src/command-policy.ts'
import type { FreeCodeGoEngineeringVerificationVerdict } from '../src/types.ts'

/** The tool surface this module registers, captured instead of mounted. */
interface RegisteredTool {
  readonly name: string
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>
}

const COUNCIL_ID = `council_${'a'.repeat(32)}`

function harness(options: {
  readonly verdict?: FreeCodeGoEngineeringVerificationVerdict
  readonly probeCommandPolicy?: (agent: unknown) => CompiledCommandPolicy | undefined
} = {}): {
  readonly tool: RegisteredTool
  readonly recorded: { readonly agentId: string; readonly verdict: FreeCodeGoEngineeringVerificationVerdict }[]
  readonly verifications: () => number
} {
  const registered = new Map<string, RegisteredTool>()
  const recorded: { agentId: string; verdict: FreeCodeGoEngineeringVerificationVerdict }[] = []
  let verifications = 0

  const ctx = {
    get: (name: string) => name === 'tools'
      ? {
          register: (tool: RegisteredTool) => {
            registered.set(tool.name, tool)
            return () => undefined
          },
        }
      : undefined,
    effect: () => undefined,
  }

  const deps = {
    ctx,
    advisor: {},
    engineering: {
      verify: async () => {
        verifications += 1
        return { id: COUNCIL_ID, checkedAt: 1, stages: [], ...(options.verdict === undefined ? {} : { verdict: options.verdict }) }
      },
    },
    engineCouncil: {
      // `verification: undefined` is what makes the tool run a verification
      // rather than replay a recorded one.
      report: () => ({ decision: { state: 'approved' }, verification: undefined }),
      beginVerification: async () => undefined,
      recordVerification: async () => ({ result: { recorded: true } }),
      failVerification: () => undefined,
    },
    agnes: undefined,
    generateImageWithFallback: async () => undefined,
    generateVideoWithFallback: async () => undefined,
    onVerificationRecorded: (agentId: string, verdict: FreeCodeGoEngineeringVerificationVerdict) => {
      recorded.push({ agentId, verdict })
    },
    probeCommandPolicy: options.probeCommandPolicy,
  } as unknown as AgentToolsDeps

  registerAdvisorTools(deps)
  const tool = registered.get('engineering_team_verify')
  if (tool === undefined) throw new Error('engineering_team_verify was not registered')
  return { tool, recorded, verifications: () => verifications }
}

function call(tool: RegisteredTool, args: Record<string, unknown> = {}): Promise<unknown> {
  return tool.execute(
    { id: COUNCIL_ID, ...args },
    { agent: { id: 'agent-1', session: { header: { cwd: process.cwd() } } }, signal: new AbortController().signal },
  )
}

/** One declared probe, in the shape `normalizeEngineeringProbes` accepts. */
const declaredProbe = (command: readonly string[]): Record<string, unknown> => ({
  id: 'probe-1',
  command,
  expectation: 'pass',
  rationale: 'Falsifies the change rather than restating it.',
})

describe('engineering_team_verify reporting', () => {
  it('reports a passing verdict so the stop-time gate can be satisfied', async () => {
    const { tool, recorded } = harness({ verdict: 'verified' })
    await call(tool)
    expect(recorded).toEqual([{ agentId: 'agent-1', verdict: 'verified' }])
  })

  it('reports the other verdicts too, because the nudge reads differently for them', async () => {
    for (const verdict of ['unverified', 'failed'] as const) {
      const { tool, recorded } = harness({ verdict })
      await call(tool)
      expect(recorded).toEqual([{ agentId: 'agent-1', verdict }])
    }
  })

  it('reports a result with no verdict as unverified rather than as a pass', async () => {
    // Results persisted before the verdict existed carry none, and a missing
    // verdict is not a verification.
    const { tool, recorded } = harness()
    await call(tool)
    expect(recorded).toEqual([{ agentId: 'agent-1', verdict: 'unverified' }])
  })

  it('runs a verification before reporting one', async () => {
    const { tool, recorded, verifications } = harness({ verdict: 'verified' })
    await call(tool)
    expect(verifications()).toBe(1)
    expect(recorded).toHaveLength(1)
  })
})

/**
 * The probe argv is a second way to run a command on this machine.
 *
 * The verification tool spawns its probes directly, so no tool guard ever sees
 * them: before these cases the argv was screened by the script patterns alone and
 * `chmod -R 777 .` — which those patterns do not name and the command policy
 * does — ran. The refusal is thrown *before* `beginVerification`, because the run
 * would otherwise be recorded as a verdict for a probe the model can simply fix.
 */
describe('engineering_team_verify probe commands', () => {
  it('refuses a probe the command policy forbids, before the run starts', async () => {
    const { tool, verifications } = harness({ verdict: 'verified', probeCommandPolicy: () => undefined })
    await expect(call(tool, { probes: [declaredProbe(['chmod', '-R', '777', '.'])] }))
      .rejects.toThrow(/command policy forbids/u)
    expect(verifications()).toBe(0)
  })

  it('applies the repository policy to probe argv too', async () => {
    const policy = compileCommandPolicy({
      version: 1,
      rules: [{
        pattern: ['node', '--write-cache'],
        decision: 'forbidden',
        justification: 'The repository refuses it.',
        match: ['node --write-cache'],
        notMatch: ['node --version'],
      }],
    })
    const { tool, verifications } = harness({ verdict: 'verified', probeCommandPolicy: () => policy })
    await expect(call(tool, { probes: [declaredProbe(['node', '--write-cache'])] }))
      .rejects.toThrow(/The repository refuses it/u)
    expect(verifications()).toBe(0)
  })

  it('runs the verification when no probe is refused', async () => {
    const { tool, verifications } = harness({ verdict: 'verified', probeCommandPolicy: () => undefined })
    await call(tool, { probes: [declaredProbe(['node', '--version'])] })
    expect(verifications()).toBe(1)
  })
})
