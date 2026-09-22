import { describe, expect, it } from 'vitest'
import { clearGlobCache, expandBraces, globToRegExp, matchAnyGlob, matchesGlob } from '../src/review/glob.ts'
import { addedLineNumbers, isLineInNewSide, parseHunkHeader, parseQuotedPath, parseUnifiedDiff } from '../src/review/diff.ts'
import { compareComments, validateReviewComment, type ReviewComment } from '../src/review/comments.ts'
import {
  createReviewRuleResolver,
  groupByRule,
  parseReviewRuleDocument,
  SYSTEM_REVIEW_RULE,
  type ReviewRuleLayer,
} from '../src/review/rules.ts'
import { relocateComment, translateOldToNew } from '../src/review/relocate.ts'
import { admitGroup, admitRound, consumeFinalRound, createBudgetState, DEFAULT_REVIEW_BUDGET, isBudgetExhausted, recordSpend, summarizeBudget } from '../src/review/budget.ts'
import { missingReasons, summarizeCoverage, unaccountedFiles, type ReviewFileOutcome } from '../src/review/coverage.ts'
import { assembleReviewReport, renderReviewJson, renderReviewSarif, renderReviewText } from '../src/review/report.ts'

const APP_DIFF = `diff --git a/src/app.ts b/src/app.ts
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
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1
+export const y = 2
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const z = 3
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 95%
rename from src/old-name.ts
rename to src/new-name.ts
diff --git a/assets/logo.png b/assets/logo.png
index 5555555..6666666 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`

const QUOTED_NON_ASCII_DIFF = `diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
index 1..2 100644
--- "a/src/caf\\303\\251.ts"
+++ "b/src/caf\\303\\251.ts"
@@ -1 +1 @@
-old
+new
`

const QUOTED_DIFF = `diff --git "a/dir/my file.ts" "b/dir/my file.ts"
index 1..2 100644
--- "a/dir/my file.ts"
+++ "b/dir/my file.ts"
@@ -1 +1 @@
-old
+new
`

const DUPLICATE_DIFF = `diff --git a/src/dup.ts b/src/dup.ts
index 1..2 100644
--- a/src/dup.ts
+++ b/src/dup.ts
@@ -0,0 +1,2 @@
+return null
+return null
`

const MIXED_DIFF = `diff --git a/src/shrunk.ts b/src/shrunk.ts
index 1..2 100644
--- a/src/shrunk.ts
+++ b/src/shrunk.ts
@@ -10,4 +10,3 @@
 context one
-removed one
-removed two
+added line
 context two
`

const NO_NEWLINE_DIFF = `diff --git a/src/eof.ts b/src/eof.ts
index 1..2 100644
--- a/src/eof.ts
+++ b/src/eof.ts
@@ -1 +1 @@
-const a = 1
+const a = 2
\\ No newline at end of file
`

