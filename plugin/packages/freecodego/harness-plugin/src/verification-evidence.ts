/**
 * What makes a command *evidence* that a change was verified.
 *
 * Why
 * ---
 * `engineering-quality.ts` already enforces the honest half of the contract: a
 * pass must carry the command that ran and the exit status it returned, and a
 * probe must hold a declared expectation. What it could not tell is whether the
 * command it recorded was a *check at all*. So the cheapest way to turn a red
 * run green was to declare a probe whose program cannot fail —
 * `node -e "process.exit(0)"` holds every expectation it is given — and the
 * verdict would read `verified` while nothing about the change had been
 * falsified. The failure is not that the probe lied; it is that the verdict
 * accepted an observation that could not have contradicted anything.
 *
 * Hermes' `agent/verification_evidence.py` is the reference for the missing
 * half. Its three questions are the ones this module answers, in the same order:
 *
 * 1. **Is this command a verification?** (`classify_verification_command`) — a
 *    runner the project's own gates use, a project-declared script, or a program
 *    run against a file inside the workspace. `echo`, `true`, `ls`, `sleep` and
 *    an inline script with no failing path are not.
 * 2. **Is the exit status attributable to the check?** (`_exit_status_is_attributable`)
 *    — a shell line that pipes its check into `tail` reports the *filter's*
 *    status, so a failing check reads as a pass. (A line that ends in `|| true`
 *    or `; echo done` is caught by question 1 instead, because its last stage is
 *    not a check at all — one refusal is enough to make the point, and two
 *    reasons for one line would only make the report harder to read.)
 * 3. **Does the check have anything to do with the change?**
 *    (`_find_canonical_match`, `_is_under_temp_dir`) — a suite run covers the
 *    change by being a superset of it; a command naming an unrelated path does
 *    not; a script under a temporary directory is not part of the workspace it
 *    claims to verify.
 *
 * Deliberate limits, stated rather than implied:
 *
 * - **This is not a shell parser.** It tokenizes enough to find separators,
 *   pipes and a trailing stage, and it treats anything it cannot read as
 *   *eligible* rather than ineligible. A classifier that refused unfamiliar
 *   shapes would block real projects, and refusing a good check is a worse
 *   failure than admitting a weak one — the weak one still has to carry its
 *   command and exit status into the report, where a reader can see what it was.
 * - **A project-declared script is never second-guessed.** When `package.json`
 *   says `"tests": "cleantest"`, the declaration is the intent; what this module
 *   refuses is a command that is *not* a check by any reading, not a check it
 *   does not recognize.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/verification-evidence
 */

import { SHELL_INTERPRETERS, commandProgramIndex } from './command-policy.ts'

/** Which kind of project gate a command belongs to. */
export type VerificationCommandKind = 'tests' | 'types' | 'lint' | 'build' | 'check-script' | 'not-a-check'

/** One command's verdict about whether it can falsify anything. */
export interface VerificationCommandClassification {
  /** Whether the command is a check at all. */
  readonly verification: boolean
  /**
   * Set when the verdict came from reading an inline evaluation.
   *
   * The program evaluates code written on the command line, so there is no path in
   * the command for a coverage reading to match and the declaration that the script
   * targets the change is the only thing left to read. Recorded here rather than
   * re-derived by a caller: a second reader of "is this an inline script?" would key
   * off the token alone, and `tsc -p packages/app/tsconfig.json` carries one.
   */
  readonly inline?: true
  readonly kind: VerificationCommandKind
  /** The bare program this classification is anchored on, when one was found. */
  readonly runner?: string
  /** Why, in a sentence a report can carry verbatim. */
  readonly reason: string
}

/** Whether a shell line's exit status reports the check rather than a filter. */
export interface ExitStatusAttribution {
  readonly attribuable: boolean
  readonly reason: string
}

/** How far a command's coverage reaches the paths a change touched. */
export type VerificationCoverage = 'targeted' | 'suite' | 'unrelated'

/** How deep a dispatcher chain is followed before the reader admits it stopped. */
const MAX_DISPATCH_DEPTH = 4

