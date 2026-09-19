/**
 * The ten collectors, built from live plugin state.
 *
 * This is the layer that answers "where does each section's data actually come
 * from", kept apart from `collect.ts` (which owns isolation and rendering) and
 * from `index.ts` (which owns the plugin's own objects). Every dependency is an
 * injected port, which is what lets the whole surface be tested against a
 * fixture instead of a running Host.
 *
 * Two rules govern what a section may claim.
 *
 * **A section reads the plugin's existing answers, it does not re-derive them.**
 * Skills and MCP come from the capability registry's own snapshot, engines from
 * the runtime status objects, trust from the trust store's own resolution. A
 * second reader for any of these is how two surfaces start disagreeing about the
 * same fact — the problem this whole feature exists to avoid.
 *
 * **A file-backed section is gated on trust before it reads anything.** Hooks,
 * rules and personas all live in files a repository can write, so they go
 * through the project trust decision. Reading an untrusted checkout's
 * `.claude/settings.json` in order to *report* it would be a smaller version of
 * the bug the gate exists to prevent, and the report would then be a list of
 * instructions the repository authored. The `scan` section is the one exception,
 * and it is a difference in what it reads rather than an exemption: sizes and
 * path names, never content, because a byte count cannot carry an instruction.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/inspect/host
 */

import { join } from 'node:path'
import type { WorkspaceChangeScope } from '../engineering-quality.ts'
import { selectScanFiles, type ScanCandidate } from '../scan-selection.ts'
import { collectHookHandlers } from '../hooks/surface.ts'
import { loadPersonaRoster } from '../persona/files.ts'
import { loadHookDocuments } from '../hooks/files.ts'
import {
  collectHooksSection,
  collectRulesSection,
  collectScanSection,
  collectSkillsSection,
  type InspectCollector,
  type InspectSkillEntry,
  type JsonValue,
  type RuleSource,
} from './collect.ts'

/** The capability snapshot fields the inspect surface reads. */
export interface InspectCapabilitiesSnapshot {
  readonly skills: readonly { readonly name?: string; readonly id?: string; readonly description?: string; readonly source?: string; readonly invocation?: string }[]
  readonly mcpServers: readonly { readonly id?: string; readonly name?: string; readonly transport?: string; readonly enabled?: boolean; readonly command?: string; readonly url?: string }[]
  readonly mcpTools: readonly { readonly name: string; readonly description?: string }[]
  readonly mountErrors?: readonly { readonly id: string; readonly message: string }[]
  readonly trustRefusals?: readonly { readonly id: string; readonly message: string }[]
}

/** The folder-trust answer for one directory. */
export interface InspectTrustAnswer {
  readonly enabled: boolean
  readonly trusted: boolean
  readonly reason: string
  readonly root?: string
}

/** Everything the assembler needs, as narrow readers. */
export interface InspectHostPort {
  /** The active workspace, when there is one. */
  readonly workspace: () => string | undefined
  /** The user's home directory. */
  readonly home: () => string
  /** `$DSH_HOME`. */
  readonly dataHome: () => string
  /** The trust resolution for a directory. */
  readonly trust: (directory: string | undefined) => Promise<InspectTrustAnswer>
  /** The capability registry's own snapshot. */
  readonly capabilities: () => Promise<InspectCapabilitiesSnapshot>
  /** The sandbox profile in force and its deny enforcement state. */
  readonly sandbox: () => JsonValue
  /** Engine availability, from the runtime status objects. */
  readonly engines: () => JsonValue
  /** Read a file, returning undefined when it is absent or unreadable. */
  readonly readFile: (path: string) => Promise<string | undefined>
  /** List a directory's entry names, returning empty when it is absent. */
  readonly listDir: (path: string) => Promise<readonly string[]>
  /**
   * The workspace's uncommitted changes, or `undefined` when git cannot answer.
   *
   * The same reader the verification tier uses (`readWorkspaceChangeScope`), so
   * the scan section and the tier cannot disagree about what changed.
   */
  readonly changes: (workspace: string) => Promise<WorkspaceChangeScope | undefined>
  /**
   * The repository root `changes` reported its paths against.
   *
   * git reports changed paths relative to the **repository root**, not to the
   * directory it ran in, so sizing one means resolving it against this. Using the
   * session workspace instead is the bug this port exists to make impossible: on a
   * workspace that is a subdirectory of its repository every lookup misses, and a
   * missed lookup is indistinguishable from a size nobody could measure — which is
   * why the mistake was silent rather than loud.
   */
  readonly repositoryRoot: (workspace: string) => Promise<string | undefined>
  /**
   * The size of a path in bytes, or `undefined` when it cannot be judged.
   *
   * `undefined` is passed through rather than defaulted: the selection treats
   * "not measured" as an answer of its own, and a `0` here would erase it.
   */
  readonly fileSize: (path: string) => Promise<number | undefined>
}

