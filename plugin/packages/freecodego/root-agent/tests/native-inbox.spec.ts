import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Bare specifier; see the note in `native-agent.spec.ts`.
import { FreeCodeGoNativeInbox, type NativeInboxNotifications } from '@deepseek-ai/dsh-freecodego-root-agent'

/** Recording notification sink, so publication order is inspectable. */
function sink(): { notifications: NativeInboxNotifications; inserted: string[]; discarded: string[]; claimed: string[] } {
  const inserted: string[] = []
  const discarded: string[] = []
  const claimed: string[] = []
  return {
    notifications: {
      inserted: message => void inserted.push(message.id),
      discarded: message => void discarded.push(message.id),
      claimed: (message, turn) => void claimed.push(`${message.id}@${turn}`),
    },
    inserted,
    discarded,
    claimed,
  }
}

/** One identified user message carrying its own id as text, for readable assertions. */
function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** The durable splice targets in log order, which is how the contract orders clearing. */
function splicedTargets(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'agent/inbox/spliced')
    .map(event => event.data.target)
}

describe('FreeCodeGoNativeInbox', () => {
  it('commits every mutation durably and replays the same pending lists', () => {
    const session = Session.create(SessionId('inbox-replay'))
    const first = new FreeCodeGoNativeInbox(session, sink().notifications)
    const queuedTurn = message('queued turn')
    const steering = message('steering')
    const second = message('second steering')

    first.append('next-turn', queuedTurn)
    first.append('next-step', steering)
    first.prepend('next-step', second)
    first.replace(steering.id, message('replaced steering'))

    const replayed = new FreeCodeGoNativeInbox(
      Session.create(SessionId('inbox-replay-fork'), session.snapshotEvents()),
      sink().notifications,
    )
    expect(replayed.nextTurn.map(entry => entry.id)).toEqual([queuedTurn.id])
    expect(replayed.nextStep.map(entry => entry.id).length).toBe(2)
    expect(replayed.hasPending).toBe(true)
    // The replacement carries new text under a fresh identity, and the replaced
    // message is gone from both the live projection and the replay.
    expect(replayed.nextStep.some(entry => entry.id === steering.id)).toBe(false)
  })

  it('rejects an identity that is already pending in either list and logs nothing', () => {
    const session = Session.create(SessionId('inbox-duplicate'))
    const inbox = new FreeCodeGoNativeInbox(session, sink().notifications)
    const pending = message('already pending')
    inbox.append('next-turn', pending)
    const before = session.snapshotEvents().length

    expect(() => { inbox.append('next-step', pending) }).toThrow(/already pending/)
    // Crossing lists is still one identity: a rejected mutation must not leave a
    // half-written durable record behind.
    expect(session.snapshotEvents()).toHaveLength(before)
    expect(inbox.nextStep).toHaveLength(0)
  })

  it('applies the invalid-splice rejection on replay and names the offending sequence', () => {
    const source = Session.create(SessionId('inbox-corrupt-source'))
    const inbox = new FreeCodeGoNativeInbox(source, sink().notifications)
    inbox.append('next-step', message('only entry'))
    const [splice] = source.snapshotEvents()
    // The record is corrupt by construction, which is what the inbox must
    // reject: the spread of a union cannot satisfy `exactOptionalPropertyTypes`,
    // and a valid-looking object is not what this case is about.
    const corrupt = { ...splice!, data: { ...splice!.data, start: 7 } } as SessionEvent

    expect(() => new FreeCodeGoNativeInbox(
      Session.create(SessionId('inbox-corrupt'), [corrupt]),
      sink().notifications,
    )).toThrow(new RegExp(`invalid persisted inbox splice at session seq ${splice!.seq}`))
  })

  it('clears the next-step list before the next-turn list', () => {
    const session = Session.create(SessionId('inbox-clear'))
    const inbox = new FreeCodeGoNativeInbox(session, sink().notifications)
    inbox.append('next-turn', message('turn'))
    inbox.append('next-step', message('step'))

    inbox.clear()

    // The documented order: step-level input is cancelled before queued turns,
    // so an observer replaying the log never sees a turn cancel a step that is
    // still pending.
    expect(splicedTargets(session)).toEqual(['next-turn', 'next-step', 'next-step', 'next-turn'])
    expect(inbox.hasPending).toBe(false)
  })

  it('claims the step batch always, and one queued turn only when the boundary asks', () => {
    const session = Session.create(SessionId('inbox-claim'))
    const { notifications, claimed, discarded, inserted } = sink()
    const inbox = new FreeCodeGoNativeInbox(session, notifications)
    const stepA = message('step a')
    const stepB = message('step b')
    const turnA = message('turn a')
    const turnB = message('turn b')
    inbox.append('next-step', stepA)
    inbox.append('next-step', stepB)
    inbox.append('next-turn', turnA)
    inbox.append('next-turn', turnB)

    expect(inbox.claim('next-step', 1).map(entry => entry.id)).toEqual([stepA.id, stepB.id])
    expect(inbox.nextTurn.map(entry => entry.id)).toEqual([turnA.id, turnB.id])

    // A turn boundary drains the step batch and exactly one queued turn, leaving
    // the rest queued for later turns.
    expect(inbox.claim('next-turn', 2).map(entry => entry.id)).toEqual([turnA.id])
    expect(inbox.nextTurn.map(entry => entry.id)).toEqual([turnB.id])
    expect(claimed).toEqual([`${stepA.id}@1`, `${stepB.id}@1`, `${turnA.id}@2`])
    // A claim consumes input rather than cancelling it.
    expect(discarded).toEqual([])
    expect(inserted).toEqual([stepA.id, stepB.id, turnA.id, turnB.id])
  })

  it('reports a missing identity instead of mutating the log', () => {
    const session = Session.create(SessionId('inbox-missing'))
    const inbox = new FreeCodeGoNativeInbox(session, sink().notifications)
    inbox.append('next-turn', message('present'))
    const before = session.snapshotEvents().length
    const absent = message('absent')

    expect(inbox.remove(absent.id)).toBe(false)
    expect(inbox.replace(absent.id, message('replacement'))).toBe(false)
    expect(session.snapshotEvents()).toHaveLength(before)
    expect(inbox.nextTurn).toHaveLength(1)
  })
})
