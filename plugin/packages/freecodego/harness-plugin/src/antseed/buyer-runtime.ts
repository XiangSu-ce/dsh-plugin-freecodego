/**
 * The free-model buyer runtime, installed and supervised by this plugin.
 *
 * One decision this module makes
 * ------------------------------
 * The buyer is an **external process**, not vendored code. The upstream protocol
 * needs a DHT, an end-to-end encrypted transport, and EIP-712 channel signing;
 * depending on their published packages keeps that surface theirs and keeps the
 * protocol's schema bumps out of this plugin's release cycle. What the plugin
 * takes over is everything the user would otherwise do by hand: fetching the
 * package, keeping it below the Harness home, supplying an identity, and
 * starting and stopping it.
 *
 * Three boundaries it holds
 * -------------------------
 * **The identity never reaches the command line, and the environment is an
 * allowlist, not a copy.** Command lines are world-readable on every platform,
 * so the key travels only in `ANTSEED_IDENTITY_HEX`; and passing `process.env`
 * through would hand the child every credential this Host holds.
 *
 * **The buyer reads the plugin's own state, not the user's.** The install root,
 * the data directory, and the config path all point under the Host's runtime
 * root, so a user who also runs the CLI keeps their own config, their own
 * identity, and their own routing preferences — and this plugin never reads or
 * writes any of those.
 *
 * **The routing preferences are the plugin's, not the CLI's defaults.** They can
 * be stated nowhere else — upstream reads no environment variable for any of
 * them — and their default is not the policy this plugin promises: a trust floor
 * of 60 is a *hard* gate on routing while `/v1/models` reports every offer
 * regardless, so the card would offer free models that answering a request
 * refuses. The file is written under the plugin's own root, just before each
 * start; see {@link AntSeedBuyerRuntime.writeBuyerConfig}.
 *
 * **A port this runtime does not own is refused, not adopted.** The CLI's answer
 * to a busy port is to reuse whoever answers there, which for a managed buyer
 * means serving traffic with an identity this plugin did not hand over; see
 * {@link AntSeedBuyerRuntime.assertPortIsFree}.
 *
 * The one directory it cannot redirect
 * ------------------------------------
 * Before its proxy can bind, the CLI installs its router plugin into a
 * **hard-coded** directory under the user's home
 * (`apps/cli/src/plugins/manager.ts` computes it from `homedir()` and reads no
 * environment variable), and that
 * cache is therefore shared with any hand-run CLI on the machine. This plugin
 * neither writes nor reads the config or identity there; it only notices
 * whether the router plugin is already cached, because that decides how long
 * the first start may legitimately take. See {@link AntSeedBuyerRuntimeOptions.pluginsDirectory}.
 *
 * One rename the install has to survive
 * -------------------------------------
 * The root was renamed from `runtimes/antseed` to `runtimes/key-gateway`, and
 * the completion marker with it, so that nothing a user can find on disk carries
 * the upstream name either. Someone who already downloaded must not be asked to
 * do it again, so a previous release's root is renamed into the new name the
 * first time this handle looks at it — a same-volume rename, so it costs
 * metadata rather than bytes — and is used where it lies when that rename is
 * refused, because re-fetching bytes the user already has is worse than a
 * directory under the old name. Both marker spellings count as installed for the
 * same reason, and so does a tree with no marker that holds the pinned package —
 * see {@link AntSeedBuyerRuntime.status}. Only a *default* root is treated this
 * way: a root the caller names is used exactly as named, since an injected root
 * belongs to its caller.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/antseed/buyer-runtime
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { harnessHomeDirectory } from '../data-home.ts'
// The plugin's own quoter for a `cmd.exe` command line. Imported rather than
// copied: it is the one place here that already knows how to hand a `.cmd` shim
// to `cmd.exe` (including the `%`-expansion case quoting cannot fix), and a
// second copy of that rule is a copy that drifts — see `installLaunch`.
import { windowsShimCommandLine } from '../plugin-update.ts'
import {
  ANTSEED_DEFAULT_PORT,
  isAntSeedPort,
  readAntSeedCatalog,
  type AntSeedCatalog,
  type AntSeedModelRow,
} from './provider.ts'

/** npm package that carries the buyer proxy. */
export const ANTSEED_CLI_PACKAGE = '@antseed/cli'

/**
 * The version this plugin installs.
 *
 * Pinned rather than ranged: the buyer speaks a versioned protocol whose schema
 * has changed more than once in the weeks before this was written, and a
 * floating range would adopt a schema change without a plugin release.
 */
export const ANTSEED_CLI_VERSION = '0.1.165'

/** Marker written only after an install finished, so a partial install is never adopted. */
const INSTALL_MARKER = '.key-gateway-install-complete'

/**
 * Marker a previous release wrote, under the name it used then.
 *
 * Read wherever {@link INSTALL_MARKER} is read: an install someone already has
 * must keep counting as installed rather than being downloaded a second time.
 * Nothing ever writes this name again — a completed install writes the current
 * one — so it only ever travels with the tree it was found in.
 */
const LEGACY_INSTALL_MARKER = '.antseed-install-complete'

/** Directory the runtime root is named, under the Harness home's `runtimes`. */
const RUNTIME_DIRECTORY = 'key-gateway'

/**
 * Directory a previous release named the same root.
 *
 * Kept so the rename above is invisible to anyone who already downloaded: see
 * {@link adoptLegacyRoot}.
 */
const LEGACY_RUNTIME_DIRECTORY = 'antseed'

/**
 * File both children's output is written to, under the plugin's own root.
 *
 * The install and the buyer share it because they are two halves of one story: a
 * start that fails is usually reporting what the install left behind.
 */
