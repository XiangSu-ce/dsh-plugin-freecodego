/**
 * The conversation arc: durable Goals and Decisions folded from what actually
 * happened in a session.
 *
 * Why a fold, not a transcript
 * ----------------------------
 * A session log is the wrong shape for memory: it is ordered, verbose, and
 * dominated by tool traffic, and everything in it is already persisted where it
 * happened. What a future session needs is the *arc* — what this session was
 * trying to do, and what it decided along the way. OpenClaude calls this
 * `conversationArc.ts` and extracts it with a model pass; the extraction here is
 * deliberately mechanical, because the plugin already owns a model-free source
 * of both facts:
 *
 * - **Goals** come from the Host's own `goal/change` events — the same durable
 *   event the goal tools commit. Folding them here means the arc's Goals can
 *   never disagree with `get_goal`: it is the same source, re-read.
 * - **Decisions** come from memory records the review pipeline already
 *   promoted, and from assistant messages that announce a choice in the
 *   imperative ("we'll use X", "switch to Y") — matched by pattern, bounded,
 *   and redaction-screened before they ever leave this module.
 *
 * Two rules this module imposes on itself:
 *
 * - **It never stores anything.** This is a pure fold over an event slice; the
 *   caller decides what the output feeds (rehydration text, a memory draft,
 *   a status panel). Keeping it pure is what makes it testable and safe to
 *   call from any listener.
 * - **Everything is bounded and screened.** A long session must not turn into
 *   an unbounded extraction, and an assistant line containing a credential must
 *   never become a quotable fact.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/memory/memory-facts
 */

import { cutAtCodePointBoundary, screenMemoryForPersistence, tailAtCodePointBoundary } from './memory-security.ts'

/** Longest objective or decision text kept per entry. */
export const MAX_FACT_TEXT_CHARS = 300
/** Most goals and most decisions the fold retains; the newest win. */
export const MAX_FACTS_PER_LIST = 12
/** Longest tail of assistant text scanned per message. */
export const MAX_FACT_MESSAGE_CHARS = 900

/** One goal the session pursued, folded from the Host's durable goal events. */
export interface ConversationGoal {
  readonly id: string
  readonly objective: string
  /** The latest phase the goal reached: active, paused, completed, or blocked. */
  readonly phase: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Present when the goal ended blocked, with the reason the model gave. */
  readonly blockedReason?: string
}

/** One decision the session made, from promoted memory or an announced choice. */
export interface ConversationDecision {
  readonly text: string
  /** Where the decision came from: a promoted memory record or an assistant line. */
  readonly origin: 'memory' | 'assistant'
  /** Epoch ms of the source event; 0 when the source carried no time. */
  readonly at: number
}

export interface ConversationArc {
  readonly goals: readonly ConversationGoal[]
  readonly decisions: readonly ConversationDecision[]
}

/** The event slice the fold reads. Shapes mirror `engineering.ts`'s compileTurnObservation. */
export interface ConversationArcEvent {
  readonly type: string
  readonly time?: number
  readonly data: unknown
}

/** One promoted memory record, as `memory_search` returns it. */
export interface ConversationArcMemory {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly createdAt: number
}

