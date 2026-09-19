/**
 * `claudeBridgeHandle` is the Host half of the native-Claude bridge contract.
 *
 * Its failure mode is silent: the worker advertises a tool, the model calls it,
 * and the only place the mistake surfaces is here — as a thrown "not available"
 * or "unsupported bridge". These cases pin the pairs that are supposed to
 * resolve end to end, so a name or `op` typo in either half fails a test rather
 * than the first real model call.
 *
 * The concrete regression this guards: the worker used to advertise eleven host
 * tools, of which none resolved. Two pairs had a mismatched `op`, and seven
 * named tools that were never registered.
 *
 * A later round removed those two remaining pairs entirely. They resolved, but
 * each carried a hand-written copy of the Harness tool's arguments that had
 * drifted — `query` where `web_search` declares `queries`, `filePath` with an
 * operation enum `lsp` does not have — so the call failed schema validation
 * after the pair succeeded. Every Harness tool now bridges generically through
 * `tool/execute`, which cannot hold a second, wrong signature.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { claudeBridgeHandle } from '../src/engine-remotes.ts'
// The double below is a full `EngineRemotesHost` only by assertion; naming the
// parameter's own type keeps that assertion honest (a `hostWith` typed as some
// other host interface would not even be assignable to the call).
import type { EngineRemotesHost } from '../src/engine-remotes.ts'

/** Minimal host whose only interesting surface is the tool executor. */
function hostWith(tools: readonly string[], recorded: Array<{ name: string; args: unknown }>) {
  return {
    ctx: { get: () => undefined },
    capabilities: {
      executeHarnessTool: async (_agent: unknown, name: string, args: unknown) => {
        if (!tools.includes(name)) throw new Error(`Harness tool "${name}" is not available to this native Agent`)
        recorded.push({ name, args })
        return { content: [{ type: 'text', text: 'ok' }], isError: false }
      },
    },
  } as unknown as EngineRemotesHost
}

const request = (bridge: string, op: string, input: unknown = {}) => ({
  bridge,
  op,
  input,
  sessionId: 'session-1',
  signal: new AbortController().signal,
})