const LOG_FILE = 'runtime.log'

/**
 * How large the log may grow before the next start truncates it.
 *
 * A buyer is a long-lived process that logs discovery traffic, so an install
 * someone leaves running for a month would otherwise leave an unbounded file on
 * disk. The interesting part of any failure is always the run that just
 * happened, which is why exceeding the ceiling truncates rather than rotates.
 */
const LOG_MAX_BYTES = 2 * 1_024 * 1_024

/** How much of the log's tail a failure message quotes. */
const LOG_TAIL_CHARS = 600

/**
 * Router plugin the CLI installs into its own cache before its proxy can bind.
 *
 * Named here — rather than left implicit — because its presence is how this
 * module tells a first start from a warm one.
 */
export const ANTSEED_ROUTER_PLUGIN = '@antseed/router-local'

/** How long an install may take before it is abandoned. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
/** How long the proxy may take to answer its directory after a start. */
const READY_TIMEOUT_MS = 60_000
/**
 * How long the proxy may take on a machine where the CLI has never run.
 *
 * The first start is not the same operation as every later one: the CLI fetches
 * and installs its router plugin into its own cache before its proxy can bind,
 * and that install is bounded at two minutes upstream and needs the registry.
 * A one-minute budget would abandon a start that is working correctly and kill
 * the child mid-install, and the user's next click would restart it.
 */
const FIRST_READY_TIMEOUT_MS = 4 * 60_000
/** Interval between readiness probes. */
const READY_POLL_MS = 500
/** Grace period before a started process is force-killed. */
const STOP_GRACE_MS = 5_000

/**
 * Price ceiling handed to the managed buyer, in USD per million tokens.
 *
 * Zero, and **enforced by the buyer's own router** rather than by this plugin's
 * settings surface: the router drops every seller offer priced above the
 * ceiling before it ranks anything, and a zero-priced offer passes it (`>`).
 * The card offers free models and nothing else, and this is what makes that
 * true of the process itself — even an installation that later funds the wallet
 * cannot be charged through this buyer, because no paid offer ever reaches the
 * router's candidate list. It is a recorded decision, not a default: lifting it
 * is how paid models would be enabled, and that change would also have to say
 * what the card shows for a route that can cost money.
 */
const BUYER_PRICE_CEILING_USD_PER_MILLION = '0'

/**
 * Routing preferences the managed buyer is pinned to.
 *
 * Written to the buyer's own config file before every start, because upstream
 * reads no environment variable for any of these and its built-in default is not
 * the policy this plugin promises:
 *
 * - `minTrustScore` is a **hard gate**, not a tie-break
 *   (`isModelRouteEligible` in `packages/node/src/routing/model-route-ranking.ts`
 *   refuses a peer scored below it, and refuses one that has no score at all),
 *   and it defaults to 60. The listing does *not* apply that gate — it only uses
 *   the same preferences to order offers — so a free model below the floor is
 *   offered by the settings card and then answered with `502 model_not_found`.
 *   Zero is what makes the card honest: with the price ceiling above, every
 *   offer still reachable is a free one, and the trust floor is the only other
 *   thing that could refuse it. It is also upstream's own free-only setting
 *   (`minTrustScore: 0` in their documented free-only configuration).
 * - `preferFreePeers` says which side to fall on when two eligible offers cost
 *   the same.
 * - `maxInputUsdPerMillion` is a soft penalty only (`score -= 50`), left at zero
 *   for the same reason as the ceiling: this buyer is for free models.
 * - The two peer lists are empty: the plugin has no opinion about which sellers
 *   serve it, and the ceiling is what keeps routing free.
 */
const BUYER_ROUTING_PREFERENCES = {
  preferFreePeers: true,
  maxInputUsdPerMillion: 0,
  minTrustScore: 0,
  allowedPeerIds: [],
  blockedPeerIds: [],
} as const

/** How long the start-time port probe waits for one connect attempt to settle. */
const PORT_PROBE_TIMEOUT_MS = 1_000

/**
 * Environment entries the child needs, spelled for both platforms.
 *
 * An allowlist rather than a filter: a name added here is a deliberate decision
 * about what the buyer may see, and everything else — API keys, tokens, proxy
 * credentials — is absent by default.
 */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'Path', 'PATHEXT', 'ComSpec', 'SystemRoot', 'windir', 'SystemDrive',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]

/**
 * The child-process surface this module uses, structurally.
 *
 * Narrower than `ChildProcessWithoutNullStreams` on purpose: both children are
 * spawned with every stdio handle ignored, and this module never reads a pipe,
 * so demanding the full stdio type would only force a cast at the default
 * binding and make the injected fake harder to write than the code it replaces.
 */
export interface AntSeedChildProcess {
  readonly pid?: number | undefined
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  /** Stop the process; the signal is ignored on Windows. */
  kill(signal?: NodeJS.Signals): boolean
  /**
   * Subscribe to the lifecycle events this module observes.
   *
   * Two signatures, because the events do not carry the same thing: an `exit`
   * reports the status the process ended with, while an `error` reports why it
   * could not be started at all — and that reason is the only explanation such a
   * failure ever has. The listener is never called by this module, so a caller
   * may declare fewer parameters than the event carries.
   */
  once(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

/** How this module starts a child process. */
export type AntSeedSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    /**
     * `ProcessEnv` rather than a plain string map, because npm inherits the
     * ambient environment as-is: the option is the same object `spawn` defaults
     * to, so there is no narrowing to do and no copy to get out of step.
     */
    readonly env: NodeJS.ProcessEnv
    readonly shell: false
    readonly windowsHide: true
    /**
     * Whether the command line is already quoted for the platform's shell.
     *
     * Set only on the `cmd.exe` path, where the arguments were quoted by
     * {@link windowsShimCommandLine} and Node must pass them through untouched.
     */
    readonly windowsVerbatimArguments: boolean
    /**
     * One entry per standard handle. A number is an open file descriptor the
     * child inherits, which is how the children's output is written to a file
     * rather than to a pipe nothing in this module drains.
     */
    readonly stdio: ('pipe' | 'ignore' | number)[]
  },
) => AntSeedChildProcess

