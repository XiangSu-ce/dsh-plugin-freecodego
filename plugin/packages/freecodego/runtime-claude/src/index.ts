import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { NativeAgentSession, NativeRootAgentCreateOptions, NativeRootAgentEvent } from '@deepseek-ai/dsh-freecodego-root-agent'
import { buildClaudeSdkEnvironment } from './environment.ts'
import { sdkSessionFromCache, withSdkSessionCache } from './sdk-session-cache.ts'
import { StreamIdleTimeoutError, redactSecrets, withIdleDeadline } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'
import { claudeSandboxDenial } from './sandbox-enforcement.ts'
import {
  createHarnessMcpServer,
  HARNESS_ASK_USER_TOOL_ALIAS,
  type ClaudeHarnessCapabilities,
  type ClaudeQuestion,
} from './harness-mcp.ts'
// The Host prompt has to name Harness tools the way this transport advertises
// them, so the naming rules are part of this package's public surface.
export { claudeHarnessToolName, claudeMcpToolName } from './harness-mcp.ts'

/**
 * Official Claude Agent SDK launch configuration.
 *
 * There is no worker path here: this package drives the SDK in the Host
 * process (see {@link DirectClaudeSdkSession}). The sidecar transport that a
 * `workerPath` used to select was accepted and then ignored, so the field only
 * made the dead path look wired.
 */
export interface ClaudeRuntimeLaunchOptions {
  readonly stateDirectory: string
  readonly environment?: Readonly<Record<string, string>>
  /** Resolves the plugin-owned gateway for the model selected for this turn. */
  readonly gatewayForRoute?: (route: ClaudePromptRoute) => Promise<ClaudeGateway>
  /** Returns the current plugin-owned MCP, Skill, and Harness tool inventory. */
  readonly capabilitiesForTurn?: () => Promise<ClaudeHarnessCapabilities> | ClaudeHarnessCapabilities
  /** Adds the current Harness topology to the official Claude Code prompt. */
  readonly systemPromptForRoute?: (route: ClaudePromptRoute) => Promise<string> | string
}

type SdkMessage = { readonly type: string; readonly subtype?: string; readonly session_id?: string; readonly [key: string]: unknown }
type Pending = { resolve(value: unknown): void; reject(error: Error): void }
type ClaudeReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ClaudePromptRoute {
  readonly modelId: string
  readonly provider: string
  readonly reasoningEffort?: string
}

export interface ClaudeGateway {
  readonly baseURL: string
  readonly apiKey: string
  /** Provider wire id when the native endpoint differs from the picker id. */
  readonly model?: string
}

/**
 * How long a Claude turn may spend with no SDK event before it is failed.
 *
 * The sibling Codex runtime bounds a turn with the same 15 minutes. Claude
 * streams partial messages while it works (`includePartialMessages`), so a gap
 * this long is the only evidence available that the session is gone rather than
 * slow — and the deadline re-arms on every event, so a long turn that keeps
 * producing is never cut off for being long.
 */
const CLAUDE_TURN_IDLE_MS = 15 * 60_000

/**
 * Host-thread Claude Agent SDK session. Keeping the official SDK in the Host
 * process avoids Windows sandbox policies that reject a CLI spawned by a
 * nested worker process.
 */
class DirectClaudeSdkSession implements NativeAgentSession {
  public readonly identity: NativeRootAgentEvent['binding']
  private readonly pendingPermissions = new Map<string, Pending>()
  private readonly pendingQuestions = new Map<string, Pending>()
  private readonly pendingBridges = new Map<string, Pending>()
  private sequence = 0
  private activeAbort: AbortController | undefined
  private activeConversation: { interrupt?: () => Promise<void> } | undefined
  private disposed = false

