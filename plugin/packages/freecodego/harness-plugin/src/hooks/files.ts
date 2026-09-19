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
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/hooks/files
 */

import type { HookDocument } from './surface.ts'

/** Hook files inside a workspace, in the order they are consulted. */
export const PROJECT_HOOK_FILES: readonly string[] = ['.freecodego/hooks.json', '.claude/settings.json', '.cursor/hooks.json']

/** Hook files under the user's home, in the order they are consulted. */
export const USER_HOOK_FILES: readonly string[] = ['.claude/settings.json', '.cursor/hooks.json']

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
}): Promise<readonly HookDocument[]> {
  const documents: HookDocument[] = []
  if (input.workspaceRoot !== undefined && input.trusted) {
    for (const relative of PROJECT_HOOK_FILES) {
      const text = await input.port.readFile(joinPath(input.workspaceRoot, relative))
      if (text === undefined) continue
      documents.push({ source: 'project', path: relative, value: parseHookJson(text) })
    }
  }
  for (const relative of USER_HOOK_FILES) {
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