/** What the Host reports about the managed buyer. */
export interface AntSeedRuntimeStatus {
  /** Whether a completed install is present. */
  readonly installed: boolean
  /** Whether this plugin currently owns a live buyer process. */
  readonly running: boolean
  /** Loopback port the proxy listens on. */
  readonly port: number
  /** Version this plugin installs and runs. */
  readonly version: string
  /** Root the install and its data directory live under. */
  readonly rootDirectory: string
  /** Why the runtime is not usable, when it is not. */
  readonly reason?: string
}

/** How the buyer runtime is configured. */
export interface AntSeedBuyerRuntimeOptions {
  /** Loopback port; defaults to {@link ANTSEED_DEFAULT_PORT}. */
  readonly port?: number
  /**
   * Install root; defaults to `<harness home>/runtimes/key-gateway`.
   *
   * Naming one also opts out of adopting a previous release's root, which is
   * what makes this option usable by a second caller or a test without the
   * machine's own install leaking into it.
   */
  readonly rootDirectory?: string
  /**
   * The CLI's own plugin cache, which is hard-coded under the user's home
   * upstream and cannot be redirected by this plugin. Read only, and only to
   * tell whether a start will have to fetch its router plugin first.
   */
  readonly pluginsDirectory?: string
  /** Version to install; pinned by default. */
  readonly version?: string
  /** npm executable used for the install. */
  readonly npmCommand?: string
  /**
   * Host platform, which decides how a process is ended and how npm is spelled.
   * Injectable so the Windows path stays pinned by tests on every host rather
   * than only on the Windows lane.
   */
  readonly platform?: NodeJS.Platform
  /** Spawn implementation; injectable so a test does not start a process. */
  readonly spawnProcess?: AntSeedSpawn
  /**
   * Models reader; injectable so a test does not open a socket.
   *
   * Answers with the whole catalog rather than only the free rows, because the
   * readiness wait reads its paid count too — see {@link AntSeedBuyerRuntime.waitUntilReady}.
   */
  readonly readModels?: (port: number, signal?: AbortSignal) => Promise<AntSeedCatalog>
  /**
   * Whether something else is already listening on a loopback port.
   *
   * Injectable so a test does not depend on the machine it runs on: the port this
   * runtime uses is the one a developer's own gateway may be holding, and a suite
   * that read that would pass or fail by whether it happened to be running. See
   * {@link AntSeedBuyerRuntime.assertPortIsFree}.
   */
  readonly isPortInUse?: (port: number) => Promise<boolean>
  /** Install timeout; defaults to ten minutes. */
  readonly installTimeoutMs?: number
  /** Readiness timeout once the CLI's plugin cache is warm; defaults to one minute. */
  readonly readyTimeoutMs?: number
  /**
   * Readiness timeout for a start that may have to install the router plugin
   * first; defaults to four minutes, and never shortens {@link readyTimeoutMs}.
   */
  readonly firstReadyTimeoutMs?: number
}

/**
 * Owns the managed buyer: its install, its process, and its lifecycle.
 *
 * Every operation is serialized through one promise chain, because the
 * operations here contradict each other when overlapped — two installs race on
 * the same directory, and a stop that interleaves a start leaves a process
 * nobody holds a handle to.
 */
export class AntSeedBuyerRuntime {
  /** Install and data root, outside any state a hand-run CLI keeps. */
  readonly rootDirectory: string
  /**
   * Whether this handle may adopt the root a previous release used.
   *
   * True only for the default root. A caller that names a directory is asking
   * for that directory, and searching the user's home for another one would be
   * answering a question nobody asked.
   */
  private readonly adoptsLegacyRoot: boolean
  /** The root in use, once resolved; see {@link root}. */
  private adoptedRoot: string | undefined
  private readonly port: number
  private readonly version: string
  private readonly npmCommand: string
  private readonly platform: NodeJS.Platform
  private readonly spawnProcess: AntSeedSpawn
  private readonly readModels: (port: number, signal?: AbortSignal) => Promise<AntSeedCatalog>
  private readonly isPortInUse: (port: number) => Promise<boolean>
  private readonly installTimeoutMs: number
  private readonly readyTimeoutMs: number
  private readonly firstReadyTimeoutMs: number
  private readonly pluginsDirectory: string
  private child: AntSeedChildProcess | undefined
  /**
   * How a buyer this runtime was holding ended, when it ended without being
   * asked to, phrased as the sentence the settings surface shows.
   *
   * Recorded only for a process this runtime was still holding: a child stopped
   * on purpose is the user's own decision and must not read as a crash. Its one
   * reader is the readiness wait, which would otherwise spend its whole budget
   * probing a port whose process is already gone — or, for a process that never
   * started, a port that was never going to be bound.
   */
  private lastFailure: string | undefined
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * Build a runtime handle.
   *
   * This constructor touches no filesystem and starts nothing: a settings page
   * constructs one to ask its status, and that must not install anything.
   * @param options - the port, root, and injected bindings.
   */
  constructor(options: AntSeedBuyerRuntimeOptions = {}) {
    const port = options.port ?? ANTSEED_DEFAULT_PORT
    if (!isAntSeedPort(port)) throw new Error(`The buyer port ${String(port)} is not a usable port number`)
    this.port = port
    this.version = options.version ?? ANTSEED_CLI_VERSION
    this.adoptsLegacyRoot = options.rootDirectory === undefined
    this.rootDirectory = resolve(options.rootDirectory ?? join(harnessHomeDirectory(), 'runtimes', RUNTIME_DIRECTORY))
    this.platform = options.platform ?? process.platform
    this.npmCommand = options.npmCommand ?? (this.platform === 'win32' ? 'npm.cmd' : 'npm')
    this.spawnProcess = options.spawnProcess ?? defaultSpawn
    // Readiness asks for every listing, so a buyer that serves only image
    // models is ready once it answers rather than reported as never starting.
    this.readModels = options.readModels
      ?? ((readPort, signal) => readAntSeedCatalog({ port: readPort, ...(signal === undefined ? {} : { signal }) }))
    this.isPortInUse = options.isPortInUse ?? defaultPortProbe
    this.installTimeoutMs = options.installTimeoutMs ?? INSTALL_TIMEOUT_MS
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.firstReadyTimeoutMs = options.firstReadyTimeoutMs ?? FIRST_READY_TIMEOUT_MS
    this.pluginsDirectory = resolve(options.pluginsDirectory ?? join(homedir(), '.antseed', 'plugins'))
  }

