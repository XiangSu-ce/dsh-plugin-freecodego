/**
 * Durable team state primitives.
 *
 * A team outlives one process: tasks get claimed, messages arrive while a
 * member is mid-turn, and a restarted Host must be able to say what was in
 * flight. So every piece of team state lives in a JSON file under the plugin's
 * own directory, written atomically, and read back with a shape check rather
 * than a cast — a hand-edited or half-written file must degrade to an empty
 * board, not crash a session.
 *
 * The store is deliberately small. It owns three things the board and the
 * member registry must agree on: where a team's files live, how a write becomes
 * atomic, and how text from a model is bounded before it is persisted.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/team/state
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { freeCodeGoDataHome } from '../data-home.ts'

/** Longest string this module will persist for a single field. */
export const TEAM_TEXT_LIMIT = 4_000

/**
 * Longest note a task carries.
 *
 * A note is the one team field whose length the model can read before writing:
 * the `engineering_team_task_update` schema states it, and the same bound is
 * applied by every board method that stores one. It was written as a literal in
 * eight places and the schema carried a ninth, so the promise and the behaviour
 * could disagree — and one did: `approve` kept 1 000 of the 2 000 the schema
 * accepted, silently halving a review rationale. Naming it makes the two
 * unable to drift, which is the whole reason it is exported rather than local.
 */
export const TEAM_NOTE_LIMIT = 2_000

/** Where all team directories live, mirroring the engineering memory layout. */
export function teamRootDirectory(): string {
  const home = freeCodeGoDataHome()
  return join(home, 'freecodego', 'engineering', 'teams')
}

/**
 * Collapse and bound one persisted string.
 *
 * Applied on the way *in*, not on the way out: a value that was never stored
 * cannot leak later, and a bound enforced at the write site is checkable by
 * reading one function.
 */
export function boundedTeamText(value: unknown, limit = TEAM_TEXT_LIMIT): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.replaceAll('\r\n', '\n').trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`
}

/** Mint a stable, sortable-enough identity for a team-owned record. */
export function teamId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

/**
 * One atomically-written JSON document.
 *
 * `update` serializes read-modify-write **per store instance**, which is to say
 * per file: two mutations of the same document cannot interleave, and a lost
 * update inside one document is impossible. It is explicitly *not* a lock across
 * documents — the board and the member registry are separate files with separate
 * queues, so "claim a task, then record who holds it" is two independent writes
 * and the pair is not atomic. A caller that needs one of the two to be
 * authoritative should treat the board as that one, because the claim is what
 * `engineering_team_recover` reports from and what the claim token is minted
 * against; the member record is a projection of it for display.
 *
 * Writes publish through `@deepseek-ai/dsh-atomic-write`, so a crash mid-write
 * leaves the previous document intact rather than a truncated one — and, unlike
 * the local `rename` this used to do, the replacement survives Windows filesystem
 * interference, keeps the document's permission bits through the swap, and cannot
 * be redirected through a symlink planted at the path.
 */
export class TeamJsonStore<T> {
  /**
   * One write tail per durable document, shared by every wrapper in this Host.
   *
   * A hot reload can construct a fresh board, roster, or worktree registry while
   * the previous wrapper still serves an in-flight call. Serializing only on
   * `this` lets both wrappers read the same revision and publish conflicting
   * replacements. The file, not its short-lived TypeScript wrapper, is the
   * ownership unit.
   */
  private static readonly writeTails = new Map<string, Promise<void>>()

  constructor(
    private readonly filePath: string,
    private readonly fallback: () => T,
    private readonly parse: (input: unknown) => T | undefined,
  ) {}

  get path(): string { return this.filePath }

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
      // next update rewrites it, and the caller sees an empty board rather than
      // an exception whose only sensible handling would be to swallow it here.
      return this.fallback()
    }
  }

  async write(value: T): Promise<void> {
    // 0600: a board carries the model's own task text, never a shared document.
    // The writer creates its parent itself, so no `mkdir` is needed here.
    await writeFileAtomic(this.filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  /** Serialized read-modify-write; the returned value is what was persisted. */
  async update(mutate: (current: T) => T): Promise<T> {
    const key = resolve(this.filePath)
    const previous = TeamJsonStore.writeTails.get(key) ?? Promise.resolve()
    const run = previous.then(async () => {
      // A predecessor may belong to another TeamJsonStore instance, so this
      // must read after its write rather than use a cached document from before
      // the shared queue admitted this mutation.
      const current = await this.readFresh()
      const next = mutate(current)
      await this.write(next)
      return next
    })
    // Keep the chain alive after a failure so one rejected update cannot wedge
    // every later one behind a permanently rejected promise.
    const tail = run.then(() => undefined, () => undefined)
    TeamJsonStore.writeTails.set(key, tail)
    void tail.finally(() => {
      if (TeamJsonStore.writeTails.get(key) === tail) TeamJsonStore.writeTails.delete(key)
    })
    return await run
  }

  /**
   * Retained for callers written before reads became durable-revision reads.
   *
   * There is no wrapper-local snapshot left to discard: the next read already
   * observes a change made by another instance or a restarted Host.
   */
  invalidate(): void {}
}

/**
 * Resolve one team's directory, refusing a symlinked root.
 *
 * The refusal matches the engineering memory store: a symlink at the state root
 * would let a peer's data be written somewhere else entirely, and the check is
 * cheap enough to run once per team open.
 */
export function teamDirectory(root: string, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/gu, '')
  if (safe === '') throw new Error('team id must contain at least one identifier character')
  const directory = resolve(root, safe)
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('team directory must not be a symlink')
  return directory
}
