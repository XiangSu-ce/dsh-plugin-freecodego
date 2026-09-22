/** Cover the free-model table generator's pure half: rendering and region replacement. */

import { describe, expect, it } from 'vitest'
import {
  FREE_MODEL_TABLE_BEGIN, FREE_MODEL_TABLE_END,
  recordedObservedAt, renderFreeModelRegion, replaceFreeModelRegion,
} from './generate-free-model-tables.ts'

const SECTION = {
  observedAt: '2026-09-23',
  cells: [
    {
      label: { en: 'OpenCode', zh: 'OpenCode' },
      models: { en: '`big-pickle`', zh: '`big-pickle`' },
      directory: { en: '1 of 2 rows; public, no sign-in', zh: '2 行中的 1 行；公开，无需登录' },
    },
    {
      label: { en: 'TRAE', zh: 'TRAE' },
      models: { en: 'the rows its directory lists', zh: '其目录列出的那些行' },
      directory: { en: 'free credits reset daily, per account', zh: '免费额度每日重置，按账号' },
      rosterless: true,
    },
  ],
  footnotes: [
    { en: 'Generated, not remembered.', zh: '由脚本生成，而非凭记忆。' },
    { en: 'TRAE publishes no stable roster.', zh: 'TRAE 不公布固定名单。' },
  ],
} as const

describe('renderFreeModelRegion', () => {
  it('wraps the table in the markers the replacer looks for', () => {
    const region = renderFreeModelRegion(SECTION, 'en', '\n')

    expect(region.startsWith(`${FREE_MODEL_TABLE_BEGIN}\n`)).toBe(true)
    expect(region.endsWith(`${FREE_MODEL_TABLE_END}\n`)).toBe(true)
    expect(region.split(FREE_MODEL_TABLE_BEGIN)).toHaveLength(2)
    expect(region.split(FREE_MODEL_TABLE_END)).toHaveLength(2)
  })

  it('renders the reading date, every row and every footnote', () => {
    const region = renderFreeModelRegion(SECTION, 'en', '\n')

    expect(region).toContain('2026-09-23')
    expect(region).toContain('| **OpenCode** | `big-pickle` | 1 of 2 rows; public, no sign-in |')
    expect(region).toContain('| **TRAE** | the rows its directory lists |')
    expect(region).toContain('Generated, not remembered.')
    expect(region).toContain('TRAE publishes no stable roster.')
  })

  it('renders the Chinese half with its own separator and header', () => {
    const region = renderFreeModelRegion(SECTION, 'zh', '\n')

    expect(region).toContain('| 提供商 | 免费模型 | 目录 |')
    expect(region).toContain('| **OpenCode** | `big-pickle` | 2 行中的 1 行；公开，无需登录 |')
    expect(region).toContain('由脚本生成，而非凭记忆。')
  })

  it('uses the target line ending, so a CRLF document keeps its endings', () => {
    const region = renderFreeModelRegion(SECTION, 'en', '\r\n')

    expect(region).toContain('\r\n')
    expect(region.replaceAll('\r\n', '')).not.toContain('\n')
  })
})

describe('recordedObservedAt', () => {
  // The reading this table was built from happened at 00:52 local on the 23rd,
  // which is still the 22nd in UTC. A recording that stored the frame instant
  // and sliced it published the 22nd — and the next live run, which dates the
  // table from the reader's own clock, called all twelve tables stale.
  const justAfterMidnight = { observedAt: '2026-09-23' }

  it('states the date the recording carries, verbatim', () => {
    expect(recordedObservedAt(justAfterMidnight)).toBe('2026-09-23')
  })

  it('never dates a reading to the day its instant fell on in UTC', () => {
    expect(recordedObservedAt(justAfterMidnight)).not.toBe('2026-09-22')
  })

  it('refuses to date a recording that carries no reading date', () => {
    expect(recordedObservedAt({})).toBeUndefined()
  })

  it('treats an empty date as missing rather than publishing a blank one', () => {
    expect(recordedObservedAt({ observedAt: '' })).toBeUndefined()
  })
})

describe('replaceFreeModelRegion', () => {
  const document = [
    '# Front page',
    '',
    'Prose above.',
    '',
    FREE_MODEL_TABLE_BEGIN,
    'stale table',
    FREE_MODEL_TABLE_END,
    '',
    '## Feature tour',
    '',
    'Prose below.',
    '',
  ].join('\n')

  it('replaces only the marked region and keeps both neighbours', () => {
    const replaced = replaceFreeModelRegion(document, renderFreeModelRegion(SECTION, 'en', '\n'))

    expect(replaced).toContain('Prose above.')
    expect(replaced).toContain('## Feature tour')
    expect(replaced).toContain('Prose below.')
    expect(replaced).not.toContain('stale table')
    expect(replaced).toContain('| **OpenCode** | `big-pickle`')
  })

  it('is idempotent, which is what makes the check mode meaningful', () => {
    const region = renderFreeModelRegion(SECTION, 'en', '\n')
    const once = replaceFreeModelRegion(document, region)

    expect(replaceFreeModelRegion(once, region)).toBe(once)
  })

  it('refuses a document without markers instead of appending a second table', () => {
    expect(() => replaceFreeModelRegion('no markers here\n', renderFreeModelRegion(SECTION, 'en', '\n'))).toThrow(/markers/u)
  })

  it('refuses markers in the wrong order', () => {
    const inverted = `${FREE_MODEL_TABLE_END}\nbody\n${FREE_MODEL_TABLE_BEGIN}\n`

    expect(() => replaceFreeModelRegion(inverted, renderFreeModelRegion(SECTION, 'en', '\n'))).toThrow(/markers/u)
  })
})
