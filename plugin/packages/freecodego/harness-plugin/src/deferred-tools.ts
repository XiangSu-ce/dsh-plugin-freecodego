/**
 * Deferred tool schemas: keep task-specific tools callable without shipping
 * their JSONSchema on every request.
 *
 * Why
 * ---
 * Measured on real sessions, the fixed part of every request was 13,454-14,320
 * tokens, and 45.7-47.4 KB of that was tool schemas. This plugin owned 37 of the
 * 61-74 tools and 14,380 chars (~3,595 tokens) of it — 27% of the whole block,
 * re-sent on every step of every turn. Most of those tools are task-specific:
 * graph queries, memory CRUD, checkpoint restore, media generation. A turn that
 * edits a setting never needs any of them.
 *
 * How
 * ---
 * Every tool is still registered globally, so nothing about dispatch, guards, or
 * audit changes. What changes is *visibility*: on `agent/session-start` the
 * plugin restricts this agent's scope with `deny: [...deferred]`, and the Harness
 * derives the wire schema from the scope's visible set (`tools.schemas(agent)`).
 * A denied name is not merely hidden — calling it surfaces as `UNKNOWN_TOOL` —
 * so the two halves cannot drift: the model can only call what it was shown.
 *
 * `tool_search` then fetches schemas on demand and lifts the denial for the
 * tools it returned, so a deferred tool is exactly as usable as an immediate one
 * after one discovery call.
 *
 * Why the index is NOT in the description
 * ---------------------------------------
 * Claude Code's own source records why: a dynamic agent list in a tool
 * description cost them "~10.2% of fleet cache_creation tokens", because any
 * mutation of the list changed the tool block and busted the entire prompt
 * cache — including every token before it. Our deferred set changes with
 * settings (engineering on/off, capabilities), so embedding it in
 * `tool_search`'s description would reintroduce exactly that failure. The
 * description is therefore **static**, and an argument-less `tool_search` call
 * returns the index. Discovery costs one call, and the cache prefix never moves.
 *
 * Why a reveal is NOT re-armed at each request
 * -------------------------------------------
 * The obvious refinement — hide a fetched tool again on the next user message,
 * the way MiMoCode's MCP tool search resets its loaded set — does not survive the
 * cache arithmetic this module is built around. Revealing a tool changes the tool
 * block, which is part of the prompt *prefix*, so every change there costs a full
 * cache **write** of the whole conversation (~1.25x input on the next request)
 * instead of a cache **read** (~0.1x) of a few hundred extra schema tokens. Ten
 * deferred tools average ~950 tokens; keeping them for forty requests costs about
 * 38k token-equivalents, while re-arming even once costs more than that. Per
 * request re-arming therefore loses money for a set this size, and it buys a
 * second problem: a call the model read out of history is refused for a reason
 * the model cannot see. MiMoCode can afford the reset because it is hiding an
 * entire MCP catalog, not 3.6k tokens.
 *
 * What *is* adopted from that design is its other half — a catalog is recomputed
 * rather than snapshotted, so a change to what is deferrable invalidates the
 * previous answer instead of leaving it standing (`syncRestrictions`).
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/deferred-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DeferredToolStatus } from './types.ts'
import { toolDefinition as rawTool, type ToolDefinitionShape } from './tool-definition.ts'
import { tokensFromChars } from './token-estimate.ts'
import { renderDeferredNameList, renderToolCatalog, type CatalogEntry } from './tool-catalog-budget.ts'
import { rankTools } from './tool-search-rank.ts'

// The status shape lives in `types.ts` because it crosses the Remote boundary,
// and the typert generator requires boundary types on a public non-root subpath.
export type { DeferredToolStatus } from './types.ts'

/** Settings slice this module reads. */
export interface FreeCodeGoDeferredToolSettings {
  readonly deferredToolSchemasEnabled?: boolean
  /** Explicit deferral list; when non-empty it replaces the prefix rule. */
  readonly deferredToolNames?: readonly string[]
}

/** Plugin-owned tool prefixes eligible for deferral. */
const DEFERRED_PREFIXES: readonly string[] = ['engineering_', 'advisor_', 'freecodego_']

/**
 * Most schemas one `tool_search` call may return, whatever the query form.
 *
 * The tool's schema states this ceiling, and it is enforced here as well — for a
 * keyword or filter query by the ranking bound, and for `select:` by the call's
 * own ceiling — because the schema is what the model is told, not what the
 * caller is guaranteed: a discovery call that answered with 999 schemas would
 * spend several requests' worth of context in one step, and `select:` lets the
 * caller state that many by name.
 */
