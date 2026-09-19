import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { MAX_WORKER_FRAME_BYTES, workerFrame } from './frame-budget.ts'
import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { redactSecrets } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'
import { mcpToolResult } from './mcp-tool-result.ts'
import { approvalResponse, isApprovalMethod } from './approval-response.ts'
import { questionResponse } from './question-response.ts'
import { codexThreadSandboxParams } from './sandbox-mode.ts'
import { harnessMcpRoute } from './harness-mcp-dispatch.ts'

/** One JSONL frame on the Host↔App-Server channel. Untagged: both directions
 * share the shape, and `undefined` fields mean "absent" on the wire. */
type Rpc = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number | string; message: string }
}
let sequence = 0
let rpcId = 0
let child: ChildProcessWithoutNullStreams | undefined
let threadId: string | undefined
// The turn in flight, as the App Server names it. `turn/interrupt` marks both
// `threadId` and `turnId` required, so a cancel that cannot name its turn is a
// request the App Server rejects instead of an interrupt it performs.
let turnId: string | undefined
let harnessSessionId: string | undefined
let modelId: string | undefined
/** The provider the App Server itself runs on. Not the Host's route label. */
let modelProvider: string | undefined
/** The route the Host selected, echoed back in every Host-facing report. */
let selectedProvider: string | undefined
let stderr = ''
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
const approvals = new Map<string, (value: unknown) => void>()
const questions = new Map<string, (value: unknown) => void>()
const pendingBridges = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
const MANAGED_MCP_START = '# freecodego-managed-mcp:start'
const MANAGED_MCP_END = '# freecodego-managed-mcp:end'
/**
 * How long an App Server gets to finish exiting after its stdin is closed.
 *
 * Only a fallback: measured against the shipped artifact it exits in 14-274ms
 * once stdin reaches EOF, including the write that completes its rollout. The
 * margin is for a loaded machine, not for the normal case.
 */
const DISPOSE_GRACE_MS = 5_000
let capabilities: CapabilityConfiguration = { mcpEnabled: false, skillEnabled: false, skillRoots: [], mcpTools: [], harnessTools: [] }
let capabilityEnvironment: Record<string, string> = {}
let harnessMcpServer: Server | undefined
let harnessMcpUrl: string | undefined
const harnessMcpToken = randomBytes(32).toString('base64url')

type CapabilityConfiguration = {
  readonly mcpEnabled: boolean
  readonly skillEnabled: boolean
  readonly skillRoots: readonly string[]
  /** Host-registered MCP tools; connection configuration never reaches the Worker. */
  readonly mcpTools: readonly CapabilityTool[]
  readonly harnessTools: readonly CapabilityTool[]
}

type CapabilityTool = { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> }

function explicitModel(): string | undefined {
  return modelId === undefined || modelId === '' || modelId === 'codex-auto' ? undefined : modelId
}

function usesOpenAiBridge(): boolean { return process.env.FREECODEGO_CODEX_PROVIDER_OVERRIDE === 'openai' }

/**
 * The provider name to hand the App Server, or `undefined` to let it choose.
 *
 * The App Server's provider registry is a different namespace from the Host's
 * route label. It holds only what the binary was built with — `openai`,
 * `ollama`, `lmstudio` — and every Harness route id (`codex`,
 * `openai-codex`, `freecodego`) is absent from it, so handing the route back
 * aborts the session with `Model provider … not found`. The one route the App
 * Server does need to be told about is the loopback bridge, which it reaches
 * through its built-in `openai` provider.
 */
function appServerProvider(): string | undefined {
  return usesOpenAiBridge() ? 'openai' : undefined
}

/** Preserve the real Harness route while Codex talks to one local OpenAI facade. */
function appServerModel(reasoningEffort: string): string | undefined {
  const model = explicitModel()
  if (model === undefined || !usesOpenAiBridge()) return model
  const provider = (selectedProvider ?? 'freecodego').trim()
  const encodedProvider = Buffer.from(provider, 'utf8').toString('base64url')
  const encodedModel = Buffer.from(model, 'utf8').toString('base64url')
  const effort = reasoningEffort === 'off' || reasoningEffort === 'low' || reasoningEffort === 'medium' || reasoningEffort === 'high' || reasoningEffort === 'xhigh' || reasoningEffort === 'max'
    ? `.${reasoningEffort}`
    : ''
  return `freecodego-route:${encodedProvider}.${encodedModel}${effort}`
}

function selectedReasoningEffort(value: unknown): 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' ? value : 'high'
}

/** Codex App Server does not have an off mode; keep its orchestration minimal. */
function codexReasoningEffort(value: unknown): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  const effort = selectedReasoningEffort(value)
  return effort === 'off' ? 'low' : effort
}

/**
 * Map the App Server's turn status onto the Host's terminal vocabulary.
 *
 * `turn/completed` carries the engine's own word. The Host reads only
 * `completed`, `cancelled` and `aborted`, and treats anything else as a protocol
 * violation: it discards the runtime session and records the turn as failed. The
 * App Server's word for the turn a `turn/interrupt` ended is `interrupted`, so
 * passing the status through tore down a healthy session on every cancel — the
 * cost landed on the *next* turn, which had to open a replacement runtime. An
 * unreadable status becomes `failed`, the outcome the Host already recorded for
 * it.
 */
function codexTurnStatus(value: unknown): 'completed' | 'cancelled' | 'failed' {
  const status = asString(value)
  if (status === 'completed') return 'completed'
  if (status === 'interrupted') return 'cancelled'
  return 'failed'
}

