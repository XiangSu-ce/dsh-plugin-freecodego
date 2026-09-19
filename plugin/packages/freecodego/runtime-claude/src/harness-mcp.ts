import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { redactSecrets } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'

export interface ClaudeBridgeTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/** Host capability snapshot supplied by the FreeCodeGo plugin for one turn. */
export interface ClaudeHarnessCapabilities {
  readonly mcpEnabled: boolean
  readonly skillEnabled: boolean
  readonly mcpTools: readonly ClaudeBridgeTool[]
  /** Safe Harness-native tools such as subagent and child-session controls. */
  readonly harnessTools: readonly ClaudeBridgeTool[]
}

export type ClaudeBridgeCall = (bridge: string, op: string, input: Record<string, unknown>) => Promise<unknown>
export type ClaudeAskUser = (questions: readonly ClaudeQuestion[]) => Promise<unknown>

export interface ClaudeQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly multiSelect?: boolean
  readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
}

/** Capability snapshot with every seam disabled; the unconfigured default. */
export const EMPTY_CLAUDE_CAPABILITIES: ClaudeHarnessCapabilities = {
  mcpEnabled: false,
  skillEnabled: false,
  mcpTools: [],
  harnessTools: [],
}

/**
 * Parse one `host/configure` payload.
 *
 * This is the single reader for `NativeCapabilityConfiguration` on the Claude
 * side. It exists because the two Claude transports used to parse that payload
 * separately and disagreed: the worker read a `hostTools` key of bare strings,
 * which the Host never sends, so its admitted set was permanently empty while
 * the in-process transport read `harnessTools` correctly. Sharing one parser
 * means a field rename fails here once rather than silently in one path.
 *
 * @param value - the raw `host/configure` params.
 * @returns the snapshot, with every unrecognized field disabled.
 */
export function readClaudeCapabilities(value: unknown): ClaudeHarnessCapabilities {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return EMPTY_CLAUDE_CAPABILITIES
  const record = value as Record<string, unknown>
  return {
    mcpEnabled: record.mcpEnabled === true,
    skillEnabled: record.skillEnabled === true,
    mcpTools: readBridgeTools(record.mcpTools, name => name.startsWith('mcp__')),
    harnessTools: readBridgeTools(record.harnessTools, name => /^[A-Za-z0-9_-]{1,96}$/u.test(name)),
  }
}

function readBridgeTools(value: unknown, accept: (name: string) => boolean): readonly ClaudeBridgeTool[] {
  if (!Array.isArray(value)) return []
  const tools: ClaudeBridgeTool[] = []
  const names = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const name = entry.name
    if (typeof name !== 'string' || !accept(name) || names.has(name)) continue
    names.add(name)
    tools.push({
      name,
      description: typeof entry.description === 'string' && entry.description.trim() !== '' ? entry.description : name,
      parameters: record(entry.parameters),
    })
  }
  return tools
}

/** Which Host bridge one advertised Claude tool resolves through. */
export type ClaudeToolKind = 'skill-list' | 'skill-load' | 'harness-tool' | 'mcp-tool' | 'ask-user'

/** One MCP tool this server advertises, before it is bound to the SDK. */
export interface ClaudeToolDeclaration {
  readonly kind: ClaudeToolKind
  readonly name: string
  readonly description: string
  readonly shape: z.ZodRawShape
  /** Harness tool name (`harness-tool`) or MCP tool name (`mcp-tool`) behind this tool. */
  readonly target?: string
}

/**
 * Derive the exact MCP tools this server advertises for one capability snapshot.
 *
 * The inventory is *derived* from the Host's tool schemas rather than restated
 * here. An earlier version of the worker kept a hand-written `HOST_TOOLS` list
 * that duplicated two Harness tool signatures; both copies had drifted (the
 * search tool was offered `query` where the Harness tool declares `queries`, and
 * the LSP tool was offered `filePath` with an operation enum the Harness tool
 * does not have), so every call the list advertised failed schema validation.
 * A derived inventory cannot drift from the tool it names.
 *
 * Names are deduplicated: two Harness tool names can sanitize to one MCP tool
 * name, and the SDK rejects a server that declares the same tool twice.
 *
 * @param capabilities - the Host capability snapshot for this turn.
 * @returns the declarations in advertisement order.
 */