export const MAX_TOOL_SEARCH_RESULTS = 20

/**
 * Whether the prefix rule would defer this tool name.
 *
 * Exported because more than one module has to agree with it: any prompt text
 * that tells the model to call a tool by name must not name a deferrable one, or
 * the instruction is un-followable until a discovery call the model was never
 * told to make. `plan-mode.ts` asserts its own guidance against this predicate.
 *
 * An explicit `deferredToolNames` setting is deliberately not consulted: that is
 * an operator's override, and a prompt-bearing module cannot read it.
 */
export function isDeferrableByPrefix(name: string): boolean {
  return !ALWAYS_IMMEDIATE.has(name) && DEFERRED_PREFIXES.some(prefix => name.startsWith(prefix))
}

/**
 * The sentence that makes a deferred tool reachable, for prompt text that names
 * one.
 *
 * A prompt may name a tool only if the Agent can call it, and this plugin ships
 * two ways to keep that true. Its own fixed set of named tools pays the schema
 * (`ALWAYS_IMMEDIATE`); text it injects *unsolicited* — a team member's brief, a
 * memory-context block at session start — does not, because that cost would be
 * paid by every Agent for a pointer most of them never follow. Such text names
 * the tool and how to load it instead, which is the shape this plugin treats as
 * the only acceptable one: telling a model to call a tool, withholding the
 * schema, and saying nothing about `tool_search` is a defect in every module
 * that has had to fix it (`plan-mode`, the native-engine media guidance).
 *
 * Returning `''` when the tool is not deferrable keeps the caller from
 * restating the rule, and means the sentence disappears by itself if the tool
 * ever moves into `ALWAYS_IMMEDIATE`.
 *
 * @param name - The plugin-owned tool name the surrounding text names.
 * @returns A sentence to append after naming the tool, or `''` when its schema
 *   is always present.
 */
export function deferredToolFetchHint(name: string): string {
  if (!isDeferrableByPrefix(name)) return ''
  return `Most tool schemas are not in the request until they are fetched, so if ${name} is not in your schema, load it first with tool_search "select:${name}" — a call to a tool you have not fetched is refused.`
}

/**
 * Tools that stay in the wire schema unconditionally.
 *
 * - `tool_search` is the entry point; deferring it would be a lockout.
 * - `engineering_status` is the diagnostic a user reaches for when nothing else
 *   works, and it is small.
 * - `engineering_repo_map` is a first-turn orientation tool.
 * - `advisor_review` and `headroom_retrieve` are answers to something the model
 *   has already been shown (a hint to consult the advisor; a compression marker
 *   naming a hash), so a discovery round-trip there is pure latency.
 * - `engineering_plan_mode` is named *by name* in the Plan Mode guidance this
 *   plugin injects, including in the enforcement addendum's line on how to move
 *   the mode. An instruction that names a deferred tool is a dead end — the call
 *   is refused until a `tool_search` fetches the schema — and that would be a
 *   drift between the text and the surface in the one feature whose whole claim
 *   is that the two cannot drift. The rule this belongs to: a tool this plugin's
 *   own prompt text names is never deferred. The schema below is ~1 KB, paid per
 *   request; the alternative was deleting the pointer and leaving the mode's
 *   programmatic path unreachable except through a search the model has no
 *   reason to run.
 * - `read_document` is named by the injected file-reading guidance ("Use
 *   `read_document` — not `read` — for PDF files and Jupyter notebooks"), so a
 *   deferred schema makes that instruction un-followable for exactly the file
 *   types it exists for.
 *   Why the same rule needs an entry here rather than family membership:
 *   `read_document`, `edit_and_run`, and `headroom_retrieve` are outside the
 *   three prefixed families, so the *prefix* rule already leaves them immediate
 *   — but an explicit `deferredToolNames` list replaces the prefix rule, and a
 *   name-based rule that only holds on one of two paths is not a rule. This set
 *   is consulted before that setting, which makes it the only place the promise
 *   can actually be kept. All three are entries above; the rule holds on both
 *   paths only for as long as that stays true, which is what
 *   `deferred-tools.spec.ts`'s case for the prompt-named pair checks.
 */
