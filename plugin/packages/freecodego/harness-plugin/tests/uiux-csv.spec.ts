/**
 * Regression tests for the UI/UX catalogue CSV reader.
 *
 * Why the fixtures include a multiline cell and quoted commas
 * ---------------------------------------------------------
 * Those are not obscure CSV features in this source tree: stack guidance uses commas
 * in prose and one of its source cells spans physical lines. These cases assert that
 * one quoted field remains one field; a split-based reader can otherwise report the
 * expected number of records while silently moving each later field to the wrong
 * column.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tests/uiux-csv
 */

import { describe, expect, it } from 'vitest'

import { duplicateColumns, parseCsv, toRows } from '../src/uiux/csv.ts'

describe('parseCsv', () => {
  it('reads delimiters and escaped quotes inside quoted cells', () => {
    const parsed = parseCsv('name,notes\na,"one, two and ""three"""\n')
    expect(parsed.records.map(record => record.fields)).toStrictEqual([
      ['name', 'notes'],
      ['a', 'one, two and "three"'],
    ])
    expect(parsed.records[1]?.line).toBe(2)
  })

  it('keeps an embedded newline in one cell and advances the next record line', () => {
    const parsed = parseCsv('id,text\n1,"first line\nsecond line"\n2,last\n')
    expect(parsed.records.map(record => record.fields)).toStrictEqual([
      ['id', 'text'],
      ['1', 'first line\nsecond line'],
      ['2', 'last'],
    ])
    expect(parsed.records[2]?.line).toBe(4)
  })

  it('accepts CRLF endings and normalizes CRLF inside quoted cells', () => {
    const parsed = parseCsv('\uFEFFid,text\r\n1,"first\r\nsecond"\r\n2,last\r\n')
    expect(parsed.records.map(record => record.fields)).toStrictEqual([
      ['id', 'text'],
      ['1', 'first\nsecond'],
      ['2', 'last'],
    ])
    expect(parsed.records[2]?.line).toBe(4)
    expect(parsed.blankLines).toStrictEqual([])
  })

  it('keeps quote characters inside an unquoted field as data', () => {
    const parsed = parseCsv('width,label\n5" screen,wide\n')
    expect(parsed.records[1]?.fields).toStrictEqual(['5" screen', 'wide'])
  })

  it('reports physically blank lines but not empty cells', () => {
    const parsed = parseCsv('a,b\n,\n\nlast,row')
    expect(parsed.records.map(record => record.fields)).toStrictEqual([
      ['a', 'b'],
      ['', ''],
      ['last', 'row'],
    ])
    expect(parsed.blankLines).toStrictEqual([3])
    expect(parsed.records[2]?.line).toBe(4)
  })

  it('refuses an unterminated quoted field and illegal text after its closing quote', () => {
    expect(() => parseCsv('id,text\n1,"incomplete')).toThrow(/never closed/u)
    expect(() => parseCsv('id,text\n1,"closed"oops\n')).toThrow(/after closing quote/u)
  })

  it('reports duplicate headers and ragged row locations without padding', () => {
    const parsed = parseCsv('id,name,name\n1,one,two\n2,short\n')
    expect(duplicateColumns(parsed.records)).toStrictEqual(['name'])
    const converted = toRows(parsed.records)
    expect(converted.columns).toStrictEqual(['id', 'name', 'name'])
    expect(converted.rows).toStrictEqual([{ id: '1', name: 'two' }])
    expect(converted.ragged).toStrictEqual([{ line: 3, fields: 2 }])
  })
})
