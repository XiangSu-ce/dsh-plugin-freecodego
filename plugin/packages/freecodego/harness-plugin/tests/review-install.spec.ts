import { describe, expect, it } from 'vitest'
import { loadReviewRules } from '../src/review/config.ts'
import { createReviewInstall, resolveReviewRoute, DEFAULT_REVIEW_MODEL, DEFAULT_REVIEW_PROVIDER } from '../src/review/install.ts'
import { ReviewRuns } from '../src/review/runs.ts'
import { renderReport, reviewToolDefinitions } from '../src/review/tool.ts'
import { createReviewRuleResolver, SYSTEM_REVIEW_RULE, type ReviewRuleLayer } from '../src/review/rules.ts'
import { summarizeCoverage } from '../src/review/coverage.ts'
import { assembleReviewReport } from '../src/review/report.ts'
import { summarizeBudget, createBudgetState, DEFAULT_REVIEW_BUDGET } from '../src/review/budget.ts'
import { parseUnifiedDiff, type DiffFile } from '../src/review/diff.ts'
import type { ReviewGitPort } from '../src/review/targets.ts'
import type { ReviewModelPort } from '../src/review/model.ts'
import type { ReviewFilePort } from '../src/review/reviewer.ts'
import type { ToolDefinitionShape } from '../src/tool-definition.ts'

const JOIN = (left: string, right: string): string => `${left}/${right}`

/** A promise and its resolver, so a test can hold a stage open on purpose. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(settle => { resolve = settle })
  return { promise, resolve }
}

const SINGLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1..2 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 const a = 1
+const b = 3
 const c = 6
`

/** A reader over an in-memory file map; a missing path is undefined, as the real reader behaves. */
function reader(files: Record<string, string>) {
  return async (path: string): Promise<string | undefined> => files[path]
}

/** A git port that answers a one-file workspace diff. */
const singleFileGit: ReviewGitPort = {
  async run(args) {
    const line = args.join(' ')
    if (line.includes('ls-files')) return { exitCode: 0, stdout: '', stderr: '' }
    if (line.includes('--numstat')) return { exitCode: 0, stdout: '1\t0\tsrc/app.ts\n', stderr: '' }
    if (line.includes('--name-status')) return { exitCode: 0, stdout: 'M\tsrc/app.ts\n', stderr: '' }
    return { exitCode: 0, stdout: SINGLE_DIFF, stderr: '' }
  },
  async readFileSize() {
    return undefined
  },
}

const permissiveRules = createReviewRuleResolver([
  { source: 'system', defaultRule: SYSTEM_REVIEW_RULE, entries: [] },
] satisfies ReviewRuleLayer[])

const emptyModel: ReviewModelPort = {
  async generate() {
    return { text: '{"verdicts":[]}', inputTokens: 0, outputTokens: 0 }
  },
}

const noFindingsReviewer: ReviewFilePort = {
  async review() {
    return { comments: [], spent: { inputTokens: 0, outputTokens: 0 } }
  },
}

