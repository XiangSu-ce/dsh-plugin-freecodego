/**
 * The sandbox profile language.
 *
 * What a profile is for
 * ---------------------
 * The Host can express exactly three sandbox modes — `read-only`,
 * `workspace-write` and `danger-full-access` — and that vocabulary is closed. A
 * user who wants "workspace-write, but never read or write `.env` anywhere, and
 * no network" has no way to say it, so the only lever they have is to pick a
 * broader mode and hope. This module adds the missing middle: a profile names a
 * builtin to extend and then *narrows* it, and the narrowing is enforced where the
 * Host cannot declare it.
 *
 * What this module honestly cannot do
 * -----------------------------------
 * A kernel-level `deny` is not reachable through the current seam: `SandboxPolicy`
 * has no deny field, and the Landlock profile the Host builds is a pure allow-list.
 * So `deny` here is enforced **in the plugin's policy layer** — over tool calls and
 * in-process file intents — and the report says so instead of claiming a kernel
 * guarantee. {@link kernelDenyAvailable} exists to make that a checked fact rather
 * than a comment, and it returns `false` on every platform on purpose: the day the
 * Host grows a deny field, one line changes here and every report follows.
 *
 * The consequence is a documented bypass, and it is the same one the tool it is
 * modelled on documents: an engine's own shell redirection
 * (`bash -c 'echo x > /etc/passwd'`) is the sandbox *mode*'s responsibility, not the
 * deny list's. Saying otherwise would be the one failure this file must not have —
 * reporting "we asked for it" as "it is in force".
 *
 * What is reachable today, stated because the two halves differ
 * ---------------------------------------------------------
 * Only the deny half has a runtime consumer. The settings document carries one
 * sandbox field, `sandboxDenyPatterns`, and `index.ts` feeds it through
 * {@link normalizeDenyPatterns} into {@link denyRefusal} on both enforcement
 * surfaces, with {@link describeDenyEnforcement} and {@link kernelDenyAvailable}
 * answering the report. So the list the user writes is the list that is enforced,
 * and nothing here overclaims about how far it reaches.
 *
 * The *profile language* is not reachable: nothing in the settings schema, the
 * agent preset or the desktop settings UI carries a `SandboxProfileSpec`, so
 * {@link resolveSandboxProfile} and {@link mergeSandboxProfiles} have no caller
 * outside their own spec. They are kept rather than deleted because the hard part
 * they encode — precedence between a repository's document and the user's, a
 * narrowing that cannot widen, and the refusal to report "asked for" as "in
 * force" — is the part that must not be re-derived when the settings field is
 * added. An earlier revision of this header said the module "adds the missing
 * middle" without saying that the middle is callable only from a test, which is
 * how a reader ends up believing a profile they wrote is in force. Wire these two
 * by giving the settings document a field for the spec and a selector for the
 * name, and apply the resolved mode at session creation — never by overriding a
 * mode the user set through `sandboxModeSet`, which is the control that exists.
 *
 * Two rules that look like nitpicks and are not
 * ---------------------------------------------
 * 1. `read_only` / `read_write` entries are **literal paths, not globs**. A wildcard
 *    in one is a mistake the user has to hear about, so `…/cache/**` is read as the
 *    parent directory `…/cache`, and an entry with a residual `*?[` is dropped with
 *    a notice rather than silently matching nothing.
 * 2. Surrounding whitespace is a **rejection**, not something to trim. A path may
 *    legally contain a space; trimming would turn a typo into a different, valid
 *    path — the worst possible outcome, because it would take effect.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/sandbox/profiles
 */

import { homedir } from 'node:os'
import { realpathThroughMissingTail } from './realpath.ts'
import type { FreeCodeGoSandboxMode } from '../types.ts'

/** The builtin profiles a custom one may extend, and the complete set of them. */
export const BUILTIN_SANDBOX_PROFILES = ['off', 'workspace', 'devbox', 'read-only', 'strict'] as const

/** One builtin sandbox profile name, drawn from {@link BUILTIN_SANDBOX_PROFILES}. */
export type BuiltinSandboxProfileName = (typeof BUILTIN_SANDBOX_PROFILES)[number]

/** A profile as the user writes it, before it is resolved against a platform. */
export interface SandboxProfileSpec {
  /** The builtin this profile narrows. */
  readonly extends: BuiltinSandboxProfileName
  /** Whether the profile asks for network access to be removed. */
  readonly restrictNetwork?: boolean
  /** Literal paths made read-only, on top of what the builtin allows. */
  readonly readOnly?: readonly string[]
  /** Literal paths made writable, on top of what the builtin allows. */
  readonly readWrite?: readonly string[]
  /** Glob patterns denied for reading **and** writing, enforced in the policy layer. */
  readonly deny?: readonly string[]
}

