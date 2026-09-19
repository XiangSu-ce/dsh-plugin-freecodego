/**
 * The complete hook surface: fifteen events, three dialects, and fail-open
 * execution.
 *
 * Why this exists when the Host already runs hooks
 * -----------------------------------------------
 * `dsh-hooks-claude-code` and `dsh-hooks-codex` execute a project's `hooks.json`
 * verbatim, and `hooks/hook-chains.ts` in this plugin is a *recovery rule engine*
 * rather than a hook executor. Neither owns the surface a migrating user
 * actually arrives with: grok's fifteen events, Cursor's `hooks.json` dialect,
 * tool-name aliases across agents, and the rule that a broken hook must not break
 * the turn.
 *
 * Three decisions are load-bearing, and each is the opposite of the obvious one.
 *
 * **1. Everything fails open except an explicit `deny`.** A hook that times out,
 * exits non-zero, prints garbage, or crashes produces a recorded result and the
 * turn continues. Hooks are user-authored scripts running against a moving
 * tool surface; treating a bug in one as a refusal to work would make the whole
 * feature unshippable. The single exception is `updatedInput`, below.
 *
 * **2. `updatedInput` is refused loudly, never ignored.** Rewriting a
 * `PreToolUse` input cannot be made safe here: history, audit and the approval
 * UI have already read and frozen the arguments by the time this seam runs, so a
 * rewrite would produce a tool call whose recorded input differs from the one
 * that ran. Returning a hook's rewrite as though it applied would be a silent
 * security failure for anyone masking secrets with it — so the model gets an
 * explicit "this host does not support input rewriting" message instead, and the
 * call is blocked because it cannot run as the hook intended.
 *
 * **3. Every handler sees the original input.** No handler observes another's
 * rewrite. With rewriting refused that is currently implied, but the dispatch
 * loop is written so it stays true if a future host does support rewriting.
 *
 * Two more things this module refuses to fake: it does not invent a `WillSleep`
 * style event that the Host cannot emit, and it does not name its own records
 * `hook/*` — that namespace belongs to the bridge's log, and a user grepping for
 * our records should not have to distinguish two writers. We write
 * `freecodego/hook-invoked` and `freecodego/hook-result`.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/hooks/surface
 */

/**
 * The fifteen events, named as grok names them.
 *
 * The names are kept rather than translated to this Host's vocabulary so that a
 * `hooks.json` written for Claude Code or Cursor loads unchanged; the mapping to
 * concrete seams lives in the dispatcher, not in the user's file.
 */

import { redactCredentialShapes } from '../secret-scan.ts'
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'StopCancelled',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const

export type HookEvent = typeof HOOK_EVENTS[number]

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS)

/**
 * What a matcher is compared against, per event.
 *
 * `none` is not "match everything" — it is "a matcher here cannot mean anything,
 * so one that is present is a mistake worth warning about". `Stop` and
 * `UserPromptSubmit` carry no discriminating subject: every stop is a stop, and
 * the prompt's text is not a name.
 */
export type HookMatcherSubject =
  | 'tool'
  | 'notification'
  | 'subagent'
  | 'session-start'
  | 'session-end'
  | 'compaction'
  | 'stop-failure'
  | 'stop-cancel'
  | 'none'

const MATCHER_SUBJECTS: ReadonlyMap<HookEvent, HookMatcherSubject> = new Map<HookEvent, HookMatcherSubject>([
  ['PreToolUse', 'tool'],
  ['PostToolUse', 'tool'],
  ['PostToolUseFailure', 'tool'],
  ['PermissionDenied', 'tool'],
  ['Notification', 'notification'],
  ['SubagentStart', 'subagent'],
  ['SubagentStop', 'subagent'],
  ['SessionStart', 'session-start'],
  ['SessionEnd', 'session-end'],
  ['PreCompact', 'compaction'],
  ['PostCompact', 'compaction'],
  ['StopFailure', 'stop-failure'],
  ['StopCancelled', 'stop-cancel'],
  ['Stop', 'none'],
  ['UserPromptSubmit', 'none'],
])

/** Events whose result may refuse the pending action outright. */
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'PreToolUse',
  'UserPromptSubmit',
  'Stop',
])

/**
 * Cursor's camelCase event names, mapped onto the canonical fifteen.
 *
 * Several Cursor names collapse onto one canonical event — its shell, MCP and
 * file-read pre-hooks are all `PreToolUse` — which is why a Cursor hook's
 * matcher has to be interpreted as a tool matcher rather than as its own
 * namespace.
 */
export const CURSOR_EVENT_ALIASES: Readonly<Record<string, HookEvent>> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit',
  beforeShellExecution: 'PreToolUse',
  beforeMCPExecution: 'PreToolUse',
  beforeReadFile: 'PreToolUse',
  afterShellExecution: 'PostToolUse',
  afterMCPExecution: 'PostToolUse',
  afterFileEdit: 'PostToolUse',
  afterAgentResponse: 'PostToolUse',
  afterAgentThought: 'PostToolUse',
  preCompact: 'PreCompact',
  postCompact: 'PostCompact',
  stop: 'Stop',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  notification: 'Notification',
}