/** Programs that observe the workspace without ever failing on its content. */
const NO_OP_PROGRAMS: ReadonlySet<string> = new Set([
  'echo', 'printf', 'true', ':', 'ls', 'dir', 'cat', 'type', 'pwd', 'date', 'sleep', 'wait', 'test', 'env', 'which', 'whoami',
])

/** Programs whose exit status is the *previous* stage's output status, not a check's. */
const STATUS_FILTERS: ReadonlySet<string> = new Set(['tail', 'head', 'cat', 'tee', 'grep', 'awk', 'sed', 'wc', 'sort', 'uniq', 'cut', 'tr'])

/** Test runners, by the bare program a command starts with. */
const TEST_PROGRAMS: ReadonlySet<string> = new Set([
  'vitest', 'jest', 'mocha', 'ava', 'tap', 'uvu', 'playwright', 'cypress', 'pytest', 'rspec', 'phpunit', 'bats',
])

/** Type checkers. `tsc` is here rather than under builders because that is the stage it serves. */
const TYPE_PROGRAMS: ReadonlySet<string> = new Set(['tsc', 'tsgo', 'vue-tsc', 'mypy', 'pyright', 'flow', 'svelte-check'])
const LINT_PROGRAMS: ReadonlySet<string> = new Set([
  'eslint', 'oxlint', 'biome', 'ruff', 'flake8', 'pylint', 'golangci-lint', 'clippy', 'shellcheck', 'stylelint', 'checkstyle', 'gofmt',
])

/** Multi-tool build systems whose *subcommand* decides whether they check anything. */
const BUILD_SYSTEMS: ReadonlySet<string> = new Set(['cargo', 'go', 'dotnet', 'gradle', 'mvn', 'make'])

/** Package managers whose `run <script>` and bare `<verb>` forms name a project gate. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'yarnpkg'])

/** Entry points that hand every argument to another program. */
const DISPATCHERS: ReadonlySet<string> = new Set(['npx', 'bunx', 'dlx'])

/** Package-manager verbs that hand off to the program named next. */
const DISPATCH_VERBS: ReadonlySet<string> = new Set(['exec', 'x'])

/** Package-manager verbs that manage the dependency tree instead of checking it. */
const TREE_VERBS: ReadonlySet<string> = new Set([
  'install', 'i', 'ci', 'add', 'a', 'remove', 'rm', 'r', 'uninstall', 'un', 'update', 'up', 'upgrade', 'link', 'ln', 'pack', 'publish',
  'init', 'create', 'config', 'get', 'set', 'cache', 'dedupe', 'prune', 'patch', 'fund', 'login', 'logout', 'view', 'info', 'repo', 'help',
  'why', 'ls', 'list', 'll', 'licenses', 'contributors',
])

/** Package-manager verbs that do report on the tree, so they are checks. */
const AUDIT_VERBS: ReadonlySet<string> = new Set(['audit', 'outdated', 'doctor'])

/**
 * Shells whose `-c`/`/c`/`-Command` argument is a line this module has to read.
 *
 * The policy's vocabulary, imported rather than written here a fourth time. The
 * second copy had drifted in **both** directions, and only one of them mattered:
 * it was missing `fish` and `script`, so `fish -c 'npm test'` was not read as a
 * shell line at all — its inner command was judged as the program `fish`, which no
 * rule and no runner knows, and the line was classified as an unrecognised script
 * rather than as the test run it is. It also carried `cmd.exe` and
 * `powershell.exe`, which are dead entries: {@link bareProgram} has already
 * lowercased the token and stripped the extension before this set is consulted, so
 * those two spellings could never be reached. Reading the same list the rule matcher
 * reads is what makes "a shell" one question with one answer; a copy can only be
 * right until the list it copies grows.
 */
const SHELL_PROGRAMS: ReadonlySet<string> = new Set(SHELL_INTERPRETERS)

/** Interpreters that can take code on the command line instead of in a file. */
const INLINE_INTERPRETERS: ReadonlySet<string> = new Set(['node', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'php'])