/** A profile after resolution: what the Host seam is told, and what we enforce. */
export interface ResolvedSandboxProfile {
  /** The three-valued mode handed to the Host; a narrowing can only ever narrow it. */
  readonly mode: FreeCodeGoSandboxMode
  /** Denied globs, normalized and deduplicated, in the order they were declared. */
  readonly deny: readonly string[]
  /**
   * Literal read-only paths the profile named, normalized and deduplicated.
   *
   * Returned rather than validated-then-dropped: these were parsed and then absent
   * from every result, so a profile could declare a narrowing that no caller could
   * ever learn about. What they do *not* have is a kernel field to go into, which
   * the notice below says out loud instead of leaving the entry to look in force.
   */
  readonly readOnly: readonly string[]
  /** Literal writable paths the profile named, normalized and deduplicated. */
  readonly readWrite: readonly string[]
  /** What the profile asked for that this platform cannot deliver, in plain language. */
  readonly notices: readonly string[]
}

/** The three-valued mode each builtin resolves to when nothing narrows it further. */
const BUILTIN_MODES: Readonly<Record<BuiltinSandboxProfileName, FreeCodeGoSandboxMode>> = {
  off: 'danger-full-access',
  workspace: 'workspace-write',
  devbox: 'workspace-write',
  'read-only': 'read-only',
  strict: 'read-only',
}

/**
 * Whether the Host seam can enforce a denied read or write in the kernel.
 *
 * `false` everywhere, and deliberately a function rather than a constant: the
 * limitation belongs to the seam (`SandboxPolicy` has no deny field, and the
 * Landlock profile is a pure allow-list), not to a platform. Every report that
 * depends on this answer composes it in {@link describeDenyEnforcement}, so the day
 * the seam grows a deny field there is one place to change.
 * @returns whether a kernel-level deny can be expressed today.
 */
export function kernelDenyAvailable(): boolean {
  return false
}

/** Order of strictness for the three-valued mode; lower is more contained. */
const MODE_RANK: Readonly<Record<FreeCodeGoSandboxMode, number>> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/** The stricter of two modes, so a narrowing can never widen. */
function stricter(left: FreeCodeGoSandboxMode, right: FreeCodeGoSandboxMode): FreeCodeGoSandboxMode {
  return MODE_RANK[left] <= MODE_RANK[right] ? left : right
}

/**
 * Expand a leading `~` and normalize separators.
 *
 * `~` is expanded rather than left literal because a deny pattern is matched
 * against absolute paths the tools report, and a literal `~` would match none of
 * them — a rule that looks configured and enforces nothing.
 * @param value - the entry as written.
 * @returns the entry with `~` expanded and backslashes normalized to `/`.
 */
export function expandEntry(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (normalized === '~') return homedir().replaceAll('\\', '/')
  if (normalized.startsWith('~/')) return `${homedir().replaceAll('\\', '/')}/${normalized.slice(2)}`
  return normalized
}

/**
 * Read one `read_only` / `read_write` entry, or reject it with a reason.
 *
 * Rejection rather than repair is the rule for both failure modes below, because a
 * repaired entry is one that *takes effect* while differing from what was written.
 * @param entry - the raw entry.
 * @returns the literal path, or the reason it cannot be used.
 */
export function readPathEntry(entry: string): { readonly path: string } | { readonly rejected: string } {
  // Surrounding whitespace is rejected instead of trimmed: a path may contain a
  // space, so trimming a typo could turn it into a different valid path.
  if (entry !== entry.trim()) return { rejected: `"${entry}" has leading or trailing whitespace; paths are literal, so it is not trimmed` }
  if (entry === '') return { rejected: 'empty path' }
  const expanded = expandEntry(entry)
  // `…/cache/**` is the shape people write meaning "this directory". A trailing
  // `/**` is therefore read as the parent, and anything else with a wildcard is a
  // mistake — dropping it loudly beats matching nothing quietly.
  const trailingGlob = /\/\*\*?$/u.exec(expanded)
  const literal = trailingGlob === null ? expanded : expanded.slice(0, trailingGlob.index)
  if (/[*?[]/u.test(literal)) return { rejected: `"${entry}" contains a wildcard; read/write entries are literal paths (use 'deny' for patterns)` }
  if (literal === '') return { rejected: `"${entry}" resolves to an empty path` }
  return { path: literal }
}

/**
 * Resolve `.` and `..` segments lexically, so one path has one spelling.
 *
 * Purely lexical on purpose: the answer must not depend on what happens to exist
 * on this machine, and a symlink still belongs to the `realpath` arm. Without
 * this, the deny list is the one guard that reads a path exactly as the caller
 * spelled it, so `/w/x/../secrets/token.txt` reached the glob as a different
 * string from `/w/secrets/token.txt` and passed a list whose entire job is to
 * refuse it — in the very profile whose own notice says the deny list is the
 * only thing narrowing it.
 *
 * Boundaries, all three stated because each is a place a plausible reading goes
 * wrong: a `..` above the root of an absolute path stops at the root, as the
 * kernel does; a leading `..` on a relative path is kept, because nothing here
 * knows what it is relative to; a drive segment is an ordinary segment, so
 * `C:/w/x/../secrets` becomes `C:/w/secrets`.
 *
 * Deliberately *not* "compare both the literal and the resolved form". That
 * would refuse `/work/secrets/../notes.md` while allowing `/work/notes.md` —
 * one file, two answers — which is the rule this module already writes down
 * (`normalizes separators so one path has one spelling`).
 */
function collapseDotSegments(pattern: string): string {
  const absolute = pattern.startsWith('/')
  const segments: string[] = []
  for (const segment of pattern.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const last = segments.at(-1)
      if (last !== undefined && last !== '..') {
        segments.pop()
        continue
      }
      if (absolute) continue
      segments.push(segment)
      continue
    }
    segments.push(segment)
  }
  return absolute ? `/${segments.join('/')}` : segments.join('/')
}

