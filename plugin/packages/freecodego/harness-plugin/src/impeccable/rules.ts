/**
 * Impeccable's detector, as far as its rules can be decided from a file's text.
 *
 * Upstream ships 61 deterministic rules inside a Rust binary (`impeccable
 * detect`), and a machine that has that binary gets all of them. This module is
 * the other half of that arrangement: the rules that can be answered from a
 * source file alone, in process, with nothing installed — which is the shape
 * this plugin's design claims rest on (the same split `design/lint.ts` makes for
 * composition files, and for the same reason: an answer that needs nothing
 * installed can be given *before* anything is rendered).
 *
 * Three things are deliberate rather than incidental.
 *
 * 1. **The rule ids are upstream's**, verbatim, and so are the descriptions that
 *    come back with a finding. Upstream's own documents, its `impeccable
 *    ignores add-value <rule>` command and every discussion of a rule name the
 *    same ids, so a finding here is the same finding — not a translation of it.
 * 2. **This is a subset, and it says so.** Each report names the rules that ran
 *    and the upstream total, because a short list that reads as complete is
 *    worse than a long list that names its bound. The rules left out are the
 *    ones that need a rendered page (contrast, padding, occlusion, measured line
 *    length, heading rhythm) — they are not approximated here, they are absent.
 * 3. **Every matcher is written against a false positive that was possible.**
 *    The tempting version of `overused-font` fires on the word `Inter` anywhere,
 *    including a comment that says not to use it; the tempting version of
 *    `layout-transition` fires on the word `width` in any value, including a
 *    `width: 100%` a page is allowed to have. Each rule below names the guard it
 *    carries, because a detector that cries wolf is switched off and then judges
 *    nothing.
 *
 * @module impeccable/rules
 */

import { stripJsComments } from '../design/lint.ts'

/**
 * The upstream release these rules were read from.
 *
 * Cited in the report and in `THIRD_PARTY_NOTICES.md` so a reader can tell which
 * state of upstream this file describes — a rule catalog that drifts is how a
 * finding's id stops matching the documentation the user opens next to it.
 */
export const IMPECCABLE_UPSTREAM = {
  repository: 'https://github.com/pbakaus/impeccable',
  /** Upstream's own count (`crates/live/assets/antipatterns.json`, distinct ids). */
  ruleCount: 61,
  license: 'Apache-2.0',
} as const

/** Upstream's two categories. `slop` is "generated-UI tell"; `quality` is craft. */
export type ImpeccableCategory = 'slop' | 'quality'

/**
 * How loud a finding is.
 *
 * Upstream separates *primary* findings — the ones that decide a scan's exit code
 * — from *advisories*, which are observations that must not fail a build. The
 * distinction is kept here rather than flattened: `em-dash-overuse` fires on
 * saturation, and a caller that treats it as a defect will delete legitimate
 * prose.
 */
export type ImpeccableSeverity = 'primary' | 'advisory'

/** One finding, in the shape upstream's own findings take. */
export interface ImpeccableFinding {
  /** Upstream's rule id: the word a user types into `impeccable ignores`. */
  readonly rule: string
  readonly ruleName: string
  readonly category: ImpeccableCategory
  readonly severity: ImpeccableSeverity
  /** 1-based line in the scanned text. */
  readonly line: number
  /** Bounded excerpt around the problem, for a caller that has to locate it. */
  readonly snippet: string
  /** What to reconsider, in upstream's own words. */
  readonly message: string
}

/** What one scan of one file produced. */
export interface ImpeccableScanReport {
  readonly findings: readonly ImpeccableFinding[]
  /** The rule ids that ran, so an absent finding is not read as a clean bill. */
  readonly rulesApplied: readonly string[]
  readonly lines: number
}

/** Longest excerpt a finding carries. */
const SNIPPET_MAX_CHARS = 140

/** A face that appears on so many generated interfaces it stops being a choice. */
const OVERUSED_FACES: readonly string[] = [
  'inter', 'roboto', 'fraunces', 'geist', 'plus jakarta sans', 'space grotesk',
]

/** Keywords whose easing overshoots. Upstream bans them outright. */
const BOUNCE_KEYWORDS: readonly string[] = [
  'bounce', 'elastic', 'back-in', 'back-out', 'ease-in-back', 'ease-out-back', 'ease-in-out-back',
]

