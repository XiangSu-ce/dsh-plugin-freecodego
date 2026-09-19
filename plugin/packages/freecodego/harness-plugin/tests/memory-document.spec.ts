import { describe, expect, it } from 'vitest'
import {
  memoryDocumentAgeNote,
  memoryFileName,
  parseMemoryDocument,
  renderMemoryDocument,
  renderMemoryIndex,
  type MemoryDocumentRecord,
} from '../src/memory/memory-document.ts'
import { MEMORY_REDACTION_MARKER } from '../src/memory/memory-security.ts'

const ID = 'mem_abc123def4567890abcdef1234567890'

/**
 * A Stripe-shaped live key, composed rather than written out.
 *
 * GitHub's push protection refuses a push that carries the literal `sk_live_…`
 * even when the only thing it appears in is a fixture, and it reads the
 * committed bytes rather than the runtime value. The scanner under test sees
 * exactly the key it saw when this was a literal.
 */
const STRIPE_LIVE_KEY = 'sk_live_' + 'A'.repeat(24)

function record(overrides: Partial<MemoryDocumentRecord> = {}): MemoryDocumentRecord {
  return {
    id: ID,
    title: 'Fix the nginx retry loop',
    body: 'The retry loop cleared itself when the upstream socket closed; the fix is the backoff header.',
    kind: 'bugfix',
    trust: 'reviewed',
    createdAt: Date.UTC(2026, 8, 10, 8, 0, 0),
    tags: ['nginx', 'networking'],
    ...overrides,
  }
}

describe('memory document filenames', () => {
  it('derives a readable stem and keeps the id as the identity', () => {
    expect(memoryFileName('Fix the nginx retry loop!', ID)).toBe(`fix-the-nginx-retry-loop--${ID}.md`)
  })

  it('falls back to a generic stem when the title has no usable characters', () => {
    expect(memoryFileName('!!!', ID)).toBe(`memory--${ID}.md`)
  })

  it('truncates the stem and strips a trailing dash left by the cut', () => {
    const name = memoryFileName('a'.repeat(80), ID)
    expect(name.startsWith('a'.repeat(59))).toBe(true)
    expect(name).not.toContain('--a-')
    expect(name.endsWith(`--${ID}.md`)).toBe(true)
  })
})

describe('memory document rendering', () => {
  it('renders lossless frontmatter and the body', () => {
    const text = renderMemoryDocument(record())
    expect(text).toContain('---\n')
    expect(text).toContain(`id: "${ID}"`)
    expect(text).toContain('kind: "bugfix"')
    expect(text).toContain('trust: "reviewed"')
    expect(text).toContain('created: 2026-09-10T08:00:00.000Z')
    expect(text).toContain('tags: ["nginx", "networking"]')
    expect(text).toContain('The retry loop cleared itself')
  })

  it('omits optional fields when absent', () => {
    // `reviewedAt` / `sourceEngine` are absent from the base record already, so
    // the case is "no optional field was ever set" — not "set to undefined",
    // which `exactOptionalPropertyTypes` refuses and which reads differently.
    const text = renderMemoryDocument(record({ tags: [] }))
    expect(text).not.toContain('reviewed:')
    expect(text).not.toContain('engine:')
    expect(text).not.toContain('tags:')
  })

  it('renders optional fields when present', () => {
    const text = renderMemoryDocument(record({ reviewedAt: Date.UTC(2026, 8, 11), sourceEngine: 'claude' }))
    expect(text).toContain('reviewed: 2026-09-11T00:00:00.000Z')
    expect(text).toContain('engine: "claude"')
  })

  it('refuses to render a record whose id is not a memory identity', () => {
    expect(renderMemoryDocument(record({ id: 'not-an-id' }))).toBeUndefined()
  })

  it('refuses to render a record whose text still carries a credential', () => {
    expect(renderMemoryDocument(record({ body: `use ${STRIPE_LIVE_KEY} for payments` }))).toBeUndefined()
  })

  it('refuses a shape-only credential, so the export is never the plaintext step', () => {
    // `sk_live_…` above is a high-confidence rule. This is the other tier: a
    // `generic-secret-key` match, which `scanForSecrets` reports but does not
    // block. Rendering it was the failure this rule exists to prevent — the
    // document is written to a plaintext file outside the workspace.
    expect(renderMemoryDocument(record({ body: `use sk-${'aB3'.repeat(16)} here` }))).toBeUndefined()
  })

  it('refuses to render a record that was already redacted upstream', () => {
    expect(renderMemoryDocument(record({ body: `upstream says ${MEMORY_REDACTION_MARKER} here` }))).toBeUndefined()
  })
})