  /**
   * The install root in use: the configured one, or the one a previous release
   * left behind.
   *
   * Resolved on first use rather than in the constructor, which promises to
   * touch no filesystem, and cached afterwards so the rename is attempted once
   * per handle instead of once per status read. A rename that cannot be done is
   * not an error — the install then runs where it lies, which is the whole point
   * of having looked for it — so this getter never throws and never re-fetches
   * anything.
   */
  private get root(): string {
    if (!this.adoptsLegacyRoot) return this.rootDirectory
    return this.adoptedRoot ??= adoptLegacyRoot(this.rootDirectory)
  }

  /** Absolute path of the installed CLI entry point. */
  private get entryPoint(): string {
    return join(this.root, 'node_modules', ANTSEED_CLI_PACKAGE, 'dist', 'cli', 'index.js')
  }

  /** Data directory handed to the buyer, so it never writes to the CLI's own default. */
  private get dataDirectory(): string {
    return join(this.root, 'data')
  }

  /**
   * Config file the buyer reads, and the only file under this root the plugin
   * writes besides the install marker.
   *
   * Upstream resolves this path independently of the data directory, so it is
   * named here rather than left to the CLI's default in the user's home. See
   * {@link AntSeedBuyerRuntime.writeBuyerConfig} for what goes in it.
   */
  private get configPath(): string {
    return join(this.dataDirectory, 'config.json')
  }

  /**
   * Where the install's and the buyer's own output goes.
   *
   * Both children write here instead of to a pipe: nobody in this plugin drains
   * a pipe, and a writer whose reader never reads fills the OS buffer and then
   * blocks mid-handshake. A file descriptor is drained by the kernel, so the
   * output survives *and* the process keeps running — and it is the one place the
   * reason for a failed start is ever written down.
   */
  private get logPath(): string {
    return join(this.root, LOG_FILE)
  }

  /**
   * Report the install and process state without changing either.
   *
   * Two ways a tree counts as installed, and the second one exists because
   * re-fetching bytes the user already has is worse than either way of being
   * wrong about them:
   *
   * - **The marker, plus the entry point.** The marker is written after npm
   *   exits zero, so it is the plugin's own statement that this tree is whole.
   * - **A tree that verifies itself.** No marker, but the package on disk is
   *   the pinned version and its entry point is there. That is what an install
   *   someone moved here by hand, restored from a backup, copied from another
   *   machine, or produced with `npm install --prefix` looks like — and the
   *   version is what makes the check safe: the proxy speaks a pinned protocol,
   *   so a tree holding another version is one this plugin must not run, and
   *   the answer to it is the same download it would have asked for anyway.
   *   The remaining case is an install this plugin was interrupted in the
   *   middle of: if both files survived it, the tree reads as installed and a
   *   broken one fails on start with the log tail beside it, which is visible —
   *   unlike a tree that is whole and is asked to download itself again.
   *
   * Reading the manifest is what tells those apart, and it is read rather than
   * trusted from the marker for the reason the whole pin exists: what matters is
   * what is on disk, not what a file says was asked for.
   * @returns the current status.
   */
  status(): AntSeedRuntimeStatus {
    const root = this.root
    const base = {
      running: this.child !== undefined,
      port: this.port,
      version: this.version,
      // The root in use, not the one the constructor was handed: a status that
      // named the new spelling while the install sits under the old one would
      // send anyone reading it to an empty directory.
      rootDirectory: root,
    }
    if (!hasInstallMarker(root)) {
      return existsSync(this.entryPoint) && installedCliVersion(root) === this.version
        ? { ...base, installed: true }
        : { ...base, installed: false, reason: 'KEY_GATEWAY_RUNTIME_NOT_INSTALLED' }
    }
    if (!existsSync(this.entryPoint)) return { ...base, installed: false, reason: 'KEY_GATEWAY_RUNTIME_INCOMPLETE' }
    return { ...base, installed: true }
  }