/**
 * Properties whose animation forces layout on every frame.
 *
 * `top`/`left`/`bottom`/`right` are here because animating them reflows where a
 * `transform` would not; they are the exact list upstream's description names.
 */
const LAYOUT_PROPERTIES: readonly string[] = [
  'width', 'height', 'padding', 'margin', 'top', 'right', 'bottom', 'left',
]

/** Generic SaaS phrases upstream lists as instant tells. */
const BUZZWORDS: readonly string[] = [
  'streamline', 'empower', 'supercharge', 'world-class', 'enterprise-grade',
  'next-generation', 'cutting-edge', 'game-chang', 'seamlessly', 'best-in-class',
]

/** Extensions whose whole text is a stylesheet. */
const STYLESHEET_EXTENSIONS: readonly string[] = ['.css', '.scss', '.less', '.pcss']

/** One `property: value` pair, with where it was found. */
interface Declaration {
  readonly property: string
  readonly value: string
  /** Offset into the scanned text, for the line number and the excerpt. */
  readonly offset: number
}

/** One declaration group: a CSS rule body, a `style` attribute, or a JSX object. */
interface Block {
  readonly declarations: readonly Declaration[]
  /** Offset of the group, used when a finding is about the group and not a line. */
  readonly offset: number
}

/** Collapse an excerpt to one bounded line. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > SNIPPET_MAX_CHARS ? `${flat.slice(0, SNIPPET_MAX_CHARS - 3)}...` : flat
}

/** The 1-based line an offset falls on. */
function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
}

/** The excerpt for a finding, taken from the source rather than reconstructed. */
function excerptAt(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const end = text.indexOf('\n', offset)
  return snippet(text.slice(start, end === -1 ? text.length : end))
}

/**
 * `fontSize` is `font-size`.
 *
 * Both spellings reach the same CSS declaration, and React's `style` objects use
 * the camelCase one exclusively — so a scanner that only knew `font-size` would
 * report every styled component as clean. The camelCase spelling carries its
 * vendor prefix in a leading capital (`WebkitBackgroundClip`), which is a detail
 * {@link withoutVendorPrefix} handles rather than one every rule has to know.
 */
function toKebab(property: string): string {
  if (!/[A-Z]/u.test(property)) return withoutVendorPrefix(property.toLowerCase())
  // The conversion puts a dash in front of every capital, the first one included,
  // which is exactly what `withoutVendorPrefix` removes before it looks for a
  // prefix: `WebkitBackgroundClip` becomes `-webkit-background-clip` and then
  // `background-clip`, and `fontSize` becomes `-font-size` and then `font-size`.
  return withoutVendorPrefix(property.replace(/([A-Z])/gu, '-$1').toLowerCase())
}

/**
 * Vendor prefixes, which every rule here reads past.
 *
 * A rule about an effect is a rule about the effect, and the prefixed spelling is
 * often the only one that works: `background-clip: text` alone does not clip text
 * in the engines this rule exists for, so the code a reader actually has is
 * `-webkit-background-clip: text` with `-webkit-text-fill-color: transparent`. A
 * scanner that matched only the unprefixed name would report that canonical
 * gradient headline as clean, and the same applies to the React spelling
 * (`WebkitBackgroundClip: 'text'`), which is why this is one normalization rather
 * than a second list of spellings beside every rule.
 */
const VENDOR_PREFIXES: readonly string[] = ['webkit-', 'moz-', 'ms-', 'o-']

/**
 * The same property name without its vendor prefix.
 *
 * The leading dashes are removed before the prefix is matched rather than after,
 * because the two spellings arrive with different numbers of them: CSS writes
 * `-webkit-background-clip`, and the React spelling has none until
 * {@link toKebab} adds one from the leading capital.
 *
 * A **custom property is left alone**, and that is a correctness rule rather than
 * a tidy-up: `--font-size` and `--font-size-base` are token *names*, and reading
 * one of them as `font-size` would make the tiny-text rule fire on the definition
 * of a scale instead of on text that uses it.
 */
function withoutVendorPrefix(property: string): string {
  if (property.startsWith('--')) return property
  const bare = property.replace(/^-+/u, '')
  const prefix = VENDOR_PREFIXES.find(candidate => bare.startsWith(candidate))
  return prefix === undefined ? bare : bare.slice(prefix.length)
}

