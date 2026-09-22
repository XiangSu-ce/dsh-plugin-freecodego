/**
 * Target selection: deciding *what* gets reviewed, and accounting for what does
 * not.
 *
 * Why selection is a stage and not a `git diff | head`
 * ---------------------------------------------------
 * A review is only as honest as its denominator. Three decisions have to be made
 * before a single model call, and each of them is a place where a review can
 * silently become smaller than the change it claims to cover:
 *
 * 1. **Which refs.** A workspace review means staged *and* unstaged *and*
 *    untracked changes — the untracked half is the part a naive `git diff` never
 *    shows, and it is exactly where a new file's worst bug lives. A range review
 *    diffs from the **merge base**, not from `from`, or every commit on the base
 *    branch arrives as the reviewer's problem. A commit review diffs against its
 *    own first parent.
 * 2. **What is skipped, and why.** Binary content has no lines to review;
 *    an oversized file would spend the whole budget on one diff; an excluded
 *    pattern is a decision the project already made. Each is skipped with its
 *    reason recorded, because a file that vanishes without a reason is
 *    indistinguishable from a file the review forgot.
 * 3. **The skip is a *type*.** {@link ReviewSkipReason} is a closed union, so a
 *    report can group skips ("3 binary, 1 oversized") instead of printing free
 *    text, and a test can assert that a new skip category is handled.
 *
 * Everything git-independent lives in {@link selectReviewableFiles} and is
 * tested without a repository; {@link resolveReviewTarget} is the thin
 * orchestration over an injected {@link ReviewGitPort}.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/review/targets
 */

import { Buffer } from 'node:buffer'
import { parseQuotedPath, parseUnifiedDiff, type DiffFile, type DiffFileStatus } from './diff.ts'
import { matchAnyGlob } from './glob.ts'
import { redactCredentialShapes } from '../secret-scan.ts'

/** How a review was scoped. Mirrors the report's own union. */
export type ReviewTargetMode = 'workspace' | 'range' | 'commit'

/** One command's settled outcome; a nonzero exit is a result, not a throw. */
export interface ReviewGitResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * The git surface target selection needs.
 *
 * Injected rather than imported so the whole selection path can be driven from a
 * fixture: git's own output shape for an empty repository, a root commit, or a
 * mid-merge workspace is not something a unit test should have to reproduce.
 */
export interface ReviewGitPort {
  /** Run one git command in `cwd`; never throws for a nonzero exit. */
  run(args: readonly string[], cwd: string): Promise<ReviewGitResult>
  /**
   * Read a file's bytes, for the untracked-file size check.
   *
   * `path` is a git path — relative to the worktree root, as every path this
   * module handles is — and `cwd` is the workspace it belongs to. The workspace is
   * passed because the worktree root is what a git path is relative to, and it is
   * not the same thing as the directory a session happens to be open in.
   */
  readFileSize(path: string, cwd: string): Promise<number | undefined>
}

/** What a caller asks a review to cover. */
export interface ReviewTargetRequest {
  readonly mode: ReviewTargetMode
  readonly cwd: string
  /** Range mode: the source ref. */
  readonly from?: string
  /** Range mode: the target ref; defaults to `HEAD`. */
  readonly to?: string
  /** Commit mode: the commit under review. */
  readonly commit?: string
  /** Extra gitignore-style patterns to exclude, merged with the rule layers. */
  readonly exclude?: readonly string[]
}

/** Default ceiling on one file's diff, above which it is skipped rather than truncated. */
export const DEFAULT_MAX_FILE_BYTES = 1_500_000

/** Default ceiling on how many files one run will attempt. */
export const DEFAULT_MAX_FILES = 400

