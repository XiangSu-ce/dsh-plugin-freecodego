/**
 * Regressions for the Impeccable guidance vendoring pass.
 *
 * The defects this class of script ships are the ones its own report cannot see:
 * text that is still valid markdown, still passes every audit, and no longer says
 * what it meant. The sibling pass over the HyperFrames pack shipped four of those
 * before anyone read its output — reflowed whitespace, doubled findings, nested
 * backticks, a swallowed code span — so each rule here is pinned against a fixture
 * that reproduces the *shape* rather than against the real upstream pack, which
 * changes with every sync.
 *
 * The two claims specific to this pack are the ones worth reading twice:
 *
 *  - **Prose and code are handled differently.** A launcher verb in a sentence
 *    becomes a sentence; in a fenced block it stays a command or refuses the write,
 *    because a code block is an instruction and turning one into English would ship
 *    something nobody can run.
 *  - **A false sentence is corrected, not deleted.** Upstream's Setup step explains
 *    what to do when the launcher fails, which cannot happen here; the surrounding
 *    instruction has to survive, or the reader loses a step instead of a claim.
 *
 * The script is exercised as a subprocess rather than imported: it *is* a command,
 * its contract is its arguments and its exit code, and importing it would run `main`.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/vendor-impeccable
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(PACKAGE_ROOT, 'scripts', 'vendor-impeccable.mjs')

/** The limit `inspectSkillRoot()` enforces, restated so a fixture can exceed it. */
const BODY_LIMIT_BYTES = 64 * 1024

interface Finding {
  readonly file: string
  readonly text: string
  readonly kind?: string
}

interface Report {
  readonly summary: {
    readonly upstream: { readonly tree: { readonly digest: string; readonly files: number } }
    readonly kept: { readonly files: number; readonly bytes: number }
    readonly dropped: { readonly files: number; readonly byReason: readonly (readonly [string, number])[] }
    readonly changedFiles: number
    readonly findings: {
      readonly mapped: readonly Finding[]
      readonly 'removed-line': readonly Finding[]
      readonly 'replaced-invocation': readonly Finding[]
      readonly 'prose-rewritten': readonly Finding[]
      readonly 'needs-review': readonly Finding[]
      readonly 'unmapped-invocation': readonly Finding[]
      readonly 'project-artifacts': readonly Finding[]
      readonly extracted: readonly Finding[]
      readonly 'over-body-budget': readonly Finding[]
      readonly 'claim-repaired': readonly Finding[]
    }
    readonly claims: {
      readonly repaired: readonly Finding[]
      readonly unmatched: readonly { readonly id: string; readonly pattern: string }[]
    }
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A checkout whose `.dsh/skills/impeccable/` holds the given files. */
function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'freecodego-vendor-impeccable-'))
  roots.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, '.dsh', 'skills', 'impeccable', relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return root
}

/**
 * Run the script and parse its report.
 *
 * `--out` is always passed, and that is a safety rule rather than tidiness: the
 * default destination is the package's real `assets/design/impeccable`, so a
 * `--write` case that forgot it would overwrite the shipped pack from inside a test.
 */
function run(source: string, out: string, extra: readonly string[] = []): { report: Report | undefined; status: number; stderr: string } {
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
  // document needs no delimiter and no trailer to be located — and a run that
  // never started has no document at all, which the cases about refusals read as
  // `undefined` rather than as a parse failure.
  return { report: stdout.trim() === '' ? undefined : JSON.parse(stdout) as Report, status, stderr }
}

const read = (out: string, file: string) => readFileSync(join(out, file), 'utf8')

/** A minimal body, so the cases below differ only in what they are about. */
const BODY = ['---', 'name: impeccable', 'description: A fixture.', '---', '', '# Impeccable', ''].join('\n')

/**
 * A run that produced a report.
 *
 * Every case but the refusal one reads the report, and an `undefined` there would
 * be a failure of the script rather than of the assertion — so this is where that
 * is said, once.
 */
const reported = (result: { readonly report: Report | undefined }): Report => {
  expect(result.report).toBeDefined()
  return result.report as Report
}