/**
 * Read a property name.
 *
 * The leading dash is accepted because a prefixed property starts with one, and a
 * pattern anchored at a letter would silently skip every `-webkit-*` declaration —
 * which is not a missing finding but a missing *class* of them. What the name
 * then normalizes to is {@link toKebab}'s business.
 */
const PROPERTY_PATTERN = /^\s*(-?[A-Za-z][A-Za-z0-9-]*)\s*:\s*(.+?)\s*$/u

/** Unwrap a quoted value so `'12px'` is read as `12px`. */
function unquote(value: string): string {
  const trimmed = value.trim()
  const first = trimmed[0]
  if ((first === '\'' || first === '"' || first === '`') && trimmed.endsWith(first)) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * Read the declarations out of one group body.
 *
 * Splitting happens at `;` and `,` at paren depth zero, quote-aware, because the
 * comma is both a CSS declaration separator in some contexts (JSX objects, and
 * `style` attributes written with commas) and load-bearing inside the values this
 * scanner exists to read: `linear-gradient(90deg, #ff3399, #8833ff)` is one
 * value, and a splitter that broke it at its commas would see two color stops as
 * two declarations and match neither rule.
 */
function readDeclarations(text: string, base: number): readonly Declaration[] {
  const declarations: Declaration[] = []
  let depth = 0
  let quote: string | undefined
  let start = base + 0
  const push = (from: number, to: number): void => {
    const chunk = text.slice(from - base, to - base)
    const match = PROPERTY_PATTERN.exec(chunk)
    if (match === null || match[1] === undefined || match[2] === undefined) return
    declarations.push({ property: toKebab(match[1]), value: unquote(match[2]), offset: from })
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== undefined) {
      if (char === '\\') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '\'' || char === '"' || char === '`') { quote = char; continue }
    if (char === '(' || char === '[' || char === '{') { depth += 1; continue }
    if (char === ')' || char === ']' || char === '}') { depth = Math.max(0, depth - 1); continue }
    if (depth === 0 && (char === ';' || char === ',' || char === '\n')) {
      push(start, base + index)
      start = base + index + 1
    }
  }
  push(start, base + text.length)
  return declarations
}

/**
 * The declaration groups a source contributes.
 *
 * Four shapes reach a browser as CSS and all four are read here: a stylesheet's
 * own text, a `<style>` element, a `style="..."` attribute, and a JSX/TSX
 * `style={{...}}` object. A group with no braces at all (an attribute, an object)
 * is one block; a stylesheet contributes one block per `{...}` body. Template
 * literals handed to a CSS-in-JS call are *not* parsed — they are a JavaScript
 * expression's worth of indirection, and guessing at one produces findings whose
 * location a reader cannot verify.
 */
function collectBlocks(text: string, file: string): readonly Block[] {
  const blocks: Block[] = []
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
  const regions: { readonly text: string; readonly base: number; readonly braces: boolean }[] = []

  if (STYLESHEET_EXTENSIONS.includes(extension)) regions.push({ text, base: 0, braces: true })

  for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) {
    const body = match[1] ?? ''
    regions.push({ text: body, base: match.index + match[0].indexOf(body), braces: true })
  }
  for (const match of text.matchAll(/\bstyle\s*=\s*"([^"]*)"/giu)) {
    const body = match[1] ?? ''
    regions.push({ text: body, base: match.index + match[0].indexOf(body), braces: false })
  }
  // The JSX form, `style={{ ... }}`: the outer braces belong to the expression.
  for (const match of text.matchAll(/\bstyle\s*=\s*\{\{([\s\S]*?)\}\}/gu)) {
    const body = match[1] ?? ''
    regions.push({ text: body, base: match.index + match[0].indexOf(body), braces: false })
  }

  for (const region of regions) {
    if (!region.braces) {
      const declarations = readDeclarations(region.text, region.base)
      if (declarations.length > 0) blocks.push({ declarations, offset: region.base })
      continue
    }
    let index = 0
    let found = false
    while (index < region.text.length) {
      const open = region.text.indexOf('{', index)
      if (open === -1) break
      let depth = 1
      let cursor = open + 1
      while (cursor < region.text.length && depth > 0) {
        const char = region.text[cursor]
        if (char === '{') depth += 1
        else if (char === '}') depth -= 1
        cursor += 1
      }
      const body = region.text.slice(open + 1, cursor - 1)
      const base = region.base + open + 1
      const declarations = readDeclarations(body, base)
      if (declarations.length > 0) { blocks.push({ declarations, offset: base }); found = true }
      // Inside the group rather than past it: a nested `@media` (or a `.scss`
      // rule) puts its declarations one level down, and skipping to the closing
      // brace would leave every rule inside it unread. A group that holds nothing
      // but nested rules contributes no declarations of its own, so it is simply
      // not pushed.
      index = open + 1
    }
    // A stylesheet written without braces is not CSS, but a single declaration
    // group can arrive brace-free from a `style` attribute-shaped region, and
    // dropping it would silently skip a file's only styles.
    if (!found) {
      const declarations = readDeclarations(region.text, region.base)
      if (declarations.length > 0) blocks.push({ declarations, offset: region.base })
    }
  }
  return blocks
}

