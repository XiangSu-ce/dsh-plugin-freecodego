/**
 * The durable registry of working copies one workspace has handed out.
 *
 * Isolation is a directory, and the directory outlives the process that made it:
 * a restart has to answer "where is this conversation's copy" from a record
 * rather than by guessing at a name. So the entries live in one atomically
 * written JSON document, the parser refuses a document belonging to a different
 * workspace, and a hand-edited file degrades to an empty registry instead of
 * taking a session down.
 *
 * The *format* is the shared thing, not the file: this registry is keyed on a
 * workspace and its document is `<workspace>/.freecodego/worktrees.json`, which
 * the session tool surface (`worktree/tools.ts`) and the standalone creator
 * (`worktree/creator.ts`) both write through. Entries recorded by the retired
 * team runtime are read back verbatim — they are the same shape, and a copy left
 * on disk is a copy somebody may still need to find.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/worktree/registry
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const run = promisify(execFile)

/** Longest git invocation this module waits for. A hung prune must not hang a session. */
const GIT_TIMEOUT_MS = 120_000

const MAX_GIT_OUTPUT = 64_000

/** Where worktrees sit inside the workspace, relative to its root. */
export const WORKTREE_RELATIVE_DIRECTORY = join('.freecodego', 'worktrees')

/**
 * One isolated working copy, as the registry persists it.
 *
 * Durable rather than inferred, and that is the point: whether a copy has a branch,
 * which commit it was cut from, and which creator made it are recorded, because a
 * reader that derived them from `git status` would be guessing about a directory
 * another process may be writing in.
 */
export interface WorktreeEntry {
  readonly id: string
  readonly memberId: string
  /**
   * The branch the worktree is on, or the empty string when there is none.
   *
   * Empty is a real state, not a missing value: a `fast` creator makes a plain
   * working copy with no git branch behind it (see `worktree/creator.ts`), and
   * writing an intended branch name here would make a reader claim a branch that
   * does not exist.
   */
  readonly branch: string
  readonly path: string
  /** Commit the branch was cut from, or the empty string when unknown. */
  readonly base: string
  readonly createdAt: number
  readonly mergedAt?: number | undefined
  readonly state: 'active' | 'merged' | 'abandoned'
  /** Which creator produced it, when the writer recorded one. */
  readonly strategy?: 'git' | 'fast'
  /** Session that holds it, when the entry is keyed on a conversation. */
  readonly sessionId?: string
}

interface WorktreeDocument {
  readonly version: 1
  /** Workspace the worktrees belong to; a mismatched registry is refused. */
  readonly cwd: string
  readonly worktrees: readonly WorktreeEntry[]
}

/**
 * One atomically-written JSON document.
 *
 * `update` serializes read-modify-write **per store instance**, which is to say
 * per file: two mutations of the same document cannot interleave, and a lost
 * update inside one document is impossible. A hot reload can construct a fresh
 * registry while the previous wrapper still serves an in-flight call, so the queue
 * is keyed on the file rather than on the wrapper: the document, not its
 * short-lived TypeScript object, is the ownership unit.
 *
 * Writes publish through `@deepseek-ai/dsh-atomic-write`, so a crash mid-write
 * leaves the previous document intact rather than a truncated one — and the
 * replacement survives Windows filesystem interference, keeps the document's
 * permission bits through the swap, and cannot be redirected through a symlink
 * planted at the path.
 */
export class JsonDocumentStore<T> {
  /** One write tail per durable document, shared by every wrapper in this Host. */
  private static readonly writeTails = new Map<string, Promise<void>>()

  constructor(
    private readonly filePath: string,
    private readonly fallback: () => T,
    private readonly parse: (input: unknown) => T | undefined,
  ) {}

  /** The document this wrapper owns. */
  get path(): string { return this.filePath }

  /**
   * Read the document as it stands on disk.
   * @returns The parsed document, or the fallback when it is absent or unreadable.
   */
  async read(): Promise<T> {
    return await this.readFresh()
  }

