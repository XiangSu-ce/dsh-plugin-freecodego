/**
 * The one list of command shapes that must not pass unreviewed.
 *
 * Why this is a module rather than a constant beside its first caller
 * ------------------------------------------------------------------
 * Two surfaces judge content that reaches the other. The asset audit in
 * `engineering.ts` runs *before* externally sourced skills, MCP configurations and
 * catalog entries are written to a managed directory or a settings document; the
 * publish pre-flight in `skills/publish.ts` runs over a skill about to leave the
 * machine. Each carried its own list, and they disagreed in **both** directions:
 * `mkfs`, `dd if=`, `chmod -R 777`, `git push --force`, an unqualified `sudo` and a
 * bare `eval(` were errors at publish time and invisible to the audit, while
 * `rm -fr` was the reverse — refused by the audit, missed by the pre-flight.
 *
 * A command that is dangerous on one surface and fine on the other is not a strict
 * surface and a loose one. It is one rule written twice, and only one copy was
 * maintained — the same shape as the path-key vocabularies in `tool-guards.ts` and
 * `sandbox/profiles.ts`, and the reason those were collapsed into one list too.
 *
 * The list lives in its own module so the property is structural rather than a
 * convention: both surfaces import it, and a private copy would be visible as a
 * second declaration. Nothing asserts that absence mechanically yet, so what holds
 * it is the shape of the imports rather than a test.
 *
 * Legible rather than exhaustive, deliberately: the point of these patterns is to
 * make a human look at content that arrived from outside. A list long enough to hit
 * every legitimate release script is a list whose hits stop meaning anything.
 * Nothing here is a security boundary in itself — the boundary is the read it
 * forces, plus the command policy that judges what actually runs.
 *
 * A shape and a word are read differently, because they are different evidence.
 * `rm -rf /` is not something prose writes by accident, while "never call `eval()`"
 * and "run this with sudo" match a rule without instructing anyone to run
 * anything. Those two entries are named in
 * {@link DANGEROUS_COMMAND_MENTION_PATTERNS}, and each reader decides what a
 * mention is worth: the publish pre-flight reports it as a warning instead of
 * refusing the skill, and the asset audit records it as a warning finding instead
 * of a blocking one. Both readers weigh a *shape* the way they always did. Without
 * that split a legitimate skill — one that documents the guard, or tells a person
 * to install something themselves — could not be published or installed at all,
 * which is how a validator loses its audience.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/dangerous-command-patterns
 */

import { POWERSHELL_EXPRESSION_PROGRAMS, POWERSHELL_FETCH_PROGRAMS, SHELL_INTERPRETERS } from './command-policy.ts'

/**
 * The shells a pipeline can hand a download to, as a regular-expression source.
 *
 * Derived from {@link SHELL_INTERPRETERS} rather than written again, because the
 * copy is what this module was already guilty of: the list said `sh|bash|zsh` while
 * `command-policy.ts` had grown `pwsh`, `powershell`, `cmd`, `fish` and `script`, so
 * `curl … | pwsh` was a download piped into a shell that this audit could not see.
 * Longest name first, so `pwsh` is not read as `sh` followed by a stray `w`.
 */
const SHELL_INTERPRETER_SOURCE = [...SHELL_INTERPRETERS].sort((left, right) => right.length - left.length).join('|')

/** PowerShell's fetch verbs, the counterpart of `curl`/`wget`, from the policy. */
const POWERSHELL_DOWNLOADERS = POWERSHELL_FETCH_PROGRAMS.join('|')

/** PowerShell's evaluator, the counterpart of a shell, from the policy. */
const POWERSHELL_EXECUTORS = POWERSHELL_EXPRESSION_PROGRAMS.join('|')

/**
 * The `cmd` delete verbs, still spelled out here on purpose.
 *
 * The policy names the same four verbs, but as three rule patterns that guard probes
 * anchor on, so importing them would move two surfaces at once. This is the one copy
 * of a vocabulary this module keeps, and it is written down as a copy rather than as
 * a coincidence.
 */