  /**
   * Fetch and install the pinned CLI package into the managed root.
   *
   * Presented to the user as one button: the npm invocation, the version pin,
   * and the data directory are this plugin's business, not theirs. The
   * completion marker is written last, so an interrupted install reports
   * `not installed` and the next attempt starts clean instead of running a
   * half-unpacked tree — and every spelling of that marker is cleared first, so
   * a tree an older release marked complete cannot vouch for this one.
   *
   * Refused while a buyer is running rather than stopping it here: installing
   * writes over the tree that process is executing out of, which npm cannot do
   * on Windows while those files are held open — and stopping a process is the
   * caller's decision, since the switch that made it meaningful has to be closed
   * with it.
   * @returns the status once the install finished.
   * @throws when a buyer is running out of the tree, or the install failed.
   */
  async install(): Promise<AntSeedRuntimeStatus> {
    return this.serialize(async () => {
      if (this.child !== undefined) throw new Error('KEY_GATEWAY_RUNTIME_RUNNING: stop the buyer before installing over it')
      const root = this.root
      await mkdir(root, { recursive: true })
      for (const marker of [INSTALL_MARKER, LEGACY_INSTALL_MARKER]) await rm(join(root, marker), { force: true })
      const installed = await this.runInstall(root)
      if (!installed) throw new Error(`The runtime install failed${readLogTail(this.logPath)}`)
      await writeFile(join(root, INSTALL_MARKER), `${this.version}\n`, { mode: 0o600 })
      return this.status()
    })
  }

  /**
   * Start the buyer proxy for one identity, carrying the current state's models.
   *
   * The identity arrives as an argument and leaves through the environment
   * only: it is never an argument to the child, and no caller-supplied option
   * can put it on the command line.
   * @param identityHex - the private key, 32 bytes written as 64 hex characters.
   * @throws when the runtime is not installed, or the child cannot be started.
   */
  async start(identityHex: string): Promise<void> {
    await this.serialize(async () => {
      const status = this.status()
      // Defensive: `status()` states a reason on every not-installed path, but the
      // field is optional in the shape, so the marker is the floor rather than a
      // message nothing can produce.
      /* v8 ignore next -- status() always reports a reason when it reports not installed. */
      if (!status.installed) throw new Error(status.reason ?? 'KEY_GATEWAY_RUNTIME_NOT_INSTALLED')
      if (this.child !== undefined) return
      // Asked before anything is written or started: a buyer that cannot own its
      // port must leave no trace of an attempt behind.
      await this.assertPortIsFree()
      await mkdir(this.dataDirectory, { recursive: true })
      await this.writeBuyerConfig()
      const child = this.spawnBuyer(identityHex)
      this.child = child
      this.lastFailure = undefined
      // A process that dies before the first probe would otherwise leave a
      // handle that reads as `running`, and the readiness wait would spend its
      // whole budget on a buyer that is already gone.
      child.once('exit', (code, signal) => {
        if (this.child !== child) return
        this.child = undefined
        this.lastFailure = `${describeExit({ code, signal })}${readLogTail(this.logPath)}`
      })
      // A process that could not be started at all reports `error`, not `exit`.
      // This listener is not optional politeness: an emitter with no `error`
      // listener throws the event out of whatever is running it, so a buyer that
      // could not be spawned — a locked executable, an exhausted descriptor
      // table, a missing working directory — would take the Host down with it.
      // The reason travels with the event, and it is the whole explanation, so
      // it is what the readiness wait reports.
      child.once('error', (error) => {
        if (this.child !== child) return
        this.child = undefined
        this.lastFailure = `The buyer could not be started: ${error.message}${readLogTail(this.logPath)}`
      })
    })
  }

  /**
   * Wait until the proxy answers its model directory.
   *
   * Ready means the buyer has **discovered something**, not that it has found a
   * free model — and the two had to be told apart once the catalog began
   * dropping paid rows, because the live network's image offers are all priced
   * per picture. Waiting for a free row would leave a correctly working buyer
   * probing for the whole budget on a network that has none, and the switch
   * would refuse to open over it. The wait therefore ends on the paid count as
   * well, and reports only the free rows it found.
   * @param signal - aborts the wait.
   * @returns the free models the buyer serves, once it answers.
   * @throws when the deadline passes with no answer, or the wait is aborted.
   */
  async waitUntilReady(signal?: AbortSignal): Promise<readonly AntSeedModelRow[]> {
    const budget = this.readyBudget()
    const deadline = Date.now() + budget
    for (;;) {
      if (signal?.aborted === true) throw new Error('The buyer readiness wait was aborted')
      // Asked before the probe, so the answer to a failed start is the failure
      // rather than a connection error repeated until the budget runs out.
      const failure = this.lastFailure
      if (failure !== undefined) throw new Error(failure)
      const catalog = await this.readModels(this.port, signal)
      if (catalog.models.length + catalog.paid > 0) return catalog.models
      if (Date.now() >= deadline) throw new Error(`The buyer did not answer on port ${String(this.port)} within ${String(budget)}ms`)
      await delay(READY_POLL_MS)
    }
  }

  /**
   * How long this readiness wait may take.
   *
   * Longer while the CLI's router plugin is not cached, because that start has
   * an install in front of it and the install is bounded at two minutes
   * upstream. A warm cache skips it entirely, so the ordinary budget applies —
   * which is why the two are measured apart rather than one long timeout being
   * used for both: a buyer that is simply wedged should be reported in a
   * minute, not after four.
   * @returns the milliseconds this wait may spend.
   */
  private readyBudget(): number {
    const cached = existsSync(join(this.pluginsDirectory, 'node_modules', ANTSEED_ROUTER_PLUGIN, 'package.json'))
    return cached ? this.readyTimeoutMs : Math.max(this.readyTimeoutMs, this.firstReadyTimeoutMs)
  }

