/**
 * Deferred tool schemas exist to cut the fixed per-request cost, which measured
 * 13,454-14,320 tokens with 45.7-47.4 KB of tool schemas — 27% of it ours. The
 * tests below pin three properties that are easy to break silently:
 *
 * 1. Visibility and callability cannot drift (`deny` gates both).
 * 2. Discovery never puts a dynamic list into a tool description, because that
 *    is the documented way to bust the whole prompt cache prefix.
 * 3. Deferral is scoped to one agent, and revealing is monotone.
 */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  deferredToolFetchHint,
  FreeCodeGoDeferredTools,
  matchDeferredTools,
  MAX_TOOL_SEARCH_RESULTS,
  parseToolSearchQuery,
  type FreeCodeGoDeferredToolSettings,
} from '../src/deferred-tools.ts'
import { DEFAULT_CATALOG_TOKEN_BUDGET } from '../src/tool-catalog-budget.ts'
import { tokensFromChars } from '../src/token-estimate.ts'

const SCHEMAS = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
  { name: 'engineering_status', description: 'Engineering status', parameters: { type: 'object' } },
  { name: 'engineering_repo_map', description: 'Repo map', parameters: { type: 'object' } },
  { name: 'advisor_review', description: 'Advisor review', parameters: { type: 'object' } },
  { name: 'headroom_retrieve', description: 'Retrieve compressed original', parameters: { type: 'object' } },
  { name: 'engineering_memory_search', description: 'Search durable project memory', parameters: { type: 'object' } },
  { name: 'engineering_memory_get', description: 'Read selected memory records', parameters: { type: 'object' } },
  { name: 'engineering_checkpoint_restore', description: 'Restore a checkpoint', parameters: { type: 'object' } },
  { name: 'engineering_team_start', description: 'Start an engineering team', parameters: { type: 'object' } },
  { name: 'advisor_notes', description: 'Read advisor notes', parameters: { type: 'object' } },
  { name: 'freecodego_generate_image', description: 'Generate an image', parameters: { type: 'object' } },
  { name: 'mcp__context7__query-docs', description: 'Query docs', parameters: { type: 'object' } },
]

interface Restriction {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  disposed: boolean
}

function deferredHarness(options: {
  readonly settings?: FreeCodeGoDeferredToolSettings
  readonly schemas?: readonly { readonly name: string; readonly description?: string; readonly parameters?: unknown }[]
} = {}): {
  readonly service: FreeCodeGoDeferredTools
  readonly registered: { readonly name: string; readonly description: string; readonly execute: (args: never, exec: never) => Promise<unknown> }[]
  readonly restrictions: readonly Restriction[]
  readonly startSession: (agentId?: string) => { readonly id: string; readonly ctx: unknown }
  readonly disposeSession: (agentId: string) => void
  readonly commitSettings: (next: FreeCodeGoDeferredToolSettings) => void
  readonly call: (args: Record<string, unknown>, agent: { readonly id: string; readonly ctx: unknown }) => Promise<unknown>
} {
  let settings = options.settings ?? {}
  // The service reads settings through a scope slice; `watch` is the half that
  // makes a commit observable mid-session, so the fixture must supply it.
  const settingsListeners: (() => void)[] = []
  const restrictions: Restriction[] = []
  const registered: never[] = []
  // `agent/created` carries a `source` the service reads; `agent/disposed` does
  // not, so the shared payload view makes it optional rather than dropping it.
  const listeners = new Map<string, (payload: { agent: unknown; source?: 'startup' | 'resume' | 'clear' | 'compact' }) => void>()
  const globalTools = {
    register: (tool: { name: string; description: string }) => { registered.push(tool as never); return () => undefined },
    schemas: () => options.schemas ?? SCHEMAS,
  }
  const ctx = {
    get: (name: string) => name === 'tools' ? globalTools : undefined,
    on: (event: string, handler: (payload: { agent: unknown; source?: 'startup' | 'resume' | 'clear' | 'compact' }) => void) => { listeners.set(event, handler); return () => undefined },
    effect: (callback: () => unknown) => { callback() },
  }
  const service = new FreeCodeGoDeferredTools(ctx as unknown as Context, {
    get: () => settings,
    watch: (callback: () => void) => {
      settingsListeners.push(callback)
      return () => undefined
    },
  })
  service.start()
  const agents = new Map<string, { readonly id: string; readonly ctx: unknown }>()
  return {
    service,
    registered: registered,
    restrictions,
    startSession: (agentId = 'agent-1') => {
      const scoped = {
        tools: {
          restrict: (filter: { allow?: readonly string[]; deny?: readonly string[] }) => {
            const entry: Restriction = { ...filter, disposed: false }
            restrictions.push(entry)
            return () => { entry.disposed = true }
          },
        },
      }
      const agent = { id: agentId, ctx: scoped }
      agents.set(agentId, agent)
      listeners.get('agent/created')?.({ agent, source: 'startup' })
      return agent
    },
    disposeSession: (agentId: string) => {
      const agent = agents.get(agentId)
      if (agent === undefined) return
      agents.delete(agentId)
      listeners.get('agent/disposed')?.({ agent })
    },
    commitSettings: (next: FreeCodeGoDeferredToolSettings) => {
      settings = next
      for (const listener of settingsListeners) listener()
    },
    call: async (args, agent) => {
      const tool = (registered as unknown as { name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }[])
        .find(entry => entry.name === 'tool_search')
      if (tool === undefined) throw new Error('tool_search was not registered')
      return await tool.execute(args, { agent })
    },
  }
}

