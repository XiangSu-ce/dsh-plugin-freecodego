/**
 * The Impeccable engine, when the machine already has one.
 *
 * Upstream's `impeccable detect` runs 61 deterministic rules inside a
 * self-contained native binary, and its launcher downloads that binary the first
 * time a skill or hook runs. This module deliberately does not: **it only ever
 * looks for an engine that is already installed**. That distinction is the whole
 * point of the capability's promise on the design page — a switch that fetches a
 * native binary from the network is a different product from one that answers
 * with what the machine has, and a user cannot see the difference until the
 * download has already happened.
 *
 * What that buys and what it costs, stated rather than discovered:
 *
 *  - Installed engine: all 61 rules, upstream's own verdicts, including the ones
 *    that need a rendered page and the checks against a project's `DESIGN.md`.
 *  - No engine: the built-in subset in `./rules.ts`, which answers from source
 *    text alone. It is a real answer with a named bound, not a failure.
 *
 * The probes are deliberately few. `IMPECCABLE_ENGINE` (an explicit path, for a
 * user who keeps the binary somewhere else), `$PATH`, and `~/.impeccable/bin`,
 * which is where upstream's own launcher puts what it downloads. Nothing here
 * shells out to find a binary: a `which`-shaped subprocess would be a second
 * answer to the same question, and on Windows it would be the wrong one.
 *
 * @module impeccable/engine
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Where an engine was found, so a caller can say why it is being used. */
export type ImpeccableEngineSource = 'env' | 'path' | 'home'

/** A located engine binary. Nothing is executed to produce this. */
export interface ImpeccableEngine {
  /** Absolute path, or the bare name when it was found on `$PATH`. */
  readonly path: string
  readonly source: ImpeccableEngineSource
}

/** What the resolution reads; every field is injectable so the probes are testable. */
export interface EngineResolutionOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  /** The user's home directory, for the `~/.impeccable/bin` probe. */
  readonly home?: string
  /** Injected in tests; defaults to `node:fs`'s answer. */
  readonly exists?: (path: string) => boolean
}

/** The environment variable that overrides every probe. */
export const IMPECCABLE_ENGINE_ENV = 'IMPECCABLE_ENGINE'

/** The launcher's own install directory, relative to the user's home. */
const HOME_INSTALL = join('.impeccable', 'bin')

/**
 * The file names an engine can have, most specific first.
 *
 * Windows needs the list: a copied release is `impeccable.exe`, and the
 * extension-less name is kept last so it loses to the real executable beside it.
 * The npm shim (`impeccable.cmd`) is **located but not launched** — see
 * {@link spawnEngine} — and it is here rather than absent for the reason the
 * probes are here at all: a name that is found and explained is a better answer
 * than one that is missing with no way to tell why.
 */
function candidateNames(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? ['impeccable.exe', 'impeccable.cmd', 'impeccable.bat', 'impeccable'] : ['impeccable']
}

/**
 * Shell shims that are found on `$PATH` and cannot be launched by `execFile`.
 *
 * Node refuses a `.cmd`/`.bat` without a shell (`EINVAL`), and this module does
 * not use one: `spawnEngine` hands the engine a model-supplied *target*, and a
 * target passed through a command line would be re-parsed as one — `x&calc` is a
 * file name here and two commands there. So the shim is reported as the reason no
 * engine answered instead of being run a second way, which also puts the fix in
 * front of the user: point `IMPECCABLE_ENGINE` at the executable, or let the
 * upstream launcher place the native binary under `~/.impeccable/bin`, which this
 * module's own probe already reads.
 */
const SHELL_SHIM_EXTENSIONS: readonly string[] = ['.cmd', '.bat', '.ps1']

/** A path that is present, or `undefined`. */
function present(path: string, exists: (path: string) => boolean): string | undefined {
  return exists(path) ? path : undefined
}

/**
 * Find an installed engine, or nothing.
 *
 * @param options - environment, platform and home, all injected for tests.
 * @returns the engine, or `undefined` when this machine has none. A missing
 *          engine is the expected state on most machines, which is why it is a
 *          value rather than a throw.
 */
