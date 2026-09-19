/**
 * Companion-file reader behind the Skill library detail dialog.
 *
 * A `SKILL.md` is only part of a Skill: several of the bundled ones keep their
 * real payload in a sibling file (`codebase-design/DESIGN-IT-TWICE.md`,
 * `prototype/LOGIC.md`, `wizard/template.sh`, the per-skill `agents/` briefs),
 * and the Skills page used to show none of it. The dialog reads the body
 * from the Skill service and the siblings from here.
 *
 * Everything this module returns is derived from a directory listing it did
 * itself, so a caller cannot ask for a path outside the Skill directory: the
 * requested path has to match a listed entry, and the containment check below
 * re-proves it locally rather than trusting the listing.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/skill-detail
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { FreeCodeGoSkillFile } from './types.ts'

/**
 * The shape a Skill body has to have before its quoted names count as forwards.
 *
 * The bundled alias Skills state their intent in one sentence, so the check is
 * deliberately strict: a body that does any work of its own must never have
 * unrelated Skills printed under it, because that would misdescribe it.
 */
const SKILL_FORWARD_OPENER = 'Call the Skill tool'
/** Quoted Skill names inside that one line. */
const SKILL_FORWARD_NAME = /"([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)"/g

/**
 * The Skill names a thin alias body forwards to, in order of appearance.
 *
 * Several bundled Skills exist only so a human has a name to type: their whole
 * `SKILL.md` is `Call the Skill tool with "grilling".`, and the real prompt lives
 * in the Skill they name. That makes the library dialog's body tab look empty
 * for exactly the entries someone opens to find out what the Skill does, so the
 * caller resolves these names and shows their bodies beside the alias.
 * @param content - the `SKILL.md` body, front matter already stripped by the provider.
 * @returns unique kebab-case names in the order quoted; empty when the body does real work.
 */
export function skillForwardTargets(content: string): readonly string[] {
  const lines = content.split('\n').map(line => line.trim()).filter(line => line !== '')
  // One instruction line, or it is not an alias: extra prose is the Skill's own.
  if (lines.length !== 1) return []
  const line = lines[0]!
  if (!line.startsWith(SKILL_FORWARD_OPENER)) return []
  const names: string[] = []
  for (const match of line.matchAll(SKILL_FORWARD_NAME)) {
    if (!names.includes(match[1]!)) names.push(match[1]!)
  }
  return names
}

/** How deep below the Skill directory siblings are listed. */
const MAX_DEPTH = 3
/** Cap on listed entries, so one pathological directory cannot bloat the dialog. */
const MAX_ENTRIES = 200
/** Files above this size are listed but not returned inline. */
const MAX_FILE_BYTES = 256 * 1024

/** The directory holding a Skill's `SKILL.md`, when the provider reported a path. */
export function skillCompanionDirectory(skillPath: string | undefined): string | undefined {
  if (skillPath === undefined || skillPath.trim() === '') return undefined
  return dirname(resolve(skillPath))
}

/**
 * List the files beside a Skill's `SKILL.md`.
 * @param directory - the Skill directory, or `undefined` when the provider had no path.
 * @returns sorted relative paths with their byte sizes; empty when unknown or unreadable.
 */
export async function listSkillCompanionFiles(directory: string | undefined): Promise<readonly FreeCodeGoSkillFile[]> {
  if (directory === undefined) return []
  const found: FreeCodeGoSkillFile[] = []
  await walk(directory, '', 0, found)
  return found.sort((left, right) => left.path.localeCompare(right.path))
}

async function walk(root: string, prefix: string, depth: number, found: FreeCodeGoSkillFile[]): Promise<void> {
  if (depth > MAX_DEPTH || found.length >= MAX_ENTRIES) return
  let entries: readonly import('node:fs').Dirent[]
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch {
    // An unreadable directory contributes nothing rather than failing the dialog.
    return
  }
  for (const entry of entries) {
    if (found.length >= MAX_ENTRIES) return
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      await walk(root, path, depth + 1, found)
      continue
    }
    if (!entry.isFile()) continue
    // The body is delivered by the Skill service, not as a companion file.
    if (depth === 0 && entry.name === 'SKILL.md') continue
    try {
      found.push({ path, bytes: (await stat(join(root, path))).size })
    } catch {
      // A file that vanished between readdir and stat is simply absent.
    }
  }
}

/**
 * Read one listed companion file.
 * @param input - the Skill directory, the listing that authorized the path, and the requested path.
 * @returns the file's text content and byte size.
 * @throws when the path is not a listed entry, is too large, or is not text.
 */
export async function readSkillCompanionFile(input: {
  readonly directory: string | undefined
  readonly files: readonly FreeCodeGoSkillFile[]
  readonly path: string
}): Promise<{ readonly path: string; readonly bytes: number; readonly content: string }> {
  const directory = input.directory
  if (directory === undefined) throw new Error('This Skill reports no directory, so its companion files cannot be read')
  const listed = input.files.find(entry => entry.path === input.path)
  if (listed === undefined) throw new Error(`"${input.path}" is not a file in this Skill directory`)
  if (listed.bytes > MAX_FILE_BYTES) throw new Error(`"${input.path}" is ${listed.bytes} bytes; companion files above ${MAX_FILE_BYTES} bytes are not shown`)
  const absolute = resolve(directory, listed.path)
  if (!absolute.startsWith(directory + sep)) throw new Error(`"${input.path}" resolves outside this Skill directory`)
  // The lexical check above is the listing's own containment, and `resolve()
  // does not follow links: a link *inside* the Skill directory named like a
  // companion file resolves to a path inside it while `readFile` opens whatever
  // it points at. Comparing real paths is what makes the module's promise —
  // that it re-proves containment instead of trusting the listing — true for a
  // listing it did not build. The file's own resolution falls back to the
  // lexical answer when the target is gone, so a vanished file still reports as
  // a read failure rather than as an escape.
  const [realDirectory, realTarget] = await Promise.all([
    realpath(directory),
    realpath(absolute).catch(() => absolute),
  ])
  if (!realTarget.startsWith(realDirectory + sep)) throw new Error(`"${input.path}" resolves outside this Skill directory`)
  const buffer = await readFile(absolute)
  // A NUL byte is the cheap, dependency-free tell for a binary sibling; showing
  // a decoded PNG as mojibake would be worse than saying nothing.
  if (buffer.includes(0)) throw new Error(`"${input.path}" is not a text file`)
  return { path: listed.path, bytes: buffer.byteLength, content: buffer.toString('utf8') }
}
