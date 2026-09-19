/**
 * Every durable FreeCodeGo session record is written by one package and read by
 * another, and the reader nearly always goes through a cast — `data as
 * Record<string, unknown>`, `event.data as Partial<AgentEnginePlan>` — because
 * the record type is declared in the package that mints it. That cast is exactly
 * where a field-name divergence lives: TypeScript sees `unknown`, so reading a
 * field nobody writes compiles, tests pass on both sides, and the reader silently
 * produces `undefined`.
 *
 * This spec is the gate for that class. It was written after one instance of it:
 * `compileTurnObservation` read `data.engine` / `data.model` from three record
 * types that store `engineId` / `modelId`, so every deepseek session (the default
 * engine) compiled evidence with no engine and every session compiled it with no
 * model. Each side had tests; none of them compared the two.
 *
 * Four rules, each failing with the fields it holds responsible:
 *
 * 1. **Vocabulary** — the contract table and `freeCodeGoSessionEventTypes` name
 *    the same events, so a new record type has to be declared here.
 * 2. **Coverage** — the number of use sites per file is declared, so a new
 *    writer or reader is noticed even when its author does not touch the table.
 *    The scan reads `.ts` and `.tsx` across every package under `packages/
 *    freecodego`: a client component is a consumer of these records too, and the
 *    one that renders delegated-Agent progress lives in a `.tsx` file. Leaving it
 *    out made this table describe every reader except the most visible one.
 * 3. **Fields** — a reader's `required` fields must be stored by a writer of one
 *    of the records it folds, and its `fallbacks` must be either stored or
 *    declared in `unwritten`. A writer's fields must be read by somebody or
 *    listed in `unread` with a reason, so a durable field with no reader is a
 *    decision rather than an accident.
 * 4. **Anchors** — every declared site resolves to exactly one place in the
 *    source, that anchor names its own event, and its line carries a use site of
 *    that event. A declaration cannot drift onto a different record.
 *
 * The table is a *description* of the source, so it has to be maintained with it.
 * That is the point: it is the review step the casts removed.
 *
 * What this does not do
 * ---------------------
 * It does not parse a reader's field accesses out of its source. `required` and
 * `fallbacks` are a claim the author makes, and the spec holds that claim to the
 * writers — the site is verifiable, the content is not. A reader's field reads
 * are also often a different statement from the site that finds the record (the
 * `findLast` assigns a variable and the fields are read fifteen lines later), so
 * a mechanical derivation would have to model each file's shape. The failure mode
 * removed here is narrower than "any divergence is impossible": it is that two
 * sides of one contract had no place where they were ever compared. Editing a
 * reader now means stating what it needs, and the spec checks that statement.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { freeCodeGoSessionEventTypes } from '../src/session-events.ts'

/** `packages/freecodego`, the root every file below is named from. */
const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * A place that stores a record.
 *
 * `fields` is every key the site can store, including keys a spread guard writes
 * only sometimes — a reader has to tolerate an absent key either way. `carried`
 * marks a payload built elsewhere and appended whole, where `fields` lists only
 * the keys a reader in this workspace depends on by name.
 */
interface Writer {
  readonly file: string
  readonly anchor: string
  readonly anchorIndex?: number
  readonly fields: readonly string[]
  readonly carried?: true
}

/**
 * A place that consumes a record.
 *
 * `events` names the records a single reader folds together — a branch that
 * inspects one field across three record types is one reader, and a field it
 * requires may be stored by any of them. `whole` marks a reader that keeps the
 * record as it stands (a report stored into a map), which exempts the event from
 * rule 3's read-by-somebody half: its fields are passed on, not read here.
 */
interface Reader {
  readonly file: string
  readonly anchor: string
  readonly anchorIndex?: number
  readonly events?: readonly string[]
  readonly required?: readonly string[]
  readonly fallbacks?: readonly string[]
  readonly whole?: true
  /** What this site does, for the sites that read no field at all. */
  readonly note?: string
}

