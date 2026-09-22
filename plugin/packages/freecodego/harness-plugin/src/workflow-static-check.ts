/**
 * Static checks on a workflow script, run by the plugin on `tools/pre-execute`
 * before the `workflow` tool ever reaches the engine.
 *
 * Why the plugin, and not the engine
 * ----------------------------------
 * The engine seam (`@deepseek-ai/dsh-workflow`'s `WorkflowEngine.start`) is the
 * obvious place to refuse a doomed script, and a copy of this module once lived
 * there. It could not ship: everything outside `packages/freecodego/**` is
 * untracked upstream Harness core that `sync:harness` overwrites and the publish
 * tree never copies, so a gate added there stays on this machine. The plugin's
 * own `tools/pre-execute` waterfall is tracked, published, and already carries
 * this plugin's other refusals — so a refusal here reaches users, and reaches
 * them one seam earlier: before the tool call is dispatched at all.
 *
 * Why
 * ---
 * The engine already rejects a body that does not compile, and the guest
 * re-compiles the same wrapper in its own process. What neither catches is a
 * script that parses perfectly and then fails **after work has already been paid
 * for**: `fetch(...)`, `process.env`, a dynamic `import()`, or
 * `agent(prompt, { effort: 'high' })` all parse, and all throw — but only once the
 * run is under way, which is after the model has burned child agents on the way to
 * the failure.
 *
 * The idea ported here is from ZCode's `dynamic-workflow` compiler: make the
 * authoring contract **executable** instead of describing it in prose. There the
 * model writes TypeScript against an embedded `.d.ts` façade and a virtual host
 * type-checks it, so the compiler enforces what the tool description only asks
 * for. Our scripts are plain JavaScript, not TypeScript (the tool schema says so
 * explicitly), so the façade is applied the other way round: `checkJs` type-checks
 * a **JavaScript** body against a declaration file that names exactly the surface
 * the VM actually installs.
 *
 * What may reject a script, and what may not
 * ------------------------------------------
 * A static gate that rejects a script which would have run is worse than no gate,
 * so **only a diagnostic that is provably fatal at runtime may block**. Three
 * kinds qualify, and each was measured rather than assumed:
 *
 * - **A name the VM does not install.** A bare `vm.createContext({})` is a plain
 *   V8 context: it carries the ECMAScript intrinsics and, measurably, `console`
 *   and `globalThis` — and nothing else. `process`, `require`, `fetch`, every
 *   timer, `Buffer`, `URL`, `TextEncoder`, `structuredClone` and `crypto` are all
 *   absent, so referencing one is a guaranteed `ReferenceError`. The compiler
 *   option `lib: ['lib.es2022.d.ts']` with `types: []` makes the checker's view of
 *   the world *exactly* that surface, which is why the lib is pinned rather than
 *   left to the environment's defaults.
 * - **A dynamic `import()`.** Confirmed fatal in a contextified VM:
 *   `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. No name-based rule can see this —
 *   the callee is a keyword, not an identifier — which is why it is an AST check.
 *   (A *static* `import` statement needs no rule here: `vm.Script` already refuses
 *   it as a syntax error, so the engine owns that case.)
 * - **An `agent()` option the runtime rejects.** The guest throws
 *   `UNSUPPORTED_OPTION` for any key outside `label`/`phase`/`schema`/`provider`/
 *   `model`, and `effort`/`isolation`/`agentType` are named-deferred rather than
 *   merely unknown. Any of those in an object literal is fatal, so catching it
 *   here only moves the failure earlier.
 *
 * Every other diagnostic the checker produces is **reported and not enforced**.
 * That boundary is the point: an ordinary type complaint is a hint, and the JS
 * engine will happily run a script the checker dislikes (a parameter without a
 * type, a property read off `any`). Blocking those would turn advice into a
 * refusal to work.
 *
 * Which calls this gate applies to
 * --------------------------------
 * Argument shape, not tool name: the `workflow` tool's name is a documented
 * configuration knob (`toolName`, default `workflow`), so a name-keyed rule stops
 * guarding the moment a deployment renames it. A call whose arguments carry a
 * string `script` is precisely a call that hands the engine a model-authored body
 * — which is the only kind that can be checked this way. The sibling `ralph` tool
 * carries no `script` argument (its body is a fixed constant compiled into the
 * plugin's own engine build), so it is correctly left alone.
 *
 * Line numbers
 * ------------
 * The checked text is `PRELUDE + body + EPILOGUE`, the same wrapper the engine's
 * guest compiles (`workflow-ptc/src/runtime.ts`), which is one line long. A
 * position's 0-based line index in that text therefore *is* the 1-based line
 * number in the body the model wrote — the same cancellation the runtime gets from
 * `lineOffset: -1`. Columns need the usual 0-to-1 shift.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/workflow-static-check
 */

