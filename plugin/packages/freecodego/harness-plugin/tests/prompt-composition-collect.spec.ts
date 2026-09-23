/**
 * The collector's two rules are what keep the breakdown honest: a tagged block
 * is counted in its own bucket and removed from the conversation (never both),
 * and an unclassified tag stays in the conversation (never nowhere). Both are
 * asserted here, along with the call/result split the usage tree depends on.
 */

import { describe, expect, it } from 'vitest'
import { collectPromptCompositionSources, collectPromptUsageItems, segmentPromptText } from '../src/prompt-composition-collect.ts'

const userMessage = (text: string): { type: string; seq: number; data: unknown } => ({
  type: 'user/message',
  seq: 1,
  data: { message: { role: 'user', content: [{ type: 'text', text }] } },
})

describe('prompt text segmentation', () => {
  it('moves a recognised block out of the conversation', () => {
    const text = 'before\n<freecodego-skill-map>\n- a: b\n</freecodego-skill-map>\nafter'
    const { blocks, remainder } = segmentPromptText(text)
    expect(blocks.skills).toEqual(['<freecodego-skill-map>\n- a: b\n</freecodego-skill-map>'])
    expect(remainder).toBe('before\n\nafter')
  })

  it('routes each known tag to its own bucket', () => {
    const text = [
      '<rules><r>one</r></rules>',
      '<available_skills>skills here</available_skills>',
      '<mcp_filesystem>fs</mcp_filesystem>',
      '<dynamic_tool_catalog>dyn</dynamic_tool_catalog>',
      '<available_subagent_types>- a: b</available_subagent_types>',
    ].join('\n')
    const { blocks, remainder } = segmentPromptText(text)
    expect(blocks.rules).toHaveLength(1)
    expect(blocks.skills).toHaveLength(1)
    expect(blocks.mcp).toHaveLength(2)
    expect(blocks.subagents).toHaveLength(1)
    expect(remainder).toBe('\n\n\n\n')
  })

  it('keeps an unclassified tag in the conversation', () => {
    // Dropping it would make the rows under-count the prompt while looking
    // complete, which is the worse of the two errors.
    const { blocks, remainder } = segmentPromptText('<something_new>keep me</something_new>')
    expect(blocks).toEqual({})
    expect(remainder).toBe('<something_new>keep me</something_new>')
  })

  it('ignores a block that was never closed', () => {
    const { blocks, remainder } = segmentPromptText('<rules>half a block')
    expect(blocks.rules).toBeUndefined()
    expect(remainder).toBe('<rules>half a block')
  })

  it('counts a nested block once, in the outer bucket', () => {
    const { blocks } = segmentPromptText('<mcp_a><mcp_b>inner</mcp_b></mcp_a>')
    expect(blocks.mcp).toEqual(['<mcp_a><mcp_b>inner</mcp_b></mcp_a>'])
  })
})

describe('source collection', () => {
  it('reads the system prompt and the tool block off the header as rendered', () => {
    const sources = collectPromptCompositionSources({
      system: 'you are a coding agent',
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    }, [])
    expect(sources['system-prompt']).toEqual(['you are a coding agent'])
    expect(sources.tools?.[0]).toBe('read read a file {"type":"object"}')
  })

  it('splits a transcript into conversation, tagged buckets, and the summary', () => {
    const sources = collectPromptCompositionSources(undefined, [
      userMessage('do the thing\n<rules><r>be brief</r></rules>'),
      { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } } },
      { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', seq: 4, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a.ts' }] }] } } },
      // The kind the core's compaction actually stamps on a summary message.
      { type: 'user/message', seq: 5, data: { message: { role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'c1' }, content: [{ type: 'text', text: 'the summary so far' }] } } },
    ])
    expect(sources.rules).toHaveLength(1)
    expect(sources.conversation).toContain('do the thing\n')
    expect(sources.conversation).toContain('working on it')
    expect(sources.conversation).toContain('bash {"command":"ls"}')
    expect(sources.conversation).toContain('a.ts')
    expect(sources.summary).toEqual(['the summary so far'])
  })

  it('reads the summarized conversation from the event compaction actually writes', () => {
    // The Harness commits `compaction/summary` with the replacement text; it does
    // not write a summary *message*. Reading only the message shape is what left
    // the `summary` row structurally zero in this composition.
    const sources = collectPromptCompositionSources(undefined, [
      userMessage('do the thing'),
      { type: 'compaction/summary', seq: 2, data: { compactionId: 'c1', summary: [{ type: 'text', text: 'earlier history, condensed' }] } },
    ])
    expect(sources.summary).toEqual(['earlier history, condensed'])
    expect(sources.conversation).not.toContain('earlier history, condensed')
  })

  it('counts the summary once when both shapes are present', () => {
    // Both carry the same characters, so counting both would report the
    // summarized conversation at twice its size — a bigger error than zero.
    const sources = collectPromptCompositionSources(undefined, [
      { type: 'user/message', seq: 1, data: { message: { role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'c1' }, content: [{ type: 'text', text: 'condensed' }] } } },
      { type: 'compaction/summary', seq: 2, data: { compactionId: 'c1', summary: [{ type: 'text', text: 'condensed' }] } },
    ])
    expect(sources.summary).toEqual(['condensed'])
  })

  it('keeps only the latest compaction summary', () => {
    // A second compaction summarizes the first one's output, so adding them
    // would count the same history twice.
    const sources = collectPromptCompositionSources(undefined, [
      { type: 'compaction/summary', seq: 1, data: { compactionId: 'a', summary: [{ type: 'text', text: 'first' }] } },
      { type: 'compaction/summary', seq: 2, data: { compactionId: 'b', summary: [{ type: 'text', text: 'second' }] } },
    ])
    expect(sources.summary).toEqual(['second'])
  })

  it('leaves the bucket absent when a summary carries no text', () => {
    const sources = collectPromptCompositionSources(undefined, [
      { type: 'compaction/summary', seq: 1, data: { compactionId: 'a', summary: [] } },
    ])
    expect(sources.summary).toBeUndefined()
  })
})

describe('usage item collection', () => {
  it('keeps call and result separate so the tree can pair them', () => {
    const { items } = collectPromptUsageItems([
      { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'read', arguments: '{}' } },
      { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'body' }] }] } } },
    ])
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ callId: 'c1', role: 'call', label: 'read' })
    expect(items[1]).toMatchObject({ callId: 'c1', role: 'result' })
  })

  it('keeps the newest items and reports what the cap left out', () => {
    const events = Array.from({ length: 12 }, (_, index) => userMessage(`message ${String(index)}`))
    const { items, omitted } = collectPromptUsageItems(events, 5)
    expect(items).toHaveLength(5)
    expect(omitted).toBe(7)
    expect(items[4]!.text).toContain('message 11')
  })

  it('ignores events that carry no text and a result with no call id', () => {
    const { items } = collectPromptUsageItems([
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'tool/result', seq: 2, data: { message: { content: [{ type: 'text', text: 'orphan' }] } } },
    ])
    expect(items).toHaveLength(0)
  })
})
