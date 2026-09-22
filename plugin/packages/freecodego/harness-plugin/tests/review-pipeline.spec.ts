import { describe, expect, it } from 'vitest'
import { parseNameStatus, parseNumstat, resolveReviewTarget, selectReviewableFiles, type ChangedFileEntry, type ReviewGitPort } from '../src/review/targets.ts'
import { fallbackGrouping, groupChanges, validateGrouping } from '../src/review/grouping.ts'
import { parseReviewPlan, planGroup, shouldPlan } from '../src/review/plan.ts'
import { applyFilterVerdicts, filterComments, parseFilterVerdicts } from '../src/review/filter.ts'
import { buildFileReviewPrompt, createModelFileReviewer, parseFileComments } from '../src/review/reviewer.ts'
import { runReview } from '../src/review/engine.ts'
import { createReviewRuleResolver, groupByRule, type ReviewRuleLayer } from '../src/review/rules.ts'
import { parseUnifiedDiff, type DiffFile } from '../src/review/diff.ts'
import type { ReviewModelPort, ReviewModelRequest, ReviewModelResult } from '../src/review/model.ts'
import type { ReviewComment } from '../src/review/comments.ts'

const SINGLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,5 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
+const d = 5
 const e = 6
`

const TWO_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1
+const b = 3
 const c = 6
diff --git a/lib/b.ts b/lib/b.ts
index 1..2 100644
--- a/lib/b.ts
+++ b/lib/b.ts
@@ -1,2 +1,3 @@
 export const x = 1
+export const y = 2
 export const z = 3
`

const TWO_FILE_NAME_STATUS = 'M\tsrc/a.ts\nM\tlib/b.ts\n'
const TWO_FILE_NUMSTAT = '1\t0\tsrc/a.ts\n1\t0\tlib/b.ts\n'

/** A git port whose answers are decided per command by the test. */
function gitWith(handler: (args: readonly string[]) => { exitCode?: number; stdout?: string; stderr?: string }): ReviewGitPort {
  return {
    async run(args) {
      const answer = handler(args)
      // `stderr` is carried through because a failure is reported by quoting git's
      // own words: a fake that dropped it would test a message no real failure
      // produces, and would hide the difference between "git refused" and "git was
      // never reached".
      return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
    },
    async readFileSize() {
      return undefined
    },
  }
}

/** A model port that answers by stage, keyed on the system prompt. */
function modelWith(handler: (request: ReviewModelRequest) => Partial<ReviewModelResult> | undefined): ReviewModelPort {
  return {
    async generate(request: ReviewModelRequest): Promise<ReviewModelResult> {
      const answer = handler(request)
      return { text: answer?.text ?? '', inputTokens: answer?.inputTokens ?? 0, outputTokens: answer?.outputTokens ?? 0 }
    },
  }
}

const PERMISSIVE_LAYERS: ReviewRuleLayer[] = [
  { source: 'system', defaultRule: 'baseline standard', entries: [] },
  { source: 'project', entries: [] },
]

