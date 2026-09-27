/**
 * The model-facing Impeccable detector tool.
 *
 * One tool, two backends, and the answer always says which one replied. That
 * shape is copied deliberately from `design/browser.ts`, which resolves the
 * machine's own browser rather than shipping one: the higher-fidelity path is
 * used when the machine already has it, the built-in path answers otherwise, and
 * the caller is told which happened because the two are not equally strong.
 *
 *  - **`engine`** — an Impeccable engine that is already installed. All 61 rules,
 *    including the ones that need a rendered page. Never downloaded: `./engine.ts`
 *    only looks.
 *  - **`builtin`** — this package's subset, scanned in process from source text.
 *    It names the rules it ran and the upstream total beside them, so a caller can
 *    tell a clean file from an unchecked one.
 *
 * The tool never writes anything, and it reads only through the `fs` service, so a
 * model-supplied path is resolved by the backend that owns the sandbox rather than
 * by this process. It carries the `freecodego_` prefix and is registered by the
 * design page's own switch, like every other tool in the pack.
 *
 * @module impeccable/tool
 */

import type { Context } from '@deepseek-ai/cordis'

import { JSON_TOOL_OUTPUT, toolDefinition, type ToolDefinitionShape } from '../tool-definition.ts'
import {
  IMPECCABLE_ENGINE_ENV,
  firstString,
  readEngineFindings,
  resolveImpeccableEngine,
  runImpeccableDetect,
  type ImpeccableEngine,
} from './engine.ts'
import {
  IMPECCABLE_UPSTREAM,
  scanSource,
  type ImpeccableCategory,
  type ImpeccableFinding,
} from './rules.ts'

/** Registered tool name; prefixed so Harness deferral and Plan Mode classify it. */
export const IMPECCABLE_DETECT_TOOL_NAME = 'freecodego_design_detect'

/** Longest path this tool accepts. */
const PATH_MAX_CHARS = 1_024

/** Extensions the built-in backend reads. Anything else is skipped by name. */
const SCANNABLE_EXTENSIONS: readonly string[] = [
  '.css', '.scss', '.less', '.html', '.htm', '.vue', '.svelte', '.astro',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mdx',
]

/** Default and maximum numbers of files the built-in backend will read. */
const DEFAULT_MAX_FILES = 40
const MAX_FILES_CEILING = 200

/** Largest single file the built-in backend reads, and its total per call. */
const FILE_MAX_BYTES = 1024 * 1024
const TOTAL_MAX_BYTES = 8 * 1024 * 1024

/** How deep a directory walk goes before it reports the bound instead of walking. */
const WALK_MAX_DEPTH = 4

/** Longest engine output echoed back into a tool result. */
const ENGINE_REPORT_MAX_CHARS = 20_000

/** The subset of the Harness `fs` service this tool uses. */
export interface DetectFileService {
  resolve(path: string): Promise<unknown>
  readText(target: unknown): Promise<string>
  /** Absent when this composition's file service cannot list a directory. */
  listDir?(target: unknown): Promise<readonly {
    readonly name: string
    readonly type: 'file' | 'directory' | 'other'
    readonly target: unknown
  }[]>
}

/** A call's execution context, as far as this tool needs it. */
interface DetectToolExec {
  readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } }
}

/** The arguments the model may pass. */
interface DetectArgs {
  readonly path?: unknown
  readonly category?: unknown
  readonly include_advisories?: unknown
  readonly max_files?: unknown
  readonly backend?: unknown
}

/** A refusal states what prevented a scan from running, in the tool's own words. */
interface DetectRefusal {
  readonly kind: 'refused'
  readonly target: string
  readonly reason: string
  readonly message: string
}

/** One normalized finding. */
interface DetectFinding extends ImpeccableFinding {
  /** The file it was found in. Absent on engine findings that name none. */
  readonly file?: string
}

