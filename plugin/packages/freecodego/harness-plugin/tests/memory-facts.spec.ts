import { describe, expect, it } from 'vitest'
import {
  MAX_FACTS_PER_LIST,
  MAX_FACT_TEXT_CHARS,
  conversationArcText,
  foldConversationArc,
  type ConversationArcEvent,
  type ConversationArcMemory,
} from '../src/memory/memory-facts.ts'

const goalChange = (goal: Record<string, unknown>, time?: number): ConversationArcEvent => ({
  type: 'goal/change',
  ...(time === undefined ? {} : { time }),
  data: { kind: 'goal/change', version: 1, operation: 'create', goal, roundsStarted: 0, createdAt: time ?? 0, updatedAt: time ?? 0 },
})

/**
 * A Stripe-shaped live key, composed rather than written out.
 *
 * GitHub's push protection refuses a push carrying the literal `sk_live_…` even
 * inside a fixture, and it reads the committed bytes instead of the runtime
 * value; `memory-document.spec.ts` states the same reasoning once more.
 */
const STRIPE_LIVE_KEY = 'sk_live_' + 'A'.repeat(24)

/** A half of a surrogate pair: what a byte-count cut leaves behind. */
const hasLoneSurrogate = (value: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)

describe('conversation arc: goals from goal/change events', () => {
  it('never cuts a goal or a message in half', () => {
    // The caps count UTF-16 code units on text the user and the model wrote, and
    // the arc is injected into a later session: a half character stored here is
    // a replacement glyph there — and in the export the user opens.
    const objective = `${'a'.repeat(MAX_FACT_TEXT_CHARS - 1)}\u{1F600}`
    const arc = foldConversationArc([goalChange({ id: 'goal_a', objective, phase: 'active', createdAt: 1 }, 1)])
    const text = conversationArcText(arc)
    expect(text).toContain('…')
    expect(hasLoneSurrogate(text)).toBe(false)
  })
  it('folds the latest snapshot per goal id', () => {
    const arc = foldConversationArc([
      goalChange({ id: 'goal_a', objective: 'first wording', phase: 'active', createdAt: 100 }, 100),
      goalChange({ id: 'goal_a', objective: 'edited objective', phase: 'active', createdAt: 100 }, 200),
      goalChange({ id: 'goal_b', objective: 'other goal', phase: 'active', createdAt: 150 }, 150),
    ])
    expect(arc.goals).toHaveLength(2)
    const goalA = arc.goals.find(goal => goal.id === 'goal_a')
    expect(goalA?.objective).toBe('edited objective')
    expect(goalA?.updatedAt).toBe(200)
  })

  it('retires a cleared goal and keeps a completed one visible', () => {
    const arc = foldConversationArc([
      goalChange({ id: 'goal_a', objective: 'done deal', phase: 'completed', createdAt: 100 }, 100),
      goalChange({ id: 'goal_b', objective: 'doomed', phase: 'active', createdAt: 120 }, 120),
      { type: 'goal/change', time: 300, data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'goal_b' }, clearedAt: 300 } },
    ])
    expect(arc.goals.map(goal => goal.id)).toEqual(['goal_a'])
    expect(arc.goals[0]?.phase).toBe('completed')
  })

  it('carries a blocked reason through the fold', () => {
    const arc = foldConversationArc([
      goalChange({ id: 'goal_a', objective: 'ship it', phase: 'blocked', createdAt: 100, blockedReason: 'flaky CI on windows' }, 150),
    ])
    expect(arc.goals[0]?.blockedReason).toBe('flaky CI on windows')
  })

  it('ignores events that are not version-1 goal changes', () => {
    const arc = foldConversationArc([
      { type: 'goal/change', data: { kind: 'other', version: 1 } },
      { type: 'goal/change', data: { kind: 'goal/change', version: 2, goal: { id: 'goal_x', objective: 'x', phase: 'active' } } },
      { type: 'tool/call', data: { name: 'read' } },
    ])
    expect(arc.goals).toEqual([])
  })

  it('degrades gracefully on structurally broken goal payloads', () => {
    const arc = foldConversationArc([
      // A clear tombstone with no id, and a snapshot with no goal object.
      { type: 'goal/change', time: 10, data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: {} } },
      { type: 'goal/change', time: 20, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { phase: 'active' } } },
      // A snapshot whose timestamps and reason fields are the wrong shape: the
      // objective is dropped (a non-string is not text to clamp) rather than
      // coerced, and the text renderer falls back to the id.
      goalChange({ id: 'goal_bad', objective: 42, phase: 'active', createdAt: 'yesterday', blockedReason: 7 }, 30),
    ])
    expect(arc.goals).toHaveLength(1)
    expect(arc.goals[0]?.id).toBe('goal_bad')
    expect(arc.goals[0]?.objective).toBe('')
    expect(arc.goals[0]?.blockedReason).toBeUndefined()
  })

  it('derives event time from the event when the stamp is missing', () => {
    const arc = foldConversationArc([
      { type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'goal_a', objective: 'no stamp', phase: 'active', createdAt: 5 } } },
    ])
    expect(arc.goals[0]?.createdAt).toBe(5)
    expect(arc.goals[0]?.updatedAt).toBe(0)
  })

  it('clears a goal that was never folded and updates an existing one in place', () => {
    // Clear first: there is no previous snapshot, so the tombstone records the
    // zero-value defaults before the filter drops it.
    const arc = foldConversationArc([
      { type: 'goal/change', time: 10, data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'goal_ghost' } } },
      goalChange({ id: 'goal_real', objective: 'subject', phase: 'active', createdAt: 100 }, 100),
      goalChange({ id: 'goal_real', objective: 'subject, amended', phase: 'active', createdAt: 100 }, 250),
    ])
    expect(arc.goals).toHaveLength(1)
    expect(arc.goals[0]?.updatedAt).toBe(250)
  })

  it('ignores a clear tombstone whose payload is not an object', () => {
    const arc = foldConversationArc([
      { type: 'goal/change', time: 10, data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: 'garbage' } },
      goalChange({ id: 'goal_real', objective: 'subject', phase: 'active', createdAt: 100 }, 100),
    ])
    expect(arc.goals.map(goal => goal.id)).toEqual(['goal_real'])
  })

  it('truncates a long objective and labels a missing phase', () => {
    const long = `migrate ${'x'.repeat(MAX_FACT_TEXT_CHARS)}`
    const arc = foldConversationArc([
      { type: 'goal/change', time: 10, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'goal_long', objective: long, createdAt: 10 } } },
      { type: 'goal/change', time: 20, data: 'not an object' },
    ])
    expect(arc.goals[0]?.objective).toBe(`${long.slice(0, MAX_FACT_TEXT_CHARS)}…`)
    expect(arc.goals).toHaveLength(1)
  })

  it('survives non-object payloads and malformed assistant blocks', () => {
    const arc = foldConversationArc([
      // A clear whose payload is not an object at all.
      { type: 'goal/change', time: 10, data: 'garbage' },
      // A goal snapshot whose goal payload is not an object.
      { type: 'goal/change', time: 20, data: { kind: 'goal/change', version: 1, operation: 'create', goal: 'garbage' } },
      // Assistant events whose message or content blocks are the wrong shape.
      { type: 'assistant/message', data: 'not an object' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text' }, 'plain string', { type: 'text', text: 'We will use the chosen path forward.' }] } } },
    ])
    expect(arc.goals).toEqual([])
    expect(arc.decisions.map(decision => decision.text)).toEqual(['We will use the chosen path forward.'])
  })

  it('renders the blocked reason and the memory attribution', () => {
    const arc = foldConversationArc(
      [goalChange({ id: 'goal_a', objective: 'ship', phase: 'blocked', createdAt: 100, blockedReason: 'flaky CI' }, 100)],
      [({ id: 'mem_a', kind: 'decision', title: 'Ship on Friday.', createdAt: 50 })],
    )
    const text = conversationArcText(arc)
    expect(text).toContain('[blocked] ship — blocked: flaky CI')
    expect(text).toContain('Ship on Friday. (recorded in project memory)')
  })

  it('caps the retained goals at the newest', () => {
    const events = Array.from({ length: MAX_FACTS_PER_LIST + 4 }, (_value, index) =>
      goalChange({ id: `goal_${index}`, objective: `objective ${index}`, phase: 'active', createdAt: index * 10 }, index * 10))
    const arc = foldConversationArc(events)
    expect(arc.goals).toHaveLength(MAX_FACTS_PER_LIST)
    expect(arc.goals[0]?.id).toBe('goal_4')
    expect(arc.goals.at(-1)?.id).toBe(`goal_${MAX_FACTS_PER_LIST + 3}`)
  })
})

