/**
 * User-managed MCP and Skill capability inventory for the FreeCodeGo bundle.
 *
 * The Host owns outbound MCP connections and filesystem discovery. Native
 * engines receive only a redacted configuration snapshot and route Claude
 * calls back through this inventory, so browser configuration never becomes a
 * direct worker capability.
 */

import { randomUUID } from 'node:crypto'
import type { FreeCodeGoSettingsPort } from './policy.ts'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { redactCredentialShapes } from './secret-scan.ts'
import { asRecord as plainRecord } from './untrusted-json.ts'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { apply as applyMcpClient } from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import { apply as applySkillFilesystem } from '@deepseek-ai/dsh-skill-filesystem'
import type { FreeCodeGoCapabilitySettings, FreeCodeGoCapabilitySnapshot, FreeCodeGoMcpServer, FreeCodeGoModelCategory, FreeCodeGoSkillDetail, FreeCodeGoSkillEntry, FreeCodeGoSkillForward, FreeCodeGoSkillRoot } from './types.ts'
import { listSkillCompanionFiles, readSkillCompanionFile, skillForwardTargets, skillResourceLocation, type SkillCompanionFs } from './skill-detail.ts'
import { omitRecordKey } from './record-utils.ts'

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
/** Kebab-case Skill name, the same shape the registry accepts. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_CONFIGURED_SERVERS = 24
const MAX_CONFIGURED_ROOTS = 24
/** Browser-visible marker that preserves a saved secret during an edit without revealing it. */
export const MCP_SECRET_REDACTED = '__FREECODEGO_MCP_SECRET_REDACTED__'

/**
 * Largest attachment this bridge will inline as image bytes.
 *
 * Stored images are already normalized to a 4 MiB target, but a model transport
 * caps one image at 5 MB *after* base64 expansion, which is 4/3 of the raw size.
 * 3 MiB leaves headroom on every hop.
 */
export const INLINE_IMAGE_MAX_BYTES = 3 * 1024 * 1024


/**
 * Replace `{type:'image', attachment}` blocks with inline image bytes.
 *
 * A Harness tool result carries an image as a *reference* to durable attachment
 * storage. Native engine transports hand their tool results to the model as MCP
 * content, which can carry an image only as base64 bytes — so without this step
 * a generated image reaches a native engine as an attachment id inside text, and
 * neither the model nor the transcript renders it.
 *
 * Every failure keeps the original block: a missing reader, an unreadable id, an
transport that cannot carry bytes, or a file over {@link INLINE_IMAGE_MAX_BYTES}
 * all fall back to the reference. A lost render must never turn a successful
 * generation into a failed tool call.
 *
 * @param content - the tool result's content blocks.
 * @param read - reads one attachment's stored bytes, or `undefined` when unavailable.
 * @returns the same blocks, with readable image attachments inlined.
 */
export async function inlineImageAttachmentBlocks(
  content: readonly unknown[],
  read: (attachment: Readonly<Record<string, unknown>>) => Promise<Uint8Array | undefined>,
): Promise<readonly unknown[]> {
  return await Promise.all(content.map(async (block) => {
    const candidate = plainRecord(block)
    if (candidate.type !== 'image') return block
    const attachment = plainRecord(candidate.attachment)
    const mediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : ''
    if (typeof attachment.attachmentId !== 'string' || mediaType === '') return block
    let bytes: Uint8Array | undefined
    try {
      bytes = await read(attachment)
    } catch {
      // An unreadable attachment is a missing render, never a failed call.
      return block
    }
    if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength > INLINE_IMAGE_MAX_BYTES) return block
    return { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: mediaType }
  }))
}

function callId(value: string): never { return value as never }
/**
 * The capability view a native worker is handed before a session opens.
 *
 * Flat and already filtered, because the worker runs in another process and cannot
 * ask the Host whether Skills are enabled: an empty `skillRoots` here is how a
 * disabled switch reaches it.
 */
export type NativeCapabilityConfiguration = {
  readonly mcpEnabled: boolean
  readonly skillEnabled: boolean
  readonly skillRoots: readonly string[]
  readonly mcpTools: readonly ToolSchema[]
  readonly harnessTools: readonly ToolSchema[]
}

/** Schema kept in the FreeCodeGo settings namespace; settings snapshots never contain runtime handles. */
export const FreeCodeGoCapabilitySettingsSchema = z.object({
  mcpEnabled: z.boolean().default(false),
  skillEnabled: z.boolean().default(false),
  voiceInputEnabled: z.boolean().default(true),
  sessionDeleteEnabled: z.boolean().default(true),
  modelCategories: z.dict(z.union([z.const('text'), z.const('image'), z.const('video'), z.const('audio')])).default({}),
  mcpServers: z.array(z.object({
    id: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    transport: z.union([z.const('stdio'), z.const('streamable-http')]),
    serverName: z.string().pattern(SERVER_NAME),
    command: z.string().default(''),
    args: z.array(z.string().max(4096)).default([]),
    env: z.dict(z.string()).default({}),
    cwd: z.string().default(''),
    url: z.string().default(''),
    headers: z.dict(z.string()).default({}),
  })).default([]),
  skillRoots: z.array(z.object({
    id: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    path: z.string().min(1).max(4096),
  })).default([]),
  skillInvocationOverrides: z.dict(z.boolean()).default({}),
  // Declared without a default, the way `Config`'s optional fields are: schemastery
  // has no optional-object spelling, and an absent key *is* the answer here — no
  // preference, which means the community root. A default would have to invent a
  // placement on every install that never chose one.
  //
  // `null` is the *clear*, and it is here because a settings write is a **merge**
  // (`mergeLayers` in the settings service: plain objects merge recursively, other
  // values replace, and `undefined` entries are stripped so that "a sparse patch cannot
  // erase lower keys"). Omitting the field therefore cannot remove a stored preference —
  // the live harness proved it — so clearing has to say so with a value.
  preferredSkillPlacement: z.union([
    z.object({
      agent: z.union([z.const('harness'), z.const('agents')]),
      scope: z.union([z.const('project'), z.const('user')]),
    }),
    z.const(null),
  ]),
}) as z<FreeCodeGoCapabilitySettings>

type Fiber = { dispose(): Promise<void> }