describe('review rule loading', () => {
  it('reads the project rule file and keeps the system default below it', async () => {
    const loaded = await loadReviewRules({
      workspace: '/repo',
      readFile: reader({ '/repo/.opencodereview/rule.json': '{"rules":[{"path":"**/*.ts","rule":"no any"}]}' }),
      joinPath: JOIN,
    })
    expect(loaded.sources).toEqual(['/repo/.opencodereview/rule.json'])
    expect(loaded.warnings).toEqual([])
    expect(loaded.resolver.resolve('src/a.ts')).toMatchObject({ source: 'project', rule: 'no any' })
    expect(loaded.resolver.resolve('src/a.py')).toMatchObject({ source: 'system', rule: SYSTEM_REVIEW_RULE })
  })

  it('takes the first project file that exists rather than merging several', async () => {
    const loaded = await loadReviewRules({
      workspace: '/repo',
      readFile: reader({
        '/repo/.opencodereview/rule.json': '{"rules":[{"path":"**/*.ts","rule":"first"}]}',
        '/repo/.dsh/review.json': '{"rules":[{"path":"**/*.ts","rule":"second"}]}',
      }),
      joinPath: JOIN,
    })
    expect(loaded.sources).toEqual(['/repo/.opencodereview/rule.json'])
    expect(loaded.layers.find(layer => layer.source === 'project')?.entries[0]?.rule).toBe('first')
  })

  it('lets a run-specific file outrank a project file', async () => {
    const loaded = await loadReviewRules({
      workspace: '/repo',
      customPath: '/tmp/run.json',
      readFile: reader({
        '/tmp/run.json': '{"rules":[{"path":"**/*.ts","rule":"custom"}]}',
        '/repo/.opencodereview/rule.json': '{"rules":[{"path":"**/*.ts","rule":"project"}]}',
      }),
      joinPath: JOIN,
    })
    expect(loaded.resolver.resolve('src/a.ts')).toMatchObject({ source: 'custom', rule: 'custom' })
  })

  it('reports a malformed rule file instead of silently reviewing without it', async () => {
    const loaded = await loadReviewRules({
      workspace: '/repo',
      readFile: reader({ '/repo/.opencodereview/rule.json': '{"rules":[{"path":"x",}]}' }),
      joinPath: JOIN,
    })
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toContain('/repo/.opencodereview/rule.json')
    expect(loaded.resolver.resolve('x.ts')).toMatchObject({ source: 'system' })
  })

  it('applies a project rule file\'s own exclude patterns to that project', async () => {
    // `exclude` travels with the file it was written in, so it takes effect where
    // the rules do — and the report names the layer that removed the file, which is
    // what makes "excluded" actionable rather than a bare category.
    const loaded = await loadReviewRules({
      workspace: '/repo',
      readFile: reader({
        '/repo/.opencodereview/rule.json': '{"rules":[{"path":"**/*.ts","rule":"no any"}],"exclude":["**/*.gen.ts","vendor/**"]}',
      }),
      joinPath: JOIN,
    })
    expect(loaded.warnings).toEqual([])
    expect(loaded.resolver.excludeSource('src/api.gen.ts')).toBe('project')
    expect(loaded.resolver.excludeSource('vendor/lib.ts')).toBe('project')
    expect(loaded.resolver.excludeSource('src/api.ts')).toBeUndefined()
    // The rules still apply: an exclusion is not a replacement for the standard.
    expect(loaded.resolver.resolve('src/api.ts')).toMatchObject({ source: 'project', rule: 'no any' })
  })

  it('does not let a malformed project file leave its rules in force without its exclusions', async () => {
    // Both halves of the file are validated together: a file whose `exclude` is not
    // a list is reported and dropped whole, rather than applying its rules while its
    // exclusions quietly vanish.
    const loaded = await loadReviewRules({
      workspace: '/repo',
      readFile: reader({
        '/repo/.opencodereview/rule.json': '{"rules":[{"path":"**/*.ts","rule":"no any"}],"exclude":"**/*.gen.ts"}',
      }),
      joinPath: JOIN,
    })
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toContain('"exclude" must be an array')
    expect(loaded.resolver.resolve('src/api.ts')).toMatchObject({ source: 'system' })
    expect(loaded.resolver.excludeSource('src/api.gen.ts')).toBeUndefined()
  })

  it('reads the user-level file from home and applies caller excludes on the system layer', async () => {
    const loaded = await loadReviewRules({
      workspace: '/repo',
      home: '/home/ada',
      exclude: ['**/vendor/**'],
      readFile: reader({ '/home/ada/.opencodereview/rule.json': '{"rules":[{"path":"**/*.go","rule":"user-go"}]}' }),
      joinPath: JOIN,
    })
    expect(loaded.sources).toEqual(['/home/ada/.opencodereview/rule.json'])
    expect(loaded.resolver.resolve('main.go')).toMatchObject({ source: 'global', rule: 'user-go' })
    expect(loaded.resolver.excludeSource('vendor/a.ts')).toBe('system')
  })

  it('always produces a usable resolver, even with nothing on disk', async () => {
    const loaded = await loadReviewRules({ workspace: '/repo', readFile: async () => undefined, joinPath: JOIN })
    expect(loaded.sources).toEqual([])
    expect(loaded.resolver.resolve('a.ts')).toMatchObject({ source: 'system', pattern: 'default' })
  })
})