describe('memory document parsing', () => {
  it('round-trips a rendered document exactly', () => {
    const text = renderMemoryDocument(record({ reviewedAt: Date.UTC(2026, 8, 11), sourceEngine: 'codex' }))!
    const parsed = parseMemoryDocument(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record).toEqual(record({ reviewedAt: Date.UTC(2026, 8, 11), sourceEngine: 'codex' }))
  })

  it('strips the freshness note it appended, so a stamped export still round-trips', () => {
    // The note is transport metadata for a preview renderer. Folding it into the
    // body would grow the body on every export, so the parser removes exactly
    // what the renderer added and nothing else.
    const stamped = renderMemoryDocument(record(), Date.UTC(2026, 8, 12))!
    expect(stamped).toContain('<!-- freshness:')
    const parsed = parseMemoryDocument(stamped)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record).toEqual(record())
  })

  it('leaves a body that merely mentions freshness alone', () => {
    const body = 'Track freshness: it is a property of the record, not the export.'
    const text = renderMemoryDocument(record({ body }))!
    const parsed = parseMemoryDocument(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.body).toBe(body)
  })

  it('leaves a body that quotes the freshness comment form itself alone', () => {
    // The sibling above probes the *words*, not the form, and that is the gap the
    // unanchored pattern lived in: `<!-- freshness: … -->` anywhere in the body was
    // removed, not only the note the renderer appends at the end. So a memory that
    // records "the export appends a freshness comment", or a sample pasted out of
    // one, came back a line shorter — silently, having passed every other check,
    // which is worse than a rejection: this document is meant to be the store's
    // lossless projection.
    const body = 'Export note: each document ends with <!-- freshness: stale (9 days) --> appended by the renderer.'
    const text = renderMemoryDocument(record({ body }))!
    const parsed = parseMemoryDocument(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.body).toBe(body)
  })

  it('reads a body back byte-for-byte whatever trailing newlines it has', () => {
    // The freshness note is transport metadata, so a body has to read back the same
    // whether a note was appended or not. The note pattern's leading `\n*` ate the
    // body's *own* trailing newlines, so `"plain\n"` came back as `"plain"` on the
    // stamped path and as `"plain\n"` on the unstamped one: the same record, two
    // answers, and the module header says this field round-trips exactly.
    for (const body of ['plain', 'plain\n', 'plain\n\n', 'plain\n\n\n', 'a\nb']) {
      const plain = parseMemoryDocument(renderMemoryDocument(record({ body }))!)
      expect(plain.ok, `unstamped ${JSON.stringify(body)}`).toBe(true)
      if (!plain.ok) continue
      expect(plain.record.body, `unstamped ${JSON.stringify(body)}`).toBe(body)

      const stamped = parseMemoryDocument(renderMemoryDocument(record({ body }), Date.UTC(2026, 8, 12))!)
      expect(stamped.ok, `stamped ${JSON.stringify(body)}`).toBe(true)
      if (!stamped.ok) continue
      expect(stamped.record.body, `stamped ${JSON.stringify(body)}`).toBe(body)
    }
  })

  it('still strips its own trailing note when the body also quotes the form', () => {
    // Both halves at once: the anchored rule has to remove the note the renderer
    // added *and* leave the identical form inside the body untouched. An
    // unanchored pattern could satisfy either alone but not both.
    const body = 'Export note: each document ends with <!-- freshness: stale (9 days) --> appended by the renderer.'
    const stamped = renderMemoryDocument(record({ body }), Date.UTC(2026, 8, 12))!
    expect(stamped).toContain('<!-- freshness:')
    const parsed = parseMemoryDocument(stamped)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.body).toBe(body)
  })

  it('round-trips CRLF input to the same record', () => {
    const text = renderMemoryDocument(record())!.replaceAll('\n', '\r\n')
    const parsed = parseMemoryDocument(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.id).toBe(ID)
    expect(parsed.record.body).toBe(record().body)
  })

  it('accepts an unknown kind and trust verbatim', () => {
    const text = renderMemoryDocument(record({ kind: 'quantum', trust: 'attested' }))!
    const parsed = parseMemoryDocument(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.kind).toBe('quantum')
    expect(parsed.record.trust).toBe('attested')
  })

  it('collects every problem in one pass', () => {
    const parsed = parseMemoryDocument('---\nid: bad\ntitle: ""\nkind: ""\ntrust: ""\ncreated: nope\ntags: ["ok", 5]\n---\nbody\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    const fields = parsed.errors.map(error => error.field)
    expect(fields).toContain('id')
    expect(fields).toContain('title')
    expect(fields).toContain('kind')
    expect(fields).toContain('trust')
    expect(fields).toContain('created')
    expect(fields).toContain('tags')
  })

  it('transports tags and an engine attribution verbatim instead of re-classifying them', () => {
    // `MemoryDocumentRecord.tags` documents these as free text and the store owns
    // the narrower vocabulary it accepts, so a reader that refused the other shapes
    // made rows written before that vocabulary was shared unexportable — and it
    // refused them on documents this module had rendered itself.
    const shapes: readonly (readonly string[])[] = [[], ['retry'], ['中文标签'], ['Has Upper'], ['ns:thing'], ['a,b'], [''], ['x'.repeat(64)], ['tab\there']]
    for (const tags of shapes) {
      const tagsValue = tags
      const text = renderMemoryDocument(record({ tags: tagsValue, sourceEngine: '' }))
      expect(text, `tags=${JSON.stringify(tagsValue)}`).toBeDefined()
      const parsed = parseMemoryDocument(text ?? '')
      expect(parsed.ok, `tags=${JSON.stringify(tagsValue)}`).toBe(true)
      if (parsed.ok) expect(parsed.record).toEqual(record({ tags: tagsValue, sourceEngine: '' }))
    }
  })

  it('rejects a document with no frontmatter and one that never closes', () => {
    expect(parseMemoryDocument('just text')).toEqual({
      ok: false,
      errors: [{ field: 'document', reason: 'the document does not start with a frontmatter block' }],
    })
    const unclosed = parseMemoryDocument('---\nid: "x"\n')
    expect(unclosed.ok).toBe(false)
    if (!unclosed.ok) expect(unclosed.errors[0]?.field).toBe('document')
  })

  it('reports a frontmatter line without a key', () => {
    const parsed = parseMemoryDocument('---\njusttext\n---\nbody\n')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]?.field).toBe('frontmatter line 1')
  })

  it('transports an empty engine attribution and reports only the malformed stamp', () => {
    const parsed = parseMemoryDocument('---\n'
      + `id: "${ID}"\n`
      + 'title: "t"\n'
      + 'kind: "note"\n'
      + 'trust: "draft"\n'
      + 'created: 2026-09-10T08:00:00.000Z\n'
      + 'reviewed: nope\n'
      + 'engine: ""\n'
      + '---\nbody\n')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      const fields = parsed.errors.map(error => error.field)
      expect(fields).toContain('reviewed')
      // An empty attribution is a value the record held: transported, not refused.
      expect(fields).not.toContain('engine')
    }
  })

  it('tolerates blank frontmatter lines and a missing trailing newline in the body', () => {
    const text = renderMemoryDocument(record())!.replace('---\n', '---\n\n')
    const parsed = parseMemoryDocument(text.replace(/\n$/u, ''))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.body).toBe(record().body)
  })

  it('parses a document with no tags key at all', () => {
    const text = '---\n'
      + `id: "${ID}"\n`
      + 'title: "t"\n'
      + 'kind: "note"\n'
      + 'trust: "draft"\n'
      + 'created: 2026-09-10T08:00:00.000Z\n'
      + '---\nbody\n'
    const parsed = parseMemoryDocument(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.tags).toEqual([])
  })

  it('reports unquoted and malformed tags lists', () => {
    const head = `id: "${ID}"\ntitle: "t"\nkind: "note"\ntrust: "draft"\ncreated: 2026-09-10T08:00:00.000Z\n`
    const malformed = parseMemoryDocument(`---\n${head}tags: ["good", broken]\n---\nbody\n`)
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.errors[0]?.field).toBe('tags')
    const brokenJson = parseMemoryDocument(`---\n${head}tags: ["unterminated\n---\nbody\n`)
    expect(brokenJson.ok).toBe(false)
    if (!brokenJson.ok) expect(brokenJson.errors[0]?.field).toBe('tags')
  })

  it('accepts a tags value written without brackets', () => {
    const head = `id: "${ID}"\ntitle: "t"\nkind: "note"\ntrust: "draft"\ncreated: 2026-09-10T08:00:00.000Z\n`
    const parsed = parseMemoryDocument(`---\n${head}tags: "one", "two"\n---\nbody\n`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.tags).toEqual(['one', 'two'])
  })

  it('accepts an explicitly empty tags list', () => {
    const head = `id: "${ID}"\ntitle: "t"\nkind: "note"\ntrust: "draft"\ncreated: 2026-09-10T08:00:00.000Z\n`
    const parsed = parseMemoryDocument(`---\n${head}tags: []\n---\nbody\n`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.record.tags).toEqual([])
  })

  it('reports a quoted field whose value is not valid JSON', () => {
    // A hand-edited title that opens a quote but never closes it: the value
    // starts with a quote, so the JSON path runs, and the parse must refuse it
    // instead of silently keeping the raw text.
    const parsed = parseMemoryDocument('---\n'
      + `id: "${ID}"\n`
      + 'title: "unterminated\n'
      + 'kind: "note"\n'
      + 'trust: "draft"\n'
      + 'created: 2026-09-10T08:00:00.000Z\n'
      + '---\nbody\n')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.some(error => error.field === 'title')).toBe(true)
  })
})