describe('review target selection', () => {
  const entry = (overrides: Partial<ChangedFileEntry>): ChangedFileEntry => ({
    path: 'src/a.ts',
    status: 'modified',
    added: 1,
    deleted: 0,
    binary: false,
    sizeBytes: 100,
    untracked: false,
    ...overrides,
  })

  it('parses name-status rows, folding a rename into one entry', () => {
    const rows = parseNameStatus('M\tsrc/a.ts\nA\tsrc/b.ts\nD\tsrc/c.ts\nR100\tsrc/old.ts\tsrc/new.ts\n')
    expect(rows).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
      { path: 'src/c.ts', status: 'deleted' },
      { path: 'src/new.ts', status: 'renamed', oldPath: 'src/old.ts' },
    ])
  })

  it('reads numstat, treating a dash as binary rather than as zero', () => {
    const stats = parseNumstat('3\t2\tsrc/a.ts\n-\t-\tassets/logo.png\n')
    expect(stats.get('src/a.ts')).toEqual({ added: 3, deleted: 2, binary: false })
    expect(stats.get('assets/logo.png')).toEqual({ added: 0, deleted: 0, binary: true })
  })

  it('unquotes a non-ASCII path in name-status, so it names the same file the diff named', () => {
    // Measured against git 2.x: `--name-status` prints `"caf\303\251.ts"` for
    // `café.ts`, while the parsed `diff --git` header decodes to `café.ts`. Left
    // quoted, every lookup by path misses and the file is excluded as `unreadable`
    // — a review that reports nothing to review about a change set it cannot see.
    const rows = parseNameStatus('M\t"caf\\303\\251.ts"\nA\t"foo bar \\344\\270\\255\\346\\226\\207.ts"\nR100\t"\\344\\270\\255\\346\\226\\207.ts"\t"renamed-\\344\\270\\255\\346\\226\\207.ts"\n')
    expect(rows).toEqual([
      { path: 'café.ts', status: 'modified' },
      { path: 'foo bar 中文.ts', status: 'added' },
      { path: 'renamed-中文.ts', status: 'renamed', oldPath: '中文.ts' },
    ])
  })

  it('keys numstat by the new path of a rename, in both forms git prints', () => {
    // A rename is one column, not two: `old => new` for unrelated paths, and the
    // compact `dir/{old => new}.ts` when the affixes are shared. Joined against
    // name-status by the new path, an unresolved key drops exactly the rename rows.
    const stats = parseNumstat('2\t1\t"caf\\303\\251.ts"\n0\t0\t"\\344\\270\\255\\346\\226\\207.ts" => "renamed-\\344\\270\\255\\346\\226\\207.ts"\n4\t0\tdir/{old => new}.ts\n')
    expect(stats.get('café.ts')).toEqual({ added: 2, deleted: 1, binary: false })
    expect(stats.get('renamed-中文.ts')).toEqual({ added: 0, deleted: 0, binary: false })
    expect(stats.get('dir/new.ts')).toEqual({ added: 4, deleted: 0, binary: false })
  })

  it('reviews a change set whose only paths are non-ASCII', async () => {
    // The fixture is git's real output for a staged rename plus one new file with
    // a space and a Chinese name. Before the paths were decoded this resolved to
    // **zero** files to review and two exclusions reading `git produced no diff for
    // this path` — a clean report for a change set that had two changes in it.
    const target = await resolveReviewTarget(gitWith(args => {
      const line = args.join(' ')
      if (line.includes('rev-parse')) return { stdout: 'HEAD\n' }
      if (line.includes('--numstat')) return { stdout: '2\t0\t"foo bar \\344\\270\\255\\346\\226\\207.ts"\n0\t0\t"\\344\\270\\255\\346\\226\\207.ts" => "renamed-\\344\\270\\255\\346\\226\\207.ts"\n' }
      if (line.includes('--name-status')) return { stdout: 'A\t"foo bar \\344\\270\\255\\346\\226\\207.ts"\nR100\t"\\344\\270\\255\\346\\226\\207.ts"\t"renamed-\\344\\270\\255\\346\\226\\207.ts"\n' }
      // No untracked files: without this branch the fallback below answers
      // `ls-files` too, and every line of the diff is mistaken for a new file.
      if (line.includes('ls-files')) return { stdout: '' }
      return { stdout: `diff --git "a/foo bar \\344\\270\\255\\346\\226\\207.ts" "b/foo bar \\344\\270\\255\\346\\226\\207.ts"\nnew file mode 100644\n--- /dev/null\n+++ "b/foo bar \\344\\270\\255\\346\\226\\207.ts"\t\n@@ -0,0 +1,2 @@\n+with\n+space\ndiff --git "a/\\344\\270\\255\\346\\226\\207.ts" "b/renamed-\\344\\270\\255\\346\\226\\207.ts"\nsimilarity index 100%\nrename from "\\344\\270\\255\\346\\226\\207.ts"\nrename to "renamed-\\344\\270\\255\\346\\226\\207.ts"\n` }
    }), { mode: 'workspace', cwd: '/repo' })

    expect(target.excluded).toEqual([])
    expect(target.files.map(file => `${file.path}:${file.status}:${file.added}`)).toEqual([
      'foo bar 中文.ts:added:2',
      'renamed-中文.ts:renamed:0',
    ])
  })

  it('measures a diff in bytes, so a non-ASCII file is not judged at a third of its size', async () => {
    // The untracked half of the same ceiling is measured with `stat`, which counts
    // bytes; counting UTF-16 units on this half would mean the ceiling meant two
    // different things depending on whether a file was committed.
    const han = '中'.repeat(100)
    const target = await resolveReviewTarget(gitWith(args => {
      const line = args.join(' ')
      if (line.includes('rev-parse')) return { stdout: 'HEAD\n' }
      if (line.includes('--numstat')) return { stdout: `1\t0\tsrc/han.ts\n` }
      if (line.includes('--name-status')) return { stdout: 'M\tsrc/han.ts\n' }
      if (line.includes('ls-files')) return { stdout: '' }
      return { stdout: `diff --git a/src/han.ts b/src/han.ts\n--- a/src/han.ts\n+++ b/src/han.ts\n@@ -1,0 +2 @@\n+${han}\n` }
    }), { mode: 'workspace', cwd: '/repo' }, { maxFileBytes: 200 })

    expect(target.files).toEqual([])
    expect(target.excluded[0]?.reason).toBe('oversized')
    expect(target.excluded[0]?.detail).toContain('301 bytes')
  })

  it('selects a file and skips the rest with a reason each', () => {
    const digital = (path: string): DiffFile => ({ path, oldPath: path, newPath: path, status: 'modified', binary: false, added: 1, deleted: 0, hunks: [] })
    const selection = selectReviewableFiles(
      [
        entry({}),
        entry({ path: 'assets/logo.png', binary: true }),
        entry({ path: 'src/huge.ts', sizeBytes: 10_000 }),
        entry({ path: 'vendor/x.ts' }),
        entry({ path: 'src/nodiff.ts' }),
        entry({ path: 'src/kept.ts' }),
        entry({ path: 'src/limit.ts' }),
      ],
      new Map([
        ['src/a.ts', digital('src/a.ts')],
        ['src/kept.ts', digital('src/kept.ts')],
        ['src/limit.ts', digital('src/limit.ts')],
      ]),
      { exclude: ['**/vendor/**'], maxFileBytes: 5_000, maxFiles: 2 },
    )
    expect(selection.files.map(file => file.path)).toEqual(['src/a.ts', 'src/kept.ts'])
    expect(selection.excluded.map(item => `${item.path}:${item.reason}`)).toEqual([
      'assets/logo.png:binary',
      'src/huge.ts:oversized',
      'vendor/x.ts:excluded',
      'src/nodiff.ts:unreadable',
      'src/limit.ts:file-limit',
    ])
  })

  it('reports an excluded binary file as excluded, because that is the project decision', () => {
    const selection = selectReviewableFiles([entry({ path: 'vendor/x.ts', binary: true })], new Map(), { exclude: ['**/vendor/**'] })
    expect(selection.excluded[0]?.reason).toBe('excluded')
  })

  it('resolves a workspace target including untracked files', async () => {
    const target = await resolveReviewTarget(gitWith(args => {
      const line = args.join(' ')
      if (line.includes('ls-files')) return { stdout: 'src/untracked.ts\n' }
      if (line.includes('--numstat')) return { stdout: `${TWO_FILE_NUMSTAT}` }
      if (line.includes('--name-status')) return { stdout: TWO_FILE_NAME_STATUS }
      return { stdout: TWO_FILE_DIFF }
    }), { mode: 'workspace', cwd: '/repo' })

    expect(target.files.map(file => file.path)).toEqual(['src/a.ts', 'lib/b.ts', 'src/untracked.ts'])
    expect(target.files[2]?.untracked).toBe(true)
    expect(target.files[2]?.diff).toBeNull()
    expect(target.mergeBase).toBeUndefined()
  })

  it('diffs a range from the merge base rather than from the source ref', async () => {
    const target = await resolveReviewTarget(gitWith(args => {
      const line = args.join(' ')
      if (line.includes('merge-base')) return { stdout: 'abc123\n' }
      if (line.includes('--numstat')) return { stdout: TWO_FILE_NUMSTAT }
      if (line.includes('--name-status')) return { stdout: TWO_FILE_NAME_STATUS }
      if (line.includes('diff')) return { stdout: TWO_FILE_DIFF }
      return { stdout: '' }
    }), { mode: 'range', cwd: '/repo', from: 'main', to: 'feature' })

    expect(target.mergeBase).toBe('abc123')
    expect(target.to).toBe('feature')
  })

  it('uses the empty tree for a root commit that has no parent', async () => {
    let sawEmptyTree = false
    await resolveReviewTarget(gitWith(args => {
      const line = args.join(' ')
      if (line.includes('rev-parse')) return { exitCode: 1, stdout: '' }
      if (line.includes('diff')) {
        // diffArgs places the base ref after `diff`, `--find-renames`, and `--no-color`.
        if (args[3]?.startsWith('4b825dc')) sawEmptyTree = true
        return { stdout: TWO_FILE_DIFF }
      }
      return { stdout: '' }
    }), { mode: 'commit', cwd: '/repo', commit: 'deadbeef' })
    expect(sawEmptyTree).toBe(true)
  })

  it('refuses a range with no source ref and a commit review with no commit', async () => {
    const git = gitWith(() => ({ stdout: '' }))
    await expect(resolveReviewTarget(git, { mode: 'range', cwd: '/repo' })).rejects.toThrow(/from ref/)
    await expect(resolveReviewTarget(git, { mode: 'commit', cwd: '/repo' })).rejects.toThrow(/commit/)
  })

  it('asks ls-files for root-relative paths, and unquotes them', async () => {
    // Without `--full-name` git answers relative to the directory it was run in,
    // while the diff it is merged with is relative to the worktree root: the same
    // file would arrive under two names, and a rule pattern would match one of them.
    let lsFilesArgs: readonly string[] = []
    const target = await resolveReviewTarget(gitWith(args => {
      const line = args.join(' ')
      if (line.includes('ls-files')) {
        lsFilesArgs = args
        // A non-ASCII path, C-quoted by git exactly as it quotes one on the wire.
        return { stdout: 'plugin/packages/a.ts\n"plugin/packages/caf\\303\\251.ts"\n' }
      }
      if (line.includes('--numstat')) return { stdout: '' }
      if (line.includes('--name-status')) return { stdout: '' }
      return { stdout: '' }
    }), { mode: 'workspace', cwd: '/repo' })

    expect(lsFilesArgs).toContain('--full-name')
    expect(target.files.map(file => file.path)).toEqual(['plugin/packages/a.ts', 'plugin/packages/café.ts'])
  })

  it('reads an untracked file\'s size from the workspace it belongs to', async () => {
    // The size is what the oversized skip is judged on, and a size read from the
    // wrong directory comes back undefined and then zero — under every ceiling, so
    // the guard silently stops applying to exactly the files whose size is unknown.
    const seen: { path: string; cwd: string }[] = []
    const git: ReviewGitPort = {
      async run(args) {
        const line = args.join(' ')
        if (line.includes('ls-files')) return { exitCode: 0, stdout: 'src/big.ts\n', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      async readFileSize(path, cwd) {
        seen.push({ path, cwd })
        return 5_000_000
      },
    }
    const target = await resolveReviewTarget(git, { mode: 'workspace', cwd: 'E:/work/app' })
    expect(seen).toEqual([{ path: 'src/big.ts', cwd: 'E:/work/app' }])
    expect(target.files).toEqual([])
    expect(target.excluded[0]).toMatchObject({ path: 'src/big.ts', reason: 'oversized' })
  })

  it('reports a failed diff instead of reporting nothing to review', async () => {
    // The failure this rules out is the quietest one in the pipeline: a bad ref, a
    // workspace that is not a repository, or a diff past the output ceiling all
    // produced an empty `stdout`, and an empty change set reads exactly like a clean
    // one to whoever is told the review passed.
    const git = gitWith(args => args.join(' ').includes('--numstat')
      ? { exitCode: 0, stdout: '' }
      : { exitCode: 129, stdout: '', stderr: 'fatal: not a git repository' })
    await expect(resolveReviewTarget(git, { mode: 'workspace', cwd: '/not-a-repo' }))
      .rejects.toThrow('fatal: not a git repository')

    const numstatFails = gitWith(args => args.join(' ').includes('--numstat')
      ? { exitCode: 128, stdout: '', stderr: 'fatal: bad revision' }
      : { exitCode: 0, stdout: TWO_FILE_DIFF })
    await expect(resolveReviewTarget(numstatFails, { mode: 'workspace', cwd: '/repo' }))
      .rejects.toThrow('bad revision')
  })

  it('reports a failed untracked listing instead of silently seeing fewer files', async () => {
    const git = gitWith(args => args.join(' ').includes('ls-files')
      ? { exitCode: 128, stdout: '', stderr: 'fatal: index file corrupt' }
      : { exitCode: 0, stdout: '' })
    await expect(resolveReviewTarget(git, { mode: 'workspace', cwd: '/repo' }))
      .rejects.toThrow('index file corrupt')
  })

  it('reviews a repository with no commits at all', async () => {
    // `git diff HEAD` fails outright on an unborn HEAD, and its untracked files are
    // the entire change set — so the base becomes the empty tree, as it does for a
    // root commit, rather than the review failing on a repository it can see.
    let usedEmptyTree = false
    const target = await resolveReviewTarget(gitWith(args => {
      const line = args.join(' ')
      if (line.includes('rev-parse')) return { exitCode: 1, stdout: '' }
      if (line.includes('ls-files')) return { stdout: 'src/first.ts\n' }
      if (line.includes('diff')) {
        if (args[3]?.startsWith('4b825dc')) usedEmptyTree = true
        return { stdout: '' }
      }
      return { stdout: '' }
    }), { mode: 'workspace', cwd: '/fresh' })

    expect(usedEmptyTree).toBe(true)
    expect(target.files.map(file => file.path)).toEqual(['src/first.ts'])
  })

  it('refuses a ref that git would read as an option, before git is called at all', async () => {
    const calls: readonly string[][] = []
    const git = gitWith(args => { (calls as string[][]).push([...args]); return { stdout: '' } })
    await expect(resolveReviewTarget(git, { mode: 'range', cwd: '/repo', from: '--upload-pack=touch x' }))
      .rejects.toThrow('would be read as an option')
    await expect(resolveReviewTarget(git, { mode: 'commit', cwd: '/repo', commit: 'dead beef' }))
      .rejects.toThrow('contains whitespace')
    // The refusal has to happen before the funnel, not after it: a check that ran
    // once git had already been handed the argument would be reporting damage.
    expect(calls).toEqual([])
  })
})

