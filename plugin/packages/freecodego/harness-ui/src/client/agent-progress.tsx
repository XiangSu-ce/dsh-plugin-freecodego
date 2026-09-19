/** Inline delegated-Agent progress tree rendered inside the Chat transcript. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { FreeCodeGoAgentProgressEntry, FreeCodeGoAgentProgressSnapshot } from '@deepseek-ai/dsh-freecodego-harness-plugin'
import type { ConversationLocation, ConversationNodeContext, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the `Context.uiWorkspace` merge this file navigates through.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress, SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent/client'
// Type-only: activates the `Context.remote` merge, so the Host Remote surface this
// file drives is the generated one. A signature drift then breaks the build
// instead of the button.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { NS, type ProgressKey } from './agent-progress-locale.ts'
import css from './agent-progress.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'freecodego.agent-progress': ProgressKey
  }
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Aggregated delegated-Agent progress for one parent Session. */
    'freecodego-agent-progress': FreeCodeGoAgentProgressSnapshot
  }
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches.at(-1)?.location ?? { kind: 'unresolved' }
}

function snapshotFromEvent(event: SessionEventLike): FreeCodeGoAgentProgressSnapshot | undefined {
  if (event.type !== 'freecodego/agent-progress') return undefined
  return event.data
}

/**
 * Aggregate per-Agent states into the header summary counts and the progress
 * bar percentage. `cancelled` is a terminal state and is already folded into
 * `failed`; counting it a second time pushed the bar past 100% for any
 * cancelled child.
 */
export function summarizeAgentProgress(agents: readonly FreeCodeGoAgentProgressEntry[]): {
  readonly completed: number
  readonly running: number
  readonly failed: number
  readonly progressPercent: number
} {
  const completed = agents.filter(agent => agent.state === 'completed').length
  const running = agents.filter(agent => agent.state === 'running').length
  const failed = agents.filter(agent => agent.state === 'failed' || agent.state === 'cancelled').length
  const settled = completed + failed
  const progressPercent = agents.length === 0 ? 0 : Math.round(settled / agents.length * 100)
  return { completed, running, failed, progressPercent }
}

/** Chat Definition that keeps one live progress tree per parent Session. */
const progressDefinition: ConversationNodeDefinition<FreeCodeGoAgentProgressSnapshot> = {
  kind: 'freecodego-agent-progress',
  target: 'chat',
  match: (event) => {
    const data = snapshotFromEvent(event)
    if (data === undefined) return null
    return { id: data.parentSessionId, role: data.phase === 'start' ? 'start' : 'update' }
  },
  start: (_context, match) => {
    const data = snapshotFromEvent(match.event)
    if (data === undefined) throw new Error('FreeCodeGo progress start requires a progress event')
    return data
  },
  update: (_context, match) => {
    const data = snapshotFromEvent(match.event)
    return data ?? _context.state
  },
  publication: () => 'immediate',
  buildViewNode: (context) => {
    const data = context.state
    if (data === undefined) return null
    const match = context.matches.at(-1)
    if (match === undefined) return null
    const location = locationOf(context)
    return {
      key: context.key,
      kind: 'freecodego-agent-progress',
      id: context.id,
      target: 'chat' as const,
      anchorSeq: match.event.seq,
      location,
      visibility: 'visible' as const,
      data,
    }
  },
}

type ProgressProps = PropsRuntime<'conversation.chat.node', 'freecodego-agent-progress'> & PropsLocale<typeof NS> & {
  readonly openAgent?: (address: SubagentAddress) => void
  readonly interruptAgent?: (childSessionId: SessionId, parentSessionId: SessionId) => Promise<void>
  readonly resumeAgent?: (childSessionId: SessionId, parentSessionId: SessionId) => Promise<void>
}

type AgentEntry = FreeCodeGoAgentProgressSnapshot['agents'][number]
type TodoEntry = NonNullable<FreeCodeGoAgentProgressSnapshot['todos']>[number]