const ALWAYS_IMMEDIATE: ReadonlySet<string> = new Set([
  'tool_search',
  'engineering_status',
  'engineering_repo_map',
  'engineering_plan_mode',
  'advisor_review',
  'headroom_retrieve',
  'read_document',
  'edit_and_run',
])

/** Structural view of the Harness tools service — only what this module uses. */
interface ToolSchemaLike {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
}
interface ToolServiceLike {
  register(tool: ToolDefinitionShape): (() => void) | { dispose?: () => void }
  schemas?(scope?: unknown): readonly ToolSchemaLike[]
}
interface AgentLike {
  readonly id: string
  readonly ctx: { readonly tools?: { restrict(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): () => void } }
}
interface SettingsSource {
  get(): unknown
  /**
   * Observe committed settings changes, when the caller's scope provides it.
   *
   * Optional because the service accepts any read-through slice: a caller that
   * only has `get()` still works, it just cannot be re-synced mid-session.
   */
  watch?(callback: () => void): () => void
}


/** One parsed `tool_search` query. */
interface ParsedQuery {
  readonly exact: readonly string[]
  readonly required: readonly string[]
  readonly terms: readonly string[]
  /**
   * A names-only listing request (`list:<prefix>`, `list:all`), present only
   * when the query was one. Handled before ranking, and it reveals nothing: a
   * name without its schema is not callable.
   */
  readonly list?: string
}

/**
 * Present registered schemas to the catalog renderer.
 *
 * Only the first line of a description is carried: the index is a listing, and
 * a full description belongs to the fetch that makes the tool callable.
 * @param schemas - the eligible schemas, in registration order.
 * @returns the entries the index renders.
 */
function catalogEntries(schemas: readonly ToolSchemaLike[]): readonly CatalogEntry[] {
  return schemas.map((schema) => {
    const summary = (schema.description ?? '').split('\n')[0]
    return summary === undefined || summary === '' ? { name: schema.name } : { name: schema.name, summary }
  })
}

/**
 * Parse the documented query grammar.
 *
 * - `select:A,B` — exact names, in the order given.
 * - `+slack send` — `slack` must appear in the name; remaining terms rank.
 * - `list:engineering_` — names only, for a group (or `list:all`).
 * - anything else — keyword search over names and descriptions.
 *
 * Copied deliberately from Claude Code's `ToolSearch`, because a discovery
 * grammar the model has already been trained against is worth more than a
 * marginally cleaner one it has to learn; `list:` is the one form added here,
 * and it exists so that a briefer-than-full index cannot hide a name — see
 * `tool-catalog-budget.ts`.
 */
export function parseToolSearchQuery(query: string): ParsedQuery {
  const trimmed = query.trim()
  if (trimmed === '') return { exact: [], required: [], terms: [] }
  const select = /^select\s*:\s*(.+)$/iu.exec(trimmed)
  if (select !== null) {
    return { exact: (select[1] ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== ''), required: [], terms: [] }
  }
  const list = /^list\s*:\s*(.*)$/iu.exec(trimmed)
  if (list !== null) return { exact: [], required: [], terms: [], list: (list[1] ?? '').trim() }
  const terms: string[] = []
  const required: string[] = []
  for (const token of trimmed.split(/\s+/u)) {
    if (token === '') continue
    if (token.startsWith('+') && token.length > 1) required.push(token.slice(1).toLowerCase())
    else terms.push(token.toLowerCase())
  }
  return { exact: [], required, terms }
}

/**
 * Rank deferred tools against a parsed query.
 *
 * Exact selections are returned as named, in the order the caller asked for. A
 * keyword query is ranked by {@link rankTools} — BM25F over the name and the
 * description — and a `+term`-only query is a filter whose survivors keep an
 * order they can be read in, because a filter with no ranking terms makes every
 * survivor equally relevant.
 */
