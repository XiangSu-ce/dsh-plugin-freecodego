/**
 * Tests for the review Remotes.
 *
 * The Host context is faked down to the two lookups these handlers actually make
 * — a session by id and an agent by session id — because everything else here is
 * a rule about input: a ref that would be read as a git option, an exclude list
 * that arrives from a browser, a settings patch that must not carry a key nobody
 * reviewed. Those are the rules that decide whether a browser can make the plugin
 * review a directory the session never opened, and they need no runtime.
 */

import { describe, expect, it } from 'vitest'
import {
  normalizeReviewPatch,
  reviewStart,
  reviewStartInputs,
  reviewStatus,
  reviewUpdate,
  reviewWorkspace,
  type ReviewRemoteSettings,
  type ReviewRemotesHost,
} from '../src/review/remotes.ts'
import { ReviewRuns, type ReviewRunPort, type ReviewRunSnapshot } from '../src/review/runs.ts'
import { createReviewRuleResolver, SYSTEM_REVIEW_RULE } from '../src/review/rules.ts'
import type { ReviewGitPort } from '../src/review/targets.ts'

/** A one-file workspace diff, for the case that runs a real manager. */
const SINGLE_FILE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1..2 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 const a = 1
+const b = 3
 const c = 6
`

const SETTINGS: ReviewRemoteSettings = { mode: 'off', threshold: 'high', cooldownTurns: 3, deep: false, escalation: false }

function snapshot(overrides: Partial<ReviewRunSnapshot> = {}): ReviewRunSnapshot {
  const base = {
    id: 'review-1',
    phase: 'done' as const,
    state: 'completed' as const,
    mode: 'workspace',
    startedAt: 1,
    finishedAt: 2,
    files: 3,
    reviewed: 3,
    failed: 0,
    skipped: 0,
    findings: 1,
  }
  // `state` is dropped rather than set to `undefined` by an override, which
  // `exactOptionalPropertyTypes` rightly refuses.
  return 'state' in overrides && overrides.state === undefined
    ? (() => { const { state: _dropped, ...rest } = overrides; return { ...base, ...rest } })()
    : { ...base, ...overrides }
}

function port(overrides: {
  readonly runs?: readonly ReviewRunSnapshot[]
  readonly reviewThrows?: string
  readonly onReview?: () => void
} = {}) {
  const state = { calls: 0 }
  const api: ReviewRunPort = {
    async review() {
      state.calls += 1
      overrides.onReview?.()
      if (overrides.reviewThrows !== undefined) throw new Error(overrides.reviewThrows)
      return { report: undefined as never, refused: [], notes: [], attribution: '' }
    },
    async preview() { throw new Error('not used') },
    status: () => undefined,
    list: () => overrides.runs ?? [snapshot()],
    report: () => undefined,
    cancel: () => false,
  }
  return { api, state }
}

function host(options: {
  readonly cwd?: string | undefined
  readonly knownSession?: boolean
  readonly iport?: ReviewRunPort
  readonly settings?: ReviewRemoteSettings
  readonly deep?: boolean
  readonly patched?: Record<string, unknown>[]
} = {}): ReviewRemotesHost {
  const known = options.knownSession ?? true
  const cwd = options.cwd ?? '/repo'
  return {
    ctx: {
      sessions: { get: () => (known ? { header: { cwd } } : undefined) as { header: { cwd: string } } | undefined },
      agents: { get: () => (options.deep === true ? { id: 'agent-1' } : undefined) },
    } as unknown as ReviewRemotesHost['ctx'],
    portFor: async () => options.iport ?? port().api,
    deepReviewerFor: agent => (agent === undefined ? undefined : { review: async () => ({ comments: [], spent: { inputTokens: 0, outputTokens: 0 } }) }),
    settings: () => options.settings ?? SETTINGS,
    update: async patch => { options.patched?.push(patch as Record<string, unknown>) },
  }
}

describe('review workspace resolution', () => {
  it('refuses a request with no session to review from', () => {
    expect(() => reviewWorkspace(host(), '')).toThrow('requires the session')
    expect(() => reviewWorkspace(host(), 'x'.repeat(300))).toThrow('requires the session')
  })

  it('refuses a session the host does not have open', () => {
    expect(() => reviewWorkspace(host({ knownSession: false }), 'session-1')).toThrow('workspace-backed')
  })

  it('refuses a session whose workspace is empty', () => {
    expect(() => reviewWorkspace(host({ cwd: '  ' }), 'session-1')).toThrow('workspace-backed')
  })

  it('resolves the workspace from the session that asked', () => {
    expect(reviewWorkspace(host({ cwd: 'E:/work/app' }), 'session-1')).toBe('E:/work/app')
  })
})

describe('review settings patch', () => {
  it('writes only the fields a settings page owns', () => {
    // A browser-sent object reaches `policy.update`, which merges whatever it is
    // given into the user's settings document. An unreviewed key that got through
    // would be written and then blamed on the user's own file.
    const patch = normalizeReviewPatch({ reviewMode: 'gate', reviewDeep: true, reviewFallback: 'nope' } as never)
    expect(patch).toEqual({ reviewMode: 'gate', reviewDeep: true })
  })

  it('refuses values the schema would only drop', () => {
    expect(() => normalizeReviewPatch({ reviewMode: 'always' } as never)).toThrow('off, record or gate')
    expect(() => normalizeReviewPatch({ reviewThreshold: 'urgent' } as never)).toThrow('critical, high, medium or low')
    expect(() => normalizeReviewPatch({ reviewCooldownTurns: 2.5 } as never)).toThrow('whole number')
    expect(() => normalizeReviewPatch({ reviewCooldownTurns: 21 } as never)).toThrow('between 0 and 20')
    expect(() => normalizeReviewPatch(undefined)).toThrow('update is required')
  })

  it('coerces the two switches to booleans rather than trusting them', () => {
    expect(normalizeReviewPatch({ reviewEscalation: 'yes' as never })).toEqual({ reviewEscalation: false })
    expect(normalizeReviewPatch({})).toEqual({})
  })
})

describe('review start inputs', () => {
  it('starts from the workspace it was given, not from anything the browser said', () => {
    const inputs = reviewStartInputs({ mode: 'workspace', from: 'main' }, '/repo')
    expect(inputs.request.cwd).toBe('/repo')
    // A workspace-mode request carries no refs at all: `from` belongs to range mode,
    // and passing it on would make the target resolver read a ref nobody chose.
    expect(inputs.request).toEqual({ mode: 'workspace', cwd: '/repo' })
  })

  it('carries the refs a range or commit review needs', () => {
    expect(reviewStartInputs({ mode: 'range', from: 'main', to: 'feature' }, '/repo').request)
      .toEqual({ mode: 'range', cwd: '/repo', from: 'main', to: 'feature' })
    expect(reviewStartInputs({ mode: 'commit', commit: 'HEAD~2' }, '/repo').request)
      .toEqual({ mode: 'commit', cwd: '/repo', commit: 'HEAD~2' })
  })

  it('refuses a ref that git would read as an option or split into two arguments', () => {
    expect(() => reviewStartInputs({ mode: 'range', from: '--upload-pack=touch /tmp/x' }, '/repo')).toThrow('not a valid git ref')
    expect(() => reviewStartInputs({ mode: 'range', from: 'main extra' }, '/repo')).toThrow('not a valid git ref')
    expect(() => reviewStartInputs({ mode: 'range', from: 'ma\nin' }, '/repo')).toThrow('not a valid git ref')
  })

  it('treats blank refs as absent rather than as empty strings', () => {
    expect(reviewStartInputs({ mode: 'range', from: '   ', to: '' }, '/repo').request)
      .toEqual({ mode: 'range', cwd: '/repo' })
  })

  it('bounds an exclude list and drops the entries that say nothing', () => {
    const inputs = reviewStartInputs({ exclude: ['', '  ', 'dist/**', ...Array.from({ length: 80 }, (_, index) => `p${index}/**`)] }, '/repo')
    expect(inputs.request.exclude).toHaveLength(64)
    expect(inputs.request.exclude?.[0]).toBe('dist/**')
  })

  it('keeps a background that says something and drops one that does not', () => {
    expect(reviewStartInputs({ background: '  retry the upload  ' }, '/repo').background).toBe('retry the upload')
    expect(reviewStartInputs({ background: '   ' }, '/repo').background).toBeUndefined()
    expect(reviewStartInputs({}, '/repo').request.mode).toBe('workspace')
  })
})

describe('review status', () => {
  it('reports the workspace, the settings, and the runs', async () => {
    const api = port({ runs: [snapshot({ findings: 2 })] }).api
    const status = await reviewStatus(host({ iport: api, settings: { ...SETTINGS, mode: 'gate', deep: true } }), 'session-1')
    expect(status).toMatchObject({ workspace: '/repo', mode: 'gate', deep: true, threshold: 'high' })
    expect(status.runs).toHaveLength(1)
    expect(status.runs[0]?.findings).toBe(2)
    expect(status.report).toBeUndefined()
  })
})

describe('review start', () => {
  it('refuses to start while a run is in flight, naming it', async () => {
    const api = port({ runs: [snapshot({ id: 'review-7', phase: 'reviewing' })] }).api
    await expect(reviewStart(host({ iport: api }), 'session-1', {})).rejects.toThrow('already running (review-7')
  })

  it('starts a run without waiting for it and answers with the current runs', async () => {
    const started = port()
    const status = await reviewStart(host({ iport: started.api }), 'session-1', { mode: 'workspace' })
    expect(started.state.calls).toBe(1)
    expect(status.workspace).toBe('/repo')
  })

  it('swallows a failed start, because the manager published the failure already', async () => {
    // A rejection here would be an unhandled one: nothing awaits this promise, and
    // the run manager records the failure on the run it published before the work
    // could fail. The assertion is that `reviewStart` still resolves.
    const failing = port({ reviewThrows: 'git is not installed' })
    const status = await reviewStart(host({ iport: failing.api }), 'session-1', {})
    expect(status.workspace).toBe('/repo')
    expect(failing.state.calls).toBe(1)
  })

  it('makes the run visible before the review has finished — the fire-and-forget contract', async () => {
    // The panel starts a review and then polls the same Remote, so the run has to
    // exist by the time `reviewStart` answers. It does because the manager
    // publishes its snapshot synchronously, before its first await — which is a
    // property of `ReviewRuns`, not of this handler, so it is measured against a
    // real manager with a reviewer that never returns.
    const rules = createReviewRuleResolver([{ source: 'system', defaultRule: SYSTEM_REVIEW_RULE, entries: [] }])
    const git: ReviewGitPort = {
      async run(args) {
        const line = args.join(' ')
        if (line.includes('ls-files')) return { exitCode: 0, stdout: '', stderr: '' }
        if (line.includes('--numstat')) return { exitCode: 0, stdout: '1\t0\tsrc/app.ts\n', stderr: '' }
        if (line.includes('--name-status')) return { exitCode: 0, stdout: 'M\tsrc/app.ts\n', stderr: '' }
        return { exitCode: 0, stdout: SINGLE_FILE_DIFF, stderr: '' }
      },
      async readFileSize() { return undefined },
    }
    const runs = new ReviewRuns({
      git,
      rules,
      engine: {
        model: { generate: async () => ({ text: '{"comments":[]}', inputTokens: 0, outputTokens: 0 }) },
        // Never resolves, so the run is still in flight when the status is read.
        reviewer: { review: () => new Promise(() => {}) },
      },
    })
    const status = await reviewStart(host({ iport: runs }), 'session-1', { mode: 'workspace' })
    expect(status.runs).toHaveLength(1)
    expect(status.runs[0]?.phase).not.toBe('done')
    runs.cancel()
  })

  it('gives the run the deep reviewer when the setting is on and the session has an agent', async () => {
    let sawReviewer = false
    const iport = {
      ...port().api,
      async review(inputs: { readonly reviewer?: unknown }) {
        sawReviewer = inputs.reviewer !== undefined
        return { report: undefined as never, refused: [], notes: [], attribution: '' }
      },
    } as ReviewRunPort
    await reviewStart(host({ iport, deep: true }), 'session-1', {})
    expect(sawReviewer).toBe(true)
  })

  it('starts without a deep reviewer when there is no live agent to open a child in', async () => {
    let sawReviewer = false
    const iport = {
      ...port().api,
      async review(inputs: { readonly reviewer?: unknown }) {
        sawReviewer = inputs.reviewer !== undefined
        return { report: undefined as never, refused: [], notes: [], attribution: '' }
      },
    } as ReviewRunPort
    await reviewStart(host({ iport, deep: false }), 'session-1', {})
    expect(sawReviewer).toBe(false)
  })
})

describe('review update', () => {
  it('writes the whitelisted patch and answers with the new surface', async () => {
    const patched: Record<string, unknown>[] = []
    const status = await reviewStatus(host({ patched, iport: port().api }), 'session-1')
    expect(status.mode).toBe('off')
    await reviewUpdate(host({ patched, iport: port().api }), 'session-1', { reviewMode: 'record' })
    expect(patched).toEqual([{ reviewMode: 'record' }])
  })
})
