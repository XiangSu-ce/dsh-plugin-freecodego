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

/**
 * The filesystem seam the Skill dialog reads companion files through.
 *
 * Structurally the Harness's `ctx.fs` shape, because that is what the provider
 * layer uses: `skill-filesystem` loads a Skill body through this seam, so a
 * dialog reading the host's `node:fs` instead would list files the model cannot
 * see whenever the composition points the seam at a sandbox — and refuse to list
 * ones it can. `contains` is the backend's own canonical containment, which is a
 * stronger answer than the plugin's lexical check plus `realpath` for the one
 * question this module actually asks: is this file inside the Skill directory?
 */
export interface SkillCompanionFs {
  /** Resolve a path into a backend-owned target. */
  resolve(path: string): Promise<unknown>
  /** List one directory's children, each with its own resolved target. */
  listDir(target: unknown): Promise<readonly { readonly name: string; readonly type: 'file' | 'directory' | 'other'; readonly target: unknown; readonly size?: number }[]>
  /** Read a resolved target as decoded text. */
  readText(target: unknown): Promise<string>
  /** Whether one resolved target is the other, or a descendant of it. */
  contains(parent: unknown, child: unknown): boolean
}

/** The directory holding a Skill's `SKILL.md`, when the provider reported a path.
 * @param skillPath - the reported `SKILL.md` path.
 * @returns the containing directory, or `undefined` when no path was reported.
 */
export function skillCompanionDirectory(skillPath: string | undefined): string | undefined {
  if (skillPath === undefined || skillPath.trim() === '') return undefined
  return dirname(resolve(skillPath))
}

/**
 * The provider's own statement of where a Skill's relative resources live.
 *
 * Deliberately structural rather than imported: the shape belongs to
 * `@deepseek-ai/dsh-skill` (which owns it as `SkillResourceBase`), and that
 * package is not a dependency of this one. `kind` stays open for the same reason
 * the module refuses a base it cannot read — a provider from a newer Harness must
 * be *refused*, never guessed at with a fallback that reads the wrong directory.
 */
export type SkillResourceBaseLike =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }
  | { readonly kind: string; readonly [key: string]: unknown }

/** Where a Skill's companion files can be read, and why not when they cannot. */
export type SkillResourceLocation =
  | { readonly kind: 'directory'; readonly directory: string; readonly provenance: string }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Resolve where a Skill's companion files live, the Harness's answer first.
 *
 * `resourceBase` is the *provider's* statement about its own resources, and it is
 * the only one that covers a virtual Skill: the bundled `dsh-badge` skill reports
 * assets in its package directory and reports **no** `SKILL.md` path at all, so
 * inferring the directory from the path showed a Skill that has files as having
 * none, and refused to open the ones it told the model about. Inferring from the
 * path therefore stays the *fallback* — for a provider that declares no base —
 * rather than the first answer.
 *
 * A declared base this build cannot read (a URL, an opaque provider handle, or a
 * `kind` from a newer Harness) is reported as unavailable with the provider's own
 * wording, not silently downgraded to a local read: "these resources are not local
 * files" and "these resources are in this directory" are different facts, and
 * printing the second while doing the first is how a dialog shows a wrong file.
 *
 * @param skill - the loaded Skill's `path` and declared `resourceBase`.
 * @returns the directory to read, or the reason there is none.
 */
export function skillResourceLocation(skill: { readonly path?: string | undefined; readonly resourceBase?: SkillResourceBaseLike | undefined }): SkillResourceLocation {
  const base = skill.resourceBase
  if (base !== undefined) {
    if (base.kind === 'directory' && typeof base.path === 'string' && base.path.trim() !== '') {
      return { kind: 'directory', directory: resolve(base.path), provenance: "the resource base this Skill's provider declared" }
    }
    if (base.kind === 'url' && typeof base.url === 'string' && base.url.trim() !== '') {
      return { kind: 'unavailable', reason: `this Skill's resources are served from ${base.url}, not from a local directory` }
    }
    if (base.kind === 'opaque' && typeof base.description === 'string' && base.description.trim() !== '') {
      return { kind: 'unavailable', reason: base.description }
    }
    return { kind: 'unavailable', reason: `this Skill's provider declares a "${base.kind}" resource base, which this build does not know how to read` }
  }
  const directory = skillCompanionDirectory(skill.path)
  return directory === undefined
    ? { kind: 'unavailable', reason: 'This Skill reports no directory, so its companion files cannot be read' }
    : { kind: 'directory', directory, provenance: "the SKILL.md path this Skill's provider reported" }
}

