/**
 * The displayed Session must stay readable through alpha.2's interface change.
 *
 * alpha.2 deleted `SessionListState.current`, and for a while a hand-written
 * cast in the plugin's client kept that read compiling while it returned
 * `undefined` for every surface — model-menu badges, engine seats, and the
 * Session-scoped settings panels all went blank with a green test suite. The
 * replacement reads the retention fact the renderer's own `publishMain` uses,
 * so these cases pin the rule: `mainView`, not "some session is retained".
 */

import { describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { mainViewSessionId } from '../src/client/current-session.ts'

/** Minimal context: the helper reads exactly one snapshot off `sessions`. */
const contextWith = (list: Partial<SessionListState>): ClientContext => ({
  sessions: {
    list: {
      getSnapshot: () => ({
        ids: [], byId: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {},
        ...list,
      }),
    },
  },
} as unknown as ClientContext)

const row = (id: string, retainedBy: Record<string, number>): [string, object] =>
  [id, { id, retainedBy }]

describe('mainViewSessionId', () => {
  it('finds the Session the main view retains, not merely the first row', () => {
    const byId = Object.fromEntries([
      row('other', { workspaceOperation: 2 }),
      row('shown', { mainView: 1 }),
    ])
    expect(mainViewSessionId(contextWith({ ids: ['other', 'shown'], byId }))).toBe('shown')
  })

  it('ignores retention by other sources', () => {
    const byId = Object.fromEntries([row('background', { workspaceOperation: 3 })])
    expect(mainViewSessionId(contextWith({ ids: ['background'], byId }))).toBeUndefined()
  })

  it('reports absence while no Session is displayed', () => {
    expect(mainViewSessionId(contextWith({}))).toBeUndefined()
  })

  it('does not depend on the retention count being exactly one', () => {
    const byId = Object.fromEntries([row('shown', { mainView: 4 })])
    expect(mainViewSessionId(contextWith({ ids: ['shown'], byId }))).toBe('shown')
  })
})