/** What a scan returns. */
interface DetectResult {
  readonly kind: 'scanned'
  readonly target: string
  readonly backend: 'engine' | 'builtin'
  readonly engine?: { readonly path: string; readonly source: string; readonly exitCode?: number }
  /**
   * How the engine's own document was read.
   *
   * Present only for the engine backend, and it carries the document itself
   * whenever its shape was not recognized — upstream publishes no JSON schema, so
   * an unrecognized document is handed over rather than summarized into silence.
   */
  readonly engineReport?: {
    readonly parsed: boolean
    readonly recognized: boolean
    readonly truncated: boolean
    readonly raw?: string
  }
  /** The built-in backend's own accounting; the engine reports its own counts. */
  readonly scanned?: {
    readonly files: number
    readonly bytes: number
    readonly skipped: readonly { readonly path: string; readonly reason: string }[]
  }
  readonly counts: {
    readonly findings: number
    readonly primary: number
    readonly advisory: number
    readonly byCategory: Readonly<Record<string, number>>
    readonly byRule: Readonly<Record<string, number>>
  }
  readonly findings: readonly DetectFinding[]
  readonly coverage: {
    readonly backend: string
    readonly rules: number
    readonly of: number
    readonly note: string
  }
  readonly notes: readonly string[]
}

/** The response union, so a caller can branch on `kind` rather than on fields. */
type DetectResponse = DetectResult | DetectRefusal

/** A refusal in the sentence-shaped form the rest of this pack uses. */
function refused(target: string, reason: string, message: string): DetectRefusal {
  return { kind: 'refused', target, reason, message }
}

/**
 * The absolute path a target argument means, resolved against the caller's cwd.
 *
 * The execution context is optional because the registry's own `execute`
 * signature leaves it that way, and a scan of an absolute path does not need it —
 * a tool that assumed it was there would throw on a host that calls without one.
 */
function resolveTarget(path: string, exec: DetectToolExec | undefined): string {
  const cwd = exec?.agent?.session?.header?.cwd
  const absolute = path.startsWith('/') || /^[a-z]:[\\/]/iu.test(path)
  return cwd === undefined || absolute ? path : `${cwd.replace(/[\\/]+$/u, '')}/${path}`
}

/** Whether a target is a URL, which only the engine can scan. */
function isUrl(target: string): boolean {
  return /^https?:\/\//iu.test(target.trim())
}

/** The file name's extension, lowercased. */
function extensionOf(path: string): string {
  const index = path.lastIndexOf('.')
  return index === -1 ? '' : path.slice(index).toLowerCase()
}

/** Join a directory path and an entry name without doubling a separator. */
function joinPath(directory: string, name: string): string {
  return `${directory.replace(/[\\/]+$/u, '')}/${name}`
}

/** Count findings by category and by rule, for a caller that wants the shape only. */
function tally(findings: readonly DetectFinding[]): DetectResult['counts'] {
  const byCategory: Record<string, number> = {}
  const byRule: Record<string, number> = {}
  let primary = 0
  let advisory = 0
  for (const finding of findings) {
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1
    byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1
    if (finding.severity === 'advisory') advisory += 1
    else primary += 1
  }
  return { findings: findings.length, primary, advisory, byCategory, byRule }
}

