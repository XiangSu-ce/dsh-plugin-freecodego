/**
 * The plan on disk.
 *
 * Why the plan is a file rather than a message
 * -------------------------------------------
 * A plan is reviewed, argued with line by line, and revisited after the session
 * that produced it is gone. Held only as a transcript message it can be quoted but
 * not commented on, and it disappears with the conversation. On disk it is a
 * document with a path: the review overlay can point at lines, the user's remarks
 * can name them, and a restarted process can read the same text back instead of
 * reconstructing it from a log.
 *
 * Why the path is this plugin's own
 * ---------------------------------
 * The harness keeps per-session files under a private layout it is free to change
 * between releases; a plugin that reached into it would break on an upgrade with no
 * warning and no compile error. The plan therefore lives under this plugin's own * data root, which `data-home.ts` already owns for engineering memory, checkpoints
 * and plan state.
 *
 * The one writer
 * --------------
 * `engineering_plan_mode` (enter and exit) and the user's comment submission are
 * the only writes. In particular the *exit* path reads this file back rather than
 * trusting anything held in memory, so what is approved is the text that is on
 * disk — a plan edited by hand between enter and exit is approved as edited, which
 * is the only behaviour that makes the file the document of record.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/plan/plan-file
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { freeCodeGoDataHome } from '../data-home.ts'

/** The file's name inside a session's plan directory. */
export const PLAN_FILE_NAME = 'plan.md'

/**
 * Directory holding one session's plan.
 * @param sessionId - the session the plan belongs to.
 * @returns the absolute directory.
 */
export function planDirectory(sessionId: string): string {
  return join(freeCodeGoDataHome(), 'freecodego', 'plans', safeSegment(sessionId))
}

/**
 * The plan file for one session.
 * @param sessionId - the session the plan belongs to.
 * @returns the absolute path of `plan.md`.
 */
export function planFilePath(sessionId: string): string {
  return join(planDirectory(sessionId), PLAN_FILE_NAME)
}

/**
 * Make a session id safe to use as one path segment, **without losing which id it
 * was**.
 *
 * A session id reaches this function from a log or a wire call, and a value
 * containing a separator would place the plan outside the directory that is
 * supposed to contain it — including, for a `..`, outside the plugin's data root.
 *
 * The mapping is **injective**, and that is the point of its shape. It used to
 * replace every unreserved character with `_`, which is safe and lossy: `a/b` and
 * `a_b` both became `a_b`, so two sessions were handed one `plan.md` — A's plan
 * read back as B's and B's exit approved A's text — and `isPlanFile` answered true
 * for both. This repository already contained the right function for the job (the
 * session log's `encodeSegment`, and `spill-local`'s copy of it, whose header says
 * "distinct inputs never collide"), but both live in packages this plugin does not
 * depend on, and taking a dependency on a persistence backend in order to name one
 * plan directory is the wrong trade; the rule is ten lines, so it is stated here
 * rather than borrowed.
 *
 * The rule: an unreserved character stands for itself, and everything else —
 * including `~` itself, which is what makes the reading unambiguous — becomes
 * `~` followed by **six** hex digits of its code point. Six rather than four
 * because a four-digit escape is ambiguous against an astral code point: `U+1000`
 * escaped as `~1000` followed by a literal `0` would spell the same segment as
 * `U+10000` escaped as `~10000`. A fixed width makes every `~` the start of exactly
 * six digits, so the segment decodes back to one id and only that id.
 *
 * Two consequences of path semantics are handled explicitly, because they are where
 * an injective-looking mapping stops being injective *on a filesystem*: a segment
 * that would be `.` or `..` is escaped (it names a directory other than itself),
 * and a trailing `.` is escaped because win32 drops it, which would make `a.` and
 * `a` the same component.
 *
 * A note on what this does not fix: win32 and macOS compare names case-insensitively,
 * so two ids differing only in case still share one directory there. Lowercasing
 * would move the problem rather than solve it (the same session would then have two
 * plan files on POSIX and one elsewhere), so it is recorded rather than guessed at.
 *
 * @param sessionId - the raw session id.
 * @returns a single safe path segment that identifies that one id.
 */
