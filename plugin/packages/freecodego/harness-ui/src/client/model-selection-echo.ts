/**
 * Keep the native picker label in sync with a successful Session selection.
 *
 * alpha.2 changed how the directory reports a refused selection: alpha.1 threw,
 * alpha.2 resolves with the Remote failure and publishes `status: 'error'` plus
 * the message on its own store. A wrapper that only watches for a throw treats a
 * refusal as an applied selection and clears the reason it just wrote, so the
 * failure branch below is the result check, and the catch stays for the throw
 * the directory still raises when a Session cannot select at all.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/**
 * One model selection the native picker publishes.
 */
export interface NativeSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

interface DirectoryState {
  current: NativeSelection | null
  routable: boolean | null
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

/**
 * The slice of the official model directory the echo layer patches.
 */
export interface NativeModelDirectory {
  select(selection: NativeSelection): Promise<RemoteResult<void>>
  readonly store: {
    update(mutator: (state: DirectoryState) => void): void
  }
}

const patched = new WeakSet<object>()

/**
 * The official directory waits for the session event stream before updating its
 * local snapshot. Echo a confirmed selection immediately, then let the event
 * projection reconcile normalized data when it arrives.
 * @param directory - the native model directory to patch.
 */
export function installModelSelectionEcho(directory: NativeModelDirectory): void {
  if (patched.has(directory)) return
  patched.add(directory)
  const select = directory.select.bind(directory)
  // A picker can issue a second selection before the Host settles the first.
  // Only the most recent request owns the optimistic fields: an older rejection
  // must not restore its pre-click model over the user's later choice.
  let selectionGeneration = 0
  directory.select = async (selection) => {
    const generation = ++selectionGeneration
    const current = (): boolean => generation === selectionGeneration
    // Reflect the user's choice before the network round-trip. The Host still
    // remains authoritative and reconciles the durable projection on success,
    // but the composer no longer appears frozen while that RPC is in flight.
    const rollbackStore = directory.store as unknown as { getSnapshot?: () => DirectoryState; set?: (state: DirectoryState) => void }
    const previous = rollbackStore.getSnapshot?.()
    const optimistic = previous !== undefined && rollbackStore.set !== undefined
    if (optimistic) directory.store.update((state) => {
      state.current = selection
      state.routable = true
      state.status = 'selecting'
      state.error = null
    })
    // Restore only the fields the optimistic update touched: writing the whole
    // pre-request snapshot back would clobber concurrent updates (e.g.
    // session-event projections) that landed while the RPC ran.
    const restoreClaimedFields = (withStatus: boolean): void => {
      if (!current() || previous === undefined || rollbackStore.set === undefined) return
      const snapshot = rollbackStore.getSnapshot?.()
      rollbackStore.set(snapshot !== undefined
        ? withStatus
          ? { ...snapshot, current: previous.current, routable: previous.routable, status: previous.status, error: previous.error }
          : { ...snapshot, current: previous.current, routable: previous.routable }
        : previous)
    }
    let result: RemoteResult<void>
    try {
      result = await select(selection)
    } catch (error) {
      // A throw means the directory refused to run at all, so nothing published
      // a reason: the pre-request status and error are the ones to put back.
      restoreClaimedFields(true)
      throw error
    }
    if (!result.ok) {
      // The directory already published this failure's status and message; the
      // optimistic model claim is the only part that is ours to undo here.
      restoreClaimedFields(false)
      return result
    }
    if (!current()) return result
    directory.store.update((state) => {
      state.current = selection
      state.routable = true
      state.status = 'ready'
      state.error = null
    })
    return result
  }
}