/**
 * The App Server's own words for a turn it could not finish.
 *
 * `Turn.error` is documented as "only populated when the Turn's status is
 * failed", and it is the only place a reason is published: the protocol
 * declares no `turn/failed` notification, so a failed turn arrives as
 * `turn/completed` with this object attached to the turn.
 *
 * `message` is required and `additionalDetails` is optional, and in practice
 * the second is the more specific half -- a turn cut off by an unreachable
 * model reports `message: "Reconnecting... 5/5"` beside
 * `additionalDetails: "request timed out"`. Both are kept when they differ,
 * because either can be the only informative one.
 *
 * Both are redacted: the model client produces them, and that is a producer
 * holding credentials -- a refused request can quote itself back in the error.
 *
 * @param error - the `turn.error` value of a `turn/completed` notification.
 * @returns a non-empty explanation for the Host, which rejects the turn with it.
 */
function appServerTurnFailure(error: unknown): string {
  const detail = asRecord(error)
  const message = asString(detail.message) ?? ''
  const additional = asString(detail.additionalDetails) ?? ''
  if (message === '') return additional === '' ? 'Codex turn failed' : redactAppServerDetail(additional)
  // `additionalDetails` is redundant when the message already contains it.
  const combined = additional === '' || message.includes(additional) ? message : `${message} (${additional})`
  return redactAppServerDetail(combined)
}

function codexConfig(systemPrompt: unknown, reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'): Record<string, unknown> {
  return {
    model_reasoning_effort: reasoningEffort,
    model_reasoning_summary: 'detailed',
    ...(typeof systemPrompt === 'string' && systemPrompt.trim() !== '' ? { developer_instructions: systemPrompt } : {}),
  }
}

