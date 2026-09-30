import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTSEED_CLI_PACKAGE,
  ANTSEED_CLI_VERSION,
  ANTSEED_ROUTER_PLUGIN,
  AntSeedBuyerRuntime,
  type AntSeedChildProcess,
  type AntSeedSpawn,
} from '../src/antseed/buyer-runtime.ts'
import type { AntSeedCatalog, AntSeedModelRow } from '../src/antseed/provider.ts'
import { harnessHomeDirectory } from '../src/data-home.ts'

/**
 * Marker the current release writes once an install finished.
 *
 * Spelled here rather than imported: it is a file on disk that an upgrade has
 * to keep reading, so a test that took it from the module could not notice the
 * name changing under the installs the rename exists to protect.
 */
const INSTALL_MARKER = '.key-gateway-install-complete'

/** Marker a previous release wrote, under the name the root had then. */
const LEGACY_INSTALL_MARKER = '.antseed-install-complete'

/** Directory name the current release gives the runtime root. */
const RUNTIME_DIRECTORY = 'key-gateway'

/** Directory name a previous release gave the same root. */
const LEGACY_RUNTIME_DIRECTORY = 'antseed'

/** A directory that answered and advertised nothing: what a starting buyer sees. */
function silentCatalog(): AntSeedCatalog {
  return { models: [], paid: 0 }
}

/** One free text row, as a directory read hands it over. */
function freeTextRow(): AntSeedModelRow {
  return { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', kind: 'text', free: true }
}

/** A directory that answered with free rows and the paid ones it left out. */
function catalogOf(models: readonly AntSeedModelRow[], paid: number): AntSeedCatalog {
  return { models, paid }
}

/** One scripted child: the test decides when it exits and with what code. */
class FakeChild implements AntSeedChildProcess {
  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []
  /** Registered listeners, by event; the module under test declares what each carries. */
  private readonly listeners = new Map<string, ((value?: unknown, signal?: unknown) => void)[]>()

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    return true
  }

  once(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  // The implementation takes the union of the two shapes an event can carry and
  // files it under the event name: this fake never interprets a value, it only
  // hands each event to whatever the module under test registered for it.
  once(
    event: 'exit' | 'close' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
  ): this {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener as (value?: unknown, signal?: unknown) => void)
    this.listeners.set(event, existing)
    return this
  }

  emit(event: 'exit' | 'close', code?: number | null, signal?: NodeJS.Signals | null): void
  emit(event: 'error', error: Error): void
  emit(event: 'exit' | 'close' | 'error', value?: number | null | Error, signal?: NodeJS.Signals | null): void {
    // The code travels with the event: the install path decides success from
    // it, and a listener called with no arguments would read `undefined`. The
    // signal is carried too, because the sentence a failed start shows says
    // which of the two ended the process — and the reason travels with an
    // `error`, which is the only thing that explains a failed spawn.
    if (event === 'exit') this.exitCode = value as number | null
    for (const listener of this.listeners.get(event) ?? []) listener(value, signal)
  }
}

interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  /** The environment as the spawn was handed it; `ProcessEnv`, like `spawn` itself takes. */
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  /** One entry per standard handle; a number is a descriptor the child inherits. */
  readonly stdio: readonly (string | number)[]
}

/** A spawn binding that records its calls and hands back one scripted child. */
function recordingSpawn(children: FakeChild[]): { readonly calls: SpawnCall[]; readonly spawn: AntSeedSpawn } {
  const calls: SpawnCall[] = []
  const spawn: AntSeedSpawn = (command, args, options) => {
    calls.push({ command, args, env: options.env, cwd: options.cwd, stdio: [...options.stdio] })
    const child = children.shift()
    if (child === undefined) throw new Error('the test scripted no child for this spawn')
    return child
  }
  return { calls, spawn }
}

/**
 * A port probe that says nothing is listening, for every runtime that starts.
 *
 * The plugin's own probe asks this machine about the port the runtime uses, and a
 * developer's gateway may well be holding exactly that port — so a suite that
 * left the real binding in place would pass or fail by whether that gateway
 * happened to be running. The real one is exercised on its own below, against
 * listeners of this test's making.
 */
const portIsFree = async (): Promise<boolean> => false

/** A port this test owned and has released, so a probe sees it as free. */
async function freeLoopbackPort(): Promise<number> {
  const { port, close } = await occupiedLoopbackPort()
  await close()
  return port
}

/**
 * A listener this test holds open, so a probe sees its port as occupied.
 *
 * On port `0`, which asks the OS for one nobody else is using: the port a runtime
 * is configured with has to be a real one for the real binding to test it.
 */
async function occupiedLoopbackPort(): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
  const server = createServer()
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) }),
  }
}

const roots: string[] = []

/**
 * Yield until the runtime's serialized operation has actually started.
 *
 * Every entry point queues its work on the runtime's own promise chain, so an
 * event emitted in the same turn as the call is emitted before the operation
 * registers its listener. A macrotask boundary is the smallest thing that
 * orders the two the way the real process does.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setImmediate(resolve) })
}

/**
 * Wait until the runtime has actually spawned its child.
 *
 * The install path prepares directories before it spawns, so one macrotask is
 * not enough to know the child exists — and emitting a lifecycle event before
 * then is emitting it to nobody.
 */
async function waitForSpawn(calls: readonly unknown[]): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (calls.length > 0) return
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  throw new Error('the runtime never spawned a child')
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'antseed-runtime-'))
  roots.push(root)
  return root
}

/**
 * Run one synchronous step with the harness home pointed at a directory of this
 * test's own.
 *
 * The override is read per call rather than cached, and it is restored in the
 * same turn — the reset happens before any `await` — so no other test can see a
 * home that is not its own. The resolver is asserted as much as the runtime is:
 * if it went on naming the real home, every fixture below would be invisible and
 * the test would silently assert nothing about this machine.
 */
function withHarnessHome<Value>(home: string, run: () => Value): Value {
  process.env.DSH_HOME = home
  try {
    if (resolve(harnessHomeDirectory()) !== resolve(home)) throw new Error('the harness home override was not honoured')
    return run()
  } finally {
    delete process.env.DSH_HOME
  }
}