  /**
   * Stop the buyer process, gracefully then by force.
   *
   * Bounded on every path: a buyer whose pipes are held open by an orphaned
   * grandchild may never emit `close`, and a teardown that waits for it would
   * hang the Host's disposal chain.
   */
  async stop(): Promise<void> {
    await this.serialize(async () => {
      const child = this.child
      if (child === undefined) return
      this.child = undefined
      terminate(child, this.platform)
      await new Promise<void>((resolveStop) => {
        const grace = setTimeout(() => { terminate(child, this.platform) }, STOP_GRACE_MS)
        const cap = setTimeout(resolveStop, STOP_GRACE_MS * 2)
        child.once('close', () => { clearTimeout(grace); clearTimeout(cap); resolveStop() })
      })
    })
  }

  /**
   * Refuse to start onto a port this runtime does not own.
   *
   * The CLI's own answer to a busy port is to adopt whoever answers there
   * (`isCompatibleBuyerProxy`) and keep running without the listener. For a
   * managed buyer that is the worst available outcome: the process reports
   * itself alive, the directory answers, the switch opens — and every request is
   * served by a buyer this plugin did not start and did not hand this identity
   * to. The case that matters is a buyer left behind by an earlier Host crash,
   * because it outlives a replaced key: the card would show the new peer id while
   * the old one signed.
   *
   * Refusing is the whole fix. Adopting is what the CLI already does, and killing
   * whatever holds the port would mean killing a process this plugin cannot
   * identify as its own — a hand-run CLI buyer is exactly as likely as a leftover.
   * @throws when something is already listening on the port.
   */
  private async assertPortIsFree(): Promise<void> {
    if (!await this.isPortInUse(this.port)) return
    throw new Error(
      `Port ${String(this.port)} is already in use, so the buyer cannot be started. `
      + 'That port is often held by a buyer left running by an earlier crash; close it and try again.',
    )
  }

  /**
   * Write the routing preferences the buyer runs under, before it starts.
   *
   * Every start rather than only when the file is missing: this is state derived
   * from the plugin, so a file written by an older release — or edited by hand —
   * must not outlive its reason.
   *
   * Written through a temporary name and renamed into place. The proxy watches
   * this path for live routing updates, and a reader that arrived mid-write would
   * see a truncated document, fall back to the built-in defaults, and put the
   * trust floor back without anything reporting it.
   */
  private async writeBuyerConfig(): Promise<void> {
    const path = this.configPath
    const staged = `${path}.writing`
    const document = `${JSON.stringify({ buyer: { routingPreferences: BUYER_ROUTING_PREFERENCES } }, null, 2)}\n`
    await writeFile(staged, document, { mode: 0o600 })
    renameSync(staged, path)
  }

  /**
   * Start the buyer, with its output going to this runtime's own log.
   * @param identityHex - the private key to hand over in the environment.
   * @returns the started process.
   */
  private spawnBuyer(identityHex: string): AntSeedChildProcess {
    return this.spawnWithLog(process.execPath, [
      this.entryPoint,
      'buyer', 'start',
      '--port', String(this.port),
    ], this.root, this.childEnvironment(identityHex))
  }

