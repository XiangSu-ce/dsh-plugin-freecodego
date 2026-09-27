/**
 * The vendored Taste-Skill pack, checked as the tree it is.
 *
 * Two questions this file exists to answer, neither of which the vendoring pass
 * can answer about itself:
 *
 * 1. **Can the provider see these Skills at all.** A `SKILL.md` whose frontmatter
 *    the parser cannot read contributes no entry anywhere, so a pack of thirteen
 *    would render as a shorter list with nothing saying one was dropped. The pass
 *    refuses an unreadable body before writing, and this reads the tree that landed.
 * 2. **Is the tree still the tree the provenance describes.** The pack is the one
 *    place in this package where third-party prose is shipped at upstream length, so
 *    the only thing standing between a well-meaning edit and a body that no longer
 *    matches what the notice attributes is a digest. Every file's SHA-256 is
 *    recorded in `PROVENANCE.md` at vendoring time and re-computed here.
 *
 * The remaining cases are the rules the pass applies, asserted on what it wrote
 * rather than on what it reported: the 64 KiB split that moved five sections out of
 * the flagship body, the no-emoji rule, and the links that make a moved section
 * reachable.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TASTE_FEATURE } from '../src/design/features.ts'
import { engineeringSkillDirectory, parseSkillBrief, starterSkillDirectory, superpowersSkillDirectory } from '../src/engineering.ts'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(PACKAGE_ROOT, 'assets', 'design', 'taste')

/** The limit `inspectSkillRoot()` reports, and the number the split was made for. */
const BODY_LIMIT_BYTES = 64 * 1024

/** `\p{Emoji_Presentation}` plus the variation selector, as `engineering.spec.ts` reads it. */
const EMOJI = /[\p{Emoji_Presentation}\uFE0F]/gu

/** The body of every Skill in the pack, in directory order. */
function bodies(): readonly { readonly directory: string; readonly path: string; readonly text: string }[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ directory: entry.name, path: join(ROOT, entry.name, 'SKILL.md'), text: readFileSync(join(ROOT, entry.name, 'SKILL.md'), 'utf8') }))
    .sort((left, right) => left.directory.localeCompare(right.directory))
}

/** Every file under the pack, forward-slashed, relative to the pack root. */
function filesUnder(current: string, prefix = ''): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...filesUnder(join(current, entry.name), relative))
    else if (entry.isFile()) found.push(relative)
  }
  return found.sort()
}

const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