describe('review route resolution', () => {
  it('uses the configured second-model route', () => {
    expect(resolveReviewRoute({ advisorProvider: 'anthropic', advisorModel: 'claude' }))
      .toEqual({ provider: 'anthropic', model: 'claude' })
  })

  it('falls back to the shipped default when nothing is configured', () => {
    expect(resolveReviewRoute(undefined)).toEqual({ provider: DEFAULT_REVIEW_PROVIDER, model: DEFAULT_REVIEW_MODEL })
    expect(resolveReviewRoute({ advisorProvider: '  ', advisorModel: '' }))
      .toEqual({ provider: DEFAULT_REVIEW_PROVIDER, model: DEFAULT_REVIEW_MODEL })
  })
})

describe('review composition root', () => {
  it('assembles a port that reviews a workspace end to end', async () => {
    const install = await createReviewInstall({
      llm: { async *stream() { /* the fake reviewer means no stream is read */ } },
      workspace: '/repo',
      readFile: reader({ '/repo/.opencodereview/rule.json': '{"rules":[{"path":"**/*.ts","rule":"no any"}]}' }),
      joinPath: JOIN,
      git: singleFileGit,
      reviewer: noFindingsReviewer,
      now: () => 1_700_000_000_000,
      keep: 2,
    })

    expect(install.warnings).toEqual([])
    const result = await install.port.review({ request: { mode: 'workspace', cwd: '/repo' } })
    expect(result.report.state).toBe('completed')
    expect(result.report.coverage).toMatchObject({ totalFiles: 1, reviewedFiles: 1 })
    expect(result.report.comments).toEqual([])
    expect(install.port.status()?.state).toBe('completed')
  })

  it('surfaces a malformed project rule file without failing the review', async () => {
    const install = await createReviewInstall({
      llm: { async *stream() {} },
      workspace: '/repo',
      readFile: reader({ '/repo/.dsh/review.json': 'not json' }),
      joinPath: JOIN,
      git: singleFileGit,
      reviewer: noFindingsReviewer,
    })
    expect(install.warnings).toHaveLength(1)
    const result = await install.port.review({ request: { mode: 'workspace', cwd: '/repo' } })
    expect(result.report.state).toBe('completed')
  })

  it('adjudicates when enabled, keeping a finding the adjudicator cannot decide', async () => {
    // The stub model answers every call with a filter-shaped object, so the
    // adjudicator reads no verdict and must report `unavailable` — which the stage
    // treats as undecided rather than as agreement.
    const install = await createReviewInstall({
      llm: { async *stream() {} },
      workspace: '/repo',
      readFile: async () => undefined,
      joinPath: JOIN,
      git: singleFileGit,
      escalationEnabled: () => true,
      reviewer: {
        async review() {
          return {
            comments: [{ path: 'src/app.ts', content: 'drops the tenant', startLine: 2, endLine: 2, severity: 'critical', category: 'bug' }],
            spent: { inputTokens: 0, outputTokens: 0 },
          }
        },
      },
    })
    const result = await install.port.review({ request: { mode: 'workspace', cwd: '/repo' } })
    expect(result.report.escalations).toHaveLength(1)
    expect(result.report.escalations[0]?.resolution).toBe('undecided')
    expect(result.report.comments[0]?.state).toBe('kept')
  })

  it('leaves findings unadjudicated when adjudication is off', async () => {
    const install = await createReviewInstall({
      llm: { async *stream() {} },
      workspace: '/repo',
      readFile: async () => undefined,
      joinPath: JOIN,
      git: singleFileGit,
      reviewer: {
        async review() {
          return {
            comments: [{ path: 'src/app.ts', content: 'drops the tenant', startLine: 2, endLine: 2, severity: 'critical', category: 'bug' }],
            spent: { inputTokens: 0, outputTokens: 0 },
          }
        },
      },
    })
    const result = await install.port.review({ request: { mode: 'workspace', cwd: '/repo' } })
    expect(result.report.escalations).toEqual([])
  })

  it('previews coverage and rules without calling a model', async () => {
    let modelCalls = 0
    const install = await createReviewInstall({
      llm: { async *stream() { modelCalls += 1 } },
      workspace: '/repo',
      readFile: async () => undefined,
      joinPath: JOIN,
      git: singleFileGit,
      reviewer: noFindingsReviewer,
    })
    const preview = await install.port.preview({ mode: 'workspace', cwd: '/repo' })
    expect(preview.target.files.map(file => file.path)).toEqual(['src/app.ts'])
    expect(preview.ruleGroups).toHaveLength(1)
    expect(modelCalls).toBe(0)
  })
})