export function matchDeferredTools(query: string, candidates: readonly ToolSchemaLike[], maxResults = 10): readonly ToolSchemaLike[] {
  const parsed = parseToolSearchQuery(query)
  if (parsed.exact.length > 0) {
    const byName = new Map(candidates.map(candidate => [candidate.name.toLowerCase(), candidate]))
    return parsed.exact.map(name => byName.get(name.toLowerCase())).filter((tool): tool is ToolSchemaLike => tool !== undefined)
  }
  if (parsed.required.length === 0 && parsed.terms.length === 0) return []
  // The `+` filter stays a substring test on the name: it is documented as
  // "must appear in the tool name", and a filter that quietly became fuzzy would
  // answer a question the caller did not ask.
  const survivors = candidates.filter((candidate) => {
    const name = candidate.name.toLowerCase()
    return parsed.required.every(term => name.includes(term))
  })
  const limit = Math.min(
    MAX_TOOL_SEARCH_RESULTS,
    Math.max(1, Number.isFinite(maxResults) ? Math.floor(maxResults) : 10),
  )
  if (parsed.terms.length === 0) {
    return [...survivors].sort((left, right) => left.name.localeCompare(right.name)).slice(0, limit)
  }
  return rankTools(parsed.terms, survivors, limit).map(entry => entry.tool)
}

