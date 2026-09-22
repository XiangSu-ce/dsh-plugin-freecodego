/** Durable parent-session progress projection for delegated Agent work. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { FreeCodeGoFocusTodo } from './types.ts'
import { stripMemoryContextSections } from './memory-context.ts'

/**
 * Lifecycle state of one child agent, as the progress surface reports it.
 */
export type FreeCodeGoAgentProgressState =
  | 'queued'
  | 'running'
  | 'stalled'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * One child agent inside a progress snapshot.
 */
export interface FreeCodeGoAgentProgressEntry {
  readonly id: string
  readonly label: string
  readonly task?: string | undefined
  readonly state: FreeCodeGoAgentProgressState
  readonly currentTool?: string | undefined
  readonly toolUses: number
  readonly tokens?: number
  readonly startedAt: number
  readonly updatedAt: number
  readonly finishedAt?: number | undefined
  readonly error?: string | undefined
}

/**
 * One whole progress snapshot, sent when a child agent starts or updates.
 */
export interface FreeCodeGoAgentProgressSnapshot {
  readonly version: 1
  readonly phase: 'start' | 'update'
  readonly parentSessionId: string
  readonly agents: readonly FreeCodeGoAgentProgressEntry[]
  /** Latest whole-list todo plan (todo/write) — the Focus Chain surface. */
  readonly todos?: readonly FreeCodeGoFocusTodo[]
  readonly updatedAt: number
  readonly turn: number
  readonly step: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Informational parent-session projection of delegated Agent activity. */
    'freecodego/agent-progress': FreeCodeGoAgentProgressSnapshot
  }
}

type MutableEntry = {
  id: string
  label: string
  task?: string | undefined
  state: FreeCodeGoAgentProgressState
  currentTool?: string | undefined
  toolUses: number
  tokens?: number
  startedAt: number
  updatedAt: number
  finishedAt?: number | undefined
  error?: string | undefined
}

type ParentState = {
  readonly session: Session
  readonly agents: Map<string, MutableEntry>
  /** Latest whole-list todo plan from the parent session (todo/write). */
  todos?: readonly FreeCodeGoFocusTodo[] | undefined
  tail: Promise<void>
  lastKey?: string
  published: boolean
  /** Foreign (non-progress) events seen; keys the turn/step cache. */
  foreignEvents: number
  turnCache?: { readonly foreignEvents: number; readonly turn: number; readonly step: number }
}

type AgentLike = Agent & {
  readonly options?: { readonly model?: string }
}

const MAX_LABEL_CHARS = 160
const MAX_TASK_CHARS = 1_000
const MAX_TOOL_CHARS = 120
/** Terminal children stay visible briefly, then leave the active snapshot. */
const TERMINAL_RETENTION_MS = 10 * 60 * 1_000
/** Recent terminal entries always retained regardless of age. */
const MAX_RETAINED_TERMINAL = 8

/** Aggregate child lifecycle and tool events into a parent-session snapshot. */
export class FreeCodeGoAgentProgressRuntime {
  private readonly parents = new Map<string, ParentState>()
  private readonly childParents = new Map<string, string>()
  private disposed = false
  private readonly watchdog: ReturnType<typeof setInterval>

  constructor(private readonly ctx: Context) {
    ctx.on('agent/created', ({ agent }) => { this.observeAgent(agent) })
    ctx.on('agent/status', ({ agent, status }) => { this.observeStatus(agent, status) })
    ctx.on('session/event', (session, event) => { this.observeSessionEvent(session, event) })
    ctx.on('agent/disposed', ({ agent }) => { this.observeDisposed(agent) })
    for (const agent of ctx.agents.list()) this.observeAgent(agent)
    this.watchdog = setInterval(() => { this.markStalled() }, 15_000)
    // Unref'd like every other plugin interval (the update check and the
    // WorkBuddy sweep), so a Host that is otherwise idle can still exit: this
    // watchdog observes stalled children, and it is not a reason to stay alive.
    this.watchdog.unref?.()
  }