/**
 * One discovered Skill before any invocation policy is applied.
 *
 * Derived from the service the cordis `Context` augmentation installs rather
 * than imported from `@deepseek-ai/dsh-skill`: that package is not a dependency
 * of this one, and the augmentation already puts its types in the program.
 */
type DiscoveredSkill = Awaited<ReturnType<Context['skills']['snapshot']>>['skills'][number]

/** Which provider families a reconcile must tear down and remount. */
type ReconcileChanges = { readonly mcp: boolean; readonly skill: boolean }

/**
 * The folder-trust question asked per configured entry.
 *
 * Injected rather than imported so this registry stays a pure mount/unmount
 * owner: it never learns where the grant record lives, and a test can drive
 * every branch without touching a real home directory. The answer is asked per
 * entry because trust is per repository — a machine-wide Skill root and a root
 * committed inside a checkout are not the same risk even in one settings
 * document.
 * @param directory - the directory the entry operates in.
 * @returns whether repository-supplied content there may be mounted, and why not.
 */
export type ProjectScopeTrust = (directory: string) => Promise<{ readonly trusted: boolean; readonly reason: string }>

/**
 * The repository-declared entries a reconcile mounts beside the user's own.
 *
 * A value rather than a settings read, because these entries are not the user's
 * settings: they come from the project tier and never enter the settings
 * document, the snapshot, or the settings surface's own inventory. Ids are
 * namespaced by `project-tier.ts`, so the two inventories cannot collide.
 */
export interface ProjectCapabilityEntries {
  readonly mcpServers: readonly FreeCodeGoMcpServer[]
  readonly skillRoots: readonly FreeCodeGoSkillRoot[]
}

const NO_PROJECT_ENTRIES: ProjectCapabilityEntries = { mcpServers: [], skillRoots: [] }

/** Keeps dynamically mounted MCP and Skill providers aligned with durable user settings. */
export class FreeCodeGoCapabilityRegistry {
  private readonly mcpFibers = new Map<string, Fiber>()
  private readonly mountErrors = new Map<string, string>()
  /**
   * Entries refused by the folder-trust gate, keyed like {@link mountErrors}.
   *
   * Kept apart from `mountErrors` because the two need opposite retry
   * treatment: a mount failure is worth retrying on the next settings change,
   * while a refusal is a standing decision and must not make the family look
   * permanently incomplete — otherwise every unrelated settings write would tear
   * down and remount providers that are working.
   */
  private readonly trustRefusals = new Map<string, string>()
  private skillFiber: Fiber | undefined
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  /**
   * Ids the last reconcile read out of the project tier.
   *
   * Held so `mcpMountIncomplete` / `skillMountIncomplete` cover the repository's
   * entries too: a project-declared server whose first mount failed has to be
   * retried on the next settings write exactly as a user-declared one is, or the
   * retry rule would hold for half of one inventory.
   */
  private projectInventory: ProjectCapabilityEntries = NO_PROJECT_ENTRIES

  constructor(
    private readonly ctx: Context,
    private readonly settings: FreeCodeGoSettingsPort | undefined,
    private readonly projectScopeTrust: ProjectScopeTrust = async () => ({ trusted: true, reason: 'granted' }),
    /**
     * The repository's own entries for the process's workspace, or none.
     *
     * Injected rather than read here because the read is trust-gated, cached, and
     * owned by the plugin root that already answers `projectConfigReport` for the
     * same directory; a second reader would be a second answer to "which
     * repository are we in", and the two would eventually disagree. A failure is
     * treated as "no project entries": an unreadable project file must not cost
     * the user's own servers their mount.
     */
    private readonly projectEntries: () => Promise<ProjectCapabilityEntries> = async () => NO_PROJECT_ENTRIES,
  ) {}

  /**
   * Remount both families from the current configuration.
   *
   * Exists for callers that change an *input to the gate* rather than the
   * configuration itself — granting or revoking folder trust — where nothing in
   * the settings document moved, so the ordinary change detection would
   * correctly see nothing to do.
   */
  async remount(): Promise<void> {
    await this.enqueue(() => this.reconcile({ mcp: true, skill: true }))
  }

  /** Start the configured providers without making plugin construction wait on third-party MCP startup. */
  start(): void {
    // Boot must not wait on third-party MCP startup, so the work is handed to the
    // queue — but a reconcile that throws must not surface as an unhandled
    // rejection: Node ends the process on one. Every other fire-and-forget start
    // in this plugin contains it (the engineering registry's own reconcile
    // swallows, the Claude bridge logs); this was the one site that did not.
    void this.enqueue(() => this.reconcile()).catch((error: unknown) => {
      this.ctx.logger?.warn?.(`FreeCodeGo capability reconcile failed: ${redactCredentialShapes(error instanceof Error ? error.message : String(error))}`)
    })
  }

  /** Stop every dynamically owned provider. */
  dispose(): Promise<void> {
    this.closed = true
    return this.enqueue(async () => {
      await this.disposeMcpFibers()
      await this.disposeSkillFiber()
    })
  }

  /** Return a detached, browser-safe durable configuration snapshot. 
   * @returns the capability Settings.
   */
  configuration(): FreeCodeGoCapabilitySettings {
    const value = this.settings?.get() ?? emptySettings()
    return copySettings(value)
  }

  /** Return the current configuration plus discoverable Host-owned capabilities. 
   * @returns the capability snapshot the Host reports.
   */
  async snapshot(): Promise<FreeCodeGoCapabilitySnapshot> {
    const settings = this.configuration()
    // The settings library is the user-facing inventory, so it lists every
    // discovered Skill. It used to reuse `listSkills()`, whose model-invocation
    // filter hid the 14 bundled Skills that set `disable-model-invocation` —
    // including `ask-matt`, the router a user opens precisely because they do
    // not know which Skill fits. Model-facing consumers keep that filter.
    const skills = await this.listSkillInventory()
    return {
      ...settings,
      mcpServers: settings.mcpServers.map(redactMcpServer),
      mcpTools: settings.mcpEnabled
        ? this.mcpTools().map(tool => ({ name: tool.name, description: tool.description }))
        : [],
      skills,
      ...this.mountErrors.size === 0 ? {} : {
        mountErrors: [...this.mountErrors.entries()].sort(([left], [right]) => left.localeCompare(right))
          .map(([id, message]) => ({ id, message })),
      },
      ...this.trustRefusals.size === 0 ? {} : {
        trustRefusals: [...this.trustRefusals.entries()].sort(([left], [right]) => left.localeCompare(right))
          .map(([id, message]) => ({ id, message })),
      },
    }
  }

