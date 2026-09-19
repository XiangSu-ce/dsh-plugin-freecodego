/**
 * Host-level tool-call guards: credential-file protection and doom-loop detection.
 *
 * Guards run on every host-dispatched execution (DeepSeek/AgentLoop, Claude
 * bridge tools, engineering subagents) after pre-execute policy and before the
 * tool body. They are monotonic denials: no listener ordering can re-allow a
 * denied call, and a denial cannot be converted back into an approval prompt.
 * Native Codex/Claude worker-internal tool executions do not cross this seam;
 * those engines keep their own sandbox and approval policies.
 */

import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { COMPILED_BUILT_IN_COMMAND_POLICY, commandPolicyDenial, commandProgramIndexes, type CompiledCommandPolicy } from './command-policy.ts'
import { pathArgumentsOf } from './sandbox/profiles.ts'
// Resolving a path is the same syscall for both guards that read one, so the
// resolver is shared rather than copied here: a second copy is how one tier ends up
// resolving through a missing tail and the other stops at the first `ENOENT`.
import { realpathThroughMissingTail } from './sandbox/realpath.ts'
import { planModeRefusal } from './plan-mode.ts'
import { stableJson } from './stable-json.ts'

/** Guard toggles persisted with the FreeCodeGo profile (defaults in the schema below). */
export const FreeCodeGoGuardSettingsSchema = z.object({
  // Fail-closed by default: the model has no legitimate need for secret
  // material, and a denial message tells it how to proceed instead.
  envReadGuardEnabled: z.boolean().default(true),
  // Stops the token-burning failure mode where a stuck engine repeats one
  // failing call until the user cancels the session.
  doomLoopGuardEnabled: z.boolean().default(true),
  // Probe-based LSP stack: on by default, mounts only when language-server
  // binaries resolve on PATH so boot never depends on tooling being present.
  lspEnabled: z.boolean().default(true),
  // Declarative command policy: rules live in `command-policy.ts` as data with
  // their own positive/negative examples, and only `forbidden` rules can deny
  // here — this guard is monotonic, so `prompt` is left to the approval layer.
  commandPolicyEnabled: z.boolean().default(true),
  // Plan Mode: while a session is in `plan`, file-mutating tools and any command
  // the policy does not clear are refused. The mode is per conversation, not per
  // tool call, so it is read from durable state rather than from arguments.
  planModeEnabled: z.boolean().default(true),
  // Model-visible context budget: the model is told how full its window is, at
  // band granularity, so it can choose a targeted read over a whole file. A
  // model that never learns the number cannot avoid the cost the number causes.
  contextBudgetEnabled: z.boolean().default(true),
  // Cache-cold clearing: when the prompt cache is provably expired, shrinking the
  // prompt costs nothing, because the whole prefix is about to be re-sent anyway.
  cacheColdClearEnabled: z.boolean().default(true),
  // Request-shape attribution: fingerprint the request before it is sent, so a
  // cache miss can name the tool whose description moved instead of only saying
  // "the prefix changed".
  cacheBreakAttributionEnabled: z.boolean().default(true),
  // Assistant-output repetition guard: the doom-loop guard above catches a tool
  // call repeated with identical arguments, which is a different failure from
  // the model looping inside its own prose. That one is only ever stopped by the
  // token budget today, so this watches `agent/assistant-stream` and answers with
  // a reminder first and a cancelled turn second.
  assistantLoopGuardEnabled: z.boolean().default(true),
  // Paged recall of a parked tool result. On by default: the artifact already
  // exists on disk, so this only changes how it is read back, and reading it with
  // no statement of what is left is the failure it removes.
  spillRecallEnabled: z.boolean().default(true),
  // Compaction-summary fidelity: a summary replaces the history it was written
  // from, in the same commit, so the only moment its quotations can be checked
  // against the record is before it lands. An unfaithful summary is logged, never
  // enforced — it is already appended by the time it can be read.
  compactionFidelityEnabled: z.boolean().default(true),
  // Prompt-composition reporting: the model can ask where its own context goes
  // rather than only how full it is. `context-budget.ts` answers "how much is
  // left"; without this the answer to "too much of *what*" is a guess, which is
  // what leaves the tool block and an over-long transcript indistinguishable.
  promptCompositionEnabled: z.boolean().default(true),
})

/**
 * The argument keys a path-taking tool can carry its target under.
 *
 * `locator` is here because `spill_recall` reads a file handed to it by a marker,
 * and a reader the credential shield does not look at is a reader that can be
 * used to read `.env` — the shape of the bypass this guard exists to close.
 */
type ToolArgsView = { readonly path?: unknown; readonly file_path?: unknown; readonly locator?: unknown; readonly command?: unknown }

/**
 * Credential material, by the file's own name.
 *
 * The framing question this list is written from is not "which well-known secret
 * files exist" but **"where does the ecosystem this guard belongs to keep its
 * secrets"** — and asking the first question is how the list ended up naming
 * `.aws/credentials`, `.kube/config`, `gh`, gcloud and Azure while missing the
 * host's own credential document, `$DSH_HOME/.credentials.yaml`. That file's
 * module header says it "holds nothing but credentials", and this plugin's own
 * secrets are in it: the Agnes account and apiKey, the account coordinator's
 * access/refresh tokens, the VYCE and Kling keys. The neighbours' safes were all
 * on the list; the one the plugin writes to was not.
 *
 * The suffix tolerance on `.credentials.yaml` is not cosmetic: the atomic write
 * lands `<name>.<uuid>.tmp` beside it and renames, so the temp file carries the
 * same bytes under a name one suffix away. The same negative lookahead the `.env`
 * branch carries applies here for the same reason — a committed
 * `.credentials.yaml.example` is a template a repository means to share, and a
 * guard whose hits stop meaning anything is a guard nobody reads.
 *
 * The entry is a *basename* rule that is not directory-scoped, unlike
 * {@link SECRET_FILE_IN_DIRECTORIES}: `credentials.yaml` is a name a project could
 * plausibly use for something else, which is why the undotted spelling is
 * deliberately absent, while `.credentials.yaml` is this ecosystem's own spelling.
 */
const SECRET_BASENAME = /^(?:\.env(?!\.(?:example|sample|template|dist)$)(?:\..+)?|\.credentials\.ya?ml(?!\.(?:example|sample|template|dist)$)(?:\..+)?|\.envrc|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.pub)?|.+_rsa|.+_ed25519|.+\.pem|.+\.pfx|.+\.p12|.+\.keystore|secrets?\.json|secrets?\.ya?ml|credentials\.json)$/

const SECRET_DIRECTORIES = new Set(['.ssh', '.gnupg'])