  /** Stop the watchdog and drop every tracked parent/child relationship. */
  dispose(): void {
    this.disposed = true
    clearInterval(this.watchdog)
    this.parents.clear()
    this.childParents.clear()
  }

  private observeAgent(agent: AgentLike): void {
    if (this.disposed) return
    const parentId = agent.session.header.parentSession
    if (parentId === undefined || parentId === agent.id) return
    const parent = this.ctx.sessions.get(parentId)
    if (parent === undefined) return
    this.childParents.set(String(agent.id), String(parentId))
    const state = this.parentState(parent)
    const existing = state.agents.get(String(agent.id))
    if (existing !== undefined) {
      this.hydrateEntry(existing, agent.session)
      this.publish(state)
      return
    }
    const now = Date.now()
    const entry: MutableEntry = {
      id: String(agent.id),
      label: String(agent.id).slice(0, MAX_LABEL_CHARS),
      state: 'queued',
      toolUses: 0,
      startedAt: now,
      updatedAt: now,
    }
    this.hydrateEntry(entry, agent.session)
    state.agents.set(String(agent.id), entry)
    this.publish(state)
  }

  private observeStatus(agent: AgentLike, status: 'idle' | 'running'): void {
    const parentId = this.childParents.get(String(agent.id)) ?? this.parentIdOf(agent)
    if (parentId === undefined) return
    const parent = this.ctx.sessions.get(parentId as SessionId)
    if (parent === undefined) return
    const state = this.parentState(parent)
    const entry = this.ensureEntry(state, agent)
    // The agent loop emits a synchronous idle right after a failed turn's
    // turn/end; an idle must not erase a terminal failure/cancellation that
    // the parent-visible snapshot already recorded.
    if (status === 'idle' && (entry.state === 'failed' || entry.state === 'cancelled')) return
    entry.state = status
    entry.updatedAt = Date.now()
    this.publish(state)
  }

  /** Surface wedged children without killing long-running provider calls. */
  private markStalled(): void {
    const cutoff = Date.now() - 90_000
    for (const state of this.parents.values()) {
      let changed = false
      for (const entry of state.agents.values()) {
        if ((entry.state === 'running' || entry.state === 'queued') && entry.updatedAt < cutoff) {
          entry.state = 'stalled'
          entry.updatedAt = Date.now()
          changed = true
        }
      }
      if (changed) this.publish(state)
    }
  }

  /** A late assistant message proves a stalled child is alive again. */
  private reviveStalled(entry: MutableEntry): void {
    if (entry.state === 'stalled') {
      entry.state = 'running'
      entry.updatedAt = Date.now()
    }
  }

