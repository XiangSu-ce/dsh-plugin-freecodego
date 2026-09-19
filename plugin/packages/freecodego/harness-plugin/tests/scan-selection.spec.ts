/**
 * Deterministic scan selection.
 *
 * What these cases are actually protecting
 * ----------------------------------------
 * Selection is the one part of a scan that must not be a judgement call, so the
 * cases below are about the three ways a *decision* goes wrong rather than about
 * covering branches:
 *
 * 1. **A file leaves without a reason.** Every excluded candidate must carry one,
 *    and the denominator must equal the selected set exactly — a file that is
 *    neither selected nor excluded is the silent skip this module exists to make
 *    impossible.
 * 2. **"Not measured" reads as "small".** A size the caller could not judge is an
 *    answer of its own. Both directions are pinned: such a file must stay
 *    *selected*, and it must be *named* as unchecked. Treating it as `0` loses the
 *    flag; treating it as huge excludes it. One assertion kills both.
 * 3. **The order of the gates drifts.** A credential path that also matches an
 *    exclusion pattern must report the credential, because that is the reason that
 *    explains why nobody looked at it.
 *
 * There is no filesystem in this file on purpose: the module takes measured facts
 * and returns decisions, so a case here is about the decision and never about git
 * or a temp directory. That is what makes the answer reproducible, and it is the
 * property `engineering_inspect` relies on when it shows the same selection a run
 * would act on.
 */

import { describe, expect, test } from 'vitest'

import {
  DEFAULT_SCAN_EXCLUDE_RULES,
  DEFAULT_SCAN_MAX_FILE_BYTES,
  SCAN_EXCLUSIONS,
  selectScanFiles,
  type ScanCandidate,
  type ScanExcludeRule,
} from '../src/scan-selection.ts'

/** A selected candidate's decision, by path — the assertion most cases need. */
function decisionFor(selection: ReturnType<typeof selectScanFiles>, path: string) {
  return selection.decisions.find(decision => decision.path === path)!
}

describe('selectScanFiles is a function of its arguments', () => {
  test('two calls over the same input agree, so a preview and a run cannot drift', () => {
    const candidates: readonly ScanCandidate[] = [
      { path: 'src/a.ts', bytes: 100 },
      { path: 'dist/b.js', bytes: 100 },
      { path: 'src/gone.ts', deleted: true },
      { path: 'src/unknown.ts' },
    ]
    expect(selectScanFiles(candidates)).toEqual(selectScanFiles(candidates))
  })

  test('returns one decision per candidate, in input order', () => {
    const selection = selectScanFiles([
      { path: 'z.ts', bytes: 1 },
      { path: 'a.ts', bytes: 1 },
      { path: 'dist/m.js', bytes: 1 },
    ])
    expect(selection.decisions.map(decision => decision.path)).toEqual(['z.ts', 'a.ts', 'dist/m.js'])
    expect(selection.selected).toEqual(['z.ts', 'a.ts'])
  })

  test('accepts an empty change set without inventing an answer', () => {
    const selection = selectScanFiles([])
    expect(selection.selected).toEqual([])
    expect(selection.excluded).toEqual([])
    expect(selection.counts.none).toBe(0)
  })
})

describe('a deletion leaves the denominator and stays in the decisions', () => {
  test('a deleted path is not selected, so nothing is asked to read it', () => {
    const selection = selectScanFiles([{ path: 'src/gone.ts', deleted: true, bytes: 10 }])
    expect(selection.selected).toEqual([])
    expect(decisionFor(selection, 'src/gone.ts').exclusion).toBe('deleted')
  })

  test('the same path is still reported, so the change set a reader sees is whole', () => {
    const selection = selectScanFiles([
      { path: 'src/kept.ts', bytes: 10 },
      { path: 'src/gone.ts', deleted: true },
    ])
    // Both paths survive in `decisions` even though only one is scannable: a
    // report that showed only the survivor would be a change set nobody made.
    expect(selection.decisions.map(decision => decision.path)).toEqual(['src/kept.ts', 'src/gone.ts'])
    expect(selection.excluded.map(decision => decision.path)).toEqual(['src/gone.ts'])
  })
})

