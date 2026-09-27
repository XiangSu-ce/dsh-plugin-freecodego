/**
 * The vendored craft layer, checked as the tree and as the contract it carries.
 *
 * Three questions this file exists to answer, and none of them is answered by the
 * vendoring pass about itself:
 *
 * 1. **Is the tree still the tree the provenance describes.** Same shape as the
 *    Taste pack's spec and for the same reason: these files are third-party prose
 *    shipped at upstream length — the one adaptation is recorded — so a digest is
 *    the only thing standing between a well-meaning edit and a file that no longer
 *    matches what the notice attributes.
 * 2. **Does the contract the module implements match the one upstream wrote.**
 *    `FUTURE_SECTIONS.md` is upstream's forward-reference register, and the
 *    distinction it preserves — a slug that is *planned* versus a slug that is a
 *    typo — is the difference between a caller reading the wrong rule and being
 *    told there is none. The register is checked against the tree in both
 *    directions here, which is what the vendoring pass refuses to write over.
 * 3. **Are the numbers on the card the numbers on disk.** The card is what a user
 *    decides on, and it quotes a section count and a size range; the pair check is
 *    the same one the Impeccable and Taste rows already carry.
 *
 * The last group drives the tool itself — the three actions, the refusals, and the
 * cap on how many bodies one call returns.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CRAFT_TOOL_NAME, craftToolDefinition } from '../src/craft/tool.ts'
import {
  CRAFT_DIRECTORY,
  CRAFT_SECTIONS_PER_CALL,
  readCraftCatalogue,
  readCraftSection,
  readForwardReferences,
  resolveCraftRequirements,
} from '../src/craft/sections.ts'
import { CRAFT_FEATURE } from '../src/design/features.ts'
import { pluginTool } from '../src/tool-manifest.ts'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(PACKAGE_ROOT, 'assets', 'design', 'craft')

/** The companions: prose about the layer rather than sections of it. */
const COMPANIONS = ['README.md', 'FUTURE_SECTIONS.md', 'PROVENANCE.md', 'LICENSE']

/** `\p{Emoji_Presentation}` plus the variation selector, as `engineering.spec.ts` reads it. */
const EMOJI = /[\p{Emoji_Presentation}\uFE0F]/gu

/** The section slugs on disk, in directory order. */
function shippedSlugs(): readonly string[] {
  return readdirSync(ROOT)
    .filter(name => name.endsWith('.md') && !COMPANIONS.includes(name))
    .map(name => name.replace(/\.md$/u, ''))
    .sort()
}

/** Every file under the vendored root, in directory order. */
function shippedFiles(): readonly string[] {
  return readdirSync(ROOT).filter(name => name.endsWith('.md') && !COMPANIONS.includes(name)).sort()
}

const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

/** One call to the shipped tool definition, with the definition built on demand. */
async function craft(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const definition = craftToolDefinition()
  const execute = definition.execute as (input: unknown) => unknown
  return await execute(args) as Record<string, unknown>
}