/**
 * Normalize one deny glob.
 *
 * Globs are kept as globs — this only makes two spellings of one pattern compare
 * equal, so the deduplication below cannot leave both a pattern and its duplicate
 * in force. Dot segments are part of that promise rather than a separate step:
 * the pattern side and the candidate side both arrive through this function
 * (`denyMatch` normalizes the path it was handed), so collapsing them here is
 * what makes one file have one answer on both arms at once.
 * @param pattern - the pattern as written.
 * @returns the normalized pattern.
 */
export function normalizeDenyPattern(pattern: string): string {
  const expanded = expandEntry(pattern.trim())
  const collapsed = expanded.replace(/\/{2,}/gu, '/')
  // A trailing slash names a directory; the pattern already covers it, and keeping
  // it would make `a/` and `a` two entries that match the same tree.
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/u, '') : collapsed
  return collapseDotSegments(trimmed)
}

/**
 * Whether a deny glob can be compiled, and why not when it cannot.
 *
 * A pattern is a regular expression once {@link denyPatternToRegExp} has read it, and
 * a character class is passed through verbatim (that is what makes `[0-9]` work), so
 * a class JavaScript refuses — `[z-a]` is the shortest one — reaches `new RegExp`
 * and throws. That throw happens inside a tool guard, where it would make every call
 * in the session an error rather than a denial, so the check belongs at the point
 * where a list is accepted.
 * @param pattern - a normalized deny glob.
 * @returns the reason it cannot be compiled, or `undefined` when it can.
 */