function send(message: unknown): void {
  // One choke point for everything this worker writes. The ceiling lives in
  // `frame-budget.ts`, and a frame over it is *replaced* there rather than
  // truncated into a line the Host cannot parse.
  const frame = workerFrame(message)
  // Diagnostics go to stderr: stdout carries frames only.
  if (frame.replaced) process.stderr.write(`freecodego-codex-worker: replaced an oversized frame (${String(frame.originalBytes)} bytes over the ${String(MAX_WORKER_FRAME_BYTES)}-byte ceiling)\n`)
  process.stdout.write(frame.line)
}
function event(method: string, params: Record<string, unknown> = {}): void {
  if (threadId === undefined || harnessSessionId === undefined) return
  send({ method, params: { runtimeSessionId: threadId, harnessSessionId, sequence: ++sequence, ...params } })
}
function request(method: string, params: unknown): Promise<unknown> {
  if (child === undefined) return Promise.reject(new Error('Codex app-server is not running'))
  const id = ++rpcId
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  try {
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  } catch (error) {
    // A synchronous EPIPE must not leak the pending entry until 'close'.
    pending.delete(id)
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  return promise
}
const CODEX_TURN_IDLE_MS = 15 * 60_000

/** Specs shorten the idle window through this env name. It is not a product
 * setting: production always uses `CODEX_TURN_IDLE_MS`. */
function turnIdleMs(): number {
  const override = Number(process.env.FREECODEGO_CODEX_TURN_IDLE_MS)
  return Number.isFinite(override) && override > 0 ? override : CODEX_TURN_IDLE_MS
}

/** Fail the in-flight turn when the app-server goes silent. The window is idle:
 * every app-server frame during a live turn resets it, matching the Claude
 * watchdog. A hung (but alive) app-server otherwise leaves the Host waiting
 * forever after the first `turn/start` acknowledgement. */
function armTurnWatchdog(): void {
  if (turnWatchdog !== undefined) clearTimeout(turnWatchdog)
  turnWatchdog = setTimeout(() => {
    turnWatchdog = undefined
    const hungTurn = turnId
    turnId = undefined
    const message = 'Codex turn produced no events within the watchdog window'
    clearPendingBridges(message)
    event('session/completed', { status: 'failed', message })
    // Best-effort, and not awaited: a process that has already gone quiet is
    // the last thing this path should wait on. The Host has settled the turn.
    if (hungTurn !== undefined && threadId !== undefined) {
      void request('turn/interrupt', { threadId, turnId: hungTurn }).catch(() => undefined)
    }
  }, turnIdleMs())
}
function disarmTurnWatchdog(): void {
  if (turnWatchdog !== undefined) { clearTimeout(turnWatchdog); turnWatchdog = undefined }
}
/** Reset the idle window only while a turn is open. `receiveRpc` also sees
 * initialize / thread/start / models/refresh replies; arming those would fire
 * an unowned `session/completed` after the idle window. */
function refreshTurnWatchdog(): void {
  if (turnWatchdog === undefined && turnId === undefined) return
  armTurnWatchdog()
}
let turnWatchdog: ReturnType<typeof setTimeout> | undefined
function reply(id: string, result?: unknown, error?: Error): void { send(error === undefined ? { id, result } : { id, error: { code: 'CODEX_WORKER', message: redactAppServerDetail(error.message) } }) }
function start(): ChildProcessWithoutNullStreams {
  if (child !== undefined) return child
  const executable = process.env.FREECODEGO_CODEX_APP_SERVER
  if (executable === undefined || executable.length === 0) throw new Error('FREECODEGO_CODEX_APP_SERVER is required and must be set from a verified runtime manifest')
  // The sealed app-server binary defaults to stdio://. Its `--stdio` flag is
  // only accepted by the npm `codex app-server` wrapper, not by this artifact.
  const args = process.env.FREECODEGO_CODEX_APP_SERVER_ARGS?.split('\u001f').filter(Boolean) ?? []
  const codexHome = process.env.FREECODEGO_CODEX_HOME
  if (codexHome === undefined || codexHome.length === 0) throw new Error('FREECODEGO_CODEX_HOME is required and must be a plugin-owned state directory')
  child = spawn(executable, args, {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      CODEX_HOME: codexHome,
      ...(process.env.OPENAI_API_KEY === undefined ? {} : { OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
      ...(process.env.OPENAI_BASE_URL === undefined ? {} : { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL }),
      ...capabilityEnvironment,
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    // A sealed app-server can print an upgrade notice, a crash banner, or any
    // other plain text on stdout. Only parse lines that look like protocol
    // frames; anything else goes to the stderr channel as diagnostics instead
    // of failing a healthy session.
    const trimmed = line.trim()
    if (trimmed === '' || !(trimmed.startsWith('{') || trimmed.startsWith('['))) {
      if (trimmed !== '') stderr = `${stderr}${trimmed}\n`.slice(-16 * 1024)
      return
    }
    try { receiveRpc(JSON.parse(trimmed) as Rpc) } catch (error) {
      // Malformed JSON on a frame-shaped line is still suspect: log it, but a
      // single bad line must not reject the session while requests are in
      // flight. Only protocol errors surfaced through request rejections and
      // the close handler terminate the session.
      stderr = `${stderr}unparsable stdout frame: ${String(error)}\n`.slice(-16 * 1024)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16 * 1024) })
  child.stdin.on('error', () => undefined)
  const instance = child
  child.on('close', () => {
    // A dispose+recreate race must not let this stale close callback clear the
    // freshly spawned child or fail its new session.
    if (child !== instance) return
    disarmTurnWatchdog()
    const detail = redactAppServerDetail(stderr.trim())
    const error = new Error(detail === '' ? 'Codex app-server exited' : `Codex app-server exited: ${detail}`)
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    clearPendingBridges('Codex app-server exited')
    child = undefined
    event('session/failed', { message: error.message })
  })
  return child
}

/** Seed the isolated Codex home with the user's existing login/provider setup.
 * Secrets remain in the plugin-owned directory and are never sent over the
 * Harness protocol. Existing plugin state is preserved. */
async function prepareCodexHome(): Promise<void> {
  const target = process.env.FREECODEGO_CODEX_HOME
  if (!target) return
  await mkdir(target, { recursive: true })
  if (process.env.FREECODEGO_CODEX_SYNC_GLOBAL_AUTH === '1') {
    const home = process.env.CODEX_GLOBAL_HOME?.trim() || join(process.env.USERPROFILE || process.env.HOME || '', '.codex')
    if (home && home !== target) {
      // Model routing is supplied per turn by FreeCodeGo. Copying a global
      // config.toml would also import user-global MCP definitions and bypass
      // the Host-owned tool policy, so only the login credential is seeded.
      for (const name of ['auth.json']) {
        const source = join(home, name)
        const destination = join(target, name)
        try { await access(destination); continue } catch { /* seed missing files only */ }
        try { await copyFile(source, destination) } catch { /* unauthenticated installs remain explicit */ }
      }
    }
  }
  await ensureHarnessMcpServer()
  await writeManagedMcpConfig(target)
}

/** Replace only the FreeCodeGo-delimited MCP segment in the isolated Codex config. */
async function writeManagedMcpConfig(home: string): Promise<void> {
  const target = join(home, 'config.toml')
  let existing = ''
  try { existing = await readFile(target, 'utf8') } catch { /* first plugin-owned config */ }
  const start = existing.indexOf(MANAGED_MCP_START)
  const end = existing.indexOf(MANAGED_MCP_END)
  const hasManagedSegment = start >= 0 && end >= start
  if (hasManagedSegment) existing = `${existing.slice(0, start)}${existing.slice(end + MANAGED_MCP_END.length)}`.trimEnd()
  existing = stripMcpServerTables(existing)
  const rendered = renderManagedMcpConfig()
  if (rendered === '' && !hasManagedSegment) return
  // Write to a sibling temp file first: a crash mid-write must never leave a
  // truncated config.toml for the next session to inherit.
  const temporary = `${target}.tmp-${process.pid}`
  await writeFile(temporary, `${existing}${existing === '' || rendered === '' ? '' : '\n\n'}${rendered}${rendered === '' ? '' : '\n'}`, 'utf8')
  await rename(temporary, target)
}

function renderManagedMcpConfig(): string {
  capabilityEnvironment = {}
  if (harnessMcpUrl === undefined) return ''
  // User MCP URLs, commands, headers, and environment values are owned by
  // the Host. Codex receives one authenticated loopback bridge only.
  capabilityEnvironment.FREECODEGO_CODEX_HARNESS_MCP_TOKEN = harnessMcpToken
  return [
    MANAGED_MCP_START,
    '[mcp_servers.freecodego-harness]',
    `url = ${tomlString(harnessMcpUrl)}`,
    'bearer_token_env_var = "FREECODEGO_CODEX_HARNESS_MCP_TOKEN"',
    MANAGED_MCP_END,
  ].join('\n\n')
}

function tomlString(value: string): string { return JSON.stringify(value) }

/**
 * Remove persisted MCP tables written by earlier plugin versions or global config sync.
 *
 * TOML ignores whitespace around the dots of a dotted key, so every test below
 * tolerates it: `[mcp_servers . docs]` names the same table as
 * `[mcp_servers.docs]`, and a strip that only matched the tight spelling would
 * leave that user definition in the file — the exact bypass this function
 * exists to prevent, because Codex would then load a tool the Host never
 * approved while the Host's own inventory knows nothing about it.
 */
function stripMcpServerTables(value: string): string {
  let inMcpSection = false
  const retained: string[] = []
  for (const line of value.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/)
    if (header !== null) {
      inMcpSection = /^mcp_servers(?:\s*\.|$)/.test((header[1] ?? '').trim())
      if (!inMcpSection) retained.push(line)
      continue
    }
    // Dotted assignments define servers too (`mcp_servers.docs.url = "…"`), so
    // the inline-table form is not the only line that has to go.
    if (!inMcpSection && !/^\s*mcp_servers\s*(?:\.|=)/.test(line)) retained.push(line)
  }
  return retained.join('\n').trimEnd()
}

function readCapabilities(value: unknown): CapabilityConfiguration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { mcpEnabled: false, skillEnabled: false, skillRoots: [], mcpTools: [], harnessTools: [] }
  const input = value as Record<string, unknown>
  return {
    mcpEnabled: input.mcpEnabled === true,
    skillEnabled: input.skillEnabled === true,
    skillRoots: input.skillEnabled === true ? strings(input.skillRoots) : [],
    mcpTools: input.mcpEnabled === true ? readHarnessTools(input.mcpTools) : [],
    harnessTools: readHarnessTools(input.harnessTools),
  }
}

function readHarnessTools(value: unknown): CapabilityTool[] {
  if (!Array.isArray(value)) return []
  const tools: CapabilityTool[] = []
  const names = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const tool = item as Record<string, unknown>
    if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(tool.name) || names.has(tool.name)) continue
    names.add(tool.name)
    tools.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : tool.name,
      parameters: typeof tool.parameters === 'object' && tool.parameters !== null && !Array.isArray(tool.parameters) ? tool.parameters as Record<string, unknown> : { type: 'object', properties: {} },
    })
  }
  return tools
}

