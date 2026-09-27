/**
 * Static composition lint: the subset of upstream's rules that needs no browser.
 *
 * Upstream ships ~100 rules across eleven files (16k lines) and drives them
 * through PostCSS plus a full HTML document model. We take the rules that are
 * decidable from the file's own text, because those are the ones that can answer
 * *before* anything is rendered — and because this plugin's whole design claim is
 * that a composition is checked and produced on the machine it already has, with
 * no dependency to install for the check.
 *
 * Two consequences worth stating rather than hiding:
 *
 * 1. **The finding codes are upstream's**, verbatim. A Skill that says "clear
 *    `non_deterministic_code`" keeps meaning the same thing here, and a fix that
 *    works upstream still applies. Inventing our own names would turn every
 *    vendored instruction about lint into a translation step.
 * 2. **This is a subset.** Rules that need a document tree (selector nesting
 *    resolution, composition-loading graphs, caption layout measurement) are
 *    absent, and the report says which rules ran so a missing finding is not read
 *    as a clean bill of health. A short list that claims completeness is worse
 *    than a long list that names its bound.
 *
 * @module design/lint
 */

import { Script } from 'node:vm'

/** Upstream's severities. `info` findings are hidden unless asked for. */
export type DesignLintSeverity = 'error' | 'warning' | 'info'

/** One finding, shaped as upstream's `HyperframeLintFinding`. */
export interface DesignLintFinding {
  /** Upstream's rule id, so a Skill's wording about it still applies. */
  readonly code: string
  readonly severity: DesignLintSeverity
  readonly message: string
  readonly fixHint?: string
  /** Short excerpt around the problem, for a model that needs to locate it. */
  readonly snippet?: string
}

/** The lint report for one composition source. */
export interface DesignLintReport {
  readonly ok: boolean
  readonly errorCount: number
  readonly warningCount: number
  readonly infoCount: number
  readonly findings: readonly DesignLintFinding[]
  /** The rule ids that actually ran, so the answer names its own bound. */
  readonly rulesApplied: readonly string[]
}

/** Default ceiling on a composition's size, in bytes. */
export const DEFAULT_COMPOSITION_MAX_BYTES = 512 * 1024

/** Longest excerpt any finding carries. */
const SNIPPET_MAX_CHARS = 120

/** Collapse a source excerpt to one bounded line. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > SNIPPET_MAX_CHARS ? `${flat.slice(0, SNIPPET_MAX_CHARS - 3)}...` : flat
}

/** Read one attribute out of a raw start tag. Quoted and bare values both count.
 *
 * Exported because `timeline.ts` reads the same clip contract out of the same
 * markup: two private copies would be two answers to "what is this attribute"
 * the first time one of them learned about a new quoting style. */
export function readAttr(tag: string, name: string): string | undefined {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'iu').exec(tag)
  if (quoted !== null) return quoted[2] ?? quoted[3] ?? ''
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s"'>]+)`, 'iu').exec(tag)
  return bare?.[1]
}

/**
 * Remove JavaScript comments without touching string contents.
 *
 * A regex would be wrong in both directions: `//` inside a URL string is not a
 * comment, and a `/*` inside a template literal is not one either. Both mistakes
 * show up as a `non_deterministic_code` finding that is not there, or as a missed
 * one — so the scanner tracks quote state instead.
 */
export function stripJsComments(source: string): string {
  let out = ''
  let quote: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (quote !== undefined) {
      out += char
      if (char === '\\') { out += next ?? ''; index += 1; continue }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === '\'' || char === '`') { quote = char; out += char; continue }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        // Newlines are preserved so a reported offset still points at the right line.
        if (source[index] === '\n') out += '\n'
        index += 1
      }
      index += 1
      continue
    }
    out += char
  }
  return out
}

/**
 * Blank out string literals, keeping their length and any newlines.
 *
 * This is what keeps a composition that *displays* source — a code-snippet
 * block, an explainer about randomness — from reporting itself as
 * non-deterministic. The literal is inert text; only executable code can make a
 * render diverge.
 */
export function stripStringLiterals(source: string): string {
  let out = ''
  let quote: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote === undefined) {
      if (char === '"' || char === '\'' || char === '`') { quote = char; out += ' '; continue }
      out += char
      continue
    }
    if (char === '\\') { out += '  '; index += 1; continue }
    if (char === quote) { quote = undefined; out += ' '; continue }
    out += char === '\n' ? '\n' : ' '
  }
  return out
}