/**
 * The flags that make an interpreter *evaluate* the token after them, per program.
 *
 * One table rather than one set, because one spelling means different things to
 * different programs and the difference is the whole verdict. `-c` hands code to
 * `python`, while `node -c script.mjs` is `--check` — it *checks a file*, so the
 * token after it is a path and the command is an ordinary script run; `ruby -c` and
 * `perl -c` are the same syntax-check spelling, and `perl -p`/`ruby -p` are loop
 * modes that read no code from the line at all. A single shared set answered
 * `node --check script.mjs` and `node -c script.mjs` differently — the long spelling
 * correctly and the short one as `not-a-check`, "inline script with no assertion" —
 * so the same check counted as evidence or not depending on how it was typed, which
 * is the one thing this module's "two spellings, one answer" rule exists to stop.
 *
 * `php` is here for the same reason in the other direction: its evaluation flag is
 * `-r`, which the shared set never carried, so `php -r '…'` skipped the inline branch
 * altogether and the code was read as a **script file** — an unfalsifiable one-liner
 * became `check-script` evidence. Its `-e` (extended debug information) and `-c`
 * (an ini path) are deliberately *not* evaluation, and `-l` (lint) is an ordinary
 * check, which the script-file branch below already reads correctly.
 */
const EVALUATION_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['node', new Set(['-e', '--eval', '-p', '--print'])],
  ['bun', new Set(['-e', '--eval', '-p', '--print'])],
  ['python', new Set(['-c'])],
  ['python3', new Set(['-c'])],
  ['ruby', new Set(['-e'])],
  ['perl', new Set(['-e', '-E'])],
  ['php', new Set(['-r'])],
])

/**
 * The subcommand form of the same question, for an interpreter whose eval spelling
 * is a word rather than a flag: `deno eval "code"`. Listed separately because the
 * token after it is code, not a path, exactly like the flag forms above.
 */
const EVALUATION_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['deno', new Set(['eval'])],
])

/**
 * Where the interpreter evaluates code given on this command line, or -1.
 *
 * The returned index is the token holding the *flag* (or subcommand), so the code is
 * always the token after it — which keeps the flag form and the subcommand form one
 * arithmetic instead of two.
 * @param program - the bare program name.
 * @param argv - the command's tokens.
 * @returns the index of the evaluation site, or -1 when there is none.
 */
function evaluationSiteIndex(program: string, argv: readonly string[]): number {
  const flags = EVALUATION_FLAGS.get(program)
  if (flags !== undefined) {
    const index = argv.findIndex((part, position) => position > 0 && flags.has(part.toLowerCase()))
    if (index >= 0) return index
  }
  const words = EVALUATION_SUBCOMMANDS.get(program)
  return words !== undefined && words.has((argv[1] ?? '').toLowerCase()) ? 1 : -1
}
const SHELL_LINE_FLAGS: ReadonlySet<string> = new Set(['-c', '/c', '-command', '--command'])

/** Substrings that show an inline script has a way to report failure. */
const FAILURE_CAPABLE_TOKENS: readonly string[] = [
  'assert', 'expect(', 'should', 'throw', 'raise', 'fatal', 'panic(', 'exit(1', 'exit(2', 'sys.exit(1',
]

/** The last path segment of a token that looks like a program invocation. */
function bareProgram(token: string | undefined): string {
  if (token === undefined) return ''
  const trimmed = token.trim().toLowerCase()
  if (trimmed === '') return ''
  const segments = trimmed.split(/[\\/]/u)
  const name = segments[segments.length - 1] ?? ''
  return name.replace(/\.(?:exe|cmd|bat|ps1|mjs|cjs)$/u, '')
}

/** Split a shell line on separators and pipes, keeping the segments in reading order.
 * @param line - the shell line to split.
 * @returns the non-empty segments, in reading order.
 */
export function shellSegments(line: string): readonly string[] {
  return line
    .replace(/\r\n?/gu, '\n')
    .split(/\n|;|&&|\|\||[|&]/u)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
}

/** Whether an inline `-e`/`-p`/`-c` script contains a construct that can report failure.
 * @param script - the inline script text to inspect.
 * @returns true when the script can report failure.
 */
export function inlineScriptCanFail(script: string): boolean {
  const text = script.toLowerCase()
  return FAILURE_CAPABLE_TOKENS.some(token => text.includes(token))
}