describe('vendoring the Impeccable guidance pack', () => {
  it('writes nothing on a dry run, and nothing but the report under --json', () => {
    const source = fixture({ 'SKILL.md': BODY, 'reference/audit.md': '# Audit\n' })
    const out = join(source, 'out')
    const result = run(source, out)
    expect(result.status).toBe(0)
    expect(existsSync(out)).toBe(false)
    expect(reported(result).summary.kept.files).toBe(2)
    expect(reported(result).summary.changedFiles).toBe(0)
  })

  it('drops the launcher and its engine, and says so by class', () => {
    // The scripts tree is what this pack will never invoke, and it is also what
    // `dangerousCommandFindings` exists to catch — so it is dropped as a class
    // rather than excluded file by file.
    const source = fixture({
      'SKILL.md': BODY,
      'scripts/impeccable': '#!/bin/sh\n',
      'scripts/impeccable.cmd': '@echo off\n',
      'scripts/notes.txt': 'kept nowhere\n',
    })
    const report = reported(run(source, join(source, 'out')))

    expect(report.summary.kept.files).toBe(1)
    expect(report.summary.dropped.files).toBe(3)
    // One class, counted by reason: everything under `scripts/` is the launcher
    // tree, including the file that happens to be prose, because the alternative is
    // a rule that has to name each upstream file it means.
    expect(report.summary.dropped.byReason).toEqual([
      ['the launcher tree (binaries, shims, and whatever sits beside them)', 3],
    ])
  })

  it('removes emoji without reflowing the whitespace around them', () => {
    // Collapsing every run of spaces is invisible in a report and visible in every
    // example in the file: it took indented blocks and ASCII diagrams with it.
    const source = fixture({
      'SKILL.md': [
        '---', 'name: impeccable', 'description: A fixture.', '---', '',
        '# Impeccable', '',
        'Steps:', '',
        '```text',
        '    indented example    with inner spacing',
        '```', '',
        '| Column A      | Column B        |',
        '| ------------- | --------------- |', '',
        'Verdict: \u274C because the source was stale.', '',
      ].join('\n'),
    })
    const out = join(source, 'out')
    run(source, out, ['--write'])

    const body = read(out, 'SKILL.md')
    expect(body).not.toMatch(/\p{Emoji_Presentation}|\uFE0F|\u200D/u)
    expect(body).toContain('    indented example    with inner spacing')
    expect(body).toContain('| Column A      | Column B        |')
    expect(body).toContain('Verdict: FAIL because the source was stale.')
  })

  it('maps the detector to this pack\u2019s tool and replaces the launcher\u2019s other verbs', () => {
    // Every spelling of the launcher: the `<skill-base-dir>` form the playbooks use,
    // the Windows `.cmd` fallback, and a bare `scripts/` path.
    const source = fixture({
      'SKILL.md': [
        '---', 'name: impeccable', 'description: A fixture.', '---', '',
        '# Impeccable', '',
        'Run `<skill-base-dir>/scripts/impeccable detect src/App.tsx --json` to see what the detector says.', '',
        'On Windows, call `.dsh/skills/impeccable/scripts/impeccable.cmd detect src/App.tsx` instead.', '',
        'Run `scripts/impeccable context --target src/App.tsx` once per session, and keep cwd at the user project.', '',
      ].join('\n'),
    })
    const out = join(source, 'out')
    const report = reported(run(source, out, ['--write']))
    const body = read(out, 'SKILL.md')

    expect(report.summary.findings.mapped).toHaveLength(2)
    expect(report.summary.findings['prose-rewritten']).toHaveLength(1)
    expect(body).toContain('Run `freecodego_design_detect` to see what the detector says.')
    expect(body).toContain('call `freecodego_design_detect` instead.')
    // The sentence around the replaced verb is replaced whole, and that is the
    // point of sentence-level substitution: the argument run does not survive as a
    // flag naming a tool schema field that does not exist, and the reader gets a
    // step they can take — read the project context directly — rather than a
    // sentence with a hole where the launcher used to be.
    expect(body).toContain('This pack has no context launcher')
    expect(body).toContain('read the project PRODUCT.md and DESIGN.md directly')
    expect(body).not.toContain('--target')
    expect(body).not.toContain('scripts/impeccable')
  })

  it('leaves a fenced launcher command alone, and refuses to write over it', () => {
    // A code fence is an instruction, not prose. `detect` is rewritten in place
    // because this pack answers it; anything else is reported and blocks the write,
    // because a command block this pack cannot run needs a person to decide what
    // the example becomes.
    const source = fixture({
      'SKILL.md': [
        '---', 'name: impeccable', 'description: A fixture.', '---', '',
        '# Impeccable', '',
        '```sh',
        '<skill-base-dir>/scripts/impeccable detect src/App.tsx',
        '```', '',
        '```sh',
        '<skill-base-dir>/scripts/impeccable live',
        '```', '',
      ].join('\n'),
    })
    const out = join(source, 'out')
    const result = run(source, out, ['--write'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to write')
    expect(existsSync(out)).toBe(false)
    const report = reported(result)
    expect(report.summary.findings.mapped).toHaveLength(1)
    expect(report.summary.findings['unmapped-invocation']).toHaveLength(1)
    expect(report.summary.findings['unmapped-invocation'][0]?.text).toContain('live')
  })

  it('rewrites a fenced detector invocation inside the block it sits in', () => {
    const source = fixture({
      'SKILL.md': ['---', 'name: impeccable', 'description: A fixture.', '---', '', '# Impeccable', '', '```sh', '<skill-base-dir>/scripts/impeccable detect src/App.tsx', '```', ''].join('\n'),
    })
    const out = join(source, 'out')
    expect(run(source, out, ['--write']).status).toBe(0)

    const body = read(out, 'SKILL.md')
    expect(body).toContain('```sh\nfreecodego_design_detect\n```')
  })

  it('corrects the launcher-failure sentence instead of deleting the step', () => {
    const source = fixture({
      'SKILL.md': [
        '---', 'name: impeccable', 'description: A fixture.', '---', '',
        '# Impeccable', '',
        '**Launcher unavailable:** On refusal or failure, send a separate message before the next tool call: "Context loading did not run; I\'ll read the existing project context directly." Then read existing PRODUCT.md and DESIGN.md without inventing missing context.', '',
      ].join('\n'),
    })
    const out = join(source, 'out')
    const report = reported(run(source, out, ['--write']))
    const body = read(out, 'SKILL.md')

    expect(report.summary.claims.repaired).toHaveLength(1)
    expect(report.summary.claims.unmatched).toEqual([])
    expect(body).toContain('**No launcher here:**')
    expect(body).not.toContain('Launcher unavailable')
    // The instruction the reader was about to follow survives the correction.
    expect(body).toContain('never invents what they are missing')
  })

  it('reports a claim repair that could not apply, without refusing the write', () => {
    const source = fixture({ 'SKILL.md': BODY })
    const out = join(source, 'out')
    const result = run(source, out, ['--write'])
    const report = reported(result)

    expect(result.status).toBe(0)
    expect(report.summary.claims.repaired).toHaveLength(0)
    // The entry is named with its pattern, or it is an inventory nobody can act on.
    expect(report.summary.claims.unmatched.map(entry => entry.id)).toEqual(['launcher-unavailable'])
    expect(report.summary.claims.unmatched[0]?.pattern).toContain('Launcher unavailable')
    expect(existsSync(join(out, 'SKILL.md'))).toBe(true)
  })

  it('reports a project artifact this pack does not write, without refusing the write', () => {
    // Upstream records what it learned in `.impeccable/`; a vendored playbook that
    // tells the model to write one is naming a step this pack cannot take, and the
    // remedy is a sentence about this pack's artifacts rather than a substitution.
    const source = fixture({
      'SKILL.md': [...BODY.trimEnd().split('\n'), '', 'Record the critique history in `.impeccable/critique/` as you go.', ''].join('\n'),
    })
    const out = join(source, 'out')
    const result = run(source, out, ['--write'])

    expect(result.status).toBe(0)
    expect(reported(result).summary.findings['project-artifacts']).toHaveLength(1)
    expect(read(out, 'SKILL.md')).toContain('.impeccable/critique/')
  })

  it('moves a section out of a body that is over the audit limit', () => {
    const padding = 'Filler sentence for the oversized section. '.repeat(1_600)
    const source = fixture({
      'SKILL.md': [
        '---', 'name: impeccable', 'description: A fixture.', '---', '',
        '# Impeccable', '',
        '## Workflow', '',
        '#### Oversized Detail', '',
        padding, '',
        '#### Small Detail', '',
        'Short.', '',
      ].join('\n'),
    })
    const out = join(source, 'out')
    const report = reported(run(source, out, ['--write']))

    expect(report.summary.findings['over-body-budget']).toHaveLength(0)
    expect(report.summary.findings.extracted).toHaveLength(1)
    const body = read(out, 'SKILL.md')
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(BODY_LIMIT_BYTES)
    const extracted = report.summary.findings.extracted[0]!.file
    expect(body).toContain(extracted)
    expect(body).toContain('read it before acting on it')
    // The moved section lives under `reference/`, which is where the playbooks that
    // link it already point.
    expect(extracted.startsWith('reference/')).toBe(true)
    expect(read(out, extracted)).toContain('Filler sentence for the oversized section.')
  })

  it('records a reproducible digest, and a provenance table with the snapshot commit', () => {
    const source = fixture({ 'SKILL.md': BODY, 'reference/audit.md': '# Audit\n' })
    const out = join(source, 'out')
    const first = reported(run(source, out)).summary.upstream.tree
    const second = reported(run(source, out)).summary.upstream.tree
    expect(first.digest).toBe(second.digest)
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(first.files).toBe(2)

    const written = run(source, out, ['--write', '--commit', 'abc1234', '--date', '2026-09-27'])
    expect(written.status).toBe(0)
    const provenance = read(out, 'PROVENANCE.md')
    expect(provenance).toContain('`abc1234`')
    expect(provenance).toContain('2026-09-27')
    expect(provenance).toContain(`sha256:${first.digest}`)
    expect(provenance).toContain('| `SKILL.md` | `')
    // Provenance without a commit is not written: an audit has nothing to read.
    rmSync(out, { recursive: true, force: true })
    run(source, out, ['--write'])
    expect(existsSync(join(out, 'PROVENANCE.md'))).toBe(false)
  })

  it('refuses a source directory that has no DSH-shaped skill, and explains', () => {
    const root = mkdtempSync(join(tmpdir(), 'freecodego-vendor-impeccable-'))
    roots.push(root)
    const result = run(root, join(root, 'out'), [])
    expect(result.status).toBe(2)
    expect(result.report).toBeUndefined()
    expect(result.stderr).toContain('.dsh/skills/impeccable')
  })
})