  /** Persist both feature switches and apply the new provider generation.
   * @param input - the switches to move; an omitted one keeps its stored value.
   * @returns the capability snapshot the Host reports.
   */
  async setEnabled(input: { readonly mcpEnabled?: boolean; readonly skillEnabled?: boolean; readonly voiceInputEnabled?: boolean; readonly sessionDeleteEnabled?: boolean }): Promise<FreeCodeGoCapabilitySnapshot> {
    const current = this.configuration()
    await this.update({
      ...current,
      ...input.mcpEnabled === undefined ? {} : { mcpEnabled: input.mcpEnabled },
      ...input.skillEnabled === undefined ? {} : { skillEnabled: input.skillEnabled },
      ...input.voiceInputEnabled === undefined ? {} : { voiceInputEnabled: input.voiceInputEnabled },
      ...input.sessionDeleteEnabled === undefined ? {} : { sessionDeleteEnabled: input.sessionDeleteEnabled },
    }, false)
    return this.snapshot()
  }

  /** Persist one user-selected category override, or remove it to restore auto classification.
   * @param input - the model key to classify, and the category to pin on it.
   * @returns the capability snapshot the Host reports.
   */
  async setModelCategory(input: { readonly key: string; readonly category?: FreeCodeGoModelCategory }): Promise<FreeCodeGoCapabilitySnapshot> {
    const key = input.key.trim()
    if (key === '' || key.length > 768 || !key.includes('\u0000')) throw new Error('model category key is invalid')
    if (input.category !== undefined && !['text', 'image', 'video', 'audio'].includes(input.category)) throw new Error('model category is invalid')
    const current = this.configuration()
    const modelCategories = input.category === undefined
      ? omitRecordKey(current.modelCategories, key)
      : { ...current.modelCategories, [key]: input.category }
    await this.update({ ...current, modelCategories })
    return this.snapshot()
  }

  /** Add or replace one user-managed MCP connection after validating its transport-specific fields.
   * @param input - the connection to store; an id replaces that entry, none adds one.
   * @returns the capability snapshot the Host reports.
   */
  async saveMcpServer(input: Omit<FreeCodeGoMcpServer, 'id'> & { readonly id?: string }): Promise<FreeCodeGoCapabilitySnapshot> {
    const current = this.configuration()
    const existing = input.id === undefined ? undefined : current.mcpServers.find(item => item.id === input.id)
    const server = normalizeMcpServer(restoreRedactedMcpSecrets(input, existing))
    const next = current.mcpServers.filter(item => item.id !== server.id)
    if (next.some(item => item.serverName === server.serverName)) throw new Error(`MCP server name "${server.serverName}" is already configured`)
    if (next.length >= MAX_CONFIGURED_SERVERS) throw new Error(`at most ${MAX_CONFIGURED_SERVERS} MCP servers may be configured`)
    await this.update({ ...current, mcpServers: [...next, server] })
    return this.snapshot()
  }

  /** Remove an MCP connection and unload its registered tools.
   * @param id - the stored connection to remove; an unknown id is not an error.
   * @returns the capability snapshot the Host reports.
   */
  async removeMcpServer(id: string): Promise<FreeCodeGoCapabilitySnapshot> {
    const current = this.configuration()
    await this.update({ ...current, mcpServers: current.mcpServers.filter(item => item.id !== id) })
    return this.snapshot()
  }

  /** Add or replace one absolute Skill root.
   * @param input - the root to store; an id replaces that entry, none adds one.
   * @returns the capability snapshot the Host reports.
   */
  async saveSkillRoot(input: Omit<FreeCodeGoSkillRoot, 'id'> & { readonly id?: string }): Promise<FreeCodeGoCapabilitySnapshot> {
    const root = normalizeSkillRoot(input)
    const current = this.configuration()
    const next = current.skillRoots.filter(item => item.id !== root.id)
    if (next.some(item => sameFilesystemPath(item.path, root.path))) throw new Error(`Skill root "${root.path}" is already configured`)
    if (next.length >= MAX_CONFIGURED_ROOTS) throw new Error(`at most ${MAX_CONFIGURED_ROOTS} Skill roots may be configured`)
    await this.update({ ...current, skillRoots: [...next, root] })
    return this.snapshot()
  }

  /** Register one managed Skill root and enable Skills in the same settings commit.
   * @param id - the managed root's identity, which replaces any root of the same id.
   * @param directory - directory the operation runs against.
   * @returns the capability snapshot the Host reports.
   */
  async enableManagedSkillRoot(id: string, directory: string): Promise<FreeCodeGoCapabilitySnapshot> {
    const root = normalizeSkillRoot({ id, enabled: true, path: directory })
    const current = this.configuration()
    const skillRoots = current.skillRoots.filter(item => item.id !== root.id && !sameFilesystemPath(item.path, root.path))
    if (skillRoots.length >= MAX_CONFIGURED_ROOTS) throw new Error(`at most ${MAX_CONFIGURED_ROOTS} Skill roots may be configured`)
    await this.update({ ...current, skillEnabled: true, skillRoots: [...skillRoots, root] })
    return this.snapshot()
  }

  /**
   * Persist the user's answer for one Skill's model invocation, or clear it.
   *
   * `modelInvocable: undefined` deletes the override, which is the only way to
   * go back to whatever the Skill's own file declares — including after that
   * file changes. The name is validated here because it becomes a settings key
   * that a later discovery pass matches against real Skill names.
   * @param input - the Skill name, and the override to store or clear.
   * @returns the capability snapshot the Host reports.
   */
  async setSkillInvocation(input: { readonly name: string; readonly modelInvocable?: boolean }): Promise<FreeCodeGoCapabilitySnapshot> {
    const name = input.name.trim()
    if (!SKILL_NAME.test(name)) throw new Error('Skill name is invalid')
    if (input.modelInvocable !== undefined && typeof input.modelInvocable !== 'boolean') throw new Error('modelInvocable must be a boolean')
    const current = this.configuration()
    const skillInvocationOverrides = input.modelInvocable === undefined
      ? omitRecordKey(current.skillInvocationOverrides, name)
      : { ...current.skillInvocationOverrides, [name]: input.modelInvocable }
    await this.update({ ...current, skillInvocationOverrides })
    return this.snapshot()
  }