/** Whether a path names a temporary location, which is never part of the workspace. 
 * @param path - path the operation acts on.
 * @returns true when the path names a temporary location.
 */
export function isTemporaryPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/').toLowerCase()
  return normalized.startsWith('/tmp/') || normalized.startsWith('/var/tmp/') || normalized.startsWith('/private/var/') ||
    /(?:^|\/)temp\//u.test(normalized) || /(?:^|\/)tmp\//u.test(normalized) || /appdata\/local\/temp\//u.test(normalized)
}

/** Whether an absolute path sits under a workspace root, by prefix after normalization. */
function isInsideWorkspace(path: string, workspaceRoot: string | undefined): boolean {
  if (workspaceRoot === undefined || workspaceRoot.trim() === '') return false
  const fold = (value: string): string => value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
  const target = fold(path)
  const root = fold(workspaceRoot)
  return root !== '' && (target === root || target.startsWith(`${root}/`))
}

/** The kind a project-declared script name implies, from its own words. */
function kindForScriptName(name: string): VerificationCommandKind {
  const normalized = name.toLowerCase()
  if (/test|spec/u.test(normalized)) return 'tests'
  if (/type|tsc/u.test(normalized)) return 'types'
  if (/lint|fmt|format/u.test(normalized)) return 'lint'
  if (/build|compile|bundle/u.test(normalized)) return 'build'
  return 'check-script'
}

/** The classification a bare program name implies, ignoring its role in a pipeline. */
function classifyProgram(program: string, args: readonly string[]): VerificationCommandClassification {
  if (program === '') {
    return { verification: false, kind: 'not-a-check', reason: 'the command names no program, so it ran nothing that could fail' }
  }
  if (NO_OP_PROGRAMS.has(program)) {
    return { verification: false, kind: 'not-a-check', reason: `\`${program}\` observes nothing and cannot fail on the change` }
  }
  if (TEST_PROGRAMS.has(program)) return { verification: true, kind: 'tests', runner: program, reason: `\`${program}\` is a test runner` }
  if (TYPE_PROGRAMS.has(program)) return { verification: true, kind: 'types', runner: program, reason: `\`${program}\` checks types` }
  if (LINT_PROGRAMS.has(program)) return { verification: true, kind: 'lint', runner: program, reason: `\`${program}\` lints` }
  if (BUILD_SYSTEMS.has(program)) {
    const sub = (args[0] ?? '').toLowerCase()
    if (program === 'cargo' && sub === 'clippy') return { verification: true, kind: 'lint', runner: program, reason: '`cargo clippy` lints' }
    if (sub === 'test') return { verification: true, kind: 'tests', runner: program, reason: `\`${program} ${sub}\` runs tests` }
    return { verification: true, kind: 'build', runner: program, reason: `\`${program}\` builds or checks the project` }
  }
  if (program === 'prettier' || program === 'black' || program === 'rustfmt') {
    const checking = args.some(arg => arg === '--check' || arg === '-c' || arg === '--check-only')
    return checking
      ? { verification: true, kind: 'lint', runner: program, reason: `\`${program} --check\` reports a diff` }
      : { verification: false, kind: 'not-a-check', reason: `\`${program}\` without --check rewrites files instead of reporting` }
  }
  return { verification: true, kind: 'check-script', runner: program, reason: `\`${program}\` is treated as a project invocation` }
}

/** Append the wrapper that led here, so a reader sees how the check was reached. */
function viaWrapper(inner: VerificationCommandClassification, wrapper: string): VerificationCommandClassification {
  return { ...inner, reason: `${inner.reason} (via \`${wrapper}\`)` }
}