describe('review grouping', () => {
  const file = (path: string, added = 1) => ({
    path, status: 'modified' as const, added, deleted: 0, untracked: false,
    diff: parseUnifiedDiff(TWO_FILE_DIFF)[0] as DiffFile,
  })

  it('accepts a complete proposal and rejects every way it can be malformed', () => {
    expect(validateGrouping([[0], [1]], 2)).toEqual({ ok: true, indices: [[0], [1]] })
    expect(validateGrouping([{ files: [0, 1] }], 2).ok).toBe(true)
    expect(validateGrouping([[0]], 2).ok).toBe(false)
    expect(validateGrouping([[0], [0]], 2).ok).toBe(false)
    expect(validateGrouping([[0], [5]], 2).ok).toBe(false)
    expect(validateGrouping([[]], 0).ok).toBe(false)
    expect(validateGrouping([[0, 1, 2]], 3, 2).ok).toBe(false)
    expect(validateGrouping('nonsense', 1).ok).toBe(false)
  })

  it('falls back deterministically by directory, then rule group', () => {
    const groups = fallbackGrouping([file('src/a.ts'), file('src/b.ts'), file('lib/c.ts')], [])
    expect(groups.map(group => group.files.map(entry => entry.path))).toEqual([['src/a.ts', 'src/b.ts'], ['lib/c.ts']])
    expect(groups.map(group => group.id)).toEqual([1, 2])
  })

  it('uses the model grouping when it validates and records the cost', async () => {
    const model = modelWith(() => ({ text: '[[1],[0]]', inputTokens: 10, outputTokens: 5 }))
    const files = [file('src/a.ts'), file('lib/b.ts')]
    const { grouped, spent } = await groupChanges(model, files, groupByRule(createReviewRuleResolver(PERMISSIVE_LAYERS), files.map(f => f.path)))
    expect(grouped.source).toBe('model')
    expect(grouped.groups[0]?.files.map(entry => entry.path)).toEqual(['lib/b.ts'])
    expect(spent).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('rejects an invalid proposal in favour of the fallback, without throwing', async () => {
    const files = [file('src/a.ts'), file('lib/b.ts')]
    const { grouped } = await groupChanges(modelWith(() => ({ text: '[[0, 0]]' })), files, [])
    expect(grouped.source).toBe('fallback')
    expect(grouped.note).toContain('rejected')
  })

  it('survives a model failure by falling back', async () => {
    const files = [file('src/a.ts'), file('lib/b.ts')]
    const model: ReviewModelPort = { async generate() { throw new Error('route missing') } }
    const { grouped } = await groupChanges(model, files, [])
    expect(grouped.source).toBe('fallback')
    expect(grouped.note).toContain('route missing')
  })
})

describe('review planning', () => {
  const group = (files: { path: string; added: number }[], changedLines: number) => ({
    id: 1,
    files: files.map(file => ({
      path: file.path, status: 'modified' as const, added: file.added, deleted: 0,
      untracked: false, diff: null,
    })),
    ruleGroupIds: [],
    changedLines,
  })

  it('triggers on one large file or on a large multi-file batch', () => {
    expect(shouldPlan(group([{ path: 'a.ts', added: 50 }], 50))).toBe(true)
    expect(shouldPlan(group([{ path: 'a.ts', added: 49 }], 49))).toBe(false)
    expect(shouldPlan(group([{ path: 'a.ts', added: 10 }, { path: 'b.ts', added: 10 }], 100))).toBe(true)
    expect(shouldPlan(group([{ path: 'a.ts', added: 10 }, { path: 'b.ts', added: 10 }], 99))).toBe(false)
  })

  it('parses the plan, sorts by severity, and reads the arrow lines', () => {
    const plan = parseReviewPlan(`Summary: adds a cache layer

Issues

1. [low] naming could be clearer
2. [high] the cache key omits the tenant, so tenants can read each other's entries
   → read src/cache.ts — confirm the key construction
   → engineering_codegraph_affected cacheKey — find the call sites
3. [medium] the TTL is not configurable
`)
    expect(plan.summary).toBe('adds a cache layer')
    expect(plan.issues.map(issue => issue.severity)).toEqual(['high', 'medium', 'low'])
    expect(plan.issues[0]?.suggestions).toEqual([
      { tool: 'read', args: 'src/cache.ts', purpose: 'confirm the key construction' },
      { tool: 'engineering_codegraph_affected', args: 'cacheKey', purpose: 'find the call sites' },
    ])
  })

  it('recognizes the none sentinel as a real answer rather than a parse failure', () => {
    expect(parseReviewPlan('Summary: trivial\n\nIssues\n\n(none)\n')).toEqual({ summary: 'trivial', issues: [] })
  })

  it('skips a batch below the threshold without calling the model', async () => {
    const { outcome, spent } = await planGroup(modelWith(() => ({ text: 'unused' })), group([{ path: 'a.ts', added: 1 }], 1), [])
    expect(outcome.kind).toBe('skipped')
    expect(spent).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('reports an unreadable plan as unavailable rather than as no risks', async () => {
    const model = modelWith(() => ({ text: 'I could not analyze this diff.' }))
    const { outcome } = await planGroup(model, group([{ path: 'a.ts', added: 60 }], 60), [])
    expect(outcome.kind).toBe('unavailable')
  })

  it('reports an empty planning response as unavailable, not as a plan with no risks', async () => {
    // The clearest case of "the answer could not be read", and the one an emptiness
    // test on the *parsed* plan misses: parsing nothing yields an empty plan, and an
    // empty plan tells the reviewer that no risks were identified.
    const model = modelWith(() => ({ text: '' }))
    const { outcome } = await planGroup(model, group([{ path: 'a.ts', added: 60 }], 60), [])
    expect(outcome).toMatchObject({ kind: 'unavailable' })
    expect((outcome as { reason: string }).reason).toContain('empty')
  })

  it('keeps the none sentinel an answer even without a summary line', async () => {
    // The sentinel is how the prompt spells "I looked and there is nothing", so a
    // refusal on emptiness must not swallow it — that would turn honesty into a
    // planning failure and cost a second attempt for the same answer.
    const model = modelWith(() => ({ text: 'Issues\n\n(none)\n' }))
    const { outcome } = await planGroup(model, group([{ path: 'a.ts', added: 60 }], 60), [])
    expect(outcome).toMatchObject({ kind: 'planned', plan: { issues: [] } })
  })

  it('reports a planning failure as unavailable and never throws', async () => {
    const model: ReviewModelPort = { async generate() { throw new Error('timeout') } }
    const { outcome } = await planGroup(model, group([{ path: 'a.ts', added: 60 }], 60), [])
    expect(outcome).toMatchObject({ kind: 'unavailable' })
  })
})

describe('review post-filter', () => {
  const comment = (id: string): ReviewComment => ({
    id, path: 'src/a.ts', content: 'finding', startLine: 1, endLine: 1,
    category: 'bug', severity: 'high', state: 'proposed',
  })

  it('keeps everything when the filter call fails, and says so', async () => {
    const model: ReviewModelPort = { async generate() { throw new Error('route missing') } }
    const outcome = await filterComments(model, [comment('c1'), comment('c2')], 'diff')
    expect(outcome.kept.map(item => item.id)).toEqual(['c1', 'c2'])
    expect(outcome.removed).toEqual([])
    expect(outcome.failedOpen).toBe(true)
    expect(outcome.reason).toContain('route missing')
  })

  it('keeps everything when the response cannot be read', async () => {
    const outcome = await filterComments(modelWith(() => ({ text: 'no json here' })), [comment('c1')], 'diff')
    expect(outcome.failedOpen).toBe(true)
    expect(outcome.kept).toHaveLength(1)
  })

  it('removes only what a verdict disproves, recording the reason', async () => {
    const model = modelWith(() => ({ text: '{"verdicts":[{"id":"c1","approve":false,"reason":"the guard already exists"}]}' }))
    const outcome = await filterComments(model, [comment('c1'), comment('c2')], 'diff')
    expect(outcome.kept.map(item => item.id)).toEqual(['c2'])
    expect(outcome.removed[0]).toMatchObject({ id: 'c1', state: 'filtered', filteredReason: 'the guard already exists' })
  })

  it('treats a removal with no stated evidence as an approval', () => {
    const outcome = applyFilterVerdicts([comment('c1')], parseFilterVerdicts({ verdicts: [{ id: 'c1', approve: false }] }))
    expect(outcome.kept.map(item => item.id)).toEqual(['c1'])
    expect(outcome.removed).toEqual([])
  })

  it('drops a verdict with no id rather than guessing which comment it meant', () => {
    expect(parseFilterVerdicts({ verdicts: [{ approve: false, reason: 'x' }] })).toEqual([])
  })

  it('ignores a verdict naming an id that does not exist and keeps an unjudged comment', () => {
    const outcome = applyFilterVerdicts(
      [comment('c1'), comment('c2')],
      parseFilterVerdicts([{ id: 'nope', approve: false, reason: 'x' }, { id: 'c1', approve: false, reason: 'disproven' }]),
    )
    expect(outcome.kept.map(item => item.id)).toEqual(['c2'])
    expect(outcome.removed.map(item => item.id)).toEqual(['c1'])
  })
})

describe('review reviewer', () => {
  it('labels neighbour files as reference and marks untracked files', () => {
    const diff = parseUnifiedDiff(SINGLE_DIFF)[0] as DiffFile
    const task = {
      group: {
        id: 1,
        files: [
          { path: 'src/app.ts', status: 'modified' as const, added: 3, deleted: 1, untracked: false, diff },
          { path: 'src/other.ts', status: 'added' as const, added: 1, deleted: 0, untracked: true, diff: null },
        ],
        ruleGroupIds: [1],
        changedLines: 4,
      },
      file: { path: 'src/app.ts', status: 'modified' as const, added: 3, deleted: 1, untracked: false, diff },
      rule: { source: 'project', pattern: '**/*.ts', text: 'check nulls' },
      reviewer: 'reviewer-1',
    }
    const prompt = buildFileReviewPrompt(task)
    expect(prompt.system).toContain('code review assistant')
    expect(prompt.user).toContain('<review_rule source="project" pattern="**/*.ts">')
    expect(prompt.user).toContain('Do not report findings against them.')
    expect(prompt.user).toContain('<review_files>')
    expect(prompt.user).toContain('@@ -1,3 +1,5 @@')
    expect(prompt.user).toContain('"comments"')
  })

  it('reads comments in either case convention', () => {
    expect(parseFileComments({ comments: [{ path: 'a.ts', content: 'x', start_line: 2, end_line: 2, existing_code: 'y' }] }))
      .toEqual([{ path: 'a.ts', content: 'x', startLine: 2, endLine: 2, category: undefined, severity: undefined, suggestionCode: undefined, existingCode: 'y' }])
  })

  it('reports an unreadable reviewer response as an empty review with a note', async () => {
    const reviewer = createModelFileReviewer(modelWith(() => ({ text: 'I looked at it.' })))
    const diff = parseUnifiedDiff(SINGLE_DIFF)[0] as DiffFile
    const outcome = await reviewer.review({
      group: { id: 1, files: [], ruleGroupIds: [], changedLines: 0 },
      file: { path: 'src/app.ts', status: 'modified', added: 3, deleted: 1, untracked: false, diff },
      rule: { source: 'system', pattern: 'default', text: '' },
      reviewer: 'reviewer-1',
    })
    expect(outcome.comments).toEqual([])
    expect(outcome.note).toContain('no readable comments')
  })
})

describe('review engine end to end', () => {
  const resolver = () => createReviewRuleResolver(PERMISSIVE_LAYERS)

  const workspaceGit = (diff: string, nameStatus: string, numstat: string) => gitWith(args => {
    const line = args.join(' ')
    if (line.includes('ls-files')) return { stdout: '' }
    if (line.includes('--numstat')) return { stdout: numstat }
    if (line.includes('--name-status')) return { stdout: nameStatus }
    return { stdout: diff }
  })

  it('runs a single-file workspace review and publishes a completed report', async () => {
    const reviewer = {
      async review() {
        return {
          comments: [
            { path: 'src/app.ts', content: 'the fallback drops the tenant', startLine: 3, endLine: 3, severity: 'high', category: 'bug' },
            { path: 'src/app.ts', content: '   ' },
          ],
          spent: { inputTokens: 100, outputTokens: 50 },
        }
      },
    }
    const result = await runReview(
      {
        git: workspaceGit(SINGLE_DIFF, 'M\tsrc/app.ts\n', '3\t1\tsrc/app.ts\n'),
        model: modelWith(() => ({ text: '{"verdicts":[]}' })),
        reviewer,
        rules: resolver(),
        now: () => 1_700_000_000_000,
        newId: () => 'run-1',
      },
      { request: { mode: 'workspace', cwd: '/repo' }, reviewerName: 'reviewer-1', modelName: 'test-model' },
    )

    expect(result.report.state).toBe('completed')
    expect(result.report.coverage).toMatchObject({ totalFiles: 1, reviewedFiles: 1, coverageRate: 1 })
    expect(result.report.comments).toHaveLength(1)
    expect(result.refused).toEqual([{ path: 'src/app.ts', reason: 'content is required and must be a non-empty string' }])
    expect(result.report.budget.spentTotal).toBe(150)
    expect(result.attribution).toContain('Apache-2.0')
  })

  it('stops dispatching groups once the run budget is gone, and reports the rest as failed', async () => {
    const reviewer = {
      async review() {
        return { comments: [], spent: { inputTokens: 100, outputTokens: 100 } }
      },
    }
    const result = await runReview(
      {
        git: workspaceGit(TWO_FILE_DIFF, TWO_FILE_NAME_STATUS, TWO_FILE_NUMSTAT),
        model: modelWith(() => ({ text: '[[0],[1]]', inputTokens: 5, outputTokens: 5 })),
        reviewer,
        rules: resolver(),
        newId: () => 'run-2',
      },
      {
        request: { mode: 'workspace', cwd: '/repo' },
        budget: { maxGroupTokens: 10_000, maxTotalTokens: 50 },
      },
    )

    expect(result.report.state).toBe('partial')
    expect(result.report.coverage).toMatchObject({ reviewedFiles: 1, failedFiles: 1 })
    expect(result.report.files.find(file => file.state === 'failed')?.reason).toContain('budget exhausted')
    expect(result.report.budget.exhausted).toBe(true)
  })

  it('marks a file failed when its reviewer rejects, without failing the run', async () => {
    const result = await runReview(
      {
        git: workspaceGit(SINGLE_DIFF, 'M\tsrc/app.ts\n', '3\t1\tsrc/app.ts\n'),
        model: modelWith(() => ({ text: '{"verdicts":[]}' })),
        reviewer: { async review() { throw new Error('provider 500') } },
        rules: resolver(),
        newId: () => 'run-3',
      },
      { request: { mode: 'workspace', cwd: '/repo' } },
    )
    expect(result.report.state).toBe('failed')
    expect(result.report.files[0]?.reason).toContain('provider 500')
  })

  it('classifies a rule-excluded file as skipped, naming the layer', async () => {
    const rules = createReviewRuleResolver([
      { source: 'system', defaultRule: 'baseline', entries: [] },
      { source: 'custom', entries: [], exclude: ['**/app.ts'] },
    ])
    const result = await runReview(
      {
        git: workspaceGit(SINGLE_DIFF, 'M\tsrc/app.ts\n', '3\t1\tsrc/app.ts\n'),
        model: modelWith(() => ({ text: '{"verdicts":[]}' })),
        reviewer: { async review() { throw new Error('must not be called') } },
        rules,
        newId: () => 'run-4',
      },
      { request: { mode: 'workspace', cwd: '/repo' } },
    )
    expect(result.report.coverage).toMatchObject({ totalFiles: 1, skippedFiles: 1, reviewedFiles: 0 })
    expect(result.report.files[0]?.reason).toContain('excluded by the custom rule layer')
  })

  it('relocates a mis-numbered finding onto the line its quoted code occupies', async () => {
    const reviewer = {
      async review() {
        return {
          comments: [{ path: 'src/app.ts', content: 'this branch cannot be reached', startLine: 99, endLine: 99, existingCode: 'const c = 4' }],
          spent: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const result = await runReview(
      {
        git: workspaceGit(SINGLE_DIFF, 'M\tsrc/app.ts\n', '3\t1\tsrc/app.ts\n'),
        model: modelWith(() => ({ text: '{"verdicts":[]}' })),
        reviewer,
        rules: resolver(),
        newId: () => 'run-5',
      },
      { request: { mode: 'workspace', cwd: '/repo' } },
    )
    expect(result.report.comments[0]?.startLine).toBe(3)
  })

  it('records a rejected grouping as a note and still reviews every file', async () => {
    const result = await runReview(
      {
        git: workspaceGit(TWO_FILE_DIFF, TWO_FILE_NAME_STATUS, TWO_FILE_NUMSTAT),
        model: modelWith(request => request.system.startsWith('You are a file grouping assistant')
          ? { text: '[[0,0]]' }
          : { text: '{"verdicts":[]}' }),
        reviewer: { async review() { return { comments: [], spent: { inputTokens: 0, outputTokens: 0 } } } },
        rules: resolver(),
        newId: () => 'run-6',
      },
      { request: { mode: 'workspace', cwd: '/repo' } },
    )
    expect(result.notes.some(note => note.includes('rejected'))).toBe(true)
    expect(result.report.coverage.reviewedFiles).toBe(2)
  })

  it('keeps a finding that names a file outside the change set, and says its line is unverified', async () => {
    // A reviewer that names a file nobody handed it has said something the report
    // cannot place: the finding is kept — it may be real — but no line of it was
    // checked against any diff, and a reader has to be able to tell those apart from
    // the findings that were.
    const reviewer = {
      async review() {
        return {
          comments: [{ path: 'docs/notes.md', content: 'this doc contradicts the code', startLine: 12, endLine: 12, severity: 'medium', category: 'documentation' }],
          spent: { inputTokens: 1, outputTokens: 1 },
        }
      },
    }
    const result = await runReview(
      {
        git: workspaceGit(SINGLE_DIFF, 'M\tsrc/app.ts\n', '3\t1\tsrc/app.ts\n'),
        model: modelWith(() => ({ text: '{"verdicts":[]}' })),
        reviewer,
        rules: resolver(),
        newId: () => 'run-8',
      },
      { request: { mode: 'workspace', cwd: '/repo' } },
    )
    expect(result.report.comments).toHaveLength(1)
    expect(result.report.comments[0]?.startLine).toBe(12)
    expect(result.notes.some(note => note.includes('outside this run\'s change set') && note.includes('docs/notes.md'))).toBe(true)
  })

  it('says nothing about unattributed findings when every finding is in the change set', async () => {
    // The note is a claim about *this* run, so it must not appear as boilerplate.
    const result = await runReview(
      {
        git: workspaceGit(SINGLE_DIFF, 'M\tsrc/app.ts\n', '3\t1\tsrc/app.ts\n'),
        model: modelWith(() => ({ text: '{"verdicts":[]}' })),
        reviewer: { async review() { return { comments: [{ path: 'src/app.ts', content: 'ok finding', startLine: 3, endLine: 3 }], spent: { inputTokens: 0, outputTokens: 0 } } } },
        rules: resolver(),
        newId: () => 'run-9',
      },
      { request: { mode: 'workspace', cwd: '/repo' } },
    )
    expect(result.notes.some(note => note.includes('outside this run\'s change set'))).toBe(false)
  })

  it('reviews nothing and completes when the change set is empty', async () => {
    const result = await runReview(
      {
        git: workspaceGit('', '', ''),
        model: modelWith(() => ({ text: '{}' })),
        reviewer: { async review() { throw new Error('must not be called') } },
        rules: resolver(),
        newId: () => 'run-7',
      },
      { request: { mode: 'workspace', cwd: '/repo' } },
    )
    expect(result.report.state).toBe('completed')
    expect(result.report.coverage).toMatchObject({ totalFiles: 0, coverageRate: 0 })
  })
})