/** Why a changed file is not being reviewed. */
export type ReviewSkipReason =
  /** git reported binary content, so there are no lines to comment on. */
  | 'binary'
  /** The file's diff or content exceeds the size ceiling. */
  | 'oversized'
  /** A caller or rule layer excluded it by pattern. */
  | 'excluded'
  /** The file's diff could not be read, so nothing can be said about it. */
  | 'unreadable'
  /** The run's own file ceiling was reached before this file. */
  | 'file-limit'
  /** The caller scoped the run to a set of paths this file is not in. */
  | 'outside-scope'

/** One file that will be reviewed. */
export interface ReviewableFile {
  /** Repository-relative path, POSIX separators. */
  readonly path: string
  readonly status: DiffFileStatus
  readonly added: number
  readonly deleted: number
  /** True when the file has no tracked diff because it is untracked. */
  readonly untracked: boolean
  /** Parsed hunks; empty for an untracked file, which the reviewer reads whole. */
  readonly diff: DiffFile | null
}

/** One file that will not be reviewed, and why. */
export interface ExcludedReviewFile {
  readonly path: string
  readonly reason: ReviewSkipReason
  /** Human-readable detail, so a report never shows a bare category. */
  readonly detail: string
}

/** The resolved target: what will be reviewed and what will not. */
export interface ReviewTarget {
  readonly mode: ReviewTargetMode
  readonly cwd: string
  readonly from?: string
  readonly to?: string
  readonly commit?: string
  /** The merge base a range was diffed from; absent outside range mode. */
  readonly mergeBase?: string
  readonly files: readonly ReviewableFile[]
  readonly excluded: readonly ExcludedReviewFile[]
}

/** One changed-file entry before selection. */
export interface ChangedFileEntry {
  readonly path: string
  readonly status: DiffFileStatus
  readonly added: number
  readonly deleted: number
  readonly binary: boolean
  /** Bytes of the diff, or of the whole file for an untracked entry. */
  readonly sizeBytes: number
  readonly untracked: boolean
}

/** Selection inputs that are not the file list itself. */
export interface ReviewSelectionOptions {
  /** Extra gitignore-style patterns to drop. */
  readonly exclude?: readonly string[]
  /**
   * Exact paths this run is confined to; every other changed file is skipped as
   * `outside-scope`.
   *
   * This is what makes a per-turn review affordable. A stop-time gate knows
   * precisely which files the turn touched, so reviewing the workspace's whole
   * uncommitted diff would re-read files that have not changed since the last
   * review — paying for them again and, worse, reporting their findings as if
   * this turn had introduced them.
   */
  readonly include?: readonly string[]
  readonly maxFileBytes?: number
  readonly maxFiles?: number
}

/** The selection outcome. */
export interface ReviewSelection {
  readonly files: readonly ReviewableFile[]
  readonly excluded: readonly ExcludedReviewFile[]
}

/**
 * Decide which changed files to review.
 *
 * Order of checks is deliberate: an excluded pattern is the project's own
 * decision and is reported as such even for a binary file, because a report that
 * calls an excluded file "binary" tells its reader the wrong reason.
 */
export function selectReviewableFiles(
  entries: readonly ChangedFileEntry[],
  diffs: ReadonlyMap<string, DiffFile>,
  options: ReviewSelectionOptions = {},
): ReviewSelection {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const exclude = options.exclude ?? []
  const include = options.include === undefined || options.include.length === 0
    ? undefined
    : new Set(options.include)

  const files: ReviewableFile[] = []
  const excluded: ExcludedReviewFile[] = []

  for (const entry of entries) {
    if (include !== undefined && !include.has(entry.path)) {
      excluded.push({
        path: entry.path,
        reason: 'outside-scope',
        detail: 'changed outside this review\'s scope, so it was not re-reviewed',
      })
      continue
    }
    if (exclude.length > 0 && matchAnyGlob(exclude, entry.path)) {
      excluded.push({ path: entry.path, reason: 'excluded', detail: 'matched an exclude pattern' })
      continue
    }
    if (entry.binary) {
      excluded.push({ path: entry.path, reason: 'binary', detail: 'git reported binary content' })
      continue
    }
    if (entry.sizeBytes > maxFileBytes) {
      excluded.push({
        path: entry.path,
        reason: 'oversized',
        detail: `${entry.sizeBytes} bytes exceeds the ${maxFileBytes}-byte ceiling`,
      })
      continue
    }
    if (files.length >= maxFiles) {
      excluded.push({
        path: entry.path,
        reason: 'file-limit',
        detail: `the run reached its ${maxFiles}-file ceiling`,
      })
      continue
    }
    const diff = diffs.get(entry.path) ?? null
    if (!entry.untracked && diff === null) {
      excluded.push({ path: entry.path, reason: 'unreadable', detail: 'git produced no diff for this path' })
      continue
    }
    files.push({
      path: entry.path,
      status: entry.status,
      added: entry.added,
      deleted: entry.deleted,
      untracked: entry.untracked,
      diff,
    })
  }

  return { files, excluded }
}

