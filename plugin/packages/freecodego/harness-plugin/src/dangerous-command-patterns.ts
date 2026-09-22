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
 *   bounded so the pattern cannot run away across a long document. The verb is
 *   matched as a whole word, because it was not: `curl` inside "curling" and `irm`
 *   inside "confirm" each matched, so an English sentence that happened to contain
 *   one of those words and a later `| sh` was reported as a fetch piped into a
 *   shell. A word that is not even the program is not the lenient reading this
 *   module makes elsewhere — it is a plain false positive, and the audit that
 *   reports it is the audit nobody finishes reading. Both halves come
 *   from the policy's vocabularies, because "an operation, one of its spellings" is
 *   the defect this rule exists for: `curl … | pwsh` was refused while
 *   `iwr … | iex` was invisible, and the missing half was the verb, not the shape,
 * - **recursive force-deletion in any flag spelling** — `-rf`, `-fr`, `-Rf`,
 *   `-r -f`, `-f -r`, with or without trailing letters, because a list that only
 *   knew one spelling is exactly how `rm -fr` slipped past the audit. That
 *   enumeration was the same defect one step on: it was complete for the pairs
 *   someone had thought of, and silent for `rm --recursive --force`, `rm -r
 *   --force` and `rm -v -r -f` — the operation with a long spelling, or with one
 *   more flag in front of the pair. The POSIX rule is therefore written as the
 *   fact — one `rm`, then a recursion token and a force token inside that one
 *   command, in either order — so the spellings above are what it *matches* rather
 *   than what it *knows*. The Windows
 *   spellings are here for the same reason: `Remove-Item -Recurse -Force` and
 *   `del /s /q` are that operation, and leaving them out would repeat the defect one
 *   platform over. On Windows the two flags must be adjacent, and that difference is
 *   deliberate: a PowerShell parameter may take a value, so a gap that swallowed
 *   values would pair a `-Recurse` with a `-Force` that belongs to another command,
 *   while a `cmd` switch cannot take one and `/f /s /q` is one operation,
 * - **a bare `eval(`** — it runs whatever text it is handed,
 * - **`chmod -R 777` in any flag or mode spelling** — `-R`, `-r`, the clustered
 *   `-Rv`, the long `--recursive`, and the mode with or without a leading zero,
 *   in either order and with other flags in front of it (`chmod -R -v 777 .`,
 *   which the rule missed while it read the mode as the token right after the one
 *   recursive flag), because a list that knows one spelling of an operation is how this list
 *   missed `rm -fr`; the pattern names the recursive flag and the octal modes
 *   ending in a world-writable `777`/`666`, and leaves the *other* spellings of
 *   the same operation (`a+rwx`, `ugo=rwx`) to the command policy, which decides
 *   what actually runs and asks about a recursive chmod it cannot name. An audit
 *   list that tried to enumerate symbolic modes would report the unbounded
 *   permutations of them, and a finding nobody can act on is a finding nobody
 *   reads,
 * - **a forced push** — it discards whatever the remote already holds, in either
 *   spelling and wherever the flag sits in the line, because `git push origin main
 *   --force` is how the flag is usually written and the rule used to require it
 *   immediately after the subcommand. `--force-with-lease` is deliberately *not*
 *   this operation: it refuses when the remote has moved rather than discarding what
 *   is there, so a skill documenting the safe form is not refused a publish for
 *   naming it,
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

/**
 * Flag vocabularies, and the command window a rule may look through to find them.
 *
 * Why a vocabulary rather than a spelling
 * --------------------------------------
 * The rule for a recursive force-deletion used to name the flag pairs someone had
 * thought of — `-rf`, `-fr`, `-r -f`, `-f -r` — and an enumeration of spellings is a
 * rule that is right about the entries it has and silent about the operation. It was
 * repaired once, from a lone `-rf` to that list, and the repair was still an
 * enumeration: `rm --recursive --force`, `rm -r --force` and `rm -v -r -f` were all
 * invisible, so a reviewer reading this audit was told that a workspace-wiping line
 * was fine. Measured before this change: of the spellings the matrix in
 * `tests/dangerous-command-patterns.spec.ts` asserts, nine were reported as nothing —
 * four ways of writing a forced push, four of a recursive force-deletion, and the
 * recursive chmod whose mode follows a second flag.
 *
 * So the rule is written as the fact instead: *one* `rm`, and then, inside the rest
 * of that one command, a token asking for recursion and a token asking to stop
 * asking. Order stops mattering because the two lookaheads answer independently, and
 * spelling stops mattering because each is a vocabulary.
 */

