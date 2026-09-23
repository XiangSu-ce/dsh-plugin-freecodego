/**
 * The web-search binding: what a picked model turns into.
 *
 * The provider being bound appends `/messages` to whatever base URL it is given,
 * so the only two things that can go wrong here are the join (a base that is one
 * `/v1` short) and the durability claim (a process-local bridge endpoint offered
 * as if it were permanent). Both are asserted directly, because both present as a
 * search that fails later — in a page the user has already left.
 */
import { describe, expect, it, vi } from 'vitest'
import { webSearchBind, type EngineRemotesHost } from '../src/engine-remotes.ts'
import { WEB_SEARCH_API_KEY_REF } from '../src/web-search-binding.ts'

/** A host whose one routed answer is fixed, as the catalogs would resolve it. */
function hostStub(resolved: { readonly baseURL: string; readonly apiKey: string; readonly model?: string }): EngineRemotesHost {
  return { catalogs: { claudeGatewayForRoute: vi.fn(async () => resolved) } } as unknown as EngineRemotesHost
}

describe('webSearchBind', () => {
  it('hands over the provider’s own Anthropic base as durable', async () => {
    const binding = await webSearchBind(hostStub({
      baseURL: 'https://vyceai.com/v1', apiKey: 'sk-vyce', model: 'deepseek-v4.1',
    }), { provider: 'Vyce', model: 'vyce/deepseek-v4.1' })

    expect(binding).toEqual({
      provider: 'vyce',
      // The provider's own wire id wins: the picker's id carries the provider
      // prefix and the search request must not.
      model: 'deepseek-v4.1',
      baseURL: 'https://vyceai.com/v1',
      apiKeyEnv: WEB_SEARCH_API_KEY_REF,
      apiKey: 'sk-vyce',
      durable: true,
    })
  })

  it('appends the /v1 the local bridge base is missing, and marks it process-local', async () => {
    const binding = await webSearchBind(hostStub({
      baseURL: 'http://127.0.0.1:41234/anthropic/6f1c',
      apiKey: 'sk-ant-api03-bridge',
    }), { provider: 'freecodego', model: 'deepseek-v4.1' })

    expect(binding.baseURL).toBe('http://127.0.0.1:41234/anthropic/6f1c/v1')
    expect(binding.model).toBe('deepseek-v4.1')
    expect(binding.durable).toBe(false)
  })

  it('does not double the version on a base that already carries one', async () => {
    const binding = await webSearchBind(hostStub({
      baseURL: 'https://vyceai.com/v1/', apiKey: 'sk-vyce',
    }), { provider: 'vyce', model: 'deepseek-v4.1' })

    expect(binding.baseURL).toBe('https://vyceai.com/v1')
  })

  it('refuses an empty pick rather than writing a namespace nothing can serve', async () => {
    await expect(webSearchBind(hostStub({ baseURL: 'https://vyceai.com/v1', apiKey: 'k' }), { provider: '', model: 'x' }))
      .rejects.toThrow('a provider and a model are required')
    await expect(webSearchBind(hostStub({ baseURL: 'https://vyceai.com/v1', apiKey: 'k' }), { provider: 'vyce', model: '  ' }))
      .rejects.toThrow('a provider and a model are required')
  })

  it('refuses a resolution that is not an HTTP endpoint', async () => {
    await expect(webSearchBind(hostStub({ baseURL: 'file:///tmp/socket', apiKey: 'k' }), { provider: 'vyce', model: 'x' }))
      .rejects.toThrow('did not resolve an HTTP endpoint')
  })
})
