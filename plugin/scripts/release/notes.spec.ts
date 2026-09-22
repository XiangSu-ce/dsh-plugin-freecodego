/** Cover the release-notes extractor: which heading is a version's, and what counts as its notes. */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANGELOG_CANDIDATES, changelogPath, sectionFor } from './notes.ts'

const DOCUMENT = [
  '# Changelog',
  '',
  'Preamble prose that belongs to no version.',
  '',
  '## 0.1.6-alpha.2.2 — 2026-09-23',
  '',
  '### Fixed',
  '',
  '- The second thing.',
  '',
  '## 0.1.6-alpha.2.1 — 2026-09-23',
  '',
  '- The first thing.',
  '',
  '## 0.1.6-alpha.2 — 2026-09-23',
  '',
  '- The earliest thing.',
  '',
].join('\n')

describe('sectionFor', () => {
  it('returns one version\u2019s body without its heading', () => {
    expect(sectionFor(DOCUMENT, '0.1.6-alpha.2.1')).toBe('- The first thing.')
  })

  it('keeps the groups a section is written with, and drops the heading of the next version', () => {
    const notes = sectionFor(DOCUMENT, '0.1.6-alpha.2.2')

    expect(notes).toContain('### Fixed')
    expect(notes).toContain('- The second thing.')
    expect(notes).not.toContain('0.1.6-alpha.2.1')
    expect(notes).not.toContain('Preamble prose')
  })

  it('does not answer a shorter version with a longer one\u2019s section', () => {
    // The trap the boundary in the pattern exists for: `0.1.6-alpha.2` is a
    // prefix of `0.1.6-alpha.2.1`, so a substring match would publish the wrong
    // version's notes under the right version's tag.
    const onlyLonger = '## 0.1.6-alpha.2.1\n\n- Notes for the longer version.\n'

    expect(sectionFor(onlyLonger, '0.1.6-alpha.2')).toBeUndefined()
    expect(sectionFor(onlyLonger, '0.1.6-alpha.2.1')).toBe('- Notes for the longer version.')
  })

  it('accepts the headings a release is written with', () => {
    for (const heading of [
      '## 0.1.6-alpha.2.2',
      '## v0.1.6-alpha.2.2',
      '## freecodego-v0.1.6-alpha.2.2',
      '## 0.1.6-alpha.2.2 - 2026-09-23',
      '## 0.1.6-alpha.2.2 (2026-09-23)',
    ]) {
      expect(sectionFor(`${heading}\n\n- Something.\n`, '0.1.6-alpha.2.2')).toBe('- Something.')
    }
  })

  it('treats a heading with no body as no section', () => {
    expect(sectionFor('## 0.1.6-alpha.2.2\n\n## 0.1.6-alpha.2.1\n\n- Something.\n', '0.1.6-alpha.2.2')).toBeUndefined()
  })

  it('returns notes with no carriage returns, because a Windows checkout writes CRLF', () => {
    const crlf = DOCUMENT.replaceAll('\n', '\r\n')

    expect(sectionFor(crlf, '0.1.6-alpha.2')).toBe('- The earliest thing.')
  })
})

describe('the changelog this repository publishes', () => {
  it('is looked for in both layouts, one of which every tree has', () => {
    // The private tree keeps the published root face in `public/`; the published
    // tree has it at its root. A tree that has neither is a release that cannot
    // say what it contains, so both names are looked for by name.
    const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..')

    expect(CHANGELOG_CANDIDATES).toEqual([
      resolve(repositoryRoot, 'public', 'CHANGELOG.md'),
      resolve(repositoryRoot, 'CHANGELOG.md'),
    ])
    expect(existsSync(changelogPath())).toBe(true)
  })

  it('carries a section for every version the repository has released', () => {
    const source = readFileSync(changelogPath(), 'utf8')

    expect(sectionFor(source, '0.1.6-alpha.2.2')).toContain('free-model tables')
    expect(sectionFor(source, '0.1.6-alpha.2.1')).not.toBeUndefined()
    expect(sectionFor(source, '0.1.6-alpha.2')).not.toBeUndefined()
  })
})