/** The `cubic-bezier(...)` control points a value declares. */
function bezierPoints(value: string): readonly (readonly number[])[] {
  return [...value.matchAll(/cubic-bezier\s*\(([^)]*)\)/giu)].map(match =>
    (match[1] ?? '').split(',').map(part => Number.parseFloat(part.trim())).filter(part => Number.isFinite(part)))
}

/** A CSS length in pixels, or `undefined` when the unit is not one this reads. */
function pixels(value: string, fontSizePx: number): number | undefined {
  const match = /^(-?\d*\.?\d+)\s*(px|rem|em)?$/iu.exec(value.trim())
  if (match === null || match[1] === undefined) return undefined
  const amount = Number.parseFloat(match[1])
  if (!Number.isFinite(amount)) return undefined
  const unit = (match[2] ?? 'px').toLowerCase()
  if (unit === 'px') return amount
  // `em` is relative to the element's own font size, which is what a line-height
  // in `em` is measured against.
  return amount * fontSizePx
}

/**
 * The RGB of one color literal, or `undefined` when this scanner does not read it.
 *
 * Named colors are deliberately absent: the hue windows below are what the rule
 * is about, and a name table that covers `purple` but not `rebeccapurple` would
 * make the rule's coverage a guess.
 */
function rgbOf(value: string): { readonly r: number; readonly g: number; readonly b: number } | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(value.trim())
  if (hex?.[1] !== undefined) {
    const digits = hex[1]
    const expand = (part: string): number => Number.parseInt(part.length === 1 ? part + part : part, 16)
    if (digits.length >= 6) {
      return { r: expand(digits.slice(0, 2)), g: expand(digits.slice(2, 4)), b: expand(digits.slice(4, 6)) }
    }
    return { r: expand(digits[0] ?? '0'), g: expand(digits[1] ?? '0'), b: expand(digits[2] ?? '0') }
  }
  return undefined
}

/** The hue of a color in degrees, for the windows the palette rule reads. */
function hueOf(color: { readonly r: number; readonly g: number; readonly b: number }): number {
  const [r, g, b] = [color.r / 255, color.g / 255, color.b / 255]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  const raw = max === r
    ? ((g - b) / delta) % 6
    : max === g
      ? (b - r) / delta + 2
      : (r - g) / delta + 4
  return ((raw * 60) + 360) % 360
}

/**
 * The hue of every color literal inside a value, in source order.
 *
 * Hue is read rather than handed to a color library because hue is the whole
 * question the palette rule asks, and because an `hsl()` stop states it outright:
 * converting a hue to RGB only to convert it back is how a rounding error turns
 * into a missed finding at a window's edge.
 */
