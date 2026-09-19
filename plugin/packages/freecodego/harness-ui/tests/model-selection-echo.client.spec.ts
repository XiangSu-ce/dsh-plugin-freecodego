import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { installModelSelectionEcho } from '../src/client/model-selection-echo.ts'
import type { NativeSelection } from '../src/client/model-selection-echo.ts'

const accepted = { ok: true, value: undefined } as const
/**
 * alpha.2's directory resolves a refused selection with the Remote failure
 * instead of throwing; the code object only has to be a failure the wrapper can
 * read `ok` off, so the test builds the branch rather than a Host error class.
 */
const refused = { ok: false, error: { code: 'session/writer-held', message: 'refused' } } as unknown as RemoteResult<void>

describe('model selection echo', () => {
  it('updates the native directory only after the Host selection succeeds', async () => {
    const state = { current: { provider: 'freecodego', model: 'default' }, routable: true, status: 'ready' as const, error: null }
    const select = vi.fn(async (_selection: NativeSelection) => accepted as RemoteResult<void>)
    const directory = {
      select,
      store: { update: (mutator: (value: typeof state) => void) => { mutator(state) } },
    }
    installModelSelectionEcho(directory)
    await directory.select({ provider: 'logfare', model: 'glm-5.2' })
    expect(select).toHaveBeenCalledWith({ provider: 'logfare', model: 'glm-5.2' })
    expect(state).toMatchObject({ current: { provider: 'logfare', model: 'glm-5.2' }, status: 'ready', error: null })
  })

  it('does not echo a refused selection, and keeps the reason the directory published', async () => {
    type State = { current: { provider: string; model: string } | null; routable: boolean | null; status: 'ready' | 'selecting' | 'error'; error: string | null }
    // The shipped store is an immer `produce` store: every update publishes a new
    // object, which is what makes the pre-request snapshot the wrapper reads a
    // real "before" rather than a live alias of the state it is about to write.
    let state: State = { current: { provider: 'freecodego', model: 'default' }, routable: true, status: 'ready', error: null }
    const store = {
      getSnapshot: (): State => state,
      set: (next: State) => { state = { ...next } },
      update: (mutator: (value: State) => void) => { const draft = { ...state }; mutator(draft); state = draft },
    }
    const directory = {
      select: vi.fn(async (_selection: NativeSelection) => {
        // What the shipped directory does on a Host refusal: publish, do not throw.
        store.update((draft) => { draft.status = 'error'; draft.error = 'session/writer-held: refused' })
        return refused
      }),
      store,
    }
    installModelSelectionEcho(directory)
    await expect(directory.select({ provider: 'logfare', model: 'glm-5.2' })).resolves.toBe(refused)
    expect(state).toEqual({
      current: { provider: 'freecodego', model: 'default' },
      routable: true,
      status: 'error',
      error: 'session/writer-held: refused',
    })
  })

  it('does not change the visible selection when the Host rejects it', async () => {
    const state = { current: { provider: 'freecodego', model: 'default' }, routable: true, status: 'ready' as const, error: null }
    const directory = {
      select: vi.fn(async (_selection: NativeSelection) => { throw new Error('rejected') }),
      store: { update: (mutator: (value: typeof state) => void) => { mutator(state) } },
    }
    installModelSelectionEcho(directory)
    await expect(directory.select({ provider: 'logfare', model: 'glm-5.2' })).rejects.toThrow('rejected')
    expect(state.current).toEqual({ provider: 'freecodego', model: 'default' })
  })

  it('does not let an older rejected selection roll back a newer successful selection', async () => {
    const state = { current: { provider: 'freecodego', model: 'default' }, routable: true, status: 'ready' as const, error: null }
    const first = Promise.withResolvers<RemoteResult<void>>()
    const second = Promise.withResolvers<RemoteResult<void>>()
    const directory = {
      select: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
      store: {
        getSnapshot: () => state,
        set: (next: typeof state) => { Object.assign(state, next) },
        update: (mutator: (value: typeof state) => void) => { mutator(state) },
      },
    }
    installModelSelectionEcho(directory)

    const firstSelection = directory.select({ provider: 'logfare', model: 'first' })
    const secondSelection = directory.select({ provider: 'agnes', model: 'second' })
    second.resolve(accepted)
    await secondSelection
    first.reject(new Error('first selection rejected'))
    await expect(firstSelection).rejects.toThrow('first selection rejected')

    expect(state).toMatchObject({ current: { provider: 'agnes', model: 'second' }, routable: true, status: 'ready', error: null })
  })
})
