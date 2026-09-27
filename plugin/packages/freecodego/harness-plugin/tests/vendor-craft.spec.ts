/**
 * Regressions for the craft vendoring pass.
 *
 * The pass has four rules that can be wrong in ways its own report would call
 * green — a glyph named in the wrong place, a register that drifted from the tree,
 * a file whose name no caller could reach, a section with no title — plus the
 * refusal that keeps all four out of a shipped root. This spec drives the script as
 * a subprocess against a fixture checkout: a test cannot fetch, and `--source` is
 * the mode a maintainer with a clone uses anyway, so the same rules run both ways.
 *
 * The refusals matter more here than in the sibling packs, because the craft layer
 * has no frontmatter and no mount: a file that lands wrong is a *slug* — the thing
 * a caller asks for by name — and a wrong slug is a rule believed to be in force.
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
const SCRIPT = join(PACKAGE_ROOT, 'scripts', 'vendor-craft.mjs')

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** Write a fixture upstream checkout, and return its root. */
function checkout(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'craft-vendor-source-'))
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
  const path = join(mkdtempSync(join(tmpdir(), 'craft-vendor-out-')), 'craft')
  temporary.push(path)
  return path
}

/**
 * Run the pass and read both streams.
 *
 * `spawnSync` rather than `execFileSync`: the latter returns stdout alone, so a
 * refusal — written to stderr on purpose, keeping stdout parseable — would be
 * invisible here, and a case asserting on a message nobody captured passes for the
 * wrong reason.
 */
function run(args: readonly string[]): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const LICENCE = 'Apache License\nVersion 2.0, January 2004\n'

/** A minimal upstream tree: two sections, the register and the layer's README. */
function layer(overrides: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return {
    LICENSE: LICENCE,
    'package.json': JSON.stringify({ name: 'fixture', version: '9.9.9' }),
    'craft/README.md': '# Craft references\n\nFixture prose about the layer.\n',
    'craft/FUTURE_SECTIONS.md': '# Future Craft Sections\n\n- motion-discipline\n',
    'craft/alpha.md': '# Alpha craft rules\n\nProse.\n',
    'craft/beta.md': '# Beta craft rules\n\nSome prose, then a tell: \u2728 here.\n',
    ...overrides,
  }
}

