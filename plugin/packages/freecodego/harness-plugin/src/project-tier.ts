/**
 * The project tier's *consumed* half: accepted keys turned into mountable entries.
 *
 * Why this module exists
 * ---------------------
 * `project-config.ts` reads `.freecodego/config.json` and reports which keys it
 * accepts. For a while that was all it did: the file was parsed, the accepted
 * keys were shown in the settings surface, and **nothing ever mounted them** — so
 * a repository that declared its own MCP server or Skill root got a green
 * "accepted" badge and no server. The tier's own header promises the opposite
 * ("they run only in a repository the user trusted, and the gate is asked before
 * they are mounted"), and a promise with no caller is the defect this module
 * closes.
 *
 * What it guarantees
 * ------------------
 * - **Defensive parsing, never a throw.** The document is written by whoever
 *   authored the repository, so every entry is validated here and a bad entry is
 *   set aside with a note rather than taking a plugin down. There is no schema
 *   library in this path on purpose: the shapes are tiny, and `z`'s error
 *   reporting would have to be reworded into a note anyway.
 * - **Project entries can never masquerade as the user's.** Every id this module
 *   produces carries a `project:` prefix, so a repository cannot name its server
 *   `id: "my-laptop-server"` and have it collide with — or overwrite — an entry
 *   the user configured. The two inventories stay separable in the mount maps,
 *   in `mountErrors`, and in `trustRefusals`.
 * - **Paths are relative to the repository.** A project file says `./skills`, not
 *   a machine-specific absolute path; relative paths resolve against the
 *   workspace root, which is the only directory the file can speak about.
 * - **`permissionRules` may only ever add denials.** They compile into a
 *   *separate* policy that is evaluated *in addition to* the built-in one, never
 *   merged with it. Merging would let a project rule of the same pattern length
 *   outrank a built-in `forbidden` rule and therefore *un-forbid* `rm -rf /` —
 *   a repository quietly weakening the guard. Two policies, and a denial from
 *   either, is monotonic by construction.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/project-tier
 */

import { isAbsolute, resolve } from 'node:path'

import { compileCommandPolicy, describePolicyDiagnostics, type CompiledCommandPolicy } from './command-policy.ts'
import type { ProjectConfigReadResult } from './project-config.ts'
import type { FreeCodeGoMcpServer, FreeCodeGoSkillRoot } from './types.ts'
import { isRecord } from './untrusted-json.ts'

/** Prefix every project-declared entry id carries, so it cannot shadow a user's. */
export const PROJECT_ENTRY_ID_PREFIX = 'project:'

/**
 * Cap per family, the same value `capabilities.ts` enforces for the user's own
 * inventory. A second, larger limit here would let a repository mount more
 * servers than the settings surface permits the user to configure.
 */
const MAX_PROJECT_ENTRIES = 24

/** The server-name shape the shared MCP client accepts. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** What the tier actually contributes, once parsed. */
export interface ProjectTier {
  /** MCP servers this checkout wants, ids prefixed with {@link PROJECT_ENTRY_ID_PREFIX}. */
  readonly mcpServers: readonly FreeCodeGoMcpServer[]
  /** Skill roots this checkout ships, paths resolved against the workspace root. */
  readonly skillRoots: readonly FreeCodeGoSkillRoot[]
  /**
   * The repository's own command-policy document, compiled.
   *
   * Absent when the repository declared no usable rules. When present it is
   * evaluated *beside* the built-in policy, never instead of it.
   */
  readonly policy?: CompiledCommandPolicy
  /** The repository's `hooks` block, unparsed: the hook surface owns that dialect. */
  readonly hooks?: unknown
  /** One line per entry that was set aside, and why. Empty when everything was used. */
  readonly notes: readonly string[]
}

/** Read an array of strings, or undefined when the value is not one. */
function stringArray(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (!value.every(entry => typeof entry === 'string')) return undefined
  return value.slice(0, limit).map(entry => entry as string)
}

/** Read an object of string values, or undefined when the value is not one. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined
    out[key] = entry
  }
  return out
}

/** Resolve a declared path against the workspace root, leaving absolute ones alone. */
function resolveUnder(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path)
}