export function denyPatternRejection(pattern: string): string | undefined {
  try {
    denyPatternToRegExp(pattern)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Normalize a deny list and split it into what can be enforced and what cannot.
 *
 * Dropping a pattern is not the same as the pattern being harmless: a user who
 * writes a broken one believes they are protected by it, so the rejection carries
 * its reason out to whoever is rendering notices.
 * @param patterns - the patterns as written.
 * @returns the patterns that compile, and one entry per pattern that does not.
 */
export function partitionDenyPatterns(patterns: readonly string[]): {
  readonly accepted: readonly string[]
  readonly rejected: readonly { readonly pattern: string; readonly reason: string }[]
} {
  const accepted: string[] = []
  const rejected: { pattern: string; reason: string }[] = []
  for (const pattern of unique(patterns.map(normalizeDenyPattern).filter(entry => entry !== ''))) {
    const rejection = denyPatternRejection(pattern)
    if (rejection === undefined) accepted.push(pattern)
    else rejected.push({ pattern, reason: rejection })
  }
  return { accepted, rejected }
}

/**
 * Normalize and deduplicate a whole deny list.
 *
 * The one entry point for a list coming from settings: normalizing at the point of
 * use instead would leave two spellings of one pattern in force depending on which
 * surface asked.
 *
 * A pattern that cannot compile is dropped here rather than at match time, because
 * this is the only place in the settings path that can drop it *before* it is put in
 * front of a tool call. {@link partitionDenyPatterns} is the same function with the
 * reasons kept, for a caller that reports them.
 * @param patterns - the patterns as written.
 * @returns normalized patterns, in first-seen order, with empties and uncompilable entries removed.
 */
export function normalizeDenyPatterns(patterns: readonly string[]): readonly string[] {
  return partitionDenyPatterns(patterns).accepted
}

/** Deduplicate while keeping the first-seen order, so output is stable for a given input. */
function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

/**
 * Resolve a profile against a platform.
 *
 * Pure: the same spec and platform always produce the same result, which is what
 * makes the notices trustworthy — they are derived, not accumulated from whatever
 * happened to be mounted at the time.
 * @param spec - the profile as written.
 * @param platform - the platform to resolve for; defaults to this process's.
 * @returns the mode to hand the Host, the globs we enforce, and what cannot be delivered.
 */
export function resolveSandboxProfile(spec: SandboxProfileSpec, platform: NodeJS.Platform = process.platform): ResolvedSandboxProfile {
  const notices: string[] = []
  const builtin = BUILTIN_MODES[spec.extends]

  // Paths first: they can only add containment, so they never widen the mode.
  const readOnly: string[] = []
  const readWrite: string[] = []
  for (const entry of spec.readOnly ?? []) {
    const read = readPathEntry(entry)
    if ('rejected' in read) notices.push(`read_only entry skipped: ${read.rejected}`)
    else readOnly.push(read.path)
  }
  for (const entry of spec.readWrite ?? []) {
    const read = readPathEntry(entry)
    if ('rejected' in read) notices.push(`read_write entry skipped: ${read.rejected}`)
    else readWrite.push(read.path)
  }

  const { accepted: deny, rejected } = partitionDenyPatterns(spec.deny ?? [])
  for (const entry of rejected) {
    // Loud, per the module's own rule: a pattern that matches nothing quietly is
    // indistinguishable from a pattern that is protecting the user.
    notices.push(`deny pattern dropped: "${entry.pattern}" is not a valid pattern (${entry.reason})`)
  }
  // The literal path lists are resolved here and reported when declared: the
  // harness seam has three sandbox modes and no field for a path list, so a
  // `read_only` entry cannot reach the kernel and saying nothing about it would
  // leave the user believing it had.
  if (readOnly.length > 0 || readWrite.length > 0) {
    notices.push('read_only/read_write paths are resolved but the harness sandbox seam has no field for a path list, so they are reported rather than enforced; `deny` is what the plugin applies')
  }

  // The mode is the builtin, narrowed by what the profile asked to remove. Nothing
  // here can widen it: `stricter` picks the more contained of the two, so a
  // `read_write` entry on a `strict` profile cannot escape the builtin's own mode.
  let mode = builtin
  if (spec.restrictNetwork === true) {
    // No mode expresses "network off" on its own, so the honest answer is a notice:
    // claiming containment here would be exactly the misreporting this file exists
    // to avoid.
    notices.push('restrict_network is requested but no Host mode expresses it; network access is not restricted by this profile')
  }
  if (spec.extends === 'devbox' && platform === 'win32') {
    // The devbox builtin has no Windows backend, so it resolves to the closest
    // contained mode instead of failing to mount.
    notices.push('devbox has no Windows backend; falling back to workspace-write')
    mode = stricter(mode, 'workspace-write')
  }
  if (spec.extends === 'strict') {
    notices.push('strict resolves to read-only; there is no mode below it, so `deny` is what adds the rest')
  }
  if (spec.extends === 'off' && (readOnly.length > 0 || deny.length > 0)) {
    // The profile narrows a mode that narrows nothing. Saying so is the difference
    // between a user believing their deny list is containment and knowing it is
    // the only containment they have.
    notices.push('off means danger-full-access: the deny list is the only thing narrowing this profile')
  }
  return { mode, deny, readOnly: unique(readOnly), readWrite: unique(readWrite), notices }
}

/**
 * Compile a deny glob into a regular expression.
 *
 * The two crossings that matter: `*` stops at a separator, `**` does not, and a
 * leading `**` followed by a slash matches *zero* directories as well as many — that
 * last one is what makes the pattern match both `.env` at the root and
 * `deep/nested/.env`, which is the whole reason people write it that way.
 * @param pattern - a normalized deny glob.
 * @param platform - the platform, for case sensitivity.
 * @returns a regexp anchored to the whole path.
 */
export function denyPatternToRegExp(pattern: string, platform: NodeJS.Platform = process.platform): RegExp {
  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === '*') {
      const isDouble = pattern[index + 1] === '*'
      if (isDouble) {
        // `**/` — zero or more whole segments.
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
        continue
      }
      source += '[^/]*'
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    if (character === '[') {
      // A character class is passed through; an unterminated one is treated as a
      // literal `[`, which is what a user who typed one meant.
      const close = pattern.indexOf(']', index + 1)
      if (close === -1) {
        source += '\\['
        continue
      }
      source += pattern.slice(index, close + 1)
      index = close
      continue
    }
    source += character.replace(/[\\^$+.()|{}]/gu, '\\$&')
  }
  return new RegExp(`^${source}$`, caseInsensitive ? 'iu' : 'u')
}

/**
 * Drop the NTFS alternate-data-stream suffix that Win32 uses to name a *stream of*
 * a file, so the file has one spelling on this platform too.
 *
 * `file:stream` and `file::$DATA` both name data **of** `file`: reading
 * `.env::$DATA` returns the bytes of `.env`, while a pattern written to protect
 * `.env` is compared against the name as spelled and does not match. Measured on
 * the platform this Host runs on, that is a live bypass — the filesystem returns
 * the protected file's contents and the deny list allows the path — and it is the
 * *same* hole `tool-guards.ts` closed in `normalizeSegment`, one judgment away: the
 * credential shield refused `read({ path: '.env::$DATA' })` while a user's own
 * `deny: ['**\/.env']` rule allowed it.
 *
 * Two boundaries, because each is a place a plausible reading goes wrong: a drive's
 * colon is not a stream, so a segment that is itself a drive spec keeps its colon
 * (`C:` stays a drive, and `C:/w/.env::$DATA` still collapses to `C:/w/.env`), and
 * only the last segment can carry a stream (`C:/w:1/.env` keeps its directory). The
 * rule is win32-only, like the case folding beside it: on POSIX a colon is an
 * ordinary filename character, and `notes:2024` is a different file from `notes`.
 *
 * A drive-relative path (`C:.env`) is not read here: resolving it needs the current
 * directory of that drive, which no lexical reader can know, so it keeps the answer
 * it had before this rule existed. Cutting at its drive colon would collapse the
 * path to the bare drive, which reads like a *different* answer rather than an
 * unreadable one.
 */
function withoutWindowsStream(value: string): string {
  const separator = value.lastIndexOf('/')
  const name = value.slice(separator + 1)
  const colon = name.indexOf(':', /^[A-Za-z]:/u.test(name) ? 2 : 1)
  if (colon === -1) return value
  return `${value.slice(0, separator + 1)}${name.slice(0, colon)}`
}

/**
 * Whether a path is denied, for reading **and** writing.
 *
 * One function for both directions on purpose: a deny list that covered writes but
 * not reads would pass every write-side test while still handing the file's contents
 * to the model, which is the half that leaks. The tests below assert one direction
 * cannot be dropped without failing.
 * @param deny - normalized deny globs.
 * @param path - the absolute path a tool is about to touch.
 * @param platform - the platform, for separator and case handling.
 * @returns the pattern that matched, or `undefined` when nothing did.
 */
export function denyMatch(deny: readonly string[], path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (deny.length === 0) return undefined
  const normalized = normalizeDenyPattern(path)
  // Win32 resolves a stream spelling to the file it names, so the deny list has to
  // read the same path the filesystem would open rather than the one that was typed.
  const candidate = platform === 'win32' ? withoutWindowsStream(normalized) : normalized
  const basename = candidate.slice(candidate.lastIndexOf('/') + 1)
  for (const pattern of deny) {
    let expression: RegExp
    try {
      expression = denyPatternToRegExp(pattern, platform)
    } catch {
      // A last resort, not the mechanism: a list that reached a tool call is
      // supposed to have been through `normalizeDenyPatterns`, which drops the
      // patterns this cannot compile. It must not throw here anyway — this runs
      // inside a tool guard, so one malformed entry in settings would turn every
      // call in the session into an error instead of a denial.
      continue
    }
    if (expression.test(candidate)) return pattern
    // A pattern with no separator is matched against the basename as well, so
    // `**\/.env` and `.env` behave the same — people write both meaning "anywhere".
    // Without this the bare spelling matches only a path that *is* `.env`, and a
    // tool reports absolute paths, so the rule would look configured and enforce
    // nothing.
    if (!pattern.includes('/') && expression.test(basename)) return pattern
  }
  return undefined
}

/**
 * How a deny list is actually enforced, in the report's existing vocabulary.
 *
 * Reuses `'tool-scope'` rather than minting a `'plugin-policy'` value: the report's
 * three states already mean "the tools are the thing stopping this", and a fourth
 * synonym would be a second vocabulary for one fact.
 * @param deny - the deny globs in force.
 * @returns the enforcement state and, whenever it is not a kernel guarantee, why.
 */
export function describeDenyEnforcement(deny: readonly string[]): {
  readonly enforcedBy: 'tool-scope' | 'none'
  readonly fallbackReason?: string
} {
  if (deny.length === 0) return { enforcedBy: 'none' }
  if (kernelDenyAvailable()) return { enforcedBy: 'tool-scope' }
  return {
    enforcedBy: 'tool-scope',
    fallbackReason: 'enforced in the plugin policy layer over tool calls and in-process file intents; the harness sandbox seam cannot express a kernel-level deny, so an engine\'s own shell redirection is the sandbox mode\'s responsibility, not the deny list\'s',
  }
}

/**
 * Argument keys that name the file a tool call touches, most specific first.
 *
 * A list of *keys* rather than of tool names, deliberately. A tool-name list is a
 * list that rots: every new write tool, every MCP bridge, and every native engine's
 * own spelling (`file_path` on Claude, `path` here) would have to be added, and the
 * failure of forgetting one is silent. Reading whichever of these keys a call
 * carries covers a tool that did not exist when this line was written.
 *
 * `locator` is here for the reader that takes its path from a marker rather than
 * from the model — `spill_recall`. The name it uses is its own, so a list of tool
 * names would have had to have been extended for it, and until it was, a profile
 * denying `**\/.env` would have stopped `read` and allowed this one.
 *
 * `notebook_path` / `notebookPath` are here for the same reason, and they were the
 * missing pair: `tool-guards.ts` lists `notebook_edit` among the tools the
 * credential shield is pointed at and then read no path for it, because the key it
 * carries was in no list. The native projection (`native-tool-guard.ts`) re-keys
 * `notebook_path` onto `path`, so an engine's call was judged and a Harness tool's
 * was not — one call, two answers, decided by which component dispatched it. A key
 * vocabulary that one surface knows and another does not is the whole failure this
 * list exists to prevent.
 *
 * `file` is here for the two tools that spell their path that way —
 * `engineering_hunks` and `engineering_hunk_revert`. They are the reason this list
 * is a list of *keys*: `hunks` returns a preview of the lines a call added and
 * `hunk_revert` writes the file back, so a call carrying `file` was a read and a
 * write the judgment never saw, and the credential shield reads this same
 * vocabulary (`tool-guards.ts`). Both names were absent for the reason the whole
 * comment above warns about — nothing enumerated the keys the plugin's own tools
 * declare, so nothing could notice the gap. It sits last because it is the least
 * specific spelling: a call carrying both `path` and `file` should be answered by
 * `path` where a caller wants one answer, and judged on both where it wants all.
 *
 * Exported because the judgment list and the projection list are the same fact:
 * `native-tool-guard.ts` projects whichever of these a call carries onto `path`, so
 * a key added here reaches every surface at once instead of only the ones that
 * happened to be edited.
 */
export const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'notebookPath', 'filename', 'target_file', 'targetFile', 'locator', 'file'] as const

