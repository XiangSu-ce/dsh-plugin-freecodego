import { redactCredentialShapes } from './secret-scan.ts'
import type { JsonValue } from './types.ts'

/**
 * The project tier of FreeCodeGo configuration.
 *
 * What this tier is for
 * ---------------------
 * A repository often knows something the user cannot: which MCP server speaks to
 * its own staging environment, which Skill roots it ships, which tool calls its
 * workflow needs allowed. Letting the repository say so removes a per-clone setup
 * step, and that is the entire benefit.
 *
 * Why it is a whitelist and not "settings, but in the repo"
 * ---------------------------------------------------------
 * That benefit is bought with a real hazard: the file is written by whoever
 * authored the repository, and it is read by a process running as the user. A
 * project tier that accepted any FreeCodeGo setting would therefore let a cloned
 * repository choose the user's default model, disable their guards, or point their
 * credential handling somewhere else — reachable by `git clone`, with the user
 * never having opened a file. The tier is consequently limited to keys that
 * *describe the repository's own content* rather than the user's environment:
 *
 * | key | what the repository may say | why it is safe to accept |
 * |---|---|---|
 * | `mcpServers` | which servers this checkout wants | they run only in a repository the user trusted (see `trust.ts`), and the gate is asked before they are mounted |
 * | `skillRoots` | which directories hold this repo's skills | same gate; skills are content the repository already ships |
 * | `permissionRules` | which of the repo's own commands are allowed | narrows the allow-list for one checkout rather than granting a new capability |
 * | `hooks` | which of this repo's scripts run on lifecycle events | same gate; hooks are what the repository would otherwise ask the user to wire by hand |
 *
 * Everything else is ignored, and the ignored names are *reported* rather than
 * silently dropped: a repository that wrote `defaultModel` in good faith needs to
 * be told why nothing happened, or its author will conclude the whole tier is
 * broken.
 *
 * The whitelist is deliberately not configurable. A setting that could widen it is
 * the same hazard one indirection away.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/project-config
 */

/** Path of the project tier inside a workspace, relative to the repository root. */
export const PROJECT_CONFIG_RELATIVE_PATH = '.freecodego/config.json'

/**
 * The keys a repository may set, and the complete set of them.
 *
 * Exported because both the parser and the settings surface need one description
 * of this contract; a surface that listed a different set would be a second
 * whitelist, and the looser of the two would be the one that mattered.
 */
export const PROJECT_CONFIG_WHITELIST = ['mcpServers', 'skillRoots', 'permissionRules', 'hooks'] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_WHITELIST)[number]

/** The outcome of reading one project document. */
export interface ProjectConfigReadResult {
  /**
   * The accepted keys and their values; absent keys stay absent.
   *
   * `JsonValue` rather than `unknown` because this shape is what
   * `projectConfigReport` hands the settings surface: the Typert contract
   * generator refuses to build a schema for unconstrained data, so an `unknown`
   * field here fails `build:lib:host` at the contract step. The document is still
   * parsed defensively — this is the wire shape, not a promise about the file.
   */
  readonly accepted: Readonly<Partial<Record<ProjectConfigKey, JsonValue>>>
  /** Keys the document set that this tier does not accept, in document order. */
  readonly ignored: readonly string[]
  /** Why the document was not fully used, when it was not; for the settings surface. */
  readonly note?: string
}

/**
 * One workspace's project tier, as the settings surface reports it.
 *
 * The report is the tier's only user-visible half, and it carries the trust
 * answer because the two are one question to the reader: "why did nothing I
 * wrote take effect" is answered by the gate's reason, by the accepted keys, or
 * by `ignored` — and a surface that showed only the accepted keys would leave a
 * repository author who wrote `defaultModel` with no way to tell a broken tier
 * from a typo in a key name.
 *
 * `trusted` is a snapshot, not a promise: the gate can be granted or revoked
 * while the report is on screen, which is why the reason travels with the
 * boolean rather than being looked up again by the reader.
 */
