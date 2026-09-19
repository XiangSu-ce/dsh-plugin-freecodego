import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BuildTracker, downloadVerifiedAsset, ensurePrivateDirectory, readRuntimeManifest, replaceRuntimeDirectory, replaceVerifiedRuntimeDirectory, writeRuntimeManifest } from '../src/engineering-runtime-store.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A directory holding one marker file, which is how the cases tell copies apart. */
async function runtimeCopy(directory: string, marker: string): Promise<void> {
  await ensurePrivateDirectory(directory, '测试引擎')
  await writeFile(join(directory, 'marker'), marker)
}

/** A fetch double that counts calls, so retry behavior is observable. */
function stubFetch(handler: (call: number) => Response | Promise<Response>): { readonly impl: typeof fetch; readonly calls: () => number } {
  let calls = 0
  const impl = (async () => { calls += 1; return await handler(calls) }) as unknown as typeof fetch
  return { impl, calls: () => calls }
}

describe('plugin-owned runtime store', () => {
  it('streams a digest-verified artifact to disk exactly once', async () => {
    const directory = await scratch('freecodego-store-')
    const destination = join(directory, 'bundle.zip')
    const fetch = stubFetch(() => new Response('bundle-bytes'))
    await downloadVerifiedAsset({ url: 'https://example.test/bundle.zip', digest: digestOf('bundle-bytes'), maxBytes: 1_024, label: '测试平台包', destination }, fetch.impl)
    expect(await readFile(destination, 'utf8')).toBe('bundle-bytes')
    expect(fetch.calls()).toBe(1)
  })

  it('rejects wrong bytes without retrying, and leaves no partial file behind', async () => {
    const directory = await scratch('freecodego-store-')
    const destination = join(directory, 'bundle.zip')
    const fetch = stubFetch(() => new Response('tampered'))
    await expect(downloadVerifiedAsset({ url: 'https://example.test/b', digest: digestOf('expected'), maxBytes: 1_024, label: '测试平台包', destination }, fetch.impl)).rejects.toThrow(/SHA-256 校验失败/u)
    // Integrity is a verdict, not a hiccup: a second request cannot fix it.
    expect(fetch.calls()).toBe(1)
    expect(existsSync(destination)).toBe(false)
  })

  it('retries one transient transfer failure, then succeeds', async () => {
    const directory = await scratch('freecodego-store-')
    const destination = join(directory, 'bundle.zip')
    const fetch = stubFetch(call => call === 1 ? Promise.reject(new Error('socket hang up')) : new Response('bundle-bytes'))
    await downloadVerifiedAsset({ url: 'https://example.test/b', digest: digestOf('bundle-bytes'), maxBytes: 1_024, label: '测试平台包', destination }, fetch.impl)
    expect(fetch.calls()).toBe(2)
    expect(await readFile(destination, 'utf8')).toBe('bundle-bytes')
  })

  it('refuses an oversized body and an error status', async () => {
    const directory = await scratch('freecodego-store-')
    const destination = join(directory, 'bundle.zip')
    const oversized = stubFetch(() => new Response('x'.repeat(64), { headers: { 'content-length': '64' } }))
    await expect(downloadVerifiedAsset({ url: 'https://example.test/b', digest: digestOf('x'.repeat(64)), maxBytes: 8, label: '测试平台包', destination }, oversized.impl)).rejects.toThrow(/超过允许大小/u)
    expect(existsSync(destination)).toBe(false)
    const missing = stubFetch(() => new Response('nope', { status: 404 }))
    await expect(downloadVerifiedAsset({ url: 'https://example.test/b', digest: digestOf('nope'), maxBytes: 1_024, label: '测试平台包', destination }, missing.impl)).rejects.toThrow(/HTTP 404/u)
    expect(existsSync(destination)).toBe(false)
  })

  it('round-trips a valid manifest and treats a malformed one as not installed', async () => {
    const directory = await scratch('freecodego-store-')
    const validate = (value: Record<string, unknown>): { readonly version: string } | undefined =>
      typeof value.version === 'string' ? { version: value.version } : undefined
    await expect(readRuntimeManifest(directory, validate)).resolves.toBeUndefined()
    await writeRuntimeManifest(directory, { version: '1.6.0' })
    await expect(readRuntimeManifest(directory, validate)).resolves.toEqual({ version: '1.6.0' })
    await writeFile(join(directory, 'runtime-state.json'), '{ truncated')
    await expect(readRuntimeManifest(directory, validate)).resolves.toBeUndefined()
    await writeFile(join(directory, 'runtime-state.json'), '[1,2,3]')
    await expect(readRuntimeManifest(directory, validate)).resolves.toBeUndefined()
  })

  it('publishes a staged runtime and keeps the previous one until the swap succeeds', async () => {
    const directory = await scratch('freecodego-store-')
    const target = join(directory, 'runtime', 'engine-1')
    await runtimeCopy(target, 'old')
    const staging = join(directory, 'staging')
    await runtimeCopy(staging, 'new')
    await replaceRuntimeDirectory(staging, target)
    expect(await readFile(join(target, 'marker'), 'utf8')).toBe('new')
    expect(existsSync(`${target}.previous`)).toBe(false)
  })

  it('hands the previous runtime to a caller that still has to verify it', async () => {
    // The plain swap deletes what it replaced, which is right only when the swap
    // was the last thing to check. A caller that verifies the published runtime
    // asks for it instead and owns what happens to it next.
    const directory = await scratch('freecodego-store-')
    const target = join(directory, 'runtime', 'engine-1')
    await runtimeCopy(target, 'old')
    const staging = join(directory, 'staging')
    await runtimeCopy(staging, 'new')
    const parked = await replaceRuntimeDirectory(staging, target, { keepPrevious: true })
    expect(parked).toBe(`${target}.previous`)
    expect(await readFile(join(target, 'marker'), 'utf8')).toBe('new')
    expect(await readFile(join(`${target}.previous`, 'marker'), 'utf8')).toBe('old')
    // And with nothing to park there is nothing to hand over.
    const second = join(directory, 'staging-2')
    await runtimeCopy(second, 'newer')
    await expect(replaceRuntimeDirectory(second, join(directory, 'runtime', 'empty'), { keepPrevious: true })).resolves.toBeUndefined()
  })

  describe('a runtime that is verified where it landed', () => {
    it('publishes the new copy when the check passes, and drops the previous one', async () => {
      const directory = await scratch('freecodego-store-')
      const target = join(directory, 'runtime', 'engine-1')
      await runtimeCopy(target, 'old')
      const staging = join(directory, 'staging')
      await runtimeCopy(staging, 'new')
      const verified: string[] = []
      await replaceVerifiedRuntimeDirectory({ staging, target, verify: async (published) => { verified.push(published) } })
      // The check is handed the path the runtime will actually run from, not the
      // staging path it was prepared at.
      expect(verified).toEqual([target])
      expect(await readFile(join(target, 'marker'), 'utf8')).toBe('new')
      expect(existsSync(`${target}.previous`)).toBe(false)
    })

    it('puts the previous runtime back when the check fails', async () => {
      // The defect this exists for: the engines verify the runtime after the
      // swap, and answered a failure by deleting the published directory. The
      // previous runtime was already gone by then, so *repairing* a working
      // install that failed its post-move check left the plugin with no runtime
      // at all — strictly worse than not having tried.
      const directory = await scratch('freecodego-store-')
      const target = join(directory, 'runtime', 'engine-1')
      await runtimeCopy(target, 'working')
      const staging = join(directory, 'staging')
      await runtimeCopy(staging, 'broken-after-move')
      await expect(replaceVerifiedRuntimeDirectory({
        staging,
        target,
        verify: async () => { throw new Error('移动后的验证失败：') },
      })).rejects.toThrow(/移动后的验证失败/u)
      expect(await readFile(join(target, 'marker'), 'utf8')).toBe('working')
      // And the unusable copy is not left anywhere, including under the name the
      // next swap would have to clear.
      expect(existsSync(`${target}.previous`)).toBe(false)
      expect(existsSync(staging)).toBe(false)
    })

    it('leaves nothing published when there was no previous runtime to restore', async () => {
      // The control: with nothing to fall back to, refusing means refusing.
      const directory = await scratch('freecodego-store-')
      const target = join(directory, 'runtime', 'engine-1')
      const staging = join(directory, 'staging')
      await runtimeCopy(staging, 'broken-after-move')
      await expect(replaceVerifiedRuntimeDirectory({
        staging,
        target,
        verify: async () => { throw new Error('移动后的验证失败：') },
      })).rejects.toThrow(/移动后的验证失败/u)
      expect(existsSync(target)).toBe(false)
      expect(existsSync(`${target}.previous`)).toBe(false)
    })
  })

  it('claims one workspace per build and refuses a second concurrent build', () => {
    const builds = new BuildTracker()
    expect(builds.isBuilding('ws-a')).toBe(false)
    builds.claim('ws-a', '该工作区的构建已在进行。')
    expect(builds.isBuilding('ws-a')).toBe(true)
    expect(() => { builds.claim('ws-a', '该工作区的构建已在进行。') }).toThrow(/已在进行/u)
    // A second workspace is unaffected: the guard is per workspace, not global.
    expect(() => { builds.claim('ws-b', '该工作区的构建已在进行。') }).not.toThrow()
    expect(builds.isBuilding('ws-b')).toBe(true)
  })

  it('aborts the claimed build through the handle it was given', () => {
    const builds = new BuildTracker()
    builds.claim('ws-a', '该工作区的构建已在进行。')
    // Nothing to abort until the engine publishes the runner's own controller.
    expect(builds.cancel('ws-a')).toEqual({ cancelled: false })
    const controller = new AbortController()
    builds.attach('ws-a', controller)
    expect(builds.cancel('ws-a')).toEqual({ cancelled: true })
    expect(controller.signal.aborted).toBe(true)
    // Cancelling again is a no-op on an already-aborted handle, never a throw.
    expect(builds.cancel('ws-a')).toEqual({ cancelled: true })
    expect(builds.cancel('ws-never-claimed')).toEqual({ cancelled: false })
  })

  it('releases the claim and the abort handle together', () => {
    const builds = new BuildTracker()
    builds.claim('ws-a', '该工作区的构建已在进行。')
    builds.attach('ws-a', new AbortController())
    builds.release('ws-a')
    expect(builds.isBuilding('ws-a')).toBe(false)
    // A released workspace cannot be cancelled, so a finished build never
    // reports a live cancel path to the UI.
    expect(builds.cancel('ws-a')).toEqual({ cancelled: false })
    expect(() => { builds.claim('ws-a', '该工作区的构建已在进行。') }).not.toThrow()
  })

  it('refuses a symlinked private directory instead of writing through it', async () => {
    const directory = await scratch('freecodego-store-')
    const real = join(directory, 'real')
    await ensurePrivateDirectory(real, '测试引擎')
    const link = join(directory, 'link')
    try {
      const { symlink } = await import('node:fs/promises')
      await symlink(real, link, 'dir')
    } catch {
      return // Windows without developer mode cannot create the link; the rule is still covered elsewhere.
    }
    await expect(ensurePrivateDirectory(link, '测试引擎')).rejects.toThrow(/符号链接/u)
  })
})