/**
 * Credential stores whose own directory is the only thing that names them.
 *
 * These filenames are ordinary — a `config`, a `config.json`, a `credentials` —
 * so the directory is what identifies the file, and it is matched per segment
 * like {@link SECRET_DIRECTORIES}. That is also why `.aws/config` stays readable
 * and only `.aws/credentials` is refused: the folder is not the secret, the store
 * inside it is.
 *
 * Why the list grew: it held one provider. Measured before these entries existed,
 * `~/.kube/config`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`,
 * `~/.config/gcloud/application_default_credentials.json` and
 * `~/.azure/msal_token_cache.json` were all readable, while `~/.aws/credentials`
 * was refused — one credential store known and its four neighbours open, which is
 * the same one-spelling defect the tool list above records. Each holds a token,
 * a client key or a registry password in cleartext, and each is the store of a
 * tool the sessions this guard protects routinely drive.
 */
const SECRET_FILE_IN_DIRECTORIES: readonly (readonly [string, readonly string[]])[] = [
  /** AWS CLI credentials; `.aws/config` holds no secret and stays readable. */
  ['credentials', ['.aws']],
  /** `kubectl`: client certificates, client keys and bearer tokens in one file. */
  ['config', ['.kube']],
  /** Docker registry auth (`auths`, `credsStore`). */
  ['config.json', ['.docker']],
  /** The GitHub CLI's OAuth token. */
  ['hosts.yml', ['.config', 'gh']],
  /** `gcloud`'s refresh-token stores. */
  ['application_default_credentials.json', ['.config', 'gcloud']],
  ['credentials.db', ['.config', 'gcloud']],
  ['access_tokens.db', ['.config', 'gcloud']],
  /** The Azure CLI's token caches. */
  ['msal_token_cache.json', ['.azure']],
  ['accessTokens.json', ['.azure']],
]

/**
 * Tools whose arguments carry the one filesystem path they act on.
 *
 * Curated rather than discovered, with the same doctrine Plan Mode states for
 * its own list: a name that does not exist is inert, while a missing name is a
 * hole. `read`/`write`/`edit` are the Harness registry's file tools; the rest
 * are the spellings this guard is *actually* pointed at — the Claude Agent SDK's
 * `MultiEdit` and `NotebookEdit` and a Codex file-change approval arrive as
 * `multi_edit`, `notebook_edit` and `apply_patch` through the native
 * projection — plus the path-taking editors another composition may register.
 *
 * The list was only `read`/`write`/`edit` at first, which made the shield inert
 * for every other writer: the projection deliberately re-keys an engine's
 * `file_path`/`notebook_path` into `path` so this guard can read it, and the
 * guard then never looked, because the tool name it was handed was not one of
 * the three.
 */
export const CREDENTIAL_PATH_TOOLS: ReadonlySet<string> = new Set([
  'read', 'write', 'edit',
  'multi_edit', 'notebook_edit', 'notebook_write',
  'str_replace', 'str_replace_editor', 'apply_patch',
  'create_file', 'delete_file', 'move_file', 'fs_read', 'fs_write', 'fs_edit',
  // A content search is a file read whose name does not say so: `grep` returns the
  // matching *lines* of every file it selects, so `grep({ path: '.env' })` printed
  // the file `read` refuses. Its filter is read as well — `PATH_FILTER_ARGUMENT_KEYS`
  // in `sandbox/profiles.ts` — because `{ path: '/work', include: '*.env' }` names
  // the same file without naming it in a path key.
  'grep',
  // A reader that takes its path from a marker rather than from the model. It is
  // listed here for the same reason `read` is: the shield has to cover every way
  // a path becomes a file read, not only the ones whose name says so.
  'spill_recall',
])

/** Basename of the last path segment, accepting both separators. */
function baseName(value: string): string {
  return credentialPathSegments(value).at(-1) ?? ''
}

/**
 * Normalize one path segment the way the platform's own path resolution does.
 *
 * Two Win32 behaviours make a lexical guard lie if they are ignored, and both
 * are ways to name a file the guard already blocks:
 *
 * 1. **Trailing dots and spaces are stripped by the Win32 layer**, so
 *    `id_rsa ` and `.env.` open the same file as `id_rsa` and `.env`. On POSIX
 *    they are distinct files, so this arms only when the path could be a
 *    Windows path; a POSIX path that genuinely ends in a space keeps its name.
 * 2. **NTFS alternate data streams** are named `file:stream`. Reading
 *    `notes.txt:secret` returns the stream's bytes, and the guard compares the
 *    basename, so the stream suffix would otherwise hide the real file. The
 *    adapter suffix is dropped, but a drive-letter colon (`C:\`) is not one.
 *
 * Quotation marks are removed wherever they sit, not only at the ends: a shell
 * concatenates the words around an empty quote, so `cat .e''nv` opens `.env`, and
 * this is the same file spelled so that a guard comparing names stops seeing it.
 * No filesystem this Host runs on treats a quote as part of a name it matters to
 * protect, so removing them can only turn a disguised credential name into a
 * denial — the direction a guard is allowed to be wrong in.
 *
 * @param segment - one `/`-separated piece of the raw path.
 * @param windows - whether this platform resolves the path with Win32's name rules.
 * @returns the segment as the filesystem would resolve it, lowercased.
 */
function normalizeSegment(segment: string, windows: boolean): string {
  let value = segment.replaceAll("'", '').replaceAll('"', '')
  if (windows) {
    const stream = value.indexOf(':', 1)
    if (stream !== -1) value = value.slice(0, stream)
    value = value.replace(/[. ]+$/u, '')
  }
  return value.toLowerCase()
}

/**
 * Split a path into normalized segments, dropping separators and `.` parts.
 *
 * Whether the Win32 rules above apply is decided by the **platform**, with the
 * path's own appearance as a second trigger, and that order is the fix for a
 * measured bypass: keying it off appearance alone turned the rules off for exactly
 * the spelling a model writes. `.env::$DATA` has neither a separator nor a drive
 * prefix, so it read as a POSIX path, the adapter suffix was kept, and the guard
 * compared `.env::$data` against a list that contains `.env` — while the filesystem
 * it runs on returns `.env`'s bytes for that name. Measured on win32:
 * `isCredentialPath('C:/work/.env::$DATA')` was true and `.env::$DATA` was false.
 *
 * The appearance test stays because it is still right about a *Windows* path on a
 * POSIX host: such a path can only be read by a Windows program, so normalizing it
 * costs nothing and keeps the answer the same everywhere. What it may not do is
 * *narrow* the platform's own rules, which is the direction that leaked.
 *
 * `sandbox/profiles.ts` owns the sibling judgment for user deny globs and arms it
 * the same way (`platform === 'win32'`); its `withoutWindowsStream` and
 * {@link normalizeSegment} are two implementations of one rule, and consolidating
 * them is a decision about scope, not a mechanical edit — that module cuts the
 * stream from the **last** segment only, this one from every segment. See Q-32.
 * @param rawPath - the path as written by the caller.
 * @param windows - whether Win32 resolves names on this platform, or the path looks Windows-written.
 * @returns the normalized segments.
 */