describe('the vendored Taste-Skill pack', () => {
  it('parses all thirteen bodies into briefs, and the card states that count', () => {
    const skills = bodies()
    // A pack of twelve would make every loop below pass one skill short of the
    // claim on the card, so the count is asserted once against the tree.
    expect(skills.map(skill => skill.directory)).toHaveLength(13)
    for (const skill of skills) {
      const brief = parseSkillBrief(skill.text)
      expect(brief, `${skill.directory}/SKILL.md has no readable frontmatter`).toBeDefined()
      // An entry with an empty description is a Skill the model has no reason to
      // pick and no way to tell apart from its neighbours.
      expect(brief?.description.length, `${skill.directory} carries no description`).toBeGreaterThan(0)
    }
    // The card's number is read off the tree rather than typed beside it, the same
    // pair check the Impeccable row's card carries.
    expect(TASTE_FEATURE.summary).toContain(`${String(skills.length)} 篇`)
    expect(TASTE_FEATURE.skillRoot).toBe('assets/design/taste')
    // A row whose whole installation is prose: the empty list is the shape, and the
    // page reports what registered rather than what was declared.
    expect(TASTE_FEATURE.tools).toEqual([])
  })

  it('names them uniquely across every bundled pack, so two mounts cannot shadow one Skill', () => {
    // The design pack mounts several roots at once, and the engineering packs may be
    // on beside them. A duplicate name is a Skill the model cannot tell apart from
    // another — the failure `skills/collisions.ts` exists for — and it arrives by
    // accident, when a vendored pack happens to reuse a word.
    const roots = [
      ROOT,
      join(PACKAGE_ROOT, 'assets', 'design', 'react-bits'),
      join(PACKAGE_ROOT, 'assets', 'design', 'skills'),
      starterSkillDirectory(),
      engineeringSkillDirectory(),
      superpowersSkillDirectory(),
    ]
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const root of roots) {
      if (!existsSync(root)) continue
      for (const path of filesUnder(root)) {
        if (!path.endsWith('SKILL.md')) continue
        const brief = parseSkillBrief(readFileSync(join(root, path), 'utf8'))
        if (brief === undefined) continue
        const owner = `${root.replace(/\\/gu, '/').split('/assets/')[1] ?? root}/${path}`
        const previous = seen.get(brief.name)
        if (previous !== undefined) duplicates.push(`${brief.name}: ${previous} and ${owner}`)
        else seen.set(brief.name, owner)
      }
    }
    expect(duplicates).toEqual([])
    expect(seen.has('design-taste-frontend')).toBe(true)
  })

  it('keeps every body under the limit that made one of them split', () => {
    // The flagship body is 87 KB upstream. It ships as 62 KB plus five linked
    // sections, because `inspectSkillRoot()` reports a body over 64 KiB and both
    // vendoring passes in this package treat that number as a rule rather than as a
    // warning to live with.
    for (const skill of bodies()) {
      const bytes = Buffer.byteLength(skill.text, 'utf8')
      expect(bytes, `${skill.directory}/SKILL.md is ${String(bytes)} bytes`).toBeLessThanOrEqual(BODY_LIMIT_BYTES)
    }
  })

  it('ships no emoji, which is the rule the pass applies to every vendored pack', () => {
    // The sweep in `engineering.spec.ts` covers the three engineering roots, so this
    // is the design pack's own version of it — the rule belongs to the vendoring
    // pass, and a re-sync that reintroduces a glyph would otherwise arrive silently.
    const offences: string[] = []
    for (const path of filesUnder(ROOT)) {
      const text = readFileSync(join(ROOT, path), 'utf8')
      for (const match of text.matchAll(EMOJI)) offences.push(`${path}: ${match[0]}`)
    }
    expect(offences).toEqual([])
  })

  it('links every moved section, and leaves no orphan in references/', () => {
    // A split body is the only place a reader can be sent to a file that is not
    // there, and the reverse — a file nothing points at — is detail that was moved
    // and then lost, which reads exactly like detail that was deleted.
    const skills = bodies()
    const linked = new Set<string>()
    for (const skill of skills) {
      for (const match of skill.text.matchAll(/references\/[a-z0-9.-]+\.md/gu)) linked.add(`${skill.directory}/${match[0]}`)
    }
    const onDisk = filesUnder(ROOT).filter(path => path.includes('/references/'))
    expect(onDisk.length).toBeGreaterThan(0)
    for (const path of onDisk) expect(linked.has(path), `${path} is not linked from its body`).toBe(true)
    for (const path of linked) expect(onDisk.includes(path), `${path} is linked but missing`).toBe(true)
  })

  it('matches every digest in PROVENANCE.md, so an edit to a vendored body is caught', () => {
    // The notice attributes a snapshot, and this is what makes the attribution
    // checkable: the digests were taken from the bytes written, so a hand edit to a
    // body — the one change that would make the notice false — fails here rather
    // than shipping as if it were upstream.
    const provenance = readFileSync(join(ROOT, 'PROVENANCE.md'), 'utf8')
    const rows = [...provenance.matchAll(/^\| `([^`]+)` \| (\d+) \| `([0-9a-f]{64})` \|$/gmu)]
      .map(match => ({ file: match[1]!, bytes: Number(match[2]), sha256: match[3]! }))
    expect(rows.length).toBeGreaterThan(0)
    const described = rows.map(row => row.file).sort()
    const shipped = filesUnder(ROOT).filter(path => path !== 'PROVENANCE.md' && path !== 'LICENSE')
    expect(described).toEqual([...shipped].sort())
    for (const row of rows) {
      const text = readFileSync(join(ROOT, row.file), 'utf8')
      expect(Buffer.byteLength(text, 'utf8'), row.file).toBe(row.bytes)
      expect(sha256(text), row.file).toBe(row.sha256)
    }
    // The licence travels with the text it covers, and it is upstream's own file
    // rather than a restatement of it.
    const licence = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
    expect(licence).toContain('MIT License')
    expect(licence).toContain('Copyright (c) 2026 Leonxlnx')
  })
})