import { createRequire } from 'node:module'
import type * as TypeScript from 'typescript'

/**
 * Names a workflow script cannot reach, measured against a bare contextified VM.
 *
 * `console` and `globalThis` are deliberately absent from this list: both are
 * present in a `vm.createContext({})`, so listing either would reject a script
 * that works.
 */
export const UNAVAILABLE_SCRIPT_GLOBALS: readonly string[] = [
  'process', 'require', 'fetch',
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',
  'queueMicrotask', 'structuredClone',
  'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'atob', 'btoa', 'crypto', 'performance',
  '__dirname', '__filename', 'module', 'exports',
]

/** The `agent()` options the guest accepts. */
export const SUPPORTED_AGENT_OPTIONS: readonly string[] = ['label', 'phase', 'schema', 'provider', 'model']

/**
 * Options the runtime names explicitly in its rejection, so the static message
 * can explain them instead of listing them as merely unknown.
 */
export const DEFERRED_AGENT_OPTIONS: readonly string[] = ['effort', 'isolation', 'agentType']

/** The hook names a script may call; `args` is a value, not a hook. */
export const HOOK_NAMES: readonly string[] = ['agent', 'parallel', 'pipeline', 'phase', 'log']

/** The wrapper the guest compiles around a body, which the checker must mirror. */
export const SCRIPT_PRELUDE = '(async () => {\n'
export const SCRIPT_EPILOGUE = '\n})()'

/**
 * The global surface the VM installs, as TypeScript sees it.
 *
 * A declaration file with no top-level `import`/`export` is a global script, so
 * every name here is ambient — which is what a VM context's globals are. The
 * hook signatures mirror the guest's own argument checks: `agent()` takes a
 * required prompt string and a closed options bag, and the combinators take
 * functions.
 */
export const WORKFLOW_FACADE_DTS = `interface WorkflowAgentOptions {
  label?: string
  phase?: string
  provider?: string
  model?: string
  schema?: Record<string, unknown>
}
declare function agent(prompt: string, options?: WorkflowAgentOptions): Promise<any>
declare function parallel(thunks: Array<() => any>): Promise<any[]>
declare function pipeline(items: Array<any>, ...stages: Array<(previous: any, item: any, index: number) => any>): Promise<any[]>
declare function phase(title: string): void
declare function log(message: string): void
declare const args: any
declare const console: { log(...values: any[]): void, error(...values: any[]): void, warn(...values: any[]): void, info(...values: any[]): void }
`

/** Virtual path the body is checked under; also the diagnostic filter. */
const VIRTUAL_SCRIPT = '/workflow-script.js'

/** Virtual path of the façade. */
const VIRTUAL_FACADE = '/workflow-facade.d.ts'

/** `ts.Diagnostics.Cannot_find_name_0`. */
const CANNOT_FIND_NAME = 2304

/**
 * `ts.Diagnostics.Cannot_find_name_0_Did_you_mean_to_set_the_moduleResolution...` —
 * the same finding with an `@types/node` hint attached.
 */
const CANNOT_FIND_NAME_WITH_NODE_HINT = 2591