/**
 * The keys that carry a *list* of paths.
 *
 * A list is a separate shape because it is a separate hole: a tool that takes
 * `paths: ['.env']` names a denied file just as plainly as one that takes
 * `path: '.env'`, and reading only the singular keys would let it through. Only
 * the value that actually matched is refused, so a batch call is judged by what
 * it touches rather than by its shape.
 */
export const PATH_LIST_ARGUMENT_KEYS = ['paths', 'files', 'file_paths', 'filePaths', 'target_files', 'targetFiles'] as const

/**
 * The keys that carry a *file-name filter* rather than one path.
 *
 * A filter is a separate shape because it is a separate hole. `grep` takes `path`
 * for where to search and `include` for which files to print, so
 * `{ path: '/work', include: '*.env' }` prints the lines of a denied file while a
 * judgment that read only `path` saw the directory and allowed it — the file's
 * contents, by the one route the deny list exists to close. Claude's `Grep`
 * spells the same filter `glob`. Both are *one positive filename glob*, which is
 * what makes them readable here at all.
 *
 * `pattern` is deliberately absent, and it is the one name worth explaining. It is
 * a filename glob on Claude's `Glob` and a *content* regular expression on
 * `grep`, so the same key names two different things: reading it as a file would
 * refuse `grep({ pattern: 'api_key' })` in a workspace that denies `.env`, which
 * is a false positive on the most ordinary search there is. A key whose meaning
 * depends on which tool carries it cannot be part of a vocabulary read by tool-
 * agnostic callers.
 */
