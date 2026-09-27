/**
 * Regressions for the design-Skill vendoring pass.
 *
 * Why this file exists
 * --------------------
 * Every defect the vendoring script has actually shipped was found by **reading its
 * output**, not by its own report. It reported success while it:
 *
 * 1. reflowed whitespace across 440 files, taking indented examples and ASCII
 *    diagrams with it — and making the 64 KiB body audit pass for a reason nobody
 *    had chosen;
 * 2. counted each unsupported site twice, because the specific rule and the general
 *    probe both matched it, inflating the review list by 38%;
 * 3. reported unsupported verbs as "unmapped" because the probe ran before the
 *    removal pass, and then reported them again separately;
 * 4. nested backticks, by substituting a backtick-carrying replacement into text
 *    that was already inside a code span;
 * 5. swallowed the closing backtick of a code span, because the pattern that ate a
 *    command's trailing flags let a flag value run into the backtick that ended it.
 *
 * Four of the five produce text that is still valid input, so nothing fails: the
 * report is green and the pack is subtly wrong. That is exactly the class of defect a
 * report cannot catch, so each one is pinned here against a fixture that reproduces
 * the shape rather than against the real pack — the pack changes with every upstream
 * sync, and a test that reads it would drift with it.
 *
 * The script is exercised as a subprocess rather than imported: it *is* a command, its
 * contract is its arguments and its exit code, and importing it would run `main`.
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(PACKAGE_ROOT, 'scripts', 'vendor-design-skills.mjs')

/** The limit `inspectSkillRoot()` enforces, restated so the fixture can exceed it. */
const BODY_LIMIT_BYTES = 64 * 1024

interface Finding {
  readonly kind: string
  readonly skill: string
  readonly file: string
  readonly text: string
}
interface Report {
  readonly summary: {
    readonly upstream: {
      readonly skills: number
      readonly included: number
      readonly tree: { readonly digest: string; readonly files: number }
    }
    readonly kept: { readonly files: number; readonly bytes: number }
    readonly dropped: { readonly files: number }
    readonly changedFiles: number
    readonly findings: {
      readonly rewritten: number
      readonly extracted: readonly Finding[]
      readonly 'unmapped-cli': readonly Finding[]
      readonly 'removed-line': readonly Finding[]
      readonly 'prose-rewritten': readonly Finding[]
      readonly 'needs-review': readonly Finding[]
      readonly 'over-body-budget': readonly Finding[]
      readonly 'claim-repaired': readonly Finding[]
    }
    /** The claim audit: which written-down false sentences were still there. */
    readonly claims: {
      readonly repaired: readonly Finding[]
      readonly unmatched: readonly { readonly id: string; readonly pattern: string; readonly reason: string }[]
    }
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One Skill directory, written from a map of relative path to content. */
function writeSkill(root: string, name: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, 'skills', name, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

function makeFixture(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'freecodego-vendor-skills-'))
  roots.push(root)
  mkdirSync(join(root, 'skills'), { recursive: true })
  build(root)
  return root
}

/**
 * Run the script and parse its report.
 *
 * `--out` is always passed, and that is a safety rule rather than tidiness: the
 * script's default destination is the package's real `assets/design/skills`, so a
 * `--write` case that forgot it would overwrite the shipped pack from inside a test.
 * @param source the fixture root
 * @param extra additional arguments, e.g. `--write`
 * @returns the parsed report, and the exit status
 */
function run(source: string, out: string, extra: readonly string[] = []): { report: Report; status: number; stderr: string } {
  let stdout = ''
  let stderr = ''
  let status = 0
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, '--source', source, '--out', out, '--json', ...extra], { encoding: 'utf8' })
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number }
    stdout = failure.stdout ?? ''
    stderr = failure.stderr ?? ''
    status = failure.status ?? 1
  }
  // `--json` puts the report on stdout and every human sentence on stderr, so the
  // document needs no delimiter and no trailer to be located. An earlier revision
  // printed a status line after the JSON, and keyed-to-the-dry-run-trailer parsing
  // then read the `--write` run's `wrote N files` line as part of the document —
  // which is the defect this shape removes rather than works around.
  return { report: JSON.parse(stdout) as Report, status, stderr }
}