/** Project-relative files that carry rules or project instructions. */
const PROJECT_RULE_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'AGENTS.local.md']

/** Project-relative directory of additional rule documents. */
const PROJECT_RULE_DIR = '.freecodego/rules'

/**
 * Build the nine collectors.
 * @param port - the narrow readers described above.
 * @returns the collectors, in an unspecified order (the report orders them).
 */
export function buildInspectCollectors(port: InspectHostPort): readonly InspectCollector[] {
  return [
    { id: 'trust', collect: async () => collectTrust(port) },
    { id: 'sandbox', collect: () => port.sandbox() },
    { id: 'skills', collect: async () => collectSkills(port) },
    { id: 'hooks', collect: async () => collectHooks(port) },
    { id: 'rules', collect: async () => collectRules(port) },
    { id: 'personas', collect: async () => collectPersonas(port) },
    { id: 'mcp', collect: async () => collectMcp(port) },
    { id: 'engines', collect: () => port.engines() },
    { id: 'scan', collect: async () => collectScan(port) },
  ]
}

/**
 * The scan section: which changed files a scan would cover, and why not the rest.
 *
 * Deliberately **not** trust-gated, unlike the other file-backed sections, and the
 * difference is what it reads: sizes and path names, never content. The gate
 * exists so a repository cannot author the instructions this process acts on, and
 * a byte count is not an instruction. Gating this section would remove the one
 * diagnostic that still works on a checkout that is not trusted — which is exactly
 * when a user wants to know what a scan would have touched.
 *
 * Nothing here opens a file. A path's size comes from the port, and a deletion is
 * never sized at all because it already left the denominator.
 */
async function collectScan(port: InspectHostPort): Promise<JsonValue> {
  const workspace = port.workspace()
  if (workspace === undefined) {
    return collectScanSection({ workspace, unavailable: 'no workspace is active for this report' })
  }
  const changes = await port.changes(workspace)
  if (changes === undefined) {
    return collectScanSection({ workspace, unavailable: "git could not report this workspace's changes" })
  }
  // Resolved rather than assumed. `changes` carries repository-root-relative paths,
  // so sizing them against the session workspace misses every file whenever that
  // workspace is a subdirectory of its repository — and because the selection treats
  // an unmeasured size as its own answer, the whole size ceiling then quietly stops
  // applying while the report still looks complete.
  const repository = await port.repositoryRoot(workspace)
  const base = repository ?? workspace
  const candidates: ScanCandidate[] = await Promise.all(changes.entries.map(async (entry) => {
    const bytes = entry.deleted ? undefined : await port.fileSize(join(base, entry.path))
    return {
      path: entry.path,
      deleted: entry.deleted,
      // Omitted rather than set to `undefined`, because `exactOptionalPropertyTypes`
      // distinguishes the two and so does the selection: "not measured" is an
      // answer of its own, and a present-but-undefined `bytes` would erase it.
      ...(bytes === undefined ? {} : { bytes }),
    }
  }))
  return collectScanSection({
    workspace,
    // Omitted rather than passed as `undefined`: "no repository root could be
    // resolved" and "here is the root" are different answers, and
    // `exactOptionalPropertyTypes` makes that distinction explicit rather than
    // incidental.
    ...(repository === undefined ? {} : { repository }),
    selection: selectScanFiles(candidates),
  })
}

/** The trust section: what the gate decided for this workspace, and why. */
async function collectTrust(port: InspectHostPort): Promise<JsonValue> {
  const workspace = port.workspace()
  const answer = await port.trust(workspace)
  return {
    enabled: answer.enabled,
    trusted: answer.trusted,
    reason: answer.reason,
    ...(answer.root === undefined ? {} : { root: answer.root }),
    ...(answer.enabled
      ? {}
      // Stated rather than left to the reader: with the gate off, `trusted: true`
      // is not a decision anyone made.
      : { note: 'the folder-trust gate is disabled in settings, so nothing is refused for being untrusted' }),
    workspace: workspace ?? null,
  }
}

/** The skills section, from the registry's own inventory. */
async function collectSkills(port: InspectHostPort): Promise<JsonValue> {
  const snapshot = await port.capabilities()
  const skills: InspectSkillEntry[] = snapshot.skills.map(skill => ({
    name: skill.name ?? skill.id ?? '(unnamed)',
    description: skill.description ?? '',
    source: skill.source ?? '(unknown)',
    invocation: skill.invocation ?? '(default)',
  }))
  return collectSkillsSection(skills)
}