/** Classify an argv, following dispatchers and shells down to the program that checks. */
function classifyArgv(argv: readonly string[], workspaceRoot: string | undefined, depth: number): VerificationCommandClassification {
  const program = bareProgram(argv[0])
  if (program === '') {
    return { verification: false, kind: 'not-a-check', reason: 'the command names no program, so it ran nothing that could fail' }
  }
  if (depth >= MAX_DISPATCH_DEPTH) {
    // Fail open and say so: a chain this deep is not something the reader can
    // voucher for, and refusing it would block a project that shells out twice.
    return { verification: true, kind: 'check-script', runner: program, reason: `\`${program}\` sits in a dispatcher chain deeper than the reader follows` }
  }
  if (DISPATCHERS.has(program)) {
    const index = argv.findIndex((part, position) => position > 0 && part !== '' && !part.startsWith('-'))
    if (index < 0) {
      return { verification: true, kind: 'check-script', runner: program, reason: `\`${program}\` invokes a program whose name the command omits` }
    }
    return viaWrapper(classifyArgv(argv.slice(index), workspaceRoot, depth + 1), program)
  }
  // The evaluation site is asked about **before** the package-manager verbs, and
  // that order is load-bearing rather than tidy: `bun` is both an interpreter and
  // a manager, so `bun -e 'process.exit(0)'` entered the branch below, found a verb
  // it does not know, handed `-e` back as a program name, and answered
  // `check-script` — an unfalsifiable probe restored to `verified` evidence by
  // changing the runtime. Which flag makes *this* program evaluate its argument is
  // the more specific fact, so it is read first.
  const evaluationSite = evaluationSiteIndex(program, argv)
  if (evaluationSite >= 0) {
    const script = argv[evaluationSite + 1] ?? ''
    return inlineScriptCanFail(script)
      ? { verification: true, kind: 'check-script', runner: program, inline: true, reason: `\`${program} ${argv[evaluationSite] ?? ''}\` carries an inline script that can fail` }
      : { verification: false, kind: 'not-a-check', runner: program, inline: true, reason: `\`${program} ${argv[evaluationSite] ?? ''}\` runs an inline script with no assertion, ` +
          'so it exits successfully whatever the change did' }
  }
  if (PACKAGE_MANAGERS.has(program)) {
    const verb = (argv[1] ?? '').toLowerCase()
    if (verb === 'test' || verb === 't' || verb === 'run-script') {
      return { verification: true, kind: 'tests', runner: program, reason: `\`${program} ${verb}\` runs the project's test gate` }
    }
    if (verb === 'run') {
      const name = (argv[2] ?? '').trim()
      // A project-declared script is the project's own statement of intent, so an
      // unrecognized name is still a check; only its *kind* is unknown.
      return name === '' || name.startsWith('-')
        ? { verification: true, kind: 'check-script', runner: program, reason: `\`${program} run\` invokes a project script` }
        : { verification: true, kind: kindForScriptName(name), runner: program, reason: `\`${program} run ${name}\` is a project-declared gate` }
    }
    if (DISPATCH_VERBS.has(verb)) {
      const index = argv.findIndex((part, position) => position > 1 && part !== '' && !part.startsWith('-'))
      return index < 0
        ? { verification: true, kind: 'check-script', runner: program, reason: `\`${program} ${verb}\` invokes a program whose name the command omits` }
        : viaWrapper(classifyArgv(argv.slice(index), workspaceRoot, depth + 1), `${program} ${verb}`)
    }
    if (TREE_VERBS.has(verb)) {
      return { verification: false, kind: 'not-a-check', runner: program, reason: `\`${program} ${verb}\` manages the dependency tree instead of checking anything` }
    }
    if (AUDIT_VERBS.has(verb)) {
      return { verification: true, kind: 'check-script', runner: program, reason: `\`${program} ${verb}\` reports on the tree and can fail on it` }
    }
    if (verb !== '') {
      // `pnpm pytest -q` runs pytest: the manager passes the word through to a
      // binary on PATH, so the program that decides the kind is the next one.
      return viaWrapper(classifyArgv(argv.slice(1), workspaceRoot, depth + 1), program)
    }
    return { verification: true, kind: 'check-script', runner: program, reason: `\`${program}\` runs with no subcommand to read` }
  }
  if (SHELL_PROGRAMS.has(program)) {
    const flagIndex = argv.findIndex((part, position) => position > 0 && SHELL_LINE_FLAGS.has(part.toLowerCase()))
    if (flagIndex >= 0) {
      const inner = argv.slice(flagIndex + 1).join(' ')
      const segments = shellSegments(inner)
      const last = segments[segments.length - 1]
      if (last === undefined) {
        return { verification: false, kind: 'not-a-check', runner: program, reason: `\`${program} ${argv[flagIndex] ?? ''}\` was given an empty line to run` }
      }
      const words = last.split(/\s+/u).filter(word => word !== '')
      return viaWrapper(classifyArgv(words, workspaceRoot, depth + 1), `${program} ${argv[flagIndex] ?? ''}`)
    }
  }
  if (INLINE_INTERPRETERS.has(program)) {
    // No evaluation site was found above, so the interpreter was given a *file* to
    // run. `node -c script.mjs`, `ruby -c app.rb` and `perl -c script.pl` land here,
    // which is what they are — a syntax check of a script, not an inline script, and
    // `node --check script.mjs` has always been read this way.
    const scriptArgument = argv.find((part, position) => position > 0 && !part.startsWith('-'))
    if (scriptArgument !== undefined) {
      if (isTemporaryPath(scriptArgument)) {
        return { verification: false, kind: 'not-a-check', runner: program, reason: `\`${program} ${scriptArgument}\` runs a script under a temporary directory, not the workspace` }
      }
      // Three answers, because "inside the workspace" and "we were not told the
      // workspace" are different facts and a report must not conflate them.
      if (workspaceRoot === undefined || workspaceRoot.trim() === '') {
        return { verification: true, kind: 'check-script', runner: program, reason: `\`${program} ${scriptArgument}\` runs a script file (workspace membership unstated)` }
      }
      return isInsideWorkspace(scriptArgument, workspaceRoot)
        ? { verification: true, kind: 'check-script', runner: program, reason: `\`${program} ${scriptArgument}\` runs a script inside the verified workspace` }
        : { verification: true, kind: 'check-script', runner: program, reason: `\`${program} ${scriptArgument}\` runs a script outside the verified workspace` }
    }
  }
  return classifyProgram(program, argv.slice(1))
}