interface Contract {
  /** Use sites per file, so a new one cannot arrive unnoticed. */
  readonly uses: Readonly<Record<string, number>>
  readonly writers: readonly Writer[]
  readonly readers: readonly Reader[]
  /** Read as a fallback but stored by no writer in this workspace. */
  readonly unwritten?: readonly string[]
  /** Stored but read by nobody in this workspace, and why that is deliberate. */
  readonly unread?: { readonly fields: readonly string[]; readonly why: string }
}

/**
 * The records this plugin mints, and who reads each field.
 *
 * Field lists are read off the writers, not remembered: `agent-engine/selected`
 * and `freecodego/engine-executor` are minted by the router, `freecodego/
 * native-session` by root-agent, the Advisor and council families by
 * harness-plugin, and the engine-executor reader chain that reaches a stale
 * `engine`/`modelId` is the tolerance documented in `unwritten` below.
 */
const CONTRACTS: Readonly<Record<string, Contract>> = {
  'agent-engine/selected': {
    uses: {
      'agent-engine-router/src/index.ts': 1,
      'harness-plugin/src/engine-remotes.ts': 1,
      'harness-plugin/src/engineering-remote-utils.ts': 1,
      'harness-plugin/src/engineering.ts': 1,
      'root-agent/src/engine-plan.ts': 2,
    },
    writers: [
      {
        file: 'root-agent/src/engine-plan.ts',
        anchor: `session.append('agent-engine/selected', {`,
        fields: ['engineId', 'generation', 'artifactDigest', 'protocolAbi', 'modelId', 'routeBindingId', 'catalogRevision', 'capabilityFingerprint'],
      },
    ],
    readers: [
      {
        // Validates all eight before trusting the durable binding, so every field
        // this event stores has a reader by construction.
        file: 'agent-engine-router/src/index.ts',
        anchor: `find(event => event.type === 'agent-engine/selected')`,
        required: ['engineId', 'generation', 'artifactDigest', 'protocolAbi', 'modelId', 'routeBindingId', 'catalogRevision', 'capabilityFingerprint'],
      },
      {
        file: 'harness-plugin/src/engine-remotes.ts',
        anchor: `selection = events?.findLast(event => event.type === 'agent-engine/selected')`,
        required: ['engineId'],
        fallbacks: ['engine'],
      },
      {
        file: 'harness-plugin/src/engineering-remote-utils.ts',
        anchor: `const selected = [...events].reverse().find(event => event.type === 'agent-engine/selected')`,
        required: ['engineId'],
        fallbacks: ['engine'],
      },
      {
        // One branch folds three record types; `modelId` comes from this event,
        // which is why a missing key in either of the other two stays harmless.
        file: 'harness-plugin/src/engineering.ts',
        anchor: `event.type === 'agent-engine/selected' || event.type === 'freecodego/engine-executor'`,
        events: ['agent-engine/selected', 'freecodego/engine-executor', 'freecodego/native-session'],
        required: ['engineId', 'modelId'],
        fallbacks: ['engine', 'model'],
      },
    ],
    // Declared optional in the type map and reached only behind `engineId`; no
    // site in this workspace stores it, and the arm is kept so a record written
    // by an earlier build still answers.
    unwritten: ['engine', 'model'],
  },

  'freecodego/engine-executor': {
    uses: {
      'agent-engine-router/src/index.ts': 3,
      'harness-plugin/src/engine-remotes.ts': 1,
      'harness-plugin/src/engineering-remote-utils.ts': 1,
      'harness-plugin/src/engineering.ts': 1,
    },
    writers: [
      {
        file: 'agent-engine-router/src/index.ts',
        anchor: `session.append('freecodego/engine-executor', {`,
        fields: ['engineId', 'executor', 'provider'],
      },
    ],
    readers: [
      {
        file: 'agent-engine-router/src/index.ts',
        anchor: `some(event => event.type === 'freecodego/engine-executor')`,
        note: 'the write-once guard: asks whether the record exists, reads no field',
      },
      {
        file: 'harness-plugin/src/engine-remotes.ts',
        anchor: `executor = events?.findLast(event => event.type === 'freecodego/engine-executor')`,
        required: ['engineId', 'executor', 'provider'],
        fallbacks: ['engine', 'modelId'],
      },
      {
        file: 'harness-plugin/src/engineering-remote-utils.ts',
        anchor: `const executor = [...events].reverse().find(event => event.type === 'freecodego/engine-executor')`,
        required: ['engineId'],
        fallbacks: ['engine'],
      },
      {
        file: 'harness-plugin/src/engineering.ts',
        anchor: `event.type === 'freecodego/engine-executor' || event.type === 'freecodego/native-session'`,
        events: ['agent-engine/selected', 'freecodego/engine-executor', 'freecodego/native-session'],
        required: ['engineId', 'modelId'],
        fallbacks: ['engine', 'model'],
      },
    ],
    unwritten: ['engine', 'modelId', 'model'],
  },

  'freecodego/native-session': {
    uses: {
      'harness-plugin/src/engine-remotes.ts': 1,
      'harness-plugin/src/engineering.ts': 1,
      'root-agent/src/native-session-binding.ts': 3,
    },
    writers: [
      {
        file: 'root-agent/src/native-session-binding.ts',
        anchor: `if (existing === undefined) {\n    session.append('freecodego/native-session', binding)`,
        fields: ['engine', 'runtimeSessionId', 'artifactDigest', 'protocolAbi'],
      },
      {
        file: 'root-agent/src/native-session-binding.ts',
        anchor: `nativeSessionBinding(session, binding.engine, binding.artifactDigest, binding.protocolAbi)\n  session.append('freecodego/native-session', binding)`,
        fields: ['engine', 'runtimeSessionId', 'artifactDigest', 'protocolAbi'],
      },
    ],
    readers: [
      {
        // Reads the whole identity: it refuses a resumed session whose engine,
        // artifact or protocol moved, and returns the runtime id only then.
        file: 'root-agent/src/native-session-binding.ts',
        anchor: `findLast(candidate => candidate.type === 'freecodego/native-session')`,
        required: ['engine', 'runtimeSessionId', 'artifactDigest', 'protocolAbi'],
      },
      {
        file: 'harness-plugin/src/engine-remotes.ts',
        anchor: `nativeBinding = events?.findLast(event => event.type === 'freecodego/native-session')`,
        required: ['engine'],
        fallbacks: ['provider', 'modelId'],
      },
    ],
    // The record deliberately excludes the route — `native-session-binding.ts`
    // says credentials and provider secrets are out of scope — so the provider
    // and model arms behind it are tolerance for a record another build wrote.
    unwritten: ['provider', 'modelId'],
  },

  'advisor/note': {
    uses: {
      'harness-plugin/src/advisor.ts': 5,
      'harness-plugin/src/engineering-eval.ts': 1,
      'harness-plugin/src/managed-catalog-utils.ts': 1,
    },
    writers: [
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `agent.session.append('advisor/note', { id, severity: advice.severity`,
        fields: ['id', 'severity', 'note', 'turn'],
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `filter(event => event.type === 'advisor/note').map(event => event.data.id)`,
        required: ['id'],
      },
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `candidate.type === 'advisor/note' && !previousIds.has(candidate.data.id)`,
        required: ['id'],
      },
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `return event?.type === 'advisor/note' ? event.data : undefined`,
        whole: true,
        note: 'returns the record itself as the review result',
      },
      {
        // The same predicate text appears in the `previousIds` reader above; this
        // is its second occurrence, the one that lists recent notes.
        file: 'harness-plugin/src/advisor.ts',
        anchor: `.filter(event => event.type === 'advisor/note')`,
        anchorIndex: 1,
        whole: true,
        note: 'lists recent notes, spreading each record',
      },
      {
        file: 'harness-plugin/src/managed-catalog-utils.ts',
        anchor: `if (event.type !== 'advisor/note') return []`,
        required: ['id', 'note', 'turn', 'severity'],
      },
      {
        file: 'harness-plugin/src/engineering-eval.ts',
        anchor: `declared.includes('advisor/note')`,
        note: 'asserts a session declares this event type; reads no field of it',
      },
    ],
  },

  'advisor/delivery': {
    uses: { 'harness-plugin/src/advisor.ts': 2, 'harness-plugin/src/managed-catalog-utils.ts': 1 },
    writers: [
      { file: 'harness-plugin/src/advisor.ts', anchor: `agent.session.append('advisor/delivery', { id, channel })`, fields: ['id', 'channel'] },
    ],
    readers: [
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `if (event.type === 'advisor/delivery') deliveries.set(event.data.id, event.data.channel)`,
        required: ['id', 'channel'],
      },
      {
        file: 'harness-plugin/src/managed-catalog-utils.ts',
        anchor: `if (event.type !== 'advisor/delivery') continue`,
        required: ['id', 'channel'],
      },
    ],
  },

  'advisor/state': {
    uses: { 'harness-plugin/src/advisor.ts': 3 },
    writers: [
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `safeAppend(agent.session, 'advisor/state', { state: 'no-model'`,
        fields: ['state', 'message'],
      },
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `safeAppend(agent.session, 'advisor/state', { state: 'error'`,
        fields: ['state', 'message'],
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `function safeAppend<T extends 'advisor/state' | 'advisor/usage'>`,
        note: "the write helper's type parameter names the two events it may store, and it reads no field",
      },
    ],
    unread: {
      fields: ['state', 'message'],
      why: 'a durable diagnostic for the session log: the review runtime keeps its live status in memory and reads this record back nowhere in this workspace',
    },
  },

  'advisor/usage': {
    uses: { 'harness-plugin/src/advisor.ts': 2 },
    writers: [
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `safeAppend(agent.session, 'advisor/usage', { provider: route.provider`,
        fields: ['provider', 'model', 'inputTokens', 'outputTokens'],
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `function safeAppend<T extends 'advisor/state' | 'advisor/usage'>`,
        note: 'the same write helper as advisor/state, from the other side of its type parameter',
      },
    ],
    unread: {
      fields: ['provider', 'model', 'inputTokens', 'outputTokens'],
      why: 'per-request token accounting for the session log; the runtime budgets side channels in memory, so nothing replays this record',
    },
  },

  'advisor/council': {
    uses: { 'harness-plugin/src/advisor.ts': 1, 'harness-plugin/src/managed-catalog-utils.ts': 1 },
    writers: [
      {
        file: 'harness-plugin/src/advisor.ts',
        anchor: `agent.session.append('advisor/council', report)`,
        fields: ['id', 'sessionId', 'turn', 'provider', 'model', 'createdAt', 'findings'],
        carried: true,
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/managed-catalog-utils.ts',
        anchor: `if (event.type !== 'advisor/council') return []`,
        required: ['id', 'turn', 'provider', 'model', 'createdAt', 'findings'],
        fallbacks: ['sessionId'],
        whole: true,
      },
    ],
  },

  'freecodego/council-task': {
    uses: { 'harness-plugin/src/engine-council.ts': 3, 'harness-plugin/src/engineering-remote-utils.ts': 1 },
    writers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `parent.session.append('freecodego/council-task', {`,
        fields: ['job', 'request', 'policyDigest'],
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `find(event => event.type === 'freecodego/council-task' && event.data.job.id === id)`,
        required: ['job'],
        whole: true,
      },
      {
        file: 'harness-plugin/src/engineering-remote-utils.ts',
        anchor: `if (event.type !== 'freecodego/council-task'`,
        required: ['request'],
      },
    ],
  },

  'freecodego/council': {
    uses: { 'harness-plugin/src/engine-council.ts': 2, 'harness-plugin/src/engineering-eval.ts': 1, 'harness-plugin/src/engineering-remote-utils.ts': 1 },
    writers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `parent.session.append('freecodego/council', report)`,
        fields: ['id'],
        carried: true,
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `if (event.type === 'freecodego/council') {`,
        required: ['id'],
        whole: true,
      },
      {
        file: 'harness-plugin/src/engineering-eval.ts',
        anchor: `declared.includes('freecodego/council')`,
        note: 'asserts a session declares this event type; reads no field of it',
      },
      {
        file: 'harness-plugin/src/engineering-remote-utils.ts',
        anchor: `if (event.type === 'freecodego/council') {`,
        events: ['freecodego/council', 'freecodego/council-state'],
        required: ['id', 'state'],
        note: 'decides whether an automatic council may be retried for an approved plan; a report state of completed/partial/blocked is the review',
      },
    ],
  },

  'freecodego/council-state': {
    uses: { 'harness-plugin/src/engine-council.ts': 3, 'harness-plugin/src/engineering-remote-utils.ts': 1 },
    writers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `parent.session.append('freecodego/council-state', { id, state, updatedAt`,
        fields: ['id', 'state', 'updatedAt', 'error'],
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `find(event => event.type === 'freecodego/council-state' && event.data.id === id)`,
        required: ['id', 'state', 'updatedAt', 'error'],
        whole: true,
      },
      {
        file: 'harness-plugin/src/engineering-remote-utils.ts',
        anchor: `if (event.type === 'freecodego/council-state' && typeof data.state === 'string')`,
        events: ['freecodego/council', 'freecodego/council-state'],
        required: ['id', 'state'],
        note: 'the attempt\'s last lifecycle state, for the same retry decision as its report',
      },
    ],
  },

  'freecodego/council-decision': {
    uses: { 'harness-plugin/src/engine-council.ts': 2 },
    writers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `parent.session.append('freecodego/council-decision', decision)`,
        fields: ['id', 'state', 'decidedAt', 'planDigest', 'workspaceRevision', 'policyDigest', 'expiresAt'],
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `if (event.type === 'freecodego/council-decision') {`,
        required: ['id'],
        whole: true,
      },
    ],
  },

  'freecodego/council-implementation': {
    uses: { 'harness-plugin/src/engine-council.ts': 2 },
    writers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `parent.session.append('freecodego/council-implementation', implementation)`,
        fields: ['id', 'completedAt', 'summary', 'workspaceRevision'],
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `if (event.type === 'freecodego/council-implementation') {`,
        required: ['id'],
        whole: true,
      },
    ],
  },

  'freecodego/council-verification': {
    uses: { 'harness-plugin/src/engine-council.ts': 2 },
    writers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `parent.session.append('freecodego/council-verification', verification)`,
        fields: ['id', 'result'],
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/engine-council.ts',
        anchor: `if (event.type === 'freecodego/council-verification') {`,
        required: ['id', 'result'],
        whole: true,
      },
    ],
  },

  'freecodego/agent-progress': {
    uses: { 'harness-plugin/src/agent-progress.ts': 3, 'harness-ui/src/client/agent-progress.tsx': 1 },
    writers: [
      {
        file: 'harness-plugin/src/agent-progress.ts',
        anchor: `state.session.append('freecodego/agent-progress', snapshot)`,
        fields: [
          'version', 'phase', 'parentSessionId', 'agents', 'todos', 'updatedAt', 'turn', 'step',
          // Dotted paths name the keys inside one `agents` entry, which
          // `snapshotEntry` builds in another function. A `carried` payload's
          // reader-relevant keys belong in the declaration for that reason: the
          // client reads eleven of them by name, and a rename inside the entry
          // would otherwise be visible only in the browser.
          'agents[].id', 'agents[].label', 'agents[].state', 'agents[].toolUses', 'agents[].startedAt',
          'agents[].updatedAt', 'agents[].task', 'agents[].currentTool', 'agents[].tokens',
          'agents[].finishedAt', 'agents[].error',
          'todos[].content', 'todos[].status',
        ],
        carried: true,
      },
    ],
    readers: [
      {
        file: 'harness-plugin/src/agent-progress.ts',
        anchor: `if (raw.type !== 'freecodego/agent-progress') state.foreignEvents += 1`,
        note: 'counts the child records that belong to another session; reads no field',
      },
      {
        file: 'harness-plugin/src/agent-progress.ts',
        anchor: `findLast(event => event.type === 'freecodego/agent-progress')`,
        required: ['agents', 'todos'],
      },
      {
        // The transcript progress tree. It reads the snapshot whole — the header
        // counts, the per-row state, tool, task, error and the elapsed clock, and
        // the focus-chain strip — so its fields are listed as the keys it names
        // rather than as a subset it must have.
        file: 'harness-ui/src/client/agent-progress.tsx',
        anchor: `if (event.type !== 'freecodego/agent-progress') return undefined`,
        required: [
          'parentSessionId', 'phase', 'agents',
          'agents[].id', 'agents[].label', 'agents[].state', 'agents[].toolUses', 'agents[].startedAt',
          'agents[].updatedAt', 'agents[].task', 'agents[].currentTool', 'agents[].finishedAt', 'agents[].error',
          'todos[].content', 'todos[].status',
        ],
        whole: true,
        note: 'renders the delegated-Agent progress tree in the transcript',
      },
    ],
  },

  'freecodego/hook-invoked': {
    uses: { 'harness-plugin/src/index.ts': 1 },
    writers: [
      {
        file: 'harness-plugin/src/index.ts',
        anchor: `'freecodego/hook-invoked' : 'freecodego/hook-result',`,
        fields: ['hook_event_name', 'matcher', 'sources', 'command', 'status', 'exitCode', 'message', 'durationMs'],
      },
    ],
    readers: [],
    unread: {
      fields: ['hook_event_name', 'matcher', 'sources', 'command', 'status', 'exitCode', 'message', 'durationMs'],
      why: 'the dispatch record reaches the session log for a reader outside this workspace (`hook-protocol` shapes); nothing in the plugin replays it',
    },
  },

  'freecodego/hook-result': {
    uses: { 'harness-plugin/src/index.ts': 1 },
    writers: [
      {
        file: 'harness-plugin/src/index.ts',
        anchor: `: 'freecodego/hook-result',`,
        fields: ['hook_event_name', 'matcher', 'sources', 'command', 'status', 'exitCode', 'message', 'durationMs'],
      },
    ],
    readers: [],
    unread: {
      fields: ['hook_event_name', 'matcher', 'sources', 'command', 'status', 'exitCode', 'message', 'durationMs'],
      why: 'the same dispatch record on its result arm; the record is the observable, not an input to a later decision',
    },
  },
}