/** Every tool name the plugin owns and defers by default. */
const EXPECTED_DEFERRED = [
  'advisor_notes',
  'engineering_checkpoint_restore',
  'engineering_memory_get',
  'engineering_memory_search',
  'engineering_team_start',
  'freecodego_generate_image',
]

function lastDeny(restrictions: readonly Restriction[]): readonly string[] {
  return restrictions.at(-1)?.deny ?? []
}

describe('deferred tool query grammar', () => {
  it('treats an empty query as the index request', () => {
    expect(parseToolSearchQuery('')).toEqual({ exact: [], required: [], terms: [] })
    expect(parseToolSearchQuery('   ')).toEqual({ exact: [], required: [], terms: [] })
  })

  it('parses a names-only listing request', () => {
    expect(parseToolSearchQuery('list:engineering_').list).toBe('engineering_')
    expect(parseToolSearchQuery('LIST : all').list).toBe('all')
    expect(parseToolSearchQuery('list:')).toEqual({ exact: [], required: [], terms: [], list: '' })
    // Not a keyword query: a `list:` request that fell through to ranking would
    // search for the literal text "list:..." and answer nothing.
    expect(parseToolSearchQuery('list:all').terms).toEqual([])
    expect(matchDeferredTools('list:all', SCHEMAS)).toEqual([])
  })

  it('parses an exact selection, tolerating spacing and case', () => {
    expect(parseToolSearchQuery('select:engineering_memory_search, advisor_notes').exact)
      .toEqual(['engineering_memory_search', 'advisor_notes'])
    expect(parseToolSearchQuery('SELECT : a').exact).toEqual(['a'])
  })

  it('separates required (+) terms from ranking terms', () => {
    expect(parseToolSearchQuery('+checkpoint restore')).toEqual({ exact: [], required: ['checkpoint'], terms: ['restore'] })
  })

  it('returns exact selections in the order they were asked for', () => {
    const matches = matchDeferredTools('select:advisor_notes,engineering_memory_get', SCHEMAS)
    expect(matches.map(tool => tool.name)).toEqual(['advisor_notes', 'engineering_memory_get'])
  })

  it('drops exact names that are not deferred rather than inventing them', () => {
    // `matchDeferredTools` only sees candidates the caller already filtered, so
    // an unknown name resolves to nothing rather than to a phantom tool.
    const deferred = SCHEMAS.filter(schema => EXPECTED_DEFERRED.includes(schema.name))
    const matches = matchDeferredTools('select:engineering_status,nope,advisor_notes', deferred)
    expect(matches.map(tool => tool.name)).toEqual(['advisor_notes'])
  })

  it('requires every +term to appear in the name and still ranks by the rest', () => {
    const matches = matchDeferredTools('+memory search', SCHEMAS)
    expect(matches.map(tool => tool.name)).toEqual(['engineering_memory_search'])
    expect(matchDeferredTools('+memory +checkpoint restore', SCHEMAS)).toEqual([])
  })

  it('ranks a name match above a description-only match', () => {
    const matches = matchDeferredTools('checkpoint', SCHEMAS)
    expect(matches.map(tool => tool.name)).toEqual(['engineering_checkpoint_restore'])
  })

  it('caps results at max_results and defaults to a keyword search', () => {
    expect(matchDeferredTools('engineering', SCHEMAS, 2)).toHaveLength(2)
    expect(matchDeferredTools('engineering', SCHEMAS).length).toBeGreaterThan(2)
  })

  it('enforces the documented ceiling instead of only stating it', () => {
    // The schema is what the model is told, not a guarantee: a caller asking for
    // 999 would otherwise spend several requests' worth of context in one step.
    expect(matchDeferredTools('engineering', SCHEMAS, 999).length).toBeLessThanOrEqual(MAX_TOOL_SEARCH_RESULTS)
    expect(MAX_TOOL_SEARCH_RESULTS).toBe(20)
  })

  it('ranks a tool that names the query above one that merely mentions it', () => {
    // Both candidates match; only one is about the thing. The previous scoring
    // tied them at one point each and broke the tie alphabetically.
    const candidates = [
      { name: 'engineering_archive_notes', description: `Restore a checkpoint is the phrase inside ${'filler '.repeat(40)}` },
      { name: 'engineering_restore_point', description: 'Restore a checkpoint' },
    ]
    expect(matchDeferredTools('checkpoint', candidates).map(tool => tool.name)[0]).toBe('engineering_restore_point')
  })

  it('finds a tool whose name holds the query as a prefix, plural or not', () => {
    // The forward-only prefix rule answered the plural with "no match" while the
    // singular found the tool: a miss for a query that names the thing exactly.
    expect(matchDeferredTools('checkpoint', SCHEMAS).map(tool => tool.name)).toContain('engineering_checkpoint_restore')
    expect(matchDeferredTools('checkpoints', SCHEMAS).map(tool => tool.name)).toContain('engineering_checkpoint_restore')
  })

  it('answers a filter-only query with every survivor instead of nothing', () => {
    // `+engineering` is a filter with no ranking terms; returning [] would make
    // a legitimate discovery call look like a miss.
    const matches = matchDeferredTools('+engineering', SCHEMAS)
    expect(matches.length).toBeGreaterThan(1)
    // With nothing to rank by, the order has to be one a caller can read twice.
    expect(matches.map(tool => tool.name)).toEqual([...matches.map(tool => tool.name)].sort())
  })
})

