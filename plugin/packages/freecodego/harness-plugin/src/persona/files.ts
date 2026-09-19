/**
 * Where a workspace's persona files are read from — once.
 *
 * Two consumers need the same answer: the `engineering_persona_list` tool, and
 * the `personas` section of the unified inspect report. The section was written
 * first and carried its own directory walk; a second walk for the tool would
 * have given the same word two sources, and the ways they can disagree are the
 * interesting ones — one gated on folder trust and the other not, one including
 * `.json` and the other only `.toml`, one reading the user tier and the other
 * forgetting it.
 *
 * Read directly here (rather than receiving already-read text) so the trust gate
 * is applied *before* the file is opened. A gate that refuses after parsing still
 * means an untrusted checkout's instructions were parsed by this process.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/persona/files
 */

import { join } from 'node:path'
import type { PersonaDefinition, PersonaIssue } from './contract.ts'
import { discoverPersonas, type PersonaFile } from './discovery.ts'

/** The project tier, relative to a workspace root. */
export const PROJECT_PERSONA_DIRECTORY = join('.freecodego', 'personas')

/** The two reads this module needs, injected so it stays testable without a disk. */
export interface PersonaFilePort {
  readonly readFile: (path: string) => Promise<string | undefined>
  readonly listDir: (path: string) => Promise<readonly string[]>
}

/** The effective roster plus what was shadowed or refused. */
export interface PersonaRoster {
  readonly personas: readonly PersonaDefinition[]
  readonly shadowed: readonly { readonly name: string; readonly sources: readonly string[] }[]
  readonly issues: readonly PersonaIssue[]
}

/** Personas are `.toml` (the documented subset) or `.json` (anything richer). */
const PERSONA_EXTENSIONS = ['.toml', '.json'] as const

/**
 * Read every persona file this workspace resolves and fold them into one roster.
 * @param input - the workspace, its trust decision, the user tier, and the reader.
 * @returns the effective roster, with shadowing and refusals.
 */
export async function loadPersonaRoster(input: {
  readonly workspaceRoot?: string | undefined
  /** Whether the workspace's own files may be read at all. */
  readonly trusted: boolean
  /** The user tier directory, usually under the freecodego data home. */
  readonly userDirectory: string
  /** Extra tiers a deployment composes, lowest precedence last. */
  readonly bundled?: readonly PersonaFile[]
  readonly port: PersonaFilePort
}): Promise<PersonaRoster> {
  const files: PersonaFile[] = []
  const collect = async (directory: string, source: 'project' | 'user'): Promise<void> => {
    for (const entry of await input.port.listDir(directory)) {
      if (!PERSONA_EXTENSIONS.some(extension => entry.endsWith(extension))) continue
      const path = join(directory, entry)
      const text = await input.port.readFile(path)
      if (text === undefined) continue
      files.push({ path, source, contents: text })
    }
  }
  if (input.workspaceRoot !== undefined && input.trusted) {
    await collect(join(input.workspaceRoot, PROJECT_PERSONA_DIRECTORY), 'project')
  }
  await collect(input.userDirectory, 'user')
  files.push(...input.bundled ?? [])
  const discovered = discoverPersonas(files, { projectTrusted: input.trusted })
  return {
    personas: discovered.personas,
    shadowed: discovered.shadowed.map(entry => ({ name: entry.name, sources: [...entry.sources] })),
    issues: discovered.issues,
  }
}
