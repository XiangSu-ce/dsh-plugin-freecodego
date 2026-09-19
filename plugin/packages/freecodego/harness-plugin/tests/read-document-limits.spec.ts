/**
 * `read_document`'s budget, and a notebook a Windows editor wrote.
 *
 * Two properties of the tool's own contract, both of which held on one path and
 * not on the other:
 *
 * 1. **`max_chars` is "extraction budget in characters"** — the parameter's own
 *    description — and it was applied only while extracting a PDF. A notebook was
 *    formatted with no budget at all, so the same call that bounded a PDF to a few
 *    hundred characters returned 200 KB from a notebook with one long source line.
 *    The line window is not a substitute: it bounds *lines*, and one line can be
 *    any length.
 * 2. **A notebook that starts with a byte-order mark is a notebook.** PowerShell's
 *    `Out-File -Encoding UTF8`, several editors' "UTF-8 with BOM" saves and anything
 *    written through a Windows API produce one; `JSON.parse` rejects it, and the
 *    caller saw the JavaScript parser's message instead of a document error.
 *
 * Both cases are asserted on the returned *characters*, not on the flags alone:
 * a flag that says "truncated" while the payload is 200 KB is the failure being
 * fixed.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatNotebookLines, readDocumentToolDefinition } from '../src/read-document.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })))
})

async function fixture(name: string, body: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'freecodego-readdoc-limits-'))
  directories.push(directory)
  const file = join(directory, name)
  await writeFile(file, body)
  return file
}

/** A notebook with one markdown cell holding a single very long line. */
function notebookWithLongLine(length: number): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
    cells: [
      { cell_type: 'markdown', source: ['L'.repeat(length)] },
      { cell_type: 'code', source: ['print(1)'], outputs: [] },
    ],
  })
}

const tool = readDocumentToolDefinition()
const returnedChars = (answer: { readonly lines?: readonly string[] }): number => (answer.lines ?? []).join('\n').length

describe('read_document max_chars', () => {
  it('bounds a notebook\'s output the way it bounds a PDF\'s', async () => {
    const path = await fixture('big.ipynb', notebookWithLongLine(200_000))
    const answer = await tool.execute({ file_path: path, max_chars: 500, limit: 100_000 }, {})
    // The budget plus the one cut line's own ending; what must not happen is the
    // 200 KB the same call returned before this case existed.
    expect(returnedChars(answer)).toBeLessThan(2_000)
    expect(answer.truncatedByChars).toBe(true)
    expect(answer.note).toContain('character budget')
  })

  it('keeps the call cheap when the budget is the default and the notebook is long', async () => {
    // The default budget is what a model gets when it says nothing, so it is the
    // one that matters most: 60_000 characters, not the document's size.
    const path = await fixture('long.ipynb', notebookWithLongLine(500_000))
    const answer = await tool.execute({ file_path: path }, {})
    expect(returnedChars(answer)).toBeLessThan(70_000)
  })

  it('does not report truncation when the document fits, and keeps every line', async () => {
    // The control: a budget is a ceiling, not a rewrite. A small notebook comes
    // back whole, with the cell headings and the code intact.
    const path = await fixture('small.ipynb', JSON.stringify({
      nbformat: 4,
      metadata: { kernelspec: { name: 'python3' } },
      cells: [
        { cell_type: 'markdown', source: ['# Title'] },
        { cell_type: 'code', source: ['print(1)'], outputs: [] },
      ],
    }))
    const answer = await tool.execute({ file_path: path, max_chars: 10_000 }, {})
    expect(answer.truncatedByChars).toBeUndefined()
    expect(answer.lines?.join('\n')).toContain('# Title')
    expect(answer.lines?.join('\n')).toContain('print(1)')
    expect(answer.totalLines).toBe(answer.lines?.length)
  })
})

describe('a notebook that starts with a byte-order mark', () => {
  it('is read, not rejected by the JSON parser', async () => {
    const body = `\uFEFF${notebookWithLongLine(10)}`
    const path = await fixture('bom.ipynb', body)
    const answer = await tool.execute({ file_path: path }, {})
    expect(answer.lines?.join('\n')).toContain('LLLLLLLLLL')
    expect(answer.totalLines).toBeGreaterThan(0)
  })

  it('still reports a file that is not a notebook as one', () => {
    // The message the BOM reached was the parser's. A file that really is not JSON
    // keeps a refusal a caller can act on, and it now says what was wrong in the
    // document's own terms rather than in JavaScript's.
    expect(() => formatNotebookLines('{"nbformat": 4, "cells": [', false)).toThrow(/not a Jupyter notebook/u)
  })
})
