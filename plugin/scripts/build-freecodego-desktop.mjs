#!/usr/bin/env node
/**
 * Build the FreeCodeGo bundle and package a Desktop release that ships it.
 *
 * This is fork-owned tooling: nothing here writes into the upstream harness
 * tree. The injection seams are environment variables read by the fork patches
 * in `apps/desktop/scripts/prepare-package-set.ts` and the two Electron-version
 * seams, so the Desktop packaging pipeline itself stays byte-identical to
 * upstream whenever this wrapper is not the entry point.
 *
 * Every Desktop profile activates the bundle from the signed runtime, and
 * bundle resolution prefers the installation anchor over the profile, so the
 * packaged bundle is whichever build this script produced -- repackage and the
 * application ships the new bytes; no profile state carries the old copy.
 * `apps/desktop-host/src/index.ts` is fork-patched to read the installation
 * from the runtime project root: the injected tarball is a dependency recorded
 * on that project, and a package the anchor manifest does not declare stays out
 * of the runtime resolution table, where every bundle row would fail to import.
 *
 * Usage (from the repository root, or any directory):
 *   node plugin/scripts/build-freecodego-desktop.mjs
 *       # win-x64 directory build, unsigned (no signing credentials needed)
 *   node plugin/scripts/build-freecodego-desktop.mjs --installer
 *       # win-x64 unsigned NSIS installer instead of a bare directory
 *   node plugin/scripts/build-freecodego-desktop.mjs --skip-bundle
 *       # reuse an existing bundle dist/ (faster, only for iterating)
 *   node plugin/scripts/build-freecodego-desktop.mjs -- --build-version 0.1.7-alpha.2.YYYYMMDD.1
 *       # everything after `--` is forwarded to the packaging command
 *
 * Nothing here reads the working directory: every path resolves from this
 * file's own location, which is what lets the same command run from a clone,
 * from the published tree, or from a terminal pointed anywhere else.
 *
 * The unsigned directory build is the only mode this wrapper drives by
 * default: signed Windows packaging needs hardware-token credentials in
 * `apps/desktop/.env.windows`, and macOS targets need their signing stack.
 * Host prerequisites this wrapper does not create: Node 24 on PATH, the
 * workspace install, and the Electron download electron-builder performs on
 * first run (ELECTRON_MIRROR may be set to accelerate it). The Desktop runtime
 * install resolves its production closure from npm: when registry.npmjs.org is
 * unreachable, set DSH_DESKTOP_NPM_REGISTRY to an HTTPS origin mirror (for
 * example https://registry.npmmirror.com) in the caller's environment.
 *
 * On Windows the tar command that reads packed tarballs must be GNU tar with
 * `--force-local`: the first `tar` on this host's PATH is Git's GNU tar, which
 * reads `E:\...` archive names as remote hosts. bsdtar would not need the flag
 * but rejects it outright, so the wrapper sets TAR_OPTIONS only when GNU tar
 * is what `tar` resolves to and the option is not already configured.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'

const pluginRoot = resolve(import.meta.dirname, '..')
const workspaceRoot = resolve(pluginRoot, '..')
const bundlePackage = resolve(pluginRoot, 'packages/freecodego/bundle-latest')
const packingDir = resolve(workspaceRoot, '.tmp-freecodego-desktop-pack')

/**
 * The Electron release the packaged application runs on.
 *
 * `apps/desktop` declares `electron: ^44.0.0`, which resolves to the newest 44.x
 * patch. The shipped `node-addon-require-builtin` prebuild only recognizes exact
 * Electron V8 fingerprints (43.0.0, 44.0.0, 45.0.0-alpha.6), so a later 44.x shell
 * fails the Desktop payload smoke on `require('internal/modules/esm/loader')` -- and
 * that same internal-module lookup is what the packaged application needs at run
 * time. 44.0.0 is the newest release that prebuild supports.
 */
const DESKTOP_ELECTRON_VERSION = '44.0.0'

/** Parse the wrapper's own arguments; everything after `--` passes through untouched. */
function parseWrapperArgs(argv) {
  const passthroughIndex = argv.indexOf('--')
  const passthrough = passthroughIndex === -1 ? [] : argv.slice(passthroughIndex + 1)
  const own = (passthroughIndex === -1 ? argv : argv.slice(0, passthroughIndex))
    .filter(arg => arg !== '--')
  const flags = { installer: false, skipBundle: false }
  for (const arg of own) {
    if (arg === '--installer') flags.installer = true
    else if (arg === '--skip-bundle') flags.skipBundle = true
    else {
      throw new Error(`build-freecodego-desktop: unknown option ${arg} (known: --installer, --skip-bundle)`)
    }
  }
  if (process.platform !== 'win32') {
    throw new Error('build-freecodego-desktop: only the win-x64 target is wired; macOS targets need their signing environment')
  }
  return { ...flags, passthrough }
}

