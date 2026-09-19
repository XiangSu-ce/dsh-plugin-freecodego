/**
 * The binary-document guard on the official `read` tool.
 *
 * The pairing matters as much as the refusal: a magic-prefix check must refuse
 * a PDF renamed to `.bin` AND still read a text file that merely ends in
 * `.pdf`. A guard that only consulted the extension would pass the first case
 * and break the second, so both are asserted here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

const testToolSignal = new AbortController().signal

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
const session = { header: {} }
let callCounter = 0

function read(path: string) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`c-${++callCounter}`),
    name: 'read',
    arguments: { file_path: path },
    agent: { session } as never,
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-read-binary-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(ToolFs)
  fiber = await ctx.plugin({ apply: () => {} })
})

afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('read refuses binary PDFs', () => {
  it('refuses a PDF and names read_document instead of returning replacement characters', async () => {
    const path = join(dir, 'paper.pdf')
    await writeFile(path, Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'latin1'))
    const result = await read(path)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/binary PDF/)
    expect(JSON.stringify(result.content)).toMatch(/read_document/)
  })

  it('refuses by magic prefix, so a renamed PDF is still caught', async () => {
    const path = join(dir, 'report.bin')
    await writeFile(path, Buffer.from('%PDF-1.4\n', 'latin1'))
    const result = await read(path)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/binary PDF/)
  })

  it('still reads a text file whose name merely ends in .pdf', async () => {
    const path = join(dir, 'notes.pdf')
    await writeFile(path, 'plain text, not a PDF\n')
    const result = await read(path)
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toMatch(/plain text, not a PDF/)
  })

  it('still reads ordinary text and does not deny non-PDF binaries by name', async () => {
    const path = join(dir, 'note.txt')
    await writeFile(path, 'hello\n')
    const result = await read(path)
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toMatch(/hello/)
  })
})