describe('a credential path is refused before any other gate', () => {
  test('an environment file is refused', () => {
    expect(decisionFor(selectScanFiles([{ path: 'config/.env', bytes: 10 }]), 'config/.env').exclusion).toBe('credential')
  })

  test('an ssh key is refused', () => {
    expect(decisionFor(selectScanFiles([{ path: 'deploy/.ssh/id_rsa', bytes: 10 }]), 'deploy/.ssh/id_rsa').exclusion)
      .toBe('credential')
  })

  test('a credential file inside vendored source still reports the credential', () => {
    // The mutation this pins: moving the rule loop above the credential check
    // makes this report `excluded-by-pattern`, which is a true statement about the
    // path and the wrong answer to "why did nobody look at it".
    expect(decisionFor(selectScanFiles([{ path: 'vendor/.env', bytes: 10 }]), 'vendor/.env').exclusion).toBe('credential')
  })

  test('an ordinary source file is not mistaken for one', () => {
    expect(decisionFor(selectScanFiles([{ path: 'src/index.ts', bytes: 10 }]), 'src/index.ts').exclusion).toBe('none')
  })
})

describe('the default table excludes noise and nothing else', () => {
  test.each([
    'node_modules/react/index.js',
    'third_party/vendor/lib.c',
    'packages/app/dist/bundle.js',
    'coverage/lcov.info',
    'src/__snapshots__/a.snap',
    'web/app.min.js',
    'lib/bundle.js.map',
    'src/api.generated.ts',
    'tsconfig.tsbuildinfo',
    'pnpm-lock.yaml',
  ])('%s is excluded with a reason', (path) => {
    const decision = decisionFor(selectScanFiles([{ path, bytes: 10 }]), path)
    expect(decision.exclusion).toBe('excluded-by-pattern')
    expect(decision.pattern).toBeDefined()
    expect(String(decision.reason)).not.toBe('')
  })

  test.each([
    'node_modules/.bin/vite',
    'node_modules/.pnpm/lock.yaml',
    'repo/.cache/dist/bundle.js',
    'packages/app/dist/.staging/chunk.js',
    'src/.hidden/app.min.js',
    'lib/.nested/deep/app.js.map',
  ])('%s is excluded even though a segment on the way starts with a dot', (path) => {
    // The table's patterns were written about directories and suffixes, and
    // `matchesGlob` gives a wildcard no way to match a dot-named segment — `*` and
    // `**` both refuse one, at any depth. So `**/node_modules/**` did not match
    // `node_modules/.bin/vite`, `**/dist/**` did not match `dist/.staging/chunk.js`,
    // and `**/*.min.js` did not match `src/.hidden/app.min.js`: the paths this table
    // exists to keep out of a scan stayed in its denominator. Nothing showed it,
    // because every sample the case above feeds in has undotted segments.
    //
    // Pinned per shape rather than with one sample, because the fix reads a second
    // spelling of the path: a rule that only un-dotted the *first* segment would
    // pass the `node_modules/.bin` line and fail the nested ones.
    const decision = decisionFor(selectScanFiles([{ path, bytes: 10 }]), path)
    expect(decision.exclusion).toBe('excluded-by-pattern')
    expect(decision.pattern).toBeDefined()
  })

  test('a hidden directory no rule names stays in the scan', () => {
    // The control for the same fix: reading a second spelling is not a filter on
    // dot-paths. `.github/workflows/` and a hidden source directory are real work in
    // a repository, and no pattern in the table names them.
    for (const path of ['.github/workflows/ci.yml', 'src/.hidden/a.ts', '.freecodego/rules/style.md']) {
      expect(decisionFor(selectScanFiles([{ path, bytes: 10 }]), path).exclusion, path).toBe('none')
    }
  })

  test('every default rule carries a non-empty reason, so a report can always explain itself', () => {
    for (const rule of DEFAULT_SCAN_EXCLUDE_RULES) {
      expect(rule.pattern).not.toBe('')
      expect(rule.reason).not.toBe('')
    }
  })

  test('a test file is NOT excluded by default', () => {
    // A deliberate difference from open-code-review's default table, and the
    // reason is this repository's own defect class: a test that asserts nothing
    // while reporting green is invisible to a scan that never opens tests.
    const selection = selectScanFiles([
      { path: 'src/a.spec.ts', bytes: 10 },
      { path: 'src/b.test.tsx', bytes: 10 },
    ])
    expect(selection.selected).toEqual(['src/a.spec.ts', 'src/b.test.tsx'])
  })

  test('a caller\'s own table replaces the default rather than adding to it', () => {
    const exclude: readonly ScanExcludeRule[] = [{ pattern: '**/*.md', reason: 'documentation only' }]
    const selection = selectScanFiles([
      { path: 'node_modules/x.js', bytes: 10 },
      { path: 'README.md', bytes: 10 },
    ], { exclude })
    expect(selection.selected).toEqual(['node_modules/x.js'])
    expect(decisionFor(selection, 'README.md').reason).toBe('documentation only')
  })

  test('an empty table excludes nothing', () => {
    const selection = selectScanFiles([{ path: 'node_modules/x.js', bytes: 10 }], { exclude: [] })
    expect(selection.selected).toEqual(['node_modules/x.js'])
  })

  test('the first matching rule supplies the reason', () => {
    const exclude: readonly ScanExcludeRule[] = [
      { pattern: '**/dist/**', reason: 'generated bundle' },
      { pattern: '**/*.js', reason: 'broader rule' },
    ]
    expect(decisionFor(selectScanFiles([{ path: 'dist/a.js', bytes: 10 }], { exclude }), 'dist/a.js').reason)
      .toBe('generated bundle')
  })
})