/** Directories that hold no source this spec is about. */
const SCAN_SKIP = new Set(['lib', 'node_modules', 'tests', 'dist', 'assets'])

function scanTargets(): readonly string[] {
  const found: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(PACKAGES, relative), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SCAN_SKIP.has(entry.name)) walk(`${relative}/${entry.name}`)
        continue
      }
      if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !entry.name.endsWith('.d.ts')) found.push(`${relative}/${entry.name}`)
    }
  }
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    if (existsSync(join(PACKAGES, entry.name, 'src'))) walk(`${entry.name}/src`)
  }
  return found
}

const sources = new Map<string, string>()

/** Source with line endings normalised, so an anchor may span lines. */
function source(file: string): string {
  const cached = sources.get(file)
  if (cached !== undefined) return cached
  const text = readFileSync(join(PACKAGES, file), 'utf8').replace(/\r\n/gu, '\n')
  sources.set(file, text)
  return text
}

/** A `SessionEventMap` member, as a line-leading literal. */
const TYPE_MAP_MEMBER = /^\s*'[^']+'\s*:(?:\s|$)/
/** An entry of `freeCodeGoSessionEventTypes`, as a line-leading literal. */
const VOCABULARY_ENTRY = /^\s*'[^']+',\s*$/

interface Occurrence {
  readonly file: string
  readonly line: number
  /** A type map key or a vocabulary entry, rather than a use of the event. */
  readonly declaration: boolean
}