/**
 * Parse `git diff --name-status` output.
 *
 * Rename and copy rows carry two paths, and the status letter carries a
 * similarity score (`R100`). Both are consumed here so a renamed file is one
 * entry with its new path, rather than two entries that make the change look
 * twice as large as it is.
 *
 * Paths are unquoted, and that is load-bearing rather than cosmetic: git
 * C-quotes any path holding a non-ASCII byte, so this column otherwise says
 * `"caf\303\251.ts"` while the parsed diff — which does decode — says `café.ts`.
 * Nothing downstream would match: the size lookup, the binary flag, and above all
 * the diff lookup, which sees `undefined` and excludes the file as `unreadable`.
 * Every non-ASCII path in the change set would be reported as unreviewable while
 * the review still called itself complete, and the reason printed to the reader
 * would be a row of octal escapes.
 */
export function parseNameStatus(text: string): { path: string; status: DiffFileStatus; oldPath?: string }[] {
  const out: { path: string; status: DiffFileStatus; oldPath?: string }[] = []
  for (const raw of splitLines(text)) {
    if (raw.trim() === '') continue
    const tab = raw.indexOf('\t')
    if (tab === -1) continue
    const code = raw.slice(0, tab).trim()
    const rest = raw.slice(tab + 1)
    const paths = rest.split('\t').filter(part => part !== '')
    const path = paths[paths.length - 1]
    if (path === undefined) continue
    const letter = code.slice(0, 1).toUpperCase()
    if (letter === 'R' || letter === 'C') {
      const oldPath = paths.length > 1 ? parseQuotedPath(paths[0] as string) : undefined
      const status: DiffFileStatus = letter === 'R' ? 'renamed' : 'copied'
      out.push({ path: parseQuotedPath(path), status, ...(oldPath === undefined ? {} : { oldPath }) })
      continue
    }
    const status: DiffFileStatus =
      letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'M' ? 'modified' : 'modified'
    out.push({ path: parseQuotedPath(path), status })
  }
  return out
}

/**
 * Parse `git diff --numstat` output.
 *
 * A binary file reports `-\t-`, which is why this parser returns `binary`
 * instead of coercing the dash to zero: zero added lines and an unreviewable
 * file are different facts.
 *
 * The path column is keyed the way `--name-status` names the same file, which
 * takes two corrections. It is C-quoted for the same reason every other git path
 * is, and a rename is printed as one column (`old => new`, or the compact
 * `dir/{old => new}.ts`) rather than as the new path alone — so the map would
 * miss exactly the rows it is joined against.
 */
