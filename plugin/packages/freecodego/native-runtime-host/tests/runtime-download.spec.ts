import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadRuntimeArchive, extractRuntimeArchive, preserveRuntimeArchive } from '../src/runtime-download.ts'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

describe('runtime download cache', () => {
  it('downloads, verifies, extracts, and preserves an official-package archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-runtime-download-'))
    const source = join(root, 'source')
    await mkdir(join(source, 'package'), { recursive: true })
    await writeFile(join(source, 'package', 'README.md'), 'runtime package')
    const archive = join(root, 'package.tgz')
    await create({ cwd: source, file: archive, gzip: true }, ['package'])
    const bytes = await readFile(archive)
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(bytes)
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const spec = {
      id: 'test:win32-x64:1.0.0', engine: 'codex' as const, platform: 'win32-x64' as const,
      label: 'Test runtime', version: '1.0.0', runtimeVersion: 'test/1.0.0', sourceRevision: 'test',
      downloadURL: `http://127.0.0.1:${address.port}/package.tgz`, integrity, maxArchiveBytes: 1024 * 1024,
    }
    const cached = await downloadRuntimeArchive(spec, join(root, 'runtime', '.downloads'))
    const extracted = await extractRuntimeArchive(cached, join(root, 'extract'))
    expect(await readFile(join(extracted, 'README.md'), 'utf8')).toBe('runtime package')
    const temporary = join(root, 'temporary-runtime')
    await mkdir(temporary, { recursive: true })
    await preserveRuntimeArchive(cached, temporary)
    await expect(readFile(join(temporary, '.downloads', 'test-win32-x64-1.0.0.tgz'))).resolves.toEqual(bytes)
  })

  it('refuses an archive whose bytes do not match the declared integrity', async () => {
    // The hash is computed while streaming the archive, so this pins that the
    // streamed digest is still compared with the declared one.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-runtime-integrity-'))
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.from('not the package that was signed'))
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const spec = {
      id: 'test:integrity', engine: 'codex' as const, platform: 'win32-x64' as const,
      label: 'Test runtime', version: '1.0.0', runtimeVersion: 'test/1.0.0', sourceRevision: 'test',
      downloadURL: `http://127.0.0.1:${address.port}/package.tgz`,
      integrity: `sha512-${createHash('sha512').update('something else entirely').digest('base64')}`,
      maxArchiveBytes: 1024 * 1024,
    }
    await expect(downloadRuntimeArchive(spec, join(root, '.downloads'))).rejects.toThrow('failed integrity verification')
  })

  it('refuses a chunked response that passes the size limit mid-stream', async () => {
    // No `content-length` is sent, so the declared-length check cannot fire and
    // only the running byte count can refuse it: this is the path where the
    // response body used to be left streaming into a reader nobody would read.
    const root = await mkdtemp(join(tmpdir(), 'freecodego-runtime-limit-'))
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      const chunk = Buffer.alloc(8 * 1024)
      let written = 0
      const pump = (): void => {
        while (written < 64 * 1024) {
          written += chunk.byteLength
          if (!response.write(chunk)) { response.once('drain', pump); return }
        }
        response.end()
      }
      pump()
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const spec = {
      id: 'test:limit', engine: 'codex' as const, platform: 'win32-x64' as const,
      label: 'Test runtime', version: '1.0.0', runtimeVersion: 'test/1.0.0', sourceRevision: 'test',
      downloadURL: `http://127.0.0.1:${address.port}/package.tgz`,
      integrity: `sha512-${createHash('sha512').update('x').digest('base64')}`,
      maxArchiveBytes: 1024,
    }
    await expect(downloadRuntimeArchive(spec, join(root, '.downloads'))).rejects.toThrow('exceeds the configured archive size limit')
  })
})