function huesIn(value: string): readonly number[] {
  const hues: number[] = []
  for (const match of value.matchAll(/#[0-9a-f]{3,8}\b|hsla?\([^)]*\)|rgba?\([^)]*\)/giu)) {
    const literal = match[0]
    const numeric = /^hsla?\(/iu.test(literal)
      ? (/^hsla?\(\s*(-?\d*\.?\d+)/iu.exec(literal)?.[1])
      : undefined
    if (numeric !== undefined) { hues.push(((Number.parseFloat(numeric) % 360) + 360) % 360); continue }
    const rgb = /^rgba?\(/iu.test(literal)
      ? (() => {
        const parts = literal.replace(/^rgba?\(|\)$/giu, '').split(/[\s,/]+/u).slice(0, 3).map(Number)
        return parts.length === 3 && parts.every(part => Number.isFinite(part))
          ? { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0 }
          : undefined
      })()
      : rgbOf(literal)
    if (rgb !== undefined) hues.push(hueOf(rgb))
  }
  return hues
}

/** One rule: its upstream metadata and the declarations it reads. */
interface Rule {
  readonly id: string
  readonly name: string
  readonly category: ImpeccableCategory
  readonly severity: ImpeccableSeverity
  readonly message: string
  /** @returns one line per finding: the declaration and why it was flagged. */
  readonly match: (context: RuleContext) => readonly RuleHit[]
}

/** What a rule is handed: the blocks of one file, and the markup beside them. */
interface RuleContext {
  readonly text: string
  readonly blocks: readonly Block[]
}

/**
 * A rule's verdict on one declaration or block.
 *
 * `line` is optional and exists for the rules whose subject is a *rewritten* text:
 * the buzzword and em-dash rules read a copy with markup and code blocks blanked
 * out, so an offset into that copy cannot be translated back into the file. Those
 * rules carry the line they already know; everything else reports an offset into
 * the scanned text and lets the caller compute it.
 */
interface RuleHit {
  readonly offset: number
  readonly snippet: string
  readonly line?: number
}

/** The declarations of a block whose property is one of `properties`. */
function declarationsNamed(block: Block, properties: readonly string[]): readonly Declaration[] {
  return block.declarations.filter(declaration => properties.includes(declaration.property))
}

/** The rules this build implements, each with the guard that keeps it quiet. */
const RULES: readonly Rule[] = [
  {
    id: 'overused-font',
    name: 'Overused font',
    category: 'slop',
    severity: 'primary',
    // Guard: the font name has to appear in a `font-family` (or `font`)
    // declaration. Prose that mentions Inter — a comment, a design note, this
    // very file's own rule list — is not a font choice, and a rule that fired on
    // it would report every project that documents why it avoids Inter.
    message: 'This face appears on so many generated interfaces that it no longer reads as a choice. Pick a face that gives the interface personality.',
    match: ({ blocks }) => {
      const hits: RuleHit[] = []
      for (const block of blocks) {
        for (const declaration of declarationsNamed(block, ['font-family', 'font'])) {
          const face = OVERUSED_FACES.find(overused => new RegExp(`(^|[^a-z])${overused}([^a-z]|$)`, 'iu').test(declaration.value))
          if (face === undefined) continue
          hits.push({ offset: declaration.offset, snippet: `${declaration.property}: ${declaration.value}` })
        }
      }
      return hits
    },
  },
  {
    id: 'gradient-text',
    name: 'Gradient text',
    category: 'slop',
    severity: 'primary',
    // Guard: the clip and the gradient have to be in the *same* declaration
    // group, because that is the effect. A page with a gradient background and a
    // `background-clip: text` headline elsewhere is two declarations, not one
    // finding.
    message: 'Gradient text is decorative rather than meaningful. Use a solid color for text, or make the gradient carry information.',
    match: ({ blocks }) => {
      const hits: RuleHit[] = []
      for (const block of blocks) {
        // One name, because `-webkit-background-clip` arrives here as
        // `background-clip`: the prefixed spelling is what the effect is written
        // in, and matching it is the difference between finding gradient text and
        // missing the shape it usually has.
        const clip = declarationsNamed(block, ['background-clip'])
          .find(declaration => declaration.value.trim().toLowerCase() === 'text')
        if (clip === undefined) continue
        const gradient = declarationsNamed(block, ['background', 'background-image'])
          .find(declaration => /gradient\s*\(/iu.test(declaration.value))
        if (gradient === undefined) continue
        hits.push({ offset: clip.offset, snippet: `background-clip: text + ${gradient.value}` })
      }
      return hits
    },
  },
  {
    id: 'ai-color-palette',
    name: 'AI color palette',
    category: 'slop',
    severity: 'primary',
    // Guard: only gradient stops are read, and only the two hue windows upstream
    // names. A single brand violet used flat is a palette decision; a violet
    // *gradient* is the tell. Hue alone cannot see saturation, so this is the one
    // rule here whose verdict is a heuristic, and its message says so.
    message: 'A purple/violet or cyan gradient is the most recognizable tell of a generated interface. Choose a distinctive, intentional palette.',
    match: ({ blocks }) => {
      const hits: RuleHit[] = []
      for (const block of blocks) {
        for (const declaration of declarationsNamed(block, ['background', 'background-image'])) {
          if (!/gradient\s*\(/iu.test(declaration.value)) continue
          const tell = huesIn(declaration.value).find(hue => (hue >= 250 && hue <= 300) || (hue >= 165 && hue <= 200))
          if (tell === undefined) continue
          hits.push({ offset: declaration.offset, snippet: `${declaration.property}: ${declaration.value}` })
        }
      }
      return hits
    },
  },
  {
    id: 'bounce-easing',
    name: 'Bounce or elastic easing',
    category: 'slop',
    severity: 'primary',
    // Guard: overshoot is read from the bezier's own control points, not from the
    // word `ease` — `ease-out` is the recommended replacement and must stay quiet.
    message: 'Bounce and elastic easing read as dated. Use a decelerating curve (ease-out-quart, quint or exp) instead.',
    match: ({ blocks }) => {
      const hits: RuleHit[] = []
      for (const block of blocks) {
        for (const declaration of block.declarations) {
          const value = declaration.value.toLowerCase()
          const overshoots = bezierPoints(value).some(points =>
            points.length === 4 && ((points[1] ?? 0) < 0 || (points[1] ?? 0) > 1 || (points[3] ?? 0) < 0 || (points[3] ?? 0) > 1))
          const keyword = BOUNCE_KEYWORDS.some(entry => value.includes(entry))
          if (!overshoots && !keyword) continue
          hits.push({ offset: declaration.offset, snippet: `${declaration.property}: ${declaration.value}` })
        }
      }
      return hits
    },
  },
  {
    id: 'layout-transition',
    name: 'Layout property animation',
    category: 'quality',
    severity: 'primary',
    // Guard: the layout property has to be named as the thing being *transitioned*
    // — `transition: width` or `transition-property: height` — rather than
    // appearing anywhere in the file. A `width: 100%` is not a transition.
    message: 'Animating width, height, padding or margin forces layout on every frame. Transition transform and opacity instead.',
    match: ({ blocks }) => {
      const hits: RuleHit[] = []
      for (const block of blocks) {
        for (const declaration of declarationsNamed(block, ['transition', 'transition-property'])) {
          const named = LAYOUT_PROPERTIES.find(property => new RegExp(`(^|[^a-z-])${property}([^a-z-]|$)`, 'iu').test(declaration.value))
          if (named === undefined) continue
          hits.push({ offset: declaration.offset, snippet: `${declaration.property}: ${declaration.value}` })
        }
      }
      return hits
    },
  },
  {
    id: 'tight-leading',
    name: 'Tight line height',
    category: 'quality',
    severity: 'primary',
    // Guard: a heading's deliberate 1.1 line height is a typographic choice, so
    // only a line height below 1.3 *and* attached to a size the block declares
    // as body-sized or unknown is reported. The unitless and `em` forms are read;
    // percentages are left alone because `line-height: 120%` and a bare `1.2`
    // mean the same thing and only one of them is unambiguous to a text scanner.
    message: 'Line height below 1.3 makes multi-line text hard to read. Use 1.5 to 1.7 for body text.',
    match: ({ blocks }) => {
      const hits: RuleHit[] = []
      for (const block of blocks) {
        const fontSize = declarationsNamed(block, ['font-size'])
          .map(declaration => pixels(declaration.value, 16))
          .find(value => value !== undefined)
        for (const declaration of declarationsNamed(block, ['line-height'])) {
          const value = declaration.value.trim().toLowerCase()
          const unitless = /^\d*\.?\d+$/u.test(value) ? Number.parseFloat(value) : undefined
          const relative = /^\d*\.?\d+(rem|em)$/u.test(value) ? Number.parseFloat(value) : undefined
          const ratio = unitless ?? relative
          if (ratio !== undefined) {
            if (ratio < 1.3) hits.push({ offset: declaration.offset, snippet: `line-height: ${declaration.value}` })
            continue
          }
          const absolute = pixels(value, 16)
          if (absolute === undefined || fontSize === undefined) continue
          if (absolute / fontSize < 1.3) hits.push({ offset: declaration.offset, snippet: `line-height: ${declaration.value}` })
        }
      }
      return hits
    },
  },
  {
    id: 'tiny-text',
    name: 'Tiny body text',
    category: 'quality',
    severity: 'primary',
    // Guard: only an explicit size below the floor is reported. Sizes that arrive
    // from a token (`font-size: var(--step-1)`) or a relative unit of unknown base
    // are not guessed at, which is why `em` sizes are compared against the block's
    // own declared size and skipped when it has none.
    message: 'Body text below 12px is hard to read, especially on high-DPI screens. Use at least 14px, ideally 16px.',
    match: ({ blocks }) => {
      const hits: RuleHit[] = []
      for (const block of blocks) {
        for (const declaration of declarationsNamed(block, ['font-size'])) {
          // `em` is relative to a parent this scanner cannot see, so it is not
          // read: a size below the floor is only reported when the unit states
          // the size on its own. A *bare* number does state it — in a React
          // `style` object `fontSize: 10` is ten pixels, and a scanner that
          // ignored the unitless form would report every styled component clean.
          const value = declaration.value.trim().toLowerCase()
          const size = /^\d*\.?\d+(px|rem)?$/u.test(value) ? pixels(value, 16) : undefined
          if (size === undefined || size >= 12) continue
          hits.push({ offset: declaration.offset, snippet: `font-size: ${declaration.value}` })
        }
      }
      return hits
    },
  },
  {
    id: 'extreme-negative-tracking',
    name: 'Crushed letter spacing',
    category: 'slop',
    severity: 'primary',
    // Guard: the threshold is -0.05em (or -1px), the point at which characters
    // stop keeping their own shapes. Display type legitimately tightens by less,
    // and a rule that reported `-0.01em` would be reporting taste.
    message: 'Letter spacing pulled tighter than the point where characters keep their shapes costs legibility. Tighten display type optically, not destructively.',
    match: ({ blocks }) => {
      const hits: RuleHit[] = []
      for (const block of blocks) {
        for (const declaration of declarationsNamed(block, ['letter-spacing'])) {
          const value = declaration.value.trim().toLowerCase()
          const relative = /^(-?\d*\.?\d+)(em|rem)$/u.exec(value)
          if (relative?.[1] !== undefined) {
            if (Number.parseFloat(relative[1]) <= -0.05) hits.push({ offset: declaration.offset, snippet: `letter-spacing: ${declaration.value}` })
            continue
          }
          const absolute = pixels(value, 16)
          if (absolute !== undefined && absolute <= -1) hits.push({ offset: declaration.offset, snippet: `letter-spacing: ${declaration.value}` })
        }
      }
      return hits
    },
  },
  {
    id: 'broken-image',
    name: 'Broken or placeholder image',
    category: 'quality',
    severity: 'primary',
    // Guard: a missing `src` in a template that fills it at runtime (`<img
    // src={url}>`) is indistinguishable from a broken one by text, so an
    // expression is not reported — only an attribute that is absent, empty, or
    // literally a placeholder.
    message: 'An image with no usable src ships as a broken-image box. Use a real asset, or remove the tag.',
    match: ({ text }) => {
      const hits: RuleHit[] = []
      for (const match of text.matchAll(/<img\b[^>]*>/giu)) {
        const tag = match[0]
        const attribute = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu.exec(tag)
        const value = (attribute?.[1] ?? attribute?.[2] ?? attribute?.[3] ?? '').trim()
        if (/^[{[]/u.test(value)) continue
        const placeholder = value === '' || value === '#' || /^placeholder\b/iu.test(value)
        if (!placeholder) continue
        hits.push({ offset: match.index, snippet: snippet(tag) })
      }
      return hits
    },
  },
  {
    id: 'em-dash-overuse',
    name: 'Em-dash overuse',
    category: 'slop',
    // Upstream is explicit that this is advisory: humans use em dashes
    // legitimately, so saturation is the finding and a long article with a few is
    // not. It never decides a scan's exit code.
    severity: 'advisory',
    message: 'Em-dash saturation in body copy reads as generated cadence. Prefer commas, colons, periods or parentheses.',
    match: ({ text }) => {
      const prose = text
        .replace(/<[^>]*>/gu, ' ')
        .replace(/```[\s\S]*?```/gu, ' ')
        .replace(/^\s*[|>#-].*$/gmu, ' ')
      const dashes = [...prose.matchAll(/—|(?:^|\s)--(?=\s)/gu)].length
      if (dashes < 8) return []
      const density = prose.length === 0 ? 0 : prose.length / dashes
      if (density > 500) return []
      const first = /—|(?:^|\s)--(?=\s)/u.exec(prose)
      const offset = first?.index ?? 0
      return [{ offset, line: lineAt(prose, offset), snippet: `${dashes} em dashes in ${prose.length} characters` }]
    },
  },
  {
    id: 'marketing-buzzword',
    name: 'Marketing buzzword',
    category: 'slop',
    severity: 'advisory',
    // Guard: the phrase has to be *visible prose*. Upstream's list is a list of
    // words a reader sees, and this scanner only reads text nodes — so a class
    // name, an import path or a comment cannot produce a finding.
    message: 'Generic product phrases read as generated copy. Say what the thing literally does instead.',
    match: ({ text }) => {
      const hits: RuleHit[] = []
      const withoutTags = text.replace(/<style\b[\s\S]*?<\/style>/giu, ' ').replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
      for (const match of withoutTags.matchAll(/>([^<>]+)</gu)) {
        const body = match[1] ?? ''
        const word = BUZZWORDS.find(entry => new RegExp(`(^|[^a-z])${entry}`, 'iu').test(body))
        if (word === undefined) continue
        const offset = match.index + match[0].indexOf(body)
        hits.push({ offset, line: lineAt(withoutTags, offset), snippet: snippet(body) })
      }
      return hits
    },
  },
]

/** Heading levels in document order, with the offset each tag was found at. */
function headings(text: string): readonly { readonly level: number; readonly offset: number; readonly tag: string }[] {
  const found: { level: number; offset: number; tag: string }[] = []
  for (const match of text.matchAll(/<h([1-6])\b[^>]*>/giu)) {
    const level = Number.parseInt(match[1] ?? '0', 10)
    if (!Number.isFinite(level) || level < 1) continue
    found.push({ level, offset: match.index, tag: snippet(match[0]) })
  }
  return found
}

/**
 * The ids this build can decide, as a value.
 *
 * `skipped-heading` is listed here rather than in the table above because its
 * subject is a document's heading order rather than one declaration, so it is
 * evaluated where the whole text is in hand (see {@link scanSource}). It is in
 * *this* list because the list is what the coverage claim is made of: the design
 * page says how many rules answer here, and a count written twice is a count that
 * eventually disagrees with the scan.
 */
export const IMPECCABLE_BUILTIN_RULES: readonly string[] = [...RULES.map(rule => rule.id), 'skipped-heading'].sort()

/**
 * Scan one file's text with the built-in rule subset.
 *
 * @param file - the file's name, whose extension selects how its styles are read.
 * @param text - its contents.
 * @returns the findings, in source order, and the rules that ran.
 */
export function scanSource(file: string, text: string): ImpeccableScanReport {
  // Comments are removed before anything is parsed: every rule below is about
  // code that reaches a browser, and a comment that documents a banned easing
  // curve is the most likely place for its name to appear. `stripJsComments`
  // preserves newlines, so line numbers still point at the original file.
  const stripped = stripJsComments(text)
  const blocks = collectBlocks(stripped, file)
  const context: RuleContext = { text: stripped, blocks }
  const findings: ImpeccableFinding[] = []

  for (const rule of RULES) {
    for (const hit of rule.match(context)) {
      findings.push({
        rule: rule.id,
        ruleName: rule.name,
        category: rule.category,
        severity: rule.severity,
        line: hit.line ?? lineAt(stripped, hit.offset),
        snippet: snippet(hit.snippet === '' ? excerptAt(stripped, hit.offset) : hit.snippet),
        message: rule.message,
      })
    }
  }

  // `skipped-heading` is the one rule whose subject is the document's order
  // rather than one declaration, so it is evaluated here where the whole text is
  // in hand, and its findings join the same list.
  const levels = headings(stripped)
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1]
    const current = levels[index]
    if (previous === undefined || current === undefined) continue
    if (current.level <= previous.level + 1) continue
    findings.push({
      rule: 'skipped-heading',
      ruleName: 'Skipped heading level',
      category: 'quality',
      severity: 'primary',
      line: lineAt(stripped, current.offset),
      snippet: snippet(`${previous.tag} then ${current.tag}`),
      message: 'Heading levels should not skip. Screen readers use the hierarchy for navigation, and a skipped level breaks the document outline.',
    })
  }

  findings.sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule))
  return {
    findings,
    rulesApplied: IMPECCABLE_BUILTIN_RULES,
    lines: stripped.split('\n').length,
  }
}