describe('memory document helpers', () => {
  it('annotates freshness in an HTML comment', () => {
    const created = Date.UTC(2026, 8, 10)
    const note = memoryDocumentAgeNote(record({ createdAt: created }), Date.UTC(2026, 8, 12))
    expect(note).toContain('freshness: recent')
    expect(note).toContain('verify before relying on it')
  })

  it('says fresh when the record needs no caveat', () => {
    const now = Date.UTC(2026, 8, 10, 12)
    const note = memoryDocumentAgeNote(record({ createdAt: now }), now)
    expect(note).toBe('<!-- freshness: fresh (just now) -->')
  })

  // The redaction marker has one predicate, `containsMemoryRedaction` in
  // `memory-security.ts`, and it is covered by its own suite. A second copy here
  // tested a wrapper that no caller used.

  it('renders an index table sorted oldest first and escapes pipes', () => {
    const now = Date.UTC(2026, 8, 12)
    const text = renderMemoryIndex([
      record({ id: 'mem_bbbbbb00000000000000000000000000', title: 'newer | tricky', createdAt: Date.UTC(2026, 8, 11) }),
      record({ id: 'mem_aaaaaa00000000000000000000000000', title: 'older', createdAt: Date.UTC(2026, 8, 10) }),
    ], now)
    expect(text).toContain('generated: 2026-09-12T00:00:00.000Z')
    // The escaped title is what the table actually holds, so ordering is
    // asserted against the escaped form rather than the raw title.
    expect(text.indexOf('older')).toBeLessThan(text.indexOf('newer \\| tricky'))
    expect(text).not.toContain('newer | tricky')
    expect(text).toContain('mem_aaaaaa00000000000000000000000000')
  })
})