describe('conversation arc: decisions from promoted memory', () => {
  const memory = (overrides: Partial<ConversationArcMemory> & { readonly id: string }): ConversationArcMemory => ({
    title: 'a decision',
    kind: 'decision',
    createdAt: 100,
    ...overrides,
  })

  it('takes only decision-kind records, newest first', () => {
    const arc = foldConversationArc([], [
      memory({ id: 'mem_a', kind: 'discovery', title: 'not a choice' }),
      memory({ id: 'mem_b', kind: 'decision', title: 'older choice', createdAt: 100 }),
      memory({ id: 'mem_c', kind: 'decision', title: 'newer choice', createdAt: 200 }),
    ])
    expect(arc.decisions.map(decision => decision.text)).toEqual(['newer choice', 'older choice'])
    expect(arc.decisions.every(decision => decision.origin === 'memory')).toBe(true)
  })
})

describe('conversation arc: decisions from assistant messages', () => {
  it('extracts an announced choice and tags its origin', () => {
    const arc = foldConversationArc([
      { type: 'assistant/message', time: 500, data: { message: { content: [{ type: 'text', text: 'We will use the retry queue for delivery.' }] } } },
    ])
    expect(arc.decisions).toEqual([{ text: 'We will use the retry queue for delivery.', origin: 'assistant', at: 500 }])
  })

  it('matches the varied decision phrasings', () => {
    const lines = [
      "Let's switch to the polling approach.",
      'We should keep the old parser until the new one is verified.',
      'The team decided on SQLite after profiling.',
      'I will adopt the stricter lint rules.',
    ]
    const arc = foldConversationArc([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: lines.join('\n') }] } } },
    ])
    expect(arc.decisions).toHaveLength(4)
  })

  it('ignores lines without a choice pattern', () => {
    const arc = foldConversationArc([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The build passed and all tests are green now.' }] } } },
    ])
    expect(arc.decisions).toEqual([])
  })

  it('refuses to quote a line that carries a credential', () => {
    // `sk_live_…` is a high-confidence stripe rule in secret-scan.ts; `sk-proj-`
    // is deliberately NOT one — the medium `generic-secret-key` rule requires no
    // dash after the prefix, so this shape is out of its reach by design.
    const arc = foldConversationArc([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `We'll use the key ${STRIPE_LIVE_KEY} for payments.` }] } } },
    ])
    expect(arc.decisions).toEqual([])
  })

  it('orders the decisions newest first so a long session keeps its latest', () => {
    // Both lists have always claimed to be newest-first, and the cap keeps the
    // first MAX_FACTS_PER_LIST of them — so a list built in scan order retained
    // the session's *earliest* announcements and dropped the newest, which is
    // the half a later session needs.
    const message = (text: string, time: number): ConversationArcEvent => ({
      type: 'assistant/message', time, data: { message: { content: [{ type: 'text', text }] } },
    })
    const arc = foldConversationArc([
      message('We will use the alpha approach.', 100),
      message('We will use the beta approach.', 200),
      message('We will use the gamma approach.', 300),
    ])
    expect(arc.decisions.map(decision => decision.at)).toEqual([300, 200, 100])
  })

  it('caps the combined decisions at the newest, not the earliest', () => {
    const count = MAX_FACTS_PER_LIST + 3
    const events = Array.from({ length: count }, (_value, index) => ({
      type: 'assistant/message',
      time: (index + 1) * 10,
      data: { message: { content: [{ type: 'text', text: `We will use approach number ${index}.` }] } },
    })) satisfies ConversationArcEvent[]
    const arc = foldConversationArc(events)
    expect(arc.decisions).toHaveLength(MAX_FACTS_PER_LIST)
    expect(arc.decisions[0]?.at).toBe(count * 10)
    // The three that fell outside the cap are the oldest three.
    expect(arc.decisions.some(decision => decision.at === 10)).toBe(false)
  })

  it('scans only the message tail', () => {
    // The buried choice sits near offset 0 of a ~2 900-char message, far outside
    // the 900-char tail; the live one sits inside the tail and is the only hit.
    const filler = 'The rest of the answer continues here. '.repeat(75)
    const buried = `We will use the deep archive choice. ${filler}`
    const arc = foldConversationArc([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `${buried}We will use the live choice.` }] } } },
    ])
    expect(arc.decisions.map(decision => decision.text)).toEqual(['We will use the live choice.'])
  })

  it('skips lines that are too short or too long to be a decision', () => {
    const long = `We will use ${'x'.repeat(MAX_FACT_TEXT_CHARS)}`
    const arc = foldConversationArc([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `use it\n${long}` }] } } },
    ])
    expect(arc.decisions).toEqual([])
  })
})