describe('review run manager', () => {
  const manager = (overrides: { reviewer?: ReviewFilePort; git?: ReviewGitPort; maxConcurrent?: number } = {}) =>
    new ReviewRuns({
      git: overrides.git ?? singleFileGit,
      rules: permissiveRules,
      ...(overrides.maxConcurrent === undefined ? {} : { maxConcurrent: overrides.maxConcurrent }),
      keep: 2,
      now: () => 1_700_000_000_000,
      engine: { model: emptyModel, reviewer: overrides.reviewer ?? noFindingsReviewer },
    })

  it('refuses a second concurrent review, naming the run that holds the slot', async () => {
    const gate = deferred()
    const runs = manager({ reviewer: { review: async () => { await gate.promise; return { comments: [], spent: { inputTokens: 0, outputTokens: 0 } } } } })
    const first = runs.review({ request: { mode: 'workspace', cwd: '/repo' } })
    // The snapshot is published before the first await, so a second caller sees
    // the slot as taken even though no file has been read yet.
    expect(runs.busy).toBe(true)
    await expect(runs.review({ request: { mode: 'workspace', cwd: '/repo' } })).rejects.toThrow(/already running/)
    gate.resolve()
    await first
    expect(runs.busy).toBe(false)
  })

  it('aborts the run in flight and reports it cancelled', async () => {
    const runs = manager({
      reviewer: {
        review: async task => new Promise(resolve => {
          const done = (): void => resolve({ comments: [], spent: { inputTokens: 0, outputTokens: 0 } })
          if (task.signal?.aborted === true) done()
          else task.signal?.addEventListener('abort', done, { once: true })
        }),
      },
    })
    const pending = runs.review({ request: { mode: 'workspace', cwd: '/repo' } })
    expect(runs.cancel()).toBe(true)
    const result = await pending
    expect(result.report.state).toBe('cancelled')
    expect(runs.cancel()).toBe(false)
  })

  it('records a failed run with its error and keeps a report per finished run', async () => {
    const runs = manager({
      git: {
        async run() {
          throw new Error('git is not installed')
        },
        async readFileSize() {
          return undefined
        },
      },
    })
    await expect(runs.review({ request: { mode: 'workspace', cwd: '/repo' } })).rejects.toThrow(/git is not installed/)
    expect(runs.status()?.error).toContain('git is not installed')
    expect(runs.status()?.state).toBe('failed')
    expect(runs.report()).toBeUndefined()
    expect(runs.list()).toHaveLength(1)
  })

  it('forgets runs past its retention count', async () => {
    const runs = manager()
    for (let index = 0; index < 3; index += 1) {
      await runs.review({ request: { mode: 'workspace', cwd: '/repo' } })
    }
    expect(runs.list().length).toBeLessThanOrEqual(3)
    expect(runs.list().filter(snapshot => snapshot.phase === 'done').length).toBeLessThanOrEqual(2)
  })

  it('reports nothing before any run has happened', () => {
    const runs = manager()
    expect(runs.status()).toBeUndefined()
    expect(runs.report()).toBeUndefined()
    expect(runs.cancel()).toBe(false)
  })

  it('names a run the same way in its status and in its report', async () => {
    // Two id spaces used to exist: the manager's `review-…` — what `status`, `list`
    // and the panel all print, and what the gate's message names — and the engine's
    // UUID, which the report was actually stored under. The id a reader copied out
    // of the status was therefore guaranteed to find no report.
    const runs = manager()
    await runs.review({ request: { mode: 'workspace', cwd: '/repo' } })
    const listed = runs.list()[0] as { id: string }
    expect(runs.status(listed.id)).toBe(listed)
    expect(runs.report(listed.id)?.id).toBe(listed.id)
    expect(runs.report()).toBe(runs.report(listed.id))
  })

  it('gives every run a distinct id even with a frozen clock and a cycling retention', async () => {
    // The id used to end in the count of retained runs, which cycles as old ones are
    // trimmed: with a clock that does not advance, the next run was named after one
    // still on the list. `push` then *replaced* that snapshot and the report map is
    // keyed the same way, so an older run's history and report disappeared.
    const runs = manager()
    const seen = new Set<string>()
    for (let index = 0; index < 6; index += 1) {
      await runs.review({ request: { mode: 'workspace', cwd: '/repo' } })
      for (const snapshot of runs.list()) seen.add(snapshot.id)
    }
    expect(seen.size).toBe(6)
  })

  it('answers a named lookup for a run with no report with nothing, not another run\'s report', async () => {
    const gate = deferred()
    // Only the second run is held open: the first has to publish a report for the
    // unnamed lookup to have something to answer with.
    let calls = 0
    const runs = manager({
      reviewer: {
        review: async () => {
          calls += 1
          if (calls > 1) await gate.promise
          return { comments: [], spent: { inputTokens: 0, outputTokens: 0 } }
        },
      },
    })
    await runs.review({ request: { mode: 'workspace', cwd: '/repo' } })
    const published = runs.report()
    const pending = runs.review({ request: { mode: 'workspace', cwd: '/repo' } })
    const inFlight = runs.list()[0] as { id: string }
    expect(runs.report(inFlight.id)).toBeUndefined()
    // Asking for no particular run still answers with the most recent *published*
    // review, while the run that has not published one is still in flight.
    expect(runs.report()).toBe(published)
    gate.resolve()
    await pending
    expect(runs.report(inFlight.id)?.id).toBe(inFlight.id)
  })
})