function strings(value: unknown): readonly string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [] }

/** Every frame and every result is parsed JSON, so a field is `unknown` until it
 * is read through one of these; the app-server's schemas are the only promise
 * about its shape, and a wrong shape must degrade, not throw. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }

/** A wire value as text without ever producing `[object Object]`: a structured
 * rejection is worth reading, a stringified object is not. */
function asMessage(value: unknown): string {
  const direct = asString(value)
  if (direct !== undefined) return direct
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

async function configureCodexSkills(): Promise<void> {
  await request('skills/extraRoots/set', { extraRoots: capabilities.skillEnabled ? capabilities.skillRoots : [] })
}

/** Start a loopback-only MCP service that forwards Harness-owned tools to the parent Agent. */
async function ensureHarnessMcpServer(): Promise<void> {
  if (harnessMcpUrl !== undefined || (capabilities.harnessTools.length === 0 && capabilities.mcpTools.length === 0 && !capabilities.skillEnabled)) return
  const server = createServer((request, response) => { void handleHarnessMcpRequest(request, response).catch((error: unknown) => { mcpError(response, undefined, error) }) })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.close(() => undefined); reject(error) }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(() => undefined); reject(new Error('Codex Harness MCP server has no TCP address')); return }
      harnessMcpServer = server
      harnessMcpUrl = `http://127.0.0.1:${address.port}/mcp`
      resolve()
    })
  })
}

async function handleHarnessMcpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/mcp' || request.headers.authorization !== `Bearer ${harnessMcpToken}`) {
    response.writeHead(404); response.end(); return
  }
  const body = await readHttpBody(request)
  const message = JSON.parse(body) as { id?: string | number; method?: string; params?: unknown }
  // A notification carries no `id`, and JSON-RPC forbids answering one. The App
  // Server sends `notifications/cancelled` when it abandons a tool call and
  // `notifications/roots/list_changed` when its roots move -- both names are in
  // its binary -- and an `id: null` error is protocol noise it cannot route.
  // Cancellation needs no unwinding here: the Host aborts the call through the
  // turn's own signal, and `clearPendingBridges` releases the rest.
  if (message.id === undefined) { response.writeHead(202); response.end(); return }
  if (message.method === 'initialize') {
    mcpResult(response, message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'freecodego-harness', version: '1.0.0' },
    }); return
  }
  if (message.method === 'tools/list') {  mcpResult(response, message.id, { tools: harnessMcpTools() }); return }
  if (message.method === 'tools/call') {
    const params = typeof message.params === 'object' && message.params !== null && !Array.isArray(message.params) ? message.params as Record<string, unknown> : {}
    const name = typeof params.name === 'string' ? params.name : ''
    const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {}
    try {
      const result = await invokeHarnessMcpTool(name, args)
      mcpResult(response, message.id, mcpToolResult(result)); return
    } catch (error) {
      // A failed Host tool's own error text arrives here unmasked — the Host
      // bridge rethrows it without a catch — and an MCP error result is text the
      // Codex model reads, so a tool that touched a credential would otherwise
      // print it into this session's context.
      mcpResult(response, message.id, { content: [{ type: 'text', text: redactAppServerDetail(error instanceof Error ? error.message : String(error)) }], isError: true }); return
    }
  }
  // -32601 is JSON-RPC's "method not found", and the code this worker already
  // returns for an App Server request it does not implement. -32000 is not a
  // JSON-RPC code at all, and it is reserved here for a request that could not
  // be read.
  mcpError(response, message.id, new Error(`unsupported Harness MCP method ${String(message.method)}`), -32601)
}

