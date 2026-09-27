/**
 * The collector's two rules are what keep the breakdown honest: a tagged block
 * is counted in its own bucket and removed from the conversation (never both),
 * and an unclassified tag stays in the conversation (never nowhere). Both are
 * asserted here, along with the call/result split the usage tree depends on.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectPromptCompositionSources, collectPromptUsageItems, segmentPromptText, segmentSystemPrompt } from '../src/prompt-composition-collect.ts'
import { buildPromptComposition, estimateTokensFromChars } from '../src/prompt-composition.ts'
import { starterSkillDirectory } from '../src/engineering.ts'
import { parseSkillDocument } from '../src/skills/publish.ts'

const userMessage = (text: string): { type: string; seq: number; data: unknown } => ({
  type: 'user/message',
  seq: 1,
  data: { message: { role: 'user', content: [{ type: 'text', text }] } },
})

/** One committed system-prompt node, the shape `agent-loop` appends. */
const systemMessage = (text: string, seq = 1): { type: string; seq: number; data: unknown } => ({
  type: 'system/message',
  seq,
  data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text }] } },
})

describe('the system prompt, where this Harness actually puts it', () => {
  it('reads system/message events rather than a header field that no longer exists', () => {
    // `EpochHeader.system` is `never` in this Harness: `agent-loop` renders the
    // assembly and commits it as `system/message` events. Reading only the header
    // left the system prompt in no row at all — and because the conversation row is
    // the residual, its tokens were silently added to the transcript instead.
    const sources = collectPromptCompositionSources(undefined, [
      systemMessage('you are a coding agent', 1),
      userMessage('do the thing'),
    ])
    expect(sources['system-prompt']).toEqual(['you are a coding agent'])
    expect(sources.conversation).toEqual(['do the thing'])
  })

  it('counts every surviving node and skips the emptied ones', () => {
    // The projection keeps the prompt in history by appending changed text and
    // emptying the nodes it replaced; an emptied node contributes nothing because
    // it is no longer part of what the request carries.
    const sources = collectPromptCompositionSources(undefined, [
      systemMessage('first render', 1),
      systemMessage('', 2),
      systemMessage('second render', 3),
    ])
    // Joined with the renderer's own separator, because the nodes are one prompt
    // read in order and a section may span the join; the emptied node contributes
    // nothing at all rather than an empty entry.
    expect(sources['system-prompt']).toEqual(['first render\n\nsecond render'])
  })
})

