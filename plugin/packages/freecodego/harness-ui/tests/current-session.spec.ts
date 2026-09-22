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
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { mainViewSessionId } from '../src/client/current-session.ts'

/** Brand a fixture id the way the client specs do. */
const sessionId = (value: string): SessionId => value as SessionId

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

/** A summary carrying the one field this rule reads, plus the required shape. */
const row = (id: string, retainedBy: Record<string, number>): [SessionId, SessionSummary] => [
  sessionId(id),
  { id: sessionId(id), displayTitle: id, running: false, retainedBy, blank: false, updatedAt: 1 },
]

describe('mainViewSessionId', () => {
  it('finds the Session the main view retains, not merely the first row', () => {
    const byId = Object.fromEntries([
      row('other', { workspaceOperation: 2 }),
      row('shown', { mainView: 1 }),
    ])
    const ids = [sessionId('other'), sessionId('shown')]
    expect(mainViewSessionId(contextWith({ ids, byId }))).toBe('shown')
  })

  it('ignores retention by other sources', () => {
    const byId = Object.fromEntries([row('background', { workspaceOperation: 3 })])
    expect(mainViewSessionId(contextWith({ ids: [sessionId('background')], byId }))).toBeUndefined()
  })

  it('reports absence while no Session is displayed', () => {
    expect(mainViewSessionId(contextWith({}))).toBeUndefined()
  })

  it('does not depend on the retention count being exactly one', () => {
    const byId = Object.fromEntries([row('shown', { mainView: 4 })])
    expect(mainViewSessionId(contextWith({ ids: [sessionId('shown')], byId }))).toBe('shown')
  })
})
