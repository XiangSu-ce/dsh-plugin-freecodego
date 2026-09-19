/**
 * Durable inbox owned by the native (Codex/Claude) agent driver.
 *
 * Harness 0.1.6 keeps `agent/inbox/spliced` as the durable record of pending
 * input, but no longer exports an inbox implementation from
 * `@deepseek-ai/dsh-agent`: the React loop owns its own queue (`ReactLoopInbox`
 * in `@deepseek-ai/dsh-agent-loop`, which is not part of that package's public
 * entry points). The native driver owns its own turn loop, so it also owns the
 * queue that loop drains. This class implements the public `Inbox` contract and
 * adds the `hasPending`/`claim` pair the driver's step boundary needs.
 *
 * @module
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
import type { Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'

/** Pending-message lists keyed by the boundary that will consume them. */
type InboxState = Record<InboxTarget, UserMessage[]>

/** Live notifications published by durable inbox mutations. */
export interface NativeInboxNotifications {
  /** Publish one inserted message. */
  inserted(message: UserMessage): void
  /** Publish one discarded message. */
  discarded(message: UserMessage): void
  /** Publish one claimed message inside its owning turn. */
  claimed(message: UserMessage, turn: number): void
}

/**
 * Replay-once projection over durable inbox splices that later mutations extend.
 *
 * The durable event commits before the live projection mutates, so synchronous
 * `session/event` observers still see the pre-splice lists and can reconstruct
 * the removed messages from the normalized coordinates.
 */
export class FreeCodeGoNativeInbox implements Inbox {
  private readonly state: InboxState = { 'next-turn': [], 'next-step': [] }

  /**
   * Rebuild pending input from the session's own durable splices.
   * @param session - session whose events carry this inbox's history.
   * @param notifications - live publishers for inbox lifecycle events.
   * @throws if a persisted splice is invalid for the replayed state.
   */
  constructor(
    private readonly session: Session,
    private readonly notifications: NativeInboxNotifications,
  ) {
    for (const event of session.ownEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      try {
        this.apply(event.data)
      } catch (error: unknown) {
        throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
      }
    }
  }

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.state['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.state['next-step']
  }

  /** Whether either pending list holds work the driver must still drain. */
  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the complete batch proposed for one step boundary.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') {
      claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    }
    for (const message of claimed) this.notifications.claimed(message, turn)
    return claimed
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   * @throws if the message identity is already pending.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.state[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   * @throws if the message identity is already pending.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place, publishing the removal and insertion.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   * @throws if the replacement duplicates another pending message identity.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message and durably record its cancellation.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /**
   * Commit one normalized mutation and publish its live notifications.
   * @param target - pending list to mutate.
   * @param start - requested splice position.
   * @param deleteCount - requested removal count.
   * @param inserted - messages to insert.
   * @param discardRemoved - whether removed messages count as cancellations.
   * @returns removed messages.
   */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const inbox = this.state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    this.validate(splice)
    const event = this.session.append('agent/inbox/spliced', splice)
    const removed = inbox.splice(actualStart, actualDeleteCount, ...event.data.inserted)
    if (discardRemoved) {
      for (const message of removed) this.notifications.discarded(message)
    }
    for (const message of event.data.inserted) this.notifications.inserted(message)
    return removed
  }

  /**
   * Apply one normalized durable splice to the replay projection.
   * @param splice - durable splice payload.
   * @returns messages removed by the applied splice.
   */
  private apply(splice: SessionEventMap['agent/inbox/spliced']): UserMessage[] {
    this.validate(splice)
    const inbox = this.state[splice.target]
    return inbox.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
  }

  /**
   * Validate one normalized splice against the current projection.
   * @param splice - candidate splice payload.
   * @throws if coordinates are invalid or an identity would duplicate.
   */
  private validate(splice: SessionEventMap['agent/inbox/spliced']): void {
    const inbox = this.state[splice.target]
    const removedCount = splice.removedCount ?? 0
    if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0
      || splice.start + removedCount > inbox.length) {
      throw new Error('invalid inbox splice')
    }
    const candidate = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
    const ids = new Set<string>()
    for (const message of splice.target === 'next-turn'
      ? [...candidate, ...this.nextStep]
      : [...this.nextTurn, ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
  }
}