export function parseNumstat(text: string): Map<string, { added: number; deleted: number; binary: boolean }> {
  const out = new Map<string, { added: number; deleted: number; binary: boolean }>()
  for (const raw of splitLines(text)) {
    if (raw.trim() === '') continue
    const parts = raw.split('\t')
    if (parts.length < 3) continue
    const [addedText, deletedText] = parts
    const rawPath = parts.slice(2).join('\t')
    const binary = addedText === '-' || deletedText === '-'
    const stats = {
      added: binary ? 0 : Number(addedText) || 0,
      deleted: binary ? 0 : Number(deletedText) || 0,
      binary,
    }
    const path = resolveNumstatPath(rawPath)
    out.set(path, stats)
    // A file whose name literally contains ` => ` cannot be told from the rename
    // form by reading it, so both readings are kept. Neither loses a row, and this
    // map is a lookup for counts the diff itself also carries.
    if (path !== rawPath) out.set(parseQuotedPath(rawPath), stats)
  }
  return out
}

/**
 * The new-side path of one `--numstat` row.
 *
 * git writes a rename as `old => new` when the two paths share no affixes, and as
 * `dir/{old => new}.ts` when they do; the shared text sits outside the braces and
 * is exactly what the reconstruction has to keep.
 * @param raw - the path column, still quoted.
 * @returns the decoded new-side path.
 */
function resolveNumstatPath(raw: string): string {
  const arrow = raw.indexOf(' => ')
  if (arrow === -1) return parseQuotedPath(raw)
  const left = raw.slice(0, arrow)
  const right = raw.slice(arrow + 4)
  const open = left.lastIndexOf('{')
  const close = right.indexOf('}')
  if (open !== -1 && close !== -1) {
    return parseQuotedPath(`${left.slice(0, open)}${right.slice(0, close)}${right.slice(close + 1)}`)
  }
  return parseQuotedPath(right)
}

/**
 * Resolve a request into a target.
 *
 * Each mode diffs from the ref that makes the change *be* the change:
 * `HEAD` for a workspace (untracked files listed separately), the merge base for
 * a range, and the commit's first parent for a single commit.
 */
export async function resolveReviewTarget(
  git: ReviewGitPort,
  request: ReviewTargetRequest,
  options: ReviewSelectionOptions = {},
): Promise<ReviewTarget> {
  const exclude = [...(options.exclude ?? []), ...(request.exclude ?? [])]
  // Refs are validated here, at the one place every caller funnels through, rather
  // than at each door: a ref becomes a `git` argument below, and a second door
  // that forgot to check would put `--upload-pack=…` in git's argv.
  const ref = await resolveDiffRef(git, validatedRequestRefs(request))

  const diffArgs = ['diff', '--find-renames', '--no-color', ...ref.args]
  // Every read below is required to have succeeded. Reading `.stdout` and treating a
  // failure as an empty string is how a bad ref, a workspace that is not a
  // repository, or a diff past the output ceiling turns into "nothing changed" —
  // the one answer a review must never invent, because a clean report and a review
  // that never ran look identical to whoever reads it.
  const diffText = requireGit(await git.run([...diffArgs, '--'], request.cwd), 'git diff')
  const parsedDiff = parseUnifiedDiff(diffText)

  const numstat = parseNumstat(requireGit(await git.run([...diffArgs, '--numstat', '--'], request.cwd), 'git diff --numstat'))
  const nameStatus = parseNameStatus(requireGit(await git.run([...diffArgs, '--name-status', '--'], request.cwd), 'git diff --name-status'))

  const diffs = new Map<string, DiffFile>()
  for (const file of parsedDiff) diffs.set(file.path, file)

  const entries: ChangedFileEntry[] = []
  const seen = new Set<string>()
  for (const row of nameStatus) {
    seen.add(row.path)
    const stats = numstat.get(row.path)
    const parsed = diffs.get(row.path)
    entries.push({
      path: row.path,
      status: parsed?.status ?? row.status,
      added: stats?.added ?? parsed?.added ?? 0,
      deleted: stats?.deleted ?? parsed?.deleted ?? 0,
      binary: stats?.binary === true || parsed?.binary === true,
      sizeBytes: diffBytesFor(parsed),
      untracked: false,
    })
  }

  if (request.mode === 'workspace') {
    const untracked = await listUntracked(git, request.cwd)
    for (const path of untracked) {
      if (seen.has(path)) continue
      seen.add(path)
      entries.push({
        path,
        status: 'added',
        added: 0,
        deleted: 0,
        binary: false,
        sizeBytes: (await git.readFileSize(path, request.cwd)) ?? 0,
        untracked: true,
      })
    }
  }

  const selection = selectReviewableFiles(entries, diffs, { ...options, exclude })
  return {
    mode: request.mode,
    cwd: request.cwd,
    files: selection.files,
    excluded: selection.excluded,
    ...(ref.from === undefined ? {} : { from: ref.from }),
    ...(ref.to === undefined ? {} : { to: ref.to }),
    ...(ref.commit === undefined ? {} : { commit: ref.commit }),
    ...(ref.mergeBase === undefined ? {} : { mergeBase: ref.mergeBase }),
  }
}

