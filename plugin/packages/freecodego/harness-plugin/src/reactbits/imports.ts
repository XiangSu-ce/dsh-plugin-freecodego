/**
 * What a fetched component imports.
 *
 * Its own module because two callers need the same answer for different reasons:
 * the review (`inspect.ts`) uses it to tell a declared dependency from an
 * undeclared one and a package from a local path, and the tool reports the list
 * because the caller has to install the packages before the file compiles.
 *
 * The scan is textual on purpose. The input is TypeScript, JavaScript, and
 * occasionally Vue from a public registry, and the only question is which module
 * specifiers appear — a real parser would add a dependency and a failure mode to
 * answer something a line scan answers exactly, and the one construct that could
 * fool a scan (a specifier built from a variable) is a construct that would have
 * to be resolved at runtime anyway.
 *
 * @module reactbits/imports
 */

/** One import a source carries, and whether it names a package or a local file. */
export interface ReactBitsImport {
  readonly specifier: string
  /** `true` for a bare package specifier, `false` for a relative or aliased local path. */
  readonly external: boolean
}

/**
 * The static import specifiers in one source.
 *
 * @param source - the file's contents.
 * @returns the specifiers, deduplicated, in first-seen order.
 */
export function importSpecifiers(source: string): readonly ReactBitsImport[] {
  // Three shapes, and they are collected together rather than in passes: a
  // `from '…'` (which is how a multi-line named import ends, and upstream writes
  // those), a side-effect `import '…'`, and a `require('…')` that some components
  // still use inside a guard. One pass per shape would group the answer by shape
  // and lose the order the file is written in; sorting by offset keeps it.
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/gu,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/gu,
    /require\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ]
  const matches = patterns
    .flatMap(pattern => [...source.matchAll(pattern)].flatMap(match => (match[1] === undefined
      ? []
      : [{ at: match.index, specifier: match[1] }])))
    .sort((left, right) => left.at - right.at)

  const found: ReactBitsImport[] = []
  const seen = new Set<string>()
  for (const match of matches) {
    if (seen.has(match.specifier)) continue
    seen.add(match.specifier)
    found.push({ specifier: match.specifier, external: !/^[./~]|^@\//u.test(match.specifier) })
  }
  return found
}

/**
 * The package a specifier belongs to, scoped names kept whole.
 *
 * `@react-three/fiber` is one package rather than one of the `@react-three`
 * organization's many, so a scoped specifier keeps its second segment instead of
 * being cut at the first slash.
 *
 * @param specifier - an import specifier, with or without a subpath.
 * @returns the package name, or `undefined` for a relative path.
 */
export function packageOfSpecifier(specifier: string): string | undefined {
  if (/^[./~]|^@\//u.test(specifier)) return undefined
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) return segments.length >= 2 ? segments.slice(0, 2).join('/') : specifier
  return segments[0]
}