/** The engine's rows, mapped into the pack's finding shape. */
function findingsFromEngineRows(
  rows: readonly Record<string, unknown>[],
  category: ImpeccableCategory | undefined,
): readonly DetectFinding[] {
  const findings: DetectFinding[] = []
  for (const row of rows) {
    const rule = firstString(row, ['rule', 'ruleId', 'rule_id', 'id', 'code', 'name'])
    if (rule === undefined) continue
    const severity = firstString(row, ['severity', 'level', 'kind'])
    const file = firstString(row, ['file', 'path', 'filename', 'source', 'target'])
    const line = row.line ?? row.startLine ?? row.lineNumber
    // Only a number or a numeric string becomes a line: `String()` on whatever
    // else a document happens to carry would produce `[object Object]` and a
    // `NaN` line, which reads as a finding with no place rather than as a row this
    // reader did not understand.
    const numericLine = typeof line === 'number'
      ? line
      : typeof line === 'string' ? Number.parseInt(line, 10) : Number.NaN
    const stated = firstString(row, ['category', 'group'])
    // A row that names no category is `quality`: upstream's `slop` findings are
    // the ones its own documents insists on naming, and mislabeling a craft
    // finding as a tell is the more expensive of the two mistakes.
    const rowCategory: ImpeccableCategory = stated === 'slop' ? 'slop' : 'quality'
    if (category !== undefined && rowCategory !== category) continue
    findings.push({
      rule,
      ruleName: firstString(row, ['ruleName', 'title', 'label']) ?? rule,
      category: rowCategory,
      // `advisory` is upstream's own word for a finding that must not fail a build.
      severity: /advis|info|note/iu.test(severity ?? '') ? 'advisory' : 'primary',
      line: Number.isFinite(numericLine) ? numericLine : 0,
      snippet: firstString(row, ['snippet', 'excerpt', 'location', 'selector']) ?? '',
      message: firstString(row, ['message', 'description', 'detail', 'advice', 'why', 'recommendation']) ?? '',
      ...file === undefined ? {} : { file },
    })
  }
  return findings
}

/** One entry the built-in backend still has to visit. */
interface WalkEntry {
  readonly path: string
  readonly type: 'file' | 'directory' | 'other'
  readonly target: unknown
  readonly depth: number
}

/**
 * The files under one directory that the built-in backend will read.
 *
 * Every departure from "read everything" is pushed into `skipped` with its
 * reason. A scan that quietly read four of forty files and reported no findings
 * reads exactly like a clean directory, and the difference matters most when the
 * news is good.
 */
async function collectFiles(
  service: DetectFileService,
  root: unknown,
  rootPath: string,
  maxFiles: number,
  skipped: { path: string; reason: string }[],
): Promise<readonly { readonly path: string; readonly target: unknown }[]> {
  if (service.listDir === undefined) return []
  const files: { path: string; target: unknown }[] = []
  const queue: WalkEntry[] = (await service.listDir(root).catch(() => []))
    .map(entry => ({ path: joinPath(rootPath, entry.name), type: entry.type, target: entry.target, depth: 1 }))

  while (queue.length > 0) {
    if (files.length >= maxFiles) {
      skipped.push({ path: rootPath, reason: `stopped after ${String(maxFiles)} files` })
      break
    }
    const current = queue.shift()
    if (current === undefined) break
    if (current.type === 'directory') {
      if (current.depth > WALK_MAX_DEPTH) {
        skipped.push({ path: current.path, reason: `deeper than ${String(WALK_MAX_DEPTH)} directories` })
        continue
      }
      const children = await service.listDir(current.target).catch(() => [])
      for (const child of children) {
        queue.push({ path: joinPath(current.path, child.name), type: child.type, target: child.target, depth: current.depth + 1 })
      }
      continue
    }
    if (current.type !== 'file') {
      skipped.push({ path: current.path, reason: 'not a regular file' })
      continue
    }
    const extension = extensionOf(current.path)
    if (!SCANNABLE_EXTENSIONS.includes(extension)) {
      skipped.push({ path: current.path, reason: `extension ${extension === '' ? '(none)' : extension} is not a UI source file` })
      continue
    }
    files.push({ path: current.path, target: current.target })
  }
  return files
}