describe('system-prompt section attribution', () => {
  const SECTIONS = [
    { name: 'MCP_SERVERS/' + 'mcp:filesystem', text: 'Filesystem server instructions: use absolute paths.' },
    { name: 'tool:read', text: 'Read before you edit.' },
    { name: 'deployment:persona-suffix', text: 'Be concise.' },
  ]

  it('names the MCP and tool-guidance text by its section, and leaves the rest as system text', () => {
    // The rendered system prompt is sections joined with blank lines and carries no
    // markers, so the name on the assembly is the only classification there is.
    const text = [SECTIONS[0]!.text, SECTIONS[2]!.text, 'You are a coding agent.', SECTIONS[1]!.text].join('\n\n')
    const segments = segmentSystemPrompt(text, [
      { name: 'mcp:filesystem', text: SECTIONS[0]!.text },
      { name: 'tool:read', text: SECTIONS[1]!.text },
      { name: 'deployment:persona-suffix', text: SECTIONS[2]!.text },
    ])
    expect(segments.map(segment => segment.categoryId)).toEqual(['mcp', 'system-prompt', 'tools'])
    // Moved, not copied, and nothing dropped: the rows together are exactly the
    // collected text, with the separators between sections left in system text
    // where the renderer put them.
    expect(segments.map(segment => segment.text).join('')).toBe(text)
    expect(segments[1]!.text).toContain('Be concise.')
  })

  it('declines to attribute a section whose text the session does not carry', () => {
    // A section that changed between the assembly and the request (or one whose text
    // is still an uninterpolated `{{variable}}`) is not found verbatim, and the honest
    // answer is then the old one: all of it is system text. Guessing an offset here
    // would move characters no provider put there.
    const text = 'You are a coding agent.\n\nMCP_SERVERS instructions were re-rendered.'
    expect(segmentSystemPrompt(text, [{ name: 'mcp:filesystem', text: 'filesystem instructions' }]))
      .toEqual([{ categoryId: 'system-prompt', text }])
    expect(segmentSystemPrompt(text, undefined)).toEqual([{ categoryId: 'system-prompt', text }])
  })

  it('attributes a repeated section text twice rather than once', () => {
    // A section rendered twice is two blocks in the prompt, and a splitter that
    // stopped at the first hit would leave the second one in system text.
    const text = ['Tool: go.\n\n', 'middle\n\n', 'Tool: go.'].join('')
    const segments = segmentSystemPrompt(text, [{ name: 'tool:goal', text: 'Tool: go.' }])
    expect(segments.filter(segment => segment.categoryId === 'tools')).toHaveLength(2)
    expect(segments.map(segment => segment.text).join('')).toBe(text)
  })

  it('routes the whole system prompt through the collector with its sections', () => {
    const mcp = 'Filesystem server instructions: use absolute paths.'
    const tools = 'Read before you edit.'
    const sources = collectPromptCompositionSources(undefined, [
      systemMessage(['You are a coding agent.', mcp, tools].join('\n\n')),
      userMessage('do the thing'),
    ], {
      systemSections: [{ name: 'mcp:filesystem', text: mcp }, { name: 'tool:read', text: tools }],
    })
    expect(sources.mcp).toEqual([mcp])
    expect(sources.tools).toEqual([tools])
    expect((sources['system-prompt'] ?? []).join('')).toContain('You are a coding agent.')
    // Nothing dropped and nothing counted twice: the rows together hold exactly the
    // characters the session carried.
    const text = ['You are a coding agent.', mcp, tools].join('\n\n')
    const counted = (['system-prompt', 'mcp', 'tools'] as const)
      .flatMap(id => sources[id] ?? [])
      .reduce((sum, segment) => sum + segment.length, 0)
    expect(counted).toBe(text.length)
    expect(sources.conversation).toEqual(['do the thing'])
  })
})

describe('the system-reminder wrapper', () => {
  it('files the workspace instruction baseline as Rules', () => {
    // `agent-instructions` bakes AGENTS.md and friends in one wrapper: the project's
    // standing rules, which used to land in the conversation because the wrapper tag
    // was unknown to the segmenter.
    const text = [
      '<system-reminder>',
      'The following workspace instructions may be relevant to your work.',
      '',
      '## AGENTS.md',
      'Always run the tests.',
      '</system-reminder>',
      '',
      'and the user words',
    ].join('\n')
    const { blocks, remainder } = segmentPromptText(text)
    expect(blocks.rules).toHaveLength(1)
    expect(blocks.rules![0]).toContain('Always run the tests.')
    expect(remainder.trim()).toBe('and the user words')
  })

  it('defers to a recognised block nested inside it', () => {
    // `tool-skill` wraps its `available_skills` catalog in the same wrapper. Treating
    // the wrapper as the bucket would file every Skill catalog under Rules.
    const text = '<system-reminder>\n<available_skills>\n- a: b\n</available_skills>\n</system-reminder>'
    const { blocks, remainder } = segmentPromptText(text)
    expect(blocks.skills).toEqual([text])
    expect(blocks.rules).toBeUndefined()
    expect(remainder).toBe('')
  })
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

  it('moves a Skill body a tool call returned out of the conversation', () => {
    // The `skill` tool's result *is* the Skill: the core renders it as one
    // `<skill_content>` block carrying `<skill_resources>` and
    // `<skill_instructions>` (see `packages/skill/skill` `renderSkillContent`).
    // Reading tool results without segmenting them dumped every loaded Skill
    // body into the conversation row, and because that row is the residual it
    // never looked wrong — it just made the Skills row structurally too small
    // for the one event that is entirely Skills. A Skill body is also the
    // largest single item a session can add at once, which is exactly the case
    // the breakdown exists to name.
    const rendered = [
      '<skill_content name="engineering-ui-design">',
      '<skill_resources>',
      'Base directory for this skill: /skills/engineering-ui-design',
      'Load referenced resources only as needed.',
      '</skill_resources>',
      '',
      '<skill_instructions>',
      '# Interface Design\n\nGive the defaults instead of asking.',
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n')
    const sources = collectPromptCompositionSources(undefined, [
      { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'skill', arguments: '{"name":"engineering-ui-design"}' } },
      { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: rendered }] }] } } },
    ])
    const skills = (sources.skills ?? []).join('\n')
    expect(skills).toContain('<skill_instructions>')
    expect(skills).toContain('Give the defaults instead of asking.')
    // Moved, not copied: the wrapper tag and the resource hint go with it, or
    // the block is counted in two rows at once.
    expect(skills).toContain('<skill_content name="engineering-ui-design">')
    expect((sources.conversation ?? []).join('\n')).not.toContain('<skill_content')
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