describe('review glob', () => {
  it('matches a double star across separators and a single star within one', () => {
    expect(matchesGlob('**/*.java', 'src/main/Foo.java')).toBe(true)
    expect(matchesGlob('**/*.java', 'Foo.java')).toBe(true)
    expect(matchesGlob('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(matchesGlob('src/*.ts', 'src/b.ts')).toBe(true)
  })

  it('matches a pattern without a separator at any depth', () => {
    expect(matchesGlob('*.java', 'Foo.java')).toBe(true)
    expect(matchesGlob('*.java', 'deep/nested/Foo.java')).toBe(true)
    expect(matchesGlob('*.java', 'deep/nested/Foo.kt')).toBe(false)
  })

  it('treats an interior double star as an optional directory run', () => {
    expect(matchesGlob('a/**/b', 'a/b')).toBe(true)
    expect(matchesGlob('a/**/b', 'a/x/y/b')).toBe(true)
    expect(matchesGlob('a/**/b', 'a/x/y/c')).toBe(false)
  })

  it('matches everything below a trailing double star, including nothing below it', () => {
    expect(matchesGlob('src/**', 'src')).toBe(true)
    expect(matchesGlob('src/**', 'src/a/b.ts')).toBe(true)
    expect(matchesGlob('src/**', 'other/a.ts')).toBe(false)
  })

  it('does not let a single-character wildcard cross a separator', () => {
    expect(matchesGlob('src/?.ts', 'src/a.ts')).toBe(true)
    expect(matchesGlob('src/?.ts', 'src/ab.ts')).toBe(false)
  })

  it('supports a negated character class and an unterminated bracket', () => {
    expect(matchesGlob('a[!0-9].ts', 'ax.ts')).toBe(true)
    expect(matchesGlob('a[!0-9].ts', 'a1.ts')).toBe(false)
    expect(matchesGlob('a[.ts', 'a[.ts')).toBe(true)
  })

  it('normalizes separators so a Windows-authored pattern still applies', () => {
    expect(matchesGlob('src\\**\\*.ts', 'src/a/b.ts')).toBe(true)
    expect(matchesGlob('./src/*.ts', 'src/a.ts')).toBe(true)
  })

  it('anchors the whole path rather than matching a substring', () => {
    expect(matchesGlob('src/a.ts', 'src/a.tsx')).toBe(false)
    expect(matchesGlob('src/a.ts', 'prefix/src/a.ts')).toBe(false)
  })

  it('escapes regex metacharacters in a literal pattern', () => {
    clearGlobCache()
    expect(globToRegExp('a+b.ts').test('a+b.ts')).toBe(true)
    expect(globToRegExp('a+b.ts').test('aab.ts')).toBe(false)
  })

  it('matches a path against any of several patterns', () => {
    expect(matchAnyGlob(['**/*.ts', '**/*.md'], 'a/b.md')).toBe(true)
    expect(matchAnyGlob(['**/*.ts'], 'a/b.md')).toBe(false)
    expect(matchAnyGlob([], 'a/b.md')).toBe(false)
  })
})

describe('review glob brace lists', () => {
  it('expands a brace list the way upstream\'s rule reader does', () => {
    expect(expandBraces('*.java')).toEqual(['*.java'])
    expect(expandBraces('*.{go,py}')).toEqual(['*.go', '*.py'])
    expect(expandBraces('**/*.{ts,js,tsx,jsx}')).toEqual(['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx'])
    // An unclosed brace is a literal brace, which is upstream's behavior too.
    expect(expandBraces('*.{go,py')).toEqual(['*.{go,py'])
  })

  it('makes a brace list a list of patterns, in entries and in exclude filters alike', () => {
    // The pattern a project writes for generated files. Without expansion it matches
    // a file literally named `a.{gen,min}.ts`, which is to say nothing at all — and
    // the exclusion would silently not happen.
    expect(matchesGlob('**/*.{gen,min}.ts', 'src/a.gen.ts')).toBe(true)
    expect(matchesGlob('**/*.{gen,min}.ts', 'src/a.min.ts')).toBe(true)
    expect(matchesGlob('**/*.{gen,min}.ts', 'src/a.ts')).toBe(false)
    expect(matchAnyGlob(['**/*.{gen,min}.ts'], 'src/a.min.ts')).toBe(true)
    // A bare brace list still matches at any depth, exactly as the bare name does.
    expect(matchesGlob('*.{gen,min}.ts', 'deep/dir/a.gen.ts')).toBe(true)
  })

  it('expands every group, not only the first', () => {
    // Upstream expands one group, leaving `{ts,tsx}` in the result to match
    // literally — so this pattern, which every test runner user writes, would keep
    // the files it names. Both axes are meant, so both are expanded.
    expect(matchesGlob('**/*.{test,spec}.{ts,tsx}', 'src/a.test.ts')).toBe(true)
    expect(matchesGlob('**/*.{test,spec}.{ts,tsx}', 'src/a.spec.tsx')).toBe(true)
    expect(matchesGlob('**/*.{test,spec}.{ts,tsx}', 'src/a.test.js')).toBe(false)
    expect(expandBraces('x{a,b}y{c,d}z')).toEqual(['xaycz', 'xaydz', 'xbycz', 'xbydz'])
  })

  it('keeps a one-option group literal, and a nested group whole', () => {
    // `{b}` is not a choice. Upstream rewrites it to `ab.ts`, which silently changes
    // what the pattern names; a literal brace file is the more useful reading.
    expect(expandBraces('a{b}.ts')).toEqual(['a{b}.ts'])
    expect(matchesGlob('a{b}.ts', 'a{b}.ts')).toBe(true)
    expect(matchesGlob('a{b}.ts', 'ab.ts')).toBe(false)
    // A nested group belongs to the group containing it.
    expect(expandBraces('x{a,{b,c}}y')).toEqual(['xay', 'xby', 'xcy'])
    expect(matchesGlob('x{a,{b,c}}y', 'xcy')).toBe(true)
  })

  it('uses a pattern needing more expansions than the ceiling as written', () => {
    // All or nothing: a partially expanded list would remove some of the files the
    // project asked it to remove and say nothing about the rest.
    const huge = '{a,b}'.repeat(12)
    expect(expandBraces(huge)).toEqual([huge])
    expect(matchesGlob(huge, 'aaaaaaaaaaaa')).toBe(false)
    // One below the ceiling still expands, so the ceiling is not a blanket refusal.
    expect(expandBraces('{a,b}'.repeat(4))).toHaveLength(16)
  })

  it('applies a brace list in a rule-document entry, not only in an exclude filter', () => {
    const resolver = createReviewRuleResolver([
      { source: 'project', entries: [{ path: 'src/**/*.{ts,tsx}', rule: 'typed only', mergeSystemRule: false }], exclude: [] },
      { source: 'system', defaultRule: SYSTEM_REVIEW_RULE, entries: [] },
    ])
    expect(resolver.resolve('src/a.tsx')).toMatchObject({ source: 'project', rule: 'typed only', pattern: 'src/**/*.{ts,tsx}' })
    expect(resolver.resolve('src/a.js')).toMatchObject({ source: 'system' })
  })
})

describe('review diff parsing', () => {
  const files = parseUnifiedDiff(APP_DIFF)

  it('reads one entry per changed file, in order', () => {
    expect(files.map(file => file.path)).toEqual([
      'src/app.ts',
      'src/new.ts',
      'src/gone.ts',
      'src/new-name.ts',
      'assets/logo.png',
    ])
  })

  it('classifies added, modified, deleted, renamed, and binary files', () => {
    expect(files.map(file => file.status)).toEqual(['modified', 'added', 'deleted', 'renamed', 'modified'])
    expect(files[4]?.binary).toBe(true)
  })

  it('counts added and deleted lines from the hunks', () => {
    expect({ added: files[0]?.added, deleted: files[0]?.deleted }).toEqual({ added: 3, deleted: 1 })
    expect({ added: files[1]?.added, deleted: files[1]?.deleted }).toEqual({ added: 2, deleted: 0 })
    expect({ added: files[2]?.added, deleted: files[2]?.deleted }).toEqual({ added: 0, deleted: 1 })
  })

  it('keeps a rename as a move rather than a delete plus an add', () => {
    expect(files[3]?.oldPath).toBe('src/old-name.ts')
    expect(files[3]?.newPath).toBe('src/new-name.ts')
    expect(files[3]?.hunks).toHaveLength(0)
  })

  it('leaves a binary file with no hunks so zero hunks cannot read as unchanged', () => {
    expect(files[4]?.hunks).toHaveLength(0)
    expect(files[4]?.binary).toBe(true)
  })

  it('parses the single-line hunk shorthand', () => {
    expect(parseHunkHeader('@@ -1 +1 @@')).toEqual({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 })
    expect(parseHunkHeader('nonsense')).toBeNull()
  })

  it('honors quoted paths holding a space', () => {
    const quoted = parseUnifiedDiff(QUOTED_DIFF)
    expect(quoted[0]?.path).toBe('dir/my file.ts')
    expect(quoted[0]?.hunks[0]?.lines.map(line => line.kind)).toEqual(['-', '+'])
  })

  it('reads a non-ASCII path out of git\'s octal byte escapes', () => {
    // git quotes a non-ASCII path one *byte* at a time: `café.ts` is
    // `caf\303\251.ts` and a Han character is three escapes. Decoding each escape
    // on its own produced `caf303251.ts` — a path matching no file, no rule
    // pattern and no diff entry, in any repository whose filenames are not ASCII.
    expect(parseQuotedPath('"caf\\303\\251.ts"')).toBe('café.ts')
    expect(parseQuotedPath('"\\344\\270\\255\\346\\226\\207.ts"')).toBe('中文.ts')
    // Two characters, so the byte run spans escapes that a per-escape decoder
    // would have split into two broken halves.
    expect(parseQuotedPath('"\\303\\251\\303\\251.ts"')).toBe('éé.ts')
    // A short run is legal: an ASCII byte is one octal escape.
    expect(parseQuotedPath('"\\101.ts"')).toBe('A.ts')
    // A lone continuation byte is not a character at all — git only writes one
    // when the path itself holds an undecodable byte, and saying so with the
    // replacement character is the most a byte-level decoder can honestly say.
    expect(parseQuotedPath('"a\\303b.ts"')).toBe('a\ufffdb.ts')
    // A plain escape beside a byte run must still decode, in order.
    expect(parseQuotedPath('"tab\\t\\303\\251.ts"')).toBe('tab\té.ts')

    const parsed = parseUnifiedDiff(QUOTED_NON_ASCII_DIFF)
    expect(parsed[0]?.path).toBe('src/café.ts')
    expect(parsed[0]?.oldPath).toBe('src/café.ts')
    expect(parsed[0]?.hunks[0]?.lines.map(line => line.text)).toEqual(['old', 'new'])
  })

  it('records the no-newline marker on the line it belongs to', () => {
    const eof = parseUnifiedDiff(NO_NEWLINE_DIFF)
    expect(eof[0]?.hunks[0]?.lines[1]?.noNewline).toBe(true)
  })

  it('resolves new-file coordinates for added lines and coverage', () => {
    const app = files[0]!
    expect([...addedLineNumbers(app)].sort((a, b) => a - b)).toEqual([2, 3, 4])
    expect(isLineInNewSide(app, 1)).toBe(true)
    expect(isLineInNewSide(app, 5)).toBe(true)
    expect(isLineInNewSide(app, 6)).toBe(false)
  })

  it('translates an old-side line through the hunk body, refusing a deleted one', () => {
    const app = files[0]!
    expect(translateOldToNew(app, 1)).toBe(1)
    expect(translateOldToNew(app, 3)).toBe(5)
    expect(translateOldToNew(app, 2)).toBeUndefined()
  })
})

describe('review comment validation', () => {
  const id = 'c1'

  it('accepts a positioned finding and normalizes its path', () => {
    const verdict = validateReviewComment({ path: './src\\a.ts', content: 'broken', startLine: 4, endLine: 4 }, id)
    expect(verdict.ok && verdict.comment.path).toBe('src/a.ts')
  })

  it('refuses a missing path or empty content rather than dropping it', () => {
    expect(validateReviewComment({ path: '', content: 'x' }, id)).toMatchObject({ ok: false })
    expect(validateReviewComment({ path: 'a.ts', content: '   ' }, id)).toMatchObject({ ok: false })
  })

  it('treats omitted line numbers as unpositioned rather than as an error', () => {
    const verdict = validateReviewComment({ path: 'a.ts', content: 'x' }, id)
    expect(verdict.ok && [verdict.comment.startLine, verdict.comment.endLine]).toEqual([0, 0])
  })

  it('refuses an impossible line range', () => {
    expect(validateReviewComment({ path: 'a.ts', content: 'x', startLine: 5, endLine: 2 }, id).ok).toBe(false)
    expect(validateReviewComment({ path: 'a.ts', content: 'x', startLine: 0, endLine: 3 }, id).ok).toBe(false)
  })

  it('keeps an unpositioned finding, which is a legitimate outcome', () => {
    const verdict = validateReviewComment({ path: 'a.ts', content: 'suspect', startLine: 0, endLine: 0 }, id)
    expect(verdict.ok && verdict.comment.startLine).toBe(0)
  })

  it('defaults unknown taxonomy values instead of inventing a new one', () => {
    const verdict = validateReviewComment({ path: 'a.ts', content: 'x', severity: 'catastrophic', category: 'vibes' }, id)
    expect(verdict.ok && verdict.comment.severity).toBe('medium')
    expect(verdict.ok && verdict.comment.category).toBe('other')
  })

  it('orders findings by severity, then path, then line', () => {
    const make = (severity: string, path: string, line: number): ReviewComment =>
      (validateReviewComment({ path, content: 'x', severity, startLine: line, endLine: line }, 'c') as { ok: true; comment: ReviewComment }).comment
    const sorted = [make('low', 'a.ts', 1), make('critical', 'b.ts', 9), make('critical', 'a.ts', 2)]
      .sort(compareComments)
      .map(comment => `${comment.severity}:${comment.path}:${comment.startLine}`)
    expect(sorted).toEqual(['critical:a.ts:2', 'critical:b.ts:9', 'low:a.ts:1'])
  })
})

describe('review rule resolution', () => {
  const layers: ReviewRuleLayer[] = [
    { source: 'system', defaultRule: 'baseline', entries: [{ path: '**/*.java', rule: 'system-java', mergeSystemRule: false }] },
    { source: 'global', entries: [{ path: '**/*.ts', rule: 'global-ts', mergeSystemRule: false }] },
    { source: 'project', entries: [{ path: '**/*.ts', rule: 'project-ts', mergeSystemRule: false }] },
    { source: 'custom', entries: [{ path: 'src/**/*.ts', rule: 'custom-ts', mergeSystemRule: false }], exclude: ['**/vendor/**'] },
  ]

  it('resolves the highest-priority matching layer, regardless of argument order', () => {
    const resolver = createReviewRuleResolver(layers)
    expect(resolver.resolve('src/a.ts')).toMatchObject({ source: 'custom', pattern: 'src/**/*.ts', rule: 'custom-ts' })
    expect(resolver.resolve('lib/a.ts')).toMatchObject({ source: 'project', rule: 'project-ts' })
    expect(resolver.resolve('a.java')).toMatchObject({ source: 'system', rule: 'system-java' })
  })

  it('falls back to the layer default, then to an empty system answer', () => {
    expect(createReviewRuleResolver(layers).resolve('a.py')).toMatchObject({ source: 'system', pattern: 'default', rule: 'baseline' })
    expect(createReviewRuleResolver([]).resolve('a.py')).toEqual({ source: 'system', pattern: 'default', rule: '' })
  })

  it('includes the shipped standard only when the entry opts in', () => {
    const resolver = createReviewRuleResolver([
      { source: 'system', defaultRule: 'baseline', entries: [] },
      { source: 'project', entries: [{ path: '**/*.ts', rule: 'project-ts', mergeSystemRule: true }] },
    ])
    expect(resolver.resolve('a.ts')).toMatchObject({ source: 'project', mergedRule: 'baseline' })
  })

  it('reports which layer excluded a path', () => {
    const resolver = createReviewRuleResolver(layers)
    expect(resolver.isExcluded('vendor/a.ts')).toBe(true)
    expect(resolver.excludeSource('vendor/a.ts')).toBe('custom')
    expect(resolver.isExcluded('src/a.ts')).toBe(false)
  })

  it('keeps identical rule text from different layers in separate groups', () => {
    const resolver = createReviewRuleResolver([
      { source: 'system', defaultRule: 'same', entries: [] },
      { source: 'project', entries: [{ path: '**/*.ts', rule: 'same', mergeSystemRule: false }] },
    ])
    const groups = groupByRule(resolver, ['a.ts', 'b.py'])
    expect(groups).toHaveLength(2)
    expect(groups.map(group => group.source)).toEqual(['project', 'system'])
    expect(groups.map(group => group.files)).toEqual([['a.ts'], ['b.py']])
  })

  it('numbers groups from one and keeps every file in exactly one group', () => {
    const resolver = createReviewRuleResolver(layers)
    const groups = groupByRule(resolver, ['src/a.ts', 'src/b.ts', 'lib/c.ts'])
    expect(groups.map(group => group.id)).toEqual([1, 2])
    expect(groups.flatMap(group => group.files)).toHaveLength(3)
  })

  it('reads a rule document in either case convention, and as a bare array', () => {
    const snake = parseReviewRuleDocument('{"rules":[{"path":"**/*.ts","rule":"r","merge_system_rule":true}]}')
    expect(snake.ok && snake.entries[0]?.mergeSystemRule).toBe(true)
    const camel = parseReviewRuleDocument('{"rules":[{"path":"**/*.ts","rule":"r","mergeSystemRule":true}]}')
    expect(camel.ok && camel.entries[0]?.mergeSystemRule).toBe(true)
    const bare = parseReviewRuleDocument('[{"path":"**/*.ts","rule":"r"}]')
    expect(bare.ok && bare.entries).toHaveLength(1)
  })

  it('refuses a malformed rule document instead of ignoring it', () => {
    expect(parseReviewRuleDocument('nonsense').ok).toBe(false)
    expect(parseReviewRuleDocument('{"rules":{"path":"x"}}').ok).toBe(false)
    expect(parseReviewRuleDocument('{"rules":[{"rule":"r"}]}').ok).toBe(false)
    expect(parseReviewRuleDocument('{"rules":[{"path":"x"}]}').ok).toBe(false)
    expect(parseReviewRuleDocument('{}')).toEqual({ ok: true, entries: [], exclude: [] })
  })

  it('reads a rule document\'s own exclude patterns, and refuses a malformed list', () => {
    // Upstream's `rule.json` carries `exclude` ("do not review generated or
    // vendored paths") beside `rules`. Dropping it would apply the project's rules
    // while ignoring the paths it already decided not to review — a review that
    // looks, to whoever wrote that file, exactly like one that honored it.
    const withExclude = parseReviewRuleDocument('{"rules":[{"path":"**/*.ts","rule":"r"}],"exclude":["**/*.gen.ts"," dist/** "]}')
    expect(withExclude.ok && withExclude.exclude).toEqual(['**/*.gen.ts', 'dist/**'])
    // A single string instead of a list is the mistake worth catching: the project
    // believes its generated files are excluded, and JSON.parse would not object.
    expect(parseReviewRuleDocument('{"exclude":"**/*.gen.ts"}').ok).toBe(false)
    expect(parseReviewRuleDocument('{"exclude":[42]}').ok).toBe(false)
    expect(parseReviewRuleDocument('{"exclude":["  "]}').ok).toBe(false)
    // `include` is recognized and inert here — it only outweighs upstream's
    // extension and path deny lists, and this pipeline reviews every changed file.
    const withInclude = parseReviewRuleDocument('{"include":["**/*.ts"]}')
    expect(withInclude.ok && withInclude.exclude).toEqual([])
  })
})

describe('review relocation', () => {
  const app = parseUnifiedDiff(APP_DIFF)[0]!

  const comment = (overrides: Partial<ReviewComment>): ReviewComment => ({
    id: 'c1',
    path: 'src/app.ts',
    content: 'finding',
    startLine: 0,
    endLine: 0,
    category: 'bug',
    severity: 'high',
    state: 'proposed',
    ...overrides,
  })

  it('accepts a range already inside the diff', () => {
    expect(relocateComment(comment({ startLine: 3, endLine: 3 }), app)).toEqual({
      startLine: 3,
      endLine: 3,
      relocated: false,
      reason: 'within-diff',
    })
  })

  it('relocates by quoted code when the proposal was mis-numbered', () => {
    const outcome = relocateComment(comment({ startLine: 99, endLine: 99, existingCode: 'const c = 4' }), app)
    expect(outcome).toEqual({ startLine: 3, endLine: 3, relocated: true, reason: 'matched-existing-code' })
  })

  it('declines to choose when quoted code matches more than once', () => {
    const duplicate = parseUnifiedDiff(DUPLICATE_DIFF)[0]!
    const outcome = relocateComment(comment({ startLine: 99, endLine: 99, existingCode: 'return null' }), duplicate)
    expect(outcome.reason).toBe('not-found')
    expect(outcome.startLine).toBe(0)
  })

  it('translates a proposal numbered against the old file when the new side has no such line', () => {
    const shrunk = parseUnifiedDiff(MIXED_DIFF)[0]!
    // The old side reaches line 13; the new side stops at 12.
    expect(isLineInNewSide(shrunk, 13)).toBe(false)
    expect(relocateComment(comment({ startLine: 13, endLine: 13 }), shrunk)).toEqual({
      startLine: 12,
      endLine: 12,
      relocated: true,
      reason: 'translated-from-old-side',
    })
  })

  it('leaves an unpositioned finding unpositioned without calling it a fix', () => {
    expect(relocateComment(comment({}), app)).toEqual({
      startLine: 0,
      endLine: 0,
      relocated: false,
      reason: 'already-unpositioned',
    })
  })

  it('reports a proposal with no supporting evidence as not found', () => {
    const outcome = relocateComment(comment({ startLine: 500, endLine: 500 }), app)
    expect(outcome).toEqual({ startLine: 0, endLine: 0, relocated: true, reason: 'not-found' })
  })
})

describe('review budget', () => {
  const limits = { maxGroupTokens: 100, maxTotalTokens: 250 }

  it('admits a group while the run has budget and stops when it does not', () => {
    expect(admitGroup(createBudgetState(), limits)).toEqual({ ok: true })
    const spent = recordSpend(createBudgetState(), 'g1', 250)
    expect(admitGroup(spent, limits).ok).toBe(false)
  })

  it('allows exactly one final round to a group over its ceiling, then stops', () => {
    const over = recordSpend(createBudgetState(), 'g1', 150)
    expect(admitRound(over, 'g1', limits)).toEqual({ ok: true, final: true })
    const consumed = consumeFinalRound(over, 'g1')
    expect(admitRound(consumed, 'g1', limits).ok).toBe(false)
  })

  it('keeps a group under its ceiling on ordinary rounds', () => {
    expect(admitRound(recordSpend(createBudgetState(), 'g1', 10), 'g1', limits)).toEqual({ ok: true, final: false })
  })

  it('accumulates spend per group and in total', () => {
    const state = recordSpend(recordSpend(createBudgetState(), 'g1', 40), 'g2', 60)
    expect(state.groups).toEqual({ g1: 40, g2: 60 })
    expect(state.spentTotal).toBe(100)
    expect(isBudgetExhausted(state, limits)).toBe(false)
  })

  it('ignores a negative delta rather than crediting the run', () => {
    expect(recordSpend(createBudgetState(), 'g1', -50).spentTotal).toBe(0)
  })

  it('summarizes the ceilings and the exhausted flag', () => {
    const summary = summarizeBudget(recordSpend(createBudgetState(), 'g1', 250), limits)
    expect(summary).toEqual({ maxGroupTokens: 100, maxTotalTokens: 250, spentTotal: 250, exhausted: true })
    expect(DEFAULT_REVIEW_BUDGET.maxGroupTokens).toBeGreaterThan(0)
  })
})

describe('review coverage', () => {
  const outcomes: ReviewFileOutcome[] = [
    { path: 'a.ts', change: 'modified', state: 'reviewed', comments: 1 },
    { path: 'b.ts', change: 'added', state: 'skipped', reason: 'binary', comments: 0 },
    { path: 'c.ts', change: 'added', state: 'failed', reason: 'budget', comments: 0 },
    { path: 'd.ts', change: 'added', state: 'pending', comments: 0 },
  ]

  it('counts each state and derives the coverage rate from reviewed files', () => {
    expect(summarizeCoverage(outcomes)).toEqual({
      totalFiles: 4,
      reviewedFiles: 1,
      skippedFiles: 1,
      failedFiles: 1,
      pendingFiles: 1,
      coverageRate: 0.25,
    })
  })

  it('reports zero coverage for an empty review rather than full coverage', () => {
    expect(summarizeCoverage([]).coverageRate).toBe(0)
  })

  it('names the files a finished run never accounted for', () => {
    expect(unaccountedFiles(outcomes)).toEqual(['d.ts'])
  })

  it('names an outcome whose skipped or failed state carries no reason', () => {
    expect(missingReasons([
      { path: 'a.ts', change: 'modified', state: 'skipped', comments: 0 },
      { path: 'b.ts', change: 'added', state: 'failed', reason: '  ', comments: 0 },
      { path: 'c.ts', change: 'added', state: 'reviewed', comments: 0 },
    ])).toEqual(['a.ts', 'b.ts'])
  })
})

describe('review report rendering', () => {
  const keep = (overrides: Partial<ReviewComment>): ReviewComment => ({
    id: overrides.id ?? 'c1',
    path: overrides.path ?? 'src/a.ts',
    content: overrides.content ?? 'Null dereference on the error path.',
    startLine: overrides.startLine ?? 3,
    endLine: overrides.endLine ?? 3,
    category: overrides.category ?? 'bug',
    severity: overrides.severity ?? 'high',
    state: overrides.state ?? 'proposed',
    ...(overrides.filteredReason === undefined ? {} : { filteredReason: overrides.filteredReason }),
  })

  const report = assembleReviewReport({
    id: 'r1',
    state: 'partial',
    target: { mode: 'workspace', cwd: '/repo' },
    reviewers: ['reviewer-1'],
    createdAt: 1,
    completedAt: 2,
    coverage: summarizeCoverage([
      { path: 'src/a.ts', change: 'modified', state: 'reviewed', comments: 1 },
      { path: 'vendor/b.ts', change: 'added', state: 'skipped', reason: 'excluded by project rule', comments: 0 },
    ]),
    files: [
      { path: 'src/a.ts', change: 'modified', state: 'reviewed', comments: 1 },
      { path: 'vendor/b.ts', change: 'added', state: 'skipped', reason: 'excluded by project rule', comments: 0 },
    ],
    comments: [
      keep({ id: 'c2', severity: 'low', startLine: 2, content: 'nit' }),
      keep({ id: 'c1' }),
      keep({ id: 'c3', startLine: 0, endLine: 0, severity: 'critical', content: 'Token logged in plaintext.' }),
      { ...keep({ id: 'c4' }), state: 'filtered', filteredReason: 'diff disproves the claim' },
    ],
    budget: summarizeBudget(createBudgetState(), DEFAULT_REVIEW_BUDGET),
  })

  it('sorts findings and counts what the filter dropped', () => {
    // c3 is critical; c1 and c4 are both high at src/a.ts:3, so their insertion
    // order stands; c2 is the low finding and sorts last.
    expect(report.comments.map(comment => comment.id)).toEqual(['c3', 'c1', 'c4', 'c2'])
    expect(report.filteredCount).toBe(1)
  })

  it('states coverage, the filtered count, and every unreviewed file in text', () => {
    const text = renderReviewText(report)
    expect(text).toContain('Files reviewed: 1 / 2 (50%)')
    expect(text).toContain('Filtered out: 1')
    expect(text).toContain('`src/a.ts:3`')
    expect(text).toContain('position not determined')
    expect(text).toContain('`vendor/b.ts` — skipped: excluded by project rule')
  })

  it('omits filtered findings from text while keeping them in JSON', () => {
    expect(renderReviewText(report)).not.toContain('c4')
    expect(JSON.parse(renderReviewJson(report)).comments).toHaveLength(4)
  })

  it('maps severity to a SARIF level and leaves an unpositioned finding without a region', () => {
    const sarif = JSON.parse(renderReviewSarif(report))
    expect(sarif.version).toBe('2.1.0')
    const results = sarif.runs[0].results
    expect(results).toHaveLength(3)
    expect(results.map((result: { level: string }) => result.level)).toEqual(['error', 'error', 'note'])
    const unpositioned = results.find((result: { ruleId: string }) => result.ruleId === 'review/critical')
    expect(unpositioned.locations).toEqual([])
    const positioned = results.find((result: { ruleId: string }) => result.ruleId === 'review/high')
    expect(positioned.locations[0].physicalLocation.region).toEqual({ startLine: 3, endLine: 3 })
  })

  it('says so when a review found nothing at the reporting threshold', () => {
    const empty = assembleReviewReport({
      id: 'r2',
      state: 'completed',
      target: { mode: 'workspace', cwd: '/repo' },
      reviewers: [],
      createdAt: 1,
      coverage: summarizeCoverage([{ path: 'a.ts', change: 'modified', state: 'reviewed', comments: 0 }]),
      files: [{ path: 'a.ts', change: 'modified', state: 'reviewed', comments: 0 }],
      comments: [],
      budget: summarizeBudget(createBudgetState(), DEFAULT_REVIEW_BUDGET),
    })
    expect(renderReviewText(empty)).toContain('no findings at or above the reporting threshold')
    expect(renderReviewText(empty)).toContain('Every changed file was reviewed.')
  })
})