/**
 * List the files beside a Skill's `SKILL.md`.
 *
 * Through `fs` when the composition mounts it, through the host's own filesystem
 * otherwise — the same fallback the rest of this plugin keeps wherever the
 * Harness offers a seam.
 * @param directory - the Skill directory, or `undefined` when the provider had no path.
 * @param fs - the Harness's filesystem service, when one is mounted.
 * @returns sorted relative paths with their byte sizes; empty when unknown or unreadable.
 */
export async function listSkillCompanionFiles(directory: string | undefined, fs?: SkillCompanionFs): Promise<readonly FreeCodeGoSkillFile[]> {
  if (directory === undefined) return []
  const found: FreeCodeGoSkillFile[] = []
  if (fs === undefined) await walk(directory, '', 0, found)
  else await walkThroughFs(fs, directory, '', await fs.resolve(directory), 0, found)
  return found.sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * The same walk over a resolved target, for a filesystem the host cannot read.
 *
 * A directory this seam cannot list contributes nothing rather than failing the
 * dialog, which is the rule the host walk keeps as well: the Skill body is
 * already readable through the service, and a listing that cannot be built is a
 * reason to show less, never a reason to open nothing.
 */
async function walkThroughFs(fs: SkillCompanionFs, root: string, prefix: string, target: unknown, depth: number, found: FreeCodeGoSkillFile[]): Promise<void> {
  if (depth > MAX_DEPTH || found.length >= MAX_ENTRIES) return
  let entries: Awaited<ReturnType<SkillCompanionFs['listDir']>>
  try {
    entries = await fs.listDir(target)
  } catch {
    return
  }
  for (const entry of entries) {
    if (found.length >= MAX_ENTRIES) return
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.type === 'directory') {
      await walkThroughFs(fs, root, path, entry.target, depth + 1, found)
      continue
    }
    if (entry.type !== 'file') continue
    if (depth === 0 && entry.name === 'SKILL.md') continue
    // A backend that cannot report a size still lists the file: the size gates
    // inlining, and `0` would refuse a file that may well be small.
    found.push({ path, bytes: entry.size ?? 0 })
  }
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
 * @param input - the Skill directory, the listing that authorized the path, the requested path, and the filesystem seam.
 * @returns the file's text content and byte size.
 * @throws when the path is not a listed entry, is too large, or is not text.
 */
export async function readSkillCompanionFile(input: {
  readonly directory: string | undefined
  readonly files: readonly FreeCodeGoSkillFile[]
  readonly path: string
  readonly fs?: SkillCompanionFs | undefined
}): Promise<{ readonly path: string; readonly bytes: number; readonly content: string }> {
  const directory = input.directory
  if (directory === undefined) throw new Error('This Skill reports no directory, so its companion files cannot be read')
  const listed = input.files.find(entry => entry.path === input.path)
  if (listed === undefined) throw new Error(`"${input.path}" is not a file in this Skill directory`)
  if (listed.bytes > MAX_FILE_BYTES) throw new Error(`"${input.path}" is ${listed.bytes} bytes; companion files above ${MAX_FILE_BYTES} bytes are not shown`)
  if (input.fs !== undefined) {
    // Containment is asked of the backend rather than re-derived here: `resolve`
    // follows a link to its target, so `contains` answers the real question for
    // a listing this module did not build.
    const [root, file] = await Promise.all([input.fs.resolve(directory), input.fs.resolve(resolve(directory, listed.path))])
    if (!input.fs.contains(root, file)) throw new Error(`"${input.path}" resolves outside this Skill directory`)
    const content = await input.fs.readText(file)
    if (content.includes('\u0000')) throw new Error(`"${input.path}" is not a text file`)
    return { path: listed.path, bytes: Buffer.byteLength(content, 'utf8'), content }
  }
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