  private observeSessionEvent(session: Session, event: SessionEvent): void {
    const raw = event as unknown as { readonly type: string; readonly data: Record<string, unknown> }
    // The todo plan is host-session state owned by the parent session itself:
    // absorb it even when the emitting session is the tracked parent (it has
    // no parentSession header, so the delegation gate below would skip it).
    if (raw.type === 'todo/write') {
      const tracked = this.parents.get(String(session.id))
      if (tracked !== undefined) {
        const todos = focusTodos(raw.data.todos)
        if (todos !== undefined && !sameTodos(tracked.todos, todos)) {
          tracked.todos = todos
          this.publish(tracked, event)
        }
      }
    }
    const parentId = this.childParents.get(String(session.id)) ?? this.parentIdOfSession(session)
    if (parentId === undefined) return
    const parent = this.ctx.sessions.get(parentId as SessionId)
    if (parent === undefined) return
    const state = this.parentState(parent)
    const agent = this.ctx.agents.get(session.id)
    // Key the entry by the parent-visible child id; when the host's agent
    // registry disagrees with the emitting session id (test doubles, early
    // events), the session id keeps entries discoverable for later events.
    const entry = agent !== undefined && state.agents.has(String(agent.id))
      ? state.agents.get(String(agent.id))!
      : this.ensureEntry(state, agent, String(session.id))
    let changed = false
    // Our own appended progress events come back through this observer; they
    // are not foreign activity and must not invalidate the turn/step cache.
    if (raw.type !== 'freecodego/agent-progress') state.foreignEvents += 1
    // Child-session todo plans also flow into the parent's plan strip.
    if (raw.type === 'todo/write') {
      const todos = focusTodos(raw.data.todos)
      if (todos !== undefined && !sameTodos(state.todos, todos)) { state.todos = todos; changed = true }
    }
    switch (raw.type) {
      case 'subagent/descriptor': {
        const label = readString(raw.data.label)
        if (label !== undefined && entry.label !== label) { entry.label = bound(label, MAX_LABEL_CHARS); changed = true }
        break
      }
      case 'user/message': {
        const task = Array.isArray(raw.data.content)
          ? textFromContent(raw.data.content as readonly { readonly type?: string; readonly text?: string }[])
          : undefined
        if (task !== undefined && entry.task === undefined) { entry.task = bound(task, MAX_TASK_CHARS); changed = true }
        break
      }
      case 'tool/call':
        entry.currentTool = bound(typeof raw.data.name === 'string' ? raw.data.name : 'tool', MAX_TOOL_CHARS)
        entry.toolUses += 1
        entry.state = 'running'
        entry.updatedAt = Date.now()
        changed = true
        break
      case 'tool/result':
        entry.currentTool = undefined
        entry.updatedAt = Date.now()
        changed = true
        break
      case 'turn/start':
        entry.state = 'running'
        entry.updatedAt = Date.now()
        changed = true
        break
      case 'turn/end':
        entry.currentTool = undefined
        if (raw.data.reason !== null && typeof raw.data.reason === 'object') {
          const reason = raw.data.reason as { readonly kind?: unknown; readonly error?: unknown }
          if (reason.kind === 'error') entry.state = 'failed'
          else if (reason.kind === 'aborted') entry.state = 'cancelled'
          const error = reason.error
          if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
            entry.error = bound((error as { message: string }).message, 500)
          }
        }
        entry.updatedAt = Date.now()
        changed = true
        break
      case 'assistant/message': {
        // A completed message is fresh liveness evidence: clear the stalled
        // marker the watchdog may have set during a long quiet generation.
        this.reviveStalled(entry)
        const usage = raw.data.usage
        const tokens = usage !== null && typeof usage === 'object' && usage !== undefined
          ? (usage as { readonly totalTokens?: unknown }).totalTokens
          : undefined
        if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) {
          entry.tokens = tokens
          changed = true
        } else if (entry.state === 'running') {
          changed = true
        }
        break
      }
      default:
        break
    }
    if (changed) this.publish(state, event)
  }

  private observeDisposed(agent: AgentLike): void {
    const parentId = this.childParents.get(String(agent.id)) ?? this.parentIdOf(agent)
    if (parentId === undefined) return
    const parent = this.ctx.sessions.get(parentId as SessionId)
    if (parent === undefined) return
    const state = this.parentState(parent)
    const entry = this.ensureEntry(state, agent)
    // A dispose that races a pending reschedule must not resurrect a removed
    // state entry; publish once and drop the registration.
    this.childParents.delete(String(agent.id))
    entry.state = entry.state === 'failed' || entry.state === 'cancelled' ? entry.state : 'completed'
    entry.currentTool = undefined
    entry.finishedAt = Date.now()
    entry.updatedAt = entry.finishedAt
    this.publish(state)
    // The parent session itself is going away: drop its whole projection so
    // long-lived Hosts do not accumulate one state object per session.
    const children = [...this.childParents.values()]
    if (!children.includes(parentId)) this.parents.delete(parentId)
  }

  private parentIdOf(agent: AgentLike): string | undefined {
    return this.parentIdOfSession(agent.session)
  }

  private parentIdOfSession(session: Session): string | undefined {
    const parent = session.header.parentSession
    if (parent === undefined || parent === session.id) return undefined
    this.childParents.set(String(session.id), String(parent))
    return String(parent)
  }

  private parentState(session: Session): ParentState {
    const id = String(session.id)
    let state = this.parents.get(id)
    if (state === undefined) {
      const previous = session.snapshotEvents().findLast(event => event.type === 'freecodego/agent-progress')
      const prior = previous?.data
      const agents = new Map<string, MutableEntry>()
      for (const entry of prior?.agents ?? []) agents.set(entry.id, { ...entry })
      state = {
        session,
        agents,
        // A hydration that predates the todo feature (or a fresh registry)
        // still replays the durable todo/write history.
        ...(prior?.todos === undefined ? {} : { todos: [...prior.todos] }),
        tail: Promise.resolve(),
        published: previous !== undefined,
        foreignEvents: 0,
        ...(previous === undefined ? {} : { lastKey: JSON.stringify(previous.data) }),
      }
      if (state.todos === undefined) {
        // `String(...)` is load-bearing here: tsc narrows `event.type` to the known
        // session-event union, which has no `todo/write` member, so widening is what
        // makes the comparison legal. `no-unnecessary-type-conversion` reads this as
        // a no-op; deleting it is a `TS2367`.
        const latestTodos = session.snapshotEvents().findLast(event => String(event.type) === 'todo/write')
        if (latestTodos !== undefined) state.todos = focusTodos((latestTodos.data as { readonly todos?: unknown }).todos)
      }
      this.parents.set(id, state)
    }
    return state
  }

  private ensureEntry(state: ParentState, agent: AgentLike | undefined, fallbackId?: string): MutableEntry {
    const id = agent?.id ?? fallbackId ?? ''
    let entry = state.agents.get(id)
    if (entry !== undefined) return entry
    const now = Date.now()
    entry = { id, label: id.slice(0, MAX_LABEL_CHARS), state: 'queued', toolUses: 0, startedAt: now, updatedAt: now }
    if (agent !== undefined) this.hydrateEntry(entry, agent.session)
    state.agents.set(id, entry)
    return entry
  }

  /** Recover metadata emitted before the progress observer attached. */
  private hydrateEntry(entry: MutableEntry, session: Session): void {
    for (const event of session.snapshotEvents()) {
      const raw = event as unknown as { readonly type: string; readonly data: Record<string, unknown> }
      if (raw.type === 'subagent/descriptor') {
        const label = readString(raw.data.label)
        if (label !== undefined) entry.label = bound(label, MAX_LABEL_CHARS)
      } else if (raw.type === 'user/message' && entry.task === undefined && Array.isArray(raw.data.content)) {
        const task = textFromContent(raw.data.content as readonly { readonly type?: string; readonly text?: string }[])
        if (task !== undefined) entry.task = bound(task, MAX_TASK_CHARS)
      }
    }
  }

  private publish(state: ParentState, event?: SessionEvent): void {
    if (this.disposed || state.agents.size === 0) return
    this.pruneTerminal(state)
    const snapshot = this.snapshot(state, event)
    const key = JSON.stringify(snapshot)
    if (state.lastKey === key) return
    state.lastKey = key
    state.published = true
    state.tail = state.tail.then(() => {
      if (this.disposed) return
      try { state.session.append('freecodego/agent-progress', snapshot) } catch { /* parent may be closing */ }
    }, () => undefined)
    void state.tail.catch(() => undefined)
  }

  /** Drop long-finished children so one entry (and an O(N) diff) does not accumulate per delegation. */
  private pruneTerminal(state: ParentState): void {
    const cutoff = Date.now() - TERMINAL_RETENTION_MS
    const terminal = [...state.agents.values()]
      .filter(entry => entry.state === 'completed' || entry.state === 'failed' || entry.state === 'cancelled')
      .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt))
    for (const entry of terminal.slice(MAX_RETAINED_TERMINAL)) {
      if ((entry.finishedAt ?? entry.updatedAt) < cutoff) state.agents.delete(entry.id)
    }
  }

  private snapshot(state: ParentState, event?: SessionEvent): FreeCodeGoAgentProgressSnapshot {
    const fromEvent = event?.data as { turn?: unknown; step?: unknown } | undefined
    let turn = typeof fromEvent?.turn === 'number' ? fromEvent.turn : undefined
    let step = typeof fromEvent?.step === 'number' ? fromEvent.step : undefined
    if (turn === undefined || step === undefined) {
      const cache = state.turnCache
      if (cache !== undefined && cache.foreignEvents === state.foreignEvents) {
        turn ??= cache.turn
        step ??= cache.step
      } else {
        const parentEvents = state.session.snapshotEvents()
        turn ??= parentEvents.findLast(item => item.type === 'turn/start')?.data.turn ?? 0
        step ??= parentEvents.findLast(item => item.type === 'step/start')?.data.step ?? 0
        state.turnCache = { foreignEvents: state.foreignEvents, turn, step }
      }
    }
    return {
      version: 1,
      phase: state.published ? 'update' : 'start',
      parentSessionId: String(state.session.id),
      agents: [...state.agents.values()].map(entry => snapshotEntry(entry)),
      ...state.todos === undefined ? {} : { todos: state.todos },
      updatedAt: Date.now(),
      turn,
      step,
    }
  }
}

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed'])
const MAX_TODO_COUNT = 64
const MAX_TODO_CHARS = 200