/**
 * A plugin cache of this test's own making.
 *
 * The real one is hard-coded to `~/.antseed/plugins` upstream, so every test
 * that cares about the first-start budget points at a directory it owns instead
 * of at whatever the machine running the suite happens to have.
 */
function pluginsDirectoryOf(root: string): string {
  return join(root, 'cli-plugins')
}

/** Put the CLI's router plugin in that cache, the way a previous run would have. */
async function cacheRouterPlugin(pluginsDirectory: string): Promise<void> {
  await mkdir(join(pluginsDirectory, 'node_modules', ANTSEED_ROUTER_PLUGIN), { recursive: true })
  await writeFile(join(pluginsDirectory, 'node_modules', ANTSEED_ROUTER_PLUGIN, 'package.json'), '{}\n')
}

/**
 * Put a runtime on disk the way an install would, marker and all.
 *
 * The package's own manifest is written too, because it is what a tree has to
 * state about itself when no marker vouches for it.
 * @param root - the tree to build.
 * @param marker - which spelling of the marker to leave behind; `null` leaves none, which is the shape a hand-installed or restored tree has.
 * @param version - the version the package states for itself.
 */
async function installTree(root: string, marker: string | null = INSTALL_MARKER, version: string = ANTSEED_CLI_VERSION): Promise<void> {
  await mkdir(join(root, 'node_modules', ANTSEED_CLI_PACKAGE, 'dist', 'cli'), { recursive: true })
  await writeFile(join(root, 'node_modules', ANTSEED_CLI_PACKAGE, 'dist', 'cli', 'index.js'), '// cli\n')
  await writeFile(join(root, 'node_modules', ANTSEED_CLI_PACKAGE, 'package.json'), `${JSON.stringify({ name: ANTSEED_CLI_PACKAGE, version })}\n`)
  if (marker !== null) await writeFile(join(root, marker), `${ANTSEED_CLI_VERSION}\n`)
}

/** The entry point a completed install leaves, which is what makes a tree usable. */
function entryPointOf(root: string): string {
  return join(root, 'node_modules', ANTSEED_CLI_PACKAGE, 'dist', 'cli', 'index.js')
}

