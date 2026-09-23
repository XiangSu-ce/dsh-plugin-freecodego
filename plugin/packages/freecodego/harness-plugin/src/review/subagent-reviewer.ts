/**
 * The subagent reviewer: the deep half of the review, run by a child agent.
 *
 * Why this is the port and not a second pipeline
 * ----------------------------------------------
 * A single-shot model call sees what the prompt carries. A reviewer that can
 * read the file, grep for the callers of a changed signature, and open the
 * implementation a new test is supposed to cover can find the findings that a
 * diff alone cannot support — which is the whole reason the upstream tool runs
 * its review through an agent with tools. That difference belongs behind
 * {@link ReviewFilePort}, so coverage, budget, relocation, filtering and
 * reporting stay one implementation and this file only has to get one thing
 * right: a child agent that reads carefully and answers in the contract's format.
 *
 * Why one child per file
 * ---------------------
 * A child reused across files accumulates the previous file's findings in its
 * context, and the failure mode is specific and bad: the second file gets
 * reviewed against the first file's conclusions, and duplication or omission
 * looks like a finding either way. A fresh child per file is the only shape
 * where "this review saw this file and its own reads" is a fact rather than a
 * hope. The cost is real, so this reviewer is off unless a deployment turns it on.
 *
 * What it refuses to fake
 * -----------------------
 * - **No tools means no depth.** A child whose tool set holds none of the read
 *   or search tools is a single-shot call wearing an agent costume, so the file
 *   fails with that reason instead of being reviewed shallowly.
 * - **No answer is a failure, not an empty review.** An empty comment list is a
 *   legitimate review result, so silence must not be able to produce one.
 * - **Measured tokens only.** Every step the child ran carries its own usage, and
 *   all of them are summed; a multi-step review that read four files spends on
 *   all five steps, and reporting only the last would understate the run. When
 *   nothing was reported the spend is zero, because an invented figure would make
 *   the budget a lie.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/subagent-reviewer
 */

import { randomUUID } from 'node:crypto'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { extractJsonValue } from './model.ts'
import { parseFileComments, renderReviewUser, type ReviewFileOutcome, type ReviewFilePort, type ReviewFileTask } from './reviewer.ts'

/**
 * The read and search tools a review child may use.
 *
 * Named rather than "all read-only tools", because the child's job is to read
 * code: a review that can spend its round-trips on memory search or the advisor
 * is a review that may read less code than it was going to. Every name here is
 * a tool this plugin has seen; a name a composition does not provide is simply
 * absent from the child's tool set, and the intersection is what is restricted to.
 */
export const REVIEW_SUBAGENT_TOOLS: readonly string[] = [
  'read',
  'glob',
  'grep',
  'engineering_graph_search',
  'engineering_graph_explain',
  'engineering_graph_affected',
  'engineering_repo_map',
]

/** How long one file's child may run before it is disposed and the file fails. */
export const DEFAULT_REVIEW_SUBAGENT_TIMEOUT_MS = 180_000

/** What a created review child must be able to do. */
export interface ReviewSubagentHandle {
  /** Send the review request and resolve when the child has stopped working. */
  run(prompt: string): Promise<void>
  /** The child's final answer text, which is where the findings are. */
  answer(): string
  /**
   * Whether `answer` was cut to the output ceiling rather than returned whole.
   *
   * Optional because a handle that never cuts anything has nothing to report. It
   * exists so an unreadable answer can name its real cause: a long answer is cut
   * from the front, which is exactly where the opening brace of the one JSON object
   * the contract asks for lives — so the parse failure is *ours*, and a note blaming
   * the child's format would send a reader to fix the wrong thing.
   */
  truncated?(): boolean
  /** Input and output tokens measured across every step the child ran. */
  tokens(): { readonly inputTokens: number; readonly outputTokens: number }
  /** Stop the child and release it. Called exactly once, success or failure. */
  dispose(): Promise<void>
}

