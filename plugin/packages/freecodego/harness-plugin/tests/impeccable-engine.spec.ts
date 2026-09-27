/**
 * The engine seam: finding an Impeccable engine that is already installed, and
 * reading what it says.
 *
 * The two things this file is really about are the two promises the design page
 * makes about this capability. **Nothing is downloaded** — so the probes are
 * asked which paths they would accept, with `exists` injected and no filesystem
 * involved, and the case that matters is the one where nothing is found. And
 * **the engine's own document is not guessed at** — upstream publishes no JSON
 * schema, so `readEngineFindings` reports whether it recognized a shape, and an
 * unrecognized document is a value rather than a wrong answer.
 *
 * Every probe takes its environment as an argument rather than reading
 * `process.env`, which is what makes "this machine has no engine" testable on a
 * machine that has one.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/impeccable-engine
 */

import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  IMPECCABLE_ENGINE_ENV,
  detectArguments,
  firstString,
  readEngineFindings,
  resolveImpeccableEngine,
  runImpeccableDetect,
  spawnEngine,
} from '../src/impeccable/engine.ts'

/**
 * A `$PATH`-shaped string, built with the platform's own separator.
 *
 * The whole file is written in terms of the running platform rather than in
 * POSIX-shaped literals, because the probes join a directory and a name with the
 * platform's own `join`: a fixture asserting `/usr/bin/impeccable` on Windows
 * would be asserting a path the module is right not to look for.
 */
function pathVariable(directories: readonly string[]): string {
  return directories.join(process.platform === 'win32' ? ';' : ':')
}

/** A Linux-shaped directory, as this platform spells it. */
function posix(directory: string): string {
  return process.platform === 'win32' ? directory.split('/').join('\\') : directory
}

/** An `exists` that answers yes for exactly the listed paths. */
function existing(paths: readonly string[]): (path: string) => boolean {
  const known = new Set(paths)
  return path => known.has(path)
}

describe('finding an installed engine', () => {
  it('finds nothing when nothing is installed', () => {
    // The expected state on most machines, which is why it is a value rather than
    // a throw — and why the built-in subset has to be a real answer.
    const engine = resolveImpeccableEngine({
      environment: { PATH: pathVariable([posix('/usr/bin'), posix('/usr/local/bin')]) },
      platform: process.platform,
      home: posix('/home/reader'),
      exists: () => false,
    })
    expect(engine).toBeUndefined()
  })

  it('prefers the configured path, and only when it is there', () => {
    const [configured, onPath, inHome] = [
      posix('/opt/impeccable/impeccable'),
      join(posix('/usr/bin'), 'impeccable'),
      join(posix('/home/reader'), '.impeccable', 'bin', 'impeccable'),
    ]
    const environment = {
      [IMPECCABLE_ENGINE_ENV]: configured,
      PATH: pathVariable([posix('/usr/bin')]),
      HOME: posix('/home/reader'),
    }
    expect(resolveImpeccableEngine({
      environment,
      platform: process.platform,
      exists: existing([configured, onPath]),
    })).toEqual({ path: configured, source: 'env' })

    // A configured path that does not exist falls through to the other probes
    // rather than being reported: the variable is an override, and an override
    // that points at nothing is not a reason to lose the engine that is installed.
    expect(resolveImpeccableEngine({
      environment,
      platform: process.platform,
      exists: existing([onPath]),
    })).toEqual({ path: onPath, source: 'path' })

    // An empty or whitespace value is not a path, so it is skipped silently.
    expect(resolveImpeccableEngine({
      environment: { [IMPECCABLE_ENGINE_ENV]: '   ', HOME: posix('/home/reader') },
      platform: process.platform,
      exists: existing([inHome]),
    })).toEqual({ path: inHome, source: 'home' })
  })

  it('reads the launcher\u2019s own install directory before $PATH', () => {
    // Where upstream's launcher puts what it downloads, so finding it there is
    // the ordinary case rather than the fallback.
    const home = process.platform === 'win32' ? 'C:\\Users\\r' : '/home/reader'
    const installed = process.platform === 'win32'
      ? `${home}\\.impeccable\\bin\\impeccable.exe`
      : `${home}/.impeccable/bin/impeccable`
    expect(resolveImpeccableEngine({
      environment: { PATH: pathVariable(['/usr/bin']), HOME: home },
      platform: process.platform,
      exists: existing([installed, '/usr/bin/impeccable']),
    })).toEqual({ path: installed, source: 'home' })
  })

  it('looks for the executable name first on Windows', () => {
    // A copied release beside an npm shim: the `.exe` is the engine, and the
    // `.cmd` cannot be launched without a shell (see the shim case below).
    const directory = 'C:\\tools\\bin'
    expect(resolveImpeccableEngine({
      environment: { PATH: directory },
      platform: 'win32',
      home: 'C:\\Users\\r',
      exists: existing([`${directory}\\impeccable.exe`, `${directory}\\impeccable.cmd`, `${directory}\\impeccable`]),
    })).toEqual({ path: `${directory}\\impeccable.exe`, source: 'path' })
  })

  it('skips empty entries in the path variable instead of probing the cwd', () => {
    // An empty entry means "the current directory" to a POSIX shell, which would
    // make this probe's answer depend on where the process was started.
    const found = join(posix('/usr/local/bin'), 'impeccable')
    const engine = resolveImpeccableEngine({
      environment: { PATH: pathVariable(['', posix('/usr/local/bin'), '']) },
      platform: process.platform,
      home: posix('/home/reader'),
      exists: existing([found]),
    })
    expect(engine).toEqual({ path: found, source: 'path' })
  })

  it('answers from the machine every time, so an engine installed mid-session is found', () => {
    // No cached "there is none": a user can install the engine while the session
    // is open, and the next call has to see it rather than the answer this module
    // measured before it existed.
    const install = '/opt/impeccable/impeccable'
    let installed = false
    const options = {
      environment: { [IMPECCABLE_ENGINE_ENV]: install },
      platform: process.platform,
      home: '/home/reader',
      exists: () => installed,
    }
    expect(resolveImpeccableEngine(options)).toBeUndefined()
    installed = true
    expect(resolveImpeccableEngine(options)).toEqual({ path: install, source: 'env' })
  })
})

