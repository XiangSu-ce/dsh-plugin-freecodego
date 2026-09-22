import { describe, expect, it } from 'vitest'
import { changeFingerprint, FreeCodeGoReviewGate, renderGateMessage, reviewGateRecord, worstSeverity, DEFAULT_REVIEW_GATE_SETTINGS, type ReviewGateDelivery, type ReviewGateSettings } from '../src/review/gate.ts'
import { selectReviewableFiles, type ChangedFileEntry } from '../src/review/targets.ts'
import { summarizeCoverage } from '../src/review/coverage.ts'
import { assembleReviewReport } from '../src/review/report.ts'
import { summarizeBudget, createBudgetState, DEFAULT_REVIEW_BUDGET } from '../src/review/budget.ts'
import { validateReviewComment, type ReviewComment } from '../src/review/comments.ts'

const comment = (id: string, severity: string, path = 'src/app.ts'): ReviewComment =>
  (validateReviewComment({ path, content: `finding ${id}`, severity, startLine: 3, endLine: 3 }, id) as { ok: true; comment: ReviewComment }).comment

const report = (comments: readonly ReviewComment[]) => assembleReviewReport({
  id: 'run-1',
  state: 'completed',
  target: { mode: 'workspace', cwd: '/repo' },
  reviewers: ['reviewer-1'],
  createdAt: 1,
  coverage: summarizeCoverage([{ path: 'src/app.ts', change: 'modified', state: 'reviewed', comments: comments.length }]),
  files: [{ path: 'src/app.ts', change: 'modified', state: 'reviewed', comments: comments.length }],
  comments,
  budget: summarizeBudget(createBudgetState(), DEFAULT_REVIEW_BUDGET),
})

/** A gate wired to fakes, with everything a test wants to observe captured. */
function harness(overrides: {
  settings?: Partial<ReviewGateSettings>
  paths?: readonly string[]
  /** True when git cannot answer, which is a different fact from "nothing changed". */
  unreadable?: boolean
  revision?: string | undefined
  comments?: readonly ReviewComment[]
  reviewThrows?: string
  injectResult?: boolean
} = {}) {
  const recorded: ReviewGateDelivery[] = []
  const injected: string[] = []
  let reviews = 0
  let reads = 0
  let revision = overrides.revision ?? 'rev-1'
  // The shipped default is `off` (asserted on its own below). These tests exercise
  // the modes that do something, so the harness states `gate` for any test that
  // does not say otherwise — a test only passes a mode when the mode is the point.
  const settings: ReviewGateSettings = { ...DEFAULT_REVIEW_GATE_SETTINGS, mode: 'gate', ...overrides.settings }
  const gate = new FreeCodeGoReviewGate({
    settings: () => settings,
    workspaceOf: () => '/repo',
    readChangedPaths: async () => {
      reads += 1
      return overrides.unreadable === true ? undefined : (overrides.paths ?? ['src/app.ts'])
    },
    readChangeRevision: async () => revision,
    portFor: async () => ({
      async review() {
        reviews += 1
        if (overrides.reviewThrows !== undefined) throw new Error(overrides.reviewThrows)
        return { report: report(overrides.comments ?? []), refused: [], notes: [], attribution: '' }
      },
      async preview() { throw new Error('not used') },
      status: () => undefined,
      list: () => [],
      report: () => undefined,
      cancel: () => false,
    }),
    record: (_agentId, _report, delivery) => { recorded.push(delivery) },
    inject: (_agentId, text) => {
      if (overrides.injectResult === false) return false
      injected.push(text)
      return overrides.injectResult ?? true
    },
  })
  return {
    gate,
    recorded,
    injected,
    reviews: () => reviews,
    /** How many times the change set was read from git. */
    reads: () => reads,
    /** Change the workspace revision, which is what makes the next stop a new change set. */
    setRevision: (next: string) => { revision = next },
  }
}