  private constructor(
    private readonly runtime: ClaudeRuntimeLaunchOptions,
    private readonly options: Omit<NativeRootAgentCreateOptions, 'engine'>,
    runtimeSessionId: string,
  ) {
    this.identity = {
      engine: 'claude',
      runtimeSessionId,
      harnessSessionId: options.harnessSessionId,
      modelId: options.modelId,
      provider: options.provider,
      artifactDigest: options.artifactDigest,
      protocolAbi: options.protocolAbi,
    }
  }

  static async open(runtime: ClaudeRuntimeLaunchOptions, options: Omit<NativeRootAgentCreateOptions, 'engine'>): Promise<DirectClaudeSdkSession> {
    await mkdir(runtime.stateDirectory, { recursive: true })
    const session = new DirectClaudeSdkSession(runtime, options, options.nativeSessionId ?? randomUUID())
    // Host configuration is consumed by the Worker-only transport. The SDK
    // executes directly here, while native events still reach the same Agent.
    await options.prepare?.(async () => undefined)
    return session
  }

  async prompt(content: string, route?: ClaudePromptRoute, signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('Claude SDK session is disposed')
    if (content.trim() === '') throw new Error('native Claude prompt must not be empty')
    if (this.activeAbort !== undefined) throw new Error('Claude SDK session already has an active prompt')
    if (signal?.aborted === true) throw abortReason(signal.reason)
    const abort = new AbortController()
    this.activeAbort = abort
    const abortFromCaller = (): void => { abort.abort(signal?.reason) }
    signal?.addEventListener('abort', abortFromCaller, { once: true })
    let openedSdkSessionId: string | undefined
    // Declared here rather than beside the environment it comes from, because
    // the `catch` below redacts with it and a `const` inside `try` is out of
    // scope there. Empty until the environment is built, which is also the
    // right default: a throw before that point has no session credentials to
    // mask, and the shape rules still run.
    let knownSecrets: readonly (string | undefined)[] = []
    try {
      const selectedEffort = isClaudeReasoningEffort(route?.reasoningEffort)
        ? route.reasoningEffort
        : undefined
      const selectedRoute: ClaudePromptRoute = {
        modelId: route?.modelId ?? this.identity.modelId,
        provider: route?.provider ?? this.identity.provider,
        ...(selectedEffort === undefined ? {} : { reasoningEffort: selectedEffort }),
      }
      const gateway = await this.runtime.gatewayForRoute?.(selectedRoute)
      const capabilities = await this.runtime.capabilitiesForTurn?.() ?? EMPTY_CAPABILITIES
      const harnessPrompt = await this.runtime.systemPromptForRoute?.(selectedRoute)
      const modelId = gateway?.model ?? selectedRoute.modelId
      const sdkEffort = claudeSdkEffort(selectedRoute.reasoningEffort)
      const priorSdkSession = await loadSdkSessionMap(this.runtime.stateDirectory).then(map => sdkSessionFromCache(map, this.identity.runtimeSessionId))
      if (abort.signal.aborted) throw abortReason(abort.signal.reason)
      // The environment handed to the subprocess is also the list of credentials
      // it holds, and its stderr and thrown errors reach both the model and the
      // user, so the values are kept for the redactor below rather than built
      // inline and forgotten.
      const sdkEnvironment = buildClaudeSdkEnvironment(
        claudeSdkProcessEnvironment(this.runtime.stateDirectory, {
          ...this.runtime.environment,
          ...(gateway === undefined ? {} : {
            FREECODEGO_CLAUDE_BASE_URL: gateway.baseURL,
            FREECODEGO_CLAUDE_API_KEY: gateway.apiKey,
          }),
        }),
        this.runtime.stateDirectory,
        modelId,
      )
      knownSecrets = claudeSessionSecrets(sdkEnvironment)
      const sdkOptions = {
        cwd: this.options.workspace,
        model: modelId,
        env: sdkEnvironment,
        extraArgs: { bare: null },
        ...(this.runtime.environment?.FREECODEGO_CLAUDE_EXECUTABLE === undefined ? {} : { pathToClaudeCodeExecutable: this.runtime.environment.FREECODEGO_CLAUDE_EXECUTABLE }),
        includePartialMessages: true,
        permissionMode: this.options.readOnly ? 'plan' as const : 'default' as const,
        settingSources: [] as const,
        strictMcpConfig: true,
        mcpServers: {
          'freecodego-host': createHarnessMcpServer(
            this.options.workspace,
            capabilities,
            (bridge, op, input) => this.bridgeCall(bridge, op, input),
            questions => this.askUser(questions),
            knownSecrets,
          ),
        },
        toolAliases: { AskUserQuestion: HARNESS_ASK_USER_TOOL_ALIAS },
        stderr: (data: string) => { const text = redactSecrets(data.trim(), knownSecrets); if (text !== '') this.event('tool/progress', { method: 'stderr', detail: { text: text.slice(0, 2000) } }) },
        ...composeSystemPrompt(this.options.systemPrompt, harnessPrompt),
        abortController: abort,
        ...(priorSdkSession === undefined ? {} : { resume: priorSdkSession }),
        ...(sdkEffort === undefined ? {} : { effort: sdkEffort }),
        canUseTool: async (toolName: string, input: unknown) => {
          if (this.options.readOnly && !isCouncilReadOnlyTool(toolName)) {
            return { behavior: 'deny' as const, message: 'Engineering council children may use read-only review tools only.' }
          }
          // The SDK ships its own file/shell tools, which no Harness policy
          // reaches; the session's Harness sandbox mode is enforced here or not at
          // all. The council floor above is checked first, so a reader child gets
          // its allow list rather than this deny list.
          const sandboxDenial = claudeSandboxDenial(this.options, toolName)
          if (sandboxDenial !== undefined) return { behavior: 'deny' as const, message: sandboxDenial }
          const requestId = randomUUID()
          const pending = this.pending(this.pendingPermissions, requestId)
          this.event('permission/requested', { requestId, detail: { toolName, input } })
          const response = await pending
          const record = response !== null && typeof response === 'object' ? response as { type?: unknown; updatedInput?: unknown; message?: unknown } : {}
          return record.type === 'approved'
            ? { behavior: 'allow' as const, updatedInput: record.updatedInput ?? input }
            : { behavior: 'deny' as const, message: typeof record.message === 'string' ? record.message : 'The user rejected this tool call.' }
        },
      }
      let finalText = ''
      const sdkConversation = query({ prompt: content, options: sdkOptions } as unknown as Parameters<typeof query>[0]) as AsyncIterable<SdkMessage> & { interrupt?: () => Promise<void> }
      this.activeConversation = sdkConversation
      // A turn the SDK never finishes has no other way out: `for await` blocks
      // until the session yields or throws, and a wedged request does neither, so
      // the Host waits on this `prompt()` forever. The deadline turns that silence
      // into a throw, which the `catch` below reports as a failed turn.
      //
      // The wrapper is a plain async iterable and carries no `interrupt`, so the
      // session keeps holding the SDK conversation itself: `cancel()` reaches the
      // SDK through that method, and holding the wrapper here would silently
      // disconnect it.
      const conversation = withIdleDeadline(sdkConversation, CLAUDE_TURN_IDLE_MS)
      for await (const message of conversation) {
        if (message.type === 'stream_event') {
          const event = message.event as { type?: string; delta?: { type?: string; text_delta?: string; thinking_delta?: string } } | undefined
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text_delta === 'string') this.event('assistant/delta', { text: event.delta.text_delta })
          else if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && typeof event.delta.thinking_delta === 'string') this.event('assistant/reasoning/delta', { text: event.delta.thinking_delta, source: 'claude-agent-sdk', sourceLabel: 'Claude Agent SDK' })
          continue
        }
        if (message.type === 'assistant') {
          this.projectAssistantContent(message)
          this.projectToolUses(message)
        }
        if (message.type === 'user') this.projectUserToolResults(message)
        if (message.type === 'system' && message.subtype === 'init' && typeof message.session_id === 'string') {
          openedSdkSessionId = message.session_id
          continue
        }
        if (message.type === 'result') {
          if (typeof message.result === 'string' && message.result.trim() !== '') finalText = message.result
          if (message.subtype !== undefined && message.subtype !== 'success') throw new Error(`Claude SDK finished with ${message.subtype}`)
        }
      }
      this.event('assistant/final', { text: finalText })
      this.event('session/completed', { status: 'completed' })
      // Best-effort, like the aborted-turn write below: this turn already
      // produced its answer and announced that it completed, so a resume-cache
      // file that cannot be written must not turn it into a failed prompt — the
      // Agent records that as a failed turn and drops the answer it had already
      // streamed. The cost of a missed write is the one the cache exists to
      // avoid (the next turn opens a fresh SDK conversation), which is a
      // recoverable loss; an answer discarded mid-transcript is not.
      if (openedSdkSessionId !== undefined) await saveSdkSessionMap(this.runtime.stateDirectory, this.identity.runtimeSessionId, openedSdkSessionId).catch(() => undefined)
    } catch (error) {
      // An interrupted turn still learned its SDK session id: persist it so
      // the NEXT turn resumes the same conversation instead of silently
      // starting fresh and losing all prior context.
      if (abort.signal.aborted) {
        this.event('session/completed', { status: 'aborted' })
        if (openedSdkSessionId !== undefined) await saveSdkSessionMap(this.runtime.stateDirectory, this.identity.runtimeSessionId, openedSdkSessionId).catch(() => undefined)
        return
      }
      // A turn the deadline stopped is a failure, not a cancellation: nobody
      // asked for it, and announcing `aborted` here would settle the Host on a
      // cause the user never chose — the same false claim the Codex runtime used
      // to make about a refused interrupt. The throw is the whole channel: this
      // session is awaited by `prompt()`, so the Host is not listening for an
      // event and one would only leave a promise nobody handles.
      if (error instanceof StreamIdleTimeoutError) {
        // Best-effort and deliberately not awaited: the session that just went
        // silent is the last thing this path may wait on. Without it the SDK
        // keeps generating for a turn that is already over.
        void this.activeConversation?.interrupt?.().catch(() => undefined)
        throw new Error(redactSecrets(`Claude turn produced no SDK events for ${String(error.idleMs)}ms`, knownSecrets))
      }
      throw new Error(redactSecrets(error instanceof Error ? error.message : String(error), knownSecrets))
    } finally {
      this.activeConversation = undefined
      if (this.activeAbort === abort) this.activeAbort = undefined
      signal?.removeEventListener('abort', abortFromCaller)
      this.clear(this.pendingPermissions, 'Claude turn completed')
      this.clear(this.pendingQuestions, 'Claude turn completed')
      this.clear(this.pendingBridges, 'Claude turn completed')
    }
  }

  async cancel(reason = 'user'): Promise<void> {
    if (this.activeAbort !== undefined && !this.activeAbort.signal.aborted) this.activeAbort.abort(reason)
    await this.activeConversation?.interrupt?.().catch(() => undefined)
  }

  async respond(method: 'permission/respond' | 'question/respond' | 'bridge/respond', requestId: string, response: unknown): Promise<void> {
    const pending = method === 'permission/respond'
      ? this.pendingPermissions
      : method === 'question/respond' ? this.pendingQuestions : this.pendingBridges
    const value = pending.get(requestId)
    if (value !== undefined) {
      pending.delete(requestId)
      value.resolve(response)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.cancel('disposed')
    this.clear(this.pendingPermissions, 'Claude SDK session disposed')
    this.clear(this.pendingQuestions, 'Claude SDK session disposed')
    this.clear(this.pendingBridges, 'Claude SDK session disposed')
  }

  private event(method: string, params: Record<string, unknown>): void {
    this.sequence += 1
    this.options.onEvent?.({ method, params: { runtimeSessionId: this.identity.runtimeSessionId, harnessSessionId: this.identity.harnessSessionId, sequence: this.sequence, ...params }, binding: this.identity })
  }

  private pending(store: Map<string, Pending>, id: string): Promise<unknown> {
    // An id collision means two callers race on one request id; the previous
    // entry is resolved-and-removed before a fresh waiter is installed, so
    // the old promise is never left hanging forever.
    const existing = store.get(id)
    if (existing !== undefined) {
      store.delete(id)
      existing.reject(new Error('a newer request replaced this pending entry'))
    }
    const promise = Promise.withResolvers<unknown>()
    store.set(id, promise)
    return promise.promise
  }

  private async askUser(questions: readonly ClaudeQuestion[]): Promise<unknown> {
    const requestId = randomUUID()
    const pending = this.pending(this.pendingQuestions, requestId)
    this.event('question/requested', { requestId, request: { questions } })
    return await pending
  }

  private async bridgeCall(bridge: string, op: string, input: Record<string, unknown>): Promise<unknown> {
    const requestId = randomUUID()
    const pending = this.pending(this.pendingBridges, requestId)
    // `inlineImages` is honest here only because this session runs in the Host
    // process: the bridge response is a live object, not a size-capped protocol
    // frame, so a media tool's image can arrive as bytes and reach the model as
    // a real image block. A worker transport must not claim this.
    this.event('bridge/requested', { requestId, bridge, op, input, inlineImages: true, workspaceRoot: this.options.workspace })
    const response = await pending
    const record = response !== null && typeof response === 'object' ? response as { result?: unknown; error?: unknown } : {}
    if (record.error !== undefined && record.error !== null) throw new Error(typeof record.error === 'string' ? record.error : String(record.error))
    return record.result
  }

  private clear(store: Map<string, Pending>, reason: string): void {
    for (const pending of store.values()) pending.reject(new Error(reason))
    store.clear()
  }

  private projectToolUses(message: SdkMessage): void {
    const inner = message.message as { content?: unknown } | undefined
    if (!Array.isArray(inner?.content)) return
    for (const block of inner.content as Record<string, unknown>[]) {
      if (block.type === 'tool_use') this.event('tool/progress', { method: 'tool.requested', detail: { type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input } })
    }
  }

  private projectUserToolResults(message: SdkMessage): void {
    const inner = message.message as { content?: unknown } | undefined
    if (!Array.isArray(inner?.content)) return
    for (const block of inner.content as Record<string, unknown>[]) {
      if (block.type !== 'tool_result') continue
      this.event('tool/progress', {
        method: 'tool.completed',
        detail: {
          type: 'tool_result',
          id: String(block.tool_use_id ?? ''),
          content: block.content,
          isError: block.is_error === true,
        },
      })
    }
  }

  /** Some SDK/CLI combinations publish completed thinking only in assistant frames. */
  private projectAssistantContent(message: SdkMessage): void {
    const inner = message.message as { content?: unknown } | undefined
    if (!Array.isArray(inner?.content)) return
    for (const block of inner.content as Record<string, unknown>[]) {
      if (block.type !== 'thinking') continue
      const text = typeof block.thinking === 'string'
        ? block.thinking
        : typeof block.text === 'string' ? block.text : ''
      if (text !== '') this.event('assistant/reasoning/final', { text, source: 'claude-agent-sdk', sourceLabel: 'Claude Agent SDK' })
    }
  }
}

