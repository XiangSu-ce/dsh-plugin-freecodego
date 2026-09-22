/**
 * Where hook documents are read from — once, for both consumers.
 *
 * Two things need the same answer: the runtime that dispatches hooks, and the
 * `hooks` section of the inspect report. The section was written first and
 * carried its own list of files; a second copy for the runtime would have made
 * "which hooks are loaded?" a question with two answers, and the interesting
 * failures are exactly where they differ — one gated on folder trust and the
 * other not, one listing `.cursor/hooks.json` and the other forgetting it, one
 * reading the user tier and the other only the project's.
 *
 * The gate runs **before the read**: an untrusted checkout's `.claude/settings.json`
 * is a file the repository controls, and a hook is a command this process will
 * run, so it must not be opened — let alone parsed — on the strength of a
 * directory listing.
 *
 * One file is read by two systems
 * -------------------------------
 * `.claude/settings.json` is also what the Harness's own bridge reads
 * (`@deepseek-ai/dsh-hooks-claude-code`; `hooks-claude-code/src/config.ts` parses
 * the very same event→matcher-group shape). Both systems *run the command*, so a
 * composition that mounts both reads one file twice and every hook in it fires
 * twice — the same side effect with two authors, which no record can distinguish
 * from two hooks. The Harness's bridge is the native one, so it keeps the file:
 * when a row mounting it is present the Claude dialect is served by the Harness
 * and this reader leaves `.claude/settings.json` to it, keeping the two dialects
 * no Harness package parses (`.freecodego/hooks.json`, `.cursor/hooks.json`).
 * Neither side is silent about it — see the `hooks` section of the inspect report,
 * which names the owner of the dialect instead of quietly listing fewer files.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/hooks/files
 */

import type { HookDocument } from './surface.ts'

/** Hook files inside a workspace, in the order they are consulted. */
export const PROJECT_HOOK_FILES: readonly string[] = ['.freecodego/hooks.json', '.claude/settings.json', '.cursor/hooks.json']

/** Hook files under the user's home, in the order they are consulted. */
export const USER_HOOK_FILES: readonly string[] = ['.claude/settings.json', '.cursor/hooks.json']

/**
 * The one entry in both lists the Harness's own bridge also reads.
 *
 * Named rather than spelled twice: the same literal appears in two lists above,
 * and a stand-down that filtered only one of them would keep firing the user-tier
 * copy of every project hook while the report said the dialect had been handed over.
 */
export const CLAUDE_DIALECT_FILE = '.claude/settings.json'

/** The Harness package that owns the Claude Code dialect when it is mounted. */
export const HARNESS_CLAUDE_HOOK_BRIDGE = 'dsh-hooks-claude-code'

/**
 * The same package under its published name, for text a user reads.
 *
 * Separate from {@link HARNESS_CLAUDE_HOOK_BRIDGE} because the two answer
 * different questions: matching compares basenames (a row may be aliased), while a
 * message has to name something the user can search for in their profile.
 */
export const HARNESS_CLAUDE_HOOK_BRIDGE_PACKAGE = '@deepseek-ai/dsh-hooks-claude-code'

/**
 * Who parses the Claude dialect — this reader, or the Harness's own bridge.
 *
 * `'harness'` means the file is still read and still run, by a row the user
 * mounted; it is not "hooks are off".
 */
export type ClaudeHookDialectOwner = 'plugin' | 'harness'

/**
 * Whether one of the mounted rows is the Harness's Claude Code bridge.
 *
 * Matched on the package's basename rather than its full name, because the same
 * module is reachable under more than one spelling in a composition: the row can
 * name `@deepseek-ai/dsh-hooks-claude-code`, a bundle alias, or the id alone. What
 * every spelling shares is `dsh-hooks-claude-code`, and a comparison against the
 * full scoped name would miss the aliased case and let the file be read twice —
 * exactly the failure this stands down for.
 *
 * Fail-open in the direction that keeps the user's hooks running: an unmounted or
 * unreadable loader answers `false`, which leaves this reader in charge of the
 * file rather than dropping rules nobody else would run.
 * @param mountedPackageNames - the names of the currently mounted rows.
 * @returns true when the Harness's bridge is the Claude dialect's owner.
 */
export function harnessOwnsClaudeHookFiles(mountedPackageNames: Iterable<string>): boolean {
  for (const raw of mountedPackageNames) {
    const base = String(raw).split('/').pop() ?? ''
    if (base === HARNESS_CLAUDE_HOOK_BRIDGE) return true
  }
  return false
}