function occurrencesIn(file: string, type: string): readonly Occurrence[] {
  const text = source(file)
  const found: Occurrence[] = []
  const literal = `'${type}'`
  let index = text.indexOf(literal)
  while (index !== -1) {
    const lineStart = text.lastIndexOf('\n', index) + 1
    const lineEnd = text.indexOf('\n', index)
    const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
    const leading = text.slice(lineStart, index)
    found.push({
      file,
      line: text.slice(0, index).split('\n').length,
      // A literal that opens its line is a declaration: a `SessionEventMap` member
      // or an entry of the vocabulary array. A line-leading literal of any other
      // shape is *not* treated as one — it stays a use site, so the count below
      // reports it and `OBSERVED.shapes` names it.
      declaration: leading.trim() === '' && (TYPE_MAP_MEMBER.test(lineText) || VOCABULARY_ENTRY.test(lineText)),
    })
    index = text.indexOf(literal, index + literal.length)
  }
  return found
}

const OBSERVED = ((): {
  readonly files: readonly string[]
  readonly uses: ReadonlyMap<string, number>
  readonly lines: ReadonlyMap<string, ReadonlySet<number>>
  readonly shapes: readonly string[]
} => {
  const files = scanTargets()
  const uses = new Map<string, number>()
  const lines = new Map<string, Map<number, true>>()
  const shapes: string[] = []
  for (const file of files) {
    for (const type of freeCodeGoSessionEventTypes) {
      for (const occurrence of occurrencesIn(file, type)) {
        const key = `${file}|${type}`
        if (occurrence.declaration) continue
        // A literal that opens a line but is neither declaration shape is either a
        // formatting drift this classifier no longer understands or an unusual use
        // site; it is reported *and* counted, so it cannot slip through as one.
        const lineText = source(file).split('\n')[occurrence.line - 1] ?? ''
        const before = lineText.slice(0, Math.max(0, lineText.indexOf(`'${type}'`)))
        if (before.trim() === '') shapes.push(`${file}:${occurrence.line} ${lineText.trim()}`)
        uses.set(key, (uses.get(key) ?? 0) + 1)
        const byLine = lines.get(key) ?? new Map<number, true>()
        byLine.set(occurrence.line, true)
        lines.set(key, byLine)
      }
    }
  }
  return {
    files,
    uses,
    lines: new Map([...lines].map(([key, value]) => [key, new Set(value.keys())])),
    shapes,
  }
})()

