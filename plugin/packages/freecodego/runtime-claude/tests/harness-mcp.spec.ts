/**
 * The Claude MCP surface — one builder for both Claude transports.
 *
 * The regression this pins runs the *opposite* way from the usual one. The
 * in-process transport derives its tools from the Host payload. The worker
 * sidecar kept a private, hand-written list of two Host tools instead, and both
 * entries had drifted from the Harness tools they named: it offered `query`
 * where `web_search` declares `queries`, using a `prompt` fallback, and offered
 * `filePath` with an operation enum (`documentSymbol`) that `lsp` does not have.
 * So once the worked bridge admitted them at all, every advertised call failed
 * schema validation — a restated signature is a signature that can be wrong.
 *
 * The inventory is therefore asserted against the *Harness tool's own* declared
 * parameters: the case below feeds the real `web_search` schema and requires the
 * advertised tool to accept exactly that and nothing that was invented here.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  claudeToolInventory,
  EMPTY_CLAUDE_CAPABILITIES,
  HARNESS_ASK_USER_TOOL_ALIAS,
  projectHarnessToolResult,
  projectToolContent,
  readClaudeCapabilities,
} from '../src/harness-mcp.ts'

/** One `host/configure` payload, shaped like the Host's `NativeCapabilityConfiguration`. */
const configure = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  mcpEnabled: false,
  skillEnabled: false,
  skillRoots: [],
  mcpTools: [],
  harnessTools: [],
  ...overrides,
})

/** The `web_search` parameters exactly as the Harness registry publishes them. */
const WEB_SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    queries: { type: 'array', items: { type: 'string' }, description: 'Required search queries.' },
  },
  required: ['queries'],
}

const harnessTool = (name: string, parameters: Record<string, unknown> = { type: 'object', properties: {} }) =>
  ({ name, description: `the ${name} tool`, parameters })

/** The declared Zod shape for one advertised tool, or `undefined` when absent. */
const shapeOf = (declarations: ReturnType<typeof claudeToolInventory>, name: string) =>
  declarations.find(declaration => declaration.name === name)?.shape

describe('readClaudeCapabilities', () => {
  it('reads the Harness tool inventory the Host actually sends', () => {
    const capabilities = readClaudeCapabilities(configure({
      harnessTools: [harnessTool('web_search', WEB_SEARCH_PARAMETERS), harnessTool('lsp'), harnessTool('read')],
    }))
    expect(capabilities.harnessTools.map(tool => tool.name)).toEqual(['web_search', 'lsp', 'read'])
    // The parameters travel with the name: without them there is nothing to
    // derive a tool signature from, and only a restated one would be possible.
    expect(capabilities.harnessTools[0]?.parameters).toEqual(WEB_SEARCH_PARAMETERS)
  })

  it('does not admit the shapes that used to be assumed', () => {
    // A `hostTools` key is not part of the payload, and its elements are not
    // bare strings. Accepting either re-creates the silently empty set.
    expect(readClaudeCapabilities({ hostTools: ['web_search'] }).harnessTools).toEqual([])
    expect(readClaudeCapabilities(configure({ harnessTools: ['web_search'] })).harnessTools).toEqual([])
    // An MCP tool without the transport prefix is not addressable through the
    // MCP bridge, so it is not advertised either.
    expect(readClaudeCapabilities(configure({ mcpTools: [harnessTool('read')] })).mcpTools).toEqual([])
  })

  it('disables every seam for a payload that is not an object', () => {
    for (const value of [undefined, null, 'x', 42, [], configure()]) {
      expect(readClaudeCapabilities(value)).toEqual(EMPTY_CLAUDE_CAPABILITIES)
    }
  })

  it('keeps the enable flags apart from the inventory', () => {
    const capabilities = readClaudeCapabilities(configure({
      mcpEnabled: 'yes',
      skillEnabled: true,
      harnessTools: [harnessTool('read')],
    }))
    // A truthy non-boolean flag is not consent: only `true` enables a seam.
    expect(capabilities.mcpEnabled).toBe(false)
    expect(capabilities.skillEnabled).toBe(true)
  })

  it('drops a malformed or duplicate entry instead of advertising it twice', () => {
    const capabilities = readClaudeCapabilities(configure({
      harnessTools: [
        harnessTool('read'),
        harnessTool('read'),
        { name: 'not a tool name' },
        { name: '' },
        { description: 'no name at all' },
        null,
        'read',
      ],
      mcpTools: [harnessTool('mcp__a'), harnessTool('mcp__a')],
    }))
    expect(capabilities.harnessTools.map(tool => tool.name)).toEqual(['read'])
    expect(capabilities.mcpTools.map(tool => tool.name)).toEqual(['mcp__a'])
  })
})