/** Read and scan one target with the built-in subset. */
async function runBuiltin(
  service: DetectFileService,
  target: unknown,
  path: string,
  options: { readonly maxFiles: number; readonly category?: ImpeccableCategory; readonly includeAdvisories: boolean },
): Promise<{ readonly result: DetectResult } | { readonly refusal: DetectRefusal }> {
  const skipped: { path: string; reason: string }[] = []
  // One read answers "is this a file" without a second listing call, and its text
  // is reused rather than read twice.
  const asFile = await service.readText(target).then(text => ({ text }), () => undefined)
  const files = asFile === undefined
    ? await collectFiles(service, target, path, options.maxFiles, skipped)
    : [{ path, target }]

  if (files.length === 0) {
    return {
      refusal: service.listDir === undefined
        ? refused(path, 'unreadable-target', `"${path}" is not a readable file and this installation's file service cannot list a directory, so the built-in detector has nothing to read. Name a single file, or install an Impeccable engine for the full detector.`)
        : refused(path, 'no-scannable-files', `No UI source files were found under "${path}".`),
    }
  }

  const found: DetectFinding[] = []
  const rules = new Set<string>()
  let bytes = 0
  for (const file of files) {
    if (bytes >= TOTAL_MAX_BYTES) { skipped.push({ path: file.path, reason: 'the total read limit was reached' }); continue }
    const text = file.path === path && asFile !== undefined
      ? asFile.text
      : await service.readText(file.target).catch(() => undefined)
    if (text === undefined) { skipped.push({ path: file.path, reason: 'the file could not be read' }); continue }
    const size = Buffer.byteLength(text, 'utf8')
    if (size > FILE_MAX_BYTES) { skipped.push({ path: file.path, reason: `larger than ${String(FILE_MAX_BYTES)} bytes` }); continue }
    bytes += size
    const report = scanSource(file.path, text)
    for (const rule of report.rulesApplied) rules.add(rule)
    for (const finding of report.findings) found.push({ ...finding, file: file.path })
  }

  const selected = found
    .filter(finding => options.category === undefined || finding.category === options.category)
    // Advisories are observations; a caller that did not ask for them gets the
    // same view upstream's exit code describes.
    .filter(finding => options.includeAdvisories || finding.severity !== 'advisory')

  return {
    result: {
      kind: 'scanned',
      target: path,
      backend: 'builtin',
      scanned: { files: files.length, bytes, skipped },
      counts: tally(selected),
      findings: selected,
      coverage: {
        backend: 'builtin',
        rules: rules.size,
        of: IMPECCABLE_UPSTREAM.ruleCount,
        note: `The built-in subset covers the rules a source file can decide, ${String(rules.size)} of upstream's ${String(IMPECCABLE_UPSTREAM.ruleCount)}. The rest need a rendered page or a document model, and an installed engine answers all of them.`,
      },
      notes: found.length === selected.length ? [] : [`${String(found.length - selected.length)} advisory finding(s) were withheld; pass include_advisories to see them.`],
    },
  }
}