describe('review gate fingerprints', () => {
  it('ignores path order but not content revision', () => {
    expect(changeFingerprint(['a.ts', 'b.ts'], 'r1')).toBe(changeFingerprint(['b.ts', 'a.ts'], 'r1'))
    expect(changeFingerprint(['a.ts'], 'r1')).not.toBe(changeFingerprint(['a.ts'], 'r2'))
    expect(changeFingerprint(['a.ts'], 'r1')).not.toBe(changeFingerprint(['b.ts'], 'r1'))
    expect(changeFingerprint(['a.ts'], undefined)).not.toBe(changeFingerprint(['a.ts'], 'r1'))
  })

  it('reports the worst severity present', () => {
    expect(worstSeverity([comment('c1', 'low'), comment('c2', 'critical'), comment('c3', 'medium')])).toBe('critical')
    expect(worstSeverity([])).toBeUndefined()
  })
})

describe('review gate pass', () => {
  it('does nothing when the mode is off', async () => {
    const { gate, reviews, recorded } = harness({ settings: { mode: 'off' }, comments: [comment('c1', 'critical')] })
    gate.noteToolCall('a1', 'edit')
    const outcome = await gate.onTurnStopping('a1')
    expect(outcome).toMatchObject({ kind: 'skipped' })
    expect(reviews()).toBe(0)
    expect(recorded).toEqual([])
  })

  it('ships off, so a composition with no settings service reviews nothing', async () => {
    // The fallback value is what a host without a settings service uses. Choosing
    // `record` or `gate` here would mean a review that nobody switched on, spending
    // model calls and — in `gate` — injecting into conversations that never asked.
    expect(DEFAULT_REVIEW_GATE_SETTINGS.mode).toBe('off')
    const shipped = harness({ settings: { mode: DEFAULT_REVIEW_GATE_SETTINGS.mode }, comments: [comment('c1', 'critical')] })
    shipped.gate.noteToolCall('a1', 'edit')
    expect(await shipped.gate.onTurnStopping('a1')).toMatchObject({ kind: 'skipped' })
    expect(shipped.reviews()).toBe(0)
    expect(shipped.injected).toEqual([])
  })

  it('never reviews a turn that ran no mutating tool', async () => {
    const { gate, reviews } = harness()
    gate.noteToolCall('a1', 'read')
    expect(await gate.onTurnStopping('a1')).toMatchObject({ kind: 'skipped', reason: 'the turn changed nothing' })
    expect(reviews()).toBe(0)
  })

  it('skips when the change set cannot be read or is empty', async () => {
    const unreadable = harness({ unreadable: true })
    unreadable.gate.noteToolCall('a1', 'edit')
    expect(await unreadable.gate.onTurnStopping('a1')).toMatchObject({ kind: 'skipped', reason: 'the change set could not be read' })

    const empty = harness({ paths: [] })
    empty.gate.noteToolCall('a1', 'edit')
    expect(await empty.gate.onTurnStopping('a1')).toMatchObject({ kind: 'skipped', reason: 'the turn changed nothing' })
    expect(unreadable.reviews() + empty.reviews()).toBe(0)
  })

  it('reviews a change set once and latches it', async () => {
    const { gate, reviews, recorded } = harness({ comments: [comment('c1', 'low')] })
    gate.noteToolCall('a1', 'edit')
    const first = await gate.onTurnStopping('a1')
    expect(first.kind).toBe('ran')
    expect(reviews()).toBe(1)
    expect(recorded).toHaveLength(1)

    gate.noteToolCall('a1', 'edit')
    const second = await gate.onTurnStopping('a1')
    expect(second).toMatchObject({ kind: 'skipped', reason: 'this change set was already reviewed' })
    expect(reviews()).toBe(1)
  })

  it('re-reviews the same paths when their content changed', async () => {
    const h = harness({ comments: [] })
    h.gate.noteToolCall('a1', 'edit')
    await h.gate.onTurnStopping('a1')
    expect(h.reviews()).toBe(1)

    // A second edit of an already-modified file changes no path, so a path-only
    // latch would call this the same change set and skip it.
    h.setRevision('rev-2')
    h.gate.noteToolCall('a1', 'edit')
    await h.gate.onTurnStopping('a1')
    expect(h.reviews()).toBe(2)
  })

  it('records findings without injecting them when the mode is record', async () => {
    const { gate, injected, recorded } = harness({ settings: { mode: 'record' }, comments: [comment('c1', 'critical')] })
    gate.noteToolCall('a1', 'edit')
    const outcome = await gate.onTurnStopping('a1')
    expect(outcome).toMatchObject({ kind: 'ran', delivery: { findings: 1, blocking: 1, delivered: false } })
    expect(injected).toEqual([])
    expect(recorded[0]?.worst).toBe('critical')
    // Not "already reviewed": the run happened and found a critical finding. The
    // mode is the reason nothing was injected, and the record has to say so — it is
    // read back from a durable session event by a surface that cannot re-derive it.
    expect(recorded[0]?.suppressed).toBe('recording-only')
    expect(reviewGateRecord(report([comment('c1', 'critical')]), recorded[0] as ReviewGateDelivery).suppressed).toBe('recording-only')
  })

  it('reads the change set once for a turn known to have changed nothing', async () => {
    // A mutating tool that changed nothing — a write of identical content — must not
    // make every later stop re-read git to learn the same fact again.
    const h = harness({ paths: [] })
    h.gate.noteToolCall('a1', 'edit')
    expect(await h.gate.onTurnStopping('a1')).toMatchObject({ kind: 'skipped', reason: 'the turn changed nothing' })
    expect(h.reads()).toBe(1)
    expect(await h.gate.onTurnStopping('a1')).toMatchObject({ kind: 'skipped', reason: 'the turn changed nothing' })
    expect(h.reads()).toBe(1)
  })

  it('delivers a finding at or above the threshold and suppresses one below it', async () => {
    const delivered = harness({ comments: [comment('c1', 'high'), comment('c2', 'low')] })
    delivered.gate.noteToolCall('a1', 'edit')
    const outcome = await delivered.gate.onTurnStopping('a1')
    expect(outcome).toMatchObject({ kind: 'ran', delivery: { blocking: 1, delivered: true } })
    expect(delivered.injected[0]).toContain('stop-time review')
    expect(delivered.injected[0]).toContain('src/app.ts:3')
    expect(delivered.injected[0]).toContain('run-1')

    const quiet = harness({ comments: [comment('c1', 'low')] })
    quiet.gate.noteToolCall('a1', 'edit')
    expect(await quiet.gate.onTurnStopping('a1')).toMatchObject({
      kind: 'ran',
      delivery: { blocking: 0, delivered: false, suppressed: 'below-threshold' },
    })
    expect(quiet.injected).toEqual([])
  })

  it('honors the cooldown between deliveries and re-delivers when it elapses', async () => {
    const h = harness({ settings: { cooldownTurns: 2 }, comments: [comment('c1', 'high')] })
    h.gate.noteToolCall('a1', 'edit')
    expect(await h.gate.onTurnStopping('a1')).toMatchObject({ kind: 'ran', delivery: { delivered: true, sequence: 1 } })
    expect(h.injected).toHaveLength(1)

    // A new change set one stop later is reviewed but not delivered: the same
    // finding reported again the next turn is what a cooldown exists to stop.
    h.setRevision('rev-2')
    h.gate.noteToolCall('a1', 'edit')
    expect(await h.gate.onTurnStopping('a1')).toMatchObject({
      kind: 'ran',
      delivery: { delivered: false, suppressed: 'cooldown', sequence: 2 },
    })
    expect(h.injected).toHaveLength(1)

    h.setRevision('rev-3')
    h.gate.noteToolCall('a1', 'edit')
    expect(await h.gate.onTurnStopping('a1')).toMatchObject({ kind: 'ran', delivery: { delivered: true, sequence: 3 } })
    expect(h.injected).toHaveLength(2)
    expect(h.reviews()).toBe(3)
  })

  it('latches the change set even when the agent is gone and nothing was delivered', async () => {
    const { gate, reviews } = harness({ injectResult: false, comments: [comment('c1', 'high')] })
    gate.noteToolCall('a1', 'edit')
    expect(await gate.onTurnStopping('a1')).toMatchObject({ kind: 'ran', delivery: { delivered: false } })
    gate.noteToolCall('a1', 'edit')
    expect(await gate.onTurnStopping('a1')).toMatchObject({ kind: 'skipped' })
    expect(reviews()).toBe(1)
  })

  it('reports a review failure without blocking the stop, and keeps the cost bounded', async () => {
    const { gate, reviews } = harness({ reviewThrows: 'no route configured' })
    gate.noteToolCall('a1', 'edit')
    expect(await gate.onTurnStopping('a1')).toEqual({ kind: 'failed', reason: 'no route configured' })
    // The mutating flag is cleared, so a failing review is not retried on every
    // subsequent stop.
    expect(await gate.onTurnStopping('a1')).toMatchObject({ kind: 'skipped' })
    expect(reviews()).toBe(1)
  })

  it('forgets an agent on disposal', async () => {
    const { gate, reviews } = harness({ comments: [] })
    gate.noteToolCall('a1', 'edit')
    await gate.onTurnStopping('a1')
    gate.forget('a1')
    gate.noteToolCall('a1', 'edit')
    await gate.onTurnStopping('a1')
    expect(reviews()).toBe(2)
  })

  it('writes a summary, not the whole report, to the session', () => {
    const comments = [comment('c1', 'critical'), comment('c2', 'low')]
    const record = reviewGateRecord(report(comments), { sequence: 4, findings: 2, blocking: 1, worst: 'critical', delivered: true })
    expect(record).toEqual({
      id: 'run-1',
      state: 'completed',
      sequence: 4,
      files: 1,
      reviewed: 1,
      findings: 2,
      blocking: 1,
      worst: 'critical',
      delivered: true,
    })
  })

  it('names every blocking finding and its location in the injected message', () => {
    const blocking = [comment('c1', 'critical'), comment('c2', 'high', 'src/other.ts')]
    const text = renderGateMessage(report(blocking), blocking, 7)
    expect(text).toContain('review #7')
    expect(text).toContain('src/app.ts:3')
    expect(text).toContain('src/other.ts:3')
    expect(text).toContain('engineering_review_report')
  })
})

describe('review scoped selection', () => {
  const entry = (path: string): ChangedFileEntry => ({
    path, status: 'modified', added: 1, deleted: 0, binary: false, sizeBytes: 10, untracked: false,
  })
  const diff = (path: string) => ({
    path, oldPath: path, newPath: path, status: 'modified' as const, binary: false, added: 1, deleted: 0, hunks: [],
  })

  it('confines a run to the requested paths and names the rest as outside scope', () => {
    const selection = selectReviewableFiles(
      [entry('src/app.ts'), entry('src/other.ts')],
      new Map([['src/app.ts', diff('src/app.ts')], ['src/other.ts', diff('src/other.ts')]]),
      { include: ['src/app.ts'] },
    )
    expect(selection.files.map(file => file.path)).toEqual(['src/app.ts'])
    expect(selection.excluded).toEqual([
      { path: 'src/other.ts', reason: 'outside-scope', detail: "changed outside this review's scope, so it was not re-reviewed" },
    ])
  })

  it('treats an empty include list as no scope at all', () => {
    const selection = selectReviewableFiles(
      [entry('src/app.ts')],
      new Map([['src/app.ts', diff('src/app.ts')]]),
      { include: [] },
    )
    expect(selection.files).toHaveLength(1)
  })
})