describe('the detect invocation', () => {
  it('asks for JSON, hides advisories unless they were requested, and ends with targets', () => {
    expect(detectArguments({ targets: ['src/app.tsx'] })).toEqual(['detect', '--json', '--no-advisory', 'src/app.tsx'])
    expect(detectArguments({ targets: ['src/app.tsx'], includeAdvisories: true })).toEqual(['detect', '--json', 'src/app.tsx'])
  })

  it('passes scope and viewport only when they were given', () => {
    expect(detectArguments({ targets: ['https://example.test'], viewport: '390x844' })).toEqual([
      'detect', '--json', '--viewport', '390x844', '--no-advisory', 'https://example.test',
    ])
    expect(detectArguments({ targets: ['a.html'], scope: ['type', 'layout'] })).toEqual([
      'detect', '--json', '--scope', 'type,layout', '--no-advisory', 'a.html',
    ])
    // An empty scope list is not a scope: upstream would read it as a filter that
    // matches nothing.
    expect(detectArguments({ targets: ['a.html'], scope: [] })).toEqual(['detect', '--json', '--no-advisory', 'a.html'])
  })
})

describe('running the engine', () => {
  it('hands the engine its targets and bounds, and reports a non-zero exit as an answer', async () => {
    const seen: { args: readonly string[]; options: { readonly cwd?: string; readonly timeoutMs: number } }[] = []
    const outcome = await runImpeccableDetect(
      { path: '/engines/impeccable', source: 'env' },
      {
        cwd: '/work/project',
        targets: ['src/page.tsx'],
        includeAdvisories: true,
        run: async (_path, args, options) => {
          seen.push({ args, options })
          // Upstream exits 2 when it found problems, which is not a crash.
          return { exitCode: 2, stdout: '{"findings":[]}', stderr: '', timedOut: false, truncated: false }
        },
      },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]!.args).toEqual(['detect', '--json', 'src/page.tsx'])
    expect(seen[0]!.options.cwd).toBe('/work/project')
    expect(seen[0]!.options.timeoutMs).toBeGreaterThan(0)
    expect(outcome.exitCode).toBe(2)
    expect(outcome.failure).toBeUndefined()
  })

  it('refuses to launch a shell shim, because that is where a target would be re-parsed', async () => {
    // Windows: `execFile` cannot run a `.cmd` without a shell (EINVAL). The shim
    // is located rather than skipped so the reason can be said out loud, and it is
    // not launched through a command line because the target comes from the model.
    const outcome = await spawnEngine('C:\\tools\\impeccable.cmd', ['detect', '--json', 'a.html'], { timeoutMs: 1_000, maxBytes: 1_024 })
    expect(outcome.exitCode).toBeUndefined()
    expect(outcome.failure).toContain('shell shim')
    expect(outcome.failure).toContain(IMPECCABLE_ENGINE_ENV)
    expect(outcome.stdout).toBe('')
  })
})

describe('reading the engine\u2019s document', () => {
  it('recognizes an array of findings under the plausible keys, and a bare array', () => {
    expect(readEngineFindings('[{"rule":"overused-font"}]')).toEqual({
      rows: [{ rule: 'overused-font' }], recognized: true, parsed: true,
    })
    expect(readEngineFindings('{"version":"1.0","findings":[{"id":"gradient-text"}]}')).toEqual({
      rows: [{ id: 'gradient-text' }], recognized: true, parsed: true,
    })
    expect(readEngineFindings('{"results":[{"rule":"tiny-text"}],"counts":{"primary":1}}')).toEqual({
      rows: [{ rule: 'tiny-text' }], recognized: true, parsed: true,
    })
  })

  it('distinguishes an unrecognized document from unparseable output', () => {
    // Both leave the caller with no findings, and they need different sentences:
    // one document is handed over verbatim, the other has no document to hand over.
    expect(readEngineFindings('{"version":"1.0","summary":{"files":3}}')).toEqual({ rows: [], recognized: false, parsed: true })
    expect(readEngineFindings('impeccable: 2 problems found\nsrc/app.tsx:12')).toEqual({ rows: [], recognized: false, parsed: false })
    expect(readEngineFindings('   ')).toEqual({ rows: [], recognized: false, parsed: false })
  })

  it('keeps only the entries that are objects', () => {
    const read = readEngineFindings('{"issues":[{"rule":"a"},7,null,"b",{"rule":"c"}]}')
    expect(read.rows).toEqual([{ rule: 'a' }, { rule: 'c' }])
  })

  it('reads a field under whichever of its plausible names is present', () => {
    // Upstream's field names are not published, so the reader accepts the shapes
    // a findings row is written in rather than one spelling.
    expect(firstString({ ruleId: 'gradient-text' }, ['rule', 'ruleId', 'id'])).toBe('gradient-text')
    expect(firstString({ line: 12 }, ['line'])).toBe('12')
    expect(firstString({ title: '   ' }, ['title'])).toBeUndefined()
    expect(firstString({}, ['rule'])).toBeUndefined()
  })
})