/**
 * The unresolved name, read out of the rendered message.
 *
 * Read from the text because that is the only place it exists: measured against the
 * installed compiler, `Cannot_find_name_0` arrives as a **plain string** with no
 * argument chain to read, and the same opening carries the `@types/node` variant under
 * a second code. One anchored pattern covers both; the exhaustive test over
 * {@link UNAVAILABLE_SCRIPT_GLOBALS} fails the moment upstream rewords it.
 */
const UNRESOLVED_NAME = /^Cannot find name '([^']+)'\./

/**
 * Why a diagnostic is allowed to stop a run, and the two codes used to say so.
 *
 * A `reason` is carried on every blocking diagnostic so the classifier is one
 * closed list rather than a set of exceptions scattered through the walk.
 */
export type ScriptDiagnosticReason = 'unavailable-global' | 'dynamic-import' | 'unsupported-agent-option'

/** One finding, positioned in the body the model wrote. */
export interface ScriptDiagnostic {
  /** 1-based line in the script body. */
  readonly line: number
  /** 1-based column in the script body. */
  readonly column: number
  /** The TypeScript diagnostic code, or `0` for a check this module performs itself. */
  readonly code: number
  /** Whether this finding is provably fatal, and therefore stops the run. */
  readonly blocking: boolean
  /** Present only on a blocking finding; names the rule that fired. */
  readonly reason?: ScriptDiagnosticReason
  /** Model-facing explanation, including how to repair the script. */
  readonly message: string
}

/**
 * One hook call in the script body.
 *
 * The ordinal is deliberately a **display coordinate, not an identity**: two runs
 * of the same script share it, and a resumed run must key its replay on the
 * content it recorded rather than on "the third `agent()` call". It is here
 * because a site table is what a progress view and a run graph need, and because
 * collecting it costs one walk that the checker is already doing.
 */
export interface HookSite {
  readonly name: string
  readonly line: number
  readonly column: number
  /** 1-based ordinal among sites of this hook name, in source order. */
  readonly ordinal: number
}

/** The result of analyzing one script body. */
export interface ScriptAnalysis {
  /** Every finding, blocking and advisory, in source order. */
  readonly diagnostics: readonly ScriptDiagnostic[]
  /** Hook call sites, in source order. */
  readonly sites: readonly HookSite[]
}

let loaded: typeof TypeScript | undefined

/**
 * Load the TypeScript compiler on first use.
 *
 * Loaded lazily and synchronously: a deployment that never runs a workflow should
 * not pay for the compiler at startup, and the plugin's whole pre-execute path is
 * synchronous bar this hook. Absence is a hard failure rather than a skipped
 * check — a gate that silently stops guarding is the outcome worth avoiding most.
 * @returns the TypeScript module surface.
 * @throws when `typescript` is not installed.
 */
function loadTypeScript(): typeof TypeScript {
  if (loaded !== undefined) return loaded
  try {
    loaded = createRequire(import.meta.url)('typescript') as typeof TypeScript
  } catch (error: unknown) {
    throw new Error(
      'workflow static checks need the `typescript` package at runtime, and it could not be loaded',
      { cause: error },
    )
  }
  return loaded
}

/**
 * The name an unresolved-identifier diagnostic is about, when it is one.
 *
 * A diagnostic whose code is one of the two but whose name cannot be read returns
 * `undefined`, and the caller then leaves it advisory: mis-reading a message must
 * never become a reason to refuse a run.
 * @param diagnostic - the diagnostic to inspect.
 * @returns the unresolved name, or `undefined` for any other diagnostic.
 */
function unresolvedName(diagnostic: TypeScript.Diagnostic): string | undefined {
  if (diagnostic.code !== CANNOT_FIND_NAME && diagnostic.code !== CANNOT_FIND_NAME_WITH_NODE_HINT) return undefined
  const message = diagnostic.messageText
  const text = typeof message === 'string' ? message : message.messageText
  return UNRESOLVED_NAME.exec(text)?.[1]
}

