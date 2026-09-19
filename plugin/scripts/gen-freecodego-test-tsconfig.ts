/**
 * Derive every FreeCodeGo `tsconfig.test.json` reference list from its package
 * project, so the list is never hand-copied.
 *
 * Why a generator rather than a stricter gate
 * -------------------------------------------
 * Each FreeCodeGo package carries two TypeScript projects — `tsconfig.json`
 * (build face, `include: ["src"]`) and `tsconfig.test.json` (type-only,
 * `include: ["src", "tests"]`). The test project cannot inherit the package
 * project's `references`: `extends` does not carry them, and project references
 * have no wildcard form. So the list was written twice, nine times over, and the
 * gate that watched it could only report *what was missing* — after the fact,
 * with a symptom that points at the wrong file (a missing reference makes
 * TypeScript inline the dependency's sources, so the errors surface in
 * `vendor/**`).
 *
 * A more detailed error message cannot fix a hand-copied list; only removing the
 * copy can. Here the package project is the source of truth and this script is
 * the only writer of the test project's list, so the two cannot disagree.
 *
 * What it writes, and what it leaves alone
 * ----------------------------------------
 * Only the `"references"` array. Every other byte of the test config — its
 * header comment (which carries the reasoning for the project's existence), its
 * compiler options, its include list — is preserved exactly, so a run that
 * changes nothing produces a byte-identical file.
 *
 * Two references in `harness-plugin` are *not* derived: the suite appends
 * `todo/write` and `subagent/descriptor` through the typed `Session.append`, so
 * it needs those `SessionEventMap` merges in the program, while the plugin's own
 * `src` deliberately reads them as raw data and must not depend on them. They
 * are declared below with their reason and emitted with it.
 *
 * Usage: `npx tsx scripts/gen-freecodego-test-tsconfig.ts [--check]`
 * `--check` prints the files that would change and exits non-zero without
 * writing. The same comparison runs in `freecodego-tsconfig-families.spec.ts`,
 * so a hand edit fails the suite rather than being quietly corrected.
 *
 * @module scripts/gen-freecodego-test-tsconfig
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const FREECODEGO_ROOT = join(REPO_ROOT, 'packages/freecodego')

/** Two-space indent for member lines, matching the existing test configs. */
const MEMBER_INDENT = '  '

/**
 * References a test project needs that its package project does not.
 *
 * Every entry carries a reason: an extra reference is a claim that the suite
 * needs something `src` does not, and the claim is the reviewable part.
 */
const EXTRA_REFERENCES: Readonly<Record<string, readonly { readonly path: string; readonly reason: string }[]>> = {
  'harness-plugin': [
    { path: '../../subagent/subagent', reason: '`subagent/descriptor`: the suite appends it through the typed `Session.append`.' },
    { path: '../../todo/tool-todo', reason: '`todo/write`: the suite appends it through the typed `Session.append`.' },
  ],
}

/** A tsconfig document, stripped of its `//` commentary before parsing. */
function readConfig(path: string): { readonly references?: readonly { readonly path: string }[] } {
  const raw = readFileSync(path, 'utf8')
  const stripped = raw.replace(/^\s*\/\/.*$/gmu, '')
  return JSON.parse(stripped) as { readonly references?: readonly { readonly path: string }[] }
}

/** FreeCodeGo package directories that carry both projects. */
export function guardedPackages(): readonly string[] {
  return readdirSync(FREECODEGO_ROOT)
    .filter(name => statSync(join(FREECODEGO_ROOT, name)).isDirectory())
    .filter(name => statSync(join(FREECODEGO_ROOT, name, 'tsconfig.test.json'), { throwIfNoEntry: false }) !== undefined)
    .filter(name => statSync(join(FREECODEGO_ROOT, name, 'tsconfig.json'), { throwIfNoEntry: false }) !== undefined)
    .sort()
}

/** The reference paths a package's test project must declare, in order. */
export function derivedReferences(packageDirectory: string): readonly string[] {
  const packageConfig = readConfig(join(FREECODEGO_ROOT, packageDirectory, 'tsconfig.json'))
  return [
    ...(packageConfig.references ?? []).map(reference => reference.path),
    ...(EXTRA_REFERENCES[packageDirectory] ?? []).map(entry => entry.path),
  ]
}