/**
 * The hooks section.
 *
 * Reads handlers from the files this build knows about, then merges them the way
 * the dispatcher would, so the counts here are the counts a dispatch would see.
 * Project files are read only for a trusted workspace.
 */
async function collectHooks(port: InspectHostPort): Promise<JsonValue> {
  const workspace = port.workspace()
  const trust = await port.trust(workspace)
  const readable = trust.trusted && trust.enabled
  // The same discovery the runtime dispatches from — see `hooks/files.ts`. The
  // trust gate is applied inside it, before any project file is opened.
  const documents = await loadHookDocuments({
    workspaceRoot: workspace,
    trusted: readable,
    home: port.home(),
    port: { readFile: async target => await port.readFile(target) },
  })
  const merged = collectHookHandlers(documents)
  return {
    ...(collectHooksSection(merged.handlers, merged.warnings) as Record<string, JsonValue>),
    files: documents.map(document => document.path),
    // The one thing a reader cannot infer from an empty list.
    projectFilesSkipped: workspace !== undefined && !readable,
  }
}

/**
 * The rules section, with token counts from the shared estimator.
 *
 * Project rule files are instructions a repository wrote, so the trust gate runs
 * **before the first read**, not on the result. Gating afterwards would still
 * have opened the file, and the byte count and token count this section reports
 * would already be derived from untrusted content.
 */
async function collectRules(port: InspectHostPort): Promise<JsonValue> {
  const workspace = port.workspace()
  const trust = await port.trust(workspace)
  const sources: RuleSource[] = []
  if (workspace !== undefined && trust.trusted && trust.enabled) {
    for (const relative of PROJECT_RULE_FILES) {
      const text = await port.readFile(`${workspace}/${relative}`)
      if (text === undefined) continue
      sources.push({ path: `${workspace}/${relative}`, source: 'project', text })
    }
    for (const entry of await port.listDir(`${workspace}/${PROJECT_RULE_DIR}`)) {
      if (!entry.endsWith('.md')) continue
      const text = await port.readFile(`${workspace}/${PROJECT_RULE_DIR}/${entry}`)
      if (text === undefined) continue
      sources.push({ path: `${workspace}/${PROJECT_RULE_DIR}/${entry}`, source: 'project', text })
    }
  }
  return collectRulesSection(sources)
}

/**
 * The personas section: the effective roster plus what was shadowed or refused.
 *
 * The walk lives in `persona/files.ts` because the `engineering_persona_list`
 * tool answers the same question; the trust gate is applied inside that loader,
 * before any project file is opened, so a report cannot be the thing that parses
 * an untrusted checkout's instructions.
 */
async function collectPersonas(port: InspectHostPort): Promise<JsonValue> {
  const workspace = port.workspace()
  const trust = await port.trust(workspace)
  const discovered = await loadPersonaRoster({
    workspaceRoot: workspace,
    trusted: trust.trusted && trust.enabled,
    userDirectory: `${port.dataHome()}/freecodego/personas`,
    port: {
      readFile: async target => await port.readFile(target),
      listDir: async target => await port.listDir(target),
    },
  })
  return {
    count: discovered.personas.length,
    entries: discovered.personas.map(persona => ({
      name: persona.name,
      description: persona.description,
      source: persona.source,
      isolation: persona.defaultIsolation ?? 'none',
      inputs: persona.inputs.length,
      outputs: persona.outputs.length,
    })),
    shadowed: discovered.shadowed.map(entry => ({ name: entry.name, sources: [...entry.sources] })),
    issues: discovered.issues.map(issue => ({ path: issue.path, reason: issue.reason })),
  }
}

/** The MCP section, from the registry's snapshot and its mount bookkeeping. */
async function collectMcp(port: InspectHostPort): Promise<JsonValue> {
  const snapshot = await port.capabilities()
  return {
    servers: snapshot.mcpServers.map(server => ({
      id: server.id ?? server.name ?? '(unnamed)',
      enabled: server.enabled !== false,
      transport: server.transport ?? (server.url === undefined ? 'stdio' : 'http'),
    })),
    tools: snapshot.mcpTools.map(tool => tool.name),
    // Both failure lists are reportable states rather than errors: a server that
    // could not be mounted, and one that was refused because the folder is not
    // trusted, need to be distinguishable.
    mountErrors: (snapshot.mountErrors ?? []).map(entry => ({ id: entry.id, message: entry.message })),
    trustRefusals: (snapshot.trustRefusals ?? []).map(entry => ({ id: entry.id, message: entry.message })),
  }
}