export const PATH_FILTER_ARGUMENT_KEYS = ['include', 'glob'] as const

/** Glob metacharacters a filter may use to select a name instead of stating one. */
const FILTER_METACHARACTERS = /[*?[\]{}()!+@]/gu

/**
 * Expand one level of brace alternation in a filter glob.
 *
 * Engines accept `*.{env,md}` and `{.env,.npmrc}` as ordinary positive globs, and
 * both select every alternative. A reducer that only stripped `{`, `}`, and `,`
 * would turn those into `.env,md` / `.env,.npmrc` — names no deny rule and no
 * credential predicate recognizes — while the tool still printed `.env`. Nested
 * braces expand recursively so `{a,{b,c}}` yields the same three names the shell
 * would. Unbalanced or empty braces are left alone: inventing alternatives from a
 * typo would refuse calls that never selected a denied file.
 */
function expandFilterBraces(value: string): readonly string[] {
  const match = /^(.*)\{([^{}]+)\}(.*)$/u.exec(value)
  if (match === null) return [value]
  const [, prefix = '', body = '', suffix = ''] = match
  const alternatives = body.split(',').map(part => part.trim()).filter(part => part !== '')
  if (alternatives.length === 0) return [value]
  return alternatives.flatMap(alternative => expandFilterBraces(`${prefix}${alternative}${suffix}`))
}

/**
 * Reduce one *already-expanded* filter alternative to the literal name it selects.
 *
 * Trailing dots are stripped because Win32 collapses them (`*.env.*` → `.env.` →
 * the same file as `.env`), and leaving the bare trailing dot made the credential
 * basename regex reject a name the filesystem would open.
 */
function filterNameCandidateLiteral(value: string): string | undefined {
  const literal = value.replace(FILTER_METACHARACTERS, '')
  const segments = literal.split(/[\\/]+/u).filter(segment => segment !== '')
  const name = (segments.at(-1) ?? '').replace(/\.+$/u, '')
  return name === '' ? undefined : name
}

/**
 * The literal file name a filter glob can select, when it can select one.
 *
 * A filter is a glob and a deny pattern is a path, so comparing the two spellings
 * directly finds nothing: `denyMatch` sees `*.env` and `**\/.env` as two different
 * files although both select the same one. What the two spellings agree on is the
 * *name*, so the filter is reduced to the name it can select — `*.env`, `**\/.env`
 * and `src/**\/*.env` all reduce to `.env` — and that name is judged as a path.
 *
 * A reduction is the conservative direction: it can only add a refusal, never
 * remove one, and a filter that reduces to nothing, or to a name no rule and no
 * predicate recognizes, is left to the normal approval path. Braced alternations
 * are expanded first so each alternative is judged on its own — see
 * {@link filterNameCandidates}.
 *
 * @param value - one filter glob, as the call wrote it.
 * @returns the literal name it can select, or `undefined` when it names none.
 */
export function filterNameCandidate(value: string): string | undefined {
  return filterNameCandidates(value)[0]
}