afterEach(async () => {
  // A test that edits the environment reads it back through the runtime, so the
  // value has to leave with the test rather than with the process.
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('AntSeed buyer runtime', () => {
  it('refuses an unbindable port at construction', () => {
    expect(() => new AntSeedBuyerRuntime({ port: 80 })).toThrow('is not a usable port number')
  })

  it('keeps its install root under the Harness home when none is configured', async () => {
    // The default is the decision that keeps a managed runtime out of any state
    // a hand-run CLI keeps, so it is pinned rather than assumed — and pinned
    // against an override home of this test's own, so the assertion neither
    // reads nor renames whatever the machine running the suite happens to have.
    const home = await makeRoot()
    const rootDirectory = withHarnessHome(home, () => new AntSeedBuyerRuntime().status().rootDirectory)
    expect(rootDirectory).toBe(resolve(join(home, 'runtimes', RUNTIME_DIRECTORY)))
  })

  it('adopts an install a previous release left under the old directory name', async () => {
    // The root was renamed so that nothing a user can find on disk carries the
    // upstream name, and someone who already downloaded must not be asked to do
    // it again: the old tree is moved into the new name, marker included, and
    // the new name is what the status reports from then on.
    const home = await makeRoot()
    const legacy = join(home, 'runtimes', LEGACY_RUNTIME_DIRECTORY)
    await installTree(legacy, LEGACY_INSTALL_MARKER)

    const status = withHarnessHome(home, () => new AntSeedBuyerRuntime().status())

    expect(status).toMatchObject({ installed: true, rootDirectory: resolve(join(home, 'runtimes', RUNTIME_DIRECTORY)) })
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(entryPointOf(join(home, 'runtimes', RUNTIME_DIRECTORY)))).toBe(true)
  })

  it('leaves an install that is already under the current name alone', async () => {
    // The search for an old root runs on every default-root handle, so an
    // install under the new name has to be recognised before anything looks at
    // the old one — a status read is exactly that: what a settings page does.
    const home = await makeRoot()
    const root = join(home, 'runtimes', RUNTIME_DIRECTORY)
    const legacy = join(home, 'runtimes', LEGACY_RUNTIME_DIRECTORY)
    await installTree(root)
    await installTree(legacy, LEGACY_INSTALL_MARKER)

    const status = withHarnessHome(home, () => new AntSeedBuyerRuntime().status())

    expect(status).toMatchObject({ installed: true, rootDirectory: resolve(root) })
    // The older tree is left where it is rather than moved, renamed or deleted:
    // nothing is using it, and tidying it up is the user's call.
    expect(existsSync(legacy)).toBe(true)
  })

  it('uses the old install where it lies when the new name is already taken', async () => {
    // The move is only ever made into free space: a name something else already
    // occupies is not this module's to take, and the answer to that is not to
    // download the bytes again — the install that exists is the install that
    // runs.
    const home = await makeRoot()
    const legacy = join(home, 'runtimes', LEGACY_RUNTIME_DIRECTORY)
    await installTree(legacy, LEGACY_INSTALL_MARKER)
    const occupied = join(home, 'runtimes', RUNTIME_DIRECTORY)
    await writeFile(occupied, 'occupied\n')

    const status = withHarnessHome(home, () => new AntSeedBuyerRuntime().status())

    expect(status).toMatchObject({ installed: true, rootDirectory: resolve(legacy) })
    expect(existsSync(entryPointOf(legacy))).toBe(true)
    // Left as it was found: nothing this module did not put there is replaced.
    expect(readFileSync(occupied, 'utf8')).toBe('occupied\n')
  })

  it('does not adopt an old tree that was never marked complete', async () => {
    // The marker is the only thing that says an install finished. Adopting a
    // half-written tree would report a runtime as installed and then fail every
    // start against a package that is not there.
    const home = await makeRoot()
    const legacy = join(home, 'runtimes', LEGACY_RUNTIME_DIRECTORY)
    await mkdir(join(legacy, 'node_modules'), { recursive: true })

    const status = withHarnessHome(home, () => new AntSeedBuyerRuntime().status())

    expect(status).toMatchObject({ installed: false, reason: 'KEY_GATEWAY_RUNTIME_NOT_INSTALLED' })
    expect(status.rootDirectory).toBe(resolve(join(home, 'runtimes', RUNTIME_DIRECTORY)))
    // Left exactly as it was: a tree this module did not adopt is not its to move.
    expect(existsSync(legacy)).toBe(true)
  })

  it('counts a marker a previous release wrote as an install', async () => {
    // The marker was renamed with the root, and honouring only the new spelling
    // would report a working install as absent and offer to fetch it again.
    const root = await makeRoot()
    await installTree(root, LEGACY_INSTALL_MARKER)
    expect(new AntSeedBuyerRuntime({ rootDirectory: root }).status().installed).toBe(true)
  })

  it('counts a tree holding the pinned package even when no marker vouches for it', async () => {
    // What a tree someone installed by hand, restored from a backup or copied
    // from another machine looks like: the pinned package, its entry point, and
    // no marker. Asking for a download here would re-fetch bytes that are
    // already on disk, which is the one outcome this check exists to avoid.
    const root = await makeRoot()
    await installTree(root, null)

    expect(new AntSeedBuyerRuntime({ rootDirectory: root }).status()).toMatchObject({ installed: true })
  })

  it('does not run a tree that holds another version of the package', async () => {
    // The proxy speaks a pinned protocol, so self-verifying has to mean the
    // pinned package: another version is a different protocol rather than a
    // shortcut, and the answer to it is the download the card would have asked
    // for anyway.
    const root = await makeRoot()
    await installTree(root, null, '0.1.100')

    expect(new AntSeedBuyerRuntime({ rootDirectory: root }).status())
      .toMatchObject({ installed: false, reason: 'KEY_GATEWAY_RUNTIME_NOT_INSTALLED' })
  })

  it('does not run an entry point whose package says nothing about its version', async () => {
    // A tree can have the entry point and still not say which package it is:
    // npm unpacks the manifest first, so an extract that died leaves files with
    // no version beside them — and a manifest a tool mangled reads the same way.
    // Neither is known to be the pinned release, so neither is run, and a read
    // that cannot parse its own evidence is not an error out of a status read.
    const root = await makeRoot()
    await installTree(root, null)
    const manifest = join(root, 'node_modules', ANTSEED_CLI_PACKAGE, 'package.json')

    await writeFile(manifest, '{}\n')
    expect(new AntSeedBuyerRuntime({ rootDirectory: root }).status().installed).toBe(false)

    await writeFile(manifest, 'not json at all\n')
    expect(new AntSeedBuyerRuntime({ rootDirectory: root }).status())
      .toMatchObject({ installed: false, reason: 'KEY_GATEWAY_RUNTIME_NOT_INSTALLED' })
  })

  it('reports not installed before anything was downloaded, without touching the disk', async () => {
    const root = await makeRoot()
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root })
    expect(runtime.status()).toMatchObject({ installed: false, running: false, reason: 'KEY_GATEWAY_RUNTIME_NOT_INSTALLED' })
  })

  it('reports an incomplete tree distinctly from an absent one', async () => {
    const root = await makeRoot()
    // The marker says an install finished; a missing entry point means something
    // removed the package afterwards, which the user fixes by installing again.
    await writeFile(join(root, INSTALL_MARKER), `${ANTSEED_CLI_VERSION}\n`)
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root })
    expect(runtime.status().reason).toBe('KEY_GATEWAY_RUNTIME_INCOMPLETE')
  })

  it('installs the pinned package under its own root and marks it complete', async () => {
    const root = await makeRoot()
    const child = new FakeChild()
    const { calls, spawn } = recordingSpawn([child])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })

    const installing = runtime.install()
    await waitForSpawn(calls)
    child.emit('close', 0)
    const status = await installing

    // Windows starts npm through `cmd.exe`, because npm is a `.cmd` shim there
    // and `spawn` refuses to start one without a shell — the EINVAL that made the
    // download button fail with an empty log. Everywhere else npm is a real
    // executable and is started directly. Both spellings carry the same install.
    const install = calls[0]!
    if (process.platform === 'win32') {
      expect(install.command).toBe(process.env.ComSpec?.trim() || 'cmd.exe')
      expect(install.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      expect(install.args[3]).toContain('npm.cmd install')
      expect(install.args[3]).toContain('--prefix')
      expect(install.args[3]).toContain(`${ANTSEED_CLI_PACKAGE}@${ANTSEED_CLI_VERSION}`)
    } else {
      expect(install.command).toBe('npm')
      expect(install.args).toEqual(expect.arrayContaining(['install', '--prefix', root, `${ANTSEED_CLI_PACKAGE}@${ANTSEED_CLI_VERSION}`]))
    }
    expect(install.cwd).toBe(root)
    expect(existsSync(join(root, INSTALL_MARKER))).toBe(true)
    // The marker is written last, so a tree that exists without a matching entry
    // point still reports incomplete rather than installed.
    expect(status.installed).toBe(false)
    expect(status.reason).toBe('KEY_GATEWAY_RUNTIME_INCOMPLETE')
  })

  it('quotes a root with a space in it rather than splitting it into two arguments', async () => {
    // The reason the Windows path builds one quoted command line instead of
    // using `shell: true`: with a shell, Node joins the argv array without
    // quoting it, so a Harness home like `C:\Users\Some Name\.dsh` would reach
    // npm as `--prefix C:\Users\Some` plus a stray `Name\.dsh`. Measured here on
    // the token itself, because that is where the difference is visible.
    if (process.platform !== 'win32') return
    const base = await makeRoot()
    const root = join(base, 'harness home')
    const child = new FakeChild()
    const { calls, spawn } = recordingSpawn([child])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })

    const installing = runtime.install()
    await waitForSpawn(calls)
    child.emit('close', 0)
    await installing

    const line = calls[0]?.args[3] ?? ''
    expect(line).toContain(`--prefix "${root}"`)
  })

  it('falls back to cmd.exe when the environment names no command processor', async () => {
    // `ComSpec` is how Windows itself is told which command processor to run,
    // and it is normally set — but it is a user-editable variable in an
    // environment this plugin does not control, so the fallback has to name the
    // file Windows keeps in System32 rather than refusing to install at all.
    vi.stubEnv('ComSpec', '')
    const root = await makeRoot()
    const child = new FakeChild()
    const { calls, spawn } = recordingSpawn([child])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, platform: 'win32', isPortInUse: portIsFree })

    const installing = runtime.install()
    await waitForSpawn(calls)
    child.emit('close', 0)
    await installing

    expect(calls[0]?.command).toBe('cmd.exe')
    expect(calls[0]?.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
  })

  it('refuses to mark a failed install complete', async () => {
    const root = await makeRoot()
    const child = new FakeChild()
    const { calls, spawn } = recordingSpawn([child])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })

    const installing = runtime.install()
    await waitForSpawn(calls)
    child.emit('close', 1)
    await expect(installing).rejects.toThrow('The runtime install failed')
    expect(existsSync(join(root, INSTALL_MARKER))).toBe(false)
  })

  it('lets neither marker vouch for a failed install', async () => {
    // A tree an older release marked complete is cleared before npm runs, so an
    // install that fails cannot leave a marker behind that reads as finished —
    // under either spelling, since a surviving one would outlive the retry.
    const root = await makeRoot()
    await installTree(root, LEGACY_INSTALL_MARKER)
    const child = new FakeChild()
    const { calls, spawn } = recordingSpawn([child])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })

    const installing = runtime.install()
    await waitForSpawn(calls)
    child.emit('close', 1)
    await expect(installing).rejects.toThrow('The runtime install failed')

    expect(existsSync(join(root, LEGACY_INSTALL_MARKER))).toBe(false)
    expect(existsSync(join(root, INSTALL_MARKER))).toBe(false)
    // Neither spelling vouched for anything, which is what this test is about.
    // The tree itself survived the failed npm run — pinned manifest and entry
    // point both — so it is still the install it was before the retry started,
    // and asking the user to download it again would be the worse answer.
    expect(runtime.status()).toMatchObject({ installed: true })
  })

  it('refuses to install over a buyer that is running out of the tree', async () => {
    // npm cannot overwrite the files a running process holds open on Windows,
    // and the caller closes the switch before installing for exactly that
    // reason. Refusing here keeps that ordering a property of this module
    // rather than a habit of its one caller.
    const root = await makeRoot()
    await installTree(root)
    const { calls, spawn } = recordingSpawn([new FakeChild()])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })
    await runtime.start('ab'.repeat(32))

    await expect(runtime.install()).rejects.toThrow('KEY_GATEWAY_RUNTIME_RUNNING')
    // Refused means no npm ran at all; a guard that spawned first would have
    // already damaged the tree by the time it threw.
    expect(calls).toHaveLength(1)
  })

  it('refuses to start a runtime that is not installed', async () => {
    const root = await makeRoot()
    const { calls, spawn } = recordingSpawn([])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })
    await expect(runtime.start('a'.repeat(64))).rejects.toThrow('KEY_GATEWAY_RUNTIME_NOT_INSTALLED')
    expect(calls).toEqual([])
  })

  it('carries the identity in the environment and never on the command line', async () => {
    const root = await makeRoot()
    await installTree(root)
    const child = new FakeChild()
    const { calls, spawn } = recordingSpawn([child])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })
    const identity = 'ab'.repeat(32)

    // A credential in the ambient environment must not reach the buyer.
    process.env.ANTSEED_PROBE_SECRET = 'must-not-travel'
    try {
      await runtime.start(identity)
    } finally {
      delete process.env.ANTSEED_PROBE_SECRET
    }

    const call = calls[0]!
    expect(call.args.join(' ')).not.toContain(identity)
    expect(call.env.ANTSEED_IDENTITY_HEX).toBe(identity)
    expect(call.env).not.toHaveProperty('ANTSEED_PROBE_SECRET')
    // The data directory is the plugin's, not the user's `~/.antseed`.
    expect(call.env.ANTSEED_DATA_DIR).toBe(join(root, 'data'))
    // And so is the config path, which upstream resolves independently of the
    // data directory: left unset, the buyer would read the user's own file, whose
    // routing preferences — a peer blocklist, a trust floor — are not this
    // buyer's policy.
    expect(call.env.ANTSEED_CONFIG).toBe(join(root, 'data', 'config.json'))
    expect(call.args).toEqual([join(root, 'node_modules', ANTSEED_CLI_PACKAGE, 'dist', 'cli', 'index.js'), 'buyer', 'start', '--port', '8390'])
    expect(runtime.status().running).toBe(true)
  })

  it('caps the managed buyer at a zero price, so only free offers can be routed to', async () => {
    // The card offering free models is presentation; this is the enforcement.
    // The buyer's router drops every seller offer priced above its ceiling, so a
    // funded wallet still cannot be charged through this buyer.
    const root = await makeRoot()
    await installTree(root)
    const { calls, spawn } = recordingSpawn([new FakeChild()])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })
    await runtime.start('ab'.repeat(32))

    expect(calls[0]?.env.ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION).toBe('0')
    expect(calls[0]?.env.ANTSEED_BUYER_MAX_OUTPUT_USD_PER_MILLION).toBe('0')
  })

  it('pins the routing preferences the buyer runs under, before it starts', async () => {
    // The listing reports every offer the network has whatever these say, while
    // routing applies them as a hard gate — and the built-in trust floor of 60
    // would refuse a free seller the card had just offered. Upstream reads no
    // environment variable for any of them, so a file the plugin owns is the only
    // place they can be stated.
    const root = await makeRoot()
    await installTree(root)
    const { calls, spawn } = recordingSpawn([new FakeChild()])
    const fileAtSpawn: boolean[] = []
    const recordingProbe: AntSeedSpawn = (command, args, options) => {
      fileAtSpawn.push(existsSync(join(root, 'data', 'config.json')))
      return spawn(command, args, options)
    }
    const runtime = new AntSeedBuyerRuntime({
      rootDirectory: root,
      spawnProcess: recordingProbe,
      isPortInUse: portIsFree,
    })

    await runtime.start('ab'.repeat(32))

    expect(JSON.parse(readFileSync(join(root, 'data', 'config.json'), 'utf8'))).toEqual({
      buyer: {
        routingPreferences: {
          preferFreePeers: true,
          maxInputUsdPerMillion: 0,
          minTrustScore: 0,
          allowedPeerIds: [],
          blockedPeerIds: [],
        },
      },
    })
    // In place by the time the process exists: the proxy reads it at startup.
    expect(fileAtSpawn).toEqual([true])
    expect(calls).toHaveLength(1)
  })

  it('rewrites the routing preferences every start, so an older file cannot outlive its reason', async () => {
    // Derived state, overwritten rather than kept: a file an older release wrote,
    // or one edited by hand, must not be what the next start runs on.
    const root = await makeRoot()
    await installTree(root)
    await mkdir(join(root, 'data'), { recursive: true })
    await writeFile(join(root, 'data', 'config.json'), '{"buyer":{"routingPreferences":{"minTrustScore":60}}}\n')
    const { spawn } = recordingSpawn([new FakeChild()])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })

    await runtime.start('ab'.repeat(32))

    const written = JSON.parse(readFileSync(join(root, 'data', 'config.json'), 'utf8')) as {
      readonly buyer: { readonly routingPreferences: { readonly minTrustScore: number } }
    }
    expect(written.buyer.routingPreferences.minTrustScore).toBe(0)
  })

  it('refuses to start onto a port something else already holds', async () => {
    // The CLI's own answer to a busy port is to reuse whoever answers there. For a
    // managed buyer that means traffic served by a buyer this plugin did not start
    // and did not hand this identity to — and the case that matters is a buyer left
    // behind by an earlier crash, because it outlives a replaced key: the card
    // would show the new peer id while the old one signed. Killing whatever holds
    // the port is not the fix, since a buyer the user started by hand looks
    // exactly the same from here.
    const root = await makeRoot()
    await installTree(root)
    const { calls, spawn } = recordingSpawn([])
    const runtime = new AntSeedBuyerRuntime({
      rootDirectory: root,
      spawnProcess: spawn,
      isPortInUse: async () => true,
    })

    await expect(runtime.start('ab'.repeat(32))).rejects.toThrow('Port 8390 is already in use')
    expect(calls).toEqual([])
    // Refused before anything was written: no data directory, and no config for a
    // buyer that was never started.
    expect(existsSync(join(root, 'data'))).toBe(false)
  })

  it('reads an occupied port through the real probe', async () => {
    // The default binding is the one the plugin actually runs with. A connect is
    // the whole test, and this is where it meets a socket: the listener is this
    // test's own and its port is one the OS chose.
    const root = await makeRoot()
    await installTree(root)
    const { port, close } = await occupiedLoopbackPort()
    try {
      const { calls, spawn } = recordingSpawn([])
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, port, spawnProcess: spawn })
      await expect(runtime.start('ab'.repeat(32))).rejects.toThrow(`Port ${String(port)} is already in use`)
      expect(calls).toEqual([])
    } finally {
      await close()
    }
  })

  it('reads a released port as free through the real probe, and starts', async () => {
    // The other half of that binding, and the one path that would otherwise never
    // be taken: a port nobody holds answers with a refusal, which is a start.
    const root = await makeRoot()
    await installTree(root)
    const port = await freeLoopbackPort()
    const { calls, spawn } = recordingSpawn([new FakeChild()])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, port, spawnProcess: spawn })

    await runtime.start('ab'.repeat(32))

    expect(calls[0]?.args).toEqual([
      join(root, 'node_modules', ANTSEED_CLI_PACKAGE, 'dist', 'cli', 'index.js'),
      'buyer', 'start', '--port', String(port),
    ])
  })

  it('starts one buyer, not two', async () => {
    const root = await makeRoot()
    await installTree(root)
    const { calls, spawn } = recordingSpawn([new FakeChild()])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })
    await runtime.start('ab'.repeat(32))
    await runtime.start('cd'.repeat(32))
    expect(calls).toHaveLength(1)
  })

  it('stops reporting a buyer that died on its own', async () => {
    const root = await makeRoot()
    await installTree(root)
    const child = new FakeChild()
    const { spawn } = recordingSpawn([child])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })
    await runtime.start('ab'.repeat(32))
    await settle()
    child.emit('exit', 1)
    expect(runtime.status().running).toBe(false)
    // A second start is allowed once the handle is gone, which is what lets the
    // switch be turned off and on again.
    expect(await runtime.stop()).toBeUndefined()
  })

  describe('readiness', () => {
    it('answers as soon as the proxy reports models', async () => {
      const root = await makeRoot()
      const readModels = vi.fn(async () => catalogOf([freeTextRow()], 0))
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, readModels })
      await expect(runtime.waitUntilReady()).resolves.toEqual([freeTextRow()])
    })

    it('treats a network whose every offer is priced as answered, not as never started', async () => {
      // The catalog only carries free rows, so readiness cannot wait for one: on
      // a network where every offer is paid — which is the live state of the
      // image listing — a working buyer would otherwise spend its whole budget
      // probing and then refuse to open the switch. The paid count is what says
      // the buyer is up.
      const root = await makeRoot()
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, readModels: async () => catalogOf([], 40) })
      await expect(runtime.waitUntilReady()).resolves.toEqual([])
    })

    it('gives up when the proxy never answers', async () => {
      const root = await makeRoot()
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        // Both budgets are pinned: the machine running this suite may or may
        // not have a `~/.antseed/plugins`, and which one applies must not
        // depend on that.
        pluginsDirectory: pluginsDirectoryOf(root),
        readModels: async () => silentCatalog(),
        readyTimeoutMs: 1,
        firstReadyTimeoutMs: 1,
      })
      await expect(runtime.waitUntilReady()).rejects.toThrow('did not answer on port 8390 within 1ms')
    })

    it('refuses to keep waiting once the caller aborts', async () => {
      const root = await makeRoot()
      const controller = new AbortController()
      controller.abort()
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, readModels: async () => silentCatalog() })
      await expect(runtime.waitUntilReady(controller.signal)).rejects.toThrow('readiness wait was aborted')
    })

      it('spends the longer budget while the CLI still has to install its router plugin', async () => {
      // The first start on a machine pays for that install before its proxy can
      // bind, and the install is bounded at two minutes upstream. Timing out at
      // the ordinary budget would kill a start that is working.
      const root = await makeRoot()
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        pluginsDirectory: pluginsDirectoryOf(root),
        readModels: async () => silentCatalog(),
        readyTimeoutMs: 1,
        firstReadyTimeoutMs: 9,
      })
      await expect(runtime.waitUntilReady()).rejects.toThrow('within 9ms')
    })

    it('drops back to the ordinary budget once that plugin is cached', async () => {
      // A buyer that is merely wedged must not hold the switch for four minutes
      // once the install it was waiting behind has already happened.
      const root = await makeRoot()
      const pluginsDirectory = pluginsDirectoryOf(root)
      await cacheRouterPlugin(pluginsDirectory)
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        pluginsDirectory,
        readModels: async () => silentCatalog(),
        readyTimeoutMs: 3,
        firstReadyTimeoutMs: 5_000,
      })
      await expect(runtime.waitUntilReady()).rejects.toThrow('within 3ms')
    })

    it('keeps the ordinary budget when the first-start one is configured shorter', async () => {
      // The two are not a switch: a caller that shortens the first-start budget
      // for its own reasons must not shorten the one every start uses.
      const root = await makeRoot()
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        pluginsDirectory: pluginsDirectoryOf(root),
        readModels: async () => silentCatalog(),
        readyTimeoutMs: 7,
        firstReadyTimeoutMs: 1,
      })
      await expect(runtime.waitUntilReady()).rejects.toThrow('within 7ms')
    })

    it('reads the proxy through its own default reader, with and without a signal', async () => {
      // No injected reader: this is the binding the plugin actually runs with, and
      // it is the one place the readiness wait, the loopback port, and the two
      // listings meet. The signal is carried through to the request, which is what
      // makes a switch turned off mid-wait stop waiting.
      const root = await makeRoot()
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root })
      const zero = { inputUsdPerMillion: 0, outputUsdPerMillion: 0, minImageUsdPerImage: 0, maxImageUsdPerImage: 0 }
      const read = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
        String(input).includes('images')
          ? { data: [{ id: 'flux-2-pro', peers: [zero] }] }
          : { data: [{ id: 'deepseek-v4-flash', peers: [zero] }] },
      ), { status: 200 }))
      vi.stubGlobal('fetch', read)
      try {
        await expect(runtime.waitUntilReady()).resolves.toEqual([
          { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', kind: 'text', free: true },
          { id: 'flux-2-pro', name: 'flux-2-pro', kind: 'images', free: true },
        ])
        const controller = new AbortController()
        await expect(runtime.waitUntilReady(controller.signal)).resolves.toHaveLength(2)
        expect(read).toHaveBeenCalledWith(
          'http://127.0.0.1:8390/v1/models?type=text',
          expect.objectContaining({ signal: controller.signal }),
        )
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  describe('a buyer that died during startup', () => {
    /** A runtime whose reader never answers, so only the exit can end the wait. */
    async function dyingRuntime(): Promise<{ readonly runtime: AntSeedBuyerRuntime; readonly child: FakeChild }> {
      const root = await makeRoot()
      await installTree(root)
      const child = new FakeChild()
      const { spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        spawnProcess: spawn,
        platform: 'linux',
        isPortInUse: portIsFree,
        readModels: async () => silentCatalog(),
        // A minute of budget: the point is that none of it is spent.
        readyTimeoutMs: 60_000,
      })
      await runtime.start('ab'.repeat(32))
      await settle()
      return { runtime, child }
    }

    it('reports the exit code instead of waiting out the readiness budget', async () => {
      const { runtime, child } = await dyingRuntime()
      child.emit('exit', 1)
      await expect(runtime.waitUntilReady()).rejects.toThrow('exited with code 1 before it answered its directory')
    })

    it('names the signal when something outside ended the process', async () => {
      const { runtime, child } = await dyingRuntime()
      child.emit('exit', null, 'SIGKILL')
      await expect(runtime.waitUntilReady()).rejects.toThrow('killed by SIGKILL before it answered its directory')
    })

    it('says so when a killed process reported no signal of its own', async () => {
      const { runtime, child } = await dyingRuntime()
      child.emit('exit', null)
      await expect(runtime.waitUntilReady()).rejects.toThrow('killed by a signal before it answered its directory')
    })

    it('does not report a buyer this plugin stopped on purpose as a crash', async () => {
      const root = await makeRoot()
      await installTree(root)
      const child = new FakeChild()
      const { spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        spawnProcess: spawn,
        platform: 'linux',
        isPortInUse: portIsFree,
        readModels: async () => catalogOf([freeTextRow()], 0),
      })
      await runtime.start('ab'.repeat(32))

      const stopping = runtime.stop()
      await settle()
      child.emit('close', 0)
      await stopping

      // The exit lands after the handle was dropped, and closing the switch was
      // the user's own decision — the next wait must not read it as a crash.
      child.emit('exit', null, 'SIGKILL')
      await expect(runtime.waitUntilReady()).resolves.toEqual([freeTextRow()])
    })
  })

  describe('a buyer that never started at all', () => {
    it('reports why the process could not be spawned instead of letting it escape', async () => {
      // An emitter with no `error` listener throws the event out of the process
      // running it, which here is the Host itself: a buyer that could not be
      // spawned would take everything down with it. The failure is reported on
      // the readiness wait instead, and it is the reason the spawn gave.
      const root = await makeRoot()
      await installTree(root)
      const child = new FakeChild()
      const { spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        spawnProcess: spawn,
        platform: 'linux',
        isPortInUse: portIsFree,
        readModels: async () => silentCatalog(),
        readyTimeoutMs: 60_000,
      })
      await runtime.start('ab'.repeat(32))
      await settle()

      child.emit('error', new Error('spawn EPERM'))

      expect(runtime.status().running).toBe(false)
      await expect(runtime.waitUntilReady()).rejects.toThrow('The buyer could not be started: spawn EPERM')
    })

    it('ignores an error from a process this runtime no longer holds', async () => {
      // A stopped buyer reporting a late `error` is the same case the exit guard
      // already covers: the handle was dropped on purpose, so its teardown must
      // not become the next start's failure.
      const root = await makeRoot()
      await installTree(root)
      const child = new FakeChild()
      const { spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        spawnProcess: spawn,
        platform: 'linux',
        isPortInUse: portIsFree,
        readModels: async () => catalogOf([freeTextRow()], 0),
      })
      await runtime.start('ab'.repeat(32))

      const stopping = runtime.stop()
      await settle()
      child.emit('close', 0)
      await stopping

      child.emit('error', new Error('kill ESRCH'))
      await expect(runtime.waitUntilReady()).resolves.toEqual([freeTextRow()])
    })
  })

  describe('the runtime log', () => {
    it('hands the child a descriptor instead of a pipe nothing drains', async () => {
      // The plugin never reads the buyer's output, and a pipe whose reader never
      // reads fills the OS buffer and then blocks the writer mid-handshake. A file
      // is drained by the kernel, so the output survives and the process keeps
      // running — which matters twice over, because that text is the only
      // explanation a failed start ever has.
      const root = await makeRoot()
      await installTree(root)
      const { calls, spawn } = recordingSpawn([new FakeChild()])
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })
      await runtime.start('ab'.repeat(32))

      const stdio = calls[0]?.stdio ?? []
      expect(stdio[0]).toBe('ignore')
      expect(typeof stdio[1]).toBe('number')
      // One descriptor for both streams, so the two cannot interleave into a
      // half-written line.
      expect(stdio[2]).toBe(stdio[1])
      expect(existsSync(join(root, 'runtime.log'))).toBe(true)
    })

    it('quotes the log when a start fails, instead of reporting a bare exit code', async () => {
      // `exited with code 1` is true and useless. What the buyer itself said is
      // the only thing that names the cause, and the user cannot run the CLI by
      // hand to find out: the plugin owns its install, its data directory, and
      // its identity.
      const root = await makeRoot()
      await installTree(root)
      await writeFile(join(root, 'runtime.log'), 'Error: npm was not found on this machine\n')
      const child = new FakeChild()
      const { spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        spawnProcess: spawn,
        platform: 'linux',
        isPortInUse: portIsFree,
        readModels: async () => silentCatalog(),
        readyTimeoutMs: 60_000,
      })
      await runtime.start('ab'.repeat(32))
      await settle()

      child.emit('exit', 1)

      await expect(runtime.waitUntilReady()).rejects.toThrow('exited with code 1 before it answered its directory\nError: npm was not found on this machine')
    })

    it('adds nothing to the sentence when the log holds nothing worth quoting', async () => {
      // The one thing worse than a bare exit code is a sentence with a blank line
      // appended to it, which reads as though the reason had been found and lost.
      const root = await makeRoot()
      await installTree(root)
      await writeFile(join(root, 'runtime.log'), '   \n')
      const child = new FakeChild()
      const { spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        spawnProcess: spawn,
        platform: 'linux',
        isPortInUse: portIsFree,
        readModels: async () => silentCatalog(),
        readyTimeoutMs: 60_000,
      })
      await runtime.start('ab'.repeat(32))
      await settle()

      child.emit('exit', 1)

      const error = await runtime.waitUntilReady().catch((cause: unknown) => cause)
      expect((error as Error).message).toBe('The buyer exited with code 1 before it answered its directory')
    })

    it('truncates a log that outgrew its ceiling', async () => {
      // One install, one log, and a buyer that logs discovery traffic: without a
      // ceiling a machine left running would accumulate an unbounded file.
      const root = await makeRoot()
      await installTree(root)
      await writeFile(join(root, 'runtime.log'), 'x'.repeat((2 * 1_024 * 1_024) + 1))
      const { calls, spawn } = recordingSpawn([new FakeChild()])
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })
      await runtime.start('ab'.repeat(32))

      // Truncated rather than rotated: the run that just happened is the part
      // anyone actually reads.
      expect(statSync(join(root, 'runtime.log')).size).toBe(0)
      expect(typeof calls[0]?.stdio[1]).toBe('number')
    })

    it('starts the buyer anyway when the log cannot be opened', async () => {
      // The output is a convenience and the process is the feature: a log this
      // process cannot open must not cost the user the gateway.
      const root = await makeRoot()
      await installTree(root)
      // A directory at the log's path opens perfectly well on Windows and is not
      // a log: a descriptor for it would be handed to a child that then fails to
      // write its output instead of this module declining here.
      await mkdir(join(root, 'runtime.log'), { recursive: true })
      const child = new FakeChild()
      const { calls, spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({
        rootDirectory: root,
        spawnProcess: spawn,
        platform: 'linux',
        isPortInUse: portIsFree,
        readModels: async () => silentCatalog(),
        readyTimeoutMs: 60_000,
      })
      await runtime.start('ab'.repeat(32))

      expect(calls[0]?.stdio).toEqual(['ignore', 'ignore', 'ignore'])
      expect(runtime.status().running).toBe(true)

      // And the failure it reports is the exit alone: a log that cannot be read
      // contributes nothing rather than replacing the status that explained it.
      child.emit('exit', 1)
      await expect(runtime.waitUntilReady()).rejects.toThrow('exited with code 1 before it answered its directory')
    })

    it('quotes the log when an install fails', async () => {
      // A failed install is the likeliest failure there is — a registry that is
      // unreachable, a proxy that refuses, a package that does not exist — and
      // npm's own line is the only thing that tells the three apart.
      const root = await makeRoot()
      await writeFile(join(root, 'runtime.log'), 'npm ERR! code E404\n')
      const child = new FakeChild()
      const { calls, spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })
      const installing = runtime.install()
      await waitForSpawn(calls)

      child.emit('close', 1)

      await expect(installing).rejects.toThrow('The runtime install failed\nnpm ERR! code E404')
    })

    it('reports a refused command line as a failed install rather than a bare errno', async () => {
      // `spawn` throws this class of failure synchronously — it never reaches the
      // child's `error` event, because there is no child — and on Windows a `.cmd`
      // started without a shell is exactly that. The user saw the errno text and
      // nothing else, so what is asserted here is the message that replaced it:
      // the same one every other failed install gets, with the log quoted.
      const root = await makeRoot()
      await writeFile(join(root, 'runtime.log'), 'npm was not found\n')
      const refusing = (() => { throw new Error('spawn EINVAL') }) as unknown as AntSeedSpawn
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: refusing, isPortInUse: portIsFree })

      await expect(runtime.install()).rejects.toThrow('The runtime install failed\nnpm was not found')
    })
  })

  describe('stop', () => {
    it('does nothing when no buyer is running', async () => {
      const root = await makeRoot()
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root })
      await expect(runtime.stop()).resolves.toBeUndefined()
    })

    it('ends the process and clears the handle', async () => {
      const root = await makeRoot()
      await installTree(root)
      const child = new FakeChild()
      const { spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, platform: 'linux', isPortInUse: portIsFree })
      await runtime.start('ab'.repeat(32))

      const stopping = runtime.stop()
      await settle()
      child.emit('close', 0)
      await stopping

      expect(child.signals).toEqual(['SIGKILL'])
      expect(runtime.status().running).toBe(false)
    })

    it('ends a Windows process through taskkill, which is the only signal that works', async () => {
      const root = await makeRoot()
      await installTree(root)
      const child = new FakeChild()
      const { spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, platform: 'win32', npmCommand: 'npm.cmd', isPortInUse: portIsFree })
      await runtime.start('ab'.repeat(32))

      const stopping = runtime.stop()
      await settle()
      child.emit('close', 0)
      await stopping

      // `child.kill` posts nothing a console process without a window can
      // receive, so the Windows path must not go through it.
      expect(child.signals).toEqual([])
      expect(runtime.status().running).toBe(false)
    })

    it('forces a buyer down when it never reports its own close', async () => {
      // The grace period is five seconds and the cap is twice that, so the clock
      // is what makes this a unit test instead of a ten-second one.
      const root = await makeRoot()
      await installTree(root)
      const child = new FakeChild()
      const { spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, platform: 'linux', isPortInUse: portIsFree })
      await runtime.start('ab'.repeat(32))

      vi.useFakeTimers()
      try {
        const stopping = runtime.stop()
        await vi.advanceTimersByTimeAsync(10_001)
        await stopping
      } finally {
        vi.useRealTimers()
      }

      // Once on the way in, and once more when the grace period expired without a
      // close — which is the escalation the timeout exists for.
      expect(child.signals).toEqual(['SIGKILL', 'SIGKILL'])
    })

    it('ends a process that already exited without signalling it again', async () => {
      const root = await makeRoot()
      await installTree(root)
      const child = new FakeChild()
      const { spawn } = recordingSpawn([child])
      const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, platform: 'linux', isPortInUse: portIsFree })
      await runtime.start('ab'.repeat(32))
      child.exitCode = 0

      const stopping = runtime.stop()
      await settle()
      child.emit('close', 0)
      await stopping

      expect(child.signals).toEqual([])
    })
  })

  it('abandons an install whose child never reports anything', async () => {
    const root = await makeRoot()
    const child = new FakeChild()
    const { calls, spawn } = recordingSpawn([child])
    // Nothing is emitted at all: the install's own deadline is the only thing that
    // can settle it, and the child it gives up on is killed rather than left running.
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, platform: 'linux', installTimeoutMs: 5, isPortInUse: portIsFree })
    const installing = runtime.install()
    await waitForSpawn(calls)
    await expect(installing).rejects.toThrow('The runtime install failed')
    expect(child.signals).toEqual(['SIGKILL'])
  })

  it('treats a child that cannot be spawned as a failed install', async () => {
    const root = await makeRoot()
    const child = new FakeChild()
    const { calls, spawn } = recordingSpawn([child])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })
    const installing = runtime.install()
    await waitForSpawn(calls)
    child.emit('error', new Error('spawn npm ENOENT'))
    await expect(installing).rejects.toThrow('The runtime install failed')
  })

  it('installs through the real spawn when nothing is injected', async () => {
    // The default binding is the one the plugin actually runs with, and no other
    // test takes it. Node stands in for npm: the pinned package name is not a
    // script, so the install fails fast and what is asserted is that the binding
    // was reached and its result read, not that npm succeeded.
    const root = await makeRoot()
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, npmCommand: process.execPath })
    await expect(runtime.install()).rejects.toThrow('The runtime install failed')
  })

  it('forgets a handle it already dropped, even if the process reports later', async () => {
    const root = await makeRoot()
    await installTree(root)
    const child = new FakeChild()
    const { spawn } = recordingSpawn([child])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, platform: 'linux', isPortInUse: portIsFree })
    await runtime.start('ab'.repeat(32))

    const stopping = runtime.stop()
    await settle()
    child.emit('close', 0)
    await stopping

    // The exit arrives after the stop already cleared the handle, so the guard has
    // to see that the child reporting is no longer the one this runtime holds.
    child.emit('exit', 0)
    expect(runtime.status().running).toBe(false)
  })

  it('keeps operating after an operation fails', async () => {
    const root = await makeRoot()
    const failed = new FakeChild()
    const { calls, spawn } = recordingSpawn([failed])
    const runtime = new AntSeedBuyerRuntime({ rootDirectory: root, spawnProcess: spawn, isPortInUse: portIsFree })

    const installing = runtime.install()
    await waitForSpawn(calls)
    failed.emit('close', 1)
    await expect(installing).rejects.toThrow()

    // The serialization chain must not stay rejected: the user's next click has
    // to work, which is the whole point of installing again after a failure. The
    // second attempt has no child scripted, so its own spawn refuses — and that
    // refusal now arrives as the ordinary failed-install message rather than the
    // binding's errno, which is what makes the attempt itself the thing asserted.
    await expect(runtime.install()).rejects.toThrow('The runtime install failed')
  })
})
