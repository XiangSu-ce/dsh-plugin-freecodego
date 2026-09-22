/**
 * The tool names this package registers, discovered from its own source text.
 *
 * Discovered rather than imported because the names are registration literals
 * spread across the modules that own them, and several definitions are constants
 * referenced by name. A table that cited itself would prove nothing, so the module
 * that declares the manifest is *excluded* from the sweep: `tool-manifest.ts`
 * quoting `'engineering_status'` is not evidence that `engineering_status` exists.
 * Everything else under `src` is read.
 *
 * `tests/support/source-files.ts` is what reads the tree, for the reason that
 * module gives — a second copy of the walk would be the same duplication these
 * gates exist to find, one level up.
 */

import { sourceFiles } from './source-files.ts'

/** One discovered name, with the module a reviewer would open to see it. */
export interface RegisteredTool {
  /** The name as the model would receive it. */
  readonly name: string
  /** Path relative to `src`, forward-slashed. */
  readonly site: string
}

/** The module that holds the manifest, which cannot be evidence about itself. */
const MANIFEST_MODULE = 'tool-manifest.ts'

/** Prefixes that identify a name this plugin registers. */
const PLUGIN_PREFIXES: readonly string[] = ['engineering_', 'advisor_', 'agnes_', 'freecodego_', 'headroom_']

/**
 * Prefixed string literals that are deliberately *not* tool names.
 *
 * Enumerated rather than pattern-matched, so a new one has to be a decision
 * someone wrote down instead of a name the probe quietly skipped. Each entry says
 * where it comes from, because that is what makes it checkable.
 */
export const NOT_TOOLS: Readonly<Record<string, string>> = {
  // A model id in the evaluation corpus, not a tool.
  agnes_video_v3: 'a media model id in engineering-eval.ts',
  // MCP tool names offered to the native engines, which never pass through the
  // plugin's tool registry and so are not the manifest's subject.
  freecodego_skill_discover: 'an MCP tool name rendered for the Claude runtime',
  freecodego_skill_load: 'an MCP tool name rendered for the Claude runtime',
  // A Harness tool that `deferred-tools.ts` carries in a registration-shaped record
  // so its own rules can read it — the entry point that must never be deferred. This
  // package does not register it, so it is not the manifest's subject either; it was
  // exempted here while it also sat on the Plan Mode allow list, where the entry was
  // inert, and the exemption kept it discoverable-and-unclassified after that entry
  // went away with the hand-written list.
  tool_search: 'a Harness tool (deferred tool schemas), not one this plugin registers',
}

/**
 * Every name this package registers, with where it was found.
 *
 * Three passes, because one shape is invisible to the others:
 *
 *  - a plugin-prefixed literal, which is how almost every tool is defined;
 *  - `name: SOME_CONSTANT`, resolved back to that constant's initializer, which is
 *    how a tool whose name is shared with other code is defined;
 *  - `name: 'a_literal',`, the registration shape for a name with **no** plugin
 *    prefix — the shape that made `inspect`, `spill_recall` and `read_document`
 *    reachable while planning because no prefix-driven rule could see them.
 *
 * @returns the names, sorted, each with the first module it was seen in.
 */
export async function registeredTools(): Promise<readonly RegisteredTool[]> {
  const files = (await sourceFiles()).filter(file => file.path !== MANIFEST_MODULE)
  const found = new Map<string, string>()
  const remember = (name: string, site: string): void => {
    if (NOT_TOOLS[name] === undefined && !found.has(name)) found.set(name, site)
  }
  const prefixPattern = new RegExp(`'((?:${PLUGIN_PREFIXES.join('|')})[a-z0-9_]+)'`, 'gu')
  for (const file of files) {
    for (const match of file.text.matchAll(prefixPattern)) {
      // `noUncheckedIndexedAccess`: a capture group is possibly absent by type, and
      // this pattern always captures, so an absent one would mean the pattern changed.
      if (match[1] !== undefined) remember(match[1], file.path)
    }
  }
  for (const file of files) {
    for (const match of file.text.matchAll(/^\s+name: ([A-Z][A-Z0-9_]*),/gmu)) {
      const constant = match[1]
      if (constant === undefined) continue
      const definition = new RegExp(`(?:export )?const ${constant} = '([a-z0-9_]+)'`, 'u').exec(file.text)
      if (definition?.[1] !== undefined) remember(definition[1], file.path)
    }
  }
  for (const file of files) {
    for (const match of file.text.matchAll(/^\s+name: '([a-z0-9_]+)',/gmu)) {
      if (match[1] !== undefined) remember(match[1], file.path)
    }
  }
  return [...found].map(([name, site]) => ({ name, site })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/** The discovered names alone, sorted. */
export async function registeredToolNames(): Promise<readonly string[]> {
  return (await registeredTools()).map(tool => tool.name)
}

/** `name (site), name (site)` — a failure message a reader can act on. */
export function describeTools(tools: readonly RegisteredTool[]): string {
  return tools.map(tool => `${tool.name} (${tool.site})`).join(', ')
}