export interface ProjectConfigReport extends ProjectConfigReadResult {
  /** The workspace the report is about, as the caller named it. */
  readonly workspaceRoot: string
  /** Whether the folder-trust gate admits this repository's own content. */
  readonly trusted: boolean
  /** Why the gate answered as it did, in the gate's own words. */
  readonly trustReason: string
  /**
   * The file the tier is read from, relative to the workspace.
   *
   * Carried rather than re-derived by the reader: the settings surface runs in a
   * browser and cannot import a Host constant, so a surface that spelled the path
   * itself would be a second copy of it — and the copy that drifted would be the
   * one the user was told to edit.
   */
  readonly path: string
  /**
   * The keys the tier accepts, in the order the whitelist declares them.
   *
   * Carried for the same reason as {@link path}, and for one more: a surface that
   * listed a different set would be a second whitelist, and the looser of the two
   * would be the one a repository author believed.
   */
  readonly whitelist: readonly ProjectConfigKey[]
}

/**
 * Read a project document from its text.
 *
 * Pure so the parser can be exercised without a filesystem, and so a caller cannot
 * accidentally read the file before deciding whether the repository is trusted —
 * the trust decision is an argument to the loader, not a step inside this function.
 * @param text - the file's contents, or `undefined` when it does not exist.
 * @returns the accepted keys, the ignored names, and a note when something was set aside.
 */
export function readProjectConfig(text: string | undefined): ProjectConfigReadResult {
  // Absent and unreadable are the same answer here, and neither is an error: a
  // repository without a project tier is the common case, and it must not produce
  // a diagnostic the user has to dismiss.
  if (text === undefined || text.trim() === '') return { accepted: {}, ignored: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // Reported rather than thrown: a typo in a checked-in file must not stop the
    // host from booting, and the author still needs to hear about it.
    // Masked: a parse failure quotes the first ten characters of the text it
    // failed on, and this file is checked into a repository — the same file a
    // team shares. Ten characters cannot carry a prefixed key; the masking is
    // here for the shapes that fit inside that window.
    return { accepted: {}, ignored: [], note: `${PROJECT_CONFIG_RELATIVE_PATH} is not valid JSON: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { accepted: {}, ignored: [], note: `${PROJECT_CONFIG_RELATIVE_PATH} must be a JSON object` }
  }
  const accepted: Partial<Record<ProjectConfigKey, JsonValue>> = {}
  const ignored: string[] = []
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const allowed = (PROJECT_CONFIG_WHITELIST as readonly string[]).includes(key)
    if (!allowed) {
      ignored.push(key)
      continue
    }
    // `null` reads as "unset" rather than as a value: a repository that writes
    // `"mcpServers": null` means "this checkout has none", and handing `null` to a
    // consumer expecting an array is how that becomes a crash instead.
    if (value === null || value === undefined) continue
    // `JSON.parse` cannot produce a value outside `JsonValue`, so this cast
    // records a fact about where `value` came from rather than asserting one on
    // the document's behalf — the document is still untrusted, and nothing here
    // interprets it.
    accepted[key as ProjectConfigKey] = value as JsonValue
  }
  // `ignored` is always reported, empty or not: the field is required, and the
  // sentence that used to sit here compared a length to choose between two
  // identical objects — a branch that could never run, which reads as though an
  // empty `ignored` were reported differently. It is not, and callers already
  // read the note and the field rather than the length.
  return { accepted, ignored }
}

/**
 * Read the project tier for a workspace, honouring the folder-trust gate.
 *
 * The gate is asked *before* the file is opened. Reading first and deciding after
 * would mean an untrusted repository's document had already been parsed and, in any
 * caller that logs or caches the result, retained — the point of the gate is that
 * untrusted content never enters the process, not that it enters and is then
 * ignored.
 * @param input - the workspace root, the trust decision for it, and a file reader.
 * @returns the accepted keys, and a note naming the gate when it refused.
 */
export async function loadProjectConfig(input: {
  readonly root: string
  readonly trusted: { readonly trusted: boolean; readonly reason: string }
  readonly read: (path: string) => Promise<string | undefined>
}): Promise<ProjectConfigReadResult> {
  if (!input.trusted.trusted) {
    return { accepted: {}, ignored: [], note: `project configuration skipped: ${input.trusted.reason}` }
  }
  const path = `${input.root.replace(/[\\/]+$/u, '')}/${PROJECT_CONFIG_RELATIVE_PATH}`
  const text = await input.read(path).catch(() => undefined)
  return readProjectConfig(text)
}