/** Sticky focus-chain strip: the agent's plan survives context resets here. */
function TodoStrip({ todos, t }: { readonly todos: readonly TodoEntry[]; readonly t: (key: ProgressKey) => string }): ReactNode {
  const done = todos.filter(todo => todo.status === 'completed').length
  const percent = todos.length === 0 ? 0 : Math.round(done / todos.length * 100)
  return (
    <div className={css.todos} role="group" aria-label={t('focusChain')}>
      <div className={css.todosHeader}>
        <span className={css.todosTitle}>{done}/{todos.length}</span>
        <div className={css.todosBar} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className={css.todosBarFill} style={{ width: `${percent}%` }} />
        </div>
      </div>
      <ul className={css.todoList}>
        {todos.map((todo, index) => (
          <li
            className={
              todo.status === 'completed'
                ? `${css.todo} ${css.todoCompleted}`
                : todo.status === 'in_progress'
                  ? `${css.todo} ${css.todoActive}`
                  : css.todo
            }
            key={`${index}-${todo.content.slice(0, 24)}`}
          >
            <span className={css.todoMark} aria-hidden="true">{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '›' : '·'}</span>
            <span className={css.todoText}>{todo.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function statusText(state: AgentEntry['state'], t: (key: ProgressKey) => string): string {
  switch (state) {
    case 'queued': return t('queued')
    case 'running': return t('running')
    case 'stalled': return t('stalled')
    case 'idle': return t('idle')
    case 'completed': return t('completed')
    case 'failed': return t('failed')
    case 'cancelled': return t('cancelled')
  }
}

function displayError(error: string | undefined): string | undefined {
  if (error === undefined) return undefined
  if (/not a member of an active Agent Team/i.test(error)) return '子 Agent 未能加入当前协作组。'
  return error.length > 180 ? `${error.slice(0, 179)}…` : error
}

/** The dot is the single source of truth for state semantics — one state, one hue. */
function dotClass(state: AgentEntry['state']): string {
  switch (state) {
    case 'running': return `${css.dot} ${css.dotRunning}`
    case 'queued': return `${css.dot} ${css.dotQueued}`
    case 'stalled': return `${css.dot} ${css.dotStalled}`
    case 'completed': return `${css.dot} ${css.dotCompleted}`
    case 'failed':
    case 'cancelled': return `${css.dot} ${css.dotFailed}`
    default: return css.dot ?? ''
  }
}

/**
 * Render the delegation orchestration view: a summary header with overall
 * progress, then one row per delegated Agent with live state, current tool,
 * and quantified activity.
 */
export function AgentProgressNodeView({ node, t, openAgent, interruptAgent, resumeAgent }: ProgressProps): ReactNode {
  const agents = useMemo(() => node.data.agents, [node.data.agents])
  const [now, setNow] = useState(() => Date.now())
  const [busyAgents, setBusyAgents] = useState<ReadonlySet<string>>(new Set())
  const runExclusive = (agentId: string, action: () => Promise<void>): void => {
    setBusyAgents(previous => new Set(previous).add(agentId))
    void action().finally(() => { setBusyAgents((previous) => {
      const next = new Set(previous)
      next.delete(agentId)
      return next
    }) })
  }
  const active = agents.some(agent => agent.state === 'running' || agent.state === 'queued' || agent.state === 'idle' || agent.state === 'stalled')
  useEffect(() => {
    // Elapsed labels only move while a delegation is live; ticking forever on
    // historical blocks re-rendered the whole tree once per second per node.
    if (!active) return
    const timer = globalThis.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { globalThis.clearInterval(timer) }
  }, [active])
  const { completed, running, failed, progressPercent } = summarizeAgentProgress(agents)
  const summary = running > 0
    ? t('summary.running', { running, total: agents.length })
    : failed > 0
      ? t('summary.failed', { failed, total: agents.length })
      : t('summary.finished', { completed, total: agents.length })
  const headerTone = failed > 0 ? css.headerProgressFailed : running > 0 ? '' : css.headerProgressDone
  return (
    <section className={css.root} aria-label={summary} data-freecodego-agent-progress>
      <div className={css.header}>
        <div className={css.headerText}>
          <strong>{summary}</strong>
          <span className={css.headerMeta}>{t('toolUses', { count: agents.reduce((sum, agent) => sum + agent.toolUses, 0) })}</span>
        </div>
        <div className={css.headerProgress} role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100}>
          <div className={`${css.headerProgressBar} ${headerTone}`} style={{ width: `${progressPercent}%` }} />
        </div>
      </div>
      {node.data.todos === undefined || node.data.todos.length === 0 ? null : <TodoStrip todos={node.data.todos} t={t} />}
      <div className={css.tree} role="list">
        {agents.map((agent) => {
          const actionable = agent.state === 'running' || agent.state === 'queued' || agent.state === 'idle' || agent.state === 'stalled'
          const resumable = agent.state === 'stalled' || agent.state === 'idle' || agent.state === 'cancelled'
          return (
            <div className={css.row} key={agent.id} role="listitem">
              <span className={css.stateCell} aria-hidden="true"><span className={dotClass(agent.state)} /></span>
              <button
                className={css.contentButton}
                type="button"
                onClick={() => openAgent?.({ parentSessionId: node.data.parentSessionId as SessionId, childSessionId: agent.id as SessionId, mode: 'continuable' })}
                disabled={openAgent === undefined}
              >
                <span className={css.content}>
                  <span className={css.title}>
                    <strong>{agent.label}</strong>
                    <span className={`${css.status} ${css[`status${agent.state}`]}`}>{statusText(agent.state, t)}</span>
                  </span>
                  <span className={css.detail}>
                    {agent.currentTool === undefined ? agent.task ?? t('waiting') : t('usingTool', { tool: agent.currentTool })}
                    <span className={css.metrics}>{t('toolUses', { count: agent.toolUses })} · {formatElapsed(agent, now)}</span>
                  </span>
                  {agent.state === 'running' ? <span className={css.activity} aria-hidden="true"><span className={css.activityBar} /></span> : null}
                  {displayError(agent.error) === undefined ? null : <span className={css.error}>{displayError(agent.error)}</span>}
                </span>
              </button>
              {interruptAgent !== undefined && actionable || resumeAgent !== undefined && resumable ? (
                <span className={css.actions}>
                  {interruptAgent !== undefined && actionable ? (
                    <button type="button" className={`${css.actionButton} ${css.actionStop}`} disabled={busyAgents.has(agent.id)} onClick={() => { runExclusive(agent.id, () => interruptAgent(agent.id as SessionId, node.data.parentSessionId as SessionId)) }}>{t('stop')}</button>
                  ) : null}
                  {resumeAgent !== undefined && resumable ? (
                    <button type="button" className={`${css.actionButton} ${css.actionResume}`} disabled={busyAgents.has(agent.id)} onClick={() => { runExclusive(agent.id, () => resumeAgent(agent.id as SessionId, node.data.parentSessionId as SessionId)) }}>{t('resume')}</button>
                  ) : null}
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Elapsed time freezes at the recorded finish for settled agents — historical
 * blocks must not show a growing "3h12m" against a `now` that only ticks for
 * live delegations.
 */
function formatElapsed(agent: AgentEntry, now: number): string {
  const end = agent.finishedAt ?? (agent.state === 'completed' || agent.state === 'failed' || agent.state === 'cancelled' ? agent.updatedAt : now)
  const seconds = Math.max(0, Math.floor((end - agent.startedAt) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
}

/** Register the durable event Definition and its keyed Chat renderer. */
export function registerAgentProgressUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'freecodego-ui: Agent progress')
  ctx.uiConversation.events.register(progressDefinition)
  // `uiWorkspace`, not `sessions`: alpha.2 moved navigation out of the Session
  // Controller ("navigation belongs to view owners"), so opening a subagent is now
  // the workspace capability's `openSession(target)` — the same call upstream's own
  // subagent catalog makes for `openChild`.
  ctx.inject(['slots', 'sessions', 'uiWorkspace', 'remote.subagents'], (scope) => {
    const remote = scope.remote
    scope.slots.inject('conversation.chat.node', () => scope.slots.register({
      name: 'conversation.chat.node',
      key: 'freecodego-agent-progress',
      locale: NS,
      inject: () => ({
        openAgent: (address: SubagentAddress) => { scope.uiWorkspace.openSession(address) },
        interruptAgent: async (child: SessionId, parent: SessionId) => {
          const result = await remote.subagents.interruptByParent(child, parent, 'continuable')
          if (!result.ok) console.error('[freecodego] subagent interrupt failed:', result.error.message)
        },
        resumeAgent: async (child: SessionId, parent: SessionId) => {
          const result = await remote.subagents.prompt({
            requestId: globalThis.crypto.randomUUID() as SubagentPromptRequestId,
            parentSessionId: parent,
            childSessionId: child,
            mode: 'continuable',
            // Required by the Host's `subagent.prompt` control schema: resume is a
            // human message that queues a later turn, not a steer of the current step.
            delivery: 'queue',
            content: [{ type: 'text', text: '继续当前任务。先报告你最后完成的步骤、当前阻塞点，然后继续执行；不要重复已经完成的工作。' }],
          })
          if (!result.ok) console.error('[freecodego] subagent resume failed:', result.error.message)
        },
      }),
    }, AgentProgressNodeView))
  })
}

const zh: Record<ProgressKey, string> = {
  'summary.running': '{running}/{total} 个 Agent 正在工作',
  'summary.finished': '{completed}/{total} 个 Agent 已完成',
  'summary.failed': '{failed}/{total} 个 Agent 失败或取消',
  queued: '排队中', running: '运行中', stalled: '疑似卡住', idle: '等待任务', completed: '完成', failed: '失败', cancelled: '已取消',
  waiting: '等待子任务', usingTool: '正在使用 {tool}', toolUses: '{count} 次工具调用',
  stop: '停止', resume: '继续',
  focusChain: '任务计划',
}

const en: Record<ProgressKey, string> = {
  'summary.running': '{running}/{total} agents working',
  'summary.finished': '{completed}/{total} agents finished',
  'summary.failed': '{failed}/{total} agents failed or cancelled',
  queued: 'Queued', running: 'Working', stalled: 'Stalled', idle: 'Waiting', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled',
  waiting: 'Waiting for a task', usingTool: 'Using {tool}', toolUses: '{count} tool uses',
  stop: 'Stop', resume: 'Resume',
  focusChain: 'Task plan',
}
