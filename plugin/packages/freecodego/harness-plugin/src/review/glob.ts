/**
 * The glob dialect review rules are written in.
 *
 * Why this is hand-written rather than imported
 * --------------------------------------------
 * A rule file addresses files by pattern (`**\/*.java`, `**\/*mapper*.xml`), so
 * the review engine needs a matcher before it can resolve a single rule. The
 * nearest library (`picomatch`) is not a dependency of this package, and this
 * repository's convention is not to add a dependency for a job this small: the
 * whole translator is under a hundred lines, its semantics are fixed by the
 * tests beside it, and it costs nothing at the plugin's load time.
 *
 * The dialect, and the two decisions in it
 * ---------------------------------------
 * The patterns come from project-authored rule files, so the dialect is
 * deliberately the one contributors already know from `.gitignore`:
 *
 * - `**` crosses directory separators; `*` and `?` do not. A pattern that cannot
 *   express "any depth" is a pattern authors will write incorrectly, and a rule
 *   that silently matches nothing is worse than one that matches too much.
 * - **A pattern without a slash matches at any depth.** `*.java` and `**\/*.java`
 *   are the same rule. This is gitignore's rule and the reason a project can
 *   write a short pattern for "every Java file in the repository".
 * - **Separators are normalized before matching.** A rule file authored on
 *   Windows (`src\**\*.ts`) and a path read from git (`src/a/b.ts`) must agree;
 *   the alternative is a rule that applies on one machine and not another.
 * - **A brace list is a list of patterns.** `**\/*.{gen,min}.ts` excludes both,
 *   which is the one extension upstream's rule reader adds to the dialect and is
 *   supported here in the same three places it is supported there: system rules,
 *   rule-document entries, and `exclude` filters. Without it a project that wrote
 *   that pattern would exclude nothing at all, silently — see
 *   {@link expandBraces} for the two places this deliberately goes further.
 *
 * Matching is case-sensitive, because the destinations are case-sensitive
 * filesystems and a rule that matched `Foo.java` under `*.java` on Linux only
 * would be a difference between machines rather than a property of the rule.
 * (Upstream lowercases both sides; that is a difference this file states rather
 * than hides, because it decides whether a pattern written for macOS matches the
 * same file on Linux.)
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/glob
 */

/**
 * Regex metacharacters a literal glob character must escape.
 *
 * Deliberately not global: `RegExp.test` on a `g`-flagged pattern advances
 * `lastIndex`, so a shared instance would answer `true` only on every other
 * call — a matcher that silently skips characters.
 */
const REGEX_SPECIAL = /[.+^${}()|\\[\]]/

/**
 * Ceiling on how many patterns one brace list may become.
 *
 * `{a,b}` written twelve times is four thousand patterns, and a rule file must not
 * be able to make matching expensive. Exceeding the ceiling is **all or nothing**:
 * the pattern is used as written (and therefore matches nothing) rather than
 * expanded part-way, because half a list is a pattern that removes some of the
 * files a project asked it to remove and says nothing about the rest.
 */
export const MAX_BRACE_EXPANSIONS = 256

/** One translated pattern, its source, and every expansion of it, so a caller can cache. */
interface CompiledPattern {
  readonly source: string
  readonly regexes: readonly RegExp[]
}

/**
 * Translate one glob into an anchored regular expression.
 *
 * Exported because the review rule resolver caches compiled patterns, and a
 * caller that wants that cache needs the same translation the matcher uses
 * rather than a second one that could disagree.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePattern(pattern)
  let out = ''

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] as string

    if (char === '*') {
      const isDouble = normalized[index + 1] === '*'
      if (!isDouble) {
        // A single star stops at a separator: `src/*.ts` does not reach `src/a/b.ts`.
        out += '[^/]*'
        continue
      }

      // A run of stars is one `**`; three stars mean nothing more than two.
      // Where the run *starts* is what the separator check needs: after the
      // loop `index` is the last star, so `index - 1` would inspect the run's
      // own second character rather than the separator before it.
      const runStart = index
      while (normalized[index + 1] === '*') index += 1
      const followedBySlash = normalized[index + 1] === '/'
      const precededBySlash = runStart > 0 && normalized[runStart - 1] === '/' && out.length > 0

      if (followedBySlash) {
        // `a/**/b` matches `a/b` and `a/x/y/b`, so the directory run is optional
        // and the separator is consumed here rather than emitted twice.
        out += '(?:[^/]+/)*'
        index += 1
        continue
      }

      if (precededBySlash) {
        // `a/**` matches everything below `a`, including nothing below it.
        out = out.slice(0, -1)
        out += '(?:/.*)?'
        continue
      }

      out += '.*'
      continue
    }

    if (char === '?') {
      out += '[^/]'
      continue
    }

    if (char === '[') {
      const close = findBracketEnd(normalized, index)
      if (close === -1) {
        // An unterminated class is a literal opening bracket, matching what a
        // reader sees rather than treating the rest of the pattern as a class.
        out += '\\['
        continue
      }
      let body = normalized.slice(index + 1, close)
      // gitignore negates with `!`, regex with `^`; both spell the same intent.
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      out += `[${body.replace(/\\/g, '\\\\')}]`
      index = close
      continue
    }

    out += escapeRegExpChar(char)
  }

  return new RegExp(`^${out}$`)
}

/** Whether one path matches one pattern, in any of its brace expansions. */
export function matchesGlob(pattern: string, path: string): boolean {
  return compileMatches(pattern, normalizePath(path))
}