/**
 * The rest of one command: how far a rule may look, and no further.
 *
 * Bounded for the reason every window in this file is bounded, and stopped by `|`,
 * `;`, `&` and a newline so two neighbouring commands cannot lend each other a flag:
 * `rm -r a; rm -f b` is two commands and not one recursive force-deletion.
 */
const FLAG_WINDOW = '[^\\n|;&]{0,120}'

/**
 * Where a flag token may begin: after a space, or at the start of the window.
 *
 * This is the half that keeps a `-` inside a name from reading as a flag. Without
 * it, `rm -r my-file` matched — the name's `-f` spelled the force flag — and a
 * finding about a file called `my-file` is a finding nobody can act on.
 */
const TOKEN_START = '(?<!\\S)'

/** One token asking for recursion: `-r`, `-R`, `-rR`, `--recursive`. */
const RECURSIVE_FLAG = '(?:-[a-z]*r[a-z]*|--recursive)'

/**
 * One token asking to stop asking: `-f`, `--force`.
 *
 * One vocabulary for the deletion rule and the push rule, because it is one word
 * that two operations each spell two ways.
 */
const FORCE_FLAG = '(?:-[a-z]*f[a-z]*|--force)'

/**
 * One token a recursive `chmod` must not be given: an octal mode ending in a
 * world-writable `777` or `666`, with or without its leading zero.
 *
 * A vocabulary for the same reason the flags are: the mode is a token to be found,
 * not a position to be counted to. The rule used to read `chmod -R 777` as "the mode
 * immediately after the one recursive flag", so `chmod -R -v 777 .` — the same
 * operation with a second flag in front of the mode — was invisible.
 */
const CHMOD_MODE = '0*[0-7]?(?:777|666)\\b'

/** Command shapes the guard treats as destructive, whatever their spelling. */
export const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b(?:curl|wget|${POWERSHELL_DOWNLOADERS})\\b[^\\n|]{0,500}\\|\\s*(?:${SHELL_INTERPRETER_SOURCE}|${POWERSHELL_EXECUTORS})\\b`, 'i'),
  new RegExp(`\\brm\\s+(?=${FLAG_WINDOW}?${TOKEN_START}${RECURSIVE_FLAG})(?=${FLAG_WINDOW}?${TOKEN_START}${FORCE_FLAG})${FLAG_WINDOW}`, 'i'),
  new RegExp('\\b(?:remove-item|ri)\\b[^\\n|]{0,200}?(?:-recurse|-r)\\s+(?:-force|-fo)\\b|\\b(?:remove-item|ri)\\b[^\\n|]{0,200}?(?:-force|-fo)\\s+(?:-recurse|-r)\\b', 'i'),
  new RegExp(`\\b(?:${CMD_DELETE_PROGRAMS})\\b[^\\n|]{0,120}?(?:/s${CMD_SWITCH_GAP}(?:/q|/f)|(?:/q|/f)${CMD_SWITCH_GAP}/s)\\b`, 'i'),
  EVAL_CALL,
  new RegExp(`\\bchmod\\b(?=${FLAG_WINDOW}?${TOKEN_START}${RECURSIVE_FLAG})(?=${FLAG_WINDOW}?${TOKEN_START}${CHMOD_MODE})${FLAG_WINDOW}`, 'i'),
  new RegExp(`\\bgit\\s+push\\b(?=${FLAG_WINDOW}?${TOKEN_START}${FORCE_FLAG}(?![\\w-]))${FLAG_WINDOW}`, 'i'),
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