/** How long a ref may be, so a pasted wall of text is refused as a ref and not as a diff. */
export const MAX_REVIEW_REF_CHARS = 256

/**
 * Read one ref from untrusted input, or refuse it.
 *
 * The rule is negative, because the set of valid refs is git's and not ours: what
 * is refused is what would stop being a ref and start being something else — a
 * leading `-` makes git read it as an option (`--upload-pack`, `--ext-diff`), and
 * whitespace splits one argument into two or carries a newline into a command.
 * A blank value is *absent* rather than invalid, so a mode that needs one still
 * reports its own requirement instead of a syntax complaint.
 * @param value - the ref as it arrived, from a tool argument or a browser.
 * @param label - what the value is, for the refusal to name the field.
 * @returns the trimmed ref, or `undefined` when nothing was given.
 */
export function reviewRef(value: unknown, label = 'ref'): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`a review ${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > MAX_REVIEW_REF_CHARS) throw new Error(`a review ${label} is too long to be a git ref`)
  if (trimmed.startsWith('-')) throw new Error(`"${trimmed}" is not a valid git ref: it would be read as an option`)
  if (/\s/u.test(trimmed)) throw new Error(`"${trimmed}" is not a valid git ref: it contains whitespace`)
  return trimmed
}

/** The request's refs, validated and trimmed, with blanks dropped. */
function validatedRequestRefs(request: ReviewTargetRequest): ReviewTargetRequest {
  const from = reviewRef(request.from, 'from ref')
  const to = reviewRef(request.to, 'to ref')
  const commit = reviewRef(request.commit, 'commit')
  return {
    mode: request.mode,
    cwd: request.cwd,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(commit === undefined ? {} : { commit }),
    ...(request.exclude === undefined ? {} : { exclude: request.exclude }),
  }
}

/** The diff arguments and ref names one mode resolves to. */
interface ResolvedRef {
  readonly args: readonly string[]
  readonly from?: string
  readonly to?: string
  readonly commit?: string
  readonly mergeBase?: string
}

/** Resolve the refs one request diffs from. */
async function resolveDiffRef(git: ReviewGitPort, request: ReviewTargetRequest): Promise<ResolvedRef> {
  if (request.mode === 'commit') {
    if (request.commit === undefined || request.commit.trim() === '') {
      throw new Error('a commit review requires a commit')
    }
    const commit = request.commit.trim()
    // A root commit has no parent, so the empty tree stands in for one; asking
    // for `commit^` there fails outright and would make the first commit of a
    // repository unreviewable.
    const hasParent = (await git.run(['rev-parse', '--verify', '--quiet', `${commit}^`], request.cwd)).exitCode === 0
    const base = hasParent ? `${commit}^` : EMPTY_TREE
    return { args: [base, commit], commit }
  }

  if (request.mode === 'range') {
    if (request.from === undefined || request.from.trim() === '') {
      throw new Error('a range review requires a from ref')
    }
    const from = request.from.trim()
    const to = request.to?.trim() ?? 'HEAD'
    const mergeBaseResult = await git.run(['merge-base', from, to], request.cwd)
    const mergeBase = mergeBaseResult.exitCode === 0 ? mergeBaseResult.stdout.trim() : ''
    const base = mergeBase === '' ? from : mergeBase
    return {
      args: [`${base}..${to}`],
      from,
      to,
      ...(mergeBase === '' ? {} : { mergeBase }),
    }
  }

  // A repository with no commits has no HEAD to diff against, and asking for one
  // fails outright — which, now that a failed diff is an error, would make a fresh
  // repository unreviewable. Its untracked files are exactly what there is to
  // review, so the base becomes the empty tree: the same treatment a root commit
  // gets, for the same reason.
  const hasHead = (await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], request.cwd)).exitCode === 0
  return { args: hasHead ? ['HEAD'] : [EMPTY_TREE] }
}

/** The empty tree, used as the "before" side of a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * One git result that must have succeeded, or the reason it did not.
 *
 * git is outside this process, so its stderr is upstream text that becomes a
 * message a model reads — masked, like every other boundary that quotes it, since
 * git quotes paths and remotes back in its failures.
 * @param result - the result to check.
 * @param what - the operation, for the failure to name it.
 * @returns the command's stdout.
 */
function requireGit(result: ReviewGitResult, what: string): string {
  if (result.exitCode === 0) return result.stdout
  const detail = result.stderr.trim() === '' ? describeExit(result.exitCode, what) : result.stderr.trim()
  throw new Error(`${what} failed in the review workspace: ${redactCredentialShapes(detail)}`)
}

/**
 * Why a git call failed when git itself said nothing useful.
 *
 * A `null` exit code is not "exit code null": it is the process never reporting
 * one, which is what a timeout or a diff past the output ceiling looks like. Saying
 * so points the reader at the size of their change set instead of at git.
 */
function describeExit(exitCode: number | null, what: string): string {
  if (exitCode === null) return `${what} did not finish: it was aborted, timed out, or produced more output than can be read`
  return `exit code ${String(exitCode)}`
}

/**
 * Untracked, non-ignored paths, which a plain `git diff` never reports.
 *
 * `--full-name` is not decoration: without it `ls-files` prints paths relative to
 * the directory git was run in, while `git diff --name-status` prints them
 * relative to the worktree root. A session open in a subdirectory would then hand
 * this module two coordinate systems for the same tree — the same file counted
 * once as `packages/a.ts` from `ls-files` and once as `plugin/packages/a.ts` from
 * the diff — so a rule pattern would match one of them and not the other, and the
 * dedup below could not work at all.
 *
 * The lines are unquoted for the same reason `parseUnifiedDiff` unquotes its
 * paths: git C-quotes any path with a non-ASCII or control character, and a
 * quoted path is a different string than the one the diff stages.
 */
async function listUntracked(git: ReviewGitPort, cwd: string): Promise<string[]> {
  const result = await git.run(['ls-files', '--others', '--exclude-standard', '--full-name'], cwd)
  // Not `return []` on failure: an untracked file that cannot be listed is a file
  // the review silently declines to see, and a review that cannot see the new files
  // in a change set is the least useful one there is.
  return splitLines(requireGit(result, 'git ls-files --others'))
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => parseQuotedPath(line))
}

/**
 * Bytes of one file's diff text, which is what the size ceiling bounds.
 *
 * Measured in **bytes**, not string length: a diff of Chinese source is three
 * bytes per character on disk, so counting UTF-16 units would report a file at a
 * third of its real size — and the ceiling is the only thing standing between one
 * enormous file and the whole run's budget. The untracked path measures the same
 * quantity with `stat`, so the two must agree on the unit or the ceiling means
 * different things depending on whether a file is tracked.
 */
function diffBytesFor(file: DiffFile | undefined): number {
  if (file === undefined) return 0
  let bytes = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) bytes += Buffer.byteLength(line.text, 'utf8') + 1
  }
  return bytes
}

/** Split on `\n`, dropping a trailing empty element and any `\r`. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}