function harnessMcpTools(): Record<string, unknown>[] {
  const mcpTools = capabilities.mcpEnabled ? capabilities.mcpTools : []
  const mcpNames = new Set(mcpTools.map(tool => tool.name))
  return [
    // MCP tools use a distinct bridge operation so they retain the Host's
    // enabled-state, policy, audit, and cancellation checks.
    ...capabilities.harnessTools.filter(tool => !mcpNames.has(tool.name)).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
    ...mcpTools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
    ...(capabilities.skillEnabled ? [
      { name: 'freecodego_skill_discover', description: 'List enabled DeepSeek Harness Skills.', inputSchema: { type: 'object', properties: {} } },
      { name: 'freecodego_skill_load', description: 'Load one enabled DeepSeek Harness Skill.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    ] : []),
  ]
}

/**
 * Serve one `tools/call` by routing it to the Host bridge that owns it.
 *
 * The decision itself lives in `harness-mcp-dispatch.ts`, which re-checks the
 * capability that advertised the name: this call path takes a bare name, so an
 * unadvertised one — a Skill after Skills were switched off, say — must be
 * refused here and not merely hidden from `tools/list`.
 */
async function invokeHarnessMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const route = harnessMcpRoute(capabilities, name)
  if (route.bridge === 'skill') return await bridgeCall('skill', route.op, route.op === 'load' ? { name: args.name } : {})
  if (route.bridge === 'mcp') return await bridgeCall('mcp', 'execute', { name, arguments: args })
  return await bridgeCall('tool', 'execute', { name, arguments: args })
}

async function bridgeCall(bridge: string, op: string, input: Record<string, unknown>): Promise<unknown> {
  const requestId = randomUUID()
  const promise = Promise.withResolvers<unknown>()
  pendingBridges.set(requestId, promise)
  event('bridge/requested', { requestId, bridge, op, input })
  return await promise.promise
}

/** Release loopback MCP requests promptly when their owning turn ends. */
function clearPendingBridges(reason: string): void {
  for (const pending of pendingBridges.values()) pending.reject(new Error(reason))
  pendingBridges.clear()
}

function mcpResult(response: ServerResponse, id: string | number | undefined, result: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }))
}

function mcpError(response: ServerResponse, id: string | number | undefined, error: unknown, code = -32000): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  // Masked for the same reason as the tool failure above, plus one of its own:
  // a `JSON.parse` failure quotes the text it choked on, so the raw request body
  // would ride out inside the message.
  response.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message: redactAppServerDetail(error instanceof Error ? error.message : String(error)) } }))
}

function readHttpBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
    request.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    request.on('error', reject)
  })
}
function receiveRpc(message: Rpc): void {
  // Any app-server output during a live turn counts as liveness. The terminal
  // `turn/completed` frame is not liveness: it ends the turn, so it must not
  // re-arm a timer that the handler is about to clear.
  if (message.method === 'turn/completed') disarmTurnWatchdog()
  else refreshTurnWatchdog()
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const call = pending.get(message.id)
    if (call === undefined) return
    pending.delete(message.id)
    if (message.error === undefined) call.resolve(message.result)
    else call.reject(new Error(redactAppServerDetail(message.error.message)))
    return
  }
  if (message.id !== undefined && message.method !== undefined) {
    const id = message.id
    const requestedQuestions = normalizeQuestions(message.params)
    if (requestedQuestions !== undefined) {
      const requestId = `question-${id}`
      // The Host answers in the shared `AskUserQuestionAnswer` shape; the App
      // Server declares `ToolRequestUserInputResponse`. Translating here rather
      // than forwarding is the same fix `approvalResponse` carries for the
      // approval methods, and for the same reason: a neutral shape the App
      // Server cannot deserialize is an answer the model never receives.
      questions.set(requestId, (value) => { sendRpc({ id, result: questionResponse(value) }) })
      event('question/requested', { requestId, request: { questions: requestedQuestions } })
      return
    }
    const method = message.method
    // Only the methods that declare a decision the user can make become a
    // prompt. The rest are protocol handshakes (`item/tool/call`,
    // `attestation/generate`, `account/chatgptAuthTokens/refresh`,
    // `mcpServer/elicitation/request`) whose responses require data no approval
    // outcome carries: asking the user to "approve" them produced a prompt they
    // could not answer and an invalid result. An explicit error is diagnosable;
    // a meaningless result was not.
    if (!isApprovalMethod(method)) {
      sendRpc({ id, error: { code: -32601, message: `FreeCodeGo does not implement the Codex App Server request "${method}"` } })
      return
    }
    const approvalId = `approval-${id}`
    // The answer is translated per method: this transport's neutral outcome is
    // not the App Server's response vocabulary, and sending it verbatim was a
    // contract the App Server's own schemas do not define.
    const requestParams = message.params
    approvals.set(approvalId, (value) => { sendRpc({ id, result: approvalResponse(method, value, requestParams) }) })
    event('permission/requested', { approvalId, method, detail: message.params ?? {} })
    return
  }
  const params = asRecord(message.params)
  if (message.method === 'item/agentMessage/delta') event('assistant/delta', { text: asString(params.delta) ?? '' })
  else if (message.method === 'item/reasoning/textDelta' || message.method === 'item/reasoning/summaryTextDelta') event('assistant/reasoning/delta', { text: asString(params.delta) ?? asString(params.text) ?? '', source: 'codex-app-server', sourceLabel: 'Codex App Server' })
  else if (message.method === 'item/reasoning/summaryPartAdded') {
    const part = asRecord(params.part)
    const added = asString(part.text) ?? asString(part.content) ?? ''
    if (added !== '') event('assistant/reasoning/delta', { text: added, source: 'codex-app-server', sourceLabel: 'Codex App Server' })
  }
  else if (message.method === 'item/completed' && asRecord(params.item).type === 'agentMessage') event('assistant/final', { text: asString(asRecord(params.item).text) ?? '' })
  else if (message.method === 'item/completed' && asRecord(params.item).type === 'reasoning') {
    const item = asRecord(params.item)
    const completed = typeof item.text === 'string'
      ? item.text
      : Array.isArray(item.summary) ? item.summary.map(part => asString(asRecord(part).text) ?? '').join('') : ''
    if (completed !== '') event('assistant/reasoning/final', { text: completed, source: 'codex-app-server', sourceLabel: 'Codex App Server' })
  }
  else if (message.method === 'turn/started') turnId = asString(asRecord(params.turn).id) ?? turnId
  else if (message.method === 'turn/completed') {
    disarmTurnWatchdog()
    clearPendingBridges('Codex turn completed')
    turnId = undefined
    // This notification is a turn's only terminal channel. The protocol declares
    // no `turn/failed`, so a turn that dies arrives here as well, carrying
    // `status: 'failed'` with `turn.error` beside it. Reading the status alone
    // threw that reason away, and the Host renders a reasonless failure as the
    // bare string `native turn finished with status "failed"`.
    const status = codexTurnStatus(asRecord(params.turn).status)
    const reason = status === 'failed' ? appServerTurnFailure(asRecord(params.turn).error) : undefined
    event('session/completed', reason === undefined ? { status } : { status, message: reason })
  }
  else if (message.method !== undefined) event('tool/progress', { method: message.method, detail: message.params ?? {} })
}
function sendRpc(message: Rpc): void { child?.stdin.write(`${JSON.stringify(message)}\n`) }

