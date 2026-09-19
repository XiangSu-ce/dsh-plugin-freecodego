/**
 * A `#ref` the user wrote means what it says.
 *
 * The module's lexical table names `owner/repo#v1.2.0` as the way to pin a
 * repository, and its refusal for `pkg#` ("a `#` with no ref after it") shows the
 * parser knows what a `#` is. What it did with a ref it *could* read was worse than
 * refusing: `pkg#v1.2.3` resolved as npm `pkg`, so the pin vanished — the user
 * asked for one repository's tag and got npm's latest of the same name — and the
 * result was field-for-field equal to the result for `pkg`, which is what "a ref
 * difference makes two sources different" exists to prevent (the lockfile and the
 * collision check both compare that result). The same input with an empty ref was
 * refused, so the two spellings of one mistake got different answers.
 *
 * These cases pin the rule: a `#` selects the repository reading, a bare name is
 * still npm, and an unfinished pin stays refused.
 */

import { describe, expect, it } from 'vitest'
import { formatSkillSource, parseSkillSource, sameSkillSource } from '../src/skills/source.ts'

describe('parseSkillSource and the `#ref` a user typed', () => {
  it('never resolves a pinned repository as the bare name it was pinned from', () => {
    const bare = parseSkillSource('pkg')
    const pinned = parseSkillSource('pkg#v1.2.3')
    expect(bare.ok).toBe(true)
    // Before this rule both parsed to `{ kind: 'npm', name: 'pkg' }`, equal under
    // `sameSkillSource` — so nothing downstream could tell the pinned request from
    // the unpinned one, and the pin was installed as the latest package.
    expect(pinned.ok).not.toBe(bare.ok)
    if (bare.ok && pinned.ok) expect(sameSkillSource(pinned.source, bare.source)).toBe(false)
  })

  it('refuses a one-word name with a ref, because that name is not an owner/repo', () => {
    const parsed = parseSkillSource('pkg#v1.2.3')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issue.reason).toContain('owner/repo')
  })

  it('answers the empty ref and the unreadable one the same way: refused', () => {
    // One mistake, one answer. `pkg#` was refused while `pkg#v1.2.3` was silently
    // rewritten, which is the inconsistency this rule removes.
    expect(parseSkillSource('pkg#').ok).toBe(false)
    expect(parseSkillSource('pkg#v1.2.3').ok).toBe(false)
  })

  it('does not let a scoped package name swallow a ref either', () => {
    // `@acme/skills` is a legal npm name, so the npm reading swallowed the ref here
    // too. A `#` is a repository spelling; `@acme/skills` is not an owner/repo, so
    // the answer is a refusal rather than a different package.
    expect(parseSkillSource('@acme/skills#v1').ok).toBe(false)
  })

  it('keeps the readings that were already right', () => {
    // The control, in one place: a bare package, a bare scoped package, a pinned
    // package, a repository with a ref, and a subpath. A rule that fixes the pin
    // by breaking any of these is not a fix.
    expect(parseSkillSource('pkg')).toMatchObject({ ok: true, canonical: 'npm:pkg' })
    expect(parseSkillSource('@acme/skills')).toMatchObject({ ok: true, canonical: 'npm:@acme/skills' })
    expect(parseSkillSource('pkg@1.2.3')).toMatchObject({ ok: true, canonical: 'npm:pkg@1.2.3' })
    expect(parseSkillSource('acme/skills#v1')).toMatchObject({ ok: true, canonical: 'github:acme/skills#v1' })
    // The canonical spelling normalizes the subpath's leading separator, which is
    // what makes it re-readable: `path:/skills/foo` and `path:skills/foo` are the
    // same directory and only one of them is the parser's own output.
    expect(parseSkillSource('acme/skills#main&path:/skills/foo')).toMatchObject({
      ok: true,
      canonical: 'github:acme/skills#main&path:skills/foo',
    })
  })

  it('round-trips every canonical spelling it can produce', () => {
    // A canonical form that cannot be re-read is not canonical. Every value below
    // is produced by the parser itself, so each one has to parse back to itself.
    for (const input of ['pkg', '@acme/skills', 'pkg@1.2.3', 'acme/skills', 'acme/skills#v1', 'github:acme/skills#v1&path:/skills']) {
      const parsed = parseSkillSource(input)
      expect(parsed.ok, input).toBe(true)
      if (!parsed.ok) continue
      expect(formatSkillSource(parsed.source), `${input} canonical`).toBe(parsed.canonical)
      expect(parseSkillSource(parsed.canonical), `${parsed.canonical} must re-read`).toMatchObject({ ok: true, canonical: parsed.canonical })
    }
  })
})