/**
 * Why this name cannot work, in place of the compiler's own advice.
 *
 * TypeScript suggests installing `@types/node` for four of these
 * (`process`, `require`, `Buffer`, `module`). Following that advice would silence the
 * diagnostic and change nothing about the runtime: the sandboxed VM has no host
 * globals, so the call still throws — the hint would buy a passing check and a failing
 * run, which is the exact outcome this gate exists to prevent.
 * @param name - the unavailable global.
 * @returns model-facing explanation and repair.
 */
function unavailableGlobalMessage(name: string): string {
  return `${name} is not available to a workflow script: the sandboxed VM installs only the ECMAScript intrinsics, so this is a ReferenceError at runtime. The script coordinates subagents — have the subagents do the work that needs ${name}, or drop the dependency.`
}

/** A parsed diagnostic position, already translated into body coordinates. */
function bodyPosition(file: TypeScript.SourceFile, start: number): { line: number; column: number } {
  const { line, character } = file.getLineAndCharacterOfPosition(start)
  // `line` is a 0-based index into `PRELUDE + body`, and the prelude is exactly one
  // line, so the index is already the 1-based line of the body. See the module doc.
  return { line, column: character + 1 }
}

/**
 * Analyze one workflow script body without executing it.
 *
 * Pure: no context, no I/O beyond loading the compiler, no side effects. The
 * caller decides what to do with the findings.
 * @param body - the script body exactly as the tool received it.
 * @returns every finding plus the hook site table, both in source order.
 * @throws when the compiler cannot be loaded.
 */
export function analyzeWorkflowScript(body: string): ScriptAnalysis {
  const ts = loadTypeScript()
  const text = `${SCRIPT_PRELUDE}${body}${SCRIPT_EPILOGUE}`
  const options: TypeScript.CompilerOptions = {
    noEmit: true,
    allowJs: true,
    checkJs: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    // The lib is the script's actual world: ECMAScript intrinsics, no host globals.
    lib: ['lib.es2022.d.ts'],
    // No `@types/*` may enter: ambient Node or DOM declarations would silently
    // make an unavailable global look available, and the check would stop guarding.
    types: [],
    // Calibration taken from the same reference implementation: left off on purpose.
    // Nearly every diagnostic it adds is `items[i]` yielding `T | undefined`, which a
    // model's script does not guard and which the JS engine runs regardless — noise
    // that would bury the findings this gate exists to make.
    noUncheckedIndexedAccess: false,
  }
  const host = ts.createCompilerHost(options)
  // Bound rather than destructured: these three are the host's own methods, and a
  // destructured copy is an unbound reference whose `this` is no longer the host.
  const getSourceFile = host.getSourceFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  const readFile = host.readFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (fileName === VIRTUAL_SCRIPT) return ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.JS)
    if (fileName === VIRTUAL_FACADE) return ts.createSourceFile(fileName, WORKFLOW_FACADE_DTS, languageVersion, true, ts.ScriptKind.TS)
    return getSourceFile(fileName, languageVersion, onError, shouldCreate)
  }
  host.fileExists = fileName =>
    fileName === VIRTUAL_SCRIPT || fileName === VIRTUAL_FACADE || fileExists(fileName)
  host.readFile = fileName =>
    fileName === VIRTUAL_SCRIPT ? text : fileName === VIRTUAL_FACADE ? WORKFLOW_FACADE_DTS : readFile(fileName)

  const program = ts.createProgram({ rootNames: [VIRTUAL_SCRIPT, VIRTUAL_FACADE], options, host })
  const file = program.getSourceFile(VIRTUAL_SCRIPT)
  const facade = program.getSourceFile(VIRTUAL_FACADE)
  /* v8 ignore next -- the host above serves VIRTUAL_SCRIPT unconditionally. */
  if (file === undefined) throw new Error('workflow static checks could not build the virtual script file')
  /* v8 ignore next -- the host above serves VIRTUAL_FACADE unconditionally. */
  if (facade === undefined) throw new Error('workflow static checks could not build the virtual façade')
  const checker = program.getTypeChecker()

  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.file === file && diagnostic.start !== undefined)
    .map((diagnostic): ScriptDiagnostic => {
      const unavailable = unresolvedName(diagnostic)
      const isUnavailableGlobal = unavailable !== undefined && UNAVAILABLE_SCRIPT_GLOBALS.includes(unavailable)
      return {
        ...bodyPosition(file, diagnostic.start as number),
        code: diagnostic.code,
        blocking: isUnavailableGlobal,
        ...isUnavailableGlobal ? { reason: 'unavailable-global' as const } : {},
        message: isUnavailableGlobal
          ? unavailableGlobalMessage(unavailable)
          : ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      }
    })

  const own = collectOwnFindings(ts, file, checker, facade)
  const merged = [...diagnostics, ...own].sort((left, right) =>
    left.line - right.line || left.column - right.column)
  return { diagnostics: merged, sites: collectHookSites(ts, file, checker, facade) }
}