/** Run the installed engine over one target. */
async function runEngine(
  engine: ImpeccableEngine,
  options: { readonly includeAdvisories: boolean; readonly path: string; readonly cwd?: string; readonly category?: ImpeccableCategory },
): Promise<{ readonly result: DetectResult } | { readonly refusal: DetectRefusal } | { readonly fallback: string }> {
  const outcome = await runImpeccableDetect(engine, {
    ...options.cwd === undefined ? {} : { cwd: options.cwd },
    targets: [options.path],
    includeAdvisories: options.includeAdvisories,
  })
  if (outcome.failure !== undefined) return { fallback: `The Impeccable engine at "${engine.path}" could not be started: ${outcome.failure}` }
  if (outcome.timedOut) return { fallback: `The Impeccable engine at "${engine.path}" did not finish inside its deadline.` }
  // Exit 1 is upstream's "at least one target could not be scanned", which is an
  // answer about the target rather than a reason to present an empty scan.
  if (outcome.exitCode === 1 && outcome.stdout.trim() === '') {
    return {
      refusal: refused(options.path, 'engine-could-not-scan',
        `The Impeccable engine could not scan "${options.path}": ${outcome.stderr.trim().slice(0, 400)}`),
    }
  }

  const read = readEngineFindings(outcome.stdout)
  const findings = findingsFromEngineRows(read.rows, options.category)
  const notes: string[] = []
  if (!read.parsed && outcome.stdout.trim() !== '') {
    notes.push('The engine did not emit a JSON document on stdout, so its output is returned verbatim.')
  }
  if (read.parsed && !read.recognized) {
    notes.push('Upstream publishes no JSON schema for this document, and its shape was not recognized, so no findings were extracted from it and the document is returned verbatim.')
  }
  if (outcome.truncated) notes.push('The engine\'s output hit this tool\'s ceiling and was truncated.')

  const raw = outcome.stdout.slice(0, ENGINE_REPORT_MAX_CHARS)
  return {
    result: {
      kind: 'scanned',
      target: options.path,
      backend: 'engine',
      engine: { path: engine.path, source: engine.source, ...outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode } },
      engineReport: {
        parsed: read.parsed,
        recognized: read.recognized,
        truncated: outcome.truncated || outcome.stdout.length > raw.length,
        ...read.recognized ? {} : { raw },
      },
      counts: tally(findings),
      findings,
      coverage: {
        backend: 'engine',
        rules: new Set(findings.map(finding => finding.rule)).size,
        of: IMPECCABLE_UPSTREAM.ruleCount,
        note: 'These findings are the installed engine\'s own. Rule ids match upstream\'s documentation and its `impeccable ignores` commands.',
      },
      notes: outcome.stderr.trim() === '' ? notes : [...notes, `Engine diagnostics: ${outcome.stderr.trim().slice(0, 1_000)}`],
    },
  }
}

/** Validate the arguments and run whichever backend the call can use. */
async function runDetect(ctx: Context, input: unknown, exec: DetectToolExec | undefined): Promise<DetectResponse> {
  if (typeof input !== 'object' || input === null) return refused('', 'invalid-arguments', 'Provide a JSON object with a path to scan.')
  const args = input as DetectArgs
  if (typeof args.path !== 'string' || args.path.trim() === '') return refused('', 'invalid-path', 'Provide a non-empty path or URL to scan.')
  const rawPath = args.path.trim()
  if (rawPath.length > PATH_MAX_CHARS) return refused(rawPath.slice(0, PATH_MAX_CHARS), 'path-too-long', `The path exceeds ${String(PATH_MAX_CHARS)} characters.`)
  const category = args.category
  if (category !== undefined && category !== 'slop' && category !== 'quality') {
    return refused(rawPath, 'invalid-category', 'category must be "slop" or "quality".')
  }
  const backend = args.backend
  if (backend !== undefined && backend !== 'auto' && backend !== 'builtin') {
    return refused(rawPath, 'invalid-backend', 'backend must be "auto" (use an installed engine when there is one) or "builtin".')
  }
  const maxFiles = args.max_files === undefined ? DEFAULT_MAX_FILES : args.max_files
  if (typeof maxFiles !== 'number' || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES_CEILING) {
    return refused(rawPath, 'invalid-max-files', `max_files must be an integer from 1 to ${String(MAX_FILES_CEILING)}.`)
  }
  if (args.include_advisories !== undefined && typeof args.include_advisories !== 'boolean') {
    return refused(rawPath, 'invalid-advisories', 'include_advisories must be a boolean.')
  }
  const includeAdvisories = args.include_advisories === true
  const cwd = exec?.agent?.session?.header?.cwd
  const target = isUrl(rawPath) ? rawPath : resolveTarget(rawPath, exec)
  const notes: string[] = []

  if (backend !== 'builtin') {
    const engine = resolveImpeccableEngine()
    if (engine !== undefined) {
      const outcome = await runEngine(engine, {
        includeAdvisories,
        path: target,
        ...cwd === undefined ? {} : { cwd },
        ...category === undefined ? {} : { category },
      })
      if ('result' in outcome) return outcome.result
      if ('refusal' in outcome) return outcome.refusal
      // A broken engine is recorded and the built-in subset answers instead: the
      // capability is a scan, not a particular binary.
      if (isUrl(target)) {
        return refused(target, 'engine-required-for-url',
          `${outcome.fallback} A URL can only be scanned by the engine, because the built-in subset reads source files.`)
      }
      notes.push(outcome.fallback)
    } else if (isUrl(target)) {
      return refused(target, 'engine-required-for-url',
        `No Impeccable engine is installed, and a URL can only be scanned by the engine. Install one (\`npx impeccable install\`), set ${IMPECCABLE_ENGINE_ENV} to an engine path, or name a source file for the built-in subset.`)
    } else {
      notes.push(`No Impeccable engine was found on ${IMPECCABLE_ENGINE_ENV}, $PATH, or ~/.impeccable/bin, so the built-in subset answered.`)
    }
  }

  const service = ctx.get('fs') as DetectFileService | undefined
  if (service === undefined) {
    return refused(target, 'no-file-service', 'This installation provides no file service, so the built-in detector cannot read the target.')
  }
  const resolved = await service.resolve(target).catch(() => undefined)
  if (resolved === undefined) {
    return refused(target, 'unresolved-target', `The file service could not resolve "${target}".`)
  }
  const builtin = await runBuiltin(service, resolved, target, {
    maxFiles,
    includeAdvisories,
    ...category === undefined ? {} : { category },
  })
  if ('refusal' in builtin) return builtin.refusal
  return { ...builtin.result, notes: [...notes, ...builtin.result.notes] }
}