export function claudeToolInventory(capabilities: ClaudeHarnessCapabilities): readonly ClaudeToolDeclaration[] {
  const declarations: ClaudeToolDeclaration[] = []
  const mcpTools = capabilities.mcpEnabled ? capabilities.mcpTools : []
  const mcpNames = new Set(mcpTools.map(spec => spec.name))
  if (capabilities.skillEnabled) {
    declarations.push({
      kind: 'skill-list',
      name: 'freecodego_skill_discover',
      description: 'List the model-invocable Skills enabled in DeepSeek Harness.',
      shape: {},
    })
    declarations.push({
      kind: 'skill-load',
      name: 'freecodego_skill_load',
      description: 'Load the full markdown body of one enabled DeepSeek Harness Skill.',
      shape: { name: z.string().min(1).describe('Exact skill name returned by freecodego_skill_discover.') },
    })
  }
  for (const spec of capabilities.harnessTools) {
    // A configured MCP tool is *also* a Harness tool — that is where the
    // registry keeps it — so it would otherwise be advertised twice: once as
    // `freecodego_harness_mcp__…` and once under its own MCP name. The MCP name
    // wins, because that route is the one the Host audits as an MCP call. The
    // Codex transport excludes the same overlap.
    if (mcpNames.has(spec.name)) continue
    declarations.push({
      kind: 'harness-tool',
      name: claudeHarnessToolName(spec.name),
      description: spec.description,
      shape: zodSchema(spec.parameters),
      target: spec.name,
    })
  }
  for (const spec of mcpTools) {
    declarations.push({
      kind: 'mcp-tool',
      name: spec.name,
      description: spec.description,
      shape: zodSchema(spec.parameters),
      target: spec.name,
    })
  }
  declarations.push({
    kind: 'ask-user',
    name: 'freecodego_ask_user',
    description: 'Ask the Harness user one or more focused questions, wait for the answers, then continue.',
    shape: {
      questions: z.array(z.object({
        id: z.string().min(1).max(80).optional(),
        question: z.string().min(1).max(4_000),
        header: z.string().min(1).max(80).optional(),
        detail: z.string().min(1).max(4_000).optional(),
        multiSelect: z.boolean().optional(),
        options: z.array(z.object({
          label: z.string().min(1).max(200),
          description: z.string().min(1).max(1_000).optional(),
        })).min(1).max(8).optional(),
      })).min(1).max(4),
    },
  })
  return dedupeByAdvertisedName(declarations)
}

function dedupeByAdvertisedName(declarations: readonly ClaudeToolDeclaration[]): readonly ClaudeToolDeclaration[] {
  const seen = new Set<string>()
  return declarations.filter((declaration) => {
    if (seen.has(declaration.name)) return false
    seen.add(declaration.name)
    return true
  })
}

/**
 * Build an SDK-owned in-memory MCP server. It never reads project or user MCP
 * files: every capability is supplied by the Harness plugin for this turn.
 *
 * @param workspaceRoot - the active Harness workspace, sent with skill requests.
 * @param capabilities - the Host capability snapshot for this turn.
 * @param bridge - Host bridge transport for this transport (in-process or worker).
 * @param askUser - Host question transport.
 * @returns the SDK MCP server config to mount as `freecodego-host`.
 */
export function createHarnessMcpServer(
  workspaceRoot: string,
  capabilities: ClaudeHarnessCapabilities,
  bridge: ClaudeBridgeCall,
  askUser: ClaudeAskUser,
  knownValues: readonly (string | undefined)[],
): unknown {
  // Every tool this server can declare returns through here, so the credentials
  // this session handed the Claude Code subprocess are masked once for all of
  // them -- a case added later cannot forget it, which is how the Codex loopback
  // server is written too.
  const runTool = (operation: () => Promise<unknown>) => projectHarnessToolResult(operation, knownValues)
  const tools = claudeToolInventory(capabilities).map(declaration => sdkTool(
    declaration.name,
    declaration.description,
    declaration.shape,
    async (input: Record<string, unknown>) => {
      switch (declaration.kind) {
        case 'skill-list':
          return runTool(() => bridge('skill', 'list', { workspaceRoot }))
        case 'skill-load':
          return runTool(() => bridge('skill', 'load', { name: String(input.name ?? '') }))
        case 'harness-tool':
          return runTool(() => bridge('tool', 'execute', { name: declaration.target, arguments: input }))
        case 'mcp-tool':
          return runTool(() => bridge('mcp', 'execute', { name: declaration.target, arguments: input }))
        case 'ask-user':
          return runTool(() => askUser(normalizeAskUserQuestions(input)))
      }
    },
  ))
  return createSdkMcpServer({ name: CLAUDE_MCP_SERVER_NAME, version: '1.2.0', tools: tools as never[] })
}