export function safeSegment(sessionId: string): string {
  // The empty id needs a segment of its own, and it has to be one no other id
  // can produce: this used to return `_`, which is exactly what the perfectly
  // ordinary id `_` maps to. A bare `~` is unreachable by construction — every
  // `~` in a produced segment begins six hex digits — so empty and `_` stay
  // distinct.
  if (sessionId === '') return '~'
  const escape = (character: string): string => `~${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(6, '0')}`
  let segment = ''
  for (const character of sessionId) segment += /^[A-Za-z0-9._-]$/u.test(character) ? character : escape(character)
  if (segment === '.' || segment === '..') segment = [...segment].map(escape).join('')
  return segment.endsWith('.') ? `${segment.slice(0, -1)}${escape('.')}` : segment
}

/**
 * Whether a path names this session's plan file.
 *
 * What it compares, and what it does not
 * -------------------------------------
 * Both sides go through `resolve`, which unifies a relative path, a redundant
 * separator and a `..` segment — measured, so `plan.md/` and `./plan.md` are
 * recognized. It does **not** follow symbolic links, because `resolve` never
 * touches the filesystem: a plan addressed through a symlinked ancestor, or
 * through Windows' 8.3 short name for the same directory, compares unequal to the
 * plan addressed directly. A caller that needs that has to compare `realpath` on
 * both sides, which is a system call this function deliberately does not make —
 * it is synchronous, and a plan file legitimately may not exist yet.
 *
 * No fence calls it, and that is recorded rather than implied
 * ----------------------------------------------------------
 * This comment used to call the function "the edit fence's only allowed
 * destination". No fence does. Plan Mode's containment is implemented by name in
 * `plan-mode.ts`, which refuses every mutating tool and every unclassified plugin
 * tool. A path-based fence was written for this module and withdrawn: it judged a
 * call by whether the path it named was the plan file, and that judgment cannot
 * tell a write from a read (`read` names a `path` too), so wired in it would have
 * refused the searching and checking Plan Mode exists to allow. A rule that cannot
 * make the distinction it needs is not a stricter rule — it is a broken one. So
 * this stays for the path arithmetic the spec pins, and for a future fence able to
 * make that distinction: such a fence would call it, and would need the `realpath`
 * comparison above before treating a `true` as permission.
 * @param sessionId - the session whose plan file is the reference.
 * @param path - the path a caller is asking about.
 * @returns whether the two name the same file, by spelling once resolved.
 */
export function isPlanFile(sessionId: string, path: string): boolean {
  return resolve(path) === resolve(planFilePath(sessionId))
}

/** Read and write one session's plan file. */
export class PlanFileStore {
  /**
   * Read the plan.
   *
   * A missing plan is `undefined` rather than an error: entering Plan Mode and
   * reviewing before anything has been written are both ordinary, and an exception
   * here would turn "no plan yet" into a failure the caller has to distinguish.
   * @param sessionId - the session whose plan to read.
   * @returns the text, or `undefined` when there is none.
   */
  async read(sessionId: string): Promise<string | undefined> {
    return await readFile(planFilePath(sessionId), 'utf8').catch(() => undefined)
  }

  /**
   * Replace the plan.
   *
   * Written whole and staged through a temporary file, because the review overlay
   * may read at any moment and a partial plan is one whose `Files` section is
   * missing — a reviewer would approve a plan that is not the one on disk a second
   * later.
   *
   * The staging file is named per write rather than per process, because two writes
   * can overlap here by design: the model rewrites the plan while the user submits a
   * comment. Sharing one name makes whichever renames second find its own staging file
   * already moved, which is `ENOENT` — deterministic on POSIX, and intermittent on
   * Windows, where two renames onto one destination already report `EPERM` for the
   * loser. A per-write name removes the class rather than the symptom.
   * @param sessionId - the session whose plan to write.
   * @param body - the complete plan text.
   * @returns the absolute path written.
   */
  async write(sessionId: string, body: string): Promise<string> {
    const file = planFilePath(sessionId)
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
    await rename(temporary, file)
    return file
  }

  /**
   * The plan as the exit path must see it: the text on disk, never a memory copy.
   * @param sessionId - the session whose plan to approve.
   * @returns the text, or `undefined` when nothing was ever written.
   */
  async forApproval(sessionId: string): Promise<string | undefined> {
    return await this.read(sessionId)
  }
}
