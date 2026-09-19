/**
 * Where a skill comes from, said in one line.
 *
 * The syntax, and the ambiguity it has to resolve
 * ----------------------------------------------
 * ```
 *   owner/repo                       a GitHub repository
 *   owner/repo#v1.2.0                pinned to a ref
 *   owner/repo&path:/skills/foo      a subdirectory of one
 *   owner/repo#main&path:/skills/foo both
 *   @scope/name                      an npm package
 *   ./relative/or/absolute/path      a directory on this machine
 * ```
 *
 * `owner/repo` and `@scope/name` are distinguishable, but a bare `foo/bar`
 * could be a two-segment npm scope-less package name or a GitHub repository. The
 * rule is grok's and it is the right way round: **prefer the npm reading when the
 * name is a legal npm package name, otherwise treat it as GitHub**, and expose
 * the resolved kind so a caller can always say `github:` explicitly to override.
 * Guessing the other way would make every short package name look like a
 * repository and then fail at fetch time with a 404 about a user that does not
 * exist.
 *
 * A local path is accepted because a skill being authored is the common case
 * during development, and refusing it would push authors toward committing
 * half-finished skills in order to test them.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/skills/source
 */

/** A parsed skill source. */
export type SkillSource =
  | { readonly kind: 'github'; readonly owner: string; readonly repo: string; readonly ref?: string; readonly path?: string }
  | { readonly kind: 'npm'; readonly name: string; readonly version?: string }
  | { readonly kind: 'local'; readonly path: string }

/** A refusal, with the input quoted so the user can see what was understood. */
export interface SourceParseIssue {
  readonly input: string
  readonly reason: string
}

/** What parsing produced. */
export type SourceParseResult =
  | { readonly ok: true; readonly source: SkillSource; readonly canonical: string }
  | { readonly ok: false; readonly issue: SourceParseIssue }

/** What a legal npm package name looks like, scoped or not. */
const NPM_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** What a repository segment may contain, per GitHub's own rules. */
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Parse a skill source specifier.
 * @param input - the specifier as the user typed it.
 * @returns the parsed source and its canonical spelling, or a refusal.
 */
export function parseSkillSource(input: string): SourceParseResult {
  const trimmed = input.trim()
  if (trimmed === '') return refuse(input, 'the source is empty')

  // An absolute Windows path is here for the same reason the POSIX forms are, and
  // it is the one form that used to fall through to the npm/GitHub readings: it has
  // no leading `./`, `/` or `~` to recognize, so `C:\skills\mine` was refused with a
  // message about `owner/repo` — a refusal a Windows author cannot act on. No npm
  // or GitHub specifier can start with a drive letter and a separator, so the local
  // reading is the only reading available for one.
  if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/') || trimmed.startsWith('~') || /^[A-Za-z]:[\\/]/u.test(trimmed)) {
    return { ok: true, source: { kind: 'local', path: trimmed }, canonical: trimmed }
  }

  // An explicit `npm:` is accepted because {@link formatSkillSource} emits it,
  // and a canonical spelling that cannot be re-read is not canonical.
  if (trimmed.startsWith('npm:')) {
    const npm = splitNpmVersion(trimmed.slice('npm:'.length))
    // A `@` with nothing after it is refused, exactly as a `#` with no ref is. Both
    // are the same user mistake — a pin they did not finish typing — and accepting
    // it would record `npm:pkg@` as a source whose version is the empty string: a
    // spelling that reads as a pin, installs as an unpinned package, and is what
    // "a ref difference makes two sources different" is supposed to prevent.
    if (npm === undefined) return refuse(input, 'a `@` with no version after it; remove it or name a version')
    if (!NPM_NAME_PATTERN.test(npm.name)) return refuse(input, `"${npm.name}" is not a legal npm package name`)
    return {
      ok: true,
      source: { kind: 'npm', name: npm.name, ...(npm.version === undefined ? {} : { version: npm.version }) },
      canonical: npm.version === undefined ? `npm:${npm.name}` : `npm:${npm.name}@${npm.version}`,
    }
  }

  const explicitGithub = trimmed.startsWith('github:')
  const body = explicitGithub ? trimmed.slice('github:'.length) : trimmed

  const [beforePath, pathPart] = splitOnce(body, '&path:')
  const [referencePart, refPart] = splitOnce(beforePath, '#')
  const ref = refPart === undefined || refPart === '' ? undefined : refPart
  if (refPart === '') return refuse(input, 'a `#` with no ref after it; remove it or name a branch, tag or commit')

  if (pathPart !== undefined) {
    const normalized = normalizeSubpath(pathPart)
    if (normalized === undefined) return refuse(input, `"${pathPart}" is not a usable subpath (it must stay inside the repository)`)
    if (explicitGithub || !NPM_NAME_PATTERN.test(referencePart)) {
      return buildGithub(referencePart, ref, normalized, input)
    }
    // A path with a package name is a real ambiguity, and the path form only
    // makes sense for a repository, so the repository reading wins here and the
    // result says so.
    return refuse(input, 'a `&path:` subpath only applies to a repository, but the name before it reads as an npm package; write `github:' + referencePart + '` to say which you meant')
  }

  if (!explicitGithub && refPart === undefined) {
    // The npm reading wins whenever the *name* is a legal npm package name, **and
    // a `#ref` was not written** — because a pin the user typed is a fact about
    // what they asked for, and the npm reading has nowhere to put it. Before that
    // condition existed, `pkg#v1.2.3` was read as npm `pkg`: the resolver returned
    // success, dropped the pin, and installed the latest version of a same-named
    // package, while the module's own lexical table calls `#ref` a GitHub
    // spelling. The same input with nothing after the `#` was refused, so one
    // parser answered one mistake two ways. Now the `#` decides the reading: a
    // bare `pkg` still resolves as npm, and anything with a ref goes to
    // {@link buildGithub}, which either reads it as `owner/repo` or refuses it —
    // `pkg#v1.2.3` is refused as "expected owner/repo", which is the honest answer
    // for a name that is not one.
    //
    // A version is stripped before that test, because `pkg@1.2.3` is not itself a
    // legal name and testing the whole string would push every pinned package
    // down the GitHub path.
    const npm = splitNpmVersion(referencePart)
    if (npm === undefined) return refuse(input, 'a `@` with no version after it; remove it or name a version')
    if (NPM_NAME_PATTERN.test(npm.name)) {
      return {
        ok: true,
        source: { kind: 'npm', name: npm.name, ...(npm.version === undefined ? {} : { version: npm.version }) },
        canonical: npm.version === undefined ? `npm:${npm.name}` : `npm:${npm.name}@${npm.version}`,
      }
    }
  }

  return buildGithub(referencePart, ref, undefined, input)
}