/** Bound an id to the length the mount maps and the settings schema accept. */
function boundedId(candidate: string): string | undefined {
  const id = `${PROJECT_ENTRY_ID_PREFIX}${candidate}`.trim()
  return id.length > 80 ? undefined : id
}

/** FNV-1a, so a derived id is stable across runs without pulling in crypto. */
function shortHash(value: string): string {
  let hash = 0x811c_9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x0100_0193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * A stable, bounded id for an entry that declared none.
 *
 * Bounded on purpose, and the reason is a real failure rather than tidiness: the
 * obvious derivation — the resolved absolute path — is longer than the 80
 * characters the mount maps and the settings schema allow for any realistic
 * checkout (a `git clone` into a temp directory alone can exceed it). The first
 * version of this module dropped every root whose path was long enough, which is
 * a Skill root the repository declared and silently did not get. The path's tail
 * keeps the id recognisable; the hash keeps two roots that share a basename
 * apart.
 * @param kind - the family the entry belongs to, for a legible id.
 * @param key - the entry's own key, normally its resolved path.
 * @returns an id no longer than 80 characters, prefixed like every other one.
 */
function derivedId(kind: string, key: string): string {
  const tail = key.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? ''
  const safe = tail.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 40)
  return `${PROJECT_ENTRY_ID_PREFIX}${kind}-${safe === '' ? 'root' : safe}-${shortHash(key)}`
}

function mcpServerFrom(
  value: unknown,
  index: number,
  root: string,
  notes: string[],
): FreeCodeGoMcpServer | undefined {
  const where = `mcpServers[${index}]`
  if (!isRecord(value)) {
    notes.push(`${where} is not an object, so it was not mounted`)
    return undefined
  }
  const serverName = typeof value.serverName === 'string'
    ? value.serverName
    : typeof value.name === 'string' ? value.name : undefined
  if (serverName === undefined || !SERVER_NAME.test(serverName)) {
    notes.push(`${where} has no usable server name (${SERVER_NAME.source}), so it was not mounted`)
    return undefined
  }
  const id = boundedId(typeof value.id === 'string' && value.id.trim() !== '' ? value.id.trim() : serverName)
  if (id === undefined) {
    notes.push(`${where} declares an id longer than 80 characters, so it was not mounted`)
    return undefined
  }
  const args = value.args === undefined ? [] : stringArray(value.args, 4_096)
  if (args === undefined) {
    notes.push(`${where} declares arguments that are not an array of strings, so it was not mounted`)
    return undefined
  }
  const env = value.env === undefined ? {} : stringRecord(value.env)
  if (env === undefined) {
    notes.push(`${where} declares env values that are not strings, so it was not mounted`)
    return undefined
  }
  const headers = value.headers === undefined ? {} : stringRecord(value.headers)
  if (headers === undefined) {
    notes.push(`${where} declares header values that are not strings, so it was not mounted`)
    return undefined
  }
  const command = typeof value.command === 'string' ? value.command : ''
  const url = typeof value.url === 'string' ? value.url : ''
  const declaredTransport = value.transport === 'stdio' || value.transport === 'streamable-http' ? value.transport : undefined
  // Inferred rather than defaulted to stdio outright: the report's own fixture is
  // `{serverName, command}` with no `transport`, and a `url`-only entry is plainly
  // an HTTP server.
  const transport = declaredTransport ?? (url !== '' && command === '' ? 'streamable-http' : 'stdio')
  if (transport === 'stdio' && command.trim() === '') {
    notes.push(`${where} is a stdio server with no command, so it was not mounted`)
    return undefined
  }
  if (transport === 'streamable-http' && url.trim() === '') {
    notes.push(`${where} is an http server with no url, so it was not mounted`)
    return undefined
  }
  const declaredCwd = typeof value.cwd === 'string' ? value.cwd : ''
  return {
    id,
    enabled: value.enabled !== false,
    transport,
    serverName,
    command,
    args,
    env,
    cwd: declaredCwd === '' ? '' : resolveUnder(root, declaredCwd),
    url,
    headers,
  }
}