/**
 * Tool-name families across agents.
 *
 * Claude Code capitalizes (`Bash`, `Read`), Cursor lowercases, and this Host
 * names tools after what they do (`list_dir`, `web_search`). A hook written for
 * one agent must match in the others, so comparison runs over the family rather
 * than the spelling.
 *
 * `Edit`, `Write` and `MultiEdit` deliberately share one family because grok's
 * measured table does: a hook guarding file mutation in a multi-agent setup
 * wants all three, and refusing to match `Write` for a matcher of `Edit` would
 * silently disable exactly the guard the user wrote.
 *
 * The write family carries both `str_replace` and `str_replace_editor` because
 * they are different things: the first is the `command` an editor tool takes, the
 * second is a tool name this Host registers. `compileMatcher` anchors its pattern
 * (`^(?:m)$`) and folds case, so it never matches a prefix — a family member is
 * the only bridge between two spellings, which makes a missing name not "a
 * narrower match" but a tool the family cannot reach at all.
 *
 * The shell family names `pwsh` for the same reason `CLEARABLE_TOOL_KINDS` does:
 * the base `cordis.patch.yml` disables `tool-bash` on win32 and enables
 * `tool-pwsh`, so on Windows the only shell there is would be the one spelling the
 * family could not reach — and this family exists precisely so a hook written as
 * `Bash` still guards the shell this Host provides.
 *
 * It names `exec_command` for the third shell that arrives under its own spelling.
 * A native Codex session's shell approvals come through as `shell`/`exec_command`
 * (the same pair `bashCommandOf` and its credential screen carry), and `shell` was
 * already a member — so the family reached one Codex spelling and not the other.
 * That is the failure this table is built to prevent, in the direction that costs
 * the most: `exec_command` is a shell, a hook written as `Bash` is how a user
 * guards a shell, and a name the family cannot reach is not a narrower match but
 * a guard that never runs. `cache-cold.ts` and `plan-mode.ts` already carry it.
 *
 * The read family names `read_document` for the same reason the write family names
 * `str_replace_editor`: it is a tool name this Host registers, not an alias of
 * `read`. It is the only reader for a PDF or a notebook, so a hook written as
 * `Read` — to audit, redact or refuse a file read — reached every text format and
 * silently not those two. `CLEARABLE_TOOL_KINDS` names it and says why in the same
 * words: it is the biggest producer of the payload such lists exist for, and every
 * curated list that has to know it names it.
 *
 * It names `read_image` on the same ground. `@deepseek-ai/dsh-tool-fs` registers
 * it beside `read`, and the base bundle mounts the attachment store it needs
 * (`packages/bundle/base/cordis.patch.yml`), so it is present in every app built
 * on that bundle. An image read is the read a guard has the most reason to want:
 * it is the one whose payload is bytes the model cannot be handed back as text,
 * and a matcher of `Read` reaching every format except that one is the same
 * silent hole as the PDF case, in the direction with the larger blast radius.
 *
 * The task family names the delegation tools the shipped composition actually
 * enables. Claude Code's spelling for starting a subagent is `Task`, and this
 * Host's `dsh-tool-subagent` is mounted four times in the freecodego preset —
 * `subagent` (spawn) and `subagent_fork` (fork) enabled, `subagent_codex` and
 * `subagent_claude_code` present but `disabled: true` — with `dsh-tool-workflow`
 * and `dsh-tool-ralph` beside them as the fan-out runners. The family named only
 * `subagent`, so a hook written to guard delegation reached the one provider whose
 * spelling it happened to know and silently not the other five. The disabled pair
 * is carried for the reason `BASH_TOOL_NAMES` carries its inert entries: a preset
 * says "local edits are preserved", so which providers are switched on is a
 * deployment's choice, and a member that never arrives costs nothing while a
 * missing one is a guard that never runs. `plan-mode.ts` and `verify-on-stop.ts`
 * already carry all six, for the same reason this table exists.
 *
 * The read and write families are closed against the sibling lists rather than
 * against the Harness registry alone, because the spellings that reach a hook are
 * not only the registry's. `native-tool-guard.ts` projects an engine's tool name
 * mechanically (`NotebookEdit` → `notebook_edit`, `DeleteFile` → `delete_file`),
 * and `tool-guards.ts` says of exactly those names that they are "the spellings
 * this guard is *actually* pointed at". `CREDENTIAL_PATH_TOOLS` and
 * `READ_LIKE_TOOL_NAMES` therefore carry `fs_read`, `fs_write`, `fs_edit`,
 * `delete_file`, `move_file`, `notebook_edit`, `notebook_write`, `view` and
 * `readfile`; `CLEARABLE_TOOL_KINDS` carries `list_files`. A mutating spelling the
 * write family cannot reach is the hole its own paragraph above describes — a
 * hook written to guard file mutation that silently misses the notebook writer or
 * the deleting tool — and the same holds one family over for a reader. All of
 * them are inert on a composition that never registers them, which is why the
 * sibling lists keep them and why the cost of carrying one is nothing.
 *
 * `spill_recall` is deliberately not a reader here. `CREDENTIAL_PATH_TOOLS` lists
 * it because the credential shield has to cover every way a path becomes a file
 * read, but this table answers a different question — which matcher spelling a
 * user's hook means — and no other agent spells "recall a spilled payload" as a
 * read. `grep` is not a reader here for the same reason it is one there: a search
 * has its own family.
 */
