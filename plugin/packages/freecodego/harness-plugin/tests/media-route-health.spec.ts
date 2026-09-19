/**
 * Two things the media surface gets wrong about *what counts*.
 *
 * 1. **A route that declined by its own declaration is not a failed provider.**
 *    The ladder's breaker exists to put a provider that just failed twice behind
 *    healthy routes for five minutes. A route that refused a length it cannot
 *    render — the refusal §42 added, and Agnes' own window before it — never sent
 *    a byte, so it says nothing about that provider's health. Counted as a
 *    failure, two such requests demote the *configured default* route for five
 *    minutes: measured before the fix, a 5-second request after two 30-second
 *    ones went straight to the second route and never asked Kling at all.
 * 2. **Two audio generations in one millisecond are two files.** Generated audio
 *    is written into the workspace under a name built from `Date.now()`, and the
 *    harness runs parallel-capable tool calls in a pool
 *    (`packages/core/agent-loop/src/tool-calls.ts`), so two calls can land in the
 *    same millisecond. Measured before the fix: both results reported
 *    `audio-1789841245944.mp3` and the file held only the second payload — the
 *    first result pointed at a file that was not its audio.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateAudioWithFallback, generateVideoWithFallback } from '../src/media-generation.ts'

interface Asked { readonly selection: string; readonly body: Record<string, unknown> }

type Respond = (selection: string, body: Record<string, unknown>) => unknown

/** A ladder host over `routes`, recording every create call in `asked`. */
function ladderHost(
  routes: readonly { readonly provider: string; readonly model: string }[],
  asked: Asked[],
  respond: Respond = () => ({ data: [{ url: 'https://cdn.example/out.mp4', status: 'completed' }] }),
): unknown {
  const profiles = Object.fromEntries(routes.map(entry => [entry.provider, { baseURL: `https://${entry.provider}.example/v1` }]))
  const preferred = routes[0] === undefined ? '' : `${routes[0].provider}/${routes[0].model}`
  return {
    ctx: {
      get: (name: string) => name === 'llm'
        ? {
          listProviders: () => routes.map(entry => ({ id: entry.provider })),
          listModels: async (id: string) => routes.filter(entry => entry.provider === id).map(entry => ({ id: entry.model, name: entry.model })),
        }
        : name === 'settings' ? { get: () => ({ providers: profiles }) } : undefined,
    },
    capabilities: { configuration: () => ({ modelCategories: {} }) },
    policy: { get: () => ({ mediaDefaults: { video: preferred, audio: preferred } }) },
    readManagedCatalogCache: async () => undefined,
    logfareApiKey: async () => undefined,
    logfareModels: async () => [],
    requireAgnes: () => ({ agnesMediaModels: async () => [] }),
    credentials: { resolve: async () => ({ value: 'media-key' }) },
    mediaRoute: (selection: string) => {
      const found = routes.find(entry => `${entry.provider}/${entry.model}` === selection) ?? routes[0]
      return { selection, provider: found?.provider ?? '', model: found?.model ?? '' }
    },
    directConnection: async () => undefined,
    managedRuntime: async () => undefined,
    gatewayMediaJson: async (selection: string, _endpoint: string, body: Record<string, unknown>) => {
      asked.push({ selection, body })
      return respond(selection, body)
    },
  }
}

const signal = new AbortController().signal

afterEach(() => { vi.restoreAllMocks() })

describe('the breaker reads provider health, not a route\'s own declaration', () => {
  it('keeps asking the default route after lengths it declined', async () => {
    const asked: Asked[] = []
    const host = ladderHost([{ provider: 'kling', model: 'kling-v2-1' }, { provider: 'volcengine', model: 'doubao-seedance' }], asked)
    // Two requests for a length Kling cannot render: it refuses locally and the
    // second route serves them. Both must leave Kling's circuit alone.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await generateVideoWithFallback(host as never, { prompt: 'a long boat', seconds: 30 }, signal)
    }
    asked.length = 0
    // A length Kling renders exactly: the configured default has to keep its slot.
    await generateVideoWithFallback(host as never, { prompt: 'a short boat', seconds: 5 }, signal)
    expect(asked.map(entry => entry.selection)).toEqual(['kling/kling-v2-1'])
    expect(asked[0]?.body).toMatchObject({ duration: '5' })
  })

  it('still puts a route that failed to deliver behind a healthy one', async () => {
    // The control for the rule above: a provider failure is exactly what the
    // breaker is for, so it must keep demoting the route (and keep recording it
    // rather than ending the call). Both names have to infer as video routes or
    // they are not candidates at all — the second one is discovered through
    // `grok.*video`, which is also how a real account's routes arrive.
    const asked: Asked[] = []
    const host = ladderHost(
      [{ provider: 'volcengine', model: 'doubao-seedance-pro' }, { provider: 'xai', model: 'grok-imagine-video' }],
      asked,
      selection => selection.startsWith('volcengine/')
        ? Promise.reject(new Error('FreeCodeGo /videos/generations failed with HTTP 503'))
        : { data: [{ url: 'https://cdn.example/out.mp4', status: 'completed' }] },
    )
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(generateVideoWithFallback(host as never, { prompt: 'a boat', seconds: 6 }, signal)).resolves.toMatchObject({ url: 'https://cdn.example/out.mp4' })
    }
    asked.length = 0
    await generateVideoWithFallback(host as never, { prompt: 'a boat', seconds: 6 }, signal)
    expect(asked.map(entry => entry.selection)).toEqual(['xai/grok-imagine-video'])
  })
})

describe('two concurrent audio generations are two files', () => {
  it('writes each result its own bytes at its own path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fcg-audio-parallel-'))
    const asked: Asked[] = []
    const host = ladderHost([{ provider: 'openai', model: 'gpt-4o-mini-tts' }], asked)
    // The collision this test is about only happens when both calls land in the
    // same millisecond, so the clock is frozen to that: without it the red state
    // is red only sometimes, which is not evidence.
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    // Each call's payload is marked by the input it carried, so the bytes found at
    // a result's path can be checked against that result's own request.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const parsed = JSON.parse(String(init?.body)) as { readonly input?: string }
      const marker = parsed.input === 'first line' ? 1 : 2
      return new Response(new Uint8Array([marker, marker, marker, marker]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    })
    try {
      const [first, second] = await Promise.all([
        generateAudioWithFallback(host as never, { input: 'first line', format: 'mp3' }, workspace, signal),
        generateAudioWithFallback(host as never, { input: 'second line', format: 'mp3' }, workspace, signal),
      ]) as readonly { readonly path: string }[]
      // Both callers claim a distinct path, so an absent one is the absence of the
      // property under test rather than a value to read conditionally.
      if (first === undefined || second === undefined) throw new Error('the fallback did not produce two files')
      expect(first.path).not.toBe(second.path)
      const directory = join(workspace, '.freecodego', 'generated-media')
      expect((await readdir(directory)).length).toBe(2)
      expect([...(await readFile(first.path))]).toEqual([1, 1, 1, 1])
      expect([...(await readFile(second.path))]).toEqual([2, 2, 2, 2])
    } finally {
      vi.restoreAllMocks()
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
