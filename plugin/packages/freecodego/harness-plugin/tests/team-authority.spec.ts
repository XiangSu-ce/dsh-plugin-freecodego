/**
 * Which module owns the team once the Harness ships one too.
 *
 * The property under test is a *count*: with the Harness's team runtime composed,
 * the plugin must register its two enhancement tools and none of the six the
 * Harness supersedes; without it, all eight. Two live team surfaces is the defect
 * — a member started through one is invisible to the other's roster, mailbox, and
 * board, and neither surface raises anything to say so.
 */

import { describe, expect, it } from 'vitest'
import {
  HARNESS_TEAM_OWNED_TOOLS,
  PLUGIN_TEAM_ENHANCEMENT_TOOLS,
  findUpstreamTeams,
} from '../src/team/authority.ts'
import { FreeCodeGoTeamRuntime } from '../src/team/tools.ts'

interface RegisteredTool {
  readonly name: string
}

const teamService = {
  membership: () => ({}),
  listMembers: () => [],
  listTasks: () => [],
}

/** A ctx double covering only what the team runtime reads. */
function hostDouble(input: { readonly tools: RegisteredTool[]; readonly teams?: boolean }) {
  return {
    logger: { debug: () => undefined },
    on: () => undefined,
    effect: (factory: () => (() => void) | undefined) => factory(),
    get: (name: string) => {
      if (name === 'tools') {
        return {
          register: (tool: unknown) => {
            input.tools.push(tool as RegisteredTool)
            return () => undefined
          },
          schemas: () => [],
        }
      }
      if (name === 'agentTeams' && input.teams === true) return teamService
      return undefined
    },
  }
}

function start(input: { readonly teams?: boolean }): readonly string[] {
  const tools: RegisteredTool[] = []
  const runtime = new FreeCodeGoTeamRuntime({
    // The double implements exactly the surface `start()` and `status()` touch.
    // `exactOptionalPropertyTypes`: the double's `teams` is optional, so an
    // absent request must omit the key rather than carry `undefined`.
    ctx: hostDouble({ tools, ...input.teams === undefined ? {} : { teams: input.teams } }) as never,
    settings: { get: () => ({ engineeringEnabled: true, engineeringTeamEnabled: true }) },
    defaultAgentOptions: () => ({ engine: 'deepseek', provider: 'freecodego' }),
  })
  runtime.start()
  runtime.dispose()
  return tools.map(tool => tool.name)
}

describe('findUpstreamTeams', () => {
  it('finds the service behind a cordis context', () => {
    expect(findUpstreamTeams({ get: (name: string) => (name === 'agentTeams' ? teamService : undefined) })).toBe(teamService)
  })

  it('refuses a partial or unreachable service rather than guessing', () => {
    // A service with only one of the three methods is not this service, and a
    // composition with none of them has to fall back to the plugin's own team.
    expect(findUpstreamTeams(undefined)).toBeUndefined()
    expect(findUpstreamTeams({})).toBeUndefined()
    expect(findUpstreamTeams({ get: () => { throw new Error('realm is closing') } })).toBeUndefined()
    expect(findUpstreamTeams({ get: () => ({ membership: () => ({}) }) })).toBeUndefined()
  })
})

describe('team authority', () => {
  it('registers every tool when the Harness mounts no team runtime', () => {
    const names = start({})
    expect(names).toEqual(expect.arrayContaining([...HARNESS_TEAM_OWNED_TOOLS, ...PLUGIN_TEAM_ENHANCEMENT_TOOLS]))
  })

  it('registers only the enhancements when the Harness owns the team', () => {
    const names = start({ teams: true })
    for (const superseded of HARNESS_TEAM_OWNED_TOOLS) expect(names, superseded).not.toContain(superseded)
    for (const kept of PLUGIN_TEAM_ENHANCEMENT_TOOLS) expect(names, kept).toContain(kept)
  })

  it('reports which tools stood down, as data', () => {
    const withHarness = new FreeCodeGoTeamRuntime({
      ctx: hostDouble({ tools: [], teams: true }) as never,
      settings: { get: () => ({ engineeringEnabled: true, engineeringTeamEnabled: true }) },
      defaultAgentOptions: () => ({ engine: 'deepseek', provider: 'freecodego' }),
    })
    expect(withHarness.status().authority).toBe('harness')
    expect(withHarness.status().supersededTools).toEqual([...HARNESS_TEAM_OWNED_TOOLS])

    const standalone = new FreeCodeGoTeamRuntime({
      ctx: hostDouble({ tools: [] }) as never,
      settings: { get: () => ({ engineeringEnabled: true, engineeringTeamEnabled: true }) },
      defaultAgentOptions: () => ({ engine: 'deepseek', provider: 'freecodego' }),
    })
    expect(standalone.status().authority).toBe('plugin')
    expect(standalone.status().supersededTools).toEqual([])
  })

  it('keeps the two tool sets disjoint and non-empty', () => {
    // A name in both lists would mean "superseded by the Harness" and "kept
    // beside it" at once, which is the ambiguity these lists exist to remove.
    expect(PLUGIN_TEAM_ENHANCEMENT_TOOLS.length).toBeGreaterThan(0)
    expect(HARNESS_TEAM_OWNED_TOOLS.length).toBeGreaterThan(0)
    for (const name of PLUGIN_TEAM_ENHANCEMENT_TOOLS) expect(HARNESS_TEAM_OWNED_TOOLS).not.toContain(name)
  })
})
