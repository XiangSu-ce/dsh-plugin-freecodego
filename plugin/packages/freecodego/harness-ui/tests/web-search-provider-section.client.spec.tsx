// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  WEB_SEARCH_NAMESPACE, WebSearchProviderSection, type WebSearchNamespaceValue,
} from '../src/client/web-search-provider-section.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The copy the section renders, keyed so a missing key is visible in a failure. */
const t = (key: string): string => key

/** A shared namespace form over one value, with the writes recorded. */
function formStub(value: WebSearchNamespaceValue): {
  readonly form: ConfigForm<WebSearchNamespaceValue>
  readonly mutations: readonly (readonly Record<string, unknown>[])[]
} {
  const mutations: (readonly Record<string, unknown>[])[] = []
  const snapshot: ConfigFormSnapshot<WebSearchNamespaceValue> = {
    status: 'ready', value, base: undefined, user: undefined, revision: 3, writable: true, mode: 'host',
  }
  const form: ConfigForm<WebSearchNamespaceValue> = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    mutate: async (ops) => { mutations.push(ops); return true },
    set: async () => true,
    unset: async () => true,
  }
  return { form, mutations }
}

const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true, value })

/** The section's face, with only the page under test and the given stubs. */
function face(overrides: Partial<Parameters<typeof WebSearchProviderSection>[0]> = {}): Parameters<typeof WebSearchProviderSection>[0] {
  return {
    subject: { kind: 'item', id: 'web-search' },
    models: async () => [
      { provider: 'vyce', id: 'vyce/deepseek-v4.1', label: 'DeepSeek V4.1' },
      { provider: 'opencode', id: 'opencode/auto', label: 'Auto Free' },
    ],
    bind: async () => ok({
      provider: 'vyce', model: 'deepseek-v4.1', baseURL: 'https://vyceai.com/v1',
      apiKeyEnv: 'FREECODEGO_WEB_SEARCH_API_KEY', apiKey: 'sk-test', durable: true,
    }),
    status: async () => ok({ state: 'other', alive: true }),
    form: () => undefined,
    credentials: () => ({ set: async () => undefined }),
    remember: async () => undefined,
    t,
    ...overrides,
  }
}