/** Remove app-server credentials before diagnostics or tool results leave this
 * isolated worker. It knows both the shapes a credential takes and the exact
 * values this process holds (`OPENAI_API_KEY`, the bridge token, the capability
 * environment), because a tool that echoes its own environment defeats shape
 * rules on their own. */
function redactAppServerDetail(value: string): string {
  return redactSecrets(value, [
    process.env.OPENAI_API_KEY,
    harnessMcpToken,
    ...Object.values(capabilityEnvironment),
  ])
}
/**
 * Terminate one App Server together with every tool subprocess it started.
 *
 * On Windows `kill()` only terminates the app-server itself; its tool
 * subprocesses survive as orphans unless the whole tree is killed. This is the
 * fallback path only — see `stopAppServer`.
 */
function killAppServerTree(dying: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && dying.pid !== undefined) {
    spawn('taskkill', ['/pid', String(dying.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined)
    return
  }
  dying.kill()
}

/**
 * Stop one App Server, orderly first, and wait for it to be gone.
 *
 * The protocol declares no shutdown method — checked across all 95 client
 * requests — so closing stdin is the only orderly stop available. It is also the
 * only one that preserves the thread's rollout: the App Server flushes it as it
 * exits, and that file is what makes the thread resumable. Force-killing the
 * tree instead leaves the rollout at zero bytes, so disposing a session could
 * destroy the very conversation the Host keeps a thread id for. Measured
 * directly: forced = 0 bytes, EOF = complete in 14-274ms.
 *
 * The tree kill remains the fallback for an App Server that ignores EOF, since
 * otherwise it would outlive this worker.
 *
 * @param dying - the child to stop.
 */
async function stopAppServer(dying: ChildProcessWithoutNullStreams): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (dying.exitCode !== null || dying.signalCode !== null) { resolve(); return }
    dying.once('close', () => { resolve() })
  })
  dying.stdin.end()
  const deadline = setTimeout(() => { killAppServerTree(dying) }, DISPOSE_GRACE_MS)
  try {
    await exited
  } finally {
    clearTimeout(deadline)
  }
}