  /** Read the durable revision rather than a wrapper-local snapshot. */
  private async readFresh(): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    if (!existsSync(this.filePath)) return this.fallback()
    try {
      return this.parse(JSON.parse(await readFile(this.filePath, 'utf8'))) ?? this.fallback()
    } catch {
      // An unreadable or malformed document must not take the session down. The
      // next update rewrites it, and the caller sees an empty registry rather
      // than an exception whose only sensible handling would be to swallow it
      // here.
      return this.fallback()
    }
  }

  /**
   * Replace the document with a value the caller already holds.
   * @param value - the complete document to persist.
   * @returns Resolves once the replacement is durable.
   */
  async write(value: T): Promise<void> {
    // 0600: a registry names directories, never a shared document. The writer
    // creates its parent itself, so no `mkdir` is needed here.
    await writeFileAtomic(this.filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * Serialized read-modify-write; the returned value is what was persisted.
   * @param mutate - pure step from the current document to its replacement.
   * @returns The document that this update persisted.
   */
  async update(mutate: (current: T) => T): Promise<T> {
    const key = resolve(this.filePath)
    const previous = JsonDocumentStore.writeTails.get(key) ?? Promise.resolve()
    const run = previous.then(async () => {
      // A predecessor may belong to another store instance, so this must read
      // after its write rather than use a cached document from before the shared
      // queue admitted this mutation.
      const current = await this.readFresh()
      const next = mutate(current)
      await this.write(next)
      return next
    })
    // Keep the chain alive after a failure so one rejected update cannot wedge
    // every later one behind a permanently rejected promise.
    const tail = run.then(() => undefined, () => undefined)
    JsonDocumentStore.writeTails.set(key, tail)
    void tail.finally(() => {
      if (JsonDocumentStore.writeTails.get(key) === tail) JsonDocumentStore.writeTails.delete(key)
    })
    return await run
  }
}

function parseWorktrees(cwd: string): (input: unknown) => WorktreeDocument | undefined {
  return (input) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
    const document = input as Partial<WorktreeDocument>
    if (!Array.isArray(document.worktrees) || resolve(document.cwd ?? '') !== resolve(cwd)) return undefined
    return {
      version: 1,
      cwd: resolve(cwd),
      worktrees: document.worktrees.filter(entry => entry !== null && typeof entry === 'object' && typeof (entry as WorktreeEntry).id === 'string'),
    }
  }
}

async function git(cwd: string, args: readonly string[]): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string; readonly code: number }> {
  try {
    const result = await run('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_GIT_OUTPUT })
    return { ok: true, stdout: result.stdout, stderr: result.stderr, code: 0 }
  } catch (error) {
    const failure = error as { readonly stdout?: string; readonly stderr?: string; readonly code?: number; readonly message?: string }
    return {
      ok: false,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? '',
      code: typeof failure.code === 'number' ? failure.code : 1,
    }
  }
}

/**
 * The worktrees one workspace has handed out.
 *
 * Read and append only, which is what the session surface needs: the tool that
 * creates a copy makes its directory itself (`worktree/creator.ts`) and records it
 * here, and the same registry is what `list` reads back later — including after a
 * restart, which is the case the durable document exists for. Paths and branches
 * are never derived from a directory name, because a derivation is exactly what
 * silently disagrees once a second naming convention exists.
 */
export class WorktreeRegistry {
  private readonly store: JsonDocumentStore<WorktreeDocument>
  private readonly root: string

  constructor(cwd: string, filePath: string) {
    this.root = resolve(cwd)
    this.store = new JsonDocumentStore<WorktreeDocument>(filePath, () => ({ version: 1, cwd: this.root, worktrees: [] }), parseWorktrees(this.root))
  }

  /**
   * Every worktree this workspace has registered.
   * @returns The persisted entries; empty when none was ever created.
   */
  async list(): Promise<readonly WorktreeEntry[]> {
    return (await this.store.read()).worktrees
  }

  /**
   * Record a worktree a caller created itself.
   *
   * Deliberately the only write this class performs. A copy of a workspace is
   * made by whoever wants it and registered here afterwards, so one directory of
   * worktrees has one registry — two registries over one directory would each
   * report the other's entries as missing, and the orphan that produces is a
   * worktree nobody can find to clean up.
   * @param entry - the worktree to record, replacing any entry with the same id.
   */
  async register(entry: WorktreeEntry): Promise<void> {
    await this.store.update(current => ({ ...current, worktrees: [...current.worktrees.filter(existing => existing.id !== entry.id), entry] }))
  }

  /**
   * Add the worktree directory to `.git/info/exclude`.
   *
   * The invariant is about the directory rather than about who created an entry,
   * so it is public: a copy made outside this class must still stay out of
   * `git status`.
   */
  async excludeWorktreeDirectory(): Promise<void> {
    await this.excludeFromStatus()
  }

  /** Add the worktree directory to `.git/info/exclude` once. */
  private async excludeFromStatus(): Promise<void> {
    const info = await git(this.root, ['rev-parse', '--git-dir'])
    if (!info.ok) return
    const gitDirectory = resolve(this.root, info.stdout.trim())
    const exclude = join(gitDirectory, 'info', 'exclude')
    const pattern = `${WORKTREE_RELATIVE_DIRECTORY.replaceAll('\\', '/')}/`
    try {
      const existing = existsSync(exclude) ? await readFile(exclude, 'utf8') : ''
      if (existing.split('\n').some(line => line.trim() === pattern)) return
      await mkdir(join(gitDirectory, 'info'), { recursive: true })
      await appendFile(exclude, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}# FreeCodeGo worktrees\n${pattern}\n`, 'utf8')
    } catch {
      // A workspace whose git directory is not writable still gets working
      // isolation; only the status noise remains, which is not worth failing on.
    }
  }
}