/**
 * The test config's text with its reference array replaced by the derived list.
 *
 * A package whose project has no references at all keeps the file's text as-is,
 * references array included: `native-runtime-protocol` legitimately has neither,
 * and inventing an empty array would be a change nothing asked for.
 *
 * The member indentation is taken from the closing bracket, so the result
 * matches the file's own style rather than this script's.
 */
export function withDerivedReferences(text: string, packageDirectory: string): string {
  if (derivedReferences(packageDirectory).length === 0) return text
  // Line endings are the file's, not this script's: four FreeCodeGo test configs
  // are CRLF and the rest are LF, and rewriting one with the other's endings
  // produces a diff that hides the real change.
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const match = /("references"\s*:\s*\[)([\s\S]*?)(\r?\n([ \t]*)\])/u.exec(text)
  if (match === null) throw new Error(`${packageDirectory}/tsconfig.test.json has no "references" array`)
  const indent = `${match[4] ?? ''}${MEMBER_INDENT}`
  const packagePaths = new Set((readConfig(join(FREECODEGO_ROOT, packageDirectory, 'tsconfig.json')).references ?? [])
    .map(reference => reference.path))
  const extras = EXTRA_REFERENCES[packageDirectory] ?? []
  /** One member, with the comment lines that must sit directly above it. */
  interface Entry { readonly comment?: readonly string[]; readonly member: string }
  const entries: Entry[] = []
  for (const path of derivedReferences(packageDirectory)) {
    const extra = !packagePaths.has(path) ? extras.find(entry => entry.path === path) : undefined
    entries.push({ ...(extra === undefined ? {} : { comment: [`// ${extra.reason}`] }), member: `{ "path": "${path}" }` })
  }
  const chunks = entries.map((entry) => {
    const body = entry.member
    return entry.comment === undefined
      ? `${indent}${body}`
      : `${entry.comment.map(line => `${indent}${line}`).join(eol)}${eol}${indent}${body}`
  })
  const group = extras.length === 0 ? [] : [
    `${indent}// The two entries at the end are the only ones the package project does not`,
    `${indent}// carry, and they are not interchangeable with the rest: the suite appends`,
    `${indent}// those events through the typed \`Session.append\`, so their \`SessionEventMap\``,
    `${indent}// merges have to be in the program, while the plugin's \`src\` reads them as raw`,
    `${indent}// data on purpose and must not depend on them.`,
    `${indent}// Derived by \`scripts/gen-freecodego-test-tsconfig.ts\`; edit that, not this list.`,
  ]
  // The group header is comment lines, so it is joined with plain newlines: a
  // separator comma after a `//` line would land inside the comment.
  const head = group.length === 0 ? '' : `${group.join(eol)}${eol}`
  return `${text.slice(0, match.index)}${match[1]}${eol}${head}${chunks.join(`,${eol}`)}${eol}${match[4] ?? ''}]${text.slice(match.index + match[0].length)}`
}

/** Every package whose test config differs from the derived one. */
export function driftedPackages(): readonly string[] {
  return guardedPackages().filter((directory) => {
    const path = join(FREECODEGO_ROOT, directory, 'tsconfig.test.json')
    return withDerivedReferences(readFileSync(path, 'utf8'), directory) !== readFileSync(path, 'utf8')
  })
}

function main(): void {
  const checkOnly = process.argv.includes('--check')
  const drifted = driftedPackages()
  if (checkOnly) {
    for (const directory of drifted) process.stdout.write(`drifted: packages/freecodego/${directory}/tsconfig.test.json\n`)
    process.exit(drifted.length === 0 ? 0 : 1)
  }
  for (const directory of guardedPackages()) {
    const path = join(FREECODEGO_ROOT, directory, 'tsconfig.test.json')
    const current = readFileSync(path, 'utf8')
    const derived = withDerivedReferences(current, directory)
    if (derived === current) continue
    writeFileSync(path, derived)
    process.stdout.write(`updated: packages/freecodego/${directory}/tsconfig.test.json\n`)
  }
}

if (process.argv[1] !== undefined && /gen-freecodego-test-tsconfig/u.test(process.argv[1])) main()