const TOOL_FAMILIES: readonly (readonly string[])[] = [
  ['bash', 'shell', 'exec', 'exec_command', 'run_command', 'pwsh'],
  ['read', 'read_file', 'file_read', 'read_document', 'read_image', 'fs_read', 'view', 'readfile', 'cat'],
  ['edit', 'write', 'multi_edit', 'multiedit', 'apply_patch', 'str_replace', 'str_replace_editor', 'edit_file', 'write_file', 'create_file', 'notebook_edit', 'notebook_write', 'delete_file', 'move_file', 'fs_write', 'fs_edit'],
  ['grep', 'search', 'ripgrep'],
  ['glob', 'listdir', 'list_dir', 'ls', 'find', 'list_files'],
  ['websearch', 'web_search'],
  ['webfetch', 'web_fetch', 'fetch'],
  ['task', 'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'workflow', 'ralph', 'agent'],
]

/** Tool families indexed by every member, lowercased. */
const TOOL_FAMILY_BY_NAME: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  TOOL_FAMILIES.flatMap((family) => {
    const members = new Set(family)
    for (const alias of family) members.add(alias.replace(/[^a-z0-9]/g, ''))
    return family.map(alias => [alias, members] as const)
  }),
)

/**
 * Every spelling a tool name may legitimately be matched under.
 * @param toolName - the tool's own name, as the Host reports it in a call.
 * @returns the raw name, its lowercase form, its de-punctuated form, and its
 *   whole family when the name is a known alias.
 */
export function toolNameCandidates(toolName: string): readonly string[] {
  const lower = toolName.toLowerCase()
  const bare = lower.replace(/[^a-z0-9]/g, '')
  const family = TOOL_FAMILY_BY_NAME.get(lower) ?? TOOL_FAMILY_BY_NAME.get(bare)
  const candidates = new Set<string>([toolName, lower, bare])
  for (const member of family ?? []) candidates.add(member)
  return [...candidates]
}

/**
 * Match an alias-aware subject against a hook matcher.
 *
 * A matcher is a regular expression when it compiles as one — that is Claude
 * Code's documented behaviour and the reason `Bash|Read` works in the wild — and
 * a literal otherwise. An empty matcher and `*` both mean "every subject".
 * @param matcher - the matcher text from the hook document.
 * @param subject - the value to test (a tool name, a notification kind, ...).
 * @param candidates - spellings to test `subject` under; defaults to the one name.
 * @returns true when the handler should run.
 */
export function matchesHookMatcher(
  matcher: string,
  subject: string,
  candidates: readonly string[] = [subject],
): boolean {
  const trimmed = matcher.trim()
  if (trimmed === '' || trimmed === '*') return true
  const pattern = compileMatcher(trimmed)
  if (pattern === undefined) return candidates.some(name => name === trimmed)
  return candidates.some((name) => {
    // A fresh regex per name: a compiled pattern carries `lastIndex` when it has
    // the `g` flag, and a shared one would then match every other call.
    pattern.lastIndex = 0
    return pattern.test(name)
  })
}

/**
 * Compile a matcher, tolerating the two ways a user writes one.
 * @param matcher - matcher text.
 * @returns the pattern, or undefined when the text is not a valid expression.
 */