describe('the Skills row of a request that loaded a Skill', () => {
  it('counts the Skill body in Skills and leaves the transcript alone', () => {
    // The whole chain, on one event log, with the file this package actually
    // ships: a bundled `SKILL.md` is read, stripped of its frontmatter the way the
    // core strips it, wrapped the way `renderSkillContent` wraps it, and delivered
    // as the `skill` tool's result. The figure a user acts on is not "a block
    // moved" but "that block was N tokens of my window, and it is now visible as
    // Skills" — so the assertion is the shipped file's own size, not a fixture's.
    const { body } = parseSkillDocument(readFileSync(join(starterSkillDirectory(), 'engineering-ui-design', 'SKILL.md'), 'utf8'))
    expect(body.length).toBeGreaterThan(5_000)
    const rendered = ['<skill_content name="engineering-ui-design">', '<skill_resources>', 'base', '</skill_resources>', '', '<skill_instructions>', body, '</skill_instructions>', '</skill_content>'].join('\n')
    const snapshot = buildPromptComposition({
      sources: collectPromptCompositionSources(undefined, [
        userMessage('make the settings page look less cramped'),
        { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'Reading the Skill.' }] } } },
        { type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'skill', arguments: '{"name":"engineering-ui-design"}' } },
        { type: 'tool/result', seq: 4, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: rendered }] }] } } },
      ]),
    })
    const tokens = (id: string): number => snapshot.categories.find(category => category.id === id)?.tokens ?? 0
    const chars = (id: string): number => snapshot.categories.find(category => category.id === id)?.chars ?? 0
    // Every character of the Skill — wrapper, resource hint and body — in the
    // Skills row, priced at the plugin's one estimation entry point.
    expect(chars('skills')).toBe(rendered.length)
    expect(tokens('skills')).toBe(estimateTokensFromChars(rendered.length))
    // The conversation keeps the turn and the call, and none of the Skill. A
    // conversation row that grew by the Skill's size is the defect this asserts
    // against, and it is invisible in an apportioned table — which is why the
    // figure is bounded here rather than only checked for containment.
    expect(tokens('conversation')).toBeLessThan(100)
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

  it('files a Skill the model loaded under Skills, not under the transcript', () => {
    // The tree and the breakdown have to agree about where a loaded Skill's
    // bytes are: the breakdown moves a tagged block into its own row, so a tree
    // that still hung the same bytes under Conversation would show a reader two
    // different answers to "what is the Skills block made of".
    const rendered = '<skill_content name="engineering-ui-design">\n<skill_resources>\nx\n</skill_resources>\n\n<skill_instructions>\nBODY\n</skill_instructions>\n</skill_content>'
    const { items } = collectPromptUsageItems([
      { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'skill', arguments: '{"name":"engineering-ui-design"}' } },
      { type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: rendered }] }] } } },
      { type: 'tool/result', seq: 3, data: { message: { source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'exit code 0\n<rules>be brief</rules>' }] }] } } },
    ])
    expect(items.find(item => item.callId === 'c1' && item.role === 'result')?.categoryId).toBe('skills')
    // Mixed text is not split: one node carries one category, or the same
    // characters would be counted in two rows.
    expect(items.find(item => item.callId === 'c2' && item.role === 'result')?.categoryId).toBe('conversation')
    // The call itself stays the transcript's: its arguments are the request,
    // not the Skill.
    expect(items.find(item => item.callId === 'c1' && item.role === 'call')?.categoryId).toBe('conversation')
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
