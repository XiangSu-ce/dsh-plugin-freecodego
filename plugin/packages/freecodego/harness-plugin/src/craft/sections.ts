/**
 * OpenDesign's craft layer, as this package reads it.
 *
 * What the layer is
 * -----------------
 * Eleven short rulebooks about universal craft — typography, colour, motion,
 * accessibility, form validation, the laws of UX, RTL, state coverage — written
 * to hold *on top of* a design system rather than to describe one. Upstream's
 * own numbers make the distinction plain: the catalog it ships beside these files
 * is 40 MB of brand packages, while this layer is 104 KB and is referenced by 22
 * of its 163 Skills, 151 of its 152 design-system manifests, and a dozen of its
 * templates. The content is prose an agent reads before writing UI; that is why
 * the row on the design page registers one tool and mounts nothing.
 *
 * The three fields, and what each one means here
 * ----------------------------------------------
 * Upstream composes this layer from two declarations plus one subtraction:
 * a Skill's `requires` and a design system's `applies` are force-loaded, and a
 * design system's `exemptions` are removed from whatever the first two asked
 * for — a universal rule a brand deliberately breaks, written down rather than
 * left to be rediscovered. Upstream's `suggested` field is catalog metadata: it
 * is what a design-system picker *offers*. This package has no picker, and the
 * model choosing sections is the equivalent gesture, so {@link
 * resolveCraftRequirements} answers with it as `advisory` — sections a caller may
 * read, that nothing forces.
 *
 * Two deviations from upstream's loader, both deliberate
 * ------------------------------------------------------
 * 1. **An unknown slug is answered, not dropped.** Upstream's runtime skips a
 *    section it cannot find so an old bundle keeps working, and its repository
 *    lint fails on the same slug. This package has no authoring step to lint, so
 *    the check lives here: a miss returns why it missed, and a slug registered in
 *    `FUTURE_SECTIONS.md` is reported as *planned* rather than as a typo — the
 *    distinction that file exists to preserve.
 * 2. **The catalogue is answered from the tree.** Titles, sizes and the forward
 *    references are read from the vendored files rather than transcribed beside
 *    them, so a section added to `assets/design/craft/` appears without an edit
 *    here and a card quoting a stale count fails its test.
 *
 * @module craft/sections
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { tokensFromChars } from '../token-estimate.ts'

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the vendored craft directory from either the source tree or a built package.
 *
 * The finite candidate list is the same shape `uiux/data-store.ts` uses, and for
 * the same reason: the module runs from `src/craft/` under ts-node, from a built
 * tree beside the assets, or from the bundle's `dist/`, and the assets are
 * package files rather than generated modules. A path that exists nowhere stays
 * missing instead of being searched for in the user's workspace.
 *
 * @returns the first candidate that exists, or the source-tree spelling when none does.
 */
function resolveCraftDirectory(): string {
  const candidates = [
    resolve(MODULE_DIRECTORY, 'assets', 'design', 'craft'),
    resolve(MODULE_DIRECTORY, '..', '..', 'assets', 'design', 'craft'),
    resolve(MODULE_DIRECTORY, '..', 'assets', 'design', 'craft'),
    resolve(MODULE_DIRECTORY, '..', '..', '..', 'assets', 'design', 'craft'),
    resolve(MODULE_DIRECTORY, '..', '..', '..', '..', 'assets', 'design', 'craft'),
  ]
  return candidates.find(path => existsSync(path))
    ?? candidates[0]
    ?? resolve(MODULE_DIRECTORY, 'assets', 'design', 'craft')
}

/** The resolved craft root; tests point a reader at a fixture instead. */
export const CRAFT_DIRECTORY = resolveCraftDirectory()

/** The slug shape upstream's loader joins to `<slug>.md`. */
export const CRAFT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/**
 * The most sections one call returns.
 *
 * A cap rather than a sum: the eleven sections are 104 KB together — about
 * 25,800 tokens — and a tool that would return all of them invites one call that
 * spends a session's budget on rules the caller has not read yet. Per-section
 * sizes are in the catalogue, so the choice of which four stays with the caller.
 */
export const CRAFT_SECTIONS_PER_CALL = 4

/** The files that describe the layer rather than being part of it. */
const COMPANION_FILES: readonly string[] = ['README.md', 'FUTURE_SECTIONS.md']

/** The register of slugs upstream references before they ship. */
const FORWARD_REFERENCE_FILE = 'FUTURE_SECTIONS.md'