/** Announced-choice patterns. Imperative and first-person-plural only. */
const DECISION_PATTERNS: readonly RegExp[] = [
  /\b(?:we(?:'|’)?ll|we will|we should|let's|let us|i'll|i will)\s+(?:use|go with|switch to|adopt|prefer|keep)\b/iu,
  /\b(?:decided|agreed) (?:to|on|that)\b/iu,
  /\b(?:choose|chose|settled on|opted (?:for|to))\b/iu,
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether one candidate line announces a choice, per the pattern table. */
function announcesDecision(line: string): boolean {
  return DECISION_PATTERNS.some(pattern => pattern.test(line))
}

function clampText(value: string): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  // Cut on a character boundary: this text is user- and model-written, and the
  // arc is injected into a later session, so a half character would travel there.
  return collapsed.length > MAX_FACT_TEXT_CHARS ? `${cutAtCodePointBoundary(collapsed, MAX_FACT_TEXT_CHARS)}…` : collapsed
}

/**
 * Fold the Host's `goal/change` events into the goal arc.
 *
 * Reuses the Host's own durable goal vocabulary rather than inventing one: the
 * events are full-snapshot changes, so the fold is "keep the latest per goal id,
 * newest last", and a clear tombstone simply retires that id.
 */
function foldGoalEvents(events: readonly ConversationArcEvent[]): ConversationGoal[] {
  const byId = new Map<string, ConversationGoal & { readonly cleared?: boolean }>()
  for (const event of events) {
    if (event.type !== 'goal/change') continue
    const data = isRecord(event.data) ? event.data : {}
    if (data.kind !== 'goal/change' || data.version !== 1) continue
    const at = Number.isSafeInteger(event.time) ? event.time! : 0
    if (data.operation === 'clear') {
      const cleared = isRecord(data.cleared) ? data.cleared : {}
      if (typeof cleared.id === 'string') {
        const previous = byId.get(cleared.id)
        byId.set(cleared.id, {
          id: cleared.id,
          objective: previous?.objective ?? '',
          phase: 'cleared',
          createdAt: previous?.createdAt ?? 0,
          updatedAt: at,
        })
      }
      continue
    }
    const goal = isRecord(data.goal) ? data.goal : undefined
    if (goal === undefined || typeof goal.id !== 'string') continue
    const objective = typeof goal.objective === 'string' ? goal.objective : ''
    const phase = typeof goal.phase === 'string' ? goal.phase : 'unknown'
    // The goal snapshot's timestamps come from the Host's own fold, so a well
    // -formed event always carries a safe integer here; the fallback to the
    // event time keeps a malformed one from producing a `Number`-coerced NaN.
    const rawCreatedAt = goal.createdAt
    const createdAt = typeof rawCreatedAt === 'number' && Number.isSafeInteger(rawCreatedAt) ? rawCreatedAt : at
    byId.set(goal.id, {
      id: goal.id,
      objective: clampText(objective),
      phase,
      createdAt,
      updatedAt: at,
      ...(typeof goal.blockedReason === 'string' && goal.blockedReason !== '' ? { blockedReason: clampText(goal.blockedReason) } : {}),
    })
  }
  return [...byId.values()].filter(goal => goal.phase !== 'cleared')
}

/**
 * Extract announced decisions from assistant messages, newest first, bounded.
 *
 * A line qualifies when it matches an imperative or agreed-choice pattern and
 * passes the same secret screening the store's persistence path uses. The
 * message tail is scanned rather than the whole message: conclusions live at
 * the end of an assistant turn, and the head is usually restatement.
 */
function decisionsFromMessages(events: readonly ConversationArcEvent[]): ConversationDecision[] {
  const found: ConversationDecision[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const data = isRecord(event.data) ? event.data : {}
    const message = isRecord(data.message) ? data.message : undefined
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
      // The scan operates on sentence-ish spans, not raw lines: an assistant
      // conclusion is frequently one long line, and splitting on newlines only
      // would let a mid-line decision hide behind filler the tail slicing
      // already kept. Splitting on sentence enders bounds each candidate so the
      // length filter stays meaningful.
      const tail = block.text.length > MAX_FACT_MESSAGE_CHARS ? tailAtCodePointBoundary(block.text, MAX_FACT_MESSAGE_CHARS) : block.text
      for (const line of tail.split(/(?:[.!]\s+|\n+)/gu)) {
        const trimmed = line.trim()
        if (trimmed.length < 8 || trimmed.length > MAX_FACT_TEXT_CHARS) continue
        if (!announcesDecision(trimmed)) continue
        const screen = screenMemoryForPersistence({ title: 'decision', body: trimmed })
        if (!screen.ok || screen.redacted) continue
        found.push({ text: clampText(trimmed), origin: 'assistant', at: Number.isSafeInteger(event.time) ? event.time! : 0 })
      }
    }
  }
  return found
}

/**
 * Promoted memory records the arc treats as decisions.
 *
 * Only `decision`-kind records qualify — a `discovery` is a fact about the
 * world, not a choice the session made — and they sort newest first like the
 * message-derived ones.
 */
function decisionsFromMemories(memories: readonly ConversationArcMemory[]): ConversationDecision[] {
  return memories
    .filter(memory => memory.kind === 'decision')
    .sort((left, right) => right.createdAt - left.createdAt)
    .map(memory => ({ text: clampText(memory.title), origin: 'memory' as const, at: memory.createdAt }))
}

/**
 * Fold the conversation arc from one session's events and promoted memories.
 *
 * Deduplication is per-text (normalized), because both sources can legitimately
 * repeat: an announced decision often becomes a memory record later, and the
 * arc should say it once. Dedup runs in source order, so a decision both sources
 * carry keeps the memory origin — the one the prompt labels as recorded in
 * project memory. The result is ordered goals-then-decisions with each list
 * internally newest-first, and every list capped at
 * {@link MAX_FACTS_PER_LIST}.
 *
 * Newest-first is applied *before* the cap, and that order is not cosmetic:
 * stopping the walk at the cap instead of sorting meant the decisions came out
 * in scan order — oldest first — so a session with more than
 * {@link MAX_FACTS_PER_LIST} announcements reported its earliest ones and
 * dropped its latest, the half a later session is trying to recall.
 */
export function foldConversationArc(
  events: readonly ConversationArcEvent[],
  memories: readonly ConversationArcMemory[] = [],
): ConversationArc {
  const goals = foldGoalEvents(events).slice(-MAX_FACTS_PER_LIST)
  const seen = new Set<string>()
  const retained: ConversationDecision[] = []
  for (const decision of [...decisionsFromMemories(memories), ...decisionsFromMessages(events)]) {
    const key = decision.text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    retained.push(decision)
  }
  // Equal timestamps keep the source order above, because the sort is stable.
  retained.sort((left, right) => right.at - left.at)
  return { goals, decisions: retained.slice(0, MAX_FACTS_PER_LIST) }
}

/**
 * Render the arc as bounded prompt text, or `''` when nothing happened.
 *
 * This is the shape rehydration injects; the wording mirrors the existing
 * rehydration sections so one injected message reads as one document.
 */
export function conversationArcText(arc: ConversationArc): string {
  const lines: string[] = []
  if (arc.goals.length > 0) {
    lines.push('### Goals this session pursued', '')
    for (const goal of arc.goals) {
      const blocked = goal.blockedReason === undefined ? '' : ` — blocked: ${goal.blockedReason}`
      lines.push(`- [${goal.phase}] ${goal.objective === '' ? goal.id : goal.objective}${blocked}`)
    }
    lines.push('')
  }
  if (arc.decisions.length > 0) {
    lines.push('### Decisions made', '')
    for (const decision of arc.decisions) {
      lines.push(`- ${decision.text}${decision.origin === 'memory' ? ' (recorded in project memory)' : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