export function resolveImpeccableEngine(options: EngineResolutionOptions = {}): ImpeccableEngine | undefined {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? environment.HOME ?? environment.USERPROFILE ?? ''
  const exists = options.exists ?? existsSync
  const names = candidateNames(platform)

  const configured = environment[IMPECCABLE_ENGINE_ENV]
  if (configured !== undefined && configured.trim() !== '') {
    const path = present(configured.trim(), exists)
    if (path !== undefined) return { path, source: 'env' }
  }

  if (home !== '') {
    for (const name of names) {
      const path = present(join(home, HOME_INSTALL, name), exists)
      if (path !== undefined) return { path, source: 'home' }
    }
  }

  const pathVariable = environment.PATH ?? environment.Path ?? ''
  if (pathVariable.trim() !== '') {
    for (const directory of pathVariable.split(delimiter)) {
      if (directory.trim() === '') continue
      for (const name of names) {
        const path = present(join(directory, name), exists)
        if (path !== undefined) return { path, source: 'path' }
      }
    }
  }

  return undefined
}

/** How one engine invocation ended, whether or not it exited zero. */
export interface EngineRunOutcome {
  /** `undefined` when the process never started or was killed on the deadline. */
  readonly exitCode: number | undefined
  readonly stdout: string
  readonly stderr: string
  /** Set when the process could not be started at all. */
  readonly failure?: string
  readonly timedOut: boolean
  /** Set when either stream hit the ceiling, so a caller knows it saw a prefix. */
  readonly truncated: boolean
}

/** The spawn this module uses, injectable so no test has to own a process. */
export type EngineRunner = (
  path: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs: number; readonly maxBytes: number },
) => Promise<EngineRunOutcome>

/** What one `detect` invocation is asked for. */
export interface DetectRunOptions {
  /** The directory the engine runs in; it resolves relative targets from here. */
  readonly cwd?: string
  /** The targets to scan: files, directories, or URLs. */
  readonly targets: readonly string[]
  /** Upstream's design domains, e.g. `type`, `layout`. */
  readonly scope?: readonly string[]
  /** Upstream keeps advisories on by default and hides them with this flag. */
  readonly includeAdvisories?: boolean
  /** Only meaningful for URL targets; upstream defaults to 1280x800. */
  readonly viewport?: string
  readonly timeoutMs?: number
  readonly maxBytes?: number
  /** Injected in tests. */
  readonly run?: EngineRunner
}

/** A scan's default deadline: long enough for a URL scan, short enough to stop. */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * A scan's output ceiling.
 *
 * Upstream writes one JSON document to stdout, and a large project's findings can
 * be long. The ceiling exists so that a pathological target cannot put an
 * unbounded string into a tool result and from there into the transcript; when it
 * is hit, the outcome says so rather than presenting a truncated document as a
 * whole one.
 */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/**
 * The `detect` argument list, in the order upstream documents it.
 *
 * @param options - what to scan and how.
 * @returns the argument list, ending with the targets so a caller can see at a
 *          glance what the engine will be pointed at.
 */
export function detectArguments(options: DetectRunOptions): readonly string[] {
  const args = ['detect', '--json']
  if (options.scope !== undefined && options.scope.length > 0) args.push('--scope', options.scope.join(','))
  if (options.viewport !== undefined && options.viewport.trim() !== '') args.push('--viewport', options.viewport.trim())
  // Advisories are observations, not defects, and a caller that did not ask for
  // them gets the same view upstream's exit code describes.
  if (options.includeAdvisories !== true) args.push('--no-advisory')
  args.push(...options.targets)
  return args
}

/**
 * Spawn the engine without a shell, so a target cannot become an argument list.
 *
 * @param path - the located engine binary.
 * @param args - the `detect` argument list from {@link detectArguments}.
 * @param options - the working directory and the bounds on time and output.
 * @returns how the run ended. A refused shim comes back as a `failure` rather
 *          than as an exception, because a reason is an answer here.
 */
