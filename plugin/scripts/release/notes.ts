/**
 * Print the section of the repository changelog that belongs to one version, for
 * the release to carry as its notes.
 *
 * Why the notes are read from a file instead of written by the run: this
 * repository's public history is one `release:` commit per version, so the notes
 * GitHub generates from it would restate a commit subject, and the private record
 * of what was fixed lives in a tree that is never published. The changelog is the
 * one place that says, in the release's own words, what changed — so a version
 * with no section in it is refused here rather than published under notes that
 * describe some other version.
 *
 * Usage:
 *   tsx scripts/release/notes.ts --version 0.1.6-alpha.2.2           # print the notes
 *   tsx scripts/release/notes.ts --version 0.1.6-alpha.2.2 --check   # report only, print no notes
 *   tsx scripts/release/notes.ts --version 0.1.6-alpha.2.2 --out notes.md
 *   tsx scripts/release/notes.ts --version <version> --file <path>   # another changelog
 *
 * @module scripts/release/notes
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from './process.ts'

/**
 * The changelog a release reads, in the order the two layouts are tried.
 *
 * The published repository's root face is the root here and `public/` in the
 * private tree, so neither tree carries both paths and no single relative name
 * serves both: a release reads whichever this tree has. Reading the published
 * layout first would be the other way round, and both are named so a tree with
 * neither says which two files it looked for.
 */
export const CHANGELOG_CANDIDATES: readonly string[] = [
  resolve(import.meta.dirname, '..', '..', '..', 'public', 'CHANGELOG.md'),
  resolve(import.meta.dirname, '..', '..', '..', 'CHANGELOG.md'),
]

/**
 * The changelog this tree has.
 * @returns The first candidate that exists.
 */
export function changelogPath(): string {
  const found = CHANGELOG_CANDIDATES.find(candidate => existsSync(candidate))
  if (found === undefined) {
    throw new Error(`no changelog in this tree — looked for ${CHANGELOG_CANDIDATES.join(' and ')}`)
  }
  return found
}

/**
 * The heading that opens a version's section.
 *
 * The version must end at a heading boundary, which is what keeps a shorter
 * version from answering with a longer one's section: without the boundary,
 * asking for `0.1.6-alpha.2` would match the heading for `0.1.6-alpha.2.1`.
 * @param version - the version to look for.
 * @returns A pattern matching that version's level-2 heading.
 */
function headingPattern(version: string): RegExp {
  const escaped = version.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^##[ \\t]+(?:freecodego-)?v?${escaped}(?=$|[ \\t]|[—–(])`, 'u')
}

/**
 * Read one version's section out of a changelog.
 *
 * Only level-2 headings open or close a section, so the `###` groups a section
 * is written with stay inside it. Line endings are normalized on the way in: a
 * Windows checkout writes this file with CRLF, and notes carrying a stray `\r`
 * would be a release whose text differs from the file it came from.
 * @param source - the whole changelog.
 * @param version - the version whose section is wanted.
 * @returns The section's text without its heading, or undefined when the version
 *   has no section, or has one with no text under it.
 */
export function sectionFor(source: string, version: string): string | undefined {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const pattern = headingPattern(version)
  const start = lines.findIndex(line => pattern.test(line))
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^##[ \t]/u.test(line))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  // A heading with nothing under it is a version whose notes nobody wrote, which
  // is the state this module exists to refuse rather than to print.
  return body === '' ? undefined : body
}

/** Read the version, find its section, and either report it, print it, or write it. */
function main(): void {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      file: { type: 'string' },
      out: { type: 'string' },
      check: { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const version = values.version
  if (version === undefined || version === '') throw new Error('--version <version> is required')
  const file = values.file ?? changelogPath()
  const notes = sectionFor(readFileSync(file, 'utf8'), version)
  if (notes === undefined) {
    throw new Error(
      `no section for ${version} in ${file} — add a \`## ${version}\` heading with the notes for this version before releasing it`,
    )
  }
  if (values.check === true) {
    process.stdout.write(`release notes: ${version} has a section in ${file} (${String(notes.length)} characters)\n`)
    return
  }
  if (values.out === undefined) {
    process.stdout.write(`${notes}\n`)
    return
  }
  writeFileSync(values.out, `${notes}\n`)
  process.stdout.write(`release notes: wrote ${values.out} for ${version} (${String(notes.length)} characters)\n`)
}

// Only a direct run reads a changelog and writes a file: the spec imports
// `sectionFor`, and a module that acted on import would make a unit test read the
// repository's own changelog and write into whatever `--out` happened to say.
if (isEntry(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`release notes: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