/** Every `<script>` body that has no `src` and is not a data block. */
interface ScriptBlock {
  readonly attrs: string
  readonly content: string
}

/**
 * Inline scripts we can judge, with the ones we cannot already excluded.
 *
 * `src` scripts are another file, `application/json` blocks are data, and
 * `module` scripts may use syntax `vm.Script` refuses (import/export, top-level
 * await) — reporting those would be a false positive on a valid composition.
 */
function judgeableScripts(source: string): readonly ScriptBlock[] {
  const blocks: ScriptBlock[] = []
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    const attrs = match[1] ?? ''
    if (/\bsrc\s*=/iu.test(attrs)) continue
    if (/\btype\s*=\s*["'](?:application\/json|application\/hyperframes-slideshow\+json|importmap|module)["']/iu.test(attrs)) continue
    blocks.push({ attrs, content: match[2] ?? '' })
  }
  return blocks
}

/** Where a style or script region starts, so markup rules can ignore its inside. */
interface Region {
  readonly start: number
  readonly end: number
}

/** The spans occupied by `<style>` and `<script>` elements. */
function codeRegions(source: string): readonly Region[] {
  const regions: Region[] = []
  for (const match of source.matchAll(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/giu)) {
    regions.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
  }
  return regions
}

/** True when `offset` falls inside a style or script element. */
function inCode(regions: readonly Region[], offset: number): boolean {
  return regions.some(region => offset >= region.start && offset < region.end)
}

/**
 * The composition root: the first element that declares itself one.
 *
 * Upstream reads this from a document model. Without one, "the element carrying
 * `data-composition-id`, or failing that the element carrying `data-width`" is
 * the closest decidable question — and the two rules that depend on it are
 * exactly the two that are *about* those attributes, so a document that has
 * neither reports both against the first element it renders.
 */
function findRootTag(source: string): string | undefined {
  for (const match of source.matchAll(/<([a-z][\w-]*)\b([^>]*)>/giu)) {
    const tag = match[0]
    if (/\bdata-composition-id\s*=/iu.test(tag) || /\bdata-(?:width|height)\s*=/iu.test(tag)) return tag
  }
  return /<([a-z][\w-]*)\b[^>]*>/iu.exec(source)?.[0]
}

/** Patterns that make a render non-deterministic, in upstream's own wording. */
const NON_DETERMINISTIC_PATTERNS: readonly {
  readonly pattern: RegExp
  readonly label: string
  readonly hint: string
  /** Set when the string form is the executed value, so strings must be scanned. */
  readonly scansStrings?: boolean
}[] = [
  { pattern: /Math\.random\s*\(/u, label: 'Math.random()', hint: 'Use a seeded PRNG (e.g. a simple mulberry32) so renders are deterministic across frames.' },
  { pattern: /Date\.now\s*\(/u, label: 'Date.now()', hint: 'Remove time-dependent code. Use GSAP timeline position instead of wall-clock time.' },
  // Zero-arg only: `new Date(<fixed>)` is deterministic and is how a composition
  // labels a fixed date on an axis. Reporting it would ask the author to delete
  // the label to clear the finding.
  { pattern: /new\s+Date\s*\(\s*\)/u, label: 'new Date()', hint: 'Remove time-dependent code. Use GSAP timeline position instead of wall-clock time.' },
  { pattern: /performance\.now\s*\(/u, label: 'performance.now()', hint: 'Remove time-dependent code. Use GSAP timeline position instead of wall-clock time.' },
  { pattern: /crypto\.getRandomValues\s*\(/u, label: 'crypto.getRandomValues()', hint: 'Use a seeded PRNG (e.g. a simple mulberry32) so renders are deterministic across frames.' },
  { pattern: /gsap\.utils\.random\s*\(/u, label: 'gsap.utils.random()', hint: 'Each render worker initializes independently, so random values diverge across chunks. Use a seeded PRNG or fixed values.' },
  // Here the string IS the executed value — GSAP parses and evaluates it — which
  // is why this one pattern scans string contents while the rest do not.
  { pattern: /["'`](?:[+-]=)?random\(\s*[-\d[]/u, scansStrings: true, label: '"random(...)" tween value', hint: 'GSAP random string values re-roll at tween init and each render worker initializes independently. Use fixed values or precompute with a seeded PRNG.' },
]

/** The rule ids this module can report, in the order the report lists them. */
export const DESIGN_LINT_RULE_IDS: readonly string[] = [
  'composition_file_too_large',
  'root_missing_composition_id',
  'root_missing_dimensions',
  'unbalanced_style_tags',
  'visible_markup_comment',
  'unclosed_tag_swallowed_element',
  'id_requires_css_escape',
  'host_missing_composition_id',
  'invalid_inline_script_syntax',
  'invalid_parent_traversal_in_asset_path',
  'non_deterministic_code',
]

/**
 * Lint one composition source.
 *
 * @param source - the composition file's text.
 * @param options - size ceiling and whether this is a sub-composition.
 * @returns findings plus the rule ids that ran.
 */
export function lintComposition(source: string, options: { readonly maxBytes?: number } = {}): DesignLintReport {
  const findings: DesignLintFinding[] = []
  const add = (finding: DesignLintFinding): void => { findings.push(finding) }
  const maxBytes = options.maxBytes ?? DEFAULT_COMPOSITION_MAX_BYTES

  // A file this size is almost always an embedded asset rather than a
  // composition, and the render path reads it whole.
  const bytes = Buffer.byteLength(source, 'utf8')
  if (bytes > maxBytes) {
    add({
      code: 'composition_file_too_large',
      severity: 'warning',
      message: `Composition is ${bytes} bytes, above the ${maxBytes}-byte ceiling.`,
      fixHint: 'Move embedded assets (fonts, images, audio) out of the composition file and reference them by path.',
      snippet: snippet(source.slice(0, 80)),
    })
  }

  // --- structure -----------------------------------------------------------------

  const rootTag = findRootTag(source)
  if (rootTag === undefined || readAttr(rootTag, 'data-composition-id') === undefined) {
    add({
      code: 'root_missing_composition_id',
      severity: 'error',
      message: 'Root composition is missing `data-composition-id`.',
      fixHint: 'Add a stable `data-composition-id` to the entry composition wrapper.',
      ...(rootTag === undefined ? {} : { snippet: snippet(rootTag) }),
    })
  }
  if (rootTag === undefined || readAttr(rootTag, 'data-width') === undefined || readAttr(rootTag, 'data-height') === undefined) {
    add({
      code: 'root_missing_dimensions',
      severity: 'error',
      message: 'Root composition is missing `data-width` or `data-height`.',
      fixHint: 'Set numeric `data-width` and `data-height` on the entry composition root.',
      ...(rootTag === undefined ? {} : { snippet: snippet(rootTag) }),
    })
  }

  // Every `data-composition-src` host mounts another file, and the loader finds it
  // by id — a host without one loads nothing and the frame comes out empty.
  for (const match of source.matchAll(/<([a-z][\w-]*)\b([^>]*)>/giu)) {
    const tag = match[0]
    const ref = readAttr(tag, 'data-composition-src')
    if (ref === undefined) continue
    if (readAttr(tag, 'data-composition-id') !== undefined) continue
    add({
      code: 'host_missing_composition_id',
      severity: 'error',
      message: `Composition host for "${ref}" is missing \`data-composition-id\`.`,
      fixHint: 'Set `data-composition-id` on every `data-composition-src` host element.',
      snippet: snippet(tag),
    })
  }

  // Refuse to read outside the project. A composition is data, and data that can
  // name `../../` can name a file the user never intended to hand to a renderer.
  for (const match of source.matchAll(/\b(src|href)\s*=\s*("[^"]*"|'[^']*')/giu)) {
    const value = (match[2] ?? '').slice(1, -1)
    if (!/(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(value)) continue
    add({
      code: 'invalid_parent_traversal_in_asset_path',
      severity: 'warning',
      message: `Asset path "${value}" traverses out of the composition's directory.`,
      fixHint: 'Keep asset references inside the project directory.',
      snippet: snippet(match[0]),
    })
  }

  // --- tags ---------------------------------------------------------------------

  let opens = 0
  let closes = 0
  let firstStyleTag = ''
  for (const match of source.matchAll(/<script\b[\s\S]*?<\/script[^>]*>|<style\b|<\/style\s*>/giu)) {
    const token = match[0].toLowerCase()
    if (token.startsWith('<script')) continue
    if (token.startsWith('</style')) closes += 1
    else opens += 1
    if (firstStyleTag === '') firstStyleTag = match[0]
  }
  if (opens !== closes) {
    add({
      code: 'unbalanced_style_tags',
      severity: 'error',
      message: opens > closes
        ? 'A <style> block is never closed, so following markup is parsed as CSS and disappears from the frame.'
        : 'An extra </style> closes the stylesheet early, so trailing CSS renders as visible on-screen text.',
      fixHint: 'Keep <style> and </style> paired. One extra closer dumps CSS into the body.',
      snippet: snippet(firstStyleTag === '' ? '<style>' : firstStyleTag),
    })
  }

  const regions = codeRegions(source)

  // A `<` inside a start tag's attribute text means the previous tag never closed,
  // and the browser reads the next element as bogus attributes of this one.
  for (const match of source.matchAll(/<([a-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/giu)) {
    const attrs = match[2] ?? ''
    const bare = attrs.replace(/"[^"]*"|'[^']*'/gu, '')
    if (!bare.includes('<')) continue
    add({
      code: 'unclosed_tag_swallowed_element',
      severity: 'error',
      message: `<${match[1]}> is missing its closing \`>\` before the next \`<\` — the following element is swallowed as bogus attribute text and never becomes a real node.`,
      fixHint: "Close the previous tag's `>` before opening the next element.",
      snippet: snippet(match[0]),
    })
  }

  // An id that starts with a digit cannot be reached by `#id` in `querySelector`,
  // which is how every composition targets its elements.
  for (const match of source.matchAll(/<([a-z][\w-]*)\b([^>]*)>/giu)) {
    const id = readAttr(match[0], 'id')
    if (id === undefined || !/^\d/u.test(id)) continue
    add({
      code: 'id_requires_css_escape',
      severity: 'warning',
      message: `id="${id}" starts with a digit, so the common selector \`#${id}\` throws a SyntaxError in querySelector().`,
      fixHint: `Rename the id to start with a letter (recommended), or build selectors with \`#\${CSS.escape(id)}\` at runtime.`,
      snippet: snippet(match[0]),
    })
  }

  // `/* ... */` outside a style or script block is not a comment to an HTML
  // parser: it is text, and it renders.
  for (const match of source.matchAll(/\/\*[\s\S]*?\*\//gu)) {
    if (inCode(regions, match.index ?? 0)) continue
    add({
      code: 'visible_markup_comment',
      severity: 'error',
      message: 'CSS/JS block comment syntax (`/* ... */`) appears in visible HTML markup. HTML only treats `<!-- ... -->` as comments, so this renders as on-screen text.',
      fixHint: 'Remove the text or convert it to a real HTML comment (`<!-- ... -->`). Keep CSS comments inside `<style>` and JS comments inside `<script>`.',
      snippet: snippet(match[0]),
    })
  }

  // --- scripts ------------------------------------------------------------------

  for (const script of judgeableScripts(source)) {
    if (script.content.trim() === '') continue
    try {
      // Compiling without running it is the whole check: a syntax error is
      // decidable, and a runtime error would depend on an environment we are not
      // in and would be a false positive against a composition that works.
      void new Script(script.content)
    } catch (error) {
      add({
        code: 'invalid_inline_script_syntax',
        severity: 'error',
        message: `Inline script has invalid syntax: ${error instanceof Error ? error.message : String(error)}`,
        fixHint: 'Fix the inline script syntax before render verification.',
        snippet: snippet(script.content),
      })
    }

    // Comments stripped first, then string literals: a composition that displays
    // source shows `Math.random()` inside a literal it never executes, and
    // reporting that would leave no way to clear the finding and still render the
    // snippet.
    const withoutComments = stripJsComments(script.content)
    const executable = stripStringLiterals(withoutComments)
    for (const entry of NON_DETERMINISTIC_PATTERNS) {
      const haystack = entry.scansStrings === true ? withoutComments : executable
      const match = entry.pattern.exec(haystack)
      if (match === null) continue
      add({
        code: 'non_deterministic_code',
        severity: 'error',
        message: `Script contains \`${entry.label}\` which produces non-deterministic output. Renders may differ between frames or runs.`,
        fixHint: entry.hint,
        snippet: snippet(script.content),
      })
    }
  }

  const errorCount = findings.filter(finding => finding.severity === 'error').length
  const warningCount = findings.filter(finding => finding.severity === 'warning').length
  const infoCount = findings.filter(finding => finding.severity === 'info').length
  return {
    ok: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    findings,
    rulesApplied: DESIGN_LINT_RULE_IDS,
  }
}