describe('the craft vendoring pass', () => {
  it('writes nothing without --write, and plans the layer it found', () => {
    const source = checkout(layer())
    const out = destination()
    const result = run(['--source', source, '--out', out])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('2 sections')
    expect(result.stdout).toContain('alpha')
    // The companions are part of the layer's prose but not sections of it: a plan
    // that counted them would report a section no caller can ask for by slug.
    expect(result.stdout).toContain('companion')
    expect(result.stdout).toContain('dry run')
    expect(existsSync(out)).toBe(false)
  })

  it('keeps stdout machine-readable under --json', () => {
    const source = checkout(layer())
    const result = run(['--source', source, '--json'])
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as { summary: { sections: number; files: number; forward: readonly string[] }; files: readonly { file: string }[] }
    expect(report.summary.sections).toBe(2)
    expect(report.summary.files).toBe(4)
    expect(report.summary.forward).toEqual(['motion-discipline'])
    expect(report.files.map(file => file.file).sort()).toEqual(['FUTURE_SECTIONS.md', 'README.md', 'alpha.md', 'beta.md'])
    expect(result.stderr).toContain('dry run')
  })

  it('writes the sections, the licence and a provenance digest per written file', () => {
    const source = checkout(layer())
    const out = destination()
    const result = run(['--source', source, '--out', out, '--date', '2026-09-27', '--write'])
    expect(result.status).toBe(0)
    expect(readFileSync(join(out, 'alpha.md'), 'utf8')).toContain('# Alpha craft rules')
    // The licence is upstream's own file rather than a restatement of it, which is
    // what makes the directory self-describing to a licence audit.
    expect(readFileSync(join(out, 'LICENSE'), 'utf8')).toBe(LICENCE)
    const provenance = readFileSync(join(out, 'PROVENANCE.md'), 'utf8')
    // A tarball has no commit to cite, so the version is what a reader can check —
    // and the provenance says which of the two it is rather than leaving it blank.
    expect(provenance).toContain('9.9.9')
    expect(provenance).toContain('unrecorded')
    expect(provenance).toContain('motion-discipline')
    const body = readFileSync(join(out, 'alpha.md'), 'utf8')
    const digest = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')
    // The digest is taken from the bytes written, after the one adaptation: that is
    // the pair the shipped spec re-checks, and it can only hold if the pass prices
    // the file it actually wrote.
    expect(provenance).toContain(`| \`alpha.md\` | ${String(Buffer.byteLength(body, 'utf8'))} | \`${digest}\` |`)
  })

  it('names the six glyphs a rule is about instead of drawing them', () => {
    // `anti-ai-slop.md` names glyphs as tells, so deleting them would delete what the
    // rule is about. The substitution is the one that keeps the rule able to say
    // which glyphs it means without shipping an emoji-presentation glyph.
    const source = checkout(layer({
      'craft/beta.md': '# Beta craft rules\n\nNever use \u2728, \u{1F680} or \u26A1 as icons.\n',
    }))
    const out = destination()
    const result = run(['--source', source, '--out', out, '--write'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('glyph-named')
    const body = readFileSync(join(out, 'beta.md'), 'utf8')
    expect(body).toContain('Never use `U+2728 SPARKLES`, `U+1F680 ROCKET` or `U+26A1 HIGH VOLTAGE` as icons.')
    expect(body).not.toMatch(/[\p{Emoji_Presentation}\uFE0F]/u)
    expect(readFileSync(join(out, 'PROVENANCE.md'), 'utf8')).toContain('U+1F680 ROCKET')
  })

  it('refuses a glyph it has no name for, rather than deleting text it cannot account for', () => {
    // The pass knows six glyphs because a rule in this layer writes them down. Any
    // other one is text whose meaning nobody has written a word for, and a silent
    // deletion is a body that no longer says what the notice attributes.
    const source = checkout(layer({ 'craft/beta.md': '# Beta craft rules\n\nUse \u{1F984} freely.\n' }))
    const out = destination()
    const result = run(['--source', source, '--out', out, '--write'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to write')
    expect(result.stdout).toContain('unnamed-emoji')
    expect(existsSync(out)).toBe(false)
  })

  it('refuses a register that still lists a slug which ships', () => {
    // A stale register is what would make the tool tell a caller a section is
    // unavailable while it sits on disk, so the pass treats it as a defect rather
    // than as a note: the register and the tree have to agree in both directions.
    const source = checkout(layer({ 'craft/FUTURE_SECTIONS.md': '# Future Craft Sections\n\n- alpha\n- typographic-rhythm\n' }))
    const out = destination()
    const result = run(['--source', source, '--out', out, '--write'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('stale-register')
    expect(existsSync(out)).toBe(false)
  })

  it('refuses a section no caller could ask for, and a section with no title', () => {
    const unreachable = checkout(layer({ 'craft/Not-A-Slug.md': '# Whatever\n\nProse.\n' }))
    const outOne = destination()
    const first = run(['--source', unreachable, '--out', outOne, '--write'])
    expect(first.status).toBe(1)
    expect(first.stdout).toContain('unreachable-slug')
    expect(existsSync(outOne)).toBe(false)

    const untitled = checkout(layer({ 'craft/gamma.md': 'Prose with no heading at all.\n' }))
    const outTwo = destination()
    const second = run(['--source', untitled, '--out', outTwo, '--write'])
    expect(second.status).toBe(1)
    expect(second.stdout).toContain('no-title')
    expect(existsSync(outTwo)).toBe(false)
  })
})