const CMD_DELETE_PROGRAMS = 'rd|rmdir|del|erase'

/**
 * What may sit between the two switches that make a `cmd` deletion recursive *and*
 * forced: more switches, and nothing else.
 *
 * `cmd` switches take no value, so other switches are irrelevant to the reading and
 * `del /f /s /q` is the same operation as `del /s /q`. This is the half of the gap
 * rule that is permissive — the PowerShell half below is strict, because a
 * PowerShell parameter *may* take a value and a gap that swallowed values would pair
 * flags from two different commands.
 */
const CMD_SWITCH_GAP = '(?:\\s+/[a-z]+)*\\s*'

/**
 * What a dangerous command looks like, as this plugin defines it.
 *
 * One entry per way content goes wrong:
 *
 * - **a download piped into an interpreter** — the fetch is not the problem, the
 *   execute is, which is why a bare `curl` is deliberately absent; the window is
 *   bounded so the pattern cannot run away across a long document. Both halves come
 *   from the policy's vocabularies, because "an operation, one of its spellings" is
 *   the defect this rule exists for: `curl … | pwsh` was refused while
 *   `iwr … | iex` was invisible, and the missing half was the verb, not the shape,
 * - **recursive force-deletion in any flag spelling** — `-rf`, `-fr`, `-Rf`,
 *   `-r -f`, `-f -r`, with or without trailing letters, because a list that only
 *   knew one spelling is exactly how `rm -fr` slipped past the audit. The Windows
 *   spellings are here for the same reason: `Remove-Item -Recurse -Force` and
 *   `del /s /q` are that operation, and leaving them out would repeat the defect one
 *   platform over. On Windows the two flags must be adjacent, and that difference is
 *   deliberate: a PowerShell parameter may take a value, so a gap that swallowed
 *   values would pair a `-Recurse` with a `-Force` that belongs to another command,
 *   while a `cmd` switch cannot take one and `/f /s /q` is one operation,
 * - **a bare `eval(`** — it runs whatever text it is handed,
 * - **`chmod -R 777` in any flag or mode spelling** — `-R`, `-r`, the clustered
 *   `-Rv`, the long `--recursive`, and the mode with or without a leading zero,
 *   because a list that knows one spelling of an operation is how this list
 *   missed `rm -fr`; the pattern names the recursive flag and the octal modes
 *   ending in a world-writable `777`/`666`, and leaves the *other* spellings of
 *   the same operation (`a+rwx`, `ugo=rwx`) to the command policy, which decides
 *   what actually runs and asks about a recursive chmod it cannot name. An audit
 *   list that tried to enumerate symbolic modes would report the unbounded
 *   permutations of them, and a finding nobody can act on is a finding nobody
 *   reads,
 * - **a forced push** — it discards whatever the remote already holds,
 * - **an unqualified `sudo`** — content asking for a privilege whose shape the
 *   reader cannot see, which is the whole reason to look before installing it,
 * - **`mkfs` and `dd if=`** — they write over a device rather than a file.
 *
 * Assembled with `new RegExp(<source>, 'i')` rather than written as literals, so the
 * vocabulary above appears as a name instead of as escaped text: a probe that has to
 * anchor on this line should quote a vocabulary, not a backslash run.
 */
/**
 * The two entries above that a *sentence* produces as easily as a command.
 *
 * A shape and a word are two different kinds of evidence. `rm -rf /` is not
 * something prose writes by accident, so a match is the operation itself. A bare
 * `eval(` and an unqualified `sudo` are words: "never call `eval()` here", "ask
 * the user to run this with sudo" and "`sudo` is refused by the guard" all match
 * the same pattern while instructing nobody to run anything. That difference
 * cannot be seen in a regular expression, so it is carried as a name and decided
 * by each reader — see {@link DANGEROUS_COMMAND_MENTION_PATTERNS}.
 *
 * They are constants rather than literals in the array so the identity is
 * shareable: a set of equal-but-distinct `RegExp` objects would look like it
 * worked and match nothing.
 */
const BARE_PRIVILEGE = /\bsudo\b/