  /**
   * Start one child with its output written to the log file.
   *
   * A file, not a pipe: nothing in this plugin drains a pipe, and a writer whose
   * reader never reads fills the OS buffer and then blocks — a peer-to-peer
   * client logging discovery traffic reaches that within seconds and hangs
   * mid-handshake with a live-looking handle and a health check that never
   * answers. A descriptor is drained by the kernel, so the output survives and
   * the process keeps running, and that text is the only explanation a failed
   * start ever has.
   * @param command - the executable to start.
   * @param args - its arguments.
   * @param cwd - its working directory.
   * @param env - its environment.
   * @param verbatim - whether the command line is already quoted for `cmd.exe`.
   * @returns the started process.
   */
  private spawnWithLog(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, verbatim = false): AntSeedChildProcess {
    const log = openRuntimeLog(this.logPath)
    try {
      return this.spawnProcess(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        stdio: ['ignore', log ?? 'ignore', log ?? 'ignore'],
      })
    } finally {
      // The child holds its own duplicate of the descriptor. This one was only
      // ever the handoff, and leaving it open would leak one per start.
      if (log !== undefined) closeSync(log)
    }
  }

  /**
   * How the install is started, which differs by platform for one reason.
   *
   * On Windows `npm` is a `.cmd` shim, and `spawn` refuses to start one without a
   * shell — the failure is `EINVAL`, raised before any child exists, which is
   * what the user saw as a download that failed with nothing in the log. The
   * shell route Node offers instead (`shell: true`) is not usable here either:
   * with a shell Node joins the argv array into one command line **without
   * quoting it**, so a Harness home with a space in it — `C:\Users\Some Name\.dsh`
   * — would arrive as two arguments. The command line is therefore built by this
   * plugin's own quoter and handed to `cmd.exe` verbatim, exactly as the `dsh`
   * install path does.
   * @param root - the root to install into.
   * @returns the command, its arguments, its environment, and whether the line is pre-quoted.
   */
  private installLaunch(root: string): {
    readonly command: string
    readonly args: readonly string[]
    readonly env: NodeJS.ProcessEnv
    readonly verbatim: boolean
  } {
    const args = [
      'install',
      '--prefix', root,
      '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error',
      `${ANTSEED_CLI_PACKAGE}@${this.version}`,
    ]
    if (this.platform !== 'win32') return { command: this.npmCommand, args, env: process.env, verbatim: false }
    const shim = windowsShimCommandLine(this.npmCommand, args)
    return {
      command: process.env.ComSpec?.trim() || 'cmd.exe',
      args: ['/d', '/s', '/c', shim.line],
      // A token carrying `%` travels in the environment instead of on the line,
      // because `cmd.exe` expands variables even inside double quotes.
      env: { ...process.env, ...shim.environment },
      verbatim: true,
    }
  }

  /**
   * Run the npm install, bounded, reporting only whether it completed.
   * @param root - the root to install into, passed rather than re-read so the
   * install and the marker that follows it cannot disagree about which tree.
   */
  private runInstall(root: string): Promise<boolean> {
    const launch = this.installLaunch(root)
    return new Promise<boolean>((resolveInstall) => {
      // The install needs the user's registry and proxy configuration, which is
      // why npm inherits the ambient environment while the buyer does not: npm
      // writes no credentials into the tree it installs.
      let child: AntSeedChildProcess
      try {
        child = this.spawnWithLog(launch.command, launch.args, root, launch.env, launch.verbatim)
      } catch {
        // `spawn` raises some failures by *throwing* rather than through the
        // `error` event, and it does so before any child exists — a command line
        // it refuses to start is the whole class. Letting that escape would put a
        // bare `spawn EINVAL` in front of the user, which is the one reading that
        // says nothing about npm, the log, or what to do next. It is reported as
        // an ordinary failed install instead, so the same log tail is quoted.
        resolveInstall(false)
        return
      }
      const timer = setTimeout(() => { terminate(child, this.platform); resolveInstall(false) }, this.installTimeoutMs)
      child.once('error', () => { clearTimeout(timer); resolveInstall(false) })
      child.once('close', (code) => { clearTimeout(timer); resolveInstall(code === 0) })
    })
  }

  /**
   * The child's environment: the allowlist, plus the identity and data root.
   * @param identityHex - the private key to hand over.
   * @returns the environment for the buyer process.
   */
  private childEnvironment(identityHex: string): Record<string, string> {
    const environment: Record<string, string> = {}
    for (const name of ENV_ALLOWLIST) {
      const value = process.env[name]
      if (value !== undefined) environment[name] = value
    }
    environment.ANTSEED_IDENTITY_HEX = identityHex
    environment.ANTSEED_DATA_DIR = this.dataDirectory
    // The config path defaults to a file in the user's home *independently* of the
    // data directory, so leaving it unset would have the managed buyer read the
    // user's own file: their routing preferences, their payment preferences, their
    // port. The plugin's own file is written just before each start, and is the
    // only place the routing preferences can be stated at all — upstream reads no
    // environment variable for them, and its defaults are not this buyer's policy.
    // See `writeBuyerConfig`.
    environment.ANTSEED_CONFIG = this.configPath
    // The ceiling is passed, not configured on disk: a config file is state a
    // user can edit (or a hand-run CLI can share), while these two names are
    // read by the CLI at startup and applied *after* its own config, so the
    // managed buyer's ceiling cannot be raised from outside this plugin.
    environment.ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION = BUYER_PRICE_CEILING_USD_PER_MILLION
    environment.ANTSEED_BUYER_MAX_OUTPUT_USD_PER_MILLION = BUYER_PRICE_CEILING_USD_PER_MILLION
    // Settlement stays on, and nothing here may turn it off: the free path is
    // signed too. `ANTSEED_ENABLE_SETTLEMENT=false` starts the buyer with no
    // payments block at all, and the node builds its free-usage client only when
    // `payments.rpcUrl` and `payments.freeUsageAddress` are both set
    // (`packages/node/src/node.ts`), so a free request would have nothing to
    // authorize against. The ceiling above is what keeps this buyer free; this
    // switch is not a second way to say so.
    return environment
  }

  /** Run one operation at a time; a rejected operation must not block the next. */
  private serialize<Value>(operation: () => Promise<Value>): Promise<Value> {
    const next = this.chain.then(operation, operation)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }
}

/**
 * Start a child process through Node's own `spawn`.
 * @param command - the executable to start.
 * @param args - its arguments.
 * @param options - the spawn options this module sets.
 * @returns the started process.
 */
const defaultSpawn: AntSeedSpawn = (command, args, options) => spawn(command, [...args], options)

/**
 * Whether something is already listening on a loopback port.
 *
 * A connect is the whole test: the kernel refuses instantly on a port nobody
 * holds, and a listening socket accepts before any of its application code runs,
 * so the answer does not depend on what the other process is willing to say. The
 * timeout is a backstop for the one case that is neither — a listener whose
 * accept queue is full — and it counts as occupied, because something is there.
 * @param port - the loopback port to test.
 * @returns whether a listener holds it.
 */
const defaultPortProbe = (port: number): Promise<boolean> => new Promise<boolean>((resolveProbe) => {
  const socket = connect({ host: '127.0.0.1', port })
  /* v8 ignore next -- a loopback connect is accepted or refused; a listener whose accept queue is full is not buildable in a test. */
  const timer = setTimeout(() => { resolveProbe(true) }, PORT_PROBE_TIMEOUT_MS)
  // Every path that answers also closes the socket and clears the timer, so a
  // probe leaves neither behind it: a start that answered in a millisecond must
  // not hold the event loop open for the timeout it did not need. A socket that
  // errors after connecting runs this a second time and reads the same way — a
  // settled promise ignores the repeat.
  const finish = (inUse: boolean): void => {
    clearTimeout(timer)
    socket.destroy()
    resolveProbe(inUse)
  }
  socket.once('connect', () => { finish(true) })
  socket.once('error', () => { finish(false) })
})