describe('WebSearchProviderSection', () => {
  it('renders nothing on any other plugin page', async () => {
    const { container } = render(<WebSearchProviderSection {...face({ subject: { kind: 'item', id: 'other' } })} />)

    await waitFor(() => { expect(container.textContent).toBe('') })
  })

  it('lists every routed model and writes the endpoint, the model, and the key it is given', async () => {
    const { form, mutations } = formStub({ model: 'deepseek-v4-flash' })
    const writes: { ref: string; value: string }[] = []
    render(<WebSearchProviderSection {...face({
      form: () => form,
      credentials: () => ({ set: async (ref, value) => { writes.push({ ref, value }) } }),
    })} />)

    fireEvent.click(await screen.findByRole('button', { name: /DeepSeek V4\.1/ }))
    await waitFor(() => { expect(mutations).toHaveLength(1) })
    // The credential goes in before the namespace points at it: a namespace that
    // names a reference holding nothing turns every search into an auth failure.
    expect(writes).toEqual([{ ref: 'FREECODEGO_WEB_SEARCH_API_KEY', value: 'sk-test' }])
    expect(mutations[0]).toEqual([
      { op: 'set', path: ['model'], value: 'deepseek-v4.1' },
      { op: 'set', path: ['baseURL'], value: 'https://vyceai.com/v1' },
      { op: 'set', path: ['apiKeyEnv'], value: 'FREECODEGO_WEB_SEARCH_API_KEY' },
    ])
  })

  it('keeps the namespace untouched when the Host cannot resolve the route', async () => {
    const { form, mutations } = formStub({ model: 'deepseek-v4-flash' })
    const writes: unknown[] = []
    render(<WebSearchProviderSection {...face({
      form: () => form,
      credentials: () => ({ set: async (...args) => { writes.push(args) } }),
      // A real refusal: the failure branch of a Remote call, which resolves
      // instead of rejecting, is the shape this page has to handle.
      bind: async () => ({ ok: false, error: new RemoteError('gateway/bad-request', 'VYCE_API_KEY_REQUIRED', {}) }),
    })} />)

    fireEvent.click(await screen.findByRole('button', { name: /DeepSeek V4\.1/ }))
    await waitFor(() => { expect(screen.getByText(/VYCE_API_KEY_REQUIRED/)).toBeTruthy() })
    expect(mutations).toHaveLength(0)
    expect(writes).toHaveLength(0)
  })

  it('clears the three fields it wrote so the page falls back to the DeepSeek default', async () => {
    const { form, mutations } = formStub({ model: 'deepseek-v4.1', baseURL: 'https://vyceai.com/v1', apiKeyEnv: 'FREECODEGO_WEB_SEARCH_API_KEY' })
    render(<WebSearchProviderSection {...face({ form: () => form })} />)

    fireEvent.click(await screen.findByRole('button', { name: 'searchProviderReset' }))
    await waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]).toEqual([
      { op: 'unset', path: ['model'] },
      { op: 'unset', path: ['baseURL'] },
      { op: 'unset', path: ['apiKeyEnv'] },
    ])
  })

  it('marks the model the namespace already names, and says when none is set', async () => {
    const { form } = formStub({ model: 'vyce/deepseek-v4.1' })
    const first = render(<WebSearchProviderSection {...face({ form: () => form })} />)
    await waitFor(() => { expect(screen.getByTitle('searchProviderActive')).toBeTruthy() })
    first.unmount()

    render(<WebSearchProviderSection {...face({ form: () => formStub({}).form })} />)
    await waitFor(() => { expect(screen.getByText('searchProviderNone')).toBeTruthy() })
  })

  it('records the pair before it points the namespace at the binding', async () => {
    // The pair is what a restart rebuilds from, and the namespace is what makes the
    // search provider resolve the key — writing the namespace first would leave a
    // window where a search authenticates against a reference holding nothing.
    const order: string[] = []
    const { form } = formStub({ model: 'deepseek-v4-flash' })
    render(<WebSearchProviderSection {...face({
      form: () => form,
      credentials: () => ({ set: async () => { order.push('key') } }),
      remember: async () => { order.push('pair') },
    })} />)

    fireEvent.click(await screen.findByRole('button', { name: /DeepSeek V4\.1/ }))
    await waitFor(() => { expect(order).toEqual(['key', 'pair']) })
  })

  it('rebuilds a saved bridge binding that this process no longer serves', async () => {
    const { form, mutations } = formStub({ model: 'deepseek-v4.1', baseURL: 'http://127.0.0.1:51000/anthropic/old/v1', apiKeyEnv: 'FREECODEGO_WEB_SEARCH_API_KEY' })
    const writes: { ref: string; value: string }[] = []
    const remembered: { provider: string; model: string }[] = []
    render(<WebSearchProviderSection {...face({
      form: () => form,
      credentials: () => ({ set: async (ref, value) => { writes.push({ ref, value }) } }),
      remember: async (pair) => { remembered.push({ ...pair }) },
      status: async () => ok({
        state: 'bridge', alive: false, remembered: { provider: 'opencode', model: 'opencode/auto' },
      }),
      bind: async () => ok({
        provider: 'opencode', model: 'auto', baseURL: 'http://127.0.0.1:52000/anthropic/new/v1',
        apiKeyEnv: 'FREECODEGO_WEB_SEARCH_API_KEY', apiKey: 'sk-rebuilt', durable: false,
      }),
    })} />)

    await waitFor(() => { expect(screen.getByText('searchProviderRebuilt')).toBeTruthy() })
    expect(writes).toEqual([{ ref: 'FREECODEGO_WEB_SEARCH_API_KEY', value: 'sk-rebuilt' }])
    expect(remembered).toEqual([{ provider: 'opencode', model: 'opencode/auto' }])
    expect(mutations[0]).toEqual([
      { op: 'set', path: ['model'], value: 'auto' },
      { op: 'set', path: ['baseURL'], value: 'http://127.0.0.1:52000/anthropic/new/v1' },
      { op: 'set', path: ['apiKeyEnv'], value: 'FREECODEGO_WEB_SEARCH_API_KEY' },
    ])
  })

  it('asks for a pick when the dead binding left no pair to rebuild from', async () => {
    const { form, mutations } = formStub({ model: 'deepseek-v4.1', baseURL: 'http://127.0.0.1:51000/anthropic/old/v1', apiKeyEnv: 'FREECODEGO_WEB_SEARCH_API_KEY' })
    render(<WebSearchProviderSection {...face({
      form: () => form,
      status: async () => ok({ state: 'bridge', alive: false }),
    })} />)

    await waitFor(() => { expect(screen.getByText('searchProviderNeedsPick')).toBeTruthy() })
    expect(mutations).toHaveLength(0)
  })

  it('leaves a binding this process still serves alone', async () => {
    // The same section that the test above rebuilds: liveness, not the URL, is what
    // decides. A fresh resolution always mints a new route id, so a page comparing
    // endpoints would rewrite a healthy binding on every load.
    const { form, mutations } = formStub({ model: 'deepseek-v4.1', baseURL: 'http://127.0.0.1:51000/anthropic/live/v1', apiKeyEnv: 'FREECODEGO_WEB_SEARCH_API_KEY' })
    render(<WebSearchProviderSection {...face({
      form: () => form,
      status: async () => ok({ state: 'bridge', alive: true, remembered: { provider: 'opencode', model: 'opencode/auto' } }),
    })} />)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mutations).toHaveLength(0)
    expect(screen.queryByText('searchProviderRebuilt')).toBeNull()
    expect(screen.queryByText('searchProviderNeedsPick')).toBeNull()
  })

  it('says so when this deployment exposes no settings writer', async () => {
    render(<WebSearchProviderSection {...face({ form: () => undefined, models: async () => [] })} />)

    await waitFor(() => { expect(screen.getByText('searchProviderUnavailable')).toBeTruthy() })
  })

  it('names the namespace it edits, spelled the way the provider registers it', () => {
    // A wrong namespace would write a section the provider never reads, and the
    // page would look configured while searches kept using DeepSeek.
    expect(WEB_SEARCH_NAMESPACE).toBe('web-search-deepseek')
  })
})