describe('review tools', () => {
  const fakePort = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    async review() {
      return {
        report: assembleReviewReport({
          id: 'r1',
          state: 'completed' as const,
          target: { mode: 'workspace' as const, cwd: '/repo' },
          reviewers: ['reviewer-1'],
          createdAt: 1,
          coverage: summarizeCoverage([{ path: 'src/app.ts', change: 'modified', state: 'reviewed', comments: 1 }]),
          files: [{ path: 'src/app.ts', change: 'modified', state: 'reviewed', comments: 1 }],
          comments: [],
          budget: summarizeBudget(createBudgetState(), DEFAULT_REVIEW_BUDGET),
        }),
        refused: [],
        notes: [],
        attribution: 'Apache-2.0',
      }
    },
    async preview() {
      return {
        target: {
          mode: 'workspace' as const,
          cwd: '/repo',
          files: [{ path: 'src/app.ts', status: 'modified' as const, added: 1, deleted: 0, untracked: false, diff: parseUnifiedDiff(SINGLE_DIFF)[0] as DiffFile }],
          excluded: [{ path: 'assets/logo.png', reason: 'binary' as const, detail: 'git reported binary content' }],
        },
        ruleGroups: [{ id: 1, source: 'project' as const, pattern: '**/*.ts', rule: 'no any', files: ['src/app.ts'] }],
      }
    },
    status: () => ({ id: 'r1', phase: 'done' as const, state: 'completed' as const, mode: 'workspace', startedAt: 1, finishedAt: 2, files: 1, reviewed: 1, failed: 0, skipped: 0, findings: 2 }),
    list: () => [{ id: 'r1', phase: 'done' as const, state: 'completed' as const, mode: 'workspace', startedAt: 1, finishedAt: 2, files: 1, reviewed: 1, failed: 0, skipped: 0, findings: 2 }],
    report: () => undefined,
    cancel: () => true,
    ...overrides,
  })

  const toolsFor = (port: Record<string, unknown>) =>
    reviewToolDefinitions({ forWorkspace: async () => port as never })

  const call = async (definition: ToolDefinitionShape, args: unknown, cwd = '/repo'): Promise<{ summary: string; unavailable?: readonly string[] }> => {
    const execute = definition.execute as (args: unknown, exec: unknown) => Promise<{ summary: string; unavailable?: readonly string[] }>
    return execute(args, { agent: { session: { header: { cwd } } } })
  }

  it('registers four tools under the engineering_ prefix', () => {
    const names = toolsFor(fakePort()).map(definition => definition.name)
    expect(names).toEqual([
      'engineering_code_review',
      'engineering_review_rules',
      'engineering_review_status',
      'engineering_review_report',
    ])
  })

  it('runs a review and returns the rendered report', async () => {
    const tools = toolsFor(fakePort())
    const answer = await call(tools[0] as ToolDefinitionShape, { mode: 'workspace', background: 'why' })
    expect(answer.summary).toContain('# Code Review Results')
    expect(answer.summary).toContain('Files reviewed: 1 / 1')
  })

  it('passes the session working directory rather than trusting an argument', async () => {
    let seen = ''
    const tools = toolsFor(fakePort({
      async preview(request: { cwd: string }) {
        seen = request.cwd
        return {
          target: { mode: 'workspace' as const, cwd: request.cwd, files: [], excluded: [] },
          ruleGroups: [],
        }
      },
    }))
    await call(tools[1] as ToolDefinitionShape, { mode: 'workspace' }, '/somewhere/else')
    expect(seen).toBe('/somewhere/else')
  })

  it('renders the deterministic preview with the coverage denominator', async () => {
    const answer = await call(toolsFor(fakePort())[1] as ToolDefinitionShape, { mode: 'workspace' })
    expect(answer.summary).toContain('Files that would be reviewed: 1')
    expect(answer.summary).toContain('`assets/logo.png` — binary')
    expect(answer.summary).toContain('group 1 [project, pattern **/*.ts]')
  })

  it('reports that no review has run rather than failing', async () => {
    const answer = await call(toolsFor(fakePort({ list: () => [] }))[2] as ToolDefinitionShape, {})
    expect(answer.summary).toContain('No review has run in this workspace yet')
  })

  it('reports a missing report as unavailable rather than throwing', async () => {
    const answer = await call(toolsFor(fakePort())[3] as ToolDefinitionShape, {})
    expect(answer.summary).toContain('No report is available')
    expect(answer.unavailable).toEqual(['no report'])
  })

  it('renders json and sarif on request', async () => {
    const tools = toolsFor(fakePort())
    const json = await call(tools[0] as ToolDefinitionShape, { format: 'json' })
    expect(JSON.parse(json.summary).id).toBe('r1')
    const sarif = await call(tools[0] as ToolDefinitionShape, { format: 'sarif' })
    expect(JSON.parse(sarif.summary).version).toBe('2.1.0')
  })
})

describe('review report formats', () => {
  const report = assembleReviewReport({
    id: 'r1',
    state: 'completed',
    target: { mode: 'range', cwd: '/repo', from: 'main', to: 'feature', mergeBase: 'abc' },
    reviewers: [],
    createdAt: 1,
    coverage: summarizeCoverage([]),
    files: [],
    comments: [],
    budget: summarizeBudget(createBudgetState(), DEFAULT_REVIEW_BUDGET),
  })

  it('renders all three formats from the same report', () => {
    expect(renderReport(report, 'text')).toContain('# Code Review Results')
    expect(JSON.parse(renderReport(report, 'json')).target.mergeBase).toBe('abc')
    expect(JSON.parse(renderReport(report, 'sarif')).runs[0].tool.driver.name).toBe('dsh-freecodego-review')
  })
})