/**
 * Every literal file name one filter glob can select.
 *
 * Plural because a braced filter selects every alternative at once, and a
 * judgment that only kept the first (or concatenated them) would pass
 * `include: '*.{env,md}'` while the tool printed `.env`. Deduplicated so nested
 * braces that expand to the same name are not judged twice.
 *
 * @param value - one filter glob, as the call wrote it.
 * @returns one entry per distinct name the filter can select; empty when none.
 */
export function filterNameCandidates(value: string): readonly string[] {
  const names: string[] = []
  for (const expanded of expandFilterBraces(value)) {
    const name = filterNameCandidateLiteral(expanded)
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Every path a tool call names, in the order the call states them.
 *
 * Plural on purpose: a judgment that stopped at the first path would pass a batch
 * call whose second entry is the denied one, and a denial is the only thing this
 * can do, so a partial reading is a bypass rather than a strictness tradeoff. A
 * list entry that is not a string is skipped rather than stringified, because a
 * coerced `null` would name a file called `null`.
 * @param args - the call's arguments, of unknown shape.
 * @returns one entry per named path, plus one per name a filter can select; empty
 *   for a call that touches no file.
 */
export function pathArgumentsOf(args: unknown): readonly { readonly key: string; readonly value: string }[] {
  if (args === null || typeof args !== 'object') return []
  const record = args as Record<string, unknown>
  const found: { readonly key: string; readonly value: string }[] = []
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') found.push({ key, value })
  }
  for (const key of PATH_LIST_ARGUMENT_KEYS) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (typeof entry === 'string' && entry !== '') found.push({ key, value: entry })
    }
  }
  // Last, because a filter is the least specific statement a call makes about what
  // it touches: the paths above are what it operates on, this is what it selects.
  // Every candidate, not the first: a braced filter selects every alternative, and
  // stopping at one would pass `*.{env,md}` after judging only `md`.
  for (const key of PATH_FILTER_ARGUMENT_KEYS) {
    const value = record[key]
    if (typeof value !== 'string') continue
    for (const name of filterNameCandidates(value)) found.push({ key, value: name })
  }
  return found
}

/**
 * The first path a tool call names, if it names one.
 *
 * The shape most callers want — a single answer for a diagnostic, or a call that
 * names one file. {@link denyRefusal} uses {@link pathArgumentsOf} instead, because
 * a judgment has to see every path rather than the first.
 * @param args - the call's arguments, of unknown shape.
 * @returns the key that carried it and the value, or `undefined` for a call that touches no file.
 */
export function pathArgumentOf(args: unknown): { readonly key: string; readonly value: string } | undefined {
  return pathArgumentsOf(args)[0]
}

/**
 * Whether a tool call touches a denied path.
 *
 * The single judgment for every surface that can refuse a call — the registry guard
 * and the native engine's permission callback both call this, so they cannot
 * disagree about one path. It covers reads and writes with no direction argument:
 * a deny list that stopped writes while allowing reads would still hand the file's
 * contents to the model.
 *
 * Refusal is all this can do. A call it does not judge still goes on to the normal
 * approval path, so a rule here can only remove a capability, never grant one.
 * @param input - the deny globs in force, the call's arguments, and the platform.
 * @returns a denial message naming the pattern that matched, or `undefined`.
 */
export function denyRefusal(input: {
  readonly deny: readonly string[]
  readonly args: unknown
  readonly platform?: NodeJS.Platform
}): string | undefined {
  if (input.deny.length === 0) return undefined
  const paths = pathArgumentsOf(input.args)
  // A call that names no file — a shell command, a fetch — is out of scope here by
  // construction. Redirection inside a shell string is the sandbox *mode*'s
  // responsibility, and the report says so rather than pretending otherwise.
  //
  // Every named path is judged, not the first: a batch call is exactly where one
  // denied file hides behind an allowed one.
  for (const path of paths) {
    const matched = denyMatch(input.deny, path.value, input.platform)
    if (matched === undefined) continue
    return `FREECODEGO_SANDBOX_DENY: ${path.value} is denied by the sandbox profile pattern "${matched}" ${DENY_SCOPE}`
  }
  return undefined
}

/** The sentence both tiers' refusals end with: what this refuses, and what it cannot. */
const DENY_SCOPE = '(this denies reads and writes; use a narrower mode for kernel-level enforcement)'

/**
 * Whether a vocabulary key carries a path, rather than a name a filter can select.
 *
 * The distinction matters to the resolution tier and to nothing else: a filter
 * (`include`/`glob`) states a *name* that the searched directory is scanned for, so
 * resolving it would invent a path — against this process's working directory, which
 * the call never named — and a rule naming that directory would then refuse a search
 * that touches nothing it protects. The lexical tier judges names on purpose; only
 * paths are resolved.
 */
function isPathKey(key: string): boolean {
  return (PATH_ARGUMENT_KEYS as readonly string[]).includes(key) || (PATH_LIST_ARGUMENT_KEYS as readonly string[]).includes(key)
}