function compileMatcher(matcher: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${matcher})$`, 'i')
  } catch {
    return undefined
  }
}

/** Where a handler came from, for dedupe and for reporting. */
export type HookSourceKind = 'global' | 'project' | 'plugin' | 'config'

/** Precedence of sources, widest first. */
const SOURCE_ORDER: readonly HookSourceKind[] = ['global', 'project', 'plugin', 'config']

/** How a handler is executed. */
export type HookHandlerKind = 'command' | 'http'

/** One resolved hook handler. */
export interface HookHandler {
  readonly event: HookEvent
  /** Raw matcher text; `''` means every subject. */
  readonly matcher: string
  readonly kind: HookHandlerKind
  /** Shell command for `command` handlers, absolute URL for `http` handlers. */
  readonly command: string
  /** Per-handler timeout; absent means the event default applies. */
  readonly timeoutMs?: number
  /** Every source that declared this exact handler. */
  readonly sources: readonly HookSourceKind[]
}

/** A document a hook handler was parsed out of, with its provenance. */
export interface HookDocument {
  readonly source: HookSourceKind
  /** File path the document was read from, for diagnostics. */
  readonly path: string
  readonly value: unknown
}

/** A parse outcome: the handlers, plus everything that was skipped and why. */
export interface HookParseResult {
  readonly handlers: readonly HookHandler[]
  readonly warnings: readonly string[]
}

/** Default timeout for hooks that can gate the turn's progress. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000

/**
 * Timeout for the events that gate something expensive.
 *
 * `Stop` and the tool events are where a hook legitimately runs a build or a
 * test, and cutting those off at five seconds would make the events useless for
 * the one thing users write them for.
 */
export const GATING_HOOK_TIMEOUT_MS = 600_000

/**
 * Every event a tool seam dispatches.
 *
 * All three come off the same two listeners in `seams.ts`: `PreToolUse` guards
 * a call, and `PostToolUse`/`PostToolUseFailure` are one `tools/post-execute`
 * listener that picks the spelling by `isError`. The failure spelling is not a
 * different event with a smaller budget — it is the same handler, handed the
 * same cancellation, reporting the run that went wrong, which is the run whose
 * hook has the most to say. Kept as a set rather than an inline `||` so that
 * adding an event to a tool seam is one edit here instead of a silent five
 * second cap on a user's test suite.
 */
const TOOL_SEAM_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])

/**
 * The largest delay a timer can hold.
 *
 * Past it Node fires the timer immediately rather than late, so an
 * unrepresentable deadline is silently the *smallest* one a hook can have. See
 * {@link declaredHookTimeoutMs}.
 */
export const MAX_HOOK_TIMEOUT_MS = 2_147_483_647

/**
 * The timeout a handler runs under when it declares none.
 *
 * The tool seams are listed rather than inferred from a name prefix: the events
 * a user can write for are a fixed fifteen, and the ones on a tool seam are the
 * ones whose hooks run against a call the user can stop.
 * @param event - the event being dispatched.
 * @returns the timeout in milliseconds.
 */
export function defaultHookTimeoutMs(event: HookEvent): number {
  return event === 'Stop' || TOOL_SEAM_EVENTS.has(event) ? GATING_HOOK_TIMEOUT_MS : DEFAULT_HOOK_TIMEOUT_MS
}

/** Raised for a document we refuse rather than partly understand. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a string field, or undefined when absent or of another type. */
function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

/** Read a numeric field, or undefined when absent or of another type. */
function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) && field > 0 ? field : undefined
}

/**
 * Read a handler's declared deadline, in milliseconds.
 *
 * The key's spelling carries the unit, because nothing else can: the field both
 * known dialects share is unitless in their config files and its wire unit is
 * **seconds** — the protocol's own `CommandHook.timeoutSec` says so in as many
 * words ("Per-hook timeout in SECONDS (the wire unit); the runner converts to
 * ms") and its runner multiplies by 1000, which is why Claude Code's `timeout`
 * and Codex's `timeout`/`timeoutSec` all mean half a minute when they say 30.
 * `timeoutMs` is this plugin's own explicitly-millisecond spelling and wins when
 * both are present, because the unit that is written down beats the one that is
 * only conventional.
 *
 * Reading the wire field as milliseconds made every such hook run under a
 * deadline a thousand times smaller than it declared: `{"timeout": 30}`, the
 * idiomatic "give this build thirty seconds", was killed before a shell could
 * start, recorded as a timeout, and — because a non-decision fails open — its
 * `deny` was silently not applied. Nobody can be relying on 30 milliseconds, so
 * the asymmetry is total: the shrink disables guard hooks, the correction only
 * enlarges deadlines.
 *
 * @param value - the handler body.
 * @param path - document path, for warnings.
 * @param event - the event the handler belongs to, for warnings.
 * @param warnings - collector for skipped entries.
 * @returns the deadline in milliseconds, or `undefined` for the event default.
 */
function declaredHookTimeoutMs(value: Record<string, unknown>, path: string, event: HookEvent, warnings: string[]): number | undefined {
  const seconds = numberField(value, 'timeout')
  const milliseconds = numberField(value, 'timeoutMs')
  const declared = milliseconds ?? (seconds === undefined ? undefined : seconds * 1_000)
  if (declared === undefined) return undefined
  if (declared > MAX_HOOK_TIMEOUT_MS) {
    warnings.push(`${path}: the ${event} hook declares a timeout of ${milliseconds === undefined ? `${seconds}s` : `${milliseconds}ms`}, which is longer than a timer can hold; it was capped at ${MAX_HOOK_TIMEOUT_MS}ms instead of firing immediately`)
    return MAX_HOOK_TIMEOUT_MS
  }
  return declared
}

/**
 * Parse one handler body shared by every dialect.
 *
 * The dialects differ in how they group handlers and in how they name events;
 * they agree on this leaf shape, so it is parsed once. An alternative shape
 * (grok also accepts a bare string) is normalized here rather than at each call
 * site.
 * @param value - the handler entry.
 * @param event - canonical event it belongs to.
 * @param source - provenance for the parsed handler.
 * @param path - document path, for warnings.
 * @param warnings - collector for skipped entries.
 * @returns the handler, or undefined when the entry cannot be executed.
 */
function parseHandlerLeaf(
  value: unknown,
  event: HookEvent,
  source: HookSourceKind,
  path: string,
  warnings: string[],
): HookHandler | undefined {
  if (typeof value === 'string') {
    return { event, matcher: '', kind: 'command', command: value, sources: [source] }
  }
  if (!isRecord(value)) {
    warnings.push(`${path}: skipped a hook for ${event} that is neither a command string nor an object`)
    return undefined
  }
  const declaredKind = stringField(value, 'type')
  const command = stringField(value, 'command') ?? stringField(value, 'url')
  if (command === undefined || command.trim() === '') {
    warnings.push(`${path}: skipped a hook for ${event} with no command`)
    return undefined
  }
  const kind: HookHandlerKind = declaredKind === 'http' || declaredKind === 'url' ? 'http' : 'command'
  const timeoutMs = declaredHookTimeoutMs(value, path, event, warnings)
  const matcher = stringField(value, 'matcher') ?? ''
  return {
    event,
    matcher,
    kind,
    command,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    sources: [source],
  }
}

/**
 * Parse Claude Code's `settings.json` hook block.
 * @param value - the `hooks` object of a `settings.json`.
 * @param source - provenance for the parsed handlers.
 * @param path - document path, for warnings.
 * @returns handlers and warnings.
 */
export function parseClaudeHooks(
  value: unknown,
  source: HookSourceKind = 'config',
  path = 'settings.json',
): HookParseResult {
  const handlers: HookHandler[] = []
  const warnings: string[] = []
  if (!isRecord(value)) return { handlers, warnings }
  for (const [eventName, group] of Object.entries(value)) {
    if (!HOOK_EVENT_SET.has(eventName)) {
      warnings.push(`${path}: skipped unknown hook event "${eventName}"`)
      continue
    }
    const event = eventName as HookEvent
    if (!Array.isArray(group)) {
      warnings.push(`${path}: expected an array of hook groups for ${event}`)
      continue
    }
    for (const entry of group) {
      if (!isRecord(entry)) continue
      const matcher = stringField(entry, 'matcher') ?? ''
      const inner = Array.isArray(entry.hooks) ? entry.hooks : [entry]
      for (const leaf of inner) {
        const handler = parseHandlerLeaf(leaf, event, source, path, warnings)
        if (handler === undefined) continue
        handlers.push(handler.matcher === '' && matcher !== '' ? { ...handler, matcher } : handler)
      }
    }
  }
  return { handlers, warnings }
}

/**
 * Parse Cursor's `hooks.json`.
 *
 * Cursor groups handlers directly under an event name rather than under a
 * matcher object, and its event names are camelCase, so this normalizes both.
 * @param value - the document.
 * @param source - provenance for the parsed handlers.
 * @param path - document path, for warnings.
 * @returns handlers and warnings.
 */
export function parseCursorHooks(
  value: unknown,
  source: HookSourceKind = 'config',
  path = 'hooks.json',
): HookParseResult {
  const handlers: HookHandler[] = []
  const warnings: string[] = []
  if (!isRecord(value)) return { handlers, warnings }
  const block = isRecord(value.hooks) ? value.hooks : value
  for (const [eventName, group] of Object.entries(block)) {
    const canonical = HOOK_EVENT_SET.has(eventName)
      ? (eventName as HookEvent)
      : CURSOR_EVENT_ALIASES[eventName]
    if (canonical === undefined) {
      // Deliberately not a warning: a shared Cursor file will carry events this
      // host has no seam for, and warning about each one trains users to ignore
      // the warnings that matter.
      continue
    }
    const entries = Array.isArray(group) ? group : [group]
    for (const entry of entries) {
      const handler = parseHandlerLeaf(entry, canonical, source, path, warnings)
      if (handler !== undefined) handlers.push(handler)
    }
  }
  return { handlers, warnings }
}

/**
 * Parse this plugin's own hook block.
 *
 * The native dialect is a list rather than a map because a native handler names
 * its event explicitly — which is what makes it possible to express an event
 * whose handlers would collide with an unrelated key in a `settings.json`.
 * @param value - an array of handlers, or an object with a `hooks` array.
 * @param source - provenance for the parsed handlers.
 * @param path - document path, for warnings.
 * @returns handlers and warnings.
 */
export function parseNativeHooks(
  value: unknown,
  source: HookSourceKind = 'config',
  path = 'freecodego hooks',
): HookParseResult {
  const handlers: HookHandler[] = []
  const warnings: string[] = []
  const entries = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.hooks) ? value.hooks : []
  if (entries.length === 0 && value !== undefined && !isRecord(value)) {
    warnings.push(`${path}: expected an array of hook handlers`)
  }
  for (const entry of entries) {
    if (!isRecord(entry)) {
      warnings.push(`${path}: skipped a hook that is not an object`)
      continue
    }
    const eventName = stringField(entry, 'event')
    if (eventName === undefined || !HOOK_EVENT_SET.has(eventName)) {
      warnings.push(`${path}: skipped a hook with unknown event "${eventName ?? ''}"`)
      continue
    }
    const handler = parseHandlerLeaf(entry, eventName as HookEvent, source, path, warnings)
    if (handler !== undefined) handlers.push(handler)
  }
  return { handlers, warnings }
}

/**
 * Parse whichever dialect a document is written in.
 *
 * Sniffing is by structure, not by filename: users symlink and rename these
 * files, and a `settings.json` copied to `hooks.json` should still work. The
 * native shape wins when both could apply, because it is the only one that can
 * name an event the other two cannot express.
 * @param document - the document and its provenance.
 * @returns handlers and warnings.
 */
export function parseHookDocument(document: HookDocument): HookParseResult {
  const { value, source, path } = document
  if (Array.isArray(value) || (isRecord(value) && Array.isArray(value.hooks))) {
    const native = parseNativeHooks(value, source, path)
    if (native.handlers.length > 0) return native
  }
  if (!isRecord(value)) return { handlers: [], warnings: [`${path}: hooks must be an object or an array`] }
  const block = isRecord(value.hooks) ? value.hooks : value
  const cursor = parseCursorHooks(block, source, path)
  if (cursor.handlers.length > 0) return cursor
  return parseClaudeHooks(block, source, path)
}

/**
 * Merge handler sets from several documents into one dispatch order.
 *
 * Rules, in order of what they protect:
 *
 * - **Dedupe is by identity, not by source.** The same command registered by a
 *   global and a project file is one handler with two sources; running it twice
 *   would double every side effect a user wrote once.
 * - **Sources are merged, not replaced**, so `doctor` can say which file to edit.
 * - **Order follows source precedence** (global, then project, then plugin, then
 *   config) and preserves document order within a source. Config last means the
 *   most specific declaration runs last and therefore has the last word on a
 *   deny.
 * @param documents - parsed documents, each with its provenance.
 * @returns merged handlers plus every warning, in encounter order.
 */
export function collectHookHandlers(documents: readonly HookDocument[]): HookParseResult {
  const byIdentity = new Map<string, { handler: HookHandler; order: number }>()
  const warnings: string[] = []
  let order = 0
  const ordered = [...documents].sort((left, right) => SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source))
  for (const document of ordered) {
    const parsed = parseHookDocument(document)
    warnings.push(...parsed.warnings)
    for (const handler of parsed.handlers) {
      const identity = `${handler.event}\u0000${handler.matcher}\u0000${handler.kind}\u0000${handler.command}`
      const existing = byIdentity.get(identity)
      if (existing === undefined) {
        byIdentity.set(identity, { handler, order })
        order += 1
        continue
      }
      const merged = new Set([...existing.handler.sources, ...handler.sources])
      // The deadline is the one field identity does not cover, so a merge has to
      // decide it, and it used to be decided by accident: the first document in
      // precedence order won, which is the *widest* declaration there is — so a
      // project's longer deadline for a shared command was silently replaced by the
      // global one. A too-short deadline is not the safe pick in this module: the
      // hook is killed, recorded as a timeout, and fails open, which is how a guard
      // stops guarding (the same asymmetry `declaredHookTimeoutMs` documents for the
      // seconds/milliseconds reading). The documents arrive widest-first, so the
      // declaration seen later is the more specific one and its deadline wins — the
      // rule the order above already states, applied to the one field where two
      // identical handlers can disagree. A specific declaration that is silent
      // leaves the wider one's deadline in place rather than reverting the handler
      // to the event default.
      const timeoutMs = handler.timeoutMs ?? existing.handler.timeoutMs
      byIdentity.set(identity, {
        handler: {
          ...existing.handler,
          sources: [...merged],
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        order: existing.order,
      })
    }
  }
  const handlers = [...byIdentity.values()].sort((left, right) => left.order - right.order).map(entry => entry.handler)
  return { handlers, warnings }
}

/**
 * Select the handlers for one dispatch.
 * @param handlers - the merged handler set.
 * @param event - the event being dispatched.
 * @param subject - the value a matcher is tested against; `''` for events with
 *   no subject.
 * @param toolName - the tool name, when the event is a tool event. Passed
 *   separately so alias expansion applies only where it means something.
 * @returns the handlers that should run, in order, plus matcher warnings.
 */
export function selectHookHandlers(
  handlers: readonly HookHandler[],
  event: HookEvent,
  subject: string,
  toolName?: string,
): HookParseResult {
  const warnings: string[] = []
  const subjectKind = MATCHER_SUBJECTS.get(event) ?? 'none'
  const selected = handlers.filter((handler) => {
    if (handler.event !== event) return false
    if (handler.matcher.trim() === '' || handler.matcher.trim() === '*') return true
    if (subjectKind === 'none') {
      warnings.push(`a matcher on ${event} cannot discriminate anything and was ignored`)
      return true
    }
    if (subjectKind === 'tool') return matchesHookMatcher(handler.matcher, toolName ?? subject, toolNameCandidates(toolName ?? subject))
    return matchesHookMatcher(handler.matcher, subject)
  })
  return { handlers: selected, warnings }
}

/** How one handler ended. */
export type HookRunStatus =
  /** Ran and produced a usable result (which may still be a deny). */
  | 'ok'
  /** Timed out; fail open. */
  | 'timeout'
  /** Exited non-zero; fail open. */
  | 'failed'
  /** Exited zero with output that is not the JSON this contract expects; fail open. */
  | 'malformed'
  /** Could not be started at all; fail open. */
  | 'unavailable'
  /** Asked for a rewrite this host refuses; blocks, loudly. */
  | 'unsupported'
  /**
   * The call it guarded was cancelled — before this handler started, or while
   * it was running; fail open.
   *
   * Its own status rather than a kind of `timeout`, because the two need
   * different readers: a timeout is a fact about the hook (it is slow, or hung),
   * and cancellation is a fact about the turn (the user stopped it, the call was
   * abandoned). Recording a cancelled hook as a timing-out one sends its author
   * to tune a deadline that was never the problem.
   */
  | 'cancelled'

/** The single message a refused rewrite produces. */
export const HOOK_INPUT_REWRITE_REFUSAL =
  'This host does not support PreToolUse input rewriting: history, audit and the approval prompt already read and froze the call arguments before hook policy ran. The tool call was not executed. Remove `updatedInput` from the hook, or move the redaction to the tool itself.'

/** One handler's outcome. */
export interface HookRunResult {
  readonly handler: HookHandler
  readonly status: HookRunStatus
  /** Model-visible explanation for a deny, a refusal, or a failure worth seeing. */
  readonly message?: string
  readonly exitCode?: number
  /** Extra context a hook asked to inject. */
  readonly additionalContexts: readonly string[]
  /** Replacement model-visible output for a `PostToolUse` handler. */
  readonly replacement?: string
  /** True when this handler asked for input rewriting, which was refused. */
  readonly refusedRewrite: boolean
}

/** The body a hook may print on stdout to influence the dispatch. */
export interface HookDecisionBody {
  readonly decision?: string
  readonly permissionDecision?: string
  readonly reason?: string
  readonly additionalContexts?: readonly string[]
  readonly additionalContext?: string
  readonly replacement?: string
  readonly updatedInput?: unknown
}

/**
 * Most output one handler may produce before the rest is discarded.
 *
 * A cap rather than a courtesy: output is accumulated by appending to a string, and
 * a string in V8 has a maximum length — measured at roughly 536 million characters —
 * past which `+=` throws `RangeError: Invalid string length`. That throw lands inside
 * a stream event handler, which is to say outside every promise in this module, so it
 * becomes an uncaught exception and takes the agent process with it. A hook that
 * prints `yes` output, or a runaway test reporter behind a 10-minute gating timeout,
 * reaches that on its own; the timeout bounds time and not bytes.
 *
 * 256 KiB is far more than a decision needs (the contract is a small JSON object) and
 * far less than a process needs to survive. Truncation is reported rather than
 * silent, so a hook that was relying on a large payload is told.
 */
export const MAX_HOOK_OUTPUT_CHARS = 262_144

/** What the runner returns for one handler invocation. */
export interface HookInvocation {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /**
   * Whether the handler printed more than {@link MAX_HOOK_OUTPUT_CHARS}.
   *
   * Carried out of the runner so the dispatch can say *why* a decision was
   * unreadable: "printed output that is not JSON" is misleading when the output was
   * a valid prefix that got cut off.
   */
  readonly truncated?: boolean
}

/**
 * The injected way to run a handler, so tests do not spawn processes.
 *
 * The fourth argument is the call's own cancellation, when the caller has one:
 * a runner that ignores it leaves the handler running past the point anyone is
 * waiting for it. The real runners in `hooks/runtime.ts` honor it; an injected
 * one is free to, and a three-argument implementation still satisfies this type.
 */
export type HookRunner = (handler: HookHandler, payload: unknown, timeoutMs: number, signal?: AbortSignal) => Promise<HookInvocation>

/** The outcome of dispatching every selected handler for an event. */
export interface HookDispatchResult {
  readonly results: readonly HookRunResult[]
  /** True only when a handler explicitly denied (or refused a rewrite). */
  readonly blocked: boolean
  /** Why the dispatch blocked, chosen from the first blocking handler. */
  readonly blockReason?: string
  /** True when a handler asked for user confirmation rather than denial. */
  readonly escalated: boolean
  /** Model-visible output replacement, from the last handler that supplied one. */
  readonly replacement?: string
  readonly additionalContexts: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * Parse a hook's stdout into a decision body.
 * @param stdout - raw stdout, which may carry leading log lines.
 * @returns the body, `undefined` when the output is not JSON, or `null` when it
 *   is JSON but not the object this contract expects.
 */
function parseDecisionBody(stdout: string): HookDecisionBody | undefined | null {
  const trimmed = stdout.trim()
  if (trimmed === '') return {}
  const whole = interpretJsonObject(trimmed)
  if (whole !== undefined) return whole
  // The last line that looks like an object, for hooks that log then decide.
  //
  // Reached whenever the whole output is not JSON, and that now includes the case
  // it used to skip: output that *starts* with `{` but is not one document. A hook
  // whose log line is itself JSON — `{"level":"debug",…}`, which is what a
  // structured logger prints, and a pretty-printed log object is the same shape
  // over several lines — made the whole output unparseable, and the fast path
  // that read `startsWith('{')` as "it is a single document" took that as the
  // answer instead of looking at the last line. The decision was then recorded as
  // `malformed`, which fails open: a `PreToolUse` deny that silently did not
  // happen, for a hook that did everything right.
  const last = lastJsonObject(trimmed)
  if (last === undefined) return undefined
  return interpretJsonObject(last) ?? undefined
}

/**
 * Parse one candidate as the decision object.
 *
 * `null` and `undefined` are different answers and the caller reports them with
 * different words: the first is a hook that printed JSON of the wrong shape, the
 * second a hook that printed no document at all. Collapsing them is how the
 * "printed more than the cap" case gets explained as "not JSON".
 * @param text - one candidate slice of the handler's output.
 * @returns the body, `null` for non-object JSON, `undefined` for non-JSON.
 */
function interpretJsonObject(text: string): HookDecisionBody | null | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return undefined
  }
}

/**
 * How many trailing object openings are tried before the output is given up on.
 *
 * Named rather than inlined because the number is a budget with a reason: it is
 * far past any real decision payload (whose shape is one small object, at most a
 * couple of log objects before it) and far below the point where parsing the rest
 * of a capped output twenty times costs a noticeable stall.
 */
const LAST_OBJECT_ATTEMPTS = 20

/**
 * The last JSON object in the output, for hooks that log then decide.
 *
 * Line-based reading is not enough, and the case it missed is the one a user is
 * likeliest to write by hand: a *pretty-printed* decision follows a log object over
 * several lines, so no single line is a whole document. Searching from the last
 * line that opens an object and parsing the rest of the output finds both shapes,
 * and each earlier candidate is tried too, for an object whose own first key opens
 * a nested object on a line of its own.
 *
 * Bounded at {@link LAST_OBJECT_ATTEMPTS} candidates: each attempt parses the rest
 * of a payload that may be 256 KiB, and this runs inside a hook seam where an
 * unbounded scan would be a stall of its own. Every real "log then decide" output
 * is answered by the first attempt; the bound only stops a pathological one.
 * @param text - the handler's whole stdout, trimmed.
 * @returns the candidate text, or undefined when the output holds no JSON object.
 */
function lastJsonObject(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  let attempts = 0
  for (let index = lines.length - 1; index >= 0 && attempts < LAST_OBJECT_ATTEMPTS; index -= 1) {
    if (!lines[index]!.trim().startsWith('{')) continue
    attempts += 1
    const candidate = lines.slice(index).join('\n').trim()
    if (interpretJsonObject(candidate) !== undefined) return candidate
  }
  return undefined
}

/** Normalize a decision word across the dialects that spell it differently. */
function normalizeDecision(body: HookDecisionBody): string | undefined {
  const raw = body.decision ?? body.permissionDecision
  return raw === undefined ? undefined : raw.trim().toLowerCase()
}

/** Collect the injected-context fields, which are singular or plural by dialect. */
function decisionContexts(body: HookDecisionBody): readonly string[] {
  const contexts = [...(body.additionalContexts ?? [])]
  if (typeof body.additionalContext === 'string' && body.additionalContext !== '') contexts.push(body.additionalContext)
  return contexts.filter(entry => typeof entry === 'string' && entry !== '')
}

/**
 * Whether a guarded call has been cancelled, read through a call on purpose.
 *
 * A closure rather than an inline `signal?.aborted === true`: TypeScript narrows
 * that property after the loop-head check and keeps the narrowing across the
 * `await` inside the loop, where the truth can have changed — the compiler would
 * then "know" a cancelled signal was never cancelled. Calling this re-reads it.
 * @param signal - the call's cancellation, when it has one.
 * @returns true when the call is already cancelled.
 */
function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Dispatch every selected handler for one event, fail-open.
 *
 * Each handler runs independently and its failure is recorded rather than
 * propagated; see the module header for why that is the only workable rule. The
 * dispatch stops early for a decision that actually blocks, because a later
 * handler cannot un-deny an earlier one, and for a cancelled call, because a
 * hook guarding a call nobody is waiting for has nothing left to guard.
 * @param input - the selected handlers, the event, the injected runner, and the
 *   guarding call's cancellation when it has one.
 * @returns the dispatch result.
 */
export async function dispatchHooks(input: {
  readonly handlers: readonly HookHandler[]
  readonly event: HookEvent
  readonly payload: unknown
  readonly run: HookRunner
  /** The guarded call's cancellation; an aborted one starts no further handler. */
  readonly signal?: AbortSignal
}): Promise<HookDispatchResult> {
  const { handlers, event, payload, run, signal } = input
  const results: HookRunResult[] = []
  const additionalContexts: string[] = []
  let blocked = false
  let blockReason: string | undefined
  let escalated = false
  let replacement: string | undefined

  for (const handler of handlers) {
    // Checked per handler rather than once before the loop, because the
    // interesting moment is the one *between* two handlers: the first can be
    // running when the call is cancelled, and the second must not then spawn a
    // process nobody is waiting for anymore.
    if (cancelled(signal)) break
    const timeoutMs = handler.timeoutMs ?? defaultHookTimeoutMs(event)
    let invocation: HookInvocation
    try {
      invocation = await run(handler, payload, timeoutMs, signal)
    } catch (error) {
      // A throw is a timeout, a cancellation, or a failure to start; all three
      // fail open. Cancellation wins when both read true, because the caller is
      // already gone and "your deadline is too short" would send the hook's
      // author to the wrong place.
      const aborted = error instanceof Error && error.name === 'AbortError'
      const status: HookRunStatus = aborted ? (cancelled(signal) ? 'cancelled' : 'timeout') : 'unavailable'
      results.push({ handler, status, message: redactCredentialShapes(error instanceof Error ? error.message : String(error)), additionalContexts: [], refusedRewrite: false })
      continue
    }

    if (invocation.exitCode !== 0) {
      results.push({
        handler,
        status: 'failed',
        exitCode: invocation.exitCode,
        message: invocation.stderr.trim() === '' ? `exit code ${invocation.exitCode}` : redactCredentialShapes(invocation.stderr.trim()),
        additionalContexts: [],
        refusedRewrite: false,
      })
      continue
    }

    const body = parseDecisionBody(invocation.stdout)
    if (body === undefined || body === null) {
      results.push({
        handler,
        status: 'malformed',
        // Truncation is named first and instead of the generic wording: an output
        // that was cut off is not "output that is not JSON", and a hook author
        // reading the wrong reason looks in the wrong place.
        message: invocation.truncated === true
          ? `the handler printed more than ${MAX_HOOK_OUTPUT_CHARS} characters, so its output was truncated and its decision cannot be read`
          : body === null ? 'hook printed JSON that is not an object' : 'hook printed output that is not JSON',
        additionalContexts: [],
        refusedRewrite: false,
      })
      continue
    }

    if (body.updatedInput !== undefined) {
      // See the module header: this cannot be honored safely, so it is refused
      // rather than ignored. Blocking is the point — a hook that masked a secret
      // through `updatedInput` must not appear to have masked it.
      results.push({
        handler,
        status: 'unsupported',
        message: HOOK_INPUT_REWRITE_REFUSAL,
        additionalContexts: [],
        refusedRewrite: true,
      })
      blocked = true
      blockReason ??= HOOK_INPUT_REWRITE_REFUSAL
      continue
    }

    const contexts = decisionContexts(body).map(context => redactCredentialShapes(context))
    additionalContexts.push(...contexts)
    const replacementText = typeof body.replacement === 'string' && body.replacement !== ''
      ? redactCredentialShapes(body.replacement)
      : undefined
    if (replacementText !== undefined) replacement = replacementText

    const decision = normalizeDecision(body)
    const reason = typeof body.reason === 'string' && body.reason !== '' ? redactCredentialShapes(body.reason) : undefined
    if ((decision === 'deny' || decision === 'block') && BLOCKING_EVENTS.has(event)) {
      results.push({ handler, status: 'ok', ...(reason === undefined ? {} : { message: reason }), additionalContexts: contexts, refusedRewrite: false })
      blocked = true
      blockReason ??= reason ?? `denied by a ${handler.sources.join('/')} hook`
      continue
    }
    if (decision === 'ask' && BLOCKING_EVENTS.has(event)) escalated = true
    results.push({
      handler,
      status: 'ok',
      ...(reason === undefined ? {} : { message: reason }),
      additionalContexts: contexts,
      ...(handler.event === 'PostToolUse' && replacementText !== undefined ? { replacement: replacementText } : {}),
      refusedRewrite: false,
    })
  }

  return {
    results,
    blocked,
    ...(blockReason === undefined ? {} : { blockReason }),
    escalated,
    ...(replacement === undefined ? {} : { replacement }),
    additionalContexts,
    warnings: [],
  }
}