/** One section, as much as a caller needs to choose it. */
export interface CraftSection {
  /** The slug, which is the file name without its extension. */
  readonly slug: string
  /** The section's level-1 heading, read from the file. */
  readonly title: string
  readonly bytes: number
  /** The same body priced at the host's density, so the cost is visible before it is paid. */
  readonly tokens: number
}

/** What the layer holds at this snapshot. */
export interface CraftCatalogue {
  readonly sections: readonly CraftSection[]
  /** Slugs upstream references but has not shipped, from its own register. */
  readonly forwardReferences: readonly string[]
  /** Every section's byte total, for the card and for a caller pricing the whole layer. */
  readonly bytes: number
  /** The same total in tokens. */
  readonly tokens: number
}

/** A section's body, or the reason there is none. */
export type CraftSectionLookup =
  | { readonly kind: 'found'; readonly section: CraftSection; readonly text: string }
  | { readonly kind: 'planned' }
  | { readonly kind: 'unknown' }

/**
 * What a caller asks this layer to compose.
 *
 * Each field admits an explicit `undefined` because the caller is usually a tool
 * argument object, where "the caller did not name this list" is a value it holds
 * rather than a property it omits — and `exactOptionalPropertyTypes` is on in this
 * package, which makes those two different types.
 */
export interface CraftRequirementInput {
  /** What the task or Skill demands. */
  readonly requires?: readonly string[] | undefined
  /** What the active design system forces. */
  readonly applies?: readonly string[] | undefined
  /** What the active design system offers without forcing. */
  readonly suggested?: readonly string[] | undefined
  /** What the active design system exempts itself from. */
  readonly exemptions?: readonly string[] | undefined
}

/** Why a slug a caller named produces no section. */
export type CraftMissReason = 'planned' | 'unshipped' | 'malformed'

/** The composed answer: what loads, what is offered, what is removed, what missed. */
export interface CraftRequirementPlan {
  /** Sections to read, in the order the caller asked for them. */
  readonly load: readonly string[]
  /** Sections offered but not forced, minus anything already loading or exempted. */
  readonly advisory: readonly string[]
  /** Requested sections removed by an exemption. */
  readonly exempted: readonly string[]
  /** Requested slugs with no section behind them. */
  readonly misses: readonly { readonly slug: string; readonly reason: CraftMissReason }[]
}

/** The file name one slug reads from. */
function sectionFile(slug: string): string {
  return `${slug}.md`
}

/**
 * Every vendored file, ordered by slug rather than by file name.
 *
 * The two orders are not the same list: `.` (0x2E) sorts after `-` (0x2D), so
 * ordering file names puts `typography-hierarchy.md` ahead of `typography.md`
 * while ordering slugs — which is what a caller sees and asks for — does not.
 * The catalogue, the tool and this package's spec then read one order instead of
 * three orders that happen to agree on a small tree.
 */
function craftFiles(root: string): readonly string[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter(name => name.endsWith('.md'))
    .map(name => name.replace(/\.md$/u, ''))
    .sort()
    .map(slug => sectionFile(slug))
}

/**
 * Read one section's body, by slug.
 *
 * @param slug - the section to read, exactly as the caller spelled it.
 * @param root - the craft root; defaults to the vendored directory.
 * @returns the section and its text, `planned` when upstream registers the slug
 *          without shipping it, or `unknown` when nothing accounts for it.
 */
export function readCraftSection(slug: string, root: string = CRAFT_DIRECTORY): CraftSectionLookup {
  if (!CRAFT_SLUG_PATTERN.test(slug)) return { kind: 'unknown' }
  const path = resolve(root, sectionFile(slug))
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8')
    const title = /^# (.+)$/mu.exec(text)?.[1]?.trim() ?? slug
    return {
      kind: 'found',
      // `text.length` — UTF-16 units — is how this package counts characters
      // everywhere else, and this corpus carries no astral code points: the six
      // glyphs a rule names are written as `U+...` text, so counting them as
      // surrogate pairs is not a case that arises here.
      section: { slug, title, bytes: Buffer.byteLength(text, 'utf8'), tokens: tokensFromChars(text.length) },
      text,
    }
  }
  return readForwardReferences(root).includes(slug) ? { kind: 'planned' } : { kind: 'unknown' }
}

/**
 * The slugs upstream registers as planned.
 *
 * Read from `FUTURE_SECTIONS.md` rather than from a list kept here, because the
 * file is upstream's own contract: it is what makes a missing slug a *planned*
 * section instead of a typo, and a copy of it in this module could disagree with
 * the file the vendoring pass checks.
 *
 * @param root - the craft root; defaults to the vendored directory.
 * @returns the registered slugs, in the order the file lists them.
 */