describe('claudeToolInventory', () => {
  it("advertises the Harness tool's own parameters, not a restated signature", () => {
    const declarations = claudeToolInventory(readClaudeCapabilities(configure({
      harnessTools: [harnessTool('web_search', WEB_SEARCH_PARAMETERS)],
    })))
    const declaration = declarations.find(candidate => candidate.name === 'freecodego_harness_web_search')
    expect(declaration?.kind).toBe('harness-tool')
    // The bridge target is the Harness tool name, never the advertised one.
    expect(declaration?.target).toBe('web_search')
    const schema = z.object(declaration!.shape).strict()
    expect(schema.safeParse({ queries: ['vitest fake timers'] }).success).toBe(true)
    // Each of these is what the removed hand-written copy declared instead.
    for (const drifted of [{ query: 'x' }, { queries: ['x'], workspaceRoot: '/w' }, { prompt: 'x' }]) {
      expect(schema.safeParse(drifted).success, JSON.stringify(drifted)).toBe(false)
    }
  })

  it('never advertises the retired hand-written Host tool names', () => {
    const declarations = claudeToolInventory(readClaudeCapabilities(configure({
      harnessTools: [harnessTool('web_search', WEB_SEARCH_PARAMETERS), harnessTool('lsp')],
    })))
    const names = declarations.map(declaration => declaration.name)
    for (const retired of [
      'freecodego_web_search',
      'freecodego_lsp',
      'freecodego_worktree_enter',
      'freecodego_worktree_exit',
      'freecodego_cron_create',
      'freecodego_cron_list',
      'freecodego_agent_config_read',
      'freecodego_agent_config_write',
    ]) {
      expect(names, retired).not.toContain(retired)
    }
  })

  it('gates Skills and MCP connections on their own enable flags', () => {
    const off = claudeToolInventory(EMPTY_CLAUDE_CAPABILITIES).map(declaration => declaration.name)
    expect(off).toEqual(['freecodego_ask_user'])

    const on = claudeToolInventory(readClaudeCapabilities(configure({
      mcpEnabled: true,
      skillEnabled: true,
      mcpTools: [harnessTool('mcp__example__ping')],
    })))
    const names = on.map(declaration => declaration.name)
    expect(names).toContain('freecodego_skill_discover')
    expect(names).toContain('mcp__example__ping')
    // `freecodego_skill_load` needs a name to load, and the SDK enforces it.
    const load = z.object(shapeOf(on, 'freecodego_skill_load')!).strict()
    expect(load.safeParse({}).success).toBe(false)
    expect(load.safeParse({ name: 'my-skill' }).success).toBe(true)
  })

  it('deduplicates two Harness tools that sanitize to one advertised name', () => {
    // `a-b` and `a_b` are both valid Harness names, and both sanitize to `a_b`
    // because `-` is not a character the SDK accepts in an MCP tool name. The
    // SDK rejects a server that declares one tool twice, so the second must go.
    const declarations = claudeToolInventory(readClaudeCapabilities(configure({
      harnessTools: [harnessTool('a-b'), harnessTool('a_b')],
    })))
    const names = declarations.map(declaration => declaration.name)
    expect(names.filter(name => name === 'freecodego_harness_a_b')).toHaveLength(1)
    // The first declaration wins, and it still names its own bridge target.
    expect(declarations.find(declaration => declaration.name === 'freecodego_harness_a_b')?.target).toBe('a-b')
  })

  it('does not advertise a configured MCP tool under two names', () => {
    // A configured MCP tool also sits in the Harness registry, which is the
    // only reason it is in `harnessTools`. Advertising both routes duplicates
    // the schema in every request and splits its calls across two names.
    const declarations = claudeToolInventory(readClaudeCapabilities(configure({
      mcpEnabled: true,
      mcpTools: [harnessTool('mcp__example__ping', { type: 'object', properties: { text: { type: 'string' } } })],
      harnessTools: [
        harnessTool('mcp__example__ping', { type: 'object', properties: { text: { type: 'string' } } }),
        harnessTool('read'),
      ],
    })))
    const names = declarations.map(declaration => declaration.name)
    expect(names).toContain('mcp__example__ping')
    expect(names).not.toContain('freecodego_harness_mcp__example__ping')
    // The non-MCP Harness tool is unaffected.
    expect(names).toContain('freecodego_harness_read')
  })

  it('always advertises the question tool under the alias the SDK resolves', () => {
    const declarations = claudeToolInventory(EMPTY_CLAUDE_CAPABILITIES)
    const last = declarations[declarations.length - 1]
    expect(last?.kind).toBe('ask-user')
    expect(HARNESS_ASK_USER_TOOL_ALIAS).toBe(`mcp__freecodego-host__${last?.name}`)
    // A question call with no questions has nothing to ask.
    expect(z.object(last!.shape).strict().safeParse({ questions: [] }).success).toBe(false)
  })
})

