/**
 * The fixed slack the plugin actually holds back, measured through the plugin.
 *
 * `context-budget.spec.ts` pins the arithmetic on a report handed a buffer. This
 * file pins the two decisions that arithmetic cannot make for itself:
 *
 * 1. **The number comes from the window.** The plugin passes
 *    `contextBufferForWindow(contextWindow)`, not the reference constant: a 32k
 *    window holds 5,000 back, a 128k one holds 20,000, and the band is classified
 *    against the room that is left rather than the raw window.
 * 2. **An unadvertised window holds nothing back.** A threshold survives without a
 *    denominator because it still judges a payload; slack does not, so the plugin
 *    passes 0 and the report says `unknown` — rather than reporting a reserve it
 *    could not have applied.
 *
 * Both are wiring, not arithmetic, which is why they are read from the plugin's own
 * measurement path (`measureContextBudget`) with a token meter and a session that
 * advertise a window, instead of from the report factory.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { CONTEXT_BUFFER_TOKENS } from '../src/context-budget.ts'
import { pluginConfig, provideHostService, provideHostServiceAs, type AgentEnginesFace } from './support/host-services.ts'

/** The report fields these cases read. */
interface BudgetReport {
  readonly band: string
  readonly contextWindow?: number
  readonly remainingTokens?: number
  readonly responseReserve: number
  readonly buffer: number
}

/** The token meter as the plugin probes it: one measurement, no session storage. */
type TokenMeterFace = {
  measure(session: unknown): { readonly totalTokens: number; readonly baseline: { readonly kind: string } }
}

let suiteRoot = ''
const previousHome = process.env.DSH_HOME
let measure!: (agent: unknown) => BudgetReport | undefined
let totalTokens = 0
let dispose!: () => Promise<void>

/** The two services the constructor reads, as `plugin.spec.ts` provides them. */
function AgentEngineRegistry(ctx: Context): void {
  provideHostServiceAs<AgentEnginesFace>(ctx, 'agentEngines', { setAvailability: () => undefined })
  provideHostService(ctx, 'agents', { list: () => [], get: () => undefined })
}

beforeAll(async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'freecodego-budget-buffer-'))
  suiteRoot = sandbox
  process.env.DSH_HOME = sandbox
  await mkdir(join(sandbox, 'profiles', 'default'), { recursive: true })
  const ctx = new Context()
  await ctx.plugin(AgentEngineRegistry)
  // Provider usage rather than the meter's heuristic price, so the fragments below
  // are not the estimated case: this file is about held-back room.
  provideHostServiceAs<TokenMeterFace>(ctx, 'tokenMeter', { measure: () => ({ totalTokens, baseline: { kind: 'usage' } }) })
  const plugin = new FreeCodeGoHarnessPlugin(ctx, pluginConfig({})) as unknown as {
    measureContextBudget: (agent: unknown) => BudgetReport | undefined
  }
  measure = agent => plugin.measureContextBudget(agent)
  dispose = async () => { await ctx.fiber.dispose() }
})

afterAll(async () => {
  await dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(suiteRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
})

/** An agent whose session advertises `contextWindow`, and whose turn reserved `maxTokens`. */
const agentOn = (contextWindow: number | undefined, maxTokens?: number): unknown => ({
  session: { requestContext: () => (contextWindow === undefined ? undefined : { contextWindow }) },
  ctx: { agentOptions: maxTokens === undefined ? {} : { maxTokens } },
})

describe('the fixed slack the plugin holds back', () => {
  it('scales the reference buffer to the window in use', () => {
    // Small enough that both windows have room for their own buffer: the point
    // here is the figure itself, and the clamping order is the case below.
    totalTokens = 1_000
    const at128k = measure(agentOn(128_000))
    expect(at128k?.buffer).toBe(CONTEXT_BUFFER_TOKENS)
    expect(at128k?.contextWindow).toBe(128_000)

    const at32k = measure(agentOn(32_000))
    // A quarter of the reference figure, because the share of the window is what
    // stays constant — the error a flat constant makes on a small model.
    expect(at32k?.buffer).toBe(5_000)
  })

  it('classifies the band against the room left after both claims', () => {
    totalTokens = 80_000
    // 80k of a 100k window with no slack is "critical". Holding 20k back (the
    // reference figure for a 128k window, clamped down to this one) leaves no room
    // at all, and the band has to say so rather than reporting the raw fraction.
    expect(measure(agentOn(100_000, 0))?.band).toBe('critical')
    const held = measure(agentOn(100_000, 5_000))
    expect(held?.band).toBe('over')
    // 100k − 80k used − 5k reply − 15k of the 20k held: the reply reserve is met
    // first and the slack is what gives way.
    expect(held?.responseReserve).toBe(5_000)
    expect(held?.buffer).toBe(15_000)
    expect(held?.remainingTokens).toBe(0)
  })

  it('holds nothing back when no window is advertised', () => {
    totalTokens = 40_000
    const unknown = measure(agentOn(undefined))
    expect(unknown?.band).toBe('unknown')
    expect(unknown?.contextWindow).toBeUndefined()
    expect(unknown?.remainingTokens).toBeUndefined()
    // A reserve nobody could subtract from a denominator would be a claim rather
    // than a reserve, so the plugin passes none.
    expect(unknown?.buffer).toBe(0)
    expect(unknown?.responseReserve).toBe(0)
  })
})