async function handle(message: { id: string; method: string; params: Record<string, unknown> }): Promise<unknown> {
  if (message.method === 'initialize') return { protocolAbi: message.params.protocolVersion, engines: ['codex'], runtimeVersion: 'codex-app-server-worker/1' }
  if (message.method === 'host/configure') {
    capabilities = readCapabilities(message.params)
    if (child !== undefined) {
      await ensureHarnessMcpServer()
      const home = process.env.FREECODEGO_CODEX_HOME
      if (home !== undefined && home !== '') await writeManagedMcpConfig(home)
      await configureCodexSkills()
    }
    return null
  }
  if (message.method === 'session/create') {
    await prepareCodexHome(); start()
    harnessSessionId = asString(message.params.harnessSessionId)
    modelId = asString(message.params.modelId)
    selectedProvider = asString(message.params.provider)
    modelProvider = appServerProvider()
    const selectedEffort = selectedReasoningEffort(message.params.reasoningEffort)
    await request('initialize', { clientInfo: { name: 'DeepSeek Harness', version: '1' }, capabilities: {} })
    sendRpc({ method: 'initialized', params: {} })
    await configureCodexSkills()
    const started = asRecord(await request('thread/start', {
      cwd: message.params.workspace,
      // Deliberately not `ephemeral`. The Host persists the returned thread id
      // and reopens the conversation through `session/resume`, and an ephemeral
      // thread is never written to the rollout store: resuming one answers
      // `no rollout found for thread id …`, even after a completed turn, because
      // the rollout is what persistence consists of. `ThreadResumeParams` has no
      // `ephemeral` field, so a thread started ephemeral can never be made
      // resumable later — this is the only point where the choice exists, and
      // resumability is the contract the id in `session/started` implies.
      ...codexThreadSandboxParams(message.params),
      ...(appServerModel(selectedEffort) === undefined ? {} : { model: appServerModel(selectedEffort) }),
      ...(modelProvider ? { modelProvider } : {}),
      config: codexConfig(message.params.systemPrompt, codexReasoningEffort(selectedEffort)),
    }))
    const startedThread = asRecord(started.thread)
    const startedThreadId = startedThread.id
    if (typeof startedThreadId !== 'string' || startedThreadId === '') throw new Error('Codex app-server returned no thread id for thread/start')
    threadId = startedThreadId
    if (!usesOpenAiBridge()) {
      modelId = asString(started.model) ?? asString(startedThread.model) ?? modelId
      modelProvider = asString(started.modelProvider) ?? asString(startedThread.modelProvider) ?? modelProvider
    }
    event('session/started', { model: modelId ?? '', provider: selectedProvider ?? modelProvider ?? '' })
    return { runtimeSessionId: threadId, modelId, provider: selectedProvider ?? modelProvider }
  }
  if (message.method === 'session/resume') {
    await prepareCodexHome(); start()
    harnessSessionId = asString(message.params.harnessSessionId)
    modelId = asString(message.params.modelId)
    selectedProvider = asString(message.params.provider)
    modelProvider = appServerProvider()
    const resumeId = message.params.runtimeSessionId
    if (typeof resumeId !== 'string' || resumeId.length === 0) throw new Error('Codex resume requires a persisted runtimeSessionId')
    const selectedEffort = selectedReasoningEffort(message.params.reasoningEffort)
    await request('initialize', { clientInfo: { name: 'DeepSeek Harness', version: '1' }, capabilities: {} })
    sendRpc({ method: 'initialized', params: {} })
    await configureCodexSkills()
    const resumed = asRecord(await request('thread/resume', {
      threadId: resumeId,
      cwd: message.params.workspace,
      ...codexThreadSandboxParams(message.params),
      ...(appServerModel(selectedEffort) === undefined ? {} : { model: appServerModel(selectedEffort) }),
      ...(modelProvider ? { modelProvider } : {}),
      config: codexConfig(message.params.systemPrompt, codexReasoningEffort(selectedEffort)),
    }))
    const resumedThread = asRecord(resumed.thread)
    threadId = asString(resumedThread.id) ?? resumeId
    if (!usesOpenAiBridge()) {
      modelId = asString(resumed.model) ?? asString(resumedThread.model) ?? modelId
      modelProvider = asString(resumed.modelProvider) ?? asString(resumedThread.modelProvider) ?? modelProvider
    }
    event('session/started', { model: modelId ?? '', provider: selectedProvider ?? modelProvider ?? '' })
    return { runtimeSessionId: threadId, modelId, provider: selectedProvider ?? modelProvider }
  }
  if (message.method === 'session/prompt') {
    if (!threadId) throw new Error('Codex session is not initialized')
    // The Host sends the durable next-request selection with every prompt.
    // `model` is a real field of `turn/start`, and under the bridge it carries
    // the encoded route, so a model switch takes effect on the next turn. The
    // provider is not forwarded: the App Server has no method for changing the
    // provider of a live thread, and `turn/start` has no field to carry one.
    if (typeof message.params.modelId === 'string' && message.params.modelId.trim() !== '') modelId = message.params.modelId
    if (typeof message.params.provider === 'string' && message.params.provider.trim() !== '') selectedProvider = message.params.provider
    const selectedEffort = selectedReasoningEffort(message.params.reasoningEffort)
    armTurnWatchdog()
    try {
      const started = asRecord(await request('turn/start', {
        threadId,
        input: [{ type: 'text', text: message.params.content, text_elements: [] }],
        ...(message.params.workspace ? { cwd: message.params.workspace } : {}),
        ...(appServerModel(selectedEffort) === undefined ? {} : { model: appServerModel(selectedEffort) }),
        effort: codexReasoningEffort(selectedEffort),
        summary: 'detailed',
      }))
      // `turn/start` answers with the turn it created; that id is the only thing
      // `turn/interrupt` can name, so it is kept for the length of the turn.
      turnId = asString(asRecord(started.turn).id) ?? turnId
    } catch (error) {
      disarmTurnWatchdog()
      throw error
    }
    return null
  }
  if (message.method === 'session/cancel') {
    disarmTurnWatchdog()
    clearPendingBridges('Codex turn cancelled')
    // No turn in flight means nothing to interrupt: the request would name a
    // thread with no turn and be rejected, and the Host only needs to hear that
    // the cancel was accepted.
    if (turnId === undefined) {
      event('session/completed', { status: 'cancelled' })
      return null
    }
    try {
      await request('turn/interrupt', { threadId, turnId })
    } catch (error) {
      // A refused interrupt is not a cancelled turn. The App Server is still
      // generating, so reporting `cancelled` here would settle the turn as
      // stopped while the work continues and the transcript keeps growing.
      const detail = error instanceof Error ? redactAppServerDetail(error.message) : 'Codex turn interrupt failed'
      event('session/completed', { status: 'failed', message: detail })
      return null
    }
    turnId = undefined
    // Disarm a second time. The interrupt round trip above is the one window
    // where a frame can re-arm the timer — `turnId` has to stay set for the
    // request to name its turn, and every frame during a live turn resets the
    // idle window. A timer that outlives its turn then fires with no turn in
    // flight, and the Host answers a failed completion by disposing the runtime:
    // the session is torn down minutes after the user stopped it.
    disarmTurnWatchdog()
    // An interrupted turn never emits turn/completed, so report the cancel
    // outcome to the Host instead of leaving the turn open.
    event('session/completed', { status: 'cancelled' })
    return null
  }
  if (message.method === 'permission/respond') { const requestId = asString(message.params.requestId) ?? ''; const resolve = approvals.get(requestId); if (resolve === undefined) throw new Error('unknown Codex approval request'); approvals.delete(requestId); resolve(message.params.response); return null }
  if (message.method === 'question/respond') { const requestId = asString(message.params.requestId) ?? ''; const resolve = questions.get(requestId); if (resolve === undefined) throw new Error('unknown Codex question request'); questions.delete(requestId); resolve(message.params.response); return null }
  if (message.method === 'bridge/respond') {
    const bridgeId = asString(message.params.requestId) ?? ''
    const pending = pendingBridges.get(bridgeId)
    if (pending === undefined) return null
    pendingBridges.delete(bridgeId)
    const failure = message.params.error
    if (failure !== undefined && failure !== null) pending.reject(new Error(asMessage(failure) || 'bridge call failed'))
    else pending.resolve(message.params.result)
    return null
  }
  if (message.method === 'session/dispose') {
    disarmTurnWatchdog()
    const dying = child
    // Detach before stopping anything. The App Server's close handler reports
    // `session/failed`, and a dispose the Host asked for is not a failure;
    // clearing `child` first makes that callback see a stale instance and return.
    child = undefined
    threadId = undefined
    harnessSessionId = undefined
    approvals.clear(); questions.clear()
    clearPendingBridges('Codex session disposed')
    const server = harnessMcpServer; harnessMcpServer = undefined; harnessMcpUrl = undefined
    if (dying !== undefined) await stopAppServer(dying)
    await new Promise<void>((resolve) => { if (server === undefined) resolve(); else server.close(() => { resolve() }) })
    return null
  }
  throw new Error(`unsupported Codex worker method ${message.method}`)
}
createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const message = parseHostFrame(line)
    if (message === undefined) throw new Error('Host frame is not a { id, method, params } request object')
    void handle(message).then(
      (result) => { reply(message.id, result) },
      (error: unknown) => { reply(message.id, undefined, error instanceof Error ? error : new Error(String(error))) },
    )
  } catch (error) {
    send({ error: { code: 'INVALID_JSON', message: String(error) } })
  }
})