  /**
   * Remember where a Skill install should land, or forget the preference.
   *
   * The axes are stored rather than the root they resolve to, because the root moves:
   * the folder, `$DSH_HOME` and the home directory each decide part of it, and a saved
   * path would outlive the workspace it was resolved in. `agent: 'custom'` is refused
   * instead of stored — nothing supplies a custom root through these remotes, so it
   * would be a preference that can never resolve into a destination.
   *
   * Both axes or neither: half a placement is not a placement, and guessing the other
   * half would be this plugin choosing a directory the user did not.
   * @param input - the two axes to prefer, or neither to clear the preference.
   * @returns the capability snapshot the Host reports.
   */
  async setPreferredSkillPlacement(input: { readonly agent?: 'harness' | 'agents'; readonly scope?: 'project' | 'user' }): Promise<FreeCodeGoCapabilitySnapshot> {
    const current = this.configuration()
    const clearing = input.agent === undefined && input.scope === undefined
    if (!clearing && (typeof input.agent !== 'string' || typeof input.scope !== 'string')) {
      throw new Error('a Skill placement needs both axes: name the agent and the scope, or clear it')
    }
    // The clear writes `null` rather than dropping the key: a settings write merges, so
    // an absent field is "no change to what is stored" and the old destination would
    // survive a user asking for the default back. `null` is a value, and a value replaces.
    const next = {
      ...current,
      preferredSkillPlacement: clearing
        ? null
        : { agent: input.agent as 'harness' | 'agents', scope: input.scope as 'project' | 'user' },
    }
    await this.update(next, false)
    return this.snapshot()
  }

  /** Remove one user-managed Skill root.
   * @param id - the stored root to remove; an unknown id is not an error.
   * @returns the capability snapshot the Host reports.
   */
  async removeSkillRoot(id: string): Promise<FreeCodeGoCapabilitySnapshot> {
    const current = this.configuration()
    await this.update({ ...current, skillRoots: current.skillRoots.filter(item => item.id !== id) })
    return this.snapshot()
  }

  /** Current Host capability snapshot used by native workers before a session opens. 
   * @param agent - the agent this call applies to.
   * @returns the native Capability Configuration.
   */
  nativeConfiguration(agent?: Agent): NativeCapabilityConfiguration {
    const value = this.configuration()
    const tools = this.ctx.tools.schemas(agent)
    return {
      mcpEnabled: value.mcpEnabled,
      skillEnabled: value.skillEnabled,
      skillRoots: value.skillEnabled ? value.skillRoots.filter(root => root.enabled).map(root => root.path) : [],
      mcpTools: value.mcpEnabled ? tools.filter(tool => tool.name.startsWith('mcp__')) : [],
      harnessTools: tools,
    }
  }

  /** Execute one active MCP tool through the normal Harness policy pipeline.
   * @param agent - the agent the call is made for, when one is in scope.
   * @param name - the registered `mcp__` tool name to call.
   * @param args - the arguments the call was made with, of unknown shape.
   * @param signal - aborts the request when the caller cancels.
   * @returns The tool's content and error flag, as the pipeline reported them.
   */
  async executeMcpTool(agent: Agent | undefined, name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    if (!this.configuration().mcpEnabled) throw new Error('MCP is disabled in FreeCodeGo settings')
    if (!name.startsWith('mcp__') || !this.mcpTools(agent).some(tool => tool.name === name)) throw new Error(`MCP tool "${name}" is not active`)
    const result = await this.ctx.tools.execute({
      callId: callId(`freecodego-mcp-${randomUUID()}`),
      name,
      arguments: args,
      ...(agent === undefined ? {} : { agent }),
      signal,
    })
    return { content: result.content, isError: result.isError }
  }

  /**
   * Execute one Agent-authorized Harness/plugin tool without widening authority.
   *
   * `inlineImages` is the caller's promise that its transport can carry base64
   * image bytes back to the model. Only the in-process Claude transport can
   * (every codex worker frame is bounded by `MAX_WORKER_FRAME_BYTES` in
   * `runtime-codex/src/frame-budget.ts` — 1 MB, far below one image), so it
   * is off unless a transport asks — see {@link inlineImageAttachmentBlocks}.
   * @param agent - the agent the call is made for, when one is in scope.
   * @param name - the registered Harness tool name to call.
   * @param args - the arguments the call was made with, of unknown shape.
   * @param signal - aborts the request when the caller cancels.
   * @param options - whether image results may be inlined for this transport.
   * @returns The tool's content and error flag, as the pipeline reported them.
   */
  async executeHarnessTool(
    agent: Agent | undefined,
    name: string,
    args: unknown,
    signal: AbortSignal,
    options: { readonly inlineImages?: boolean } = {},
  ): Promise<unknown> {
    if (!this.harnessTools(agent).some(tool => tool.name === name)) {
      throw new Error(`Harness tool "${name}" is not available to this native Agent`)
    }
    const result = await this.ctx.tools.execute({
      callId: callId(`freecodego-harness-${randomUUID()}`),
      name,
      arguments: args,
      ...(agent === undefined ? {} : { agent }),
      signal,
    })
    const content = options.inlineImages === true
      ? await inlineImageAttachmentBlocks(result.content, attachment => this.readAttachmentBytes(attachment, signal))
      : result.content
    return { content, isError: result.isError }
  }