/**
 * Resolve a working `pnpm` for nested package scripts.
 *
 * `build:lib:host` and friends invoke `pnpm exec ...` from inside their
 * scripts; those children resolve `pnpm` from PATH. On this host the
 * ambient pnpm (corepack shim) is broken under Git Bash, so when `pnpm`
 * does not resolve to a working command the wrapper prepends a shim
 * directory that forwards to the workspace's own pnpm entry point.
 */
function withWorkingPnpmPath(environment) {
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8', windowsHide: true, shell: true })
  if (probe.status === 0 && /^11\./u.test((probe.stdout ?? '').trim())) return environment
  const shimDir = resolve(pluginRoot, '.tmp-pnpm-shim')
  mkdirSync(shimDir, { recursive: true })
  // %~dp0 is the shim directory with a trailing backslash: the path resolves at run
  // time, so no non-ASCII bytes land in the file (this checkout's root is non-ASCII,
  // and cmd.exe would re-encode them when reading the script).
  writeFileSync(join(shimDir, 'pnpm.cmd'), [
    '@echo off',
    'node "%~dp0../node_modules/pnpm/bin/pnpm.cjs" %*',
    '',
  ].join('\r\n'))
  // Windows PATH separator: nested pnpm children resolve through cmd.exe.
  return { ...environment, PATH: `${shimDir};${environment.PATH ?? ''}` }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? pluginRoot,
    stdio: options.inheritStdio === false ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: options.shell ?? false,
    encoding: options.inheritStdio === false ? 'utf8' : undefined,
    env: options.env ?? process.env,
    windowsHide: true,
    timeout: options.timeoutMs,
  })
  if (result.status !== 0) {
    const detail = options.inheritStdio === false
      ? `\n${String(result.stdout ?? '').slice(-2000)}\n${String(result.stderr ?? '').slice(-4000)}`
      : ''
    throw new Error(`build-freecodego-desktop: ${command} ${args.join(' ')} exited with ${String(result.status ?? result.signal)}${detail}`)
  }
  return result
}

/**
 * Build the bundle. `pnpm run build:freecodego:bundle` is the one supported
 * entry: it rebuilds the freecodego workspace libs the bundle inlines, then
 * assembles `bundle-latest/dist`, which is exactly what the tarball packs.
 * The packaging pipeline's own `build:official` does not rebuild bundle dist,
 * so this step is what makes the shipped bundle match current sources.
 */
function buildBundle(env) {
  console.log('[freecodego-desktop] building plugin bundle (pnpm run build:freecodego:bundle)...')
  const pnpmEntry = resolve(pluginRoot, 'node_modules/pnpm/bin/pnpm.cjs')
  if (!existsSync(pnpmEntry)) throw new Error(`build-freecodego-desktop: missing ${pnpmEntry}; run the workspace install first`)
  run(process.execPath, [pnpmEntry, 'run', 'build:freecodego:bundle'], { env })
  for (const artifact of ['bootstrap.js', 'client.cjs', 'harness-plugin.js']) {
    if (!existsSync(join(bundlePackage, 'dist', artifact))) {
      throw new Error(`build-freecodego-desktop: bundle build produced no dist/${artifact}`)
    }
  }
  console.log('[freecodego-desktop] bundle build complete.')
}

/** Pack the freshly built bundle into the tarball the Desktop package set will carry. */
function packBundleTarball(env) {
  console.log('[freecodego-desktop] packing freecodego tarball (npm pack)...')
  rmSync(packingDir, { recursive: true, force: true })
  mkdirSync(packingDir, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(bundlePackage, 'package.json'), 'utf8'))
  // `npm` on Windows is a .cmd shim that spawnSync cannot launch without a
  // shell, so npm's CLI entry point runs under the current Node directly --
  // the same remedy `scripts/pnpm-invocation.ts` applies to pnpm.
  const npmEntry = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmEntry)) throw new Error(`build-freecodego-desktop: missing npm CLI at ${npmEntry}`)
  run(process.execPath, [npmEntry, 'pack', '--pack-destination', packingDir, '--silent'], { cwd: bundlePackage, env })
  const tarballs = readdirSync(packingDir).filter(name => name.endsWith('.tgz')).sort()
  if (tarballs.length !== 1) {
    throw new Error(`build-freecodego-desktop: expected one packed tarball, found ${JSON.stringify(tarballs)}`)
  }
  const tarball = join(packingDir, tarballs[0])
  const body = readFileSync(tarball)
  console.log(`[freecodego-desktop] packed ${tarballs[0]} (${body.byteLength} bytes, sha512-${createHash('sha512').update(body).digest('base64').slice(0, 16)}...)`)
  return tarball
}