describe('deferred tool fetch hint', () => {
  it('names the loading call for a deferred tool and nothing for an immediate one', () => {
    // Prompt text that names a tool the Agent cannot call is the defect this
    // replaces: the hint is what a brief or an injected block appends so the
    // instruction stays followable with the schema deferred.
    const hint = deferredToolFetchHint('engineering_memory_search')
    expect(hint).toContain('engineering_memory_search')
    expect(hint).toContain('tool_search')
    expect(hint).toContain('select:engineering_memory_search')
    // An immediate tool needs no sentence, and callers append unconditionally.
    expect(deferredToolFetchHint('read_document')).toBe('')
    expect(deferredToolFetchHint('engineering_plan_mode')).toBe('')
    expect(deferredToolFetchHint('read')).toBe('')
  })
})

describe('deferred tool split', () => {
  it('defers plugin-owned families and keeps the orientation tools immediate', () => {
    const harness = deferredHarness()
    const status = harness.service.status()
    expect(status.deferred.map(entry => entry.name).sort()).toEqual(EXPECTED_DEFERRED)
    // Status/ repo-map / advisor_review / headroom_retrieve stay, and so does
    // every tool this plugin does not own.
    for (const name of ['engineering_status', 'engineering_repo_map', 'advisor_review', 'headroom_retrieve', 'read', 'mcp__context7__query-docs']) {
      expect(status.deferred.some(entry => entry.name === name)).toBe(false)
    }
  })

  it('reports the byte and token cost it removes from every request', () => {
    const status = deferredHarness().service.status()
    const expected = SCHEMAS
      .filter(schema => EXPECTED_DEFERRED.includes(schema.name))
      .reduce((total, schema) => total + JSON.stringify(schema).length, 0)
    expect(status.deferredChars).toBe(expected)
    expect(status.deferredTokens).toBe(Math.round(expected / 4))
    expect(status.deferredTokens).toBeGreaterThan(0)
  })

  it('honours an explicit deferral list instead of the prefix rule', () => {
    const harness = deferredHarness({ settings: { deferredToolNames: ['engineering_memory_get'] } })
    // The explicit list replaces the prefix rule outright, so a family that is
    // normally immediate can be deferred and a normally-deferred one kept.
    expect(harness.service.status().deferred.map(entry => entry.name)).toEqual(['engineering_memory_get'])
  })

  it('keeps the entry-point and orientation tools immediate even if listed', () => {
    // `ALWAYS_IMMEDIATE` wins over an explicit list: deferring `tool_search`
    // would be a lockout, and the others are answers to something the model has
    // already been shown.
    const harness = deferredHarness({ settings: { deferredToolNames: ['tool_search', 'engineering_status', 'advisor_review'] } })
    expect(harness.service.status().deferred).toEqual([])
  })

  it('keeps a tool this plugin\'s prompt text names immediate even if listed', () => {
    // Both names appear in prompt text this plugin injects: `read_document` in
    // the file-reading guidance ("Use read_document — not read — for PDF files"),
    // `edit_and_run` in the section that offers it in place of a separate edit
    // and shell call. A deferred schema makes either instruction un-followable —
    // the call is refused until a `tool_search` the model was never told to run.
    // Neither name carries one of the three deferrable prefixes, so family
    // membership protects nothing here and the never-deferred set is the only
    // thing that can. An explicit list replaces the prefix rule, which is the
    // path that has to be exercised for the guarantee to mean anything.
    const harness = deferredHarness({
      schemas: [
        { name: 'read_document', description: 'Read a PDF', parameters: { type: 'object' } },
        { name: 'edit_and_run', description: 'Edit a file and run a command', parameters: { type: 'object' } },
        ...SCHEMAS,
      ],
      settings: { deferredToolNames: ['read_document', 'edit_and_run', 'engineering_memory_get'] },
    })
    expect(harness.service.status().deferred.map(entry => entry.name)).toEqual(['engineering_memory_get'])
  })

  it('keeps the discovery description free of any tool name', () => {
    // The documented reason the index is not in the description: a dynamic list
    // here mutates the tool block on every settings change and busts the whole
    // prompt cache prefix, not just this tool.
    const harness = deferredHarness()
    const search = harness.registered.find(tool => tool.name === 'tool_search')
    expect(search).toBeDefined()
    // Word-boundary match: a naive substring check trips on `read` inside
    // "already", which is exactly the kind of false signal a cache bust is not.
    for (const schema of SCHEMAS) {
      const pattern = new RegExp(`(?:^|[^\w])${schema.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:[^\w]|$)`, 'u')
      expect(pattern.test(search?.description ?? '')).toBe(false)
    }
    expect(search?.description).toContain('tool_search')
  })

  it('denies exactly the deferred names when a session starts', () => {
    const harness = deferredHarness()
    harness.startSession()
    expect(harness.restrictions).toHaveLength(1)
    expect([...lastDeny(harness.restrictions)].sort()).toEqual(EXPECTED_DEFERRED)
    // Never an `allow` mask: an allow list would hide every Harness core tool too.
    expect(harness.restrictions[0]?.allow).toBeUndefined()
  })

  it('applies nothing when the feature is off', () => {
    const harness = deferredHarness({ settings: { deferredToolSchemasEnabled: false } })
    harness.startSession()
    expect(harness.restrictions).toHaveLength(0)
  })

  it('does not restrict when there is nothing eligible', () => {
    const harness = deferredHarness({ schemas: [{ name: 'read' }, { name: 'engineering_status' }] })
    harness.startSession()
    expect(harness.restrictions).toHaveLength(0)
  })

  it('lists the index without revealing anything', async () => {
    const harness = deferredHarness()
    const agent = harness.startSession()
    const listed = await harness.call({}, agent) as string
    expect(listed).toContain('engineering_memory_search')
    expect(listed).toContain('engineering_checkpoint_restore')
    // Listing is discovery, not delivery: a name is still uncallable here.
    expect(harness.restrictions).toHaveLength(1)
  })

  it('bounds the index instead of letting it grow with the catalog', async () => {
    const bulk = Array.from({ length: 80 }, (_unused, index) => ({
      name: `engineering_tool_${String(index)}`,
      description: `Does the ${String(index)}th thing, in a sentence the length a real tool description has.`,
      parameters: { type: 'object' },
    }))
    const harness = deferredHarness({ schemas: [...SCHEMAS, ...bulk] })
    const agent = harness.startSession()
    const index = await harness.call({}, agent) as string
    expect(index).toContain('Summaries are omitted')
    // Degradation is not truncation: every name is still in the listing.
    for (const entry of bulk) expect(index).toContain(entry.name)
    // And the names the index could not spell out are still askable for: the
    // listing is itself bounded, says so, and a narrower prefix reaches what the
    // wide listing left.
    const all = await harness.call({ query: 'list:all' }, agent) as string
    expect(all).toContain('engineering_tool_0')
    expect(all).toContain('… and ')
    const narrowed = await harness.call({ query: 'list:engineering_tool_5' }, agent) as string
    expect(narrowed).toContain('engineering_tool_54')
    // A listing is not a fetch: nothing was revealed by any of these calls.
    expect(harness.restrictions).toHaveLength(1)
  })

  it('lists one group of names without fetching their schemas', async () => {
    const harness = deferredHarness()
    const agent = harness.startSession()
    const listed = await harness.call({ query: 'list:engineering_' }, agent) as string
    expect(listed).toContain('engineering_memory_search')
    expect(listed).not.toContain('advisor_notes')
    expect(listed).not.toContain('<function>')
    expect(listed).toContain('is not callable until its schema is fetched')
    expect(harness.restrictions).toHaveLength(1)
  })

  it('reveals fetched tools by re-applying a narrower deny list', async () => {
    const harness = deferredHarness()
    const agent = harness.startSession()
    const result = await harness.call({ query: 'select:engineering_memory_search' }, agent) as string
    expect(result).toContain('<functions>')
    expect(result).toContain('engineering_memory_search')
    // Fetched descriptions point at sibling tools by name (`memory_timeline` says
    // to read records with `memory_get`, `checkpoint_restore` says to preview with
    // `checkpoint_diff`), and a sibling is not callable until it too is fetched.
    // The result is the one place the model is already in the discovery flow, so
    // the rule is stated there rather than repeated in every description.
    expect(result).toContain('points you at')
    expect(harness.restrictions).toHaveLength(2)
    // The first restriction is lifted, or the layers would intersect and the
    // revealed tool would stay invisible.
    expect(harness.restrictions[0]?.disposed).toBe(true)
    expect(lastDeny(harness.restrictions)).not.toContain('engineering_memory_search')
    expect(lastDeny(harness.restrictions)).toContain('engineering_checkpoint_restore')
  })

  it('lifts the restriction entirely once every deferred tool is fetched', async () => {
    const harness = deferredHarness()
    const agent = harness.startSession()
    await harness.call({ query: `select:${EXPECTED_DEFERRED.join(',')}` }, agent)
    // Nothing left to deny: an empty deny list is rejected as a no-op, so the
    // service must lift the layer instead of applying `deny: []`.
    expect(harness.restrictions).toHaveLength(1)
    expect(harness.restrictions[0]?.disposed).toBe(true)
  })

  it('never un-defers a tool that was not fetched', async () => {
    const harness = deferredHarness()
    const agent = harness.startSession()
    await harness.call({ query: 'select:advisor_notes' }, agent)
    expect([...lastDeny(harness.restrictions)].sort()).toEqual(EXPECTED_DEFERRED.filter(name => name !== 'advisor_notes'))
  })

  it('reports a helpful answer when a query matches nothing', async () => {
    const harness = deferredHarness()
    const agent = harness.startSession()
    const result = await harness.call({ query: 'zzz-nothing' }, agent) as string
    expect(result).toContain('No deferred tool matched')
    expect(result).toContain('engineering_memory_search')
    expect(harness.restrictions).toHaveLength(1)
  })

  it('bounds the no-match answer instead of dumping the whole catalog', async () => {
    // A typo is the most likely way to reach this branch, so it has to be as cheap
    // as the index it stands in for. It used to list every candidate name, which on
    // a 400-tool catalog was ~2.7k tokens — more than the whole index budget the
    // catalog renderer exists to hold.
    const catalog = Array.from({ length: 400 }, (_value, index) => ({
      name: `engineering_generated_${String(index).padStart(3, '0')}`,
      description: 'A generated tool',
      parameters: { type: 'object' },
    }))
    const harness = deferredHarness({ schemas: catalog })
    const result = await harness.call({ query: 'zzz-nothing' }, harness.startSession()) as string
    expect(result).toContain('No deferred tool matched')
    expect(tokensFromChars(result.length)).toBeLessThanOrEqual(DEFAULT_CATALOG_TOKEN_BUDGET)
    // Bounded is not hiding: the answer still has to say how to see every name.
    expect(result).toContain('list:all')
  })

  it('caps one call at the documented schema ceiling and leaves the rest denied', async () => {
    // `select:` states its own length, so it is the one form whose result size the
    // caller chooses; the ceiling has to hold there too, and the tools it did not
    // fetch have to stay uncallable rather than being revealed by the mention.
    const schemas = Array.from({ length: 30 }, (_value, index) => ({
      name: `engineering_bulk_${String(index).padStart(2, '0')}`,
      description: 'Bulk tool',
      parameters: { type: 'object' },
    }))
    const harness = deferredHarness({ schemas })
    const agent = harness.startSession()
    const result = await harness.call({ query: `select:${schemas.map(schema => schema.name).join(',')}` }, agent) as string
    expect(result.match(/<function>/gu)?.length).toBe(MAX_TOOL_SEARCH_RESULTS)
    expect(result).toContain('did not fit this call\'s ceiling')
    const deny = lastDeny(harness.restrictions)
    expect(deny).toHaveLength(schemas.length - MAX_TOOL_SEARCH_RESULTS)
    expect(deny).toContain('engineering_bulk_29')
  })

  it('scopes the denial to the agent that started the session', async () => {
    const harness = deferredHarness()
    const first = harness.startSession('agent-a')
    const second = harness.startSession('agent-b')
    await harness.call({ query: 'select:advisor_notes' }, first)
    // Three layers: agent-a's initial deny, agent-b's initial deny, and agent-a's
    // narrower re-apply. Agent-b's layer is untouched by agent-a's discovery —
    // otherwise one agent's fetch would widen another agent's tool pool.
    expect(harness.restrictions).toHaveLength(3)
    expect([...(harness.restrictions[1]?.deny ?? [])].sort()).toEqual(EXPECTED_DEFERRED)
    expect(harness.restrictions[1]?.disposed).toBe(false)
    expect(second.id).toBe('agent-b')
    expect(harness.service.status().activeAgents).toBe(2)
  })

  it('releases an agent\'s deferral scope when the agent is disposed', () => {
    const harness = deferredHarness()
    harness.startSession('agent-a')
    harness.startSession('agent-b')
    expect(harness.service.status().activeAgents).toBe(2)
    harness.disposeSession('agent-a')
    // Per-agent state released with the agent: without this, a Host accumulated
    // one live restriction for every agent it had ever spawned.
    expect(harness.service.status().activeAgents).toBe(1)
    expect(harness.restrictions[0]?.disposed).toBe(true)
    expect(harness.restrictions[1]?.disposed).toBe(false)
  })

  it('survives a host without the schema reader instead of throwing', () => {
    // An older Host has no `schemas()`; the service must degrade to "nothing is
    // deferred" rather than failing a session start.
    const ctx = {
      get: (name: string) => name === 'tools' ? { register: () => () => undefined } : undefined,
      on: () => () => undefined,
      effect: (callback: () => unknown) => { callback() },
    }
    const service = new FreeCodeGoDeferredTools(ctx as unknown as Context, { get: () => ({}) })
    expect(() => { service.start() }).not.toThrow()
    expect(service.status().deferred).toEqual([])
  })
})