/** Parse one Host→worker JSONL frame into the shape `handle` can read. */
function parseHostFrame(line: string): { id: string; method: string; params: Record<string, unknown> } | undefined {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const frame = parsed as Record<string, unknown>
  if (typeof frame.id !== 'string' || typeof frame.method !== 'string') return undefined
  const params = typeof frame.params === 'object' && frame.params !== null && !Array.isArray(frame.params) ? frame.params as Record<string, unknown> : {}
  return { id: frame.id, method: frame.method, params }
}

/**
 * Read one App Server request's params as a user-input request, or `undefined`
 * when they are not one.
 *
 * This is a discriminator, not a validator with an opinion: the App Server
 * declares `questions` only on `ToolRequestUserInputParams` (checked across both
 * published schema files), so a params object carrying a non-empty `questions`
 * array is that request and nothing else. Two consequences are deliberate:
 *
 * - **No count ceiling.** `ToolRequestUserInputParams.questions` declares no
 *   `maxItems`, and the Harness's `AskUserQuestionItem[]` declares no limit
 *   either, so this used to carry a `length > 4` guard that belonged to neither
 *   side — it came from the Claude SDK's *tool schema*, which caps its
 *   `AskUserQuestion` input at four and rejects more before the runtime ever
 *   sees it. The App Server has no such schema, so the guard only converted a
 *   legitimate request into the -32601 "does not implement" error below, which
 *   named a missing feature that was in fact implemented.
 * - **A malformed entry drops the whole request** rather than the entry. The
 *   App Server's questions carry the ids its own `answers` map is keyed by, and
 *   answering a request while silently omitting one of its questions would send
 *   back a map the App Server cannot reconcile with what it asked.
 *
 * @param value - one request's params.
 * @returns the questions to surface, or `undefined` when this is another request.
 */
function normalizeQuestions(value: unknown): readonly { readonly id: string; readonly question: string; readonly header?: string; readonly detail?: string; readonly multiSelect?: boolean; readonly options?: readonly { readonly label: string; readonly description?: string }[] }[] | undefined {
  const candidate = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { questions?: unknown }).questions
    : undefined
  if (!Array.isArray(candidate) || candidate.length === 0) return undefined
  const out: { id: string; question: string; header?: string; detail?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }[] = []
  for (const item of candidate) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
    const record = item as Record<string, unknown>
    if (typeof record.question !== 'string' || record.question.trim() === '') return undefined
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
        if (typeof option !== 'object' || option === null || Array.isArray(option)) return []
        const value = option as Record<string, unknown>
        return typeof value.label === 'string' && value.label.trim() !== ''
          ? [{ label: value.label, ...(typeof value.description === 'string' ? { description: value.description } : {}) }]
          : []
      })
      : undefined
    out.push({
      id: typeof record.id === 'string' && record.id.trim() !== '' ? record.id : `question-${out.length + 1}`,
      question: record.question,
      ...(typeof record.header === 'string' ? { header: record.header } : {}),
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
      ...(typeof record.multiSelect === 'boolean' ? { multiSelect: record.multiSelect } : {}),
      ...(options === undefined || options.length === 0 ? {} : { options }),
    })
  }
  return out
}