describe('the size gate', () => {
  test('excludes a file over the ceiling, with the size and the priced estimate', () => {
    const decision = decisionFor(
      selectScanFiles([{ path: 'src/huge.ts', bytes: DEFAULT_SCAN_MAX_FILE_BYTES + 1 }]),
      'src/huge.ts',
    )
    expect(decision.exclusion).toBe('too-large')
    expect(decision.bytes).toBe(DEFAULT_SCAN_MAX_FILE_BYTES + 1)
    expect(decision.tokens).toBeGreaterThan(0)
    expect(decision.sizeUnchecked).toBeUndefined()
  })

  test('keeps a file exactly at the ceiling', () => {
    expect(decisionFor(selectScanFiles([{ path: 'src/edge.ts', bytes: DEFAULT_SCAN_MAX_FILE_BYTES }]), 'src/edge.ts').exclusion)
      .toBe('none')
  })

  test('an unmeasured size is selected AND named, never read as small or as huge', () => {
    // The probe for the module's headline invariant. Reading the unknown as `0`
    // loses `sizeUnchecked`; reading it as infinite excludes the file. Both
    // mutations fail here.
    const decision = decisionFor(selectScanFiles([{ path: 'src/unknown.ts' }]), 'src/unknown.ts')
    expect(decision.exclusion).toBe('none')
    expect(decision.sizeUnchecked).toBe(true)
    expect(decision.bytes).toBeUndefined()
    expect(decision.tokens).toBeUndefined()
  })

  test('an unmeasured size survives a configured ceiling', () => {
    const selection = selectScanFiles([{ path: 'src/unknown.ts' }], { maxFileBytes: 1 })
    expect(selection.selected).toEqual(['src/unknown.ts'])
    expect(decisionFor(selection, 'src/unknown.ts').sizeUnchecked).toBe(true)
  })

  test('a ceiling of 0 disables the gate without dropping the measurement', () => {
    const selection = selectScanFiles([{ path: 'src/huge.ts', bytes: 10_000_000 }], { maxFileBytes: 0 })
    expect(selection.selected).toEqual(['src/huge.ts'])
    const decision = decisionFor(selection, 'src/huge.ts')
    expect(decision.bytes).toBe(10_000_000)
    expect(selection.maxFileBytes).toBe(0)
  })

  test('a zero-byte file is selected rather than treated as absent', () => {
    const decision = decisionFor(selectScanFiles([{ path: 'src/empty.ts', bytes: 0 }]), 'src/empty.ts')
    expect(decision.exclusion).toBe('none')
    expect(decision.bytes).toBe(0)
    expect(decision.sizeUnchecked).toBeUndefined()
  })
})

