/**
 * Which Host bridge one `tools/call` from the Codex App Server resolves to.
 *
 * `tools/list` tells the model which tools exist, but it is not a boundary: the
 * App Server caches the list it was handed, so a call can still name a Skill
 * after a `host/configure` turned Skills off, and a model can also call a name
 * it guessed. Every enabled capability is therefore re-checked here, at the one
 * place each call passes through, exactly as the MCP and Harness-tool routes
 * below already did. The Claude transport gets the same guarantee structurally
 * (its inventory only *declares* a tool when the capability is on, and the SDK
 * dispatches declared tools only); this transport dispatches by name string, so
 * it has to state the rule.
 *
 * @module @deepseek-ai/dsh-freecodego-runtime-codex/harness-mcp-dispatch
 */

/** The capability fields this decision reads, as `host/configure` supplied them. */
export interface HarnessMcpCapabilities {
  readonly mcpEnabled: boolean
  readonly skillEnabled: boolean
  /** Host-registered MCP tools; a name here is called through the MCP bridge. */
  readonly mcpTools: readonly { readonly name: string }[]
  /** Harness-native tools, which include the MCP ones. */
  readonly harnessTools: readonly { readonly name: string }[]
}

/** The Host bridge operation one advertised name resolves to. */
export interface HarnessMcpRoute {
  readonly bridge: 'skill' | 'mcp' | 'tool'
  readonly op: 'list' | 'load' | 'execute'
}

/** The two Skill operations this server advertises when Skills are enabled. */
export const SKILL_DISCOVER_TOOL_NAME = 'freecodego_skill_discover'
/**
 * Advertised tool name for loading one Skill by name.
 */
export const SKILL_LOAD_TOOL_NAME = 'freecodego_skill_load'

/**
 * Resolve one `tools/call` name to the bridge operation that serves it.
 *
 * @param capabilities - the snapshot the advertised tool list was derived from.
 * @param name - the name the engine called.
 * @returns the bridge operation to run.
 * @throws when no enabled capability advertises `name`. A refusal names the tool
 *   and nothing else, so a disabled capability cannot be probed for details.
 */
export function harnessMcpRoute(capabilities: HarnessMcpCapabilities, name: string): HarnessMcpRoute {
  // Skills first: their two names are constants of this transport rather than
  // registry entries, so they are the only route that no membership check would
  // otherwise catch.
  if (name === SKILL_DISCOVER_TOOL_NAME || name === SKILL_LOAD_TOOL_NAME) {
    if (!capabilities.skillEnabled) throw new Error(`Harness tool "${name}" is unavailable`)
    return { bridge: 'skill', op: name === SKILL_DISCOVER_TOOL_NAME ? 'list' : 'load' }
  }
  // A configured MCP tool is *also* a Harness tool — that is where the registry
  // keeps it — and the MCP route is the one the Host audits as an MCP call, so
  // it wins. The advertised list applies the same precedence.
  if (capabilities.mcpEnabled && capabilities.mcpTools.some(tool => tool.name === name)) {
    return { bridge: 'mcp', op: 'execute' }
  }
  if (!capabilities.harnessTools.some(tool => tool.name === name)) throw new Error(`Harness tool "${name}" is unavailable`)
  return { bridge: 'tool', op: 'execute' }
}