/** The keys a writer stores for one event. */
function writtenFields(event: string, contracts: Readonly<Record<string, Contract>> = CONTRACTS): readonly string[] {
  const fields = new Set<string>()
  for (const writer of contracts[event]?.writers ?? []) {
    for (const field of writer.fields) fields.add(field)
  }
  return [...fields]
}

/**
 * Rule 3 as a function, so its own behaviour is testable.
 *
 * `no writer` is the failure this spec exists for: a reader names a field that
 * every writer of the records it folds leaves out, which the cast to `unknown`
 * made invisible.
 */
function fieldGaps(contracts: Readonly<Record<string, Contract>>): readonly string[] {
  const gaps: string[] = []
  for (const [event, contract] of Object.entries(contracts)) {
    const unwritten = new Set(contract.unwritten ?? [])
    for (const reader of contract.readers) {
      const folded = reader.events ?? [event]
      const known = new Set<string>()
      for (const name of folded) for (const field of writtenFields(name, contracts)) known.add(field)
      for (const field of reader.required ?? []) {
        if (known.has(field)) continue
        gaps.push(
          `${reader.file} requires "${field}" of ${folded.join('/')}, but ` +
          `no writer of those records stores it (writers store: ${[...known].sort().join(', ') || 'nothing'})` +
          `${reader.note === undefined ? '' : ` [${reader.note}]`}`,
        )
      }
      for (const field of reader.fallbacks ?? []) {
        if (known.has(field) || unwritten.has(field)) continue
        gaps.push(
          `${reader.file} reads "${field}" as a fallback of ${folded.join('/')}, but no writer stores it ` +
          'and it is not declared in `unwritten` with a reason',
        )
      }
    }
    // Stored but never read, and never explained.
    const read = new Set<string>()
    let whole = false
    for (const reader of contract.readers) {
      if (reader.whole === true && reader.events === undefined) whole = true
      for (const field of reader.required ?? []) read.add(field)
      for (const field of reader.fallbacks ?? []) read.add(field)
    }
    const unread = new Set(contract.unread?.fields ?? [])
    if (whole) continue
    for (const field of writtenFields(event, contracts)) {
      if (read.has(field) || unread.has(field)) continue
      gaps.push(`${event} stores "${field}" and nothing reads it, and no \`unread\` reason declares that`)
    }
  }
  return gaps
}