/** Whether a root carries evidence that an install finished, under either spelling. */
function hasInstallMarker(root: string): boolean {
  return existsSync(join(root, INSTALL_MARKER)) || existsSync(join(root, LEGACY_INSTALL_MARKER))
}

/**
 * The version of the installed CLI package, when the tree holds a readable one.
 *
 * Read from the package's own manifest, so it says what npm actually unpacked
 * rather than what the plugin asked for. An absent, unreadable, or unversioned
 * manifest answers `undefined`, which the caller reads exactly like a mismatched
 * version: not installed. That is deliberate — the three are one state to a
 * user, who is being asked to download the pinned release either way — and it
 * keeps a damaged manifest from throwing out of a status read.
 * @param root - the install root.
 * @returns the version string, or `undefined` when there is none to read.
 */
function installedCliVersion(root: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'node_modules', ANTSEED_CLI_PACKAGE, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * The root to use, renaming a previous release's root into the current name.
 *
 * The marker decides what is an install in both directions: a directory without
 * one is a half-written tree, so it is neither adopted nor renamed over an
 * install that works.
 *
 * The rename is only ever made into **free space**. A name something else
 * already occupies is not this module's to take — and a rename would take it,
 * replacing whatever is there — which is not worth a tidier directory when the
 * install already works where it is. A refused rename ends the same way, for
 * the same reason: the user asked for models, not for a directory with a
 * particular name.
 * @param root - the configured root.
 * @returns the root the runtime should use.
 */
function adoptLegacyRoot(root: string): string {
  if (hasInstallMarker(root)) return root
  const legacy = join(dirname(root), LEGACY_RUNTIME_DIRECTORY)
  if (!hasInstallMarker(legacy)) return root
  if (existsSync(root)) return legacy
  try {
    renameSync(legacy, root)
    return root
  } catch {
    // On Windows a running process holding a file inside the tree is enough to
    // refuse this, and no portable test can build that state.
    /* v8 ignore next -- an OS-level refusal; see above. */
    return legacy
  }
}

/**
 * End a process, escalating on Windows where a graceful signal is not enough.
 *
 * The buyer runs until it is killed, so nothing here is polite by default: a
 * buyer that is on its way out must not keep a port bound while the user
 * watches a switch that has already been turned off.
 * @param child - the process to end.
 * @param platform - the host platform, which decides how it can be ended.
 */
function terminate(child: AntSeedChildProcess, platform: NodeJS.Platform): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (platform === 'win32' && child.pid !== undefined) {
    // `taskkill` without `/f` posts WM_CLOSE, which a console process without a
    // window never receives.
    // The error handler fires where `taskkill` is absent, which is the POSIX
    // lane standing in for a Windows host rather than a Windows one; the line
    // itself is the escalation either way.
    /* v8 ignore next -- `taskkill` ships with Windows, so its own start failure is not reachable there. */
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined)
    return
  }
  child.kill('SIGKILL')
}

/**
 * Say how a buyer that died on its own ended.
 *
 * The two shapes are worth distinguishing: an exit code is the process's own
 * verdict (`npm` refusing, a port already taken, a bad identity), while a signal
 * means something outside it killed it — and the user's next move differs.
 * @param exit - the code and signal the process reported.
 * @returns the sentence the settings surface shows.
 */
function describeExit(exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null }): string {
  const cause = exit.code === null
    ? `killed by ${exit.signal ?? 'a signal'} before it answered its directory`
    : `exited with code ${String(exit.code)} before it answered its directory`
  return `The buyer ${cause}`
}

/**
 * Wait for one polling interval.
 * @param ms - milliseconds to wait.
 * @returns a promise that settles after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms) })
}

/**
 * Open the runtime log for writing, or give up on it.
 *
 * A log this process cannot open — a read-only root, a full disk, a directory
 * someone put at that path — must not stop the buyer: the output is a
 * convenience and the process is the feature, so the fallback is silence rather
 * than a failure the user cannot do anything about.
 * @param path - the log file.
 * @returns the descriptor, or `undefined` when there is no log to write to.
 */
function openRuntimeLog(path: string): number | undefined {
  try {
    const existing = existsSync(path) ? statSync(path) : undefined
    // A directory at this path opens perfectly well on Windows and is not a log:
    // the descriptor would be handed to a child, which would then fail to write
    // its output rather than failing here.
    if (existing?.isDirectory() === true) return undefined
    // Past its ceiling the log is truncated rather than rotated: it belongs to
    // one install, and the run that just happened is the part anyone reads.
    const oversized = (existing?.size ?? 0) > LOG_MAX_BYTES
    return openSync(path, oversized ? 'w' : 'a')
  } catch {
    // An OS-level refusal no portable test can provoke — a read-only root, a full
    // disk — and the fallback is silence rather than a failure the user cannot do
    // anything about.
    /* v8 ignore next -- see above: unreachable without an environment no test can build. */
    return undefined
  }
}

/**
 * The tail of the runtime log, for a failure message.
 *
 * Quoted rather than counted: a process that refuses to start says why on its
 * own stderr — npm was not found, the port is taken, the identity is malformed —
 * and that sentence is the difference between "exited with code 1" and something
 * the user can act on. Best-effort in both directions: an absent or unreadable
 * log contributes nothing rather than replacing the status that did explain the
 * failure.
 * @param path - the log file.
 * @returns the last lines, prefixed with a newline, or an empty string.
 */
function readLogTail(path: string): string {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text === '' ? '' : `\n${text.slice(-LOG_TAIL_CHARS)}`
  } catch {
    return ''
  }
}