/** A bare `eval(` — named for the same reason {@link BARE_PRIVILEGE} is. */
const EVAL_CALL = /\beval\s*\(/

export const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?:curl|wget|${POWERSHELL_DOWNLOADERS})[^\\n|]{0,500}\\|\\s*(?:${SHELL_INTERPRETER_SOURCE}|${POWERSHELL_EXECUTORS})\\b`, 'i'),
  new RegExp('\\brm\\s+-[a-z]*r[a-z]*f|\\brm\\s+-[a-z]*f[a-z]*r|\\brm\\s+-r\\s+-f|\\brm\\s+-f\\s+-r', 'i'),
  new RegExp('\\b(?:remove-item|ri)\\b[^\\n|]{0,200}?(?:-recurse|-r)\\s+(?:-force|-fo)\\b|\\b(?:remove-item|ri)\\b[^\\n|]{0,200}?(?:-force|-fo)\\s+(?:-recurse|-r)\\b', 'i'),
  new RegExp(`\\b(?:${CMD_DELETE_PROGRAMS})\\b[^\\n|]{0,120}?(?:/s${CMD_SWITCH_GAP}(?:/q|/f)|(?:/q|/f)${CMD_SWITCH_GAP}/s)\\b`, 'i'),
  EVAL_CALL,
  /\bchmod\s+(?:-[A-Za-z]*[Rr][A-Za-z]*|--recursive)\s+0*[0-7]?(?:777|666)\b/,
  /\bgit\s+push\s+--force\b/,
  BARE_PRIVILEGE,
  /\bmkfs\b|\bdd\s+if=/,
]

/**
 * The entries a mention is enough to match, as object identity.
 *
 * The reader that *refuses* something needs this, and the reader that only
 * reports does not: a word in prose is worth a reviewer's glance and is not
 * worth blocking a publish or an install over. Both readers still read the one
 * list above — this names two of its entries rather than adding a second list,
 * which is the defect this module exists to prevent.
 */
export const DANGEROUS_COMMAND_MENTION_PATTERNS: ReadonlySet<RegExp> = new Set([BARE_PRIVILEGE, EVAL_CALL])

/** One dangerous command found in a document, and how it was found. */
export interface DangerousCommandFinding {
  /** The matched text, as it appears in the document. */
  readonly command: string
  /**
   * Whether the pattern is one a sentence produces by accident, so the caller can
   * weigh a quoted word differently from a shape that can only be an operation.
   * See {@link DANGEROUS_COMMAND_MENTION_PATTERNS}.
   */
  readonly mention: boolean
}

/**
 * Every dangerous command in a document, one entry per pattern that matched, each
 * carrying whether it was found as a *shape* or as a *word*.
 *
 * All of them rather than the first, because both callers report what they found
 * and a reviewer deciding whether to look needs the whole list, not the first
 * entry of it. The matched text is returned rather than a boolean for the same
 * reason: a finding that says only "dangerous" cannot be acted on without reading
 * the entire asset.
 * @param text - the document to scan.
 * @returns one finding per pattern that matched, in list order.
 */
export function dangerousCommandFindings(text: string): readonly DangerousCommandFinding[] {
  const found: DangerousCommandFinding[] = []
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    const match = pattern.exec(text)
    if (match !== null) found.push({ command: match[0], mention: DANGEROUS_COMMAND_MENTION_PATTERNS.has(pattern) })
  }
  return found
}

/**
 * Every dangerous command in a document, as matched text.
 *
 * The reading for a caller that treats a name and an operation alike.
 * @param text - the document to scan.
 * @returns the matched text of each pattern that matched, in list order.
 */
export function dangerousCommandsIn(text: string): readonly string[] {
  return dangerousCommandFindings(text).map(finding => finding.command)
}

/**
 * The first dangerous command in a document, if any.
 *
 * For callers that only need the verdict and the one name to report.
 * @param text - the document to scan.
 * @returns the matched text, or undefined when nothing matched.
 */
export function findDangerousCommand(text: string): string | undefined {
  return dangerousCommandsIn(text)[0]
}