describe('the vendored craft layer', () => {
  it('ships eleven sections the catalogue can name, and the card states that count', () => {
    const catalogue = readCraftCatalogue()
    expect(catalogue.sections.map(section => section.slug)).toEqual(shippedSlugs())
    expect(catalogue.sections).toHaveLength(11)
    for (const section of catalogue.sections) {
      // A section with no title is one a caller cannot tell from its neighbours, and
      // the vendoring pass refuses to write one — this is the check on what landed.
      expect(section.title.length, section.slug).toBeGreaterThan(0)
      expect(section.title, section.slug).not.toBe(section.slug)
      expect(section.bytes, section.slug).toBeGreaterThan(0)
      expect(section.tokens, section.slug).toBeGreaterThan(0)
    }
    expect(catalogue.bytes).toBe(catalogue.sections.reduce((total, section) => total + section.bytes, 0))
    // The card's number is read off the tree rather than typed beside it, the same
    // pair check the Taste and Impeccable rows carry.
    expect(CRAFT_FEATURE.summary).toContain(`${String(catalogue.sections.length)} 篇`)
  })

  it('ships no emoji, and names the six glyphs one rule is about instead', () => {
    // The rule that forbids emoji as feature icons has to be able to write them
    // down, so those six ship as code points. Any other emoji-presentation glyph in
    // the tree would be a substitution the pass has no word for — which it refuses
    // to make at all — so the sweep is what proves the rule held.
    const offences: string[] = []
    for (const file of readdirSync(ROOT)) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      for (const match of text.matchAll(EMOJI)) offences.push(`${file}: ${match[0]}`)
    }
    expect(offences).toEqual([])
    const slop = readFileSync(join(ROOT, 'anti-ai-slop.md'), 'utf8')
    for (const name of ['U+2728 SPARKLES', 'U+1F680 ROCKET', 'U+1F3AF DIRECT HIT', 'U+26A1 HIGH VOLTAGE', 'U+1F525 FIRE', 'U+1F4A1 LIGHT BULB']) {
      expect(slop, name).toContain(`\`${name}\``)
    }
  })

  it('keeps the forward-reference register and the tree in agreement, in both directions', () => {
    // This is upstream's `lint:craft` rule, and it is what makes the tool able to
    // tell a *planned* slug from a typo. A registered slug that has shipped would
    // have the tool telling a caller a section is unavailable while it sits on disk;
    // a shipped slug that is also registered would be the same lie the other way.
    const forward = readForwardReferences()
    expect(forward).toEqual(['motion-discipline', 'pixel-discipline', 'typographic-rhythm'])
    const shipped = shippedSlugs()
    for (const slug of forward) {
      expect(readCraftSection(slug).kind, `${slug} is registered but answered as a section`).toBe('planned')
      expect(shipped.includes(slug), `${slug} is registered and ships`).toBe(false)
    }
    // Read through the module and not through a copy: the loader that answers a
    // caller is the one whose register this asserts.
    expect(CRAFT_DIRECTORY.replace(/\\/gu, '/')).toContain('assets/design/craft')
  })

  it('matches every digest in PROVENANCE.md, so an edit to a vendored section is caught', () => {
    const provenance = readFileSync(join(ROOT, 'PROVENANCE.md'), 'utf8')
    const rows = [...provenance.matchAll(/^\| `([^`]+)` \| (\d+) \| `([0-9a-f]{64})` \|$/gmu)]
      .map(match => ({ file: match[1] as string, bytes: Number(match[2]), sha256: match[3] as string }))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map(row => row.file).sort()).toEqual([...shippedFiles(), 'FUTURE_SECTIONS.md', 'README.md'].sort())
    for (const row of rows) {
      const text = readFileSync(join(ROOT, row.file), 'utf8')
      expect(Buffer.byteLength(text, 'utf8'), row.file).toBe(row.bytes)
      expect(sha256(text), row.file).toBe(row.sha256)
    }
    // The licence travels with the text it covers, and it is upstream's own file
    // rather than a restatement of it.
    expect(readFileSync(join(ROOT, 'LICENSE'), 'utf8')).toContain('Apache License')
    expect(provenance).toContain('Apache-2.0')
    expect(provenance).toContain('refero_skill')
  })

  it('reads a section byte-for-byte, and answers a typo differently from a planned slug', () => {
    const lookup = readCraftSection('typography')
    expect(lookup.kind).toBe('found')
    if (lookup.kind !== 'found') throw new Error('unreachable')
    expect(lookup.text).toBe(readFileSync(join(ROOT, 'typography.md'), 'utf8'))
    expect(lookup.section.title).toBe('Typography craft rules')
    // The three answers a caller can get are distinct facts, and the tool's refusal
    // message is only honest if the module keeps them apart.
    expect(readCraftSection('typo-graphy').kind).toBe('unknown')
    expect(readCraftSection('motion-discipline').kind).toBe('planned')
    expect(readCraftSection('Not A Slug').kind).toBe('unknown')
  })

  it('composes requires plus applies minus exemptions, and reports every miss', () => {
    const plan = resolveCraftRequirements({
      requires: ['color', 'typography', 'color'],
      applies: ['typography', 'laws-of-ux'],
      suggested: ['state-coverage', 'color', 'typography'],
      exemptions: ['color'],
    })
    // Upstream's order and arithmetic: requires first, then applies, one entry per
    // section however many times it was asked for, exemptions subtracted from the
    // union — but still *reported*, because a rule removed on purpose is a decision
    // a reader should be able to see.
    expect(plan.load).toEqual(['typography', 'laws-of-ux'])
    expect(plan.exempted).toEqual(['color'])
    expect(plan.advisory).toEqual(['state-coverage'])
    expect(plan.misses).toEqual([])

    const missed = resolveCraftRequirements({ requires: ['motion-discipline', 'no-such-rule', 'Bad Slug'] })
    expect(missed.load).toEqual([])
    expect(missed.misses).toEqual([
      { slug: 'motion-discipline', reason: 'planned' },
      { slug: 'no-such-rule', reason: 'unshipped' },
      { slug: 'bad slug', reason: 'malformed' },
    ])
  })
})

describe('the craft tool', () => {
  it('answers a catalogue a caller can choose from, with every section priced', async () => {
    const answer = await craft({ action: 'list' })
    expect(answer.kind).toBe('catalogue')
    const sections = answer.sections as readonly { slug: string; bytes: number; tokens: number }[]
    expect(sections.map(section => section.slug)).toEqual(shippedSlugs())
    for (const section of sections) {
      // Priced, not just named: the whole point of the catalogue is that the caller
      // decides what to spend before spending it.
      expect(section.bytes).toBeGreaterThan(0)
      expect(section.tokens).toBeGreaterThan(0)
    }
    expect(answer.forwardReferences).toEqual(['motion-discipline', 'pixel-discipline', 'typographic-rhythm'])
    expect(String(answer.note)).toContain(String(CRAFT_SECTIONS_PER_CALL))
  })

  it('returns the bodies it was asked for, up to the cap, and refuses a partial answer by name', async () => {
    const answer = await craft({ action: 'get', sections: ['color', 'typography'] })
    expect(answer.kind).toBe('sections')
    const sections = answer.sections as readonly { slug: string; text: string }[]
    expect(sections.map(section => section.slug)).toEqual(['color', 'typography'])
    expect(sections[0]?.text).toBe(readFileSync(join(ROOT, 'color.md'), 'utf8'))

    // A slug that resolves to nothing refuses the call rather than returning the
    // half it found: the caller asked for a rule by name, and a partial answer with
    // no complaint is how it concludes the rule is in force.
    const typo = await craft({ action: 'get', sections: ['color', 'typo-graphy'] })
    expect(typo.kind).toBe('refused')
    expect(typo.reason).toBe('unknown-section')
    expect(typo.unknown).toEqual(['typo-graphy'])
    expect(typo.available).toContain('color')
    expect(typo).not.toHaveProperty('sections')

    const tooMany = await craft({ action: 'get', sections: shippedSlugs().slice(0, CRAFT_SECTIONS_PER_CALL + 1) })
    expect(tooMany.kind).toBe('refused')
    expect(tooMany.reason).toBe('too-many-sections')

    const empty = await craft({ action: 'get', sections: [] })
    expect(empty.kind).toBe('refused')
    expect(empty.reason).toBe('empty-sections')
  })

  it('reports a registered-but-unshipped slug as pending rather than as a typo', async () => {
    // The distinction the register exists for: asking for a section upstream has
    // planned is not a mistake, and answering it as one would send a caller looking
    // for a spelling error instead of for the section that does exist.
    const answer = await craft({ action: 'get', sections: ['typography', 'motion-discipline'] })
    expect(answer.kind).toBe('sections')
    expect((answer.sections as readonly unknown[]).map((entry) => (entry as { slug: string }).slug)).toEqual(['typography'])
    expect(answer.pending).toEqual([
      { slug: 'motion-discipline', note: expect.stringContaining('forward reference') as unknown as string },
    ])
  })

  it('answers what a composition would load, with each section priced', async () => {
    const answer = await craft({
      action: 'resolve',
      requires: ['typography'],
      applies: ['laws-of-ux'],
      suggested: ['state-coverage'],
      exemptions: ['laws-of-ux'],
    })
    expect(answer.kind).toBe('plan')
    expect((answer.load as readonly { slug: string }[]).map(section => section.slug)).toEqual(['typography'])
    expect((answer.load as readonly { tokens: number }[])[0]?.tokens).toBeGreaterThan(0)
    expect(answer.exempted).toEqual(['laws-of-ux'])
    expect((answer.advisory as readonly { slug: string }[]).map(section => section.slug)).toEqual(['state-coverage'])
    expect(answer.misses).toEqual([])
  })

  it('refuses a malformed slug and an unknown action while naming what exists', async () => {
    const malformed = await craft({ action: 'get', sections: ['Not A Slug'] })
    expect(malformed.kind).toBe('refused')
    expect(malformed.reason).toBe('malformed-slug')
    expect(malformed.available).toContain('anti-ai-slop')

    const action = await craft({ action: 'summarise' })
    expect(action.kind).toBe('refused')
    expect(action.reason).toBe('unknown-action')

    const nothing = await craft({})
    expect(nothing.kind).toBe('refused')
    expect(nothing.reason).toBe('unknown-action')
  })

  it('is declared read-only, and is the name the row and the manifest agree on', () => {
    // Three statements about one tool, none of which reads the others: the card lists
    // what switching the row on adds, the manifest says what holding the name needs,
    // and the module exports the name both are spelled with.
    expect(CRAFT_FEATURE.tools).toEqual([CRAFT_TOOL_NAME])
    expect(CRAFT_FEATURE.skillRoot).toBeUndefined()
    expect(pluginTool(CRAFT_TOOL_NAME)?.capability).toBe('read')
    expect(pluginTool(CRAFT_TOOL_NAME)?.planMode).toBe('allow')
    // Nothing here can reach the network or the workspace, and the description is
    // where the model reads that rather than inferring it from an empty result.
    const description = craftToolDefinition().description
    expect(description).toContain('Read-only')
    expect(description).toContain('no network')
  })
})