function credentialPathSegments(
  rawPath: string,
  windows = process.platform === 'win32' || /\\|^[A-Za-z]:/u.test(rawPath),
): readonly string[] {
  return rawPath
    .replaceAll('\\', '/')
    .split('/')
    .filter(segment => segment !== '' && segment !== '.')
    .map(segment => normalizeSegment(segment, windows))
}

/**
 * Whether a filesystem path points at env/credential/secret material.
 *
 * This is the **lexical** tier: it reads the path as written and never touches
 * the filesystem, so it costs nothing and cannot throw inside a tool guard. It
 * is deliberately blind to the two things only a syscall can see — a symlink
 * whose target is a credential file, and a Windows 8.3 short name — which the
 * async `credentialRealpathDenial` tier covers on the paths that exist.
 *
 * Directory matching is per segment, not substring: `.ssh-backup/id_rsa` is a
 * different directory from `.ssh`, and a guard that matched substrings would
 * block every project named after one of these.
 */
export function isCredentialPath(rawPath: string): boolean {
  const path = rawPath.trim()
  if (path === '') return false
  const segments = credentialPathSegments(path)
  const file = segments.at(-1) ?? ''
  if (SECRET_BASENAME.test(file)) return true
  // Every segment, not only the directory chain: `~/.ssh/` and `~/.ssh` name the
  // same directory, and a guard that read the leaf as a filename would deny the
  // first spelling and allow the second.
  if (segments.some(segment => SECRET_DIRECTORIES.has(segment))) return true
  // Stores whose filename is shared with ordinary files and whose directory is
  // therefore the only thing that names them (see {@link SECRET_FILE_IN_DIRECTORIES}).
  if (SECRET_FILE_IN_DIRECTORIES.some(([name, directories]) => file === name && directories.every(directory => segments.includes(directory)))) return true
  // On Linux the whole environment is also readable as a path. `/proc/self/environ`
  // is the same dump the `printenv` rule refuses — with the provider credentials
  // the Host itself holds in it — spelled as a file read.
  if (file === 'environ' && segments.includes('proc')) return true
  return false
}

/**
 * Symlink- and short-name-aware credential denial for path-taking tools.
 *
 * The lexical guard is fast and total, but it answers about the *name* the
 * model wrote. A symlink is the one construction that separates the name from
 * the file: `docs/notes.md -> .ssh/id_rsa` passes every lexical rule and still
 * returns the key. Resolving the path first closes that, and on Windows it also
 * catches an 8.3 short name that names a credential file.
 *
 * Fail-open is deliberate and matches the guard's own contract: a path that
 * cannot be resolved (permission denied, a dangling link, a race) leaves the
 * lexical decision standing rather than turning an I/O error into a denial the
 * model cannot act on. Only `read`/`write`/`edit` are resolved — `bash` runs
 * arbitrary programs, so there is no path to resolve before the command runs.
 *
 * @param toolName - the tool about to run.
 * @param args - its parsed arguments.
 * @returns the denial message, or `undefined` when the real path is safe.
 */
/**
 * Every path one call names, in the order the call states them.
 *
 * The shield asks `sandbox/profiles.ts` for this rather than keeping a key list of
 * its own, because two lists of path-bearing keys is how one guard ends up reading
 * a key the other does not. It did: this guard read the *first* non-null of
 * `path`/`file_path`/`locator`, so `{ path: 'src/a.ts', file_path: '.env' }` was
 * judged by the safe one, and `{ paths: ['.env'] }`, `{ target_file: '.env' }` and
 * `{ filename: '.env' }` were judged by nothing at all. The deny list read all
 * thirteen keys and refused those calls, which is what made the gap invisible in
 * production: the profile caught what the shield missed, and only until no profile
 * was configured.
 *
 * Plural on purpose, and for the reason that module states: a judgment that stopped
 * at the first path would pass a call whose second entry is the credential, and a
 * denial is the only thing either of these can do, so a partial reading is a bypass
 * rather than a strictness tradeoff.
 * @param args - the call's arguments, possibly a JSON string.
 * @returns one entry per named path; empty for a call that names none.
 */
function credentialPathsOf(args: unknown): readonly string[] {
  // Decoded first: the pipeline passes parsed JSON, but a stringy payload (the
  // session-event shape) must not bypass the guard by being unreadable.
  const decoded = decodeArgs(args)
  if (decoded === undefined) return []
  return pathArgumentsOf(decoded).map(entry => entry.value).filter(value => value.trim() !== '')
}

export async function credentialRealpathDenial(toolName: string, args: unknown): Promise<string | undefined> {
  if (!CREDENTIAL_PATH_TOOLS.has(toolName)) return undefined
  const paths = credentialPathsOf(args)
  if (paths.length === 0) return undefined
  // Already answered by the lexical tier; the syscall would only repeat it.
  for (const raw of paths) if (isCredentialPath(raw)) return FILE_DENIAL
  for (const raw of paths) {
    const resolved = await realpathThroughMissingTail(raw)
    if (resolved !== undefined && isCredentialPath(resolved)) return REALPATH_DENIAL
  }
  return undefined
}

const ENV_DUMP_COMMANDS = new Set(['env', 'printenv', 'setenv'])

/**
 * PowerShell spellings of the same whole-environment dump.
 *
 * `ENV_DUMP_COMMANDS` matches a *program*, and PowerShell has none named `env`:
 * it reads the environment through the `Env:` provider, so the program is
 * `Get-ChildItem`/`gci`/`ls` and the thing being dumped is an argument. It
 * belongs on this list rather than beside it because `bashCommandOf` accepts
 * `pwsh`, which puts `pwsh -c "Get-ChildItem Env:"` on the exact path
 * `printenv` already takes.
 */
const POWERSHELL_ENV_DUMP = /^(?:env:?\\?|\[environment\]::getenvironmentvariables\(\))$/iu