/**
 * Checks this module performs on the syntax tree rather than through the checker.
 *
 * Both are fatal at runtime and neither is expressible as a name lookup: a dynamic
 * `import()` has a keyword for a callee, and an unknown `agent()` option is a
 * property key inside an object literal.
 * @param ts - the loaded compiler surface.
 * @param file - the virtual script file.
 * @param checker - the program's checker, used to resolve a called name.
 * @param facade - the façade file, whose declarations are the real hook names.
 * @returns blocking findings, in source order.
 */
function collectOwnFindings(
  ts: typeof TypeScript,
  file: TypeScript.SourceFile,
  checker: TypeScript.TypeChecker,
  facade: TypeScript.SourceFile,
): ScriptDiagnostic[] {
  const found: ScriptDiagnostic[] = []
  const record = (node: TypeScript.Node, reason: ScriptDiagnosticReason, message: string): void => {
    found.push({ ...bodyPosition(file, node.getStart(file)), code: 0, blocking: true, reason, message })
  }

  const visit = (node: TypeScript.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        record(node, 'dynamic-import',
          'a dynamic `import()` never resolves in a workflow script: the sandboxed VM has no import callback, so this call always fails with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING. Remove it — a workflow coordinates subagents, and they do the work that needs modules.')
      }
      if (ts.isIdentifier(callee) && callee.text === 'agent' && resolvesToFacade(checker, facade, callee)) {
        const options = node.arguments[1]
        if (options !== undefined && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            const key = propertyName(ts, property)
            if (key === undefined || SUPPORTED_AGENT_OPTIONS.includes(key)) continue
            record(property, 'unsupported-agent-option',
              DEFERRED_AGENT_OPTIONS.includes(key)
                ? `agent() option "${key}" is deferred and not supported by this engine (supported: ${SUPPORTED_AGENT_OPTIONS.join(', ')})`
                : `agent() option "${key}" is not recognized (supported: ${SUPPORTED_AGENT_OPTIONS.join(', ')})`)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * Whether a called name resolves to the façade's own declaration.
 *
 * Resolution rather than spelling, because a script may shadow a hook with a binding of
 * its own: `const agent = myHelper` makes `agent(...)` a call to the script's function,
 * and treating that call's options as the guest's would refuse a script that runs
 * perfectly. The checker already knows which declaration a name binds to, so this asks
 * it rather than guessing from the name.
 * @param checker - the program's checker.
 * @param facade - the façade file.
 * @param identifier - the called name.
 * @returns whether the name binds to a façade declaration.
 */
function resolvesToFacade(checker: TypeScript.TypeChecker, facade: TypeScript.SourceFile, identifier: TypeScript.Identifier): boolean {
  const declarations = checker.getSymbolAtLocation(identifier)?.declarations
  return declarations?.some(declaration => declaration.getSourceFile() === facade) ?? false
}

/**
 * The statically known name of an object-literal member, when it has one.
 *
 * The three node kinds admitted below declare a required `PropertyName`, so there is
 * no "named nothing" case to check for: what can still be absent is a *statically
 * known* name, which is what the final `undefined` covers (a computed key, a spread).
 */
function propertyName(ts: typeof TypeScript, property: TypeScript.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property)
    && !ts.isShorthandPropertyAssignment(property)
    && !ts.isMethodDeclaration(property)) return undefined
  const name = property.name
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

/**
 * Collect every hook call site in the body, in source order.
 * @param ts - the loaded compiler surface.
 * @param file - the virtual script file.
 * @param checker - the program's checker, used to resolve a called name.
 * @param facade - the façade file, whose declarations are the real hook names.
 * @returns the site table.
 */
function collectHookSites(
  ts: typeof TypeScript,
  file: TypeScript.SourceFile,
  checker: TypeScript.TypeChecker,
  facade: TypeScript.SourceFile,
): HookSite[] {
  const sites: HookSite[] = []
  const counts = new Map<string, number>()
  const bodyStart = SCRIPT_PRELUDE.length
  const visit = (node: TypeScript.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee)
        && HOOK_NAMES.includes(callee.text)
        && resolvesToFacade(checker, facade, callee)
        && node.getStart(file) >= bodyStart) {
        const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file))
        const ordinal = (counts.get(callee.text) ?? 0) + 1
        counts.set(callee.text, ordinal)
        sites.push({ name: callee.text, line, column: character + 1, ordinal })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return sites
}

