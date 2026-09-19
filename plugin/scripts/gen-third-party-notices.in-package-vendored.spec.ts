/**
 * In-package vendored source, the second kind of copy `THIRD_PARTY_NOTICES.md`
 * has to disclose.
 *
 * A copy under `vendor/` is published as its own package with its `LICENSE`
 * beside it. A copy inside a package's `src/` is not: the package publishes only
 * its compiled `lib/`, so the compiled copy reaches a consumer with no upstream
 * notice travelling beside it, and this table is the only disclosure that gets
 * there. That asymmetry is why the record is parsed strictly enough to fail on a
 * missing row rather than quietly disclosing less.
 *
 * These live apart from the generator's own spec because the record's format is
 * this seam's whole contract; splitting them keeps each spec readable.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseInPackageVendored } from './gen-third-party-notices.ts'

const root = resolve(import.meta.dirname, '..')
const ENGINE_DIRECTORY = 'packages/freecodego/harness-ui/src/client/companion/engine/'
const NOTICES = 'THIRD_PARTY_NOTICES.md'

describe('parseInPackageVendored', () => {
  it('reads the committed provenance record', () => {
    const row = parseInPackageVendored(
      ENGINE_DIRECTORY,
      readFileSync(resolve(root, `${ENGINE_DIRECTORY}PROVENANCE.md`), 'utf8'),
    )
    expect(row).toEqual({
      directory: ENGINE_DIRECTORY,
      origin: 'jeremy-prt/bloub',
      upstream: 'https://github.com/jeremy-prt/bloub',
      license: 'MIT',
    })
  })

  it('fails loud when the record loses a row, instead of disclosing less', () => {
    expect(() => parseInPackageVendored(ENGINE_DIRECTORY, '| Project | `bloub` |\n'))
      .toThrow('has no Repository row')
    expect(() => parseInPackageVendored(ENGINE_DIRECTORY, '| Repository | https://github.com/a/b |\n'))
      .toThrow('has no License row')
  })

  it('refuses a repository URL it cannot name an origin from', () => {
    // The notices name the origin from this row, so a URL it cannot read is a
    // record that would render an empty origin rather than a wrong one.
    expect(() => parseInPackageVendored(ENGINE_DIRECTORY, '| Repository | git@github.com:a/b.git |\n| License | MIT |\n'))
      .toThrow('only a plain https://github.com/owner/repo URL is machine-readable')
  })

  it('reads a trailing slash and a bare owner/repo URL as the same origin', () => {
    expect(parseInPackageVendored('x/', '| Repository | https://github.com/owner/repo/ |\n| License | MIT |\n').origin)
      .toBe('owner/repo')
  })

  it('covers every in-package copy, so no copy can drop out of the notices', () => {
    // The tree is the authority here for the same reason it is under `vendor/`:
    // a copy is disclosed because its provenance record is on disk, not because
    // someone remembered to add a row.
    const onDisk = globSync('packages/*/*/src/**/PROVENANCE.md', { cwd: root })
      .map(path => path.replaceAll('\\', '/').replace(/PROVENANCE\.md$/, ''))
      .sort()
    expect(onDisk.length).toBeGreaterThan(0)
    const committed = readFileSync(resolve(root, NOTICES), 'utf8')
    for (const directory of onDisk) expect(committed).toContain(`[\`${directory}\`](${directory})`)
  })

  it('keeps the copy\u2019s own LICENSE beside it, since the artifact cannot carry one', () => {
    const onDisk = globSync('packages/*/*/src/**/PROVENANCE.md', { cwd: root })
      .map(path => path.replaceAll('\\', '/').replace(/PROVENANCE\.md$/, ''))
    for (const directory of onDisk) expect(() => readFileSync(resolve(root, `${directory}LICENSE`), 'utf8')).not.toThrow()
  })
})