/**
 * The same question, asked of a Loader instance.
 *
 * The plugin reads the answer off the Loader rather than off a bundle name,
 * because the bridge is in no bundle: the profiles that mount it insert the row
 * themselves, so "is the package currently started" is the only question whose
 * answer matches what will actually run.
 *
 * A pure function so the fail-open rules can be tested without a Host, and
 * fail-open is the direction that keeps a user's own files running: an absent
 * Loader, one that cannot be enumerated, and a row whose name is not a string all
 * answer `'plugin'`, which never drops rules that nobody else would run. The two
 * wrong answers are not symmetric — claiming the Harness runs a file it never
 * loaded is a hook that silently stops existing.
 * @param loader - the `loader` service, or whatever the host returned for it.
 * @returns the owner of the Claude dialect.
 */
export function claudeHookDialectOf(loader: unknown): ClaudeHookDialectOwner {
  const entries = (loader as { entries?: unknown } | undefined)?.entries
  if (typeof entries !== 'function') return 'plugin'
  try {
    const names: string[] = []
    for (const entry of (entries as () => Iterable<{ readonly options?: { readonly name?: unknown } }>).call(loader)) {
      const name = entry?.options?.name
      if (typeof name === 'string') names.push(name)
    }
    return harnessOwnsClaudeHookFiles(names) ? 'harness' : 'plugin'
  } catch {
    return 'plugin'
  }
}

/**
 * The files one tier consults, minus the one another system owns.
 * @param files - the tier's list, in precedence order.
 * @param owner - who owns the Claude dialect.
 * @returns the files this reader should open.
 */
function filesFor(files: readonly string[], owner: ClaudeHookDialectOwner): readonly string[] {
  return owner === 'harness' ? files.filter(file => file !== CLAUDE_DIALECT_FILE) : files
}

/** The one read this module needs. */
export interface HookFilePort {
  readonly readFile: (path: string) => Promise<string | undefined>
}

/**
 * Parse a JSON document, or hand the parser something it will refuse.
 *
 * A file that is not JSON is passed through as a string rather than dropped: the
 * dialect parser then reports "hooks must be an object or an array" against the
 * file's path, which is a warning the user can act on. Dropping it here would
 * make a malformed settings file look like an empty one.
 * @param text - the file's contents.
 * @returns the parsed value, or the raw text so the refusal names the file.
 */
export function parseHookJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Read every hook document this build knows about.
 * @param input - the workspace, its trust decision, the home directory, and the reader.
 * @returns the documents, each with its provenance, in precedence order.
 */
export async function loadHookDocuments(input: {
  readonly workspaceRoot?: string | undefined
  /** Whether the workspace's own files may be read at all. */
  readonly trusted: boolean
  readonly home: string
  readonly port: HookFilePort
  /**
   * Who owns `.claude/settings.json` — see {@link harnessOwnsClaudeHookFiles}.
   *
   * Required rather than defaulted, deliberately. A default would answer the
   * question silently for the next caller, and the two wrong answers are not
   * symmetric: `'plugin'` re-runs hooks another row is already running, and
   * `'harness'` claims the Harness runs files it may never have loaded. Both are
   * invisible in a hook's own output, so the caller states it.
   */
  readonly claudeDialect: ClaudeHookDialectOwner
}): Promise<readonly HookDocument[]> {
  const documents: HookDocument[] = []
  if (input.workspaceRoot !== undefined && input.trusted) {
    for (const relative of filesFor(PROJECT_HOOK_FILES, input.claudeDialect)) {
      const text = await input.port.readFile(joinPath(input.workspaceRoot, relative))
      if (text === undefined) continue
      documents.push({ source: 'project', path: relative, value: parseHookJson(text) })
    }
  }
  for (const relative of filesFor(USER_HOOK_FILES, input.claudeDialect)) {
    const text = await input.port.readFile(joinPath(input.home, relative))
    if (text === undefined) continue
    documents.push({ source: 'global', path: `~/${relative}`, value: parseHookJson(text) })
  }
  return documents
}

/**
 * Join a root with a forward-slashed relative path.
 *
 * Deliberately not `path.join`: the relative paths in the two lists above are the
 * ones a hook file's own `path` field is reported with, and the inspect report
 * shows that field to a user who is looking for the file to edit. A backslash on
 * Windows would be a path they cannot paste anywhere.
 * @param root - the directory.
 * @param relative - the forward-slashed relative path.
 * @returns the joined path.
 */
function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/u, '')}/${relative}`
}