/** The runtime binds one dsh version; freecodego is an independent npm package and only reported here. */
function reportVersions() {
  const desktop = JSON.parse(readFileSync(join(pluginRoot, 'apps/desktop/package.json'), 'utf8'))
  const dsh = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  const bundle = JSON.parse(readFileSync(join(bundlePackage, 'package.json'), 'utf8'))
  if (desktop.version !== dsh.version) {
    throw new Error(`build-freecodego-desktop: apps/desktop ${desktop.version} must bind dsh ${dsh.version}; refresh the harness sync first`)
  }
  console.log(`[freecodego-desktop] desktop/dsh ${desktop.version}, freecodego ${bundle.version}`)
}

/**
 * Windows + GNU tar: make `tar` treat `E:\...` archive names as local files.
 * Set only when the resolved `tar` is GNU tar (bsdtar rejects the option) and
 * the caller has not configured TAR_OPTIONS already.
 */
function withTarForceLocal(environment) {
  if (process.platform !== 'win32') return environment
  const resolved = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true })
  if (!(resolved.stdout ?? '').startsWith('tar (GNU tar)')) return environment
  if ((environment.TAR_OPTIONS ?? '').includes('--force-local')) return environment
  return { ...environment, TAR_OPTIONS: `${environment.TAR_OPTIONS ? `${environment.TAR_OPTIONS} ` : ''}--force-local` }
}

async function main() {
  const { installer, skipBundle, passthrough } = parseWrapperArgs(process.argv.slice(2))
  reportVersions()
  if (skipBundle && !existsSync(join(bundlePackage, 'dist', 'bootstrap.js'))) {
    throw new Error('build-freecodego-desktop: --skip-bundle set but no dist/bootstrap.js exists')
  }
  const env = withWorkingPnpmPath(withTarForceLocal(process.env))
  if (!skipBundle) buildBundle(env)
  const tarball = packBundleTarball(env)

  const pnpmEntry = resolve(pluginRoot, 'node_modules/pnpm/bin/pnpm.cjs')
  // Both modes are unsigned: a signed Windows build needs hardware-token
  // credentials, and the `dir` script (without --unsigned) still runs the
  // token-signer validation. The unsigned script presets `--unsigned`;
  // directory mode additionally passes `--dir` for an unpacked application.
  const script = 'package:desktop:win:x64:unsigned'
  const args = installer ? [...passthrough] : ['--dir', ...passthrough]
  // Every nested pnpm run filters its child environment through the same
  // `env` object, but the packaging scripts spawn `pnpm run ...` children of
  // their own via the PATH shim; keep the injection variable and the tar
  // option on both layers by exporting them through the shim environment.
  const electronVersion = process.env.FREECODEGO_DESKTOP_ELECTRON_VERSION?.trim()
    || DESKTOP_ELECTRON_VERSION
  const injectedEnv = {
    ...env,
    FREECODEGO_DESKTOP_TARBALL: tarball,
    FREECODEGO_DESKTOP_ELECTRON_VERSION: electronVersion,
    TAR_OPTIONS: env.TAR_OPTIONS ?? '--force-local',
  }
  console.log(`[freecodego-desktop] packaging win-x64 ${installer ? 'unsigned installer' : 'unsigned directory'} (pnpm run ${script})...`)
  console.log(`[freecodego-desktop] injecting ${basename(tarball)} via FREECODEGO_DESKTOP_TARBALL`)
  console.log(`[freecodego-desktop] downloading Electron ${electronVersion} via FREECODEGO_DESKTOP_ELECTRON_VERSION`)
  run(process.execPath, [pnpmEntry, 'run', script, ...args], { env: injectedEnv })
  console.log('[freecodego-desktop] done. Artifacts: plugin/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts (win-unpacked directory build)')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