function skillRootFrom(value: unknown, index: number, root: string, notes: string[]): FreeCodeGoSkillRoot | undefined {
  const where = `skillRoots[${index}]`
  // A bare string is accepted because that is the shortest honest way to say
  // "this checkout keeps its skills in ./skills".
  const record = typeof value === 'string' ? { path: value } : value
  if (!isRecord(record)) {
    notes.push(`${where} is neither a path string nor an object, so it was not mounted`)
    return undefined
  }
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (path === '' || path.length > 4_096) {
    notes.push(`${where} has no usable path, so it was not mounted`)
    return undefined
  }
  const resolved = resolveUnder(root, path)
  const declaredId = typeof record.id === 'string' ? record.id.trim() : ''
  const id = declaredId === '' ? derivedId('skill-root', resolved) : boundedId(declaredId)
  if (id === undefined) {
    notes.push(`${where} declares an id longer than 80 characters, so it was not mounted`)
    return undefined
  }
  return { id, enabled: record.enabled !== false, path: resolved }
}

/**
 * Project one accepted project document into the entries a consumer can mount.
 *
 * Pure: the trust decision has already been made by the loader, and the workspace
 * root is passed in rather than read from the process, so this can be exercised
 * for any checkout. Nothing here throws and nothing here interprets a document
 * the whitelist did not already accept.
 *
 * @param result - the accepted keys and ignored names from `readProjectConfig`.
 * @param workspaceRoot - the repository the relative paths are resolved against.
 * @returns the mountable entries, the compiled project policy, and the notes.
 */
export function projectTierFrom(result: ProjectConfigReadResult, workspaceRoot: string): ProjectTier {
  const accepted = result.accepted
  const notes: string[] = []

  const rawServers = accepted.mcpServers
  const mcpServers: FreeCodeGoMcpServer[] = []
  if (rawServers !== undefined) {
    if (!Array.isArray(rawServers)) {
      notes.push('mcpServers is not an array, so no server was mounted')
    } else {
      if (rawServers.length > MAX_PROJECT_ENTRIES) {
        notes.push(`mcpServers declares ${rawServers.length} servers; only the first ${MAX_PROJECT_ENTRIES} were mounted`)
      }
      rawServers.slice(0, MAX_PROJECT_ENTRIES).forEach((entry, index) => {
        const server = mcpServerFrom(entry, index, workspaceRoot, notes)
        if (server !== undefined) mcpServers.push(server)
      })
    }
  }

  const rawRoots = accepted.skillRoots
  const skillRoots: FreeCodeGoSkillRoot[] = []
  if (rawRoots !== undefined) {
    if (!Array.isArray(rawRoots)) {
      notes.push('skillRoots is not an array, so no root was mounted')
    } else {
      if (rawRoots.length > MAX_PROJECT_ENTRIES) {
        notes.push(`skillRoots declares ${rawRoots.length} roots; only the first ${MAX_PROJECT_ENTRIES} were mounted`)
      }
      rawRoots.slice(0, MAX_PROJECT_ENTRIES).forEach((entry, index) => {
        const root = skillRootFrom(entry, index, workspaceRoot, notes)
        if (root !== undefined) skillRoots.push(root)
      })
    }
  }

  let policy: CompiledCommandPolicy | undefined
  if (accepted.permissionRules !== undefined) {
    // The compiler drops what it cannot use rather than throwing, but that is not the
    // same claim as this module's "never a throw", and the difference is the whole
    // tier: an unreadable document used to propagate out of here and take the MCP
    // servers and Skill roots this function had already parsed with it, because the
    // caller has no catch. `{"rules":[{"pattern":["git"],"match":5}]}` did exactly
    // that ("number 5 is not iterable"). The compiler now rejects that shape; this
    // catch is what keeps the promise true for the next one, and it reports rather
    // than swallowing — a repository whose rules silently stopped applying is a
    // worse outcome than a note in the settings surface.
    try {
      const compiled = compileCommandPolicy(accepted.permissionRules)
      const diagnostics = describePolicyDiagnostics(compiled.diagnostics)
      if (diagnostics !== '') notes.push(`permissionRules: ${diagnostics}`)
      if (compiled.rules.length > 0 || compiled.hostExecutables.size > 0) policy = compiled
    } catch (error) {
      notes.push(`permissionRules could not be compiled (${error instanceof Error ? error.message : String(error)}), so no project rule was applied`)
    }
  }

  return {
    mcpServers,
    skillRoots,
    ...(policy === undefined ? {} : { policy }),
    ...(accepted.hooks === undefined ? {} : { hooks: accepted.hooks }),
    notes,
  }
}