/**
 * Render findings for a model-facing error message.
 * @param diagnostics - findings to render, typically only the blocking ones.
 * @param limit - most findings to render before summarizing the remainder.
 * @returns one line per finding, plus a count when some were omitted.
 */
export function formatScriptDiagnostics(diagnostics: readonly ScriptDiagnostic[], limit = 20): string {
  const shown = diagnostics.slice(0, limit)
  const lines = shown.map(diagnostic =>
    `  ${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`)
  const omitted = diagnostics.length - shown.length
  if (omitted > 0) lines.push(`  … and ${omitted} more finding${omitted === 1 ? '' : 's'}`)
  return lines.join('\n')
}

/**
 * The refusal this call deserves, or `undefined` when the script may run.
 *
 * Keyed on the argument **shape** rather than the tool name, because the name is a
 * documented configuration knob: a call whose arguments carry a string `script` is
 * exactly a call that hands the engine a model-authored body. Only blocking
 * findings are fatal, so a script the checker merely dislikes still runs — and a
 * body that is not a string is left to the engine, whose own validation owns the
 * shape of the request.
 *
 * **A gate that cannot run refuses.** Both directions are visible to the caller, but
 * only one of them is recoverable: letting the script through would mean the check
 * stopped guarding on a broken install, which is the outcome this module exists to
 * prevent. Returning a refusal instead of throwing across the seam is deliberate —
 * a throw leaves the outcome to whatever the host does with a failing `tools/
 * pre-execute` listener, and that is not this module's decision to delegate. The
 * message names the *install*, not the script, so nobody hunts for a bug in a body
 * that is fine.
 * @param args - the executing call's arguments, as the tool seam carries them.
 * @param analyze - the analyzer to consult; a parameter so the "gate itself is broken"
 * branch is reachable in a test instead of only on a user's machine.
 * @returns the model-facing refusal, or `undefined` when nothing blocks.
 */
export function workflowScriptRefusal(
  args: unknown,
  analyze: (body: string) => ScriptAnalysis = analyzeWorkflowScript,
): string | undefined {
  const script = (args as { readonly script?: unknown } | undefined)?.script
  if (typeof script !== 'string' || script.trim() === '') return undefined
  let analysis: ScriptAnalysis
  try {
    analysis = analyze(script)
  } catch (error: unknown) {
    return 'this workflow script could not be checked before running, so the run was not started: '
      + `${error instanceof Error ? error.message : String(error)}. `
      + 'The static gate type-checks a script against the runner façade and needs the `typescript` package at runtime; a script that is never checked is not run for that reason.'
  }
  const blocking = analysis.diagnostics.filter(diagnostic => diagnostic.blocking)
  if (blocking.length === 0) return undefined
  return 'this workflow script fails checks that would fail at runtime, so the run was not started:\n'
    + `${formatScriptDiagnostics(blocking)}\n`
    + 'Fix these and call the tool again; no child agent was started.'
}