/** Validate one `todo/write` payload into the durable focus-chain shape. */
function focusTodos(raw: unknown): readonly FreeCodeGoFocusTodo[] | undefined {
  if (!Array.isArray(raw)) return undefined
  // An explicitly empty list is a plan the model cleared, and it is reported as
  // that: returning `undefined` made "clear the list" indistinguishable from "no
  // todo/write was ever seen", so the parent strip kept showing a finished plan
  // for the rest of the session. A list whose entries were all malformed is still
  // `undefined` — dropping junk must not wipe a plan the caller never retracted.
  if (raw.length === 0) return []
  const todos = raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as { readonly content?: unknown; readonly status?: unknown }
    if (typeof record.content !== 'string' || record.content.trim() === '') return []
    if (typeof record.status !== 'string' || !TODO_STATUS.has(record.status)) return []
    const content = record.content.length > MAX_TODO_CHARS ? `${record.content.slice(0, MAX_TODO_CHARS - 1)}…` : record.content
    return [{ content, status: record.status as FreeCodeGoFocusTodo['status'] }]
  })
  return todos.length === 0 ? undefined : todos.slice(0, MAX_TODO_COUNT)
}

function sameTodos(left: readonly FreeCodeGoFocusTodo[] | undefined, right: readonly FreeCodeGoFocusTodo[]): boolean {
  if (left === undefined || left.length !== right.length) return false
  return left.every((todo, index) => todo.content === right[index]!.content && todo.status === right[index]!.status)
}

function snapshotEntry(entry: MutableEntry): FreeCodeGoAgentProgressEntry {
  return {
    id: entry.id,
    label: entry.label,
    state: entry.state,
    toolUses: entry.toolUses,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    ...entry.task === undefined ? {} : { task: entry.task },
    ...entry.currentTool === undefined ? {} : { currentTool: entry.currentTool },
    ...entry.tokens === undefined ? {} : { tokens: entry.tokens },
    ...entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt },
    ...entry.error === undefined ? {} : { error: entry.error },
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function bound(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit - 1) + '…'
}

function textFromContent(content: readonly { readonly type?: string; readonly text?: string }[]): string | undefined {
  // The injected memory block is stripped by the shared reader, so this
  // projection and the turn-summary scrubber cannot disagree about where one
  // ends — a local pattern stopped at the first closing tag it saw, which is the
  // one a crafted memory body gets to place.
  const text = stripMemoryContextSections(content.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text!).join('').trim())
    .split('Your parent agent id is ')[0]!.trim()
  return text === '' ? undefined : text
}