  /** Read one stored attachment's bytes for a transport that carries images inline. */
  private async readAttachmentBytes(attachment: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<Uint8Array | undefined> {
    const attachments = this.ctx.get('attachments') as AttachmentStore | undefined
    if (attachments === undefined) return undefined
    try {
      const stored = await attachments.readImage(attachment as never, signal)
      return stored.data instanceof Uint8Array ? stored.data : undefined
    } catch {
      // The caller falls back to the reference block.
      return undefined
    }
  }

  /**
   * Discover every Skill visible to the caller with the user's stored answer
   * applied to each one's model policy.
   */
  private async discoverSkills(agent?: Agent, signal?: AbortSignal): Promise<readonly DiscoveredSkill[]> {
    if (!this.configuration().skillEnabled) return []
    const skills = this.ctx.get('skills')
    if (skills === undefined) return []
    const snapshot = await skills.snapshot({
      ...(agent === undefined ? {} : { scope: agent, cwd: agent.session.header.cwd }),
      ...(signal === undefined ? {} : { signal }),
    })
    // Read the stored answers once for the whole catalog: settings snapshots
    // are detached copies, and a per-row read would copy them per Skill.
    const overrides = this.configuration().skillInvocationOverrides
    return snapshot.skills.map(skill => ({
      ...skill,
      invocation: { ...skill.invocation, modelInvocable: resolveModelInvocable(overrides, skill.name, skill.invocation.modelInvocable) },
    }))
  }

  /**
   * List model-invocable skills using the calling Agent's scope when supplied.
   *
   * This is the model-facing surface (the Claude bridge `skill/list` op and the
   * subagent projection), so it keeps honoring `disable-model-invocation`. The
   * settings library does not — see {@link listSkillInventory}. 
   * @param agent - the agent this call applies to.
   * @param signal - aborts the request when the caller cancels.
   * @returns The model-invocable Skills as name, description and source.
   */
  async listSkills(agent?: Agent, signal?: AbortSignal): Promise<readonly { readonly name: string; readonly description: string; readonly source: string }[]> {
    return (await this.discoverSkills(agent, signal))
      .filter(skill => skill.invocation.modelInvocable)
      .map(skill => ({ name: skill.name, description: skill.description, source: skill.source }))
  }

  /**
   * List every discovered Skill for the settings library, including the ones
   * only a human may invoke.
   *
   * `disable-model-invocation` narrows the *model's* reach, not the user's: the
   * marked Skills are still invocable by name, so omitting them from a page the
   * user browses hides the entries they are most likely to be looking for. The
   * invocation flags travel with each row so the page can say which is which.
   * @param agent - the agent this call applies to.
   * @param signal - aborts the request when the caller cancels.
   * @returns the skill Entry rows, in backend order.
   */
  async listSkillInventory(agent?: Agent, signal?: AbortSignal): Promise<readonly FreeCodeGoSkillEntry[]> {
    return (await this.discoverSkills(agent, signal)).map(skill => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
    }))
  }

  /**
   * Load one Skill's body plus the files beside its `SKILL.md`.
   *
   * Deliberately not filtered by `modelInvocable`: the dialog exists so a user
   * can read what a Skill contains before invoking it, and the user-invoked
   * entries are exactly the ones nothing else in the UI describes.
   * @param name - kebab-case Skill name.
   * @param file - companion file to return inline instead of the Skill body.
   * @param agent - calling Agent, when the caller has one, for scope and cwd.
   * @param signal - cancels discovery and the read.
   * @returns the entry, the body, the companion listing, and the requested file.
   */
  async readSkill(name: string, file?: string, agent?: Agent, signal?: AbortSignal): Promise<FreeCodeGoSkillDetail> {
    if (!this.configuration().skillEnabled) throw new Error('Skill is disabled in FreeCodeGo settings')
    const skills = this.ctx.get('skills')
    if (skills === undefined) throw new Error('Skill service is not configured')
    const skill = await skills.get(name, {
      ...(agent === undefined ? {} : { scope: agent, cwd: agent.session.header.cwd }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (skill === undefined) throw new Error(`Skill "${name}" is not available`)
    // The provider's declared base first, the `SKILL.md` path as the fallback:
    // a virtual Skill states where its resources are and has no path to infer
    // from, and a base this build cannot read is reported rather than replaced
    // by a local read that would list something else.
    const location = skillResourceLocation(skill)
    const directory = location.kind === 'directory' ? location.directory : undefined
    // The Harness's filesystem seam when the composition mounts one: the Skill
    // body the service just handed over came through it, so a listing read from
    // the host's own disk would describe a different filesystem whenever the seam
    // points at a sandbox. Absent, the host filesystem is the answer.
    const fileSystem = this.ctx.get('fs') as SkillCompanionFs | undefined
    const files = await listSkillCompanionFiles(directory, fileSystem)
    const entry: FreeCodeGoSkillEntry = {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      modelInvocable: this.modelInvocable(skill.name, skill.invocation.modelInvocable),
      userInvocable: skill.invocation.userInvocable,
    }
    if (file !== undefined) {
      // The reason the listing is empty, not the listing: "no directory" and
      // "the resources are served from a URL" are different answers to a user
      // who clicked a file the Skill's own provider advertised.
      if (location.kind !== 'directory') throw new Error(`"${file}" cannot be read: ${redactCredentialShapes(location.reason)}`)
      return { ...entry, content: skill.content, files, forwarded: [], file: await readSkillCompanionFile({ directory, files, path: file, ...(fileSystem === undefined ? {} : { fs: fileSystem }) }) }
    }
    return { ...entry, content: skill.content, files, forwarded: await this.resolveSkillForwards(skills, skill, agent, signal) }
  }

  /**
   * Resolve the targets of a thin alias Skill's one-line body.
   *
   * A target that is missing or unreadable is dropped rather than raised: the
   * alias itself is readable, and a reason to show *less* must never be a
   * reason the dialog cannot open. Self-references are skipped so a Skill can
   * never print itself under its own body.
   */
  private async resolveSkillForwards(
    skills: Context['skills'],
    skill: { readonly name: string; readonly content: string },
    agent?: Agent,
    signal?: AbortSignal,
  ): Promise<readonly FreeCodeGoSkillForward[]> {
    const names = skillForwardTargets(skill.content).filter(name => name !== skill.name)
    if (names.length === 0) return []
    const resolved: FreeCodeGoSkillForward[] = []
    for (const name of names) {
      try {
        const definition = await skills.get(name, {
          ...(agent === undefined ? {} : { scope: agent, cwd: agent.session.header.cwd }),
          ...(signal === undefined ? {} : { signal }),
        })
        if (definition === undefined) continue
        resolved.push({ name: definition.name, description: definition.description, content: definition.content })
      } catch {
        // An unreadable target simply contributes nothing to the dialog.
      }
    }
    return resolved
  }

  /**
   * Load one model-invocable skill using the calling Agent's scope when supplied.
   * @param name - the Skill to load, which must be model-invocable here.
   * @param agent - the agent this call applies to.
   * @param signal - aborts the request when the caller cancels.
   * @returns The Skill's name, description and content.
   */
  async loadSkill(name: string, agent?: Agent, signal?: AbortSignal): Promise<unknown> {
    if (!this.configuration().skillEnabled) throw new Error('Skill is disabled in FreeCodeGo settings')
    const skills = this.ctx.get('skills')
    if (skills === undefined) throw new Error('Skill service is not configured')
    const skill = await skills.get(name, {
      ...(agent === undefined ? {} : { scope: agent, cwd: agent.session.header.cwd }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (skill === undefined || !this.modelInvocable(skill.name, skill.invocation.modelInvocable)) throw new Error(`Skill "${name}" is not available`)
    return { name: skill.name, description: skill.description, content: skill.content }
  }

  /**
   * Whether a global Skill tool call must be denied for a disabled configuration.
   * @returns True when the Skills switch is on.
   */
  skillEnabled(): boolean { return this.configuration().skillEnabled }

  private async update(value: FreeCodeGoCapabilitySettings, waitForReconcile = true): Promise<void> {
    if (this.settings === undefined) throw new Error('FreeCodeGo settings are not configured')
    validateSettings(value)
    const previous = this.configuration()
    await this.settings.update(value)
    // Only remount the providers whose inputs actually changed: flipping the
    // voice-input or session-delete switch (or a model category) must never
    // dispose in-flight MCP tool calls or the Skill fiber. A family whose
    // enabled servers are missing or previously failed to mount still remounts,
    // so a retry (or a first mount after start) never reports stale state.
    const changed: ReconcileChanges = {
      mcp: previous.mcpEnabled !== value.mcpEnabled || !sameMcpServers(previous.mcpServers, value.mcpServers) || this.mcpMountIncomplete(value),
      skill: previous.skillEnabled !== value.skillEnabled || !sameSkillRoots(previous.skillRoots, value.skillRoots) || this.skillMountIncomplete(value),
    }
    const reconcile = this.enqueue(() => this.reconcile(changed))
    if (waitForReconcile) await reconcile
    else void reconcile.catch(() => undefined)
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.queue.then(operation, operation)
    this.queue = pending.catch(() => undefined)
    return pending
  }

  private async reconcile(changed: ReconcileChanges = { mcp: true, skill: true }): Promise<void> {
    if (this.closed) return
    const settings = this.configuration()
    const project = await this.projectEntries().then(
      value => value,
      () => NO_PROJECT_ENTRIES,
    )
    this.projectInventory = project
    // The Skill invocation overrides are not a provider that gets mounted and
    // not a reconcile input either: the resolution surfaces read them live from
    // settings (see {@link modelInvocable}), so flipping a switch never tears
    // down the Skill fiber or an in-flight MCP call.
    // Teardown only the provider family whose configuration changed. An MCP
    // remount keeps the Skill fiber (and vice versa) so live tool calls in the
    // untouched family survive the reconcile.
    if (changed.mcp) await this.disposeMcpFibers()
    if (changed.skill) await this.disposeSkillFiber()
    this.mountErrors.clear()
    this.trustRefusals.clear()
    if (settings.mcpEnabled && changed.mcp) {
      // The repository's servers mount on the same terms as the user's, including
      // the same master switch and the same gate: `mcpEnabled` is the user's
      // answer about their machine, and a repository cannot override it.
      for (const server of [...settings.mcpServers, ...project.mcpServers].filter(server => server.enabled)) {
        // A server with an empty `cwd` runs from wherever the Host runs and is
        // therefore the user's own machine's configuration; one pinned to a
        // directory can be launched from inside somebody else's checkout, so it
        // is the only shape the gate needs to ask about.
        if (server.cwd !== '' && !await this.admit('mcp', server.id, server.cwd)) continue
        try {
          const fiber = await this.ctx.plugin({
            name: `freecodego-mcp-${server.serverName}`,
            inject: ['tools'],
            apply: applyMcpClient,
          }, toMcpClientConfig(server))
          this.mcpFibers.set(server.id, fiber)
          this.mountErrors.delete(server.id)
        } catch (error) {
          this.mountErrors.set(server.id, error instanceof Error ? error.message : String(error))
        }
      }
    }
    const admittedRoots: string[] = []
    if (settings.skillEnabled) {
      for (const root of [...settings.skillRoots, ...project.skillRoots].filter(root => root.enabled)) {
        if (await this.admit('skill', root.id, root.path)) admittedRoots.push(root.path)
      }
    }
    const roots = admittedRoots
    if (settings.skillEnabled && changed.skill && roots.length > 0) {
      try {
        this.skillFiber = await this.ctx.plugin({
          name: 'freecodego-skill-roots',
          inject: ['skills'],
          apply: applySkillFilesystem,
        }, {
          providerName: 'freecodego-configured',
          includeDefaultRoots: false,
          customSkillDirs: roots,
        })
        this.mountErrors.delete('skill')
      } catch (error) {
        this.mountErrors.set('skill', error instanceof Error ? error.message : String(error))
      }
    }
  }

  /**
   * Whether one configured entry may mount, recording the refusal when it may not.
   * @param key - the family the entry belongs to, used as a record-key prefix.
   * @param id - the entry's own id.
   * @param directory - the directory the entry operates in.
   * @returns `true` when the entry is admitted or the gate cannot be asked.
   */
  private async admit(key: 'mcp' | 'skill', id: string, directory: string): Promise<boolean> {
    // A gate that cannot answer must not become a second failure mode: the
    // surfaces it guards are already optional, and turning an IO error in the
    // trust record into "your Skill root disappeared" would be a worse bug than
    // the one the gate exists to prevent.
    const decision = await this.projectScopeTrust(directory).catch(() => ({ trusted: true, reason: 'gate-unavailable' }))
    if (decision.trusted) return true
    this.trustRefusals.set(`${key}:${id}`, `not mounted: this directory is not a trusted repository (${decision.reason}); grant trust for it in the FreeCodeGo settings surface`)
    return false
  }

  private async disposeMcpFibers(): Promise<void> {
    const fibers = [...this.mcpFibers.values()]
    this.mcpFibers.clear()
    await Promise.all(fibers.map(fiber => fiber.dispose()))
  }

  private async disposeSkillFiber(): Promise<void> {
    const fiber = this.skillFiber
    this.skillFiber = undefined
    await fiber?.dispose()
  }

  /** Whether an enabled MCP server has no live fiber or a recorded mount failure. */
  private mcpMountIncomplete(value: FreeCodeGoCapabilitySettings): boolean {
    if (!value.mcpEnabled) return false
    return [...value.mcpServers, ...this.projectInventory.mcpServers].some(
      server => server.enabled && !this.trustRefusals.has(`mcp:${server.id}`) && (!this.mcpFibers.has(server.id) || this.mountErrors.has(server.id)),
    )
  }

  /** Whether the Skill family is enabled but its fiber is missing or failed. */
  private skillMountIncomplete(value: FreeCodeGoCapabilitySettings): boolean {
    if (!value.skillEnabled) return false
    return [...value.skillRoots, ...this.projectInventory.skillRoots].some(
      root => root.enabled && !this.trustRefusals.has(`skill:${root.id}`),
    ) && (this.skillFiber === undefined || this.mountErrors.has('skill'))
  }

  /**
   * Resolve one Skill's model-invocation policy with the user's stored answer.
   *
   * Harness 0.1.6 resolves `modelInvocable` inside the shared Skill registry,
   * and that registry has no override seam: a provider declares the policy for
   * the files it discovers, resolved once at collect time. The method this Host
   * used to call (`setModelInvocationOverrides`) has never existed on that
   * service in either 0.1.3 or 0.1.6 — it stayed latent while the service was
   * loosely typed and surfaced as a compile error only once 0.1.6 typed it.
   *
   * The answer therefore travels with this Host instead: every model-facing
   * surface it owns resolves through here, so a Skill's own file remains the
   * default and a stored key is the user's answer instead, exactly as
   * {@link FreeCodeGoCapabilitySettings.skillInvocationOverrides} documents.
   */
  private modelInvocable(name: string, declared: boolean): boolean {
    return resolveModelInvocable(this.configuration().skillInvocationOverrides, name, declared)
  }

  /**
   * Whether a stored manual-only answer bars the model from one Skill.
   *
   * Synchronous and settings-only, because the plugin root consults it from the
   * monotonic `skill` tool guard, which runs on the pre-execute path where no
   * discovery is available. An override naming a Skill no root discovers is
   * harmless: it guards nothing.
   * @param name - the Skill name a call is being guarded for.
   * @returns True when a stored manual-only answer bars the model from it.
   */
  skillInvocationLocked(name: string): boolean {
    return this.configuration().skillInvocationOverrides[name] === false
  }

  private mcpTools(agent?: Agent): ToolSchema[] {
    return this.ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('mcp__'))
  }

  private harnessTools(agent?: Agent): ToolSchema[] {
    return this.ctx.tools.schemas(agent)
  }
}

/**
 * Apply the user's stored answer to one Skill's declared model policy.
 *
 * Pure and settings-shaped so the catalog path can share it: a key present in
 * `overrides` is the user's answer, and an absent key defers to the Skill's own
 * file, which is the only way a third-party Skill stays upgradable.
 */
function resolveModelInvocable(overrides: Readonly<Record<string, boolean>>, name: string, declared: boolean): boolean {
  return overrides[name] ?? declared
}

function emptySettings(): FreeCodeGoCapabilitySettings {
  return { mcpEnabled: false, skillEnabled: false, voiceInputEnabled: true, sessionDeleteEnabled: true, modelCategories: {}, mcpServers: [], skillRoots: [], skillInvocationOverrides: {} }
}

function copySettings(value: FreeCodeGoCapabilitySettings): FreeCodeGoCapabilitySettings {
  return {
    // Copied by value, and dropped for both "absent" and the document's explicit `null`:
    // the snapshot is serialized across the remote boundary, where "no preference" must
    // be one fact rather than two spellings. The stored document keeps the `null` — that
    // is the only way a merge can record a clear — but nothing above this function has to
    // know that.
    ...(value.preferredSkillPlacement === undefined || value.preferredSkillPlacement === null
      ? {}
      : { preferredSkillPlacement: { ...value.preferredSkillPlacement } }),
    mcpEnabled: value.mcpEnabled ?? false,
    skillEnabled: value.skillEnabled ?? false,
    voiceInputEnabled: value.voiceInputEnabled ?? true,
    sessionDeleteEnabled: value.sessionDeleteEnabled ?? true,
    modelCategories: { ...(value.modelCategories ?? {}) },
    mcpServers: (value.mcpServers ?? []).map(server => ({ ...server, args: [...(server.args ?? [])], env: { ...(server.env ?? {}) }, headers: { ...(server.headers ?? {}) } })),
    skillRoots: (value.skillRoots ?? []).map(root => ({ ...root })),
    skillInvocationOverrides: { ...(value.skillInvocationOverrides ?? {}) },
  }
}

function redactMcpServer(server: FreeCodeGoMcpServer): FreeCodeGoMcpServer {
  return {
    ...server,
    args: [...server.args],
    env: Object.fromEntries(Object.keys(server.env).map(key => [key, MCP_SECRET_REDACTED])),
    headers: Object.fromEntries(Object.keys(server.headers).map(key => [key, MCP_SECRET_REDACTED])),
  }
}

function restoreRedactedMcpSecrets(
  input: Omit<FreeCodeGoMcpServer, 'id'> & { readonly id?: string },
  previous: FreeCodeGoMcpServer | undefined,
): Omit<FreeCodeGoMcpServer, 'id'> & { readonly id?: string } {
  const restore = (next: Readonly<Record<string, string>>, saved: Readonly<Record<string, string>>, field: string): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(next)) {
      if (value !== MCP_SECRET_REDACTED) { result[key] = value; continue }
      const prior = saved[key]
      if (previous === undefined || prior === undefined) throw new Error(`MCP ${field} value for "${key}" must be entered when creating a server`)
      result[key] = prior
    }
    return result
  }
  return {
    ...input,
    env: restore(input.env, previous?.env ?? {}, 'environment'),
    headers: restore(input.headers, previous?.headers ?? {}, 'header'),
  }
}

function normalizeMcpServer(input: Omit<FreeCodeGoMcpServer, 'id'> & { readonly id?: string }): FreeCodeGoMcpServer {
  const server: FreeCodeGoMcpServer = {
    id: input.id?.trim() || randomUUID(),
    enabled: input.enabled,
    transport: input.transport,
    serverName: input.serverName.trim(),
    command: input.command.trim(),
    args: [...input.args],
    env: { ...input.env },
    cwd: input.cwd.trim(),
    url: input.url.trim(),
    headers: { ...input.headers },
  }
  validateMcpServer(server)
  return server
}

function normalizeSkillRoot(input: Omit<FreeCodeGoSkillRoot, 'id'> & { readonly id?: string }): FreeCodeGoSkillRoot {
  const configuredPath = input.path.trim()
  if (configuredPath === '') throw new Error('Skill root path is required')
  if (!isAbsolute(configuredPath)) throw new Error('Skill root path must be absolute')
  const root = { id: input.id?.trim() || randomUUID(), enabled: input.enabled, path: resolve(configuredPath) }
  return root
}

/**
 * One path's comparison key: case-folded only where the filesystem case-folds.
 *
 * `/Skills` and `/skills` are two different directories on POSIX and one on
 * Windows, so a key that always lowercases makes a POSIX change look like a
 * no-op. Both the duplicate check and the remount check read this one helper so
 * they cannot disagree about whether a path changed.
 */
function filesystemPathKey(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function sameFilesystemPath(left: string, right: string): boolean {
  return filesystemPathKey(left) === filesystemPathKey(right)
}

/** Deep-compare configured MCP servers; a changed set forces an MCP remount. */
function sameMcpServers(left: readonly FreeCodeGoMcpServer[], right: readonly FreeCodeGoMcpServer[]): boolean {
  if (left.length !== right.length) return false
  const keyOf = (server: FreeCodeGoMcpServer): string => JSON.stringify({
    id: server.id, enabled: server.enabled, transport: server.transport, serverName: server.serverName,
    command: server.command, args: server.args, env: server.env, cwd: server.cwd, url: server.url, headers: server.headers,
  })
  return left.every((server, index) => keyOf(server) === keyOf(right[index]!))
}

/** Deep-compare configured Skill roots; a changed set forces a Skill remount. */
function sameSkillRoots(left: readonly FreeCodeGoSkillRoot[], right: readonly FreeCodeGoSkillRoot[]): boolean {
  if (left.length !== right.length) return false
  const keyOf = (root: FreeCodeGoSkillRoot): string => JSON.stringify({ id: root.id, enabled: root.enabled, path: filesystemPathKey(root.path) })
  return left.every((root, index) => keyOf(root) === keyOf(right[index]!))
}

function validateSettings(value: FreeCodeGoCapabilitySettings): void {
  if (value.mcpServers.length > MAX_CONFIGURED_SERVERS) throw new Error(`at most ${MAX_CONFIGURED_SERVERS} MCP servers may be configured`)
  if (value.skillRoots.length > MAX_CONFIGURED_ROOTS) throw new Error(`at most ${MAX_CONFIGURED_ROOTS} Skill roots may be configured`)
  const names = new Set<string>()
  for (const server of value.mcpServers) {
    validateMcpServer(server)
    if (names.has(server.serverName)) throw new Error(`MCP server name "${server.serverName}" is already configured`)
    names.add(server.serverName)
  }
  for (const root of value.skillRoots) normalizeSkillRoot(root)
  // A stored placement is read back as a destination the *user* chose, so a spelling
  // the matrix does not know would sit in settings looking like a preference while
  // every install ignored it.
  if (value.preferredSkillPlacement !== undefined && value.preferredSkillPlacement !== null) {
    const { agent, scope } = value.preferredSkillPlacement
    if (agent !== 'harness' && agent !== 'agents') throw new Error(`Skill placement agent "${String(agent)}" is not one of harness, agents`)
    if (scope !== 'project' && scope !== 'user') throw new Error(`Skill placement scope "${String(scope)}" is not one of project, user`)
  }
  // A garbage key never matches a real Skill, so it would sit in settings
  // looking like an applied preference that does nothing.
  for (const [name, modelInvocable] of Object.entries(value.skillInvocationOverrides ?? {})) {
    if (!SKILL_NAME.test(name)) throw new Error(`Skill invocation override "${name}" is not a Skill name`)
    if (typeof modelInvocable !== 'boolean') throw new Error(`Skill invocation override "${name}" must be a boolean`)
  }
}

function validateMcpServer(server: FreeCodeGoMcpServer): void {
  if (!SERVER_NAME.test(server.serverName)) throw new Error('MCP server name must use letters, numbers, underscores, or hyphens')
  if (server.transport === 'stdio' && server.command === '') throw new Error('stdio MCP servers require a command')
  if (server.transport === 'streamable-http') {
    let url: URL
    try { url = new URL(server.url) } catch { throw new Error('HTTP MCP servers require an absolute URL') }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('HTTP MCP server URL must use http or https')
  }
  for (const [key, value] of Object.entries({ ...server.env, ...server.headers })) {
    // Empty values are rejected to match the marketplace one-click path
    // (`mcpDefinitionRequiresConfiguration`): a child process silently fed
    // `EMPTY=''` is a configuration mistake, not a valid setting.
    if (key.trim() === '' || value.trim() === '' || value.length > 16_384) throw new Error('MCP environment and header values must be non-empty and bounded')
    if (/[\r\n\x00]/.test(key)) throw new Error('MCP environment and header keys must not contain control characters')
  }
}

function toMcpClientConfig(server: FreeCodeGoMcpServer): McpClientConfig {
  return server.transport === 'stdio'
    ? {
      transport: 'stdio', serverName: server.serverName, command: server.command,
      args: [...server.args], env: { ...server.env }, cwd: server.cwd,
      toolCallTimeoutMs: 60_000, failOnStartupError: false,
    } as McpClientConfig
    : {
      transport: 'streamable-http', serverName: server.serverName, url: server.url,
      headers: { ...server.headers }, toolCallTimeoutMs: 60_000, failOnStartupError: false,
    } as McpClientConfig
}