describe('conversation arc: dedup and rendering', () => {
  it('says a decision once when memory and the message agree', () => {
    const arc = foldConversationArc(
      [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'We will use the queue for delivery.' }] } } }],
      [({ id: 'mem_a', kind: 'decision', title: 'We will use the queue for delivery.', createdAt: 900 })],
    )
    expect(arc.decisions).toHaveLength(1)
  })

  it('caps combined decisions at the memory-first limit', () => {
    const memories = Array.from({ length: MAX_FACTS_PER_LIST }, (_value, index) =>
      ({ id: `mem_${index}`, kind: 'decision', title: `memory choice ${index}`, createdAt: index }) satisfies ConversationArcMemory)
    const arc = foldConversationArc(
      [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'We will use the shiny new thing.' }] } } }],
      memories,
    )
    expect(arc.decisions).toHaveLength(MAX_FACTS_PER_LIST)
    expect(arc.decisions.some(decision => decision.origin === 'assistant')).toBe(false)
  })

  it('renders nothing when the session has no arc', () => {
    expect(conversationArcText(foldConversationArc([], []))).toBe('')
  })

  it('renders goals and decisions as bounded prompt text', () => {
    const arc = foldConversationArc([
      goalChange({ id: 'goal_a', objective: 'migrate the billing service', phase: 'active', createdAt: 100 }, 100),
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: "Let's use the queue for delivery." }] } } },
    ])
    const text = conversationArcText(arc)
    expect(text).toContain('### Goals this session pursued')
    expect(text).toContain('- [active] migrate the billing service')
    expect(text).toContain('### Decisions made')
    expect(text).toContain("Let's use the queue for delivery.")
  })

  it('falls back to the goal id when the objective is missing', () => {
    const arc = foldConversationArc([goalChange({ id: 'goal_a', objective: '', phase: 'active', createdAt: 100 }, 100)])
    expect(conversationArcText(arc)).toContain('- [active] goal_a')
  })
})