/**
 * Whether a tool call reaches a denied path through a symlink, a junction, or an
 * alternate name.
 *
 * The lexical tier answers about the *name* the call states, and a link is the one
 * construction that separates a name from the file it reads: after
 * `mklink /J work\link C:\secrets`, a call naming `work/link/token.txt` passes every
 * rule {@link denyRefusal} can apply while the tool still hands the file over. So
 * this tier resolves the same paths the filesystem would open — through the nearest
 * existing ancestor, so a write target that does not exist yet still counts.
 *
 * It **only adds refusals**, and fail-open is the rule for a path that cannot be
 * resolved (a permission error, a dangling link, a race): the lexical answer stands,
 * rather than an I/O failure becoming a refusal the model cannot act on. That is the
 * credential shield's discipline in `tool-guards.ts`, and the two tiers share one
 * resolver (`sandbox/realpath.ts`) so a single call cannot be refused by one guard
 * and allowed by the other.
 *
 * @param input - the deny globs in force, the call's arguments, and the platform.
 * @returns a denial message naming the pattern that matched, or `undefined`.
 */
export async function denyRealpathRefusal(input: {
  readonly deny: readonly string[]
  readonly args: unknown
  readonly platform?: NodeJS.Platform
}): Promise<string | undefined> {
  if (input.deny.length === 0) return undefined
  const entries = pathArgumentsOf(input.args)
  // Already answered by the lexical tier; the syscall would only repeat it. Answered
  // here rather than skipped, so this function stands on its own: a caller that wires
  // only the resolution tier still gets the same refusal for the same spelling.
  for (const entry of entries) {
    const matched = denyMatch(input.deny, entry.value, input.platform)
    if (matched !== undefined) return `FREECODEGO_SANDBOX_DENY: ${entry.value} is denied by the sandbox profile pattern "${matched}" ${DENY_SCOPE}`
  }
  for (const entry of entries) {
    if (!isPathKey(entry.key)) continue
    const resolved = await realpathThroughMissingTail(entry.value)
    if (resolved === undefined) continue
    const matched = denyMatch(input.deny, resolved, input.platform)
    if (matched === undefined) continue
    return `FREECODEGO_SANDBOX_DENY: ${entry.value} resolves to ${resolved}, which the sandbox profile pattern "${matched}" denies ${DENY_SCOPE}`
  }
  return undefined
}

/** Named custom profiles, by profile name. */
export type SandboxProfileDocument = Readonly<Record<string, SandboxProfileSpec>>

/**
 * Merge the profile documents that can define profiles, in precedence order.
 *
 * Three rules, each of which exists because the alternative is a surprise:
 *
 * 1. **A custom profile may not take a builtin's name.** Registering `workspace`
 *    would make every existing reference to it mean something else, and the
 *    reference most likely to exist is the user's own `extends`. This is rejected
 *    at registration rather than resolved at use, so the failure is loud and early
 *    instead of silent and per-call.
 * 2. **The user's document wins over the repository's** when both define the same
 *    profile, and the conflict is reported. The project document arrives with a
 *    clone, so letting it win would let a repository redefine a profile the user
 *    already relies on.
 * 3. **Identical definitions are not a conflict.** Reporting them would train the
 *    user to ignore the warning, which is how a real one gets missed.
 *
 * The project document is expected to have passed the folder-trust gate before it
 * reaches here; this function does not ask, because a merge that also decided trust
 * would be a second place that decides it.
 * @param input - the builtin names to reserve, and the documents in precedence order.
 * @returns the merged profiles and the problems worth telling the user about.
 */
export function mergeSandboxProfiles(input: {
  readonly user?: SandboxProfileDocument
  readonly project?: SandboxProfileDocument
}): { readonly profiles: SandboxProfileDocument; readonly notices: readonly string[] } {
  const notices: string[] = []
  const profiles: Record<string, SandboxProfileSpec> = {}
  const reserved = new Set<string>(BUILTIN_SANDBOX_PROFILES)

  for (const [source, document] of [['project', input.project], ['user', input.user]] as const) {
    for (const [name, spec] of Object.entries(document ?? {})) {
      // Builtins are rejected from every source, including the user's own file: a
      // profile named `workspace` would change what every `extends` means.
      if (reserved.has(name)) {
        notices.push(`${source} profile "${name}" is ignored: ${name} is a builtin profile name and cannot be redefined`)
        continue
      }
      const existing = profiles[name]
      if (existing === undefined) {
        profiles[name] = spec
        continue
      }
      // The user's document is iterated second, so reaching here means the user is
      // the later writer and therefore the one that wins.
      if (sameSpec(existing, spec)) continue
      notices.push(`profile "${name}" is defined differently in the project and user files; the user's definition is used`)
      profiles[name] = spec
    }
  }
  return { profiles, notices }
}

/**
 * Whether two specs are the same profile, for conflict reporting.
 *
 * Compares resolved output rather than the written shape, because two profiles that
 * differ only in the order of their entries behave identically and warning about
 * them would be a false alarm.
 * @param left - one spec.
 * @param right - the other.
 * @returns whether both resolve to the same profile on this platform.
 */
function sameSpec(left: SandboxProfileSpec, right: SandboxProfileSpec): boolean {
  const resolve = (spec: SandboxProfileSpec): string => JSON.stringify(resolveSandboxProfile(spec))
  return resolve(left) === resolve(right)
}