/**
 * Creates one read-only review child.
 *
 * Injected rather than reached for, so the port can be tested without an agent
 * runtime — the same seam {@link ReviewFilePort} exists for, one level down.
 */
export type ReviewSubagentFactory = () => Promise<ReviewSubagentHandle>

/** Options for the shipped factory. */
export interface ReviewSubagentOptions {
  /** Provider for the child; omitted lets the engine resolve the parent's own. */
  readonly provider?: string
  /** Model for the child; omitted means the engine's route, not a hard-coded one. */
  readonly model?: string
  /** The tools the child may call; an empty intersection fails the file. */
  readonly allowTools?: readonly string[]
  readonly timeoutMs?: number
  readonly maxOutputChars?: number
}

/** The reviewer the pipeline sees, backed by one fresh child agent per file. */
export class SubagentFileReviewer implements ReviewFilePort {
  constructor(
    private readonly create: ReviewSubagentFactory,
    private readonly options: { readonly timeoutMs?: number } = {},
  ) {}

  async review(task: ReviewFileTask): Promise<ReviewFileOutcome> {
    const handle = await this.create()
    let outcome: ReviewFileOutcome | undefined
    let failure: unknown
    try {
      await withTimeout(handle.run(renderReviewUser({ ...task, investigate: true })), this.options.timeoutMs)
      const answer = handle.answer().trim()
      if (answer === '') throw new Error('the review subagent returned no answer')
      // Read before disposal: the flag describes the answer this review is about, and
      // a disposed session is the wrong place to go looking for it.
      const cut = handle.truncated?.() === true
      const parsed = extractJsonValue(answer)
      outcome = {
        comments: parsed === undefined ? [] : parseFileComments(parsed),
        // The child did answer, so an unreadable answer is a note rather than a
        // failure: it may have narrated its reading and never emitted the object,
        // and failing the file would report the same coverage as a crash while
        // hiding the fact that a child ran.
        ...(parsed === undefined ? { note: cut ? TRUNCATED_ANSWER_NOTE : 'the review subagent answered without a readable comment object' } : {}),
        spent: handle.tokens(),
      }
    } catch (error) {
      failure = error
    }
    // Disposal runs for both paths and its own failure cannot replace the real
    // one: reporting "dispose failed" for a file whose review also failed would
    // name the wrong cause.
    try {
      await handle.dispose()
    } catch (error) {
      // Appended to whatever the review already had to say, not written over it: a
      // child that answered unreadably *and* failed to dispose produced two facts,
      // and keeping only the later one is how a run loses the reason its findings
      // are missing.
      if (failure === undefined && outcome !== undefined) {
        const note = `the review subagent could not be disposed: ${(error as Error).message}`
        outcome = { ...outcome, note: outcome.note === undefined ? note : `${outcome.note}; ${note}` }
      }
    }
    if (failure !== undefined) throw failure
    return outcome as ReviewFileOutcome
  }
}

/**
 * What an answer cut to the output ceiling says about itself.
 *
 * Stated separately from the general unreadable-answer note because the two point at
 * different fixes: one at the child's output format, this one at a review that said
 * more than the ceiling allowed and whose findings are therefore *missing*, not
 * absent.
 */
const TRUNCATED_ANSWER_NOTE = 'the review subagent answered at greater length than the output ceiling allows, so its answer was cut and its findings could not be read'