/**
 * A settings commit can change both halves of the deferral decision, and the
 * restriction is applied once per Agent. Before the settings watch existed, the
 * deny list a session started with was the deny list it kept: turning the feature
 * off left every deferred tool refused while `status()` reported `enabled: false`,
 * and a name that stopped being deferrable stayed hidden with no way to notice.
 */
describe('deferred tool settings re-sync', () => {
  it('releases the restriction when deferral is turned off mid-session', () => {
    const harness = deferredHarness()
    harness.startSession('agent-a')
    expect(harness.restrictions.length).toBe(1)
    harness.commitSettings({ deferredToolSchemasEnabled: false })
    // A released scope, not a widened deny list: `deny: []` would still be a
    // restriction from this plugin, and would still be a live opinion about the
    // Agent's tool set after the user asked us to have none.
    expect(harness.restrictions.length).toBe(1)
    expect(harness.restrictions[0]?.disposed).toBe(true)
    // The tools are visible again, so the model reaches them without a search.
    expect(harness.service.status().enabled).toBe(false)
  })

  it('recomputes the deny list when the eligible catalog changes', () => {
    const harness = deferredHarness()
    harness.startSession('agent-a')
    expect([...lastDeny(harness.restrictions)].sort()).toEqual(EXPECTED_DEFERRED)
    harness.commitSettings({ deferredToolNames: ['advisor_notes'] })
    expect([...(harness.restrictions.at(-1)?.deny ?? [])].sort()).toEqual(['advisor_notes'])
    // The previous restriction is released rather than left intersecting.
    expect(harness.restrictions.length).toBe(2)
    expect(harness.restrictions[0]?.disposed).toBe(true)
  })

  it('keeps a revealed name revealed across a settings commit', async () => {
    const harness = deferredHarness()
    const agent = harness.startSession('agent-a')
    const revealed = ['engineering_memory_search']
    const search = harness.registered.find(entry => entry.name === 'tool_search')
    expect(search).toBeDefined()
    await harness.call({ query: 'select:engineering_memory_search' }, agent)
    expect([...lastDeny(harness.restrictions)].sort())
      .toEqual(EXPECTED_DEFERRED.filter(name => !revealed.includes(name)))
    harness.commitSettings({ deferredToolNames: ['engineering_memory_search', 'advisor_notes'] })
    // `engineering_memory_search` is still eligible and was already shown, so it
    // is not taken back; only the newly-scoped name is denied.
    expect([...(harness.restrictions.at(-1)?.deny ?? [])].sort()).toEqual(['advisor_notes'])
  })

  it('leaves an unchanged deny list alone instead of churning the scope', () => {
    const harness = deferredHarness()
    harness.startSession('agent-a')
    harness.commitSettings({})
    // Same eligible set, same denied set: re-restricting would change the tool
    // block for no gain, and the tool block is part of the cached prefix.
    expect(harness.restrictions.length).toBe(1)
  })
})
