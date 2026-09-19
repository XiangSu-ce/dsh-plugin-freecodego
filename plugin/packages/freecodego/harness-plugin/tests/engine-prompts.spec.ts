/**
 * The native-engine system prompts.
 *
 * A prompt is a specification the model follows literally, so a tool it names is
 * a tool the model will call. The Claude prompt used to end with "use
 * freecodego_generate_image, freecodego_generate_video, or
 * freecodego_generate_audio" — the *Harness registry* names. Nothing can call
 * those on this transport: every Harness tool is mounted through the SDK MCP
 * server as `mcp__freecodego-host__freecodego_harness_<name>`, so a model that
 * obeyed got an unknown-tool failure instead of an image.
 *
 * The names below are therefore checked two ways: that the prompt states the
 * callable name, and that the stated name is the one the mounted inventory
 * derives — importing the same helpers rather than restating the prefix here.
 *
 * The Codex prompt is the second half of that story, and it is why both are in
 * this file. The Claude prompt was fixed by deriving the media names from the
 * mounted inventory; `codexSystemPrompt` kept the hard-coded sentence naming all
 * three unconditionally, so a Codex session whose media tools are deferred (the
 * default) was instructed to call tools absent from its own inventory — the same
 * defect in the sibling function, surviving because nothing exercised it. Both
 * prompts now share one derivation, and both are tested for the three states:
 * every media tool visible, some visible, none visible.
 */

import { describe, expect, it } from 'vitest'
import { claudeHarnessToolName, claudeMcpToolName } from '@deepseek-ai/dsh-freecodego-runtime-claude'
import { claudeSystemPrompt, codexSystemPrompt } from '../src/engine-remotes.ts'
// The prompt helpers take `EngineRemotesHost`; typing the double as any other
// host interface would make it unassignable to the very calls under test.
import type { EngineRemotesHost } from '../src/engine-remotes.ts'