describe('projectToolContent', () => {
  it('passes the Host text through instead of nesting it in JSON', () => {
    // The regression: the whole Host result used to be stringified, so the model
    // read one JSON document containing another and had to parse twice to find a
    // summary it was supposed to read once.
    const content = projectToolContent({ content: [{ type: 'text', text: '{"model":"x"}' }], isError: false })
    expect(content).toEqual([{ type: 'text', text: '{"model":"x"}' }])
  })

  it('carries an inlined image through as an image block', () => {
    const content = projectToolContent({
      content: [
        { type: 'text', text: 'summary' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      ],
      isError: false,
    })
    expect(content[1]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' })
  })

  it('degrades an image this transport could not inline to its reference', () => {
    // Over the byte cap, or unreadable on the Host: the model still learns what
    // was generated and which attachment holds it, instead of losing the result.
    const content = projectToolContent({
      content: [{ type: 'image', attachment: { attachmentId: 'abc123', mediaType: 'image/png' } }],
      isError: false,
    })
    expect(content).toEqual([{ type: 'text', text: 'Generated image attachment: abc123' }])
  })

  it('keeps an unrecognized block as JSON rather than dropping it', () => {
    const content = projectToolContent({ content: [{ type: 'canvas', document: '<p/>' }], isError: false })
    expect(content).toEqual([{ type: 'text', text: '{"type":"canvas","document":"<p/>"}' }])
  })

  it('never returns an empty result', () => {
    // An empty MCP result reads as a failed call to some models.
    for (const value of [undefined, null, {}, { content: [] }, 'plain']) {
      const content = projectToolContent(value)
      expect(content.length).toBe(1)
      expect(content[0]?.type).toBe('text')
    }
  })
})

describe('projectHarnessToolResult', () => {
  it('marks a Host-reported failure as an error and a success as not one', async () => {
    const failed = await projectHarnessToolResult(async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }), [])
    expect(failed.isError).toBe(true)
    const ok = await projectHarnessToolResult(async () => ({ content: [{ type: 'text', text: 'yes' }], isError: false }), [])
    expect(ok.isError).toBeUndefined()
  })

  it('turns a rejecting bridge into an error result instead of rejecting the tool', async () => {
    const result = await projectHarnessToolResult(async () => { throw new Error('bridge offline') }, [])
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Harness tool failed: bridge offline' }])
  })

  it('masks credential shapes in a bridge failure, which is Host text the model then reads', async () => {
    const result = await projectHarnessToolResult(async () => {
      throw new Error('ghp_0123456789abcdefghijklmnopqrstuvwx rejected for Bearer sk-ant-api03-abcdefghijklmnopqrstuv')
    }, [])
    expect(result.content).toEqual([{ type: 'text', text: 'Harness tool failed: <redacted> rejected for Bearer <redacted>' }])
  })

  it('masks a credential a failed Host tool left in a URL query string', async () => {
    const result = await projectHarnessToolResult(async () => {
      throw new Error('GET https://api.example.com/v1/items?access_token=abc123def456 failed')
    }, [])
    expect(result.content).toEqual([{ type: 'text', text: 'Harness tool failed: GET https://api.example.com/v1/items?access_token=<redacted> failed' }])
  })

  it('masks a credential value this session holds even though no shape names it', async () => {
    // The Host bridge rethrows a failed tool's own error text, and a
    // third-party gateway key is whatever opaque string its provider chose:
    // `redactCredentialShapes` has nothing to match, so only the value the
    // session was launched with can name it.
    const gatewayKey = 'vyce-gateway-abcdef123456789'
    const result = await projectHarnessToolResult(async () => {
      throw new Error(`gateway refused ${gatewayKey}`)
    }, [gatewayKey])
    expect(result.content).toEqual([{ type: 'text', text: 'Harness tool failed: gateway refused <redacted>' }])
  })
})