/** The in-process SDK MCP server every Claude transport mounts. */
export const CLAUDE_MCP_SERVER_NAME = 'freecodego-host'

/**
 * The advertised MCP tool name for one Harness tool.
 *
 * The Host prompt names Harness tools to the model, and those names have to be
 * the ones the model can actually call — the SDK publishes a server's tools as
 * `mcp__<server>__<tool>`. Both sides derive them here for exactly that reason:
 * a prompt that hand-writes `freecodego_generate_image` names a tool that does
 * not exist under that name, and the model's call fails as unknown.
 *
 * @param toolName - the Harness registry name.
 * @returns the advertised MCP tool name, before the server prefix.
 */
export function claudeHarnessToolName(toolName: string): string {
  return `freecodego_harness_${safeToolName(toolName)}`
}

/**
 * Fully qualify one advertised tool name with the SDK's server prefix.
 * @param advertisedName - a name returned by {@link claudeHarnessToolName} or declared by this server.
 * @returns the name the model must use in a tool call.
 */
export function claudeMcpToolName(advertisedName: string): string {
  return `mcp__${CLAUDE_MCP_SERVER_NAME}__${advertisedName}`
}

/** Claude SDK publishes this exact name for the SDK MCP question tool. */
export const HARNESS_ASK_USER_TOOL_ALIAS = claudeMcpToolName('freecodego_ask_user')

/**
 * Normalize the SDK-validated `freecodego_ask_user` input into Harness questions.
 *
 * The SDK's declared schema already rejects a malformed call before this runs, so
 * this is a shape projection rather than a validator: it assigns the ids the Host
 * requires and drops any field the Harness question type does not declare.
 */
function normalizeAskUserQuestions(input: Record<string, unknown>): readonly ClaudeQuestion[] {
  const entries = Array.isArray(input.questions) ? input.questions : []
  const questions: ClaudeQuestion[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const item = entry as Record<string, unknown>
    if (typeof item.question !== 'string' || item.question.trim() === '') continue
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
        if (typeof option !== 'object' || option === null || Array.isArray(option)) return []
        const value = option as Record<string, unknown>
        return typeof value.label === 'string' && value.label.trim() !== ''
          ? [{ label: value.label, ...(typeof value.description === 'string' ? { description: value.description } : {}) }]
          : []
      })
      : undefined
    questions.push({
      id: typeof item.id === 'string' && item.id.trim() !== '' ? item.id : `question-${questions.length + 1}`,
      question: item.question,
      ...(typeof item.header === 'string' ? { header: item.header } : {}),
      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
      ...(typeof item.multiSelect === 'boolean' ? { multiSelect: item.multiSelect } : {}),
      ...(options === undefined || options.length === 0 ? {} : { options }),
    })
  }
  return questions
}

function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 96) || 'tool'
}

/** One MCP content block this server can return. */
type ClaudeToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }

/**
 * Project one Host tool result into MCP content blocks.
 *
 * The Host answers a bridge call with the tool's *rendered* content — text
 * blocks, and for a media tool an image block. Stringifying that whole value
 * (which is what this used to do) hid it twice over: the model received one JSON
 * document containing a second one, and a generated image arrived as an
 * attachment id inside that text, so neither the model nor the transcript could
 * show it.
 *
 * @param operation - one bridge call.
 * @param knownValues - credentials this session handed to the SDK subprocess,
 * which the shape rules cannot name when the provider chose an opaque format.
 * @returns the content blocks to hand to the model, and whether the tool failed.
 */
export async function projectHarnessToolResult(
  operation: () => Promise<unknown>,
  knownValues: readonly (string | undefined)[],
): Promise<{ readonly content: ClaudeToolContent[]; readonly isError?: boolean }> {
  try {
    const value = await operation()
    return {
      content: projectToolContent(value),
      ...(record(value).isError === true ? { isError: true } : {}),
    }
  } catch (error) {
    // The Host bridge rethrows a failed tool's own error text unmasked
    // (`engine-remotes.ts` dispatches without a catch), and this string is
    // model-visible, so a tool that touched a credential would otherwise print
    // it into the transcript.
    return {
      content: [{ type: 'text', text: `Harness tool failed: ${redactSecrets(error instanceof Error ? error.message : String(error), knownValues)}` }],
      isError: true,
    }
  }
}