interface ToolSchemaStub {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/** Minimal host whose only interesting surface is the capability snapshot. */
function hostWith(capabilities: {
  readonly mcpEnabled?: boolean
  readonly skillEnabled?: boolean
  readonly mcpTools?: readonly ToolSchemaStub[]
  readonly harnessTools?: readonly ToolSchemaStub[]
}) {
  return {
    capabilities: {
      nativeConfiguration: () => ({
        mcpEnabled: capabilities.mcpEnabled ?? false,
        skillEnabled: capabilities.skillEnabled ?? false,
        skillRoots: [],
        mcpTools: capabilities.mcpTools ?? [],
        harnessTools: capabilities.harnessTools ?? [],
      }),
    },
  } as unknown as EngineRemotesHost
}

const tool = (name: string): ToolSchemaStub => ({ name, description: `the ${name} tool`, parameters: { type: 'object', properties: {} } })

const MEDIA = ['freecodego_generate_image', 'freecodego_generate_video', 'freecodego_generate_audio'] as const

const promptFor = (host: EngineRemotesHost) => claudeSystemPrompt(
  host,
  { provider: 'anthropic', modelId: 'claude-sonnet-4' },
  '/workspace',
  undefined,
)

describe('claudeSystemPrompt', () => {
  it('names the media tools the way this transport actually mounts them', () => {
    const prompt = promptFor(hostWith({ harnessTools: MEDIA.map(name => tool(name)) }))
    for (const name of MEDIA) {
      // Derived from the package that mounts the server, not restated here.
      expect(prompt).toContain(claudeMcpToolName(claudeHarnessToolName(name)))
    }
    // No occurrence of a media tool may be left unprefixed. The lookbehind
    // excludes the `harness_` prefix, so only a bare registry name matches —
    // which is exactly the wording that shipped the broken instruction.
    for (const name of MEDIA) {
      expect(prompt, name).not.toMatch(new RegExp(`(?<![_a-z])${name}`, 'u'))
    }
  })

  it('does not name a media tool that is not mounted', () => {
    const prompt = promptFor(hostWith({ harnessTools: [tool('read'), tool('freecodego_generate_image')] }))
    expect(prompt).toContain(claudeMcpToolName(claudeHarnessToolName('freecodego_generate_image')))
    // Video and audio are absent from the inventory, so the prompt must not
    // offer them: an unmounted name is a call that cannot succeed.
    expect(prompt).not.toContain('freecodego_generate_video')
    expect(prompt).not.toContain('freecodego_generate_audio')
  })

  it('says so plainly when no media tool is mounted at all', () => {
    const prompt = promptFor(hostWith({ harnessTools: [tool('read')] }))
    expect(prompt).toContain('No media-generation tool is mounted for this session')
    expect(prompt).not.toMatch(/freecodego_generate_(?:image|video|audio)/u)
  })

  it('routes a configured MCP tool through its own MCP name, not a harness alias', () => {
    // The mounted inventory excludes a configured MCP tool from the
    // `freecodego_harness_` list, because the MCP route is the one the Host
    // audits. The prompt has to agree, or it names a tool that is not mounted.
    const prompt = promptFor(hostWith({
      mcpEnabled: true,
      mcpTools: [tool('mcp__example__ping')],
      harnessTools: [tool('mcp__example__ping'), tool('read')],
    }))
    expect(prompt).toContain(claudeMcpToolName('mcp__example__ping'))
    expect(prompt).not.toContain('freecodego_harness_mcp__example__ping')
    expect(prompt).toContain(claudeMcpToolName(claudeHarnessToolName('read')))
  })

  it('names the Skill tools only when Skills are enabled', () => {
    const off = promptFor(hostWith({}))
    expect(off).toContain('Harness Skills are currently disabled')
    for (const name of ['freecodego_skill_discover', 'freecodego_skill_load']) {
      expect(off, name).not.toContain(name)
    }
    const on = promptFor(hostWith({ skillEnabled: true }))
    expect(on).toContain(claudeMcpToolName('freecodego_skill_discover'))
    expect(on).toContain(claudeMcpToolName('freecodego_skill_load'))
  })
})

const codexPromptFor = (host: EngineRemotesHost) => codexSystemPrompt(
  host,
  'openai',
  'gpt-5-codex',
  '/workspace',
  undefined,
)

describe('codexSystemPrompt', () => {
  it('names the media tools by the bare names this transport advertises', () => {
    // The Codex bridge mounts Harness tools under their own names, so the
    // correct name here is the registry name — the opposite of the Claude side.
    const prompt = codexPromptFor(hostWith({ harnessTools: MEDIA.map(name => tool(name)) }))
    for (const name of MEDIA) expect(prompt, name).toContain(name)
    expect(prompt).not.toContain('mcp__freecodego-host__')
  })

  it('never names a media tool the Agent cannot see', () => {
    // The measured defect: this line named all three regardless of the
    // inventory, so a default (deferral-enabled) Codex session was told to call
    // tools that `deferred-tools.ts` had denied to it.
    const prompt = codexPromptFor(hostWith({ harnessTools: [tool('read'), tool('freecodego_generate_audio')] }))
    expect(prompt).toContain('freecodego_generate_audio')
    expect(prompt).not.toContain('freecodego_generate_image')
    expect(prompt).not.toContain('freecodego_generate_video')
  })

  it('says so plainly when no media tool is mounted at all', () => {
    const prompt = codexPromptFor(hostWith({ harnessTools: [tool('read')] }))
    expect(prompt).toContain('No media-generation tool is mounted for this session')
    expect(prompt).not.toMatch(/freecodego_generate_(?:image|video|audio)/u)
  })

  it('lists only the Harness tools that are in this Agent\'s inventory', () => {
    const prompt = codexPromptFor(hostWith({ harnessTools: [tool('read'), tool('freecodego_schedule_plan')] }))
    expect(prompt).toContain('freecodego_schedule_plan')
    // A name outside the inventory must not be offered as available.
    expect(prompt).not.toContain('freecodego_generate_image')
  })

  it('drops the subagent-model pointer when that tool is not in the inventory', () => {
    const without = codexPromptFor(hostWith({ harnessTools: [tool('advisor_status')] }))
    expect(without).not.toContain('list_subagent_models')
    const with_ = codexPromptFor(hostWith({ harnessTools: [tool('advisor_status'), tool('list_subagent_models')] }))
    expect(with_).toContain('list_subagent_models')
  })
})

/**
 * Names the transport itself defines, so the prompt may name them whether or not
 * the Harness registry carries them.
 *
 * `freecodego_skill_discover` / `freecodego_skill_load` are MCP tools the Claude
 * sidecar mounts and the Codex worker injects; they bridge back to the Host
 * rather than living in the registry, so `nativeConfiguration()` cannot list them
 * and the deferral rule never touches them. Everything else a prompt emits has to
 * come from the inventory — the two defects this file exists for were both a
 * registry tool named unconditionally.
 */
const TRANSPORT_DEFINED_TOOLS: ReadonlySet<string> = new Set([
  'freecodego_skill_discover',
  'freecodego_skill_load',
])

describe('both native prompts stay inside the Agent inventory', () => {
  const inventory = [tool('read'), tool('advisor_status'), tool('freecodego_generate_image')]

  /**
   * Registry names the prompt actually emits, with the Claude mount folded
   * back: this transport writes a Harness tool as
   * `mcp__freecodego-host__freecodego_harness_<name>`, so the match strips the
   * wrapper to compare against the inventory by its own name.
   */
  const emittedRegistryNames = (prompt: string): readonly string[] =>
    [...new Set([...prompt.matchAll(/(?:freecodego|engineering|advisor)_[a-z0-9_]+/gu)].map(match => match[0]))]
      .map(name => name.replace(/^freecodego_harness_/u, ''))
      .filter(name => !TRANSPORT_DEFINED_TOOLS.has(name))

  it.each([
    ['claude', () => promptFor(hostWith({ skillEnabled: true, harnessTools: inventory }))],
    ['codex', () => codexPromptFor(hostWith({ skillEnabled: true, harnessTools: inventory }))],
  ] as const)('%s names no registry tool the Agent cannot call', (_transport, build) => {
    const orphaned = emittedRegistryNames(build())
      .filter(name => !inventory.some(candidate => candidate.name === name))
    expect(orphaned).toStrictEqual([])
  })

  it.each([
    ['claude', () => promptFor(hostWith({ skillEnabled: false, harnessTools: [] }))],
    ['codex', () => codexPromptFor(hostWith({ skillEnabled: false, harnessTools: [] }))],
  ] as const)('%s names nothing plugin-owned when the inventory is empty', (_transport, build) => {
    expect(emittedRegistryNames(build())).toStrictEqual([])
  })
})
