import { describe, expect, it } from 'vitest'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MEMORY_DREAM_MAX_TOKENS, createMemoryDreamPlanner, memoryDreamPlannerFor, type MemoryDreamLlm } from '../src/memory/memory-dream-model.ts'
import type { ConsolidationRequest } from '../src/memory/dream.ts'

const SESSION = 'session-0001' as SessionId
const ROUTE = { provider: 'opencode', model: 'auto' } as const

/**
 * A request as the pipeline builds one. Built as a literal rather than through
 * `buildConsolidationRequest` so this spec tests the planner, not the renderer:
 * the planner only forwards `system` and `prompt` to the transport, and the
 * observation list plays no part in reading the answer back.
 */
const REQUEST: ConsolidationRequest = {
  system: 'consolidate',
  prompt: 'observations go here',
  tools: [],
  observations: [],
  existingTopics: [],
}

function recordingLlm(produce: () => readonly StreamChunk[]): { llm: MemoryDreamLlm; requests: GenerateOptions[] } {
  const requests: GenerateOptions[] = []
  return {
    requests,
    llm: {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        const chunks = produce()
        return (async function* generate(): AsyncGenerator<StreamChunk> {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }
}

/** A completed text answer plus a finish reason. */
function completed(text: string, reason: FinishReason = { kind: 'stop' }): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason },
  ]
}

function plannerWith(produce: () => readonly StreamChunk[]): {
  planner: ReturnType<typeof createMemoryDreamPlanner>
  requests: GenerateOptions[]
} {
  const { llm, requests } = recordingLlm(produce)
  return { planner: createMemoryDreamPlanner({ llm, route: ROUTE, sessionId: SESSION }), requests }
}

const TOPIC = { slug: 'retries', title: 'Retries', markdown: '# Retries\nBounded and jittered.', sources: ['obs_1'] }

describe('createMemoryDreamPlanner', () => {
  it('reads a bare array of topics', async () => {
    const { planner } = plannerWith(() => completed(JSON.stringify([TOPIC])))
    await expect(planner(REQUEST)).resolves.toEqual([TOPIC])
  })

  it('finds the array when a bracketed word precedes it', async () => {
    // A greedy `\[[\s\S]*\]` ran from the first `[` to the last `]`, so the
    // bracketed word below was captured along with the plan and the parse threw —
    // the module's own header cites the selector for this behaviour, and the
    // selector had the same defect.
    const { planner } = plannerWith(() => completed(`I merged the [retry] notes. Here is the plan: ${JSON.stringify([TOPIC])}`))
    await expect(planner(REQUEST)).resolves.toEqual([TOPIC])
  })

  it('finds the array when a bracketed word follows it', async () => {
    const { planner } = plannerWith(() => completed(`${JSON.stringify([TOPIC])}\n\n(see the [notes] section)`))
    await expect(planner(REQUEST)).resolves.toEqual([TOPIC])
  })

  it('accepts an empty plan as a real answer', async () => {
    // Nothing worth keeping is a valid consolidation outcome, not a failure.
    const { planner } = plannerWith(() => completed('[]'))
    await expect(planner(REQUEST)).resolves.toEqual([])
  })

  it('throws when the answer contains no array at all', async () => {
    const { planner } = plannerWith(() => completed('Nothing to consolidate.'))
    await expect(planner(REQUEST)).rejects.toThrow('the consolidation model returned no JSON array')
  })

  it('throws on a topic entry that is not a well-formed topic', async () => {
    // A half-read plan would write some of what the model proposed and discard
    // the rest, so an entry missing a field is a failure rather than a drop.
    const { planner } = plannerWith(() => completed(JSON.stringify([{ slug: 'retries', title: 'Retries', sources: ['obs_1'] }])))
    await expect(planner(REQUEST)).rejects.toThrow('consolidation topic 0 has no markdown')
  })

  it('throws on a topic whose sources are not observation ids', async () => {
    const { planner } = plannerWith(() => completed(JSON.stringify([{ ...TOPIC, sources: 'obs_1' }])))
    await expect(planner(REQUEST)).rejects.toThrow('consolidation topic 0 has no sources array of observation ids')
  })

  it('throws on an empty field rather than writing a topic with no title', async () => {
    const { planner } = plannerWith(() => completed(JSON.stringify([{ ...TOPIC, title: '   ' }])))
    await expect(planner(REQUEST)).rejects.toThrow('consolidation topic 0 has no title')
  })

  it('throws on a transport error finish', async () => {
    const { planner } = plannerWith(() => completed('', { kind: 'error', failure: { message: 'upstream refused', code: 'EPROVIDER' } }))
    await expect(planner(REQUEST)).rejects.toThrow('upstream refused')
  })

  it('throws rather than accepting a truncated plan', async () => {
    const { planner } = plannerWith(() => completed('[{"slug":"a"', { kind: 'max-tokens' }))
    await expect(planner(REQUEST)).rejects.toThrow('the consolidation answer exceeded its output limit')
  })

  it('sends the configured route, session, and output ceiling', async () => {
    const { planner, requests } = plannerWith(() => completed('[]'))
    await planner(REQUEST)
    expect(requests[0]).toMatchObject({ provider: 'opencode', model: 'auto', sessionId: SESSION, maxTokens: MEMORY_DREAM_MAX_TOKENS })
  })

  it('forwards the request system prompt and names the pass in the message source', async () => {
    const { planner, requests } = plannerWith(() => completed('[]'))
    await planner(REQUEST)
    expect(requests[0]!.system).toBe('consolidate')
    expect(requests[0]!.messages[0]!.content).toContainEqual(expect.objectContaining({ type: 'text' }))
  })
})

describe('memoryDreamPlannerFor', () => {
  const base = { provider: 'opencode', model: 'auto', sessionId: SESSION } as const

  it('returns undefined when no LLM is mounted', () => {
    expect(memoryDreamPlannerFor({ ...base, llm: undefined })).toBeUndefined()
  })

  it('returns undefined when the provider or model is empty or blank', () => {
    const { llm } = recordingLlm(() => completed('[]'))
    expect(memoryDreamPlannerFor({ ...base, provider: '', llm })).toBeUndefined()
    expect(memoryDreamPlannerFor({ ...base, provider: '  ', llm })).toBeUndefined()
    expect(memoryDreamPlannerFor({ ...base, model: '', llm })).toBeUndefined()
    expect(memoryDreamPlannerFor({ ...base, model: '\t ', llm })).toBeUndefined()
  })

  it('trims the route before using it', async () => {
    const { llm, requests } = recordingLlm(() => completed('[]'))
    const planner = memoryDreamPlannerFor({ ...base, provider: ' opencode ', model: ' auto ', llm })
    expect(planner).toBeDefined()
    await planner!(REQUEST)
    expect(requests[0]).toMatchObject({ provider: 'opencode', model: 'auto' })
  })
})