export class FreeCodeGoDeferredTools {
  private readonly tools: ToolServiceLike | undefined
  /**
   * Per-agent restriction ownership, so a fetch can re-apply a narrower deny list.
   *
   * `revealed` is kept beside `deferred` (rather than being derivable from it)
   * because a settings change has to recompute which names are denied without
   * forgetting what the model has already been shown — see `syncRestrictions`.
   */
  private readonly agents = new Map<string, {
    readonly agent: AgentLike
    dispose: (() => void) | undefined
    deferred: Set<string>
    readonly revealed: Set<string>
  }>()
  private stopWatching: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly settings: SettingsSource | undefined,
  ) {
    this.tools = (ctx as unknown as { get(name: string): unknown }).get('tools') as ToolServiceLike | undefined
  }

  start(): void {
    if (this.tools?.register === undefined) return
    this.registerSearchTool()
    // A settings commit can change both halves of the decision at once: whether
    // deferral is on at all, and which names are eligible. The restriction is
    // applied once per Agent, so without this subscription a user who turns the
    // feature off keeps a live deny list for the rest of the session — the
    // status surface would report `enabled: false` while every deferred tool was
    // still refused. The same seam is what makes the eligible set a *catalog*
    // rather than a snapshot: a capability mounting or unmounting mid-session
    // recomputes it instead of leaving the previous answer standing.
    this.stopWatching = this.settings?.watch?.(() => {
      try {
        this.syncRestrictions()
      } catch {
        // A re-sync failure must not take down the settings service that called
        // it: the previous restriction stays in force and the session keeps
        // working, which is strictly better than an exception here.
      }
    })
    // Rides the creation announcement (`agent/created` replaced
    // `agent/session-start` in Harness 0.1.6); the body is already fail-open.
    this.ctx.on('agent/created', ({ agent }) => {
      try {
        this.applyRestriction(agent)
      } catch {
        // A deferral failure must never block a session: the tools stay visible
        // and the session costs more, which is strictly better than not starting.
      }
    })
    this.ctx.effect(() => () => {
      this.stopWatching?.()
      this.stopWatching = undefined
    }, 'freecodego: deferred tool settings watch')
    this.ctx.on('agent/disposed', ({ agent }) => {
      // The restriction is per-agent state, so it is released with the agent.
      // Without this the map kept one entry — and one live restriction — for every
      // agent the Host had ever spawned, and `activeAgents` counted them all.
      try {
        const id = String((agent as unknown as { readonly id?: unknown } | undefined)?.id ?? '')
        if (id === '') return
        const entry = this.agents.get(id)
        if (entry === undefined) return
        this.agents.delete(id)
        entry.dispose?.()
      } catch {
        // Releasing a scope must never disturb the Host's disposal path.
      }
    })
  }

  dispose(): void {
    this.disposed = true
    this.stopWatching?.()
    this.stopWatching = undefined
    for (const entry of this.agents.values()) entry.dispose?.()
    this.agents.clear()
  }

  /** Every registered plugin-owned tool currently eligible for deferral. */
  private eligible(): readonly ToolSchemaLike[] {
    const schemas = this.tools?.schemas?.() ?? []
    const explicit = this.settings?.get() as FreeCodeGoDeferredToolSettings | undefined
    const configured = explicit?.deferredToolNames
    const useExplicit = Array.isArray(configured) && configured.length > 0
    return schemas.filter((schema) => {
      if (typeof schema?.name !== 'string') return false
      if (ALWAYS_IMMEDIATE.has(schema.name)) return false
      if (useExplicit) return configured.includes(schema.name)
      return isDeferrableByPrefix(schema.name)
    })
  }

  private enabled(): boolean {
    if (this.disposed) return false
    const value = this.settings?.get() as FreeCodeGoDeferredToolSettings | undefined
    return value?.deferredToolSchemasEnabled !== false
  }

  /** Deny everything eligible for this agent; a no-op when the list is empty. */
  private applyRestriction(agent: AgentLike): void {
    if (!this.enabled()) return
    const scoped = agent.ctx?.tools
    if (scoped?.restrict === undefined) return
    const names = this.eligible().map(schema => schema.name)
    if (names.length === 0) return
    // Replace any earlier restriction for this agent rather than stacking, so a
    // re-entered session does not accumulate intersecting deny layers.
    this.agents.get(agent.id)?.dispose?.()
    const dispose = scoped.restrict({ deny: names })
    this.agents.set(agent.id, { agent, dispose, deferred: new Set(names), revealed: new Set() })
  }

  /** Lift the denial for the tools a fetch just returned. */
  private reveal(agent: AgentLike, names: readonly string[]): void {
    const entry = this.agents.get(agent.id)
    const scoped = agent.ctx?.tools
    if (entry === undefined || scoped?.restrict === undefined) return
    let changed = false
    for (const name of names) {
      entry.revealed.add(name)
      if (entry.deferred.delete(name)) changed = true
    }
    if (!changed) return
    entry.dispose?.()
    entry.dispose = entry.deferred.size === 0 ? undefined : scoped.restrict({ deny: [...entry.deferred] })
  }

  /**
   * Recompute every live Agent's deny list against the settings as they now are.
   *
   * Two rules make this safe to run on any commit:
   *
   * - **Revealed names survive.** A settings edit is not a reason to take back a
   *   schema the model is already using; only names that left the eligible set
   *   drop out of `revealed` (nothing else can honour them).
   * - **Turning deferral off releases the restriction rather than widening it.**
   *   `deny: []` is not the same as no restriction at all — a released scope is
   *   what restores the Host's own default for every listener that observes the
   *   scope, so the setting's off position means "no restriction from us".
   */
  private syncRestrictions(): void {
    if (this.disposed) return
    const eligibleNames = new Set(this.eligible().map(schema => schema.name))
    for (const entry of this.agents.values()) {
      const scoped = entry.agent.ctx.tools as { restrict?: (input: { readonly deny: readonly string[] }) => () => void } | undefined
      if (scoped?.restrict === undefined) continue
      if (!this.enabled() || eligibleNames.size === 0) {
        entry.dispose?.()
        entry.dispose = undefined
        entry.deferred.clear()
        entry.revealed.clear()
        continue
      }
      for (const name of [...entry.revealed]) if (!eligibleNames.has(name)) entry.revealed.delete(name)
      const next = new Set([...eligibleNames].filter(name => !entry.revealed.has(name)))
      // Leave an unchanged list alone: re-restricting with identical contents
      // would churn the Agent's scope (and its tool block) for no gain.
      if (next.size === entry.deferred.size && [...next].every(name => entry.deferred.has(name))) continue
      entry.dispose?.()
      entry.deferred.clear()
      for (const name of next) entry.deferred.add(name)
      entry.dispose = next.size === 0 ? undefined : scoped.restrict({ deny: [...next] })
    }
  }

  status(): DeferredToolStatus {
    const eligible = this.eligible()
    const immediate = (this.tools?.schemas?.() ?? []).filter(schema => !eligible.some(entry => entry.name === schema.name))
    const charsOf = (schema: ToolSchemaLike): number => JSON.stringify(schema).length
    return {
      enabled: this.enabled(),
      deferred: eligible.map(schema => ({ name: schema.name, chars: charsOf(schema) })),
      deferredChars: eligible.reduce((total, schema) => total + charsOf(schema), 0),
      // Same density the spend measurements use, through the one entry point
      // that owns it.
      deferredTokens: tokensFromChars(eligible.reduce((total, schema) => total + charsOf(schema), 0)),
      immediateChars: immediate.reduce((total, schema) => total + charsOf(schema), 0),
      activeAgents: this.agents.size,
    }
  }

  private registerSearchTool(): void {
    const dispose = this.tools?.register(rawTool({
      name: 'tool_search',
      // Static on purpose: see the module header. A dynamic list here would bust
      // the prompt cache for every request that follows a settings change.
      // No concrete deferred tool name appears below. Naming one would go stale
      // the moment it is renamed, and would advertise a tool that a settings
      // change had already taken out of this session — see the module header.
      // `tool_search` names itself on purpose: it is never deferrable, so
      // referring to it can never dangle.
      description: 'Fetches full schema definitions for this plugin\'s deferred tools so they can be called. Until fetched, only the name is known and the tool cannot be invoked. Call tool_search with no query to list every deferred tool with a one-line summary, or with a query to get complete JSONSchema definitions back. Query forms: "select:<name>,<name>" fetches exact deferred tools by name; "<keyword>" is a keyword search over names and descriptions; "+<required> <rest>" requires the first term to appear in a tool name and ranks the matches by the remaining terms; "list:<prefix>" (or "list:all") returns names without schemas, which is how to see a name that the no-query listing had to group or summarise to stay inside its size budget. A tool becomes callable as soon as its schema appears in a result. One call returns at most 20 schemas whichever form is used; ask for the rest in another call.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Discovery query. Omit or leave empty to list all deferred tools with summaries.' },
          max_results: { type: 'integer', minimum: 1, maximum: MAX_TOOL_SEARCH_RESULTS, description: 'Maximum matches for a keyword query. Defaults to 10.' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      execute: async (args: { readonly query?: string; readonly max_results?: number }, exec: { readonly agent?: unknown }) => {
        const agent = exec?.agent as AgentLike | undefined
        const candidates = this.eligible()
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query === '') {
          if (candidates.length === 0) return 'No deferred tools: every tool this plugin provides is already in your schema.'
          // Priced and bounded: the index degrades to bare names and then to
          // per-prefix groups rather than growing with the catalog, and every
          // level says what it dropped and how to ask for it.
          return renderToolCatalog(catalogEntries(candidates)).text
        }
        const parsed = parseToolSearchQuery(query)
        if (parsed.list !== undefined) {
          // Names only, and deliberately no reveal: the model has not been shown
          // these schemas, so the listing must not imply the names are callable.
          return renderDeferredNameList(candidates, parsed.list)
        }
        const matches = matchDeferredTools(query, candidates, args?.max_results ?? 10)
        if (matches.length === 0) {
          // Bounded like the index it stands in for. Naming every candidate was
          // unbounded text reachable by a typo, and a miss cost more than the
          // listing the model was trying to use — 2.7k tokens on a 400-tool
          // catalog. `renderDeferredNameList` already knows how to say what it
          // left out and how to ask for the rest.
          return `No deferred tool matched "${query}".\n\n${renderDeferredNameList(catalogEntries(candidates), 'all', MAX_TOOL_SEARCH_RESULTS)}\n\ntool_search("list:all") lists every deferred name, and tool_search("list:<prefix>") narrows to one group.`
        }
        // One call fetches at most `MAX_TOOL_SEARCH_RESULTS` schemas, whatever the
        // form: the result *is* the context cost, and `select:` names its own
        // length. The remainder is named as unfetched rather than dropped
        // silently, and stays denied, so widening the model's surface stays a
        // deliberate act rather than a side effect of one long query.
        const fetched = matches.slice(0, MAX_TOOL_SEARCH_RESULTS)
        const unfetched = matches.length - fetched.length
        if (agent !== undefined) this.reveal(agent, fetched.map(schema => schema.name))
        const blocks = fetched
          .map(schema => `<function>${JSON.stringify({ name: schema.name, description: schema.description ?? '', parameters: schema.parameters ?? { type: 'object', properties: {} } })}</function>`)
          .join('\n')
        const remainder = unfetched === 0
          ? ''
          : `\n\n${String(unfetched)} further match${unfetched === 1 ? '' : 'es'} did not fit this call's ceiling of ${String(MAX_TOOL_SEARCH_RESULTS)} schemas and stay unfetched — ask for them by name in another call, e.g. tool_search("select:<name>").`
        return `<functions>\n${blocks}\n</functions>\n\nThese tools are now callable exactly like any other tool. Any deferred tool not listed here is still un-fetched — including one that a description above points you at — so fetch it the same way before calling it.${remainder}`
      },
      presentCall: (args: { readonly query?: string }) => ({
        card: 'generic',
        title: args?.query === undefined || args.query.trim() === ''
          ? 'List deferred tools'
          : `Search deferred tools: ${args.query}`,
      }),
    }))
    this.ctx.effect(() => () => { if (typeof dispose === 'function') dispose() }, 'freecodego: deferred tool search')
  }
}