/**
 * Classify one command as verification evidence or not.
 *
 * @param command - the argv the run recorded.
 * @param workspaceRoot - the session workspace, when the caller knows it. It only
 *   decides whether an interpreter's script argument is a file inside the
 *   workspace; absent, that question is answered as unstated rather than guessed.
 * @returns whether the command is a check, which kind, and why.
 */
export function classifyVerificationCommand(
  command: readonly string[],
  workspaceRoot?: string,
): VerificationCommandClassification {
  return classifyArgv([...command], workspaceRoot, 0)
}

/**
 * The form a path or path token is compared in.
 *
 * Test files name their subject through an infix — `src/a.test.ts` is the test
 * for `src/a.ts` — so a literal string comparison misses the most common
 * targeted run there is. Folding the infix away makes both sides meet.
 */
function matchForm(value: string): string {
  return value.replace(/\\/gu, '/').toLowerCase().replace(/\.(?:test|spec)(\.[^./]+)$/u, '$1')
}

/**
 * Whether a command's exit status can be read as the check's own outcome.
 *
 * A shell line reports the status of its **last** stage. `pnpm test | tail -20`
 * therefore exits 0 after a failing test run, and a report that carried only the
 * number would claim a pass the check never gave. The argv form is attributable
 * by construction: the program is the check.
 *
 * @param command - the argv the run recorded.
 * @returns whether the status belongs to the check, and why not when it does not.
 */