describe('the denominator', () => {
  test('lists one entry for a path git reports twice', () => {
    // Workspace mode can name the same path twice — a staged deletion followed by
    // an untracked recreation. There is one file on disk now, so there is one
    // thing to account for; `counts` counts decisions and is expected to differ.
    const selection = selectScanFiles([
      { path: 'src/x.ts', deleted: true },
      { path: 'src/x.ts', bytes: 10 },
    ])
    expect(selection.selected).toEqual(['src/x.ts'])
    expect(selection.counts.none).toBe(1)
    expect(selection.counts.deleted).toBe(1)
    expect(selection.decisions).toHaveLength(2)
  })

  test('is exactly the selected decisions, with no path unaccounted for', () => {
    const selection = selectScanFiles([
      { path: 'src/a.ts', bytes: 10 },
      { path: 'dist/b.js', bytes: 10 },
      { path: 'src/.env', bytes: 10 },
      { path: 'src/gone.ts', deleted: true },
      { path: 'src/huge.ts', bytes: DEFAULT_SCAN_MAX_FILE_BYTES + 1 },
    ])
    const decided = selection.decisions.map(decision => decision.path).sort()
    expect([...selection.selected, ...selection.excluded.map(decision => decision.path)].sort()).toEqual(decided)
    expect(selection.selected).toEqual(['src/a.ts'])
  })

  test('counts every exclusion reason, including the ones at zero', () => {
    const selection = selectScanFiles([{ path: 'src/a.ts', bytes: 10 }])
    expect(Object.keys(selection.counts).sort()).toEqual([...SCAN_EXCLUSIONS].sort())
    expect(selection.counts['too-large']).toBe(0)
    expect(selection.counts.none).toBe(1)
  })

  test('the counts agree with the decisions for every reason', () => {
    const selection = selectScanFiles([
      { path: 'src/a.ts', bytes: 10 },
      { path: 'src/.env', bytes: 10 },
      { path: 'dist/b.js', bytes: 10 },
      { path: 'src/gone.ts', deleted: true },
      { path: 'src/huge.ts', bytes: DEFAULT_SCAN_MAX_FILE_BYTES + 1 },
    ])
    for (const reason of SCAN_EXCLUSIONS) {
      expect(selection.counts[reason]).toBe(selection.decisions.filter(decision => decision.exclusion === reason).length)
    }
  })
})

describe('paths are normalized to the spelling the patterns are written in', () => {
  test('a Windows-separated path matches a forward-slash pattern and is reported the same way', () => {
    const decision = decisionFor(selectScanFiles([{ path: 'src\\deep\\a.ts', bytes: 10 }]), 'src/deep/a.ts')
    expect(decision.exclusion).toBe('none')
  })

  test('a Windows-separated vendored path is still excluded', () => {
    expect(decisionFor(selectScanFiles([{ path: 'node_modules\\x\\y.js', bytes: 10 }]), 'node_modules/x/y.js').exclusion)
      .toBe('excluded-by-pattern')
  })

  test('a leading ./ is dropped so one file has one spelling', () => {
    const selection = selectScanFiles([{ path: './src/a.ts', bytes: 10 }])
    expect(selection.selected).toEqual(['src/a.ts'])
  })
})
