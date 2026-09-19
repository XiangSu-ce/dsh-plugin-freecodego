import { describe, expect, it } from 'vitest'
import { harnessMcpRoute, SKILL_DISCOVER_TOOL_NAME, SKILL_LOAD_TOOL_NAME } from '../src/harness-mcp-dispatch.ts'

/**
 * These pin the *dispatch* rule rather than the advertised list.
 *
 * `tools/list` is what the model is shown, and this server already withholds the
 * Skill names when Skills are off — but the call path takes a bare name, so a
 * name remembered from an earlier turn (or guessed) used to reach the Host
 * bridge regardless. These cases fail if the dispatch stops re-checking the
 * capability that advertised the name.
 */

const HARNESS_TOOL = { name: 'web_search' }
const MCP_TOOL = { name: 'mcp__docs__search' }

const allOff = { mcpEnabled: false, skillEnabled: false, mcpTools: [], harnessTools: [] }

describe('Codex Harness MCP dispatch', () => {
  it('refuses both Skill names while Skills are disabled', () => {
    // The Host's `skill/load` refuses a disabled configuration itself, but
    // `skill/list` does not: without this gate a disabled capability still
    // answered the inventory question.
    expect(() => harnessMcpRoute(allOff, SKILL_DISCOVER_TOOL_NAME)).toThrow(`Harness tool "${SKILL_DISCOVER_TOOL_NAME}" is unavailable`)
    expect(() => harnessMcpRoute(allOff, SKILL_LOAD_TOOL_NAME)).toThrow(`Harness tool "${SKILL_LOAD_TOOL_NAME}" is unavailable`)
  })

  it('routes the two Skill names to their bridge operations while enabled', () => {
    const skillsOn = { ...allOff, skillEnabled: true }
    expect(harnessMcpRoute(skillsOn, SKILL_DISCOVER_TOOL_NAME)).toEqual({ bridge: 'skill', op: 'list' })
    expect(harnessMcpRoute(skillsOn, SKILL_LOAD_TOOL_NAME)).toEqual({ bridge: 'skill', op: 'load' })
  })

  it('refuses Skills that are enabled but not advertised to this snapshot', () => {
    // Enabled is necessary and not sufficient: the name still has to be one this
    // transport offers, so the refusal is the same sentence for every unknown
    // name rather than a second message that hints at the capability.
    const skillsOn = { ...allOff, skillEnabled: true }
    expect(() => harnessMcpRoute(skillsOn, 'freecodego_skill_reset')).toThrow('Harness tool "freecodego_skill_reset" is unavailable')
  })

  it('prefers the MCP route for a name the MCP inventory carries', () => {
    // A configured MCP tool is also a Harness tool; the MCP route is the one the
    // Host audits as an MCP call, which is why it wins over the tool bridge.
    const both = { mcpEnabled: true, skillEnabled: false, mcpTools: [MCP_TOOL], harnessTools: [HARNESS_TOOL, MCP_TOOL] }
    expect(harnessMcpRoute(both, MCP_TOOL.name)).toEqual({ bridge: 'mcp', op: 'execute' })
  })

  it('keeps an MCP name on the Harness route while only the MCP bridge is off', () => {
    // Turning the MCP bridge off does not unmount the tool: the name is still in
    // the Harness registry, and whether it may run is the Host's decision. This
    // transport only has to route it to the bridge that can make it.
    const mcpBridgeOff = { mcpEnabled: false, skillEnabled: false, mcpTools: [MCP_TOOL], harnessTools: [HARNESS_TOOL, MCP_TOOL] }
    expect(harnessMcpRoute(mcpBridgeOff, MCP_TOOL.name)).toEqual({ bridge: 'tool', op: 'execute' })
  })

  it('routes a Harness tool and refuses a name no capability advertises', () => {
    const tools = { ...allOff, harnessTools: [HARNESS_TOOL] }
    expect(harnessMcpRoute(tools, HARNESS_TOOL.name)).toEqual({ bridge: 'tool', op: 'execute' })
    expect(() => harnessMcpRoute(tools, 'bash')).toThrow('Harness tool "bash" is unavailable')
  })
})
