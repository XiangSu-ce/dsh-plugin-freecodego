/**
 * The SOLO think-effort control: which families have a level at all, and where the
 * level actually goes.
 *
 * SOLO states no reasoning field, so every level is a system-prompt block, and the
 * wording per family is the part that was measured rather than invented. These
 * cases pin the three things that would otherwise drift silently: which routes get
 * a menu, which sentence each level sends, and that the OpenAI field is translated
 * instead of forwarded to an upstream that has nowhere to put it.
 */

import { describe, expect, it } from 'vitest'
import { prepareTraeBody } from '../src/trae/bridge.ts'
import { traeReasoningEffortsFor, withTraeThinkEffort } from '../src/trae/reasoning.ts'

/** A system message in the OpenAI shape the adapter serializes. */
function systemTurn(text: string): Record<string, unknown> {
  return { role: 'system', content: text }
}

/** The text of the one system message in a message list. */
function systemText(messages: readonly unknown[]): string {
  const system = messages.find(message => (message as { readonly role?: string }).role === 'system') as
    | { readonly content?: unknown }
    | undefined
  const content = system?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => String((part as { readonly text?: unknown }).text ?? '')).join('')
}

describe('Trae think effort ladder', () => {
  it('offers a ladder only where a level was measured to do something', () => {
    // Measured families: GLM and Qwen take the short label, DeepSeek needed the
    // long "absolute maximum" one, and Kimi answered a shortening instruction too.
    expect(traeReasoningEffortsFor('glm-5.3')).toEqual(['off', 'high', 'max'])
    expect(traeReasoningEffortsFor('glm-5.2')).toEqual(['off', 'high', 'max'])
    expect(traeReasoningEffortsFor('qwen3.8-max')).toEqual(['off', 'high', 'max'])
    expect(traeReasoningEffortsFor('DeepSeek-V4-Pro-Official')).toEqual(['off', 'max'])
    expect(traeReasoningEffortsFor('kimi-k3')).toEqual(['off', 'low', 'high', 'max'])
  })

  it('matches the same family reached through a route prefix or a neighbouring build', () => {
    // `free/glm-5.3-flash` and `glm-5.3-flash-free` are the same family the probes
    // spoke to; the prefix is a billing route, not another model.
    expect(traeReasoningEffortsFor('free/glm-5.3-flash')).toEqual(['off', 'high', 'max'])
    expect(traeReasoningEffortsFor('glm-5.3-flash-free')).toEqual(['off', 'high', 'max'])
    expect(traeReasoningEffortsFor('moonshotai/kimi-k3')).toEqual(['off', 'low', 'high', 'max'])
  })

  it('publishes no menu for a family nothing was measured on', () => {
    // An empty control would be a promise the connector cannot keep: nothing it
    // sends to these changes how they think.
    expect(traeReasoningEffortsFor('Doubao-Seed-Evolving')).toBeUndefined()
    expect(traeReasoningEffortsFor('minimax-m3')).toBeUndefined()
    expect(traeReasoningEffortsFor('Seed-2.1-Pro-0915')).toBeUndefined()
  })
})

describe('Trae think effort injection', () => {
  it('prepends the level to the system prompt, fenced so it is recognizable', () => {
    const injected = withTraeThinkEffort([systemTurn('You are a coding agent.')], 'glm-5.3', 'max')
    const text = systemText(injected)
    expect(text).toContain('<<think_effort>>')
    expect(text).toContain('Reasoning Effort: Max')
    // Prepended, so the caller's own prompt is not buried under the block.
    expect(text.indexOf('Reasoning Effort: Max')).toBeLessThan(text.indexOf('You are a coding agent.'))
    expect(text).toContain('You are a coding agent.')
  })

  it('sends the family-specific wording rather than one sentence for everyone', () => {
    // DeepSeek did not move on the short label; the long form is the whole point.
    expect(systemText(withTraeThinkEffort([systemTurn('x')], 'DeepSeek-V4-Pro-Official', 'max')))
      .toContain('Absolute maximum with no shortcuts permitted')
    expect(systemText(withTraeThinkEffort([systemTurn('x')], 'glm-5.3', 'max')))
      .not.toContain('Absolute maximum')
    // Kimi's low is an instruction to think *less*, which no other family has.
    expect(systemText(withTraeThinkEffort([systemTurn('x')], 'kimi-k3', 'low')))
      .toContain('Token-efficient and concise')
  })

  it('sends nothing for off, and leaves the caller\'s prompt untouched', () => {
    const original = systemTurn('You are a coding agent.')
    const messages = [original]
    expect(withTraeThinkEffort(messages, 'glm-5.3', 'off')).toEqual(messages)
    expect(original.content).toBe('You are a coding agent.')
  })

  it('sends nothing for a level or a model without a measured wording', () => {
    // A level outside the family's ladder, and a model with no family at all: both
    // are answered by the request running normally, not by an error.
    expect(withTraeThinkEffort([systemTurn('x')], 'glm-5.3', 'low')).toEqual([systemTurn('x')])
    expect(withTraeThinkEffort([systemTurn('x')], 'Doubao-Seed-Evolving', 'max')).toEqual([systemTurn('x')])
  })

  it('opens the conversation with a system message when the caller sent none', () => {
    // After the user's first turn is a different experiment than before it.
    const injected = withTraeThinkEffort([{ role: 'user', content: 'hi' }], 'kimi-k3', 'high')
    expect(systemText(injected)).toContain('Reasoning Effort: High')
    expect(injected).toHaveLength(2)
  })

  it('replaces its own block instead of stacking one per attempt', () => {
    // A turn that rotates accounts is serialized once, but a retried or replayed
    // request is not the only path here; a stacked prompt would double the block.
    const twice = withTraeThinkEffort(withTraeThinkEffort([systemTurn('base')], 'glm-5.3', 'max'), 'glm-5.3', 'max')
    expect(systemText(twice).match(/<<think_effort>>/gu)).toHaveLength(1)
  })

  it('leaves the caller\'s message list unmutated', () => {
    const messages = [systemTurn('base'), { role: 'user', content: 'hi' }]
    withTraeThinkEffort(messages, 'glm-5.3', 'high')
    expect((messages[0] as { readonly content?: unknown }).content).toBe('base')
  })
})

describe('Trae request body carries the level as a prompt, not as a field', () => {
  it('translates reasoning_effort into the system prompt and drops the field', () => {
    const prepared = prepareTraeBody({
      model: 'glm-5.3',
      reasoning_effort: 'max',
      messages: [
        { role: 'system', content: 'You are a coding agent.' },
        { role: 'user', content: 'hi' },
      ],
    }, 'glm-5.3')
    // SOLO has no such field; leaving it would send a parameter the upstream does
    // not read, next to the block that actually carries the request.
    expect(prepared.reasoning_effort).toBeUndefined()
    expect(systemText(prepared.messages as readonly unknown[])).toContain('Reasoning Effort: Max')
    expect(prepared.config_name).toBe('glm-5.3')
  })

  it('sends an untouched conversation when the effort is off or absent', () => {
    const base = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] }
    const off = prepareTraeBody({ ...base, reasoning_effort: 'off' }, 'glm-5.3')
    expect(systemText(off.messages as readonly unknown[])).toBe('sys')
    const absent = prepareTraeBody({ ...base }, 'glm-5.3')
    expect(systemText(absent.messages as readonly unknown[])).toBe('sys')
  })
})