export function readForwardReferences(root: string = CRAFT_DIRECTORY): readonly string[] {
  const path = resolve(root, FORWARD_REFERENCE_FILE)
  if (!existsSync(path)) return []
  return [...readFileSync(path, 'utf8').matchAll(/^-[ \t]+([a-z0-9][a-z0-9-]*)[ \t]*$/gmu)].map(match => match[1] as string)
}

/**
 * Every shipped section, with the size and title a caller chooses on.
 *
 * @param root - the craft root; defaults to the vendored directory.
 * @returns the catalogue, or an empty one when the assets are absent — a build
 *          without them reports an empty layer rather than inventing sections.
 */
export function readCraftCatalogue(root: string = CRAFT_DIRECTORY): CraftCatalogue {
  const sections: CraftSection[] = []
  for (const file of craftFiles(root)) {
    if (COMPANION_FILES.includes(file)) continue
    const slug = file.replace(/\.md$/u, '')
    if (!CRAFT_SLUG_PATTERN.test(slug)) continue
    const lookup = readCraftSection(slug, root)
    if (lookup.kind !== 'found') continue
    sections.push(lookup.section)
  }
  const bytes = sections.reduce((total, section) => total + section.bytes, 0)
  return {
    sections,
    forwardReferences: readForwardReferences(root),
    bytes,
    tokens: sections.reduce((total, section) => total + section.tokens, 0),
  }
}

/**
 * Normalize a caller's slug list: lower case, trimmed, deduplicated, order kept.
 *
 * Deduplication is not cosmetic. A caller that lists a section twice would
 * otherwise pay for it twice, and upstream's loader drops a repeat for the same
 * reason. A slug that cannot be a file name is *kept* here so
 * {@link resolveCraftRequirements} can report it as malformed — upstream drops
 * it silently, which is the answer this module exists to not give.
 *
 * @param values - the slugs as the caller spelled them.
 * @returns the normalized list, in first-seen order.
 */
function normalizeSlugs(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    const slug = value.trim().toLowerCase()
    if (slug === '' || seen.has(slug)) continue
    seen.add(slug)
    normalized.push(slug)
  }
  return normalized
}

/**
 * Compose the sections one run would load, upstream's way.
 *
 * The order and the arithmetic are upstream's: `requires` first, then `applies`,
 * with `exemptions` removed from the union — so a caller that both requires and
 * applies a section loads it once, and a brand that exempts one gets it removed
 * even when a Skill demanded it. `suggested` is reported separately: nothing
 * forces it here, so it is offered as `advisory`.
 *
 * @param input - the four declarations.
 * @param root - the craft root; defaults to the vendored directory.
 * @returns what loads, what is offered, what was exempted, and every miss with
 *          its reason.
 */
export function resolveCraftRequirements(
  input: CraftRequirementInput,
  root: string = CRAFT_DIRECTORY,
): CraftRequirementPlan {
  const requires = normalizeSlugs(input.requires)
  const applies = normalizeSlugs(input.applies)
  const suggested = normalizeSlugs(input.suggested)
  const exemptions = new Set(normalizeSlugs(input.exemptions))
  const requested = normalizeSlugs([...requires, ...applies])

  const load: string[] = []
  const exempted: string[] = []
  const misses: { slug: string; reason: CraftMissReason }[] = []
  const classify = (slug: string): CraftMissReason => {
    if (!CRAFT_SLUG_PATTERN.test(slug)) return 'malformed'
    return readForwardReferences(root).includes(slug) ? 'planned' : 'unshipped'
  }

  for (const slug of requested) {
    if (exemptions.has(slug)) {
      exempted.push(slug)
      continue
    }
    const lookup = readCraftSection(slug, root)
    if (lookup.kind === 'found') {
      load.push(slug)
      continue
    }
    misses.push({ slug, reason: classify(slug) })
  }

  const advisory: string[] = []
  for (const slug of suggested) {
    if (exemptions.has(slug) || load.includes(slug) || advisory.includes(slug)) continue
    const lookup = readCraftSection(slug, root)
    if (lookup.kind === 'found') {
      advisory.push(slug)
      continue
    }
    if (!misses.some(miss => miss.slug === slug)) misses.push({ slug, reason: classify(slug) })
  }

  return { load, advisory, exempted, misses }
}