function loadSdkSessionMap(stateDirectory: string): Promise<unknown> {
  return readFile(join(stateDirectory, 'sdk-session-ids.json'), 'utf8').then(value => JSON.parse(value) as unknown).catch(() => undefined)
}

// All Claude sessions in one Host share this cache file. The read-merge-write
// sequence must serialize through a process-wide chain and write atomically,
// or two concurrent turn completions overwrite each other's resume entries
// (and a reader can observe a truncated file mid-write).
let sdkSessionWriteChain: Promise<void> = Promise.resolve()

function saveSdkSessionMap(stateDirectory: string, runtimeSessionId: string, sdkSessionId: string): Promise<void> {
  const write = sdkSessionWriteChain.then(async () => {
    const previous = await loadSdkSessionMap(stateDirectory)
    const cache = withSdkSessionCache(previous, runtimeSessionId, sdkSessionId)
    const target = join(stateDirectory, 'sdk-session-ids.json')
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(cache)}\n`, 'utf8')
    await rename(temporary, target).catch(async () => { await writeFile(target, `${JSON.stringify(cache)}\n`, 'utf8').catch(() => undefined) })
  })
  // The chain must survive a failed member: swallow so the next writer runs.
  sdkSessionWriteChain = write.catch(() => undefined)
  return write
}

/** Open one Claude Agent SDK session directly in the Harness Host process. */
export async function openClaudeRootRuntime(runtime: ClaudeRuntimeLaunchOptions, options: Omit<NativeRootAgentCreateOptions, 'engine'>): Promise<NativeAgentSession> {
  return await DirectClaudeSdkSession.open(runtime, options)
}

function claudeSdkProcessEnvironment(stateDirectory: string, environment: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const keys = [
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP',
    'LANG', 'LC_ALL', 'TERM', 'NO_COLOR', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ]
  return {
    ...Object.fromEntries(keys.flatMap(key => process.env[key] === undefined || process.env[key] === '' ? [] : [[key, process.env[key]]])),
    ...environment,
    FREECODEGO_CLAUDE_HOME: stateDirectory,
    HOME: stateDirectory,
    USERPROFILE: stateDirectory,
  }
}

const EMPTY_CAPABILITIES: ClaudeHarnessCapabilities = {
  mcpEnabled: false,
  skillEnabled: false,
  mcpTools: [],
  harnessTools: [],
}

function composeSystemPrompt(enginePrompt: string | undefined, harnessPrompt: string | undefined): { readonly systemPrompt?: { readonly type: 'preset'; readonly preset: 'claude_code'; readonly append: string } } {
  const append = [enginePrompt, harnessPrompt]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join('\n\n')
  return append === '' ? {} : { systemPrompt: { type: 'preset', preset: 'claude_code', append } }
}

function isCouncilReadOnlyTool(toolName: string): boolean {
  return toolName === 'Read'
    || toolName === 'Glob'
    || toolName === 'Grep'
    || /^mcp__freecodego-host__freecodego_harness_(?:read|glob|grep|engineering_graph_(?:status|search|explain|path|affected|overview|canvas)|engineering_memory_(?:search|get|timeline)|advisor_(?:status|notes))$/u.test(toolName)
}

function claudeSdkEffort(value: string | undefined): Exclude<ClaudeReasoningEffort, 'off'> | undefined {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
    ? value
    : undefined
}

function isClaudeReasoningEffort(value: unknown): value is ClaudeReasoningEffort {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
}

/**
 * The credentials this session hands to the Claude Code subprocess.
 *
 * `redactSecrets` needs the values themselves and not only their shapes: an
 * Anthropic-compatible gateway key is whatever string its provider chose, and a
 * subprocess that echoes its own environment prints one no pattern recognizes.
 * `buildClaudeSdkEnvironment` has already decided which variables carry a
 * credential, so the values are read back from what it produced rather than
 * guessed from the raw input.
 */
function claudeSessionSecrets(environment: Readonly<Record<string, string>>): readonly (string | undefined)[] {
  return [environment.ANTHROPIC_API_KEY, environment.ANTHROPIC_AUTH_TOKEN]
}

/** Preserve the caller's cancellation cause without admitting arbitrary thrown values. */
function abortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(typeof reason === 'string' && reason !== '' ? reason : 'native Claude turn interrupted')
}

export function claudeRuntimeEnvironment(stateDirectory: string, environment?: Readonly<Record<string, string>>): Record<string, string> {
  return claudeSdkProcessEnvironment(stateDirectory, environment) as Record<string, string>
}