/** Resolves a site's anchor to the lines it covers, failing when it drifted. */
function anchorSpan(site: { file: string; anchor: string; anchorIndex?: number }, type: string): readonly number[] {
  const text = source(site.file)
  const positions: number[] = []
  let index = text.indexOf(site.anchor)
  while (index !== -1) {
    positions.push(index)
    index = text.indexOf(site.anchor, index + 1)
  }
  expect(positions.length, `${site.file}: anchor not found — ${JSON.stringify(site.anchor)}`).toBeGreaterThan(0)
  if (site.anchorIndex === undefined) {
    expect(
      positions.length,
      `${site.file}: ${positions.length} sites share this anchor; give one an anchorIndex — ${JSON.stringify(site.anchor)}`,
    ).toBe(1)
  }
  expect(
    site.anchor,
    `${site.file}: an anchor must name the event it is declared for`,
  ).toContain(`'${type}'`)
  const position = positions[site.anchorIndex ?? 0]
  const start = text.slice(0, position ?? 0).split('\n').length
  const span = (site.anchor.match(/\n/gu) ?? []).length
  return Array.from({ length: span + 1 }, (_value, offset) => start + offset)
}

describe('session event contracts', () => {
  it('declares exactly the vocabulary the plugin registers', () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual([...freeCodeGoSessionEventTypes].sort())
  })

  it('classifies every event literal as a declaration or a use', () => {
    expect(OBSERVED.shapes).toEqual([])
  })

  it('finds a writer, and a reader or a recorded reason, for every record it declares', () => {
    const missing = Object.entries(CONTRACTS)
      .filter(([, contract]) => contract.writers.length === 0 || (contract.readers.length === 0 && contract.unread === undefined))
      .map(([event]) => event)
    expect(missing).toEqual([])
  })

  for (const [event, contract] of Object.entries(CONTRACTS)) {
    describe(event, () => {
      it('has the declared number of use sites', () => {
        const observed = Object.fromEntries(
          [...OBSERVED.uses]
            .filter(([key]) => key.endsWith(`|${event}`))
            .map(([key, count]) => [key.slice(0, -(event.length + 1)), count]),
        )
        // A new writer or reader must be declared: the count is the reminder that
        // this table describes the source, and the field rule is what a mismatched
        // reader is caught by.
        expect(observed, `use sites of ${event} changed — update CONTRACTS`).toEqual(contract.uses)
      })

      it('declares sites that resolve to a use site of this event', () => {
        for (const site of [...contract.writers, ...contract.readers]) {
          const span = anchorSpan(site, event)
          const lines = OBSERVED.lines.get(`${site.file}|${event}`) ?? new Set<number>()
          expect(
            span.some(line => lines.has(line)),
            `${site.file}: anchor covers lines ${span.join(',')}, which carry no use site of ${event}`,
          ).toBe(true)
        }
      })
    })
  }

  it('reads only fields a writer of the records it folds stores', () => {
    expect(fieldGaps(CONTRACTS)).toEqual([])
  })

  it('reports a reader field no writer stores, which is the defect this gate exists for', () => {
    // Falsifiability, without touching the source: the shape of the bug that
    // `compileTurnObservation` had, so this rule cannot rot into a no-op.
    const divergent: Readonly<Record<string, Contract>> = {
      'agent-engine/selected': {
        uses: {},
        writers: [{ file: 'root-agent/src/engine-plan.ts', anchor: `session.append('agent-engine/selected', {`, fields: ['engineId', 'modelId'] }],
        readers: [
          {
            file: 'harness-plugin/src/engineering.ts',
            anchor: `event.type === 'agent-engine/selected'`,
            required: ['engineId', 'modelId'],
            fallbacks: ['engine'],
          },
        ],
      },
    }
    expect(fieldGaps(divergent)).toEqual([
      'harness-plugin/src/engineering.ts reads "engine" as a fallback of agent-engine/selected, but no writer stores it and it is not declared in `unwritten` with a reason',
    ])
    const satisfied: Readonly<Record<string, Contract>> = {
      'agent-engine/selected': {
        uses: {},
        writers: [{ file: 'root-agent/src/engine-plan.ts', anchor: `session.append('agent-engine/selected', {`, fields: ['engineId', 'modelId'] }],
        readers: [
          {
            file: 'harness-plugin/src/engineering.ts',
            anchor: `event.type === 'agent-engine/selected'`,
            required: ['engineId', 'modelId'],
            fallbacks: ['engine'],
          },
        ],
        unwritten: ['engine'],
      },
    }
    expect(fieldGaps(satisfied)).toEqual([])
  })
})