/** The shipped factory: a real, read-only child agent of `parent`. */
export function createSubagentFileReviewer(parent: Agent, options: ReviewSubagentOptions = {}): ReviewFilePort {
  const allow = new Set(options.allowTools ?? REVIEW_SUBAGENT_TOOLS)
  return new SubagentFileReviewer(
    async (): Promise<ReviewSubagentHandle> => {
      const cwd = parent.session.header.cwd
      if (cwd === undefined || cwd.trim() === '') throw new Error('a review subagent requires a workspace-backed session')
      const agentOptions = {
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.model === undefined ? {} : { model: options.model }),
        freeCodeGoReadOnly: true,
      } as unknown as AgentOptions
      const handle = await parent.ctx.agents.create({
        sessionId: SessionId(randomUUID()),
        meta: { cwd, parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
        agentOptions,
        setup: (childCtx, child) => {
          setSandboxMode(child.session, 'read-only')
          setApprovalPolicy(child.session, 'never')
          const available = childCtx.tools.schemas(child).map(schema => schema.name)
          const permitted = available.filter(name => allow.has(name))
          if (permitted.length === 0) {
            throw new Error('the review subagent has no read or search tool available, so it could not read the code it is reviewing')
          }
          childCtx.tools.restrict({ allow: permitted })
        },
      })
      return wrapChild(handle, options.maxOutputChars ?? 20_000)
    },
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  )
}

/** Adapt a harness agent handle to the handle this module drives. */
function wrapChild(handle: AgentHandle, maxOutputChars: number): ReviewSubagentHandle {
  /** The child's answer in full, which both `answer` and `truncated` are read from. */
  const spoken = (): string => finalAssistantText(handle.agent.session.snapshotEvents())
  return {
    async run(prompt: string): Promise<void> {
      handle.agent.followup(createUserMessage({
        source: { kind: 'freecodego-review' },
        content: [{ type: 'text', text: prompt }],
      }))
      await handle.agent.whenIdle()
    },
    // The **tail** is kept, as the council keeps its participants' reports: the
    // conclusion is at the end of an answer that ran long, and an answer is not
    // discarded because it was verbose. The cost is that the object the contract
    // asks for may have lost its opening brace, which is what `truncated` reports.
    answer: () => spoken().slice(-maxOutputChars),
    truncated: () => spoken().length > maxOutputChars,
    tokens: () => sumSubagentUsage(handle.agent.session.snapshotEvents()),
    dispose: async () => { await handle.dispose() },
  }
}

/** Reject when `work` has not settled within the bound, leaving the child to be disposed. */
async function withTimeout(work: Promise<void>, timeoutMs: number | undefined): Promise<void> {
  if (timeoutMs === undefined) return work
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the review subagent did not finish within ${Math.round(timeoutMs / 1_000)}s`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The child's final answer.
 *
 * The last assistant message, as the council reads its participants: a child that
 * answered in several messages is answered by its conclusion, and every earlier
 * message is one of the steps that produced it.
 */
function finalAssistantText(events: readonly SessionEvent[]): string {
  const event = [...events].reverse().find(candidate => candidate.type === 'assistant/message')
  if (event?.type !== 'assistant/message') return ''
  const message = event.data.message
  return message.content.map(block => block.type === 'text' || block.type === 'reasoning' ? block.text : '').join('\n').trim()
}

/**
 * The slice of a session event this reader needs, so a malformed one contributes
 * zero instead of a NaN that would poison the run's whole budget total.
 */
export interface ReviewUsageEvent {
  readonly type: string
  readonly data?: unknown
}

/**
 * Tokens spent by every step the child ran.
 *
 * Summed over all steps rather than taken from the last one, because a review
 * that read four files has five messages and the reading is the expensive part.
 * A step whose usage the engine did not report contributes zero — understating a
 * spend the engine declined to measure is honest; inventing one is not.
 */
export function sumSubagentUsage(events: readonly ReviewUsageEvent[]): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0
  let outputTokens = 0
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = (event.data as { usage?: unknown } | undefined)?.usage
    if (typeof usage !== 'object' || usage === null) continue
    const record = usage as { inputTokens?: unknown; outputTokens?: unknown }
    if (typeof record.inputTokens === 'number' && Number.isFinite(record.inputTokens)) inputTokens += record.inputTokens
    if (typeof record.outputTokens === 'number' && Number.isFinite(record.outputTokens)) outputTokens += record.outputTokens
  }
  return { inputTokens, outputTokens }
}