/**
 * Every program a shell command actually runs, for whole-environment dump checks.
 *
 * `FOO=bar printenv`, `command printenv`, `time printenv` and `"printenv"` all
 * run `printenv`, but reading only the first whitespace token missed every one of
 * them, so the guard was bypassable by a one-word prefix — and by `-exec`, which
 * puts the program in an argument instead of in front of it.
 *
 * The program positions are the command policy's `commandProgramIndexes` rather
 * than a second launcher list here. The two guards were listing the same
 * launchers, and the copy that never learned `time` — or `timeout 5`, or the
 * argument position — was the one standing in front of the model's context. A
 * bare `env` stays the program, because the shared skip never consumes the last
 * token (that is a dump on its own).
 *
 * Quotes are stripped and empty tokens dropped first, because this caller splits
 * on whitespace and shell separators rather than tokenizing a shell line.
 */
function effectivePrograms(tokens: readonly string[]): readonly string[] {
  const candidates = tokens
    .map(token => token.replace(/^['"]|['"]$/g, ''))
    .filter(token => token !== '')
  const programs: string[] = []
  for (const index of commandProgramIndexes(candidates)) {
    const token = candidates[index]
    if (token === undefined) continue
    const program = baseName(token)
    if (!programs.includes(program)) programs.push(program)
  }
  return programs
}

const BASH_DENIAL = 'Blocked by the FreeCodeGo credential guard: this command would expose environment or credential material. Ask the user for the needed value instead of reading it (envReadGuardEnabled in FreeCodeGo settings controls this guard).'
const FILE_DENIAL = 'Blocked by the FreeCodeGo credential guard: this path looks like a credential or secret file. Ask the user for the needed value instead of reading it (envReadGuardEnabled in FreeCodeGo settings controls this guard).'
const REALPATH_DENIAL = 'Blocked by the FreeCodeGo credential guard: this path resolves through a symlink or an alternate name to a credential or secret file. Ask the user for the needed value instead of reading it (envReadGuardEnabled in FreeCodeGo settings controls this guard).'

/** Defensive argument decode: the pipeline passes parsed JSON, but a stringy
 * payload (session-event shape) must not silently bypass the guard. */
function decodeArgs(args: unknown): ToolArgsView | undefined {
  if (typeof args === 'string') {
    try { return JSON.parse(args) as ToolArgsView } catch { return undefined }
  }
  if (typeof args === 'object' && args !== null) return args
  return undefined
}

/**
 * Static credential-read denial for the path-taking and shell tools. Command
 * scanning is intentionally conservative (reader-token + secret-path pairs and
 * whole-environment dumps); anything dynamic (`node -e`, curl to arbitrary
 * hosts) remains the approval/sandbox layer's job.
 */
export function credentialReadDenial(toolName: string, args: unknown): string | undefined {
  if (CREDENTIAL_PATH_TOOLS.has(toolName)) {
    // Every key, not the first: see {@link credentialPathsOf}.
    for (const raw of credentialPathsOf(args)) if (isCredentialPath(raw)) return FILE_DENIAL
    return undefined
  }
  // The command a shell tool would run, read through the shared vocabulary rather
  // than by testing for `'bash'` here. That inline test was a second copy of a
  // tool-name list, and it had drifted one tool behind the policy tier's copy.
  const command = bashCommandOf(toolName, args)
  if (command === undefined) return undefined
  return bashCredentialDenial(command)
}

/**
 * Whether one word, as the shell would hand it to a program, names credential
 * material.
 *
 * Three readings of the same word, because each is a spelling of a file the
 * guard already refuses: the word as written (`.env`), the word PowerShell's
 * environment provider dumps (`Env:\`), and the word after the single backslash
 * removal a POSIX shell performs — `.en\v` reaches the program as `.env`, the
 * same file spelled so that neither the path tools nor the command scan
 * recognize it.
 */
function wordNamesCredentials(token: string): boolean {
  if (token === '' || token.startsWith('-')) return false
  if (POWERSHELL_ENV_DUMP.test(token)) return true
  if (isCredentialPath(token)) return true
  return isCredentialPath(token.replace(/\\(.)/g, '$1'))
}

/**
 * `NAME=value` and `--flag=value`: every spelling that puts a value behind an
 * `=`. A shell calls the bare-name form an assignment and the dashed form a
 * flag, but both put the same bytes in the same argument — `dd if=.env` and
 * `dd --input=.env` have to reach the same answer, and only the dashed one did.
 */
const EQUALS_VALUE = /^(?:[A-Za-z_][A-Za-z0-9_]*|--?[A-Za-z][A-Za-z0-9-]*)=(.+)$/su

/**
 * Command substitution: the one expansion whose text is itself a command.
 * `cat "$(echo .env)"` names the credential file through a program the outer
 * scan never sees, because the shell runs the substitution and splices its
 * output into the word before the outer program is invoked.
 *
 * Nested substitutes (`$(a $(b))`) are deliberately not matched: the pattern
 * reads the innermost-free text, and a second copy of a shell parser is not what
 * this guard should become. See {@link MAX_SUBSTITUTION_DEPTH}.
 */
const COMMAND_SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/gsu

/**
 * How many substitution levels the guard follows before it stops trusting its
 * own reading. No real command nests deeper, and a guard that recurses inside a
 * tool call is worse than one that misses.
 */
const MAX_SUBSTITUTION_DEPTH = 2

/** The text of every command substitution in one command line, outermost first. */
function commandSubstitutions(command: string): readonly string[] {
  const inner: string[] = []
  for (const match of command.matchAll(COMMAND_SUBSTITUTION)) {
    const text = match[1] ?? match[2] ?? ''
    if (text.trim() !== '') inner.push(text)
  }
  return inner
}

/**
 * The extra words a shell would build from a command the guard only reads as
 * written.
 *
 * The scanner splits on whitespace and shell separators, so every expansion that
 * happens *after* that split is invisible to it — and each one is a spelling of
 * a credential file the guard already refuses when written literally. Measured
 * on the version before this pass existed, all four of these returned
 * `undefined` through `credentialReadDenial`:
 *
 * - `cat .env*` — a glob, so the word never equals `.env`. The literal part of
 *   the pattern is the part that is known, and it is enough: whether the pattern
 *   matches one file or ten, `.env`'s bytes are among whatever the program
 *   receives. Metacharacters are also read as if deleted (`.en?v` → `.env`),
 *   which covers the same evasion written inside the name.
 * - `F=.env; cat $F` — an assignment is a word like any other, and the variable
 *   is a second name for the value it was given earlier in the same command.
 * - `cat "$(echo .env)"` — the substitution is scanned as a command of its own.
 * - `dd if=.env` — the value sits behind `=` in an argument position, which is
 *   not a position a shell would call an assignment.
 *
 * Brace expansion is read too (`.env` in `{.env,other}`), because it is the
 * same question spelled with a different character.
 *
 * Variables the command never assigns are **deliberately not resolved**:
 * `cat $SOMETHING` where `SOMETHING` comes from the environment cannot be known
 * here, and denying every `$`-word would refuse `cd $HOME`. A false denial costs
 * a working feature, so an unknowable spelling is left to the approval layer
 * rather than guessed at — the same boundary the module header states for
 * `node -e` and `curl`.
 *
 * @param tokens - the whitespace/separator split of the command line.
 * @returns words to test with {@link wordNamesCredentials}, in no order.
 */
function expansionSpellings(tokens: readonly string[]): readonly string[] {
  const spellings: string[] = []
  const variables = new Map<string, string>()
  const substitute = (word: string): string =>
    word.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu, (whole, name: string) => variables.get(name) ?? whole)
  for (const token of tokens) {
    if (token === '') continue
    const equals = EQUALS_VALUE.exec(token)
    if (equals !== null) {
      const value = equals[1] ?? ''
      spellings.push(value)
      const name = token.slice(0, token.indexOf('='))
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) variables.set(name, value)
      continue
    }
    const literal = token.replace(/[*?[\]{}]/gu, '')
    if (literal !== token && literal !== '') spellings.push(literal)
    const meta = token.search(/[*?[{]/u)
    if (meta > 0) spellings.push(token.slice(0, meta))
    if (token.includes('{') && token.endsWith('}')) {
      const open = token.indexOf('{')
      for (const part of token.slice(open + 1, -1).split(',')) {
        if (part !== '') spellings.push(token.slice(0, open) + part)
      }
    }
    if (!token.includes('$')) continue
    const resolved = substitute(token)
    if (resolved !== token) spellings.push(resolved)
  }
  return spellings
}

/**
 * Scan one shell command for whole-env dumps and secret-file access.
 *
 * `depth` counts command substitutions already followed, and is not part of the
 * guard's contract: callers pass nothing. It exists so the recursive read of
 * `$(…)` cannot walk forever inside a tool call.
 */
function scanShellCommand(command: string, depth: number): string | undefined {
  const trimmed = command.trim()
  if (trimmed === '') return undefined
  const tokens = trimmed.split(/[\s;|&<>]+/)
  const programs = effectivePrograms(tokens)
  if (programs.some(program => ENV_DUMP_COMMANDS.has(program))) return BASH_DENIAL
  for (const raw of tokens) {
    const token = raw.replace(/^--?[A-Za-z-]+=*/, '').replace(/^['"]|['"]$/g, '')
    if (wordNamesCredentials(token)) return BASH_DENIAL
  }
  for (const spelling of expansionSpellings(tokens)) {
    if (wordNamesCredentials(spelling.replace(/^['"]|['"]$/g, ''))) return BASH_DENIAL
  }
  if (depth >= MAX_SUBSTITUTION_DEPTH) return undefined
  for (const inner of commandSubstitutions(trimmed)) {
    if (scanShellCommand(inner, depth + 1) !== undefined) return BASH_DENIAL
  }
  return undefined
}

/** Scan one shell command for whole-env dumps and secret-file access. */
export function bashCredentialDenial(command: string): string | undefined {
  return scanShellCommand(command, 0)
}

/**
 * Identical-call fingerprints use the shared deterministic encoder.
 *
 * The cycle-tolerant arm deliberately: this runs inside a tool-execution hook,
 * where a throw would break the call instead of denying it. Arguments arrive as
 * `JSON.parse` output, so a cycle cannot occur in practice — tolerating one is
 * the difference between a fingerprint and a failed tool call, not between two
 * fingerprints.
 */
const stableStringify = stableJson

/**
 * Argument keys whose value names a filesystem location.
 *
 * A whitelist rather than a shape test, because "contains a slash" is not a path:
 * a URL, a shell command, a regex and a code snippet all do. Normalizing one of
 * those would merge two calls that do different things, which is the one
 * direction a repetition guard may not be wrong in.
 */
const PATH_ARG_KEYS: ReadonlySet<string> = new Set([
  'path', 'file_path', 'filePath', 'notebook_path', 'notebookPath',
  'cwd', 'dir', 'directory', 'root', 'target', 'file', 'paths', 'files',
])

/**
 * Rewrite one path so two spellings of the same location collide.
 *
 * Only rewrites that hold on every platform this Host runs on are applied: `./x`
 * and `x` name the same entry everywhere, as do `x//y` and `x/y`, and a trailing
 * separator names the same entry as none. Backslashes are deliberately NOT
 * unified with slashes — on POSIX a backslash is an ordinary filename character,
 * so `a\b` and `a/b` are two different files, and merging them would deny a call
 * that touches something else entirely.
 *
 * @param value - a path-valued argument, already trimmed.
 * @returns the normalized spelling.
 */
function normalizePathValue(value: string): string {
  // A URL is not a path, and collapsing its `//` would corrupt it.
  if (value.includes('://')) return value
  const segments = value.replaceAll('//', '/').split('/')
  const kept = segments.filter(segment => segment !== '' && segment !== '.')
  if (kept.length === 0) return value
  const prefix = value.startsWith('/') ? '/' : ''
  const trailing = value.endsWith('/') && kept.length > 1 ? '/' : ''
  return `${prefix}${kept.join('/')}${trailing}`
}

/**
 * Strip the spellings that cannot change which call is being made.
 *
 * This is the near-duplicate axis. It exists because an exact fingerprint is
 * too narrow in the case that matters most: a stuck model retrying with
 * `./src/a.ts` after `src/a.ts`, or with a trailing space on a command, is in
 * the same loop, and against an exact hash it is invisible forever.
 *
 * Every rule is conservative in the same direction — it only merges values that
 * provably denote the same thing:
 *
 * - **Trim.** Leading and trailing whitespace is never significant, in a path
 *   or in a shell command.
 * - **Path spelling.** `./x`, `x//y` and `x/` are `x` and `x/y` on every
 *   platform. Applied only under a path-named key.
 * - **Nothing else.** Internal whitespace is left alone (a shell command's
 *   whitespace can be inside a quoted string), separators are not unified, and
 *   case is not folded (case matters on POSIX).
 *
 * @param value - one argument value.
 * @param key - the key it sits under, which decides whether it is a path.
 * @param seen - cycle guard for object graphs a caller could not produce but a
 *   session event could still carry.
 * @returns a value that stringifies identically for equivalent calls.
 */
export function normalizeCallArguments(value: unknown, key?: string, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return key !== undefined && PATH_ARG_KEYS.has(key) ? normalizePathValue(trimmed) : trimmed
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    return value.map(entry => normalizeCallArguments(entry, key, seen))
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return value
    seen.add(value)
    const normalized: Record<string, unknown> = {}
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      normalized[entryKey] = normalizeCallArguments(entryValue, entryKey, seen)
    }
    return normalized
  }
  return value
}

export interface DoomLoopOptions {
  /** Identical calls within the window before a denial (default 3). */
  readonly threshold?: number
  /**
   * Near-identical calls within the window before a denial (default 6).
   *
   * Deliberately double the exact threshold: a near match is a weaker claim, so
   * it needs more evidence — and a model that varies only the spelling of a path
   * is still repeating, which makes it worth catching at all.
   */
  readonly nearDuplicateThreshold?: number
  /**
   * Near-identical calls across a whole agent lineage before a denial
   * (default 8).
   *
   * Only consulted when {@link chainKey} is supplied. The bar is the highest of
   * the three because the population is the largest: a parent that fans out to
   * three subagents, each reading the same file once, is three identical calls
   * and legitimate work, while eight is a tree-wide loop.
   */
  readonly shareThreshold?: number
  /** Sliding window for repetition counting (default 10 minutes). */
  readonly windowMs?: number
  /** How long a triggered denial persists (default 2 minutes). */
  readonly cooldownMs?: number
  /** Tools whose identical repetition is legitimate (job polling, waits). */
  readonly exemptTools?: readonly string[]
  /** Cumulative characters of identical-call arguments tolerated before the
   * denial message escalates to a cost warning (default 200_000). */
  readonly costBudgetChars?: number
  /** Injectable clock for tests. */
  readonly now?: () => number
  /**
   * Maps a call to the lineage whose shared chain it belongs to.
   *
   * Omitted by default, which keeps the guard exactly per-agent. A composition
   * that supplies one gets a second, coarser chain keyed on what this returns:
   * a parent and its subagents then share one counter, so `bash npm test` three
   * times in the parent and twice in a child is five calls on one chain instead
   * of a loop neither chain can see. It is opt-in because the shared population
   * is larger and a false denial there would refuse work that is legitimate.
   */
  readonly chainKey?: (exec: Readonly<ToolExecution>) => string
}

const DEFAULT_THRESHOLD = 3
const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 6
const DEFAULT_SHARE_THRESHOLD = 8
const DEFAULT_WINDOW_MS = 10 * 60_000
const DEFAULT_COOLDOWN_MS = 2 * 60_000
const DEFAULT_EXEMPT_TOOLS = ['job_output', 'job_status', 'task_output', 'wait', 'sleep']
/** ~50k tokens of duplicated argument payload before the message escalates. */
const DEFAULT_COST_BUDGET_CHARS = 200_000
const MAX_TRACKED_AGENTS = 128
const MAX_FINGERPRINTS_PER_AGENT = 64
/**
 * Bound on the cumulative-cost map.
 *
 * The map is keyed by the same fingerprint as `calls`, but it must outlive the
 * per-agent fingerprint cap (a denial deletes its fingerprint, while the cost
 * warning still refers back to what that pattern already spent), so it cannot
 * be trimmed with it. Memory would otherwise grow with every distinct
 * `(agent, tool, arguments)` ever seen for the life of the Host. Once the cap is
 * reached the least-recently-inserted entry is dropped, which keeps the recent
 * working set exact and degrades old, untouched fingerprints to a fresh count.
 */
const MAX_COST_ENTRIES = 4_096

/**
 * One repetition chain a call is counted on; see `chainsFor`.
 *
 * `owner` is which counter map the chain's timestamps live in. It is the agent
 * for the two per-agent axes and the lineage for the shared one — a shared chain
 * must not be stored per agent, or five calls from five subagents would be five
 * separate counters of one each and the tree-wide loop would stay invisible,
 * which is the whole reason the axis exists.
 */
interface DoomLoopChain {
  readonly key: string
  readonly owner: string
  readonly threshold: number
  readonly axis: 'identical' | 'near-identical' | 'lineage'
}

/**
 * Denies the Nth identical `(agent, tool, arguments)` call inside a sliding
 * window and holds the denial for a cooldown, so a stuck engine stops burning
 * tokens on a doomed retry loop while staying usable for different work.
 *
 * A cumulative cost accumulator per fingerprint escalates the denial message
 * once repeated identical calls have wasted enough context/latency, and a
 * denial counter makes guard activity observable instead of silent.
 */
export class DoomLoopGuard {
  private readonly threshold: number
  private readonly nearDuplicateThreshold: number
  private readonly shareThreshold: number
  private readonly windowMs: number
  private readonly cooldownMs: number
  private readonly exemptTools: ReadonlySet<string>
  private readonly costBudgetChars: number
  private readonly now: () => number
  private readonly chainKey: ((exec: Readonly<ToolExecution>) => string) | undefined
  /** chain key → fingerprint → call timestamps inside the window. */
  private readonly calls = new Map<string, Map<string, number[]>>()
  /** fingerprint key → epoch ms until which the denial holds. */
  private readonly deniedUntil = new Map<string, number>()
  /** fingerprint key → cumulative argument bytes seen across denials+calls. */
  private readonly costChars = new Map<string, number>()
  /** Total denials issued since construction (observable guard activity). */
  private denials = 0

  constructor(options: DoomLoopOptions = {}) {
    this.threshold = Math.max(2, options.threshold ?? DEFAULT_THRESHOLD)
    // Both coarser tiers must be at least as patient as the exact one, or a
    // settings change could make a near-duplicate denial fire before the exact
    // repetition it is derived from ever did.
    this.nearDuplicateThreshold = Math.max(this.threshold, options.nearDuplicateThreshold ?? DEFAULT_NEAR_DUPLICATE_THRESHOLD)
    this.shareThreshold = Math.max(this.nearDuplicateThreshold, options.shareThreshold ?? DEFAULT_SHARE_THRESHOLD)
    this.windowMs = Math.max(1_000, options.windowMs ?? DEFAULT_WINDOW_MS)
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_COOLDOWN_MS)
    this.exemptTools = new Set(options.exemptTools ?? DEFAULT_EXEMPT_TOOLS)
    this.costBudgetChars = Math.max(1_000, options.costBudgetChars ?? DEFAULT_COST_BUDGET_CHARS)
    this.now = options.now ?? (() => Date.now())
    this.chainKey = options.chainKey
  }

  /**
   * The repetition chains one call is counted on.
   *
   * Three axes, coarsest last, and each is a strictly weaker claim than the one
   * before it, which is why each carries a strictly higher threshold:
   *
   * 1. **identical** — the same tool with byte-identical arguments, on this
   *    agent. The only axis that can name a call as *the same call*.
   * 2. **near-identical** — the same thing modulo argument spellings that cannot
   *    change which call it is ({@link normalizeCallArguments}).
   * 3. **lineage** — the near-identical axis widened to every agent sharing the
   *    caller's lineage key, which is how a loop distributed over a parent and
   *    its subagents becomes visible at all.
   *
   * The cost counter is keyed on the **coarsest** chain this call has, which is
   * the lineage chain when one is configured and the near-identical chain
   * otherwise. Both are coarser than the exact spelling on purpose: a payload
   * counted per exact spelling would under-report exactly the loops this guard
   * is for. The consequence worth knowing is that with a lineage key the bucket
   * is shared across an agent and its subagents, so the escalation budget is a
   * lineage budget; that is the axis the loop actually wastes tokens on.
   */
  private chainsFor(exec: Readonly<ToolExecution>): readonly DoomLoopChain[] {
    const agentKey = String(exec.agent?.id ?? '*')
    const name = exec.name
    const exact = createHash('sha256').update(stableStringify(exec.arguments)).digest('hex')
    const near = createHash('sha256').update(stableStringify(normalizeCallArguments(exec.arguments))).digest('hex')
    const chains: DoomLoopChain[] = [{
      key: `${agentKey}\u0000${name}\u0000identical\u0000${exact}`,
      owner: agentKey,
      threshold: this.threshold,
      axis: 'identical',
    }]
    // The near chain is recorded for every call, including one whose arguments
    // normalized to themselves. It has to be: the near chain is the *sum* of the
    // spellings, and a canonical `src/a.ts` that skipped it would leave a model
    // alternating `./src/a.ts` / `src/a.ts` one call short of the bar forever.
    // Counting both axes cannot fire early, because the constructor keeps the
    // near threshold at or above the exact one — the exact axis fires first on a
    // genuine repeat, which is also why it is checked first.
    chains.push({ key: `${agentKey}\u0000${name}\u0000near\u0000${near}`, owner: agentKey, threshold: this.nearDuplicateThreshold, axis: 'near-identical' })
    const lineage = this.chainKey?.(exec)
    if (lineage !== undefined && lineage !== agentKey) {
      chains.push({ key: `${lineage}\u0000${name}\u0000lineage\u0000${near}`, owner: lineage, threshold: this.shareThreshold, axis: 'lineage' })
    }
    return chains
  }

  /** Denials issued since construction (or the last clear()); surfaced with stats. */
  get denialCount(): number {
    return this.denials
  }

  /** Cumulative argument bytes observed across every tracked identical call. */
  get wastedChars(): number {
    let total = 0
    for (const value of this.costChars.values()) total += value
    return total
  }

  deny(exec: Readonly<ToolExecution>): string | undefined {
    if (this.exemptTools.has(exec.name)) return undefined
    const chains = this.chainsFor(exec)
    const now = this.now()
    // Cost accumulation, on one key per call: identical retries keep paying the
    // same context and latency twice, and once the cumulative argument bytes
    // cross the budget the denial escalates from "change the arguments" to a
    // cost warning. Counted once, on the coarsest chain, so a call that is both
    // an exact and a near-duplicate repeat is not billed twice.
    // `chainsFor` always returns at least the identical chain, so the coarsest
    // one exists; the fallback keeps this total without an assertion.
    const costKey = chains.at(-1)?.key ?? `${exec.name}\u0000unkeyed`
    // An active denial on any axis holds the call, and it is reported on the
    // axis that produced it: a near-duplicate loop must not be described as an
    // identical one, or the model looks for a repetition it did not make.
    for (const chain of chains) {
      const blockedUntil = this.deniedUntil.get(chain.key)
      if (blockedUntil === undefined) continue
      if (now < blockedUntil) {
        this.denials += 1
        return this.reason(exec, chain, costKey)
      }
      this.deniedUntil.delete(chain.key)
    }
    this.evictIfNeeded(chains)
    const spent = (this.costChars.get(costKey) ?? 0) + stableStringify(exec.arguments).length
    this.evictCostChars(costKey)
    this.costChars.set(costKey, spent)
    for (const chain of chains) {
      const fingerprints = this.calls.get(chain.owner) ?? new Map<string, number[]>()
      if (!this.calls.has(chain.owner)) this.calls.set(chain.owner, fingerprints)
      const stamps = fingerprints.get(chain.key) ?? []
      if (!fingerprints.has(chain.key)) fingerprints.set(chain.key, stamps)
      while (stamps.length > 0 && stamps[0]! <= now - this.windowMs) stamps.shift()
      stamps.push(now)
      if (stamps.length < chain.threshold) continue
      fingerprints.delete(chain.key)
      if (fingerprints.size === 0) this.calls.delete(chain.owner)
      this.deniedUntil.set(chain.key, now + this.cooldownMs)
      this.denials += 1
      return this.reason(exec, chain, costKey)
    }
    return undefined
  }

  /** Drop all state (used on plugin dispose and by tests). */
  /**
   * Forget every call this guard has tracked.
   *
   * The three fields are cleared together because they are three readings of one
   * window: `calls` is what has been seen, `deniedUntil` is what that cost, and
   * `costChars` is the context spent on it. `denials` is the counter over that same
   * window, and leaving it behind made {@link denialCount} report denials from
   * before a reset that had intentionally forgotten everything — a stat whose
   * stated lifetime ("since construction, or the last clear()") and whose value
   * disagreed, with nothing able to tell which one a reader should trust.
   */
  clear(): void {
    this.calls.clear()
    this.deniedUntil.clear()
    this.costChars.clear()
    this.denials = 0
  }

  private reason(exec: Readonly<ToolExecution>, chain: DoomLoopChain, costKey: string): string {
    const minutes = Math.round(this.windowMs / 60_000)
    const cost = this.costChars.get(costKey) ?? 0
    const costNote = cost > this.costBudgetChars
      ? ` This pattern has already consumed ~${Math.round(cost / 1_000)}k characters of context on repeated retries; fix the root cause before calling "${exec.name}" again.`
      : ''
    const what = chain.axis === 'identical'
      ? `${this.threshold} times with identical arguments`
      : chain.axis === 'near-identical'
        ? `${chain.threshold} times with arguments that differ only in path spelling or surrounding whitespace`
        : `${chain.threshold} times across this session and its subagents, with arguments that differ only in path spelling or surrounding whitespace`
    return `Doom loop detected: "${exec.name}" was called ${what} within ${minutes} minutes. Change the arguments, fix the underlying error, or ask the user before retrying.${costNote}`
  }

  /**
   * Keep the cost map bounded without unsetting the fingerprint being priced.
   *
   * `Map` preserves insertion order, so the first key is the oldest entry; the
   * key about to be written is never the one dropped. An already-present key is
   * only rewritten, so its slot count is unchanged.
   */
  private evictCostChars(incomingKey: string): void {
    if (this.costChars.has(incomingKey)) return
    while (this.costChars.size >= MAX_COST_ENTRIES) {
      const oldest = this.costChars.keys().next().value
      if (oldest === undefined || oldest === incomingKey) break
      this.costChars.delete(oldest)
    }
  }

  /**
   * Bound memory: drop expired denials and the oldest owner/fingerprint slots.
   *
   * The owners this call is about to write are never the ones dropped, so a
   * bounded map stays exact for the working set and degrades only the untouched
   * tail — the same contract the cost map keeps.
   */
  private evictIfNeeded(chains: readonly DoomLoopChain[]): void {
    const now = this.now()
    for (const [key, until] of this.deniedUntil) {
      if (now >= until) this.deniedUntil.delete(key)
    }
    const owners = new Set(chains.map(chain => chain.owner))
    for (;;) {
      if (this.calls.size <= MAX_TRACKED_AGENTS) break
      const oldest = this.calls.keys().next().value
      if (oldest === undefined || owners.has(oldest)) break
      this.calls.delete(oldest)
    }
    for (const owner of owners) {
      const fingerprints = this.calls.get(owner)
      if (fingerprints === undefined) continue
      while (fingerprints.size > MAX_FINGERPRINTS_PER_AGENT) {
        const oldest = fingerprints.keys().next().value
        if (oldest === undefined) break
        fingerprints.delete(oldest)
      }
    }
  }
}

/** Plan Mode as the guard needs it: a synchronous read plus the refusal rule. */
export interface PlanModeGuardView {
  /** Current mode for the conversation this call belongs to, when it is known. */
  readonly modeFor: (agent: unknown) => 'execute' | 'plan' | undefined
  readonly policy: CompiledCommandPolicy
}

/**
 * Combined guard for the plugin: settings-gated credential, command-policy,
 * Plan Mode, and doom-loop checks.
 *
 * Order matters and is deliberate: credential protection and the command policy
 * are *monotonic* denials, so they are asked before the doom-loop heuristic — a
 * call refused for a policy reason must never be reported as a loop, and Plan
 * Mode must be able to refuse a call that would otherwise pass every other
 * check.
 */
export function freeCodeGoToolGuard(deps: {
  readonly settings: () => {
    readonly envReadGuardEnabled?: boolean
    readonly doomLoopGuardEnabled?: boolean
    readonly commandPolicyEnabled?: boolean
    readonly planModeEnabled?: boolean
  } | undefined
  readonly doomLoop: DoomLoopGuard
  /** Compiled command policy; the built-in rules when omitted. */
  readonly policy?: CompiledCommandPolicy
  /**
   * The repository's own command policy for one call, when the checkout it
   * belongs to declared `permissionRules`.
   *
   * A resolver rather than a value because the answer is per-agent — the guard is
   * installed once for the whole Host, while `permissionRules` is a property of
   * the repository a session opened — and because it must stay synchronous: the
   * root keeps a compiled policy per workspace, read and compiled off the guard
   * path, and this only looks one up.
   *
   * Evaluated *in addition to*, never instead of, the built-in policy: a project
   * rule may add a denial, and the shape of this seam is what makes it
   * impossible for one to remove one. See `project-tier.ts`.
   */
  readonly projectPolicy?: (agent: unknown) => CompiledCommandPolicy | undefined
  /** Plan Mode view; when absent, Plan Mode is not enforced. */
  readonly planMode?: PlanModeGuardView
}): (exec: Readonly<ToolExecution>) => string | undefined {
  return (exec) => {
    const settings = deps.settings()
    if (settings?.envReadGuardEnabled !== false) {
      const denial = credentialReadDenial(exec.name, exec.arguments)
      if (denial !== undefined) return denial
    }
    if (settings?.commandPolicyEnabled !== false) {
      const command = bashCommandOf(exec.name, exec.arguments)
      if (command !== undefined) {
        const policy = deps.policy ?? COMPILED_BUILT_IN_COMMAND_POLICY
        const denial = commandPolicyDenial(policy, command)
          ?? projectCommandPolicyDenial(deps.projectPolicy?.(exec.agent), command)
        if (denial !== undefined) return denial
      }
    }
    if (settings?.planModeEnabled !== false && deps.planMode !== undefined) {
      const mode = deps.planMode.modeFor(exec.agent)
      if (mode === 'plan') {
        const refusal = planModeRefusal({ mode, tool: exec.name, args: exec.arguments, policy: deps.planMode.policy })
        if (refusal !== undefined) return refusal.message
      }
    }
    if (settings?.doomLoopGuardEnabled !== false) return deps.doomLoop.deny(exec)
    return undefined
  }
}

/**
 * The shell command one call would run, for a tool that runs shell commands.
 *
 * Exported because every guard with a shell tier reads it from here: the command
 * policy in this pipeline, the native engine's guard, and the credential shield.
 * A second copy of the tool-name list is how one of them silently stops enforcing
 * it — the engine guard carried its own `'bash' | 'shell' | 'exec_command'` inline,
 * and the credential shield carried `'bash'` alone, so the same `cat .env` was
 * refused under one name and screened by nothing at all under `shell` (Codex's
 * spelling of a command approval) or `pwsh` (the shell a Windows composition
 * ships). The decode belongs here for the same reason: a stringy payload must not
 * bypass the policy in one guard but not the other.
 *
 * `pwsh` counts as a shell here even though the built-in policy's patterns are
 * written in POSIX vocabulary. The shield's judgment is about the *tokens* a
 * command names — the same file names in either shell — and a policy rule that
 * does not match PowerShell text simply does not fire, never the reverse: a
 * broader vocabulary can only add a refusal.
 */
export function bashCommandOf(toolName: string, args: unknown): string | undefined {
  if (toolName !== 'bash' && toolName !== 'shell' && toolName !== 'exec_command' && toolName !== 'pwsh') return undefined
  const view = decodeArgs(args)
  return typeof view?.command === 'string' ? view.command : undefined
}

/**
 * The denial a repository's own command policy produces for one command.
 *
 * Split out and shared because the Harness pipeline and the native-engine guard
 * both consult a project policy, and the two asking it with different code is how
 * one transport ends up enforcing a repository's rules and the other not — the
 * exact drift `bashCommandOf` was centralized to prevent.
 *
 * @param policy - the compiled project policy, when the workspace declared one.
 * @param command - the shell command line the call would run.
 * @returns the refusal to show the model, or `undefined`.
 */
export function projectCommandPolicyDenial(policy: CompiledCommandPolicy | undefined, command: string): string | undefined {
  return policy === undefined ? undefined : commandPolicyDenial(policy, command)
}
