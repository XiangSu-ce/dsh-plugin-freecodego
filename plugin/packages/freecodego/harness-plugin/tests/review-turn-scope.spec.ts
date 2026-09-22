import { describe, expect, it } from 'vitest'
import { narrowTurnScope, turnChangePaths, type TurnScopeEvent } from '../src/review/turn-scope.ts'
import { FreeCodeGoReviewGate, type ReviewGateSettings } from '../src/review/gate.ts'
import { DEFAULT_REVIEW_GATE_SETTINGS } from '../src/review/gate.ts'
import { assembleReviewReport } from '../src/review/report.ts'
import { summarizeCoverage } from '../src/review/coverage.ts'
import { summarizeBudget, createBudgetState, DEFAULT_REVIEW_BUDGET } from '../src/review/budget.ts'

const event = (type: string, seq: number, data?: unknown): TurnScopeEvent => ({ type, seq, data })

describe('per-turn change record', () => {
  it('reads the record for the stopping turn', () => {
    const paths = turnChangePaths({
      sessionId: 's1',
      turn: 7,
      events: [event('turn/start', 1, { turn: 7 }), event('workspace/changes', 9, { turn: 7 })],
      summarize: (sessionId, seq) => (sessionId === 's1' && seq === 9 ? { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] } : undefined),
    })
    expect(paths).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('refuses another turn\'s record rather than answering with it', () => {
    // The record is appended *while* the turn is stopping, so a reader that runs
    // first sees the previous turn's event. Narrowing to it would name the wrong
    // files and skip the ones this turn actually changed.
    const paths = turnChangePaths({
      sessionId: 's1',
      turn: 8,
      events: [event('workspace/changes', 9, { turn: 7 })],
      summarize: () => ({ files: [{ path: 'src/a.ts' }] }),
    })
    expect(paths).toBeUndefined()
  })

  it('answers nothing when the turn is unknown, the service cannot find the event, or the list is empty', () => {
    const summarize = (): { files: readonly { path?: unknown }[] } => ({ files: [] })
    expect(turnChangePaths({ sessionId: 's1', turn: undefined, events: [event('workspace/changes', 3, { turn: 1 })], summarize })).toBeUndefined()
    expect(turnChangePaths({ sessionId: 's1', turn: 1, events: [], summarize })).toBeUndefined()
    expect(turnChangePaths({ sessionId: 's1', turn: 1, events: [event('workspace/changes', 3, { turn: 1 })], summarize: () => undefined })).toBeUndefined()
    // `files` is capped while `total` is complete, so an empty list is ambiguous: it
    // must not be read as "this turn changed nothing" and narrow the scope to zero.
    expect(turnChangePaths({ sessionId: 's1', turn: 1, events: [event('workspace/changes', 3, { turn: 1 })], summarize })).toBeUndefined()
  })

  it('ignores entries that are not paths, and reads the newest matching record', () => {
    const paths = turnChangePaths({
      sessionId: 's1',
      turn: 2,
      events: [event('workspace/changes', 4, { turn: 2 }), event('workspace/changes', 8, { turn: 2 })],
      summarize: (_id, seq) => (seq === 8 ? { files: [{ path: 'src/new.ts' }, { path: 42 }, { path: '' }] } : { files: [{ path: 'src/old.ts' }] }),
    })
    expect(paths).toEqual(['src/new.ts'])
  })

  it('narrows only to paths that are provably inside the change set', () => {
    const changed = ['plugin/src/a.ts', 'plugin/src/b.ts']
    expect(narrowTurnScope(['plugin/src/a.ts'], changed)).toEqual(['plugin/src/a.ts'])
    expect(narrowTurnScope(undefined, changed)).toEqual(changed)
    expect(narrowTurnScope([], changed)).toEqual(changed)
    // Same files, different spelling: the turn record is relative to the session's
    // working directory and the review's paths to the worktree root. Trusting this
    // would review *nothing*, which is worse than reviewing too much.
    expect(narrowTurnScope(['src/a.ts'], changed)).toEqual(changed)
    expect(narrowTurnScope(['plugin/src/a.ts', 'src/b.ts'], changed)).toEqual(changed)
  })
})

describe('review gate turn scope', () => {
  const report = assembleReviewReport({
    id: 'run-1',
    state: 'completed',
    target: { mode: 'workspace', cwd: '/repo' },
    reviewers: ['r'],
    createdAt: 1,
    coverage: summarizeCoverage([{ path: 'src/app.ts', change: 'modified', state: 'reviewed', comments: 0 }]),
    files: [{ path: 'src/app.ts', change: 'modified', state: 'reviewed', comments: 0 }],
    comments: [],
    budget: summarizeBudget(createBudgetState(), DEFAULT_REVIEW_BUDGET),
  })

  it('hands the stopping turn to the change reader, so the narrowing is reachable', async () => {
    const seen: (number | undefined)[] = []
    const settings: ReviewGateSettings = { ...DEFAULT_REVIEW_GATE_SETTINGS, mode: 'record' }
    const gate = new FreeCodeGoReviewGate({
      settings: () => settings,
      workspaceOf: () => '/repo',
      readChangedPaths: async (_agentId, turn) => {
        seen.push(turn)
        return ['src/app.ts']
      },
      readChangeRevision: async () => 'rev-1',
      portFor: async () => ({
        async review() { return { report, refused: [], notes: [], attribution: '' } },
        async preview() { throw new Error('not used') },
        status: () => undefined,
        list: () => [],
        report: () => undefined,
        cancel: () => false,
      }),
      record: () => undefined,
      inject: () => true,
    })
    gate.noteToolCall('a1', 'edit')
    await gate.onTurnStopping('a1', { turn: 12 })
    expect(seen).toEqual([12])
  })
})