describe('claudeBridgeHandle', () => {
  it('retires the capability-specific pairs instead of resurrecting them', async () => {
    // The Claude sidecar used to reach `web_search` and `lsp` through their own
    // pairs, with a hand-written copy of each tool's arguments. Both copies had
    // drifted from the tools they named, so every advertised call failed
    // validation even though the pair resolved. Both Claude transports now go
    // through `tool/execute`, and these pairs must stay gone: re-adding one
    // would re-create a second signature that nothing keeps in step.
    for (const [bridge, op] of [['webSearch', 'search'], ['lsp', 'query']] as const) {
      await expect(claudeBridgeHandle(hostWith(['web_search', 'lsp'], []), request(bridge, op, {})))
        .rejects.toThrow(new RegExp(`unsupported FreeCodeGo capability bridge "${bridge}/${op}"`, 'u'))
    }
    // The typo this resolver originally shipped with is still a typo.
    await expect(claudeBridgeHandle(hostWith(['web_search'], []), request('webSearch', 'run', { query: 'x' })))
      .rejects.toThrow(/unsupported FreeCodeGo capability bridge "webSearch\/run"/u)
  })

  it('routes a Harness tool the model reaches by its own name', async () => {
    // The generic bridge is what replaced those pairs, so it has to actually
    // reach the tool the advertisement named.
    const recorded: Array<{ name: string; args: unknown }> = []
    const result = await claudeBridgeHandle(
      hostWith(['web_search', 'lsp'], recorded),
      request('tool', 'execute', { name: 'web_search', arguments: { queries: ['vitest fake timers'] } }),
    )
    expect(result).toMatchObject({ isError: false })
    expect(recorded).toEqual([{ name: 'web_search', args: { queries: ['vitest fake timers'] } }])
  })

  it('routes the skill bridge to the capability registry', async () => {
    // The regression this guards: this branch was deleted while the live
    // in-process Claude path kept declaring `freecodego_skill_discover` and
    // `freecodego_skill_load`, so every skill call failed with "unsupported
    // bridge" even though the system prompt still advertised them.
    const calls: string[] = []
    const host = {
      ctx: { get: () => undefined },
      capabilities: {
        listSkills: async () => { calls.push('list'); return [{ name: 's', description: 'd', source: 'x' }] },
        loadSkill: async (name: string) => { calls.push(`load:${name}`); return { name, content: 'body' } },
      },
    } as unknown as EngineRemotesHost
    await expect(claudeBridgeHandle(host, request('skill', 'list'))).resolves.toBeDefined()
    await expect(claudeBridgeHandle(host, request('skill', 'load', { name: 'my-skill' }))).resolves.toBeDefined()
    expect(calls).toEqual(['list', 'load:my-skill'])
  })

  it('answers the bridge pairs both native runtimes actually call', () => {
    // Both runtimes reach this one resolver, and neither can be exercised here:
    // the Codex worker runs as a child process, and the Claude worker is a
    // sidecar. So each side is checked by reading the calls it makes and
    // confirming the resolver has a branch — which is exactly what was missing
    // when the skill bridge was removed while both prompts still named it.
    const host = readFileSync(new URL('../src/engine-remotes.ts', import.meta.url), 'utf8')
    const sources = [
      readFileSync(new URL('../../runtime-codex/src/worker.ts', import.meta.url), 'utf8'),
      // The Claude MCP surface is one shared builder, and it is the only Claude
      // caller: the sidecar transport that used to duplicate it was deleted.
      readFileSync(new URL('../../runtime-claude/src/harness-mcp.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../runtime-claude/src/index.ts', import.meta.url), 'utf8'),
    ]
    const pairs = sources.flatMap(source =>
      [...source.matchAll(/bridge(?:Call)?\('([a-zA-Z]+)', '([a-zA-Z]+)'/gu)].map(match => [match[1], match[2]] as const))
    expect(pairs.length).toBeGreaterThan(0)
    const unanswered = pairs.filter(([bridge, op]) => !host.includes(`request.bridge === '${bridge}' && request.op === '${op}'`))
    expect(unanswered.map(([bridge, op]) => `${bridge}/${op}`)).toEqual([])
  })

  it('requires a skill name for a load request', async () => {
    const host = { ctx: { get: () => undefined }, capabilities: { loadSkill: async () => undefined } } as unknown as EngineRemotesHost
    await expect(claudeBridgeHandle(host, request('skill', 'load', {}))).rejects.toThrow(/requires a skill name/u)
  })

  it('rejects the removed agent-config bridge', async () => {
    await expect(claudeBridgeHandle(hostWith(['web_search'], []), request('agentConfig', 'read', {})))
      .rejects.toThrow(/unsupported FreeCodeGo capability bridge/u)
  })

  it('surfaces a tool that the Harness does not expose as an unavailable-tool error', async () => {
    await expect(claudeBridgeHandle(hostWith([], []), request('tool', 'execute', { name: 'lsp', arguments: {} })))
      .rejects.toThrow(/not available to this native Agent/u)
  })

  it('inlines image bytes only when the calling transport asks for them', async () => {
    // The worker protocols cap a frame at 1 MB, which cannot hold one image, so
    // byte inlining is opt-in and reaches the executor as a flag rather than as
    // the default. A media result is otherwise returned as an attachment
    // reference the caller can fall back to.
    const seen: (boolean | undefined)[] = []
    const host = {
      ctx: { get: () => undefined },
      capabilities: {
        executeHarnessTool: async (
          _agent: unknown,
          _name: string,
          _args: unknown,
          _signal: AbortSignal,
          options: { readonly inlineImages?: boolean } = {},
        ) => {
          seen.push(options.inlineImages)
          return { content: [{ type: 'text', text: 'ok' }], isError: false }
        },
      },
    } as unknown as EngineRemotesHost
    await claudeBridgeHandle(host, { ...request('tool', 'execute', { name: 'freecodego_generate_image', arguments: {} }), inlineImages: true })
    await claudeBridgeHandle(host, request('tool', 'execute', { name: 'freecodego_generate_image', arguments: {} }))
    expect(seen).toEqual([true, false])
  })

  it('keeps byte inlining to the one transport that can carry it', () => {
    // Both worker transports stream over a size-capped frame; only the
    // in-process Host session passes live objects. If a worker ever starts
    // claiming inline media, its results would arrive truncated instead of
    // failing, so the claim is checked at the source.
    const codexWorker = readFileSync(new URL('../../runtime-codex/src/worker.ts', import.meta.url), 'utf8')
    expect(codexWorker).not.toContain('inlineImages')
    const claudeInProcess = readFileSync(new URL('../../runtime-claude/src/index.ts', import.meta.url), 'utf8')
    expect(claudeInProcess).toContain('inlineImages: true')
  })

  it('still routes the generic tool and mcp bridges', async () => {
    const host = {
      ctx: { get: () => ({ get: () => undefined }) },
      capabilities: {
        executeHarnessTool: async () => ({ content: [], isError: false }),
      },
    } as unknown as EngineRemotesHost
    // `tool/execute` validates its own name argument before dispatching.
    await expect(claudeBridgeHandle(host, request('tool', 'execute', { name: 'read', arguments: {} })))
      .resolves.toBeDefined()
    await expect(claudeBridgeHandle(host, request('tool', 'execute', {})))
      .rejects.toThrow(/requires a tool name/u)
  })
})
