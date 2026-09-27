/**
 * Regressions for the Taste-Skill vendoring pass.
 *
 * The vendoring passes in this package have shipped defects that their own report
 * called green — a whitespace reflow that took indented examples with it, a site
 * counted twice, a replacement that nested backticks — which is why the sibling spec
 * tests the *output*. This one is smaller because the pass is smaller: this pack is
 * pure prose with no launcher to map, so the rules that can be wrong are the three
 * that touch the text, plus the two refusals that keep an unreadable or shadowed
 * Skill out of a mounted root.
 *
 * The script is exercised as a subprocess, against a fixture checkout rather than
 * the API: a test cannot fetch, and `--source` is the mode a maintainer with a clone
 * uses anyway, so the same rules are driven both ways.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(PACKAGE_ROOT, 'scripts', 'vendor-taste-skills.mjs')

/** The limit `inspectSkillRoot()` reports, restated so the fixture can exceed it. */
const BODY_LIMIT_BYTES = 64 * 1024

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** Write a fixture upstream checkout, and return its root. */
function checkout(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'taste-vendor-source-'))
  temporary.push(root)
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  return root
}

/** A destination under the same temporary root, so nothing is left behind. */
function destination(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'taste-vendor-out-')), 'taste')
  temporary.push(path)
  return path
}

/**
 * Run the pass and read both streams.
 *
 * `spawnSync` rather than `execFileSync`: the latter returns stdout alone, so a
 * refusal — which the script writes to stderr on purpose, keeping stdout parseable —
 * would be invisible here, and a case asserting on a message nobody captured passes
 * for the wrong reason.
 */
function run(args: readonly string[]): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const LICENCE = 'MIT License\n\nCopyright (c) 2026 Leonxlnx\n'

/** A minimal upstream tree: two Skills, one companion document and the index. */
function pack(overrides: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return {
    LICENSE: LICENCE,
    'skills/llms.txt': 'alpha: the fixture index, which is not a Skill\n',
    'skills/alpha/SKILL.md': '---\nname: alpha-design\ndescription: A fixture design skill.\n---\n\n# Alpha\n\nProse.\n',
    'skills/beta/SKILL.md': '---\nname: beta-design\ndescription: Another fixture design skill.\n---\n\n# Beta\n\nProse.\n',
    'skills/beta/DESIGN.md': '# Beta design system\n',
    ...overrides,
  }
}