/** Whether one path matches any pattern; an empty pattern list matches nothing. */
export function matchAnyGlob(patterns: readonly string[], path: string): boolean {
  const normalized = normalizePath(path)
  for (const pattern of patterns) {
    if (pattern.trim() === '') continue
    if (compileMatches(pattern, normalized)) return true
  }
  return false
}

/**
 * Expand one pattern's brace lists into the patterns it stands for.
 *
 * Upstream's rule reader expands `{a,b,c}` before matching, with two properties
 * worth naming because this implementation keeps one and changes the other:
 *
 * - **A group with one option stays as written.** Upstream rewrites `a{b}.ts` to
 *   `ab.ts`, silently renaming what the pattern addresses; a one-option group is
 *   not a choice, so this keeps the braces literal — which is also what a pattern
 *   naming a file with a brace in it needs.
 * - **Every group expands, including a second one and a nested one.** Upstream
 *   expands only the first group, so `**\/*.{test,spec}.{ts,tsx}` becomes
 *   `**\/*.test.{ts,tsx}` and `**\/*.spec.{ts,tsx}` — patterns whose remaining
 *   braces match literally, which is to say they match no file at all. A project
 *   writing that pattern means both axes, and honoring one of them while silently
 *   dropping the other is the failure this menu of rules exists to avoid.
 *
 * A pattern needing more than {@link MAX_BRACE_EXPANSIONS} alternatives is returned
 * as written.
 * @param pattern - the pattern as a rule file or caller wrote it.
 * @returns the patterns it stands for, in the order the alternatives were written.
 */
export function expandBraces(pattern: string): string[] {
  const out: string[] = []
  const state = { overflow: false }
  expandInto(pattern, out, state)
  return out.length === 0 || state.overflow ? [pattern] : out
}

/** Recursively expand the leftmost group, accumulating results in `out`. */
function expandInto(pattern: string, out: string[], state: { overflow: boolean }): void {
  if (state.overflow) return
  if (out.length >= MAX_BRACE_EXPANSIONS) {
    state.overflow = true
    return
  }
  const open = pattern.indexOf('{')
  if (open === -1) {
    out.push(pattern)
    return
  }
  // Depth-aware, so a nested group belongs to the group that contains it rather
  // than closing its parent early.
  let depth = 0
  let close = -1
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index] as string
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close === -1) {
    // An unclosed brace is a literal brace, as upstream treats it.
    out.push(pattern)
    return
  }
  const options = splitTopLevel(pattern.slice(open + 1, close))
  if (options.length < 2) {
    out.push(pattern)
    return
  }
  const prefix = pattern.slice(0, open)
  const suffix = pattern.slice(close + 1)
  for (const option of options) expandInto(`${prefix}${option}${suffix}`, out, state)
}

/** Split a brace body on its top-level commas, keeping nested groups whole. */
function splitTopLevel(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      out.push(body.slice(start, index))
      start = index + 1
    }
  }
  out.push(body.slice(start))
  return out
}

/**
 * Compile one pattern, memoized.
 *
 * A review resolves rules for every changed file against every pattern in every
 * layer, so the same pattern is translated once per file without the cache. The
 * cache is bounded because patterns come from repository-authored files: an
 * unbounded map keyed on repository content is a memory leak a checkout can
 * drive.
 */
const CACHE = new Map<string, CompiledPattern>()
const CACHE_LIMIT = 512

function compile(pattern: string): CompiledPattern {
  const cached = CACHE.get(pattern)
  if (cached !== undefined) return cached
  const entry: CompiledPattern = {
    source: pattern,
    regexes: expandBraces(pattern).map(expanded => globToRegExp(expanded)),
  }
  if (CACHE.size >= CACHE_LIMIT) CACHE.clear()
  CACHE.set(pattern, entry)
  return entry
}

/** Whether any expansion of one pattern matches one already-normalized path. */
function compileMatches(pattern: string, normalizedPath: string): boolean {
  return compile(pattern).regexes.some(regex => regex.test(normalizedPath))
}

/** Drop the compiled-pattern cache; exposed for tests that assert translation counts. */
export function clearGlobCache(): void {
  CACHE.clear()
}

/** Normalize a pattern to POSIX separators and strip a leading `./`. */
function normalizePattern(pattern: string): string {
  let out = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  // A leading slash anchors at the repository root, which is where every path
  // handed to this module already starts, so the anchor is only noise.
  if (out.startsWith('/')) out = out.slice(1)
  // A trailing slash names a directory; review targets are always files.
  if (out.endsWith('/')) out = out.slice(0, -1)
  // A pattern with no separator matches at any depth, per the module note.
  if (!out.includes('/')) out = `**/${out}`
  return out
}

/** Normalize a candidate path to POSIX separators and strip a leading `./`. */
function normalizePath(path: string): string {
  const out = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return out.startsWith('/') ? out.slice(1) : out
}

/** Index of the `]` closing the class starting at `open`, or -1 when unclosed. */
function findBracketEnd(pattern: string, open: number): number {
  for (let index = open + 1; index < pattern.length; index += 1) {
    if (pattern[index] === ']' && index > open + 1) return index
  }
  return -1
}

/** Escape one character for a regex body, leaving glob metacharacters alone. */
function escapeRegExpChar(char: string): string {
  return REGEX_SPECIAL.test(char) ? `\\${char}` : char
}