export function exitStatusIsAttributable(command: readonly string[]): ExitStatusAttribution {
  const argv = [...command]
  // Which program does this line run? Not `argv[0]` — a launcher can sit in front of
  // it. `timeout 30 sh -c "pnpm test | tail -20"`, `nice -n 5 sh -c …`,
  // `nohup sh -c …` and `env CI=1 sh -c …` all name their shell after a prefix, and a
  // reading anchored at position 0 saw the launcher, concluded "not a shell, so not a
  // pipeline", and called the reported status attributable — for a line whose status
  // is `tail`'s. `command-policy.ts` already owns this vocabulary and its `SHELL_WRAPPERS`
  // includes exactly those four words; reading its index keeps one list instead of a
  // second one here that would be right only until the first grows.
  const programIndex = commandProgramIndex(argv)
  const program = bareProgram(argv[programIndex] ?? '')
  const flagIndex = SHELL_PROGRAMS.has(program)
    ? argv.findIndex((part, position) => position > programIndex && SHELL_LINE_FLAGS.has(part.toLowerCase()))
    : -1
  if (flagIndex < 0) {
    return { attribuable: true, reason: `\`${program || '(no program)'}\` reports its own exit status` }
  }
  const inner = argv.slice(flagIndex + 1).join(' ')
  // A trailing `&` backgrounds the check, so the shell returns immediately with
  // 0. A trailing `&&` is a separator rather than a background, and shell would
  // reject the dangling operator anyway, so it must not read as one.
  const trimmed = inner.replace(/\s+$/u, '')
  if (!trimmed.endsWith('&&') && /(?:^|[^&])&$/u.test(trimmed)) {
    return { attribuable: false, reason: 'the line backgrounds the check, so the reported status is the shell\'s, not the check\'s' }
  }
  const segments = shellSegments(inner)
  const last = segments[segments.length - 1]
  if (last === undefined) return { attribuable: true, reason: 'the line is empty, so there is no status to attribute' }
  const lastProgram = bareProgram(last.split(/\s+/u)[0])
  // A trailing no-op is *not* re-refused here: `classifyVerificationCommand`
  // already answered `not-a-check` for it, and a caller reaches this function
  // only after that answer came back eligible. Saying it twice would give one
  // line two reasons and make the report harder to act on.
  //
  // Only a *single* pipe moves the status to the right-hand stage; `||` and `;`
  // already ended a segment list whose last entry is the one inspected above.
  if (!inner.includes('||') && /[^|]\|[^|]/u.test(inner) && STATUS_FILTERS.has(lastProgram)) {
    return { attribuable: false, reason: `the check is piped into \`${lastProgram}\`, so the reported status is the filter's` }
  }
  return { attribuable: true, reason: 'the last stage of the line is the check itself' }
}

/**
 * How far a command's coverage reaches the paths a change touched.
 *
 * Three answers, because two would have to lie. A command naming a changed path
 * is `targeted`. A whole gate is a *superset* of any one change, so it covers —
 * `suite` keeps that claim honest about being broad. Everything else is
 * `unrelated`, which is the answer that stops a check run somewhere else from
 * counting as evidence about this change.
 *
 * @param command - the argv the run recorded.
 * @param changedPaths - paths the work touched, as the caller knows them.
 * @returns the coverage reading.
 */
export function verificationCoversChange(command: readonly string[], changedPaths: readonly string[]): VerificationCoverage {
  if (changedPaths.length === 0) return 'suite'
  const classified = classifyVerificationCommand(command)
  if (!classified.verification) return 'unrelated'
  const tokenForms = command.map((part) => {
    const form = matchForm(part)
    return { form, bare: form.split('/').pop() ?? form }
  })
  for (const path of changedPaths) {
    const form = matchForm(path)
    const bare = form.split('/').pop() ?? form
    // A bare name with no extension is too short to identify anything, and
    // matching it would call any command mentioning `src` targeted.
    const identifiable = bare.length >= 3 && bare.includes('.')
    if (tokenForms.some(token => token.form.includes(form) || (identifiable && token.bare === bare))) return 'targeted'
  }
  // An inline script carries no path to match, but it was authored against the
  // change the caller is asking about, which is what the declaration means. The
  // question is whether the command *is* an inline evaluation — a fact about the
  // program and its own flags, already decided by the classifier above — and not
  // whether some token happens to be spelled `-p`. Read off the token alone, this
  // line called `tsc -p packages/app/tsconfig.json` (a project-wide type check),
  // `pytest -p no:cacheprovider` (a plugin selector) and `vitest run -c
  // vitest.config.ts` (a config path) all `targeted`, and a `targeted` reading keeps
  // the changed path out of `uncovered` — which is precisely how a fake green
  // arrives: a change verified only by `tsc -p …` claimed to cover every path it
  // touched.
  if (classified.inline === true) return 'targeted'
  // A gate with no path argument is the project's whole gate, which is a
  // superset of any one change rather than a claim about it.
  return 'suite'
}