describe('the Taste-Skill vendoring pass', () => {
  it('writes nothing without --write, and plans the pack it found', () => {
    const source = checkout(pack())
    const out = destination()
    const result = run(['--source', source, '--out', out])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('2 bodies')
    // The index is upstream's own list of the pack, not a Skill: a plan that carried
    // it would mount a file that is not a body and report it as one.
    expect(result.stdout).not.toContain('llms.txt')
    expect(result.stdout).toContain('dry run')
    expect(existsSync(out)).toBe(false)
  })

  it('keeps stdout machine-readable under --json', () => {
    // The sibling pass has shipped a human sentence on stdout beside the report, so
    // every consumer had to guess where the JSON stopped. `--json` means stdout is
    // the report and nothing else.
    const source = checkout(pack())
    const result = run(['--source', source, '--json'])
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as { summary: { skills: number; files: number }, files: readonly { file: string }[] }
    expect(report.summary.skills).toBe(2)
    expect(report.summary.files).toBe(3)
    expect(report.files.map(file => file.file).sort()).toEqual(['alpha/SKILL.md', 'beta/DESIGN.md', 'beta/SKILL.md'])
    expect(result.stderr).toContain('dry run')
  })

  it('writes the bodies, the licence and a provenance digest per written file', () => {
    const source = checkout(pack())
    const out = destination()
    const result = run(['--source', source, '--out', out, '--commit', 'deadbeef', '--date', '2026-09-27', '--write'])
    expect(result.status).toBe(0)
    expect(readFileSync(join(out, 'alpha', 'SKILL.md'), 'utf8')).toContain('# Alpha')
    // The licence is upstream's file rather than a restatement of it, which is what
    // makes the directory self-describing to a licence audit.
    expect(readFileSync(join(out, 'LICENSE'), 'utf8')).toBe(LICENCE)
    const provenance = readFileSync(join(out, 'PROVENANCE.md'), 'utf8')
    expect(provenance).toContain('deadbeef')
    expect(provenance).toContain('Copyright (c) 2026 Leonxlnx')
    // The digest is taken from the bytes written, after the adaptations: that is the
    // pair the shipped spec re-checks, and it can only be true if the pass prices the
    // file it actually wrote.
    const body = readFileSync(join(out, 'alpha', 'SKILL.md'), 'utf8')
    const digest = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
    expect(provenance).toContain(`| \`alpha/SKILL.md\` | ${String(Buffer.byteLength(body, 'utf8'))} | \`${digest}\` |`)
  })

  it('splits a body over the limit instead of shortening it, and links what it moved', () => {
    // The rule is general rather than a list of sections, and the assertion is about
    // the *link*: a section that moved without a pointer is detail the reader cannot
    // find, which is indistinguishable from detail that was deleted.
    const section = (title: string) => `### ${title}\n\n${'- a line of fixture prose that exists to take up space.\n'.repeat(900)}`
    const source = checkout(pack({
      'skills/big/SKILL.md': `---\nname: big-design\ndescription: A fixture whose body is too large.\n---\n\n## Body\n\n${section('Big One')}\n${section('Big Two')}\n`,
    }))
    const out = destination()
    const result = run(['--source', source, '--out', out, '--write'])
    expect(result.status).toBe(0)
    const body = readFileSync(join(out, 'big', 'SKILL.md'), 'utf8')
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(BODY_LIMIT_BYTES)
    expect(body).toContain('This section is kept in')
    expect(body).toContain('references/')
    // The section survives in full next door, and the pointer names where it went.
    const moved = ['big-one', 'big-two'].map(name => join(out, 'big', 'references', `${name}.md`))
    expect(moved.some(path => existsSync(path))).toBe(true)
    const landed = moved.filter(path => existsSync(path)).map(path => readFileSync(path, 'utf8'))
    expect(landed.every(text => text.includes('fixture prose'))).toBe(true)
    expect(readFileSync(join(out, 'PROVENANCE.md'), 'utf8')).toContain('Section moved to')
  })

  it('refuses a body the parser cannot read, rather than mounting a missing entry', () => {
    const source = checkout(pack({ 'skills/gamma/SKILL.md': '---\nname: gamma-design\n---\n\n# Gamma\n\nNo description.\n' }))
    const out = destination()
    const result = run(['--source', source, '--out', out, '--write'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to write')
    expect(result.stdout).toContain('frontmatter has no `description`')
    expect(existsSync(join(out, 'gamma', 'SKILL.md'))).toBe(false)
  })

  it('refuses two Skills that claim one name', () => {
    // The provider keys an entry by its frontmatter name, so the second one is a
    // Skill that is simply not there — a mount the page reports as ready.
    const source = checkout(pack({
      'skills/twin/SKILL.md': '---\nname: beta-design\ndescription: A second skill under a taken name.\n---\n\n# Twin\n',
    }))
    const out = destination()
    const result = run(['--source', source, '--out', out, '--write'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('duplicate-name')
    expect(existsSync(out)).toBe(false)
  })

  it('removes emoji with the vocabulary the other packs use, without reflowing the text', () => {
    // A verdict glyph becomes a word, because a terminal may draw it at double width
    // or as a box; every other glyph is dropped, and only the whitespace immediately
    // around it is collapsed, so an indented example keeps its indentation.
    const source = checkout(pack({
      'skills/alpha/SKILL.md': '---\nname: alpha-design\ndescription: A fixture design skill.\n---\n\n# Alpha\n\nAll good \u2705 here.\n\n- x \u{1F680} y\n\n    indented \u274C example\n',
    }))
    const out = destination()
    run(['--source', source, '--out', out, '--write'])
    const body = readFileSync(join(out, 'alpha', 'SKILL.md'), 'utf8')
    expect(body).toContain('All good PASS here.')
    expect(body).toContain('- x y')
    expect(body).toContain('    indented FAIL example')
    expect(body).not.toMatch(/[\p{Emoji_Presentation}\uFE0F]/u)
  })
})