/**
 * The detector definition this package ships.
 *
 * Exported as the definition rather than as a registration because the design
 * page's feature table registers tools by name — one name, one builder, so a row
 * on the page cannot offer a tool this build registers under a different id.
 *
 * @param ctx - the calling context, captured so a scan reads through this
 *              installation's own file service.
 * @returns the definition, named {@link IMPECCABLE_DETECT_TOOL_NAME}.
 */
export function impeccableDetectToolDefinition(ctx: Context): ToolDefinitionShape {
  return toolDefinition({
    name: IMPECCABLE_DETECT_TOOL_NAME,
    description: 'Scan UI source for known design problems, using the Impeccable design language\'s detector. Reads an installed Impeccable engine when this machine has one (all 61 upstream rules, including the ones that need a rendered page, plus a project\'s DESIGN.md checks); otherwise it uses the subset built into this package that a source file can decide, and the answer names which backend replied, the rules it ran, and the upstream total. Takes a file, a directory, or a URL, and never writes, downloads, or installs anything. Findings carry upstream\'s rule ids, so the same wording applies here as in Impeccable\'s own documentation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: PATH_MAX_CHARS,
          description: 'File, directory, or http(s) URL to scan, relative to the session working directory unless absolute.',
        },
        category: {
          type: 'string',
          enum: ['slop', 'quality'],
          description: 'Keep only upstream\'s "slop" (generated-UI tells) or "quality" (craft) findings. Defaults to both.',
        },
        include_advisories: {
          type: 'boolean',
          description: 'Also return findings upstream marks advisory, which never fail a scan. Defaults to false.',
        },
        max_files: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_FILES_CEILING,
          description: `Largest number of files the built-in backend reads from a directory. Defaults to ${String(DEFAULT_MAX_FILES)}.`,
        },
        backend: {
          type: 'string',
          enum: ['auto', 'builtin'],
          description: 'Defaults to "auto" (use an installed engine when there is one). "builtin" forces the in-package subset.',
        },
      },
    },
    output: JSON_TOOL_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args: DetectArgs, exec: DetectToolExec) => runDetect(ctx, args, exec),
    presentCall: (args: DetectArgs) => ({
      card: 'generic',
      title: `Impeccable detect: ${typeof args.path === 'string' ? args.path.slice(0, 72) : ''}`,
    }),
  })
}