export const spawnEngine: EngineRunner = async (path, args, options) => {
  const shim = SHELL_SHIM_EXTENSIONS.find(extension => path.toLowerCase().endsWith(extension))
  if (shim !== undefined) {
    return {
      exitCode: undefined,
      stdout: '',
      stderr: '',
      failure: `"${path}" is a ${shim} shell shim, and this tool launches the engine without a shell so that a scanned target cannot be re-parsed as a command line. Point ${IMPECCABLE_ENGINE_ENV} at the engine executable itself, or let the launcher place the native binary under ~/.impeccable/bin.`,
      timedOut: false,
      truncated: false,
    }
  }
  return await new Promise<EngineRunOutcome>((resolve) => {
    execFile(path, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      timeout: options.timeoutMs,
      maxBuffer: options.maxBytes,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      // A non-zero exit is upstream's normal way of reporting findings (2) and an
      // unscannable target (1), so the streams are read from the error object
      // rather than treated as a crash.
      const failed = error as (Error & { code?: number | string; killed?: boolean }) | null
      const exitCode = typeof failed?.code === 'number' ? failed.code : failed === null ? 0 : undefined
      resolve({
        exitCode,
        // Both streams arrive as strings from `execFile`; the encoding is fixed by
        // the options above, so nothing here has to test what it got.
        stdout,
        stderr,
        ...failed !== null && exitCode === undefined
          // `||`, not `??`: an empty message is as unhelpful as no message, and this
          // string is the whole explanation a refusal carries.
          ? { failure: failed.message || 'the engine could not be started' }
          : {},
        timedOut: failed?.killed === true,
        truncated: typeof failed?.message === 'string' && /maxBuffer/iu.test(failed.message),
      })
    })
  })
}

/**
 * Run `impeccable detect --json`.
 *
 * @param engine - the located binary.
 * @param options - targets, cwd and bounds.
 * @returns the outcome. Never throws on a non-zero exit: a scan that found
 *          problems and a scan that could not read its target are both answers,
 *          and upstream's exit codes are how it tells them apart.
 */
export async function runImpeccableDetect(engine: ImpeccableEngine, options: DetectRunOptions): Promise<EngineRunOutcome> {
  const run = options.run ?? spawnEngine
  return await run(engine.path, detectArguments(options), {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  })
}

/** What upstream's `--json` document yielded. */
export interface EngineFindings {
  /** Rows this module recognized, in upstream's order. */
  readonly rows: readonly Record<string, unknown>[]
  /** Whether an array of findings was found at all. */
  readonly recognized: boolean
  /** Whether stdout parsed as JSON. */
  readonly parsed: boolean
}

/** Keys upstream could plausibly use for the findings array. */
const FINDING_ARRAY_KEYS: readonly string[] = ['findings', 'results', 'issues', 'diagnostics', 'violations']

/**
 * Read the findings rows out of the engine's JSON document.
 *
 * **Upstream does not publish the JSON schema**, and guessing one field name and
 * calling it the answer would be the kind of confidence that survives review and
 * fails in use. So this looks for the shape that is certain — an array of objects
 * under one of the plausible keys, or a bare array — and reports whether it found
 * one. `recognized: false` is a real outcome: the caller then hands the model the
 * document itself rather than a lossy summary, and says so.
 *
 * @param stdout - the engine's standard output.
 * @returns the rows it yielded, plus whether they were recognized.
 */
export function readEngineFindings(stdout: string): EngineFindings {
  const text = stdout.trim()
  if (text === '') return { rows: [], recognized: false, parsed: false }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { rows: [], recognized: false, parsed: false }
  }
  if (Array.isArray(document)) {
    return { rows: document.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null), recognized: true, parsed: true }
  }
  if (typeof document === 'object' && document !== null) {
    const record = document as Record<string, unknown>
    for (const key of FINDING_ARRAY_KEYS) {
      const value = record[key]
      if (Array.isArray(value)) {
        return {
          rows: value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null),
          recognized: true,
          parsed: true,
        }
      }
    }
  }
  return { rows: [], recognized: false, parsed: true }
}

/**
 * The first string among several plausible field names.
 *
 * @param row - one document row, whose field names upstream does not publish.
 * @param keys - the names to try, most specific first.
 * @returns the first non-empty value as a string, or `undefined` when the row
 *          carries none of them.
 */
export function firstString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim() !== '') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}
