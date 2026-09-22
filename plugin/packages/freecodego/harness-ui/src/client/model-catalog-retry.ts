/** Recover the native picker from short-lived Host reconnects without clearing its last directory. */

interface RetryState {
  readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  readonly error: string | null
}

/**
 * The slice of the native model directory the retry layer observes.
 */
export interface RetriableModelDirectory {
  load(): Promise<unknown>
  readonly store: {
    getSnapshot(): RetryState
    subscribe(listener: () => void): () => void
  }
}

const transientTransportFailure = /(?:failed to fetch|carrier offline|remote event generation ended|remote invocation .* aborted)/iu
const retryDelays = [60_000, 10 * 60_000, 30 * 60_000] as const
// A directory can be observed repeatedly while the menu rerenders. Keep the
// existing disposer so repeated installation neither adds subscriptions nor
// silently throws away the only handle that can remove one.
const installed = new WeakMap<object, () => void>()

/**
 * Retry transient catalog transport failures in the background, retaining the last good rows.
 * @param directory - the model directory to watch for transient failures.
 * @returns a disposer that clears any scheduled retry.
 */
export function installModelCatalogRetry(directory: RetriableModelDirectory): () => void {
  const existing = installed.get(directory)
  if (existing !== undefined) return existing
  const directoryRef = new WeakRef(directory)
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const schedule = (): void => {
    const current = directoryRef.deref()
    if (current === undefined || disposed || timer !== undefined || attempts >= retryDelays.length) return
    const state = current.store.getSnapshot()
    if (state.status !== 'error' || state.error === null || !transientTransportFailure.test(state.error)) return
    const delay = retryDelays[attempts++]!
    timer = setTimeout(() => {
      timer = undefined
      const retry = (): void => {
        const latest = directoryRef.deref()
        if (latest !== undefined && !disposed) void latest.load().catch(() => undefined)
      }
      if (typeof requestIdleCallback === 'function') requestIdleCallback(retry, { timeout: 5_000 })
      else retry()
    }, delay)
  }
  const observe = (): void => {
    const current = directoryRef.deref()
    if (current === undefined || disposed) return
    const state = current.store.getSnapshot()
    if (state.status === 'ready') {
      attempts = 0
      clear()
      return
    }
    schedule()
  }
  const unsubscribe = directory.store.subscribe(observe)
  observe()
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clear()
    unsubscribe()
    if (installed.get(directory) === dispose) installed.delete(directory)
  }
  installed.set(directory, dispose)
  return dispose
}