/** Split on the first occurrence of a separator. */
function splitOnce(text: string, separator: string): [string, string | undefined] {
  const index = text.indexOf(separator)
  if (index === -1) return [text, undefined]
  return [text.slice(0, index), text.slice(index + separator.length)]
}

/**
 * Split a `name@version` specifier.
 * @param text - the specifier with any version still attached.
 * @returns the bare name and the version when one was given, or `undefined` when a
 *   separator is present with nothing after it (which the caller refuses).
 */
function splitNpmVersion(text: string): { readonly name: string; readonly version?: string } | undefined {
  // `lastIndexOf`, and `<= 0` rather than `< 0`: a scoped name starts with `@`,
  // so an `@` at index 0 is the scope marker rather than a version separator.
  const at = text.lastIndexOf('@')
  if (at <= 0) return { name: text }
  const version = text.slice(at + 1)
  if (version === '') return undefined
  return { name: text.slice(0, at), version }
}

/** Build the GitHub reading of a specifier. */
function buildGithub(ownerAndRepo: string, ref: string | undefined, path: string | undefined, input: string): SourceParseResult {
  const segments = ownerAndRepo.split('/')
  if (segments.length !== 2) {
    return refuse(input, `expected "owner/repo", "a-package-name", or a path, not "${ownerAndRepo}"`)
  }
  const [owner, repo] = segments as [string, string]
  if (owner === '' || repo === '' || !REPO_SEGMENT_PATTERN.test(owner) || !REPO_SEGMENT_PATTERN.test(repo)) {
    return refuse(input, `"${ownerAndRepo}" is not a valid owner/repo pair`)
  }
  const source: SkillSource = {
    kind: 'github',
    owner,
    repo,
    ...(ref === undefined ? {} : { ref }),
    ...(path === undefined ? {} : { path }),
  }
  const canonical = `github:${owner}/${repo}${ref === undefined ? '' : `#${ref}`}${path === undefined ? '' : `&path:${path}`}`
  return { ok: true, source, canonical }
}

/**
 * Normalize a repository subpath.
 * @param path - the raw subpath.
 * @returns the normalized subpath, or undefined when it escapes the repository.
 */
function normalizeSubpath(path: string): string | undefined {
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return undefined
    parts.push(segment)
  }
  return parts.length === 0 ? undefined : parts.join('/')
}

/** Build a refusal. */
function refuse(input: string, reason: string): SourceParseResult {
  return { ok: false, issue: { input, reason } }
}

/**
 * Spell a source back out.
 * @param source - the parsed source.
 * @returns the canonical spelling.
 */
export function formatSkillSource(source: SkillSource): string {
  if (source.kind === 'npm') return `npm:${source.name}${source.version === undefined ? '' : `@${source.version}`}`
  if (source.kind === 'local') return source.path
  return `github:${source.owner}/${source.repo}${source.ref === undefined ? '' : `#${source.ref}`}${source.path === undefined ? '' : `&path:${source.path}`}`
}

/**
 * Whether two sources identify the same content.
 *
 * A ref difference counts as different, deliberately: `owner/repo#main` and
 * `owner/repo#v2` are the same repository and different skills. The whole reason
 * a lockfile records a resolved commit rather than a branch is that content, not
 * repository, is what must match — so a function used to answer "is this already
 * installed?" has to compare content.
 *
 * The npm case compares names only, because npm resolves the version, and a
 * lockfile's `resolvedCommit` is what pins it.
 * @param left - one source.
 * @param right - the other.
 * @returns true when they identify the same content.
 */
export function sameSkillSource(left: SkillSource, right: SkillSource): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'npm' && right.kind === 'npm') return left.name === right.name
  if (left.kind === 'local' && right.kind === 'local') return left.path === right.path
  if (left.kind === 'github' && right.kind === 'github') {
    return left.owner === right.owner
      && left.repo === right.repo
      && (left.path ?? '') === (right.path ?? '')
      && (left.ref ?? '') === (right.ref ?? '')
  }
  return false
}