/**
 * Map the Host's rendered content blocks onto the blocks an MCP result can carry.
 *
 * An image block is either already inlined as bytes (the Host read the
 * attachment for this transport) or still a storage reference, which becomes the
 * same text fallback the Host renderer uses. Anything unrecognized keeps its JSON
 * so no part of a result is silently dropped.
 *
 * @param value - the Host's `{ content, isError }` tool result.
 * @returns the projected blocks, never empty.
 */
export function projectToolContent(value: unknown): ClaudeToolContent[] {
  const blocks = record(value).content
  const projected = (Array.isArray(blocks) ? blocks : []).flatMap(block => projectToolBlock(block))
  // An empty result reads as a failed call to some models, so a result with no
  // usable block still says what the Host returned.
  return projected.length === 0 ? [{ type: 'text', text: stringify(value) }] : projected
}

function projectToolBlock(block: unknown): ClaudeToolContent[] {
  const candidate = record(block)
  if (candidate.type === 'text' && typeof candidate.text === 'string') return [{ type: 'text', text: candidate.text }]
  if (candidate.type === 'image' && typeof candidate.data === 'string' && typeof candidate.mimeType === 'string') {
    return [{ type: 'image', data: candidate.data, mimeType: candidate.mimeType }]
  }
  const attachment = record(candidate.attachment)
  if (candidate.type === 'image' && typeof attachment.attachmentId === 'string') {
    return [{ type: 'text', text: `Generated image attachment: ${attachment.attachmentId}` }]
  }
  if (candidate.type === 'image') return [{ type: 'text', text: 'Generated image (unavailable to this transport)' }]
  try {
    return [{ type: 'text', text: JSON.stringify(block) }]
  } catch {
    return [{ type: 'text', text: String(block) }]
  }
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null)
}

/** Convert a Host-published JSON schema into SDK-owned Zod parameters. */
function zodSchema(parameters: Record<string, unknown>): z.ZodRawShape {
  const properties = record(parameters.properties)
  const required = new Set(Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === 'string')
    : [])
  return Object.fromEntries(Object.entries(properties).map(([name, schema]) => {
    const node = record(schema)
    // Strip the default here so it is applied after .optional() — an inner
    // ZodDefault would be short-circuited by the ZodOptional wrapper.
    const base = zodForSchema({ ...node, default: undefined })
    const value = required.has(name) ? base : base.optional()
    return [name, node.default === undefined ? value : value.default(node.default)]
  }))
}

function zodForSchema(value: unknown): z.ZodTypeAny {
  const schema = record(value)
  const description = typeof schema.description === 'string' ? schema.description : undefined
  const hasDefault = schema.default !== undefined
  // Apply the property-level annotations (description/default) exactly once, at
  // the outermost node; union branches recurse with them stripped so they are
  // not duplicated per branch.
  const annotated = (base: z.ZodTypeAny): z.ZodTypeAny => {
    const described = description === undefined ? base : base.describe(description)
    return hasDefault ? described.default(schema.default) : described
  }
  const enumValues = Array.isArray(schema.enum) ? schema.enum.filter((item): item is string => typeof item === 'string') : []
  if (enumValues.length > 0) return annotated(z.enum(enumValues as [string, ...string[]]))
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((item): item is string => typeof item === 'string')
    if (types.length === 0) return z.unknown()
    // e.g. ['string', 'null'] -> z.union([z.string(), z.null()])
    if (types.length > 1) {
      const branches = types.map(type => zodForSchema({ ...schema, type, description: undefined, default: undefined }))
      return annotated(z.union(branches as [z.ZodTypeAny, ...z.ZodTypeAny[]]))
    }
    return zodForSchema({ ...schema, type: types[0] })
  }
  switch (schema.type) {
    case 'string': return annotated(z.string())
    case 'number': return annotated(z.number())
    case 'integer': return annotated(z.number().int())
    case 'boolean': return annotated(z.boolean())
    case 'null': return annotated(z.null())
    case 'array': return annotated(z.array(zodForSchema(schema.items)))
    case 'object': return annotated(z.object(zodSchema(schema)).passthrough())
    default: return z.unknown()
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