const read = (out: string, skill: string, file: string) => readFileSync(join(out, skill, file), 'utf8')

/**
 * Every finding across the kinds this pass can emit, so counts cannot hide in one.
 *
 * The claim audit is deliberately **not** here: an unmatched claim repair is a
 * property of the run and not of any file, and folding it in would make every
 * fixture that has no such sentence report extra entries — which is how a count
 * assertion stops meaning "one site was described once".
 */
function allFindings(report: Report): readonly Finding[] {
  const findings = report.summary.findings
  return [
    ...findings.extracted,
    ...findings['unmapped-cli'],
    ...findings['removed-line'],
    ...findings['prose-rewritten'],
    ...findings['needs-review'],
    ...findings['over-body-budget'],
    ...findings['claim-repaired'],
  ]
}

describe('design Skill vendoring', () => {
  it('removes emoji without reflowing the whitespace around them', () => {
    // The heading glyph is dropped; the indented block and the aligned table keep
    // their columns. The earlier revision collapsed every run of spaces, which is
    // invisible in a report and visible in every example in the file.
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', {
        'SKILL.md': [
          '---',
          'name: alpha',
          'description: A fixture.',
          '---',
          '',
          '# Alpha ✅',
          '',
          'Steps:',
          '',
          '```text',
          '    indented example    with inner spacing',
          '        deeper',
          '```',
          '',
          '| Column A      | Column B        |',
          '| ------------- | --------------- |',
          '| value one     | value two       |',
          '',
          'Verdict: ❌ because the source was stale.',
          '',
        ].join('\n'),
      })
    })
    const out = join(source, 'out')
    run(source, out, ['--write'])

    const body = read(out, 'alpha', 'SKILL.md')
    expect(body.startsWith('---\n')).toBe(true)
    expect(body).not.toMatch(/\p{Emoji_Presentation}|\uFE0F|\u200D/u)
    expect(body).toContain('# Alpha')
    // The indented block survives byte for byte, inner spacing included.
    expect(body).toContain('    indented example    with inner spacing')
    expect(body).toContain('        deeper')
    // The table keeps its column widths.
    expect(body).toContain('| Column A      | Column B        |')
    expect(body).toContain('| value one     | value two       |')
    // A verdict glyph becomes a word, matching the vendored packs' vocabulary.
    expect(body).toContain('Verdict: FAIL because the source was stale.')
  })

  it('counts each unsupported site exactly once', () => {
    // The specific rule and the general probe used to both match, so `add` was
    // reported twice and the review list read 38% longer than it was.
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', {
        'SKILL.md': [
          '---',
          'name: alpha',
          'description: A fixture.',
          '---',
          '',
          '# Alpha',
          '',
          'Run `npx hyperframes add <block>` to install it.',
          '',
        ].join('\n'),
      })
    })
    const out = join(source, 'out')
    const { report } = run(source, out)

    // One inline `add` in the fixture, so exactly one finding may describe it —
    // whichever kind it landed in. Counting through `allFindings` rather than
    // through a single kind is the point: the defect was two kinds describing one
    // site, and an assertion that only reads one kind cannot see the second.
    expect(allFindings(report)).toHaveLength(1)
    expect(report.summary.findings['prose-rewritten']).toHaveLength(1)
    expect(report.summary.findings['prose-rewritten'][0]!.text.startsWith('add: ')).toBe(true)
    // A site that got a replacement is not also reported as unmapped: the probe runs
    // after the removal pass, on text the removal pass has already handled.
    expect(report.summary.findings['unmapped-cli']).toHaveLength(0)
  })

  it('replaces the sentence around a missing capability, not just the invocation', () => {
    // Fragment-level substitution produced "Run a capability this plugin does not
    // provide and read the results", which is worse than either the original or a
    // sentence that stands on its own.
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', {
        'SKILL.md': [
          '---',
          'name: alpha',
          'description: A fixture.',
          '---',
          '',
          '# Alpha',
          '',
          'Run `npx hyperframes catalog --query "<the look>" --json` and read the top results before you write that look down.',
          '',
        ].join('\n'),
      })
    })
    const out = join(source, 'out')
    const { report } = run(source, out, ['--write'])
    const body = read(out, 'alpha', 'SKILL.md')

    expect(report.summary.findings['prose-rewritten']).toHaveLength(1)
    expect(body).toContain('This plugin ships no hosted look registry')
    // The whole sentence went, including the clause after the invocation.
    expect(body).not.toContain('read the top results')
    expect(body).not.toContain('a capability this plugin does not provide')
  })

  it('replaces a mapped invocation without nesting backticks', () => {
    // Upstream writes these calls inside code spans. A replacement that carried its
    // own backticks produced `` `the `freecodego_design_lint` tool` `` — valid input,
    // broken output, and invisible to every assertion except one that reads it.
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', {
        'SKILL.md': [
          '---',
          'name: alpha',
          'description: A fixture.',
          '---',
          '',
          '# Alpha',
          '',
          'Check it with `npx hyperframes lint --json` before rendering.',
          '',
        ].join('\n'),
      })
    })
    const out = join(source, 'out')
    run(source, out, ['--write'])
    const body = read(out, 'alpha', 'SKILL.md')

    expect(body).toContain('Check it with `freecodego_design_lint` before rendering.')
    expect(body).not.toContain('`the `')
    for (const line of body.split('\n')) {
      if (!line.includes('freecodego_design')) continue
      expect((line.match(/`/gu) ?? []).length % 2, `unbalanced backticks: ${line}`).toBe(0)
    }
  })

  it('consumes a command\u2019s trailing flags and quoted arguments along with its verb', () => {
    // An in-process tool takes named arguments, so a leftover `--at <x>` names a tool
    // and then hands it an argument its schema rejects. The flag value also must not
    // run into the backtick that closes the span, which is what ate the closer.
    //
    // The quoted path is the case that kept escaping: upstream quotes the project
    // directory, and a run that stopped at the quote shipped a tool name followed by
    // a shell path and a flag — the same defect one token further along.
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', {
        'SKILL.md': [
          '---',
          'name: alpha',
          'description: A fixture.',
          '---',
          '',
          '# Alpha',
          '',
          'Grab proof frames with `npx hyperframes snapshot --at 1.5,3.0 --frames 4` when you need to look.',
          '',
          'Render with `npx hyperframes render --quality high --output renders/out.mp4` at the end.',
          '',
          'Serve it with `npx hyperframes preview "$PROJECT_DIR" --background` for review.',
          '',
          'Keep the trailing prose --quality of life intact.',
          '',
        ].join('\n'),
      })
    })
    const out = join(source, 'out')
    run(source, out, ['--write'])
    const body = read(out, 'alpha', 'SKILL.md')

    // The arguments are gone, and the closing backtick survived.
    expect(body).toContain('`freecodego_design_snapshot`')
    expect(body).toContain('`freecodego_design_render`')
    expect(body).toContain('`freecodego_design_preview` for review.')
    expect(body).not.toContain('--at')
    expect(body).not.toContain('--quality high')
    expect(body).not.toContain('--background')
    expect(body).not.toContain('$PROJECT_DIR')
    // A bare word after the arguments is prose, not an argument: the run has to stop.
    expect(body).toContain('Keep the trailing prose --quality of life intact.')
  })

  it('corrects a sentence the substitution itself falsifies', () => {
    // Upstream's `preview` keeps a background server and offers a flag to stop it, so
    // the sentence around the call is a claim about that mechanism rather than about
    // the capability. The tool here returns as soon as its listener is up and is
    // released by calling it again with `stop: true`, which is why the sentence is
    // repaired rather than left with its arguments stripped.
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', {
        'SKILL.md': [
          '---',
          'name: alpha',
          'description: A fixture.',
          '---',
          '',
          '# Alpha',
          '',
          'Preview: `npx hyperframes preview "$PROJECT_DIR" --background`',
          '',
          "After the user is done reviewing, stop only this project's background server: `npx hyperframes preview \"$PROJECT_DIR\" --stop`. Never tear it down while waiting for review.",
          '',
        ].join('\n'),
      })
    })
    const out = join(source, 'out')
    const { report } = run(source, out, ['--write'])
    const body = read(out, 'alpha', 'SKILL.md')

    expect(report.summary.findings['claim-repaired']).toHaveLength(1)
    expect(report.summary.findings['claim-repaired'][0]!.text.startsWith('preview-stop-flag: ')).toBe(true)
    // Only the entry this fixture contains fired; the other is reported as unmatched
    // rather than as done, and the two lists are read entry by entry.
    expect(report.summary.claims.unmatched.map(entry => entry.id)).toEqual(['preview-blocks-claim'])
    expect(body).toContain('stop only this preview by calling `freecodego_design_preview` again with `stop: true`.')
    expect(body).not.toContain('--stop')
    expect(body).not.toContain('--background')
    // The instruction the reader was about to follow survived the correction: a repair
    // that dropped the sentence would leave a step missing rather than corrected.
    expect(body).toContain('Never tear it down while waiting for review.')
  })

  it('corrects a stated reason the substitution invalidates, in a reference file', () => {
    // The claim is false wherever it appears, so the rule is keyed by pattern rather
    // than by file — and this pins that it fires in a document that is not a body.
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', {
        'SKILL.md': '---\nname: alpha\ndescription: A fixture.\n---\n\n# Alpha\n',
        'references/design-picker.md': [
          'Do NOT use `npx hyperframes preview` for the picker \u2014 it blocks. Only start the HTTP server from the main conversation thread.',
          '',
        ].join('\n'),
      })
    })
    const out = join(source, 'out')
    const { report } = run(source, out, ['--write'])
    const body = read(out, 'alpha', 'references/design-picker.md')

    expect(report.summary.findings['claim-repaired']).toHaveLength(1)
    expect(report.summary.findings['claim-repaired'][0]!.file).toBe('references/design-picker.md')
    expect(report.summary.findings['claim-repaired'][0]!.text.startsWith('preview-blocks-claim: ')).toBe(true)
    expect(body).not.toContain('it blocks')
    expect(body).toContain('It never blocks')
    // The prohibition is kept: correcting a reason must not delete an instruction,
    // and the sentence after it is not part of the claim.
    expect(body).toContain('Do NOT use `freecodego_design_preview` for the picker:')
    expect(body).toContain('Only start the HTTP server from the main conversation thread.')
  })

  it('reports a claim repair that could not apply, without refusing the write', () => {
    // The list of false sentences is written down before the text is read, so an
    // upstream rewording leaves its entry unmatched. That means somebody has to read
    // that sentence again — not that the vendoring stops, since the text the decision
    // was made against is provably gone and nothing says what replaced it.
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', { 'SKILL.md': '---\nname: alpha\ndescription: A fixture.\n---\n\n# Alpha\n\nNothing to correct here.\n' })
    })
    const out = join(source, 'out')
    const written = run(source, out, ['--write'])

    expect(written.status).toBe(0)
    expect(written.report.summary.findings['claim-repaired']).toHaveLength(0)
    expect(written.report.summary.claims.unmatched.map(entry => entry.id)).toEqual(['preview-stop-flag', 'preview-blocks-claim'])
    expect(existsSync(join(out, 'alpha', 'SKILL.md'))).toBe(true)
    // The report names the sentence, or the entry is an inventory nobody can act on.
    expect(written.report.summary.claims.unmatched[0]!.pattern).toContain('background server')
    expect(written.report.summary.claims.unmatched[1]!.pattern).toContain('it blocks')
  })

  it('moves a section out of a body that is over the audit limit', () => {
    // The 64 KiB body limit is enforced by `inspectSkillRoot()`, and one upstream body
    // was over it. The rule is general rather than a file list, so the fixture is
    // synthetic: it has the shape (a body over budget with a widest `####` section)
    // and not the identity.
    const padding = 'Filler sentence for the oversized section. '.repeat(1600)
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', {
        'SKILL.md': [
          '---',
          'name: alpha',
          'description: A fixture.',
          '---',
          '',
          '# Alpha',
          '',
          '## Workflow',
          '',
          '#### Oversized Detail',
          '',
          padding,
          '',
          '#### Small Detail',
          '',
          'Short.',
          '',
        ].join('\n'),
      })
    })
    const out = join(source, 'out')
    const { report } = run(source, out, ['--write'])

    expect(report.summary.findings['over-body-budget']).toHaveLength(0)
    expect(report.summary.findings.extracted).toHaveLength(1)
    const body = read(out, 'alpha', 'SKILL.md')
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(BODY_LIMIT_BYTES)
    // The pointer names the file, and the file is there with the moved content.
    const extracted = report.summary.findings.extracted[0]!.file
    expect(body).toContain(extracted)
    expect(body).toContain('read it before acting on it')
    expect(existsSync(join(out, 'alpha', extracted))).toBe(true)
    expect(read(out, 'alpha', extracted)).toContain('Filler sentence for the oversized section.')
  })

  it('refuses to write while a hard invariant is unmet', () => {
    // Two kinds refuse a write and the rest only warn. `needs-review` prose must not
    // refuse one: it needs a human sentence, and refusing until every one is rewritten
    // would mean nothing is ever vendored.
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', {
        'SKILL.md': [
          '---',
          'name: alpha',
          'description: A fixture.',
          '---',
          '',
          '# Alpha',
          '',
          'Escalate with `npx hyperframes cloud deploy --project .` when ready.',
          '',
        ].join('\n'),
      })
    })
    const out = join(source, 'out')

    // `cloud` has no prose entry, so its sentence is deleted and reported as
    // needs-review — which must NOT refuse the write.
    const written = run(source, out, ['--write'])
    expect(written.status).toBe(0)
    expect(written.report.summary.findings['needs-review']).toHaveLength(1)
    expect(existsSync(join(out, 'alpha', 'SKILL.md'))).toBe(true)
    expect(read(out, 'alpha', 'SKILL.md')).not.toContain('cloud deploy')
  })

  it('records a reproducible digest of the whole upstream tree', () => {
    // Upstream ships no version and is vendored from an archive, so the digest is the
    // only citable provenance. Two runs over one tree have to agree, or the value in
    // `THIRD_PARTY_NOTICES.md` means nothing.
    const source = makeFixture((root) => {
      writeSkill(root, 'alpha', { 'SKILL.md': '---\nname: alpha\ndescription: A.\n---\n\n# Alpha\n' })
      writeSkill(root, 'beta', { 'SKILL.md': '---\nname: beta\ndescription: B.\n---\n\n# Beta\n' })
    })
    const out = join(source, 'out')
    const first = run(source, out).report.summary.upstream.tree
    const second = run(source, out).report.summary.upstream.tree

    expect(first.digest).toBe(second.digest)
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(first.files).toBe(2)
    // The digest covers the source tree, so a change to a file changes it.
    writeSkill(source, 'beta', { 'SKILL.md': '---\nname: beta\ndescription: B.\n---\n\n# Beta (edited)\n' })
    expect(run(source, out).report.summary.upstream.tree.digest).not.toBe(first.digest)
  })
})
