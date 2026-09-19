import { describe, expect, it, vi } from 'vitest'
import { installModelCatalogRetry } from '../src/client/model-catalog-retry.ts'

function directory(error: string | null) {
  let state = { status: error === null ? 'ready' as const : 'error' as const, error }
  const listeners = new Set<() => void>()
  const load = vi.fn(async () => undefined)
  return {
    value: { load, store: { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } } },
    set(next: typeof state): void { state = next; for (const listener of listeners) listener() },
    load,
  }
}

describe('model catalog retry', () => {
  it('retries a transient model catalog fetch failure without needing a menu click', async () => {
    vi.useFakeTimers()
    const subject = directory('gateway/internal: client api: session/modelCatalog failed: Failed to fetch')
    const dispose = installModelCatalogRetry(subject.value)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(subject.load).toHaveBeenCalledOnce()
    dispose()
    vi.useRealTimers()
  })

  it('does not retry a semantic model catalog error', async () => {
    vi.useFakeTimers()
    const subject = directory('session/model-unavailable: provider is disabled')
    const dispose = installModelCatalogRetry(subject.value)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(subject.load).not.toHaveBeenCalled()
    dispose()
    vi.useRealTimers()
  })

  it('returns the existing disposer for repeated installation and allows reinstall', () => {
    const subject = directory('session/model-unavailable: provider is disabled')
    const first = installModelCatalogRetry(subject.value)
    const second = installModelCatalogRetry(subject.value)
    expect(second).toBe(first)
    first()
    expect(installModelCatalogRetry(subject.value)).not.toBe(first)
  })
})
