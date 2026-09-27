/**
 * The tables the vendored UI/UX catalog is made of: their shapes, their calibrated
 * thresholds, and the two pure functions that decide *what* gets searched.
 *
 * Why the column lists live here rather than beside the search
 * -----------------------------------------------------------
 * A table's searchable columns and its returned columns are the contract between
 * the vendored CSV and everything that reads it. `core.py` kept them in one
 * dictionary keyed by domain for exactly this reason: a table whose returned column
 * is misspelled returns that field empty, and the recommendation then has a blank
 * where a value should be — visible in the output, invisible in the code. One table,
 * one place, so a rename is a single edit that either matches the data or does not.
 * `google-fonts` is deliberately not a domain here: the selected package does not
 * carry its large raw-family dictionary, and the curated `typography` pairings ship.
 *
 * Why the thresholds are constants and not computed
 * ------------------------------------------------
 * Each floor below was measured against the scorer in `bm25.ts` on this corpus, and
 * a floor's whole job is to be the number a bad match does not reach. Deriving one
 * at runtime from the rows would make the abstention move whenever the table grows,
 * which is precisely when nobody is re-measuring it. `CALIBRATION_VERSION` travels
 * with every decision so a result can be attributed to the numbers that produced it.
 *
 * The column names are data, not decoration
 * -----------------------------------------
 * `Light Mode ✓` and `Dark Mode ✓` carry a check mark because that is the CSV header
 * upstream ships; the port keeps the character so the field is still found.
 *
 * @module uiux/catalog
 */

/** One domain of the catalog: the file behind it and the columns it searches and returns. */
export interface DomainTable {
  /** File name inside the catalog's data directory. */
  readonly file: string
  /** Columns joined into the document text the index is fitted over. */
  readonly searchColumns: readonly string[]
  /** Columns projected into each returned row. */
  readonly outputColumns: readonly string[]
}

/** A comparable score/coverage requirement a search must clear to answer at all. */
export interface CalibratedThreshold {
  /** Minimum top score; the domain floors below are the measured values. */
  readonly minScore: number
  /** Minimum gap between the top two scores. 0 disables the check everywhere today. */
  readonly minMargin: number
  /** Minimum share of the query's tokens the corpus has seen. */
  readonly minCoverage: number
}

/** The domains the catalog searches, in the order upstream's `_DOMAIN_TIEBREAK_ORDER` resolves ties. */
export type Domain =
  | 'ux'
  | 'product'
  | 'style'
  | 'color'
  | 'typography'
  | 'chart'
  | 'landing'
  | 'icons'
  | 'gsap'
  | 'react'
  | 'web'

/**
 * Domain name to table.
 *
 * `gsap` reads `motion.csv`: the domain is named for what the rows *are* (animation
 * skeletons) while the table is named for the library they are written against.
 * There is no separate `motion` domain here — upstream's code comments refer to one,
 * and the file it would read is not part of what this catalog ships, so a port that
 * invented the domain would promise a search with nothing behind it.
 */
export const DOMAIN_TABLES: Readonly<Record<Domain, DomainTable>> = {
  style: {
    file: 'styles.csv',
    searchColumns: ['Style ID', 'Style Category', 'Aliases', 'Keywords', 'Best For', 'Type', 'AI Prompt Keywords'],
    outputColumns: [
      'Style ID', 'Style Category', 'Aliases', 'Status', 'Parent Style ID', 'Preferred Mode', 'Type', 'Keywords',
      'Primary Colors', 'Effects & Animation', 'Best For', 'Light Mode ✓', 'Dark Mode ✓', 'Performance',
      'Accessibility', 'Framework Compatibility', 'Complexity', 'AI Prompt Keywords', 'CSS/Technical Keywords',
      'Implementation Checklist', 'Design System Variables',
    ],
  },
  color: {
    file: 'colors.csv',
    searchColumns: ['Product Type', 'Notes'],
    outputColumns: [
      'Product Type', 'Primary', 'On Primary', 'Secondary', 'On Secondary', 'Accent', 'On Accent', 'Background',
      'Foreground', 'Card', 'Card Foreground', 'Muted', 'Muted Foreground', 'Border', 'Destructive',
      'On Destructive', 'Ring', 'Notes',
    ],
  },
  chart: {
    file: 'charts.csv',
    searchColumns: ['Data Type', 'Keywords', 'Best Chart Type', 'When to Use', 'When NOT to Use', 'Accessibility Notes'],
    outputColumns: [
      'Data Type', 'Keywords', 'Best Chart Type', 'Secondary Options', 'When to Use', 'When NOT to Use',
      'Data Volume Threshold', 'Color Guidance', 'Accessibility Grade', 'Accessibility Risk', 'Accessibility Notes',
      'A11y Fallback', 'Library Recommendation', 'Interactive Level',
    ],
  },
  landing: {
    file: 'landing.csv',
    searchColumns: ['Pattern ID', 'Pattern Name', 'Aliases', 'Keywords', 'Conversion Optimization', 'Section Order'],
    outputColumns: [
      'Pattern ID', 'Pattern Name', 'Aliases', 'Keywords', 'Section Order', 'Primary CTA Placement',
      'Color Strategy', 'Conversion Optimization',
    ],
  },
  product: {
    file: 'products.csv',
    searchColumns: ['Product Type', 'Keywords', 'Primary Style Recommendation', 'Key Considerations'],
    outputColumns: [
      'Product Type', 'Keywords', 'Primary Style Recommendation', 'Secondary Styles', 'Landing Page Pattern',
      'Dashboard Style (if applicable)', 'Color Palette Focus',
    ],
  },
  ux: {
    file: 'ux-guidelines.csv',
    searchColumns: ['Category', 'Issue', 'Description', 'Platform'],
    outputColumns: [
      'Category', 'Issue', 'Platform', 'Description', 'Do', "Don't", 'Code Example Good', 'Code Example Bad', 'Severity',
    ],
  },
  typography: {
    file: 'typography.csv',
    searchColumns: ['Font Pairing Name', 'Category', 'Mood/Style Keywords', 'Best For', 'Heading Font', 'Body Font'],
    outputColumns: [
      'Font Pairing Name', 'Category', 'Heading Font', 'Body Font', 'Mood/Style Keywords', 'Best For',
      'Google Fonts URL', 'CSS Import', 'Tailwind Config', 'Notes',
    ],
  },
  icons: {
    file: 'icons.csv',
    searchColumns: ['Category', 'Icon Name', 'Keywords', 'Best For', 'Library'],
    outputColumns: [
      'Category', 'Icon Name', 'Keywords', 'Library', 'Import Code', 'Usage', 'Best For', 'Style', 'Semantic Role',
      'Allowed Contexts',
    ],
  },
  gsap: {
    file: 'motion.csv',
    searchColumns: ['Category', 'Intensity Tier', 'Keywords', 'Trigger'],
    outputColumns: [
      'Category', 'Intensity Tier', 'Trigger', 'Duration', 'Easing', 'GSAP Snippet', 'Framework Notes', 'Do', "Don't",
      'Performance Notes',
    ],
  },
  react: {
    file: 'react-performance.csv',
    searchColumns: ['Category', 'Issue', 'Keywords', 'Description'],
    outputColumns: [
      'Category', 'Issue', 'Platform', 'Description', 'Do', "Don't", 'Code Example Good', 'Code Example Bad', 'Severity',
    ],
  },
  web: {
    file: 'app-interface.csv',
    searchColumns: ['Category', 'Issue', 'Keywords', 'Description'],
    outputColumns: [
      'Category', 'Issue', 'Platform', 'Description', 'Do', "Don't", 'Code Example Good', 'Code Example Bad', 'Severity',
    ],
  },
}

/**
 * Auxiliary product-reasoning profiles used by the design-system aggregator, not a
 * directly routed search domain. Empty `Reasoning`/`Confidence` fields are omitted:
 * an empty cell is not a measured explanation or a confidence estimate.
 */
export const UI_REASONING_TABLE: DomainTable = {
  file: 'ui-reasoning.csv',
  searchColumns: [
    'UI_Category', 'Recommended_Pattern', 'Style_Priority', 'Color_Mood', 'Typography_Mood',
    'Key_Effects', 'Decision_Rules', 'Anti_Patterns',
  ],
  outputColumns: [
    'UI_Category', 'Recommended_Pattern', 'Style_Priority', 'Color_Mood', 'Typography_Mood',
    'Key_Effects', 'Decision_Rules', 'Anti_Patterns', 'Severity',
  ],
}

/** Every stack table's columns; a stack table is one file per framework under `stacks/`. */
export const STACK_COLUMNS: DomainTable = {
  file: 'stacks',
  searchColumns: ['Category', 'Guideline', 'Description', 'Do', "Don't", 'Code Good', 'Code Bad'],
  outputColumns: [
    'Category', 'Guideline', 'Description', 'Do', "Don't", 'Code Good', 'Code Bad', 'Severity', 'Docs URL',
    'Applies To', 'Status', 'Verified At',
  ],
}

/** The stacks the catalog carries, as upstream's stack table names them. */
export const STACKS: readonly string[] = [
  'react', 'nextjs', 'vue', 'svelte', 'astro', 'swiftui', 'react-native', 'flutter', 'nuxtjs', 'nuxt-ui',
  'html-tailwind', 'shadcn', 'jetpack-compose', 'threejs', 'angular', 'laravel', 'javafx', 'wpf', 'winui',
  'avalonia', 'uno', 'uwp',
]

/**
 * Measured minimum top score per domain.
 *
 * A domain absent from this map has no score floor. That is not an oversight to
 * tidy up: `product` floors at 6.0 and `color` at 0.0 because the corpora differ in
 * size and in document length, and the honest consequence is that some domains can
 * answer on a weak match while others refuse one.
 */
export const DEFAULT_SCORE_FLOORS: Readonly<Partial<Record<Domain, number>>> = {
  style: 4.3,
  landing: 4.0,
  product: 6.0,
  icons: 5.8,
  react: 3.3,
}

/** Minimum token coverage per domain. Only `landing` demands it. */
const DOMAIN_COVERAGE_FLOORS: Readonly<Partial<Record<Domain, number>>> = { landing: 0.5 }

/** Identifies the thresholds a decision used, so a result can be attributed to them. */
export const CALIBRATION_VERSION = '2026-08-12-v1'

/** Results per search unless a caller asks for fewer or more. */
export const DEFAULT_MAX_RESULTS = 3

/** Largest result count a caller may ask for. */
export const MAX_MAX_RESULTS = 20

/** A threshold that refuses nothing, used where a caller has already narrowed the rows. */
export const NO_THRESHOLD: CalibratedThreshold = { minScore: 0, minMargin: 0, minCoverage: 0 }

/**
 * The stack threshold, measured like the domain floors and separate from all of them.
 *
 * It is a function rather than a constant because the three numbers are one decision:
 * a stack table's documents are longer than a single domain row's, so a stack match
 * that clears 3.6 can still be the wrong guideline, which is what the coverage third
 * is for.
 *
 * @returns the floors a stack search must clear.
 */
export function stackThreshold(): CalibratedThreshold {
  return { minScore: 3.6, minMargin: 0, minCoverage: 1 / 3 }
}

/**
 * The threshold a domain's search must clear.
 *
 * @param domain - the domain being searched.
 * @returns its measured floors.
 */
export function thresholdForDomain(domain: Domain): CalibratedThreshold {
  return {
    minScore: DEFAULT_SCORE_FLOORS[domain] ?? 0,
    minMargin: 0,
    minCoverage: DOMAIN_COVERAGE_FLOORS[domain] ?? 0,
  }
}

/**
 * Whether a requested result count is one this catalog will answer.
 *
 * An unchecked count is how a caller turns a three-row answer into a whole table in
 * the transcript; the bound is the one upstream enforced, and it is checked where
 * the answer is formed rather than only where the tool's schema says so.
 *
 * @param value - the caller's requested count, of unknown type.
 * @returns true when it is an integer within the accepted range.
 */
export function isValidMaxResults(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_MAX_RESULTS
}

/**
 * The classification of a product type, seeded from the table the catalog ships.
 *
 * `products.csv` also carries product labels, and the loader replaces this list with
 * them when it reads the table. The seed stays because a catalog read without its
 * product table can still route a query by its industry words, and a router that
 * refused to classify anything would send every such query to the style domain.
 */
export const PRODUCT_KEYWORD_SEED: readonly string[] = [
  'saas', 'ecommerce', 'fintech', 'healthcare', 'gaming', 'portfolio',
  'crypto', 'fitness', 'marketplace', 'banking', 'cybersecurity',
  'education', 'travel', 'restaurant', 'real estate', 'social media',
  'beauty', 'spa', 'salon', 'wellness', 'booking',
]

/**
 * Domain-specific vocabulary, used to route a query and to rewrite it.
 *
 * The entries are routing vocabulary, not search vocabulary: they are the words a
 * person uses when they mean `color` or `gsap`, and several of them are deliberately
 * *not* in the corpus, which is why `rewriteQueryForDomain` exists.
 *
 * @param productKeywords - the product table's own labels, when the loader has read them.
 * @returns each domain's phrases, longest first.
 */
export function domainKeywords(
  productKeywords: readonly string[] = PRODUCT_KEYWORD_SEED,
): Readonly<Record<Domain, readonly string[]>> {
  return {
    color: ['color', 'palette', 'hex', 'rgb', 'token', 'semantic', 'accent', 'destructive', 'muted', 'foreground'],
    chart: ['time series', 'chart', 'graph', 'visualization', 'trend', 'bar chart', 'pie', 'scatter', 'heatmap', 'funnel', 'forecast'],
    landing: ['landing', 'page', 'cta', 'conversion', 'hero', 'testimonial', 'pricing', 'section'],
    product: [...productKeywords].sort((left, right) => right.length - left.length),
    style: [
      'style', 'design', 'ui', 'minimalism', 'glassmorphism', 'neumorphism', 'brutalism', 'dark mode', 'flat',
      'aurora', 'css', 'implementation', 'variable', 'checklist', 'tailwind',
    ],
    ux: ['ux', 'usability', 'accessibility', 'wcag', 'touch', 'scroll', 'animation', 'keyboard', 'navigation', 'mobile'],
    typography: ['font pairing', 'typography pairing', 'heading font', 'body font'],
    icons: ['icon', 'icons', 'lucide', 'phosphor', 'heroicons', 'symbol', 'glyph', 'pictogram', 'svg icon'],
    gsap: [
      'gsap', 'quickto', 'scrolltrigger', 'stagger', 'magnetic cursor', 'parallax', 'page transition', 'scroll reveal',
      'scroll-triggered', 'scrollytelling', 'flip plugin', 'splittext', 'shimmer', 'skeleton loader',
    ],
    react: [
      'react', 'next.js', 'nextjs', 'suspense', 'memo', 'usecallback', 'useeffect', 'rerender', 'bundle', 'waterfall',
      'barrel', 'dynamic import', 'rsc', 'server component',
    ],
    web: [
      'aria', 'focus', 'outline', 'semantic', 'virtualize', 'autocomplete', 'form', 'input type', 'preconnect',
      'drag reorder', 'single pointer', 'touch target', 'native accessibility',
    ],
  }
}

/**
 * Query vocabulary that is rewritten before it reaches a corpus that lacks it.
 *
 * A `null` value means the term carries no signal inside that domain and is dropped
 * rather than replaced — `css` for a style row, `hex` for a palette, `lucide` for
 * the curated icon table, which only carries Phosphor rows.
 */
const DOMAIN_QUERY_REWRITES: Readonly<Partial<Record<Domain, Readonly<Record<string, string | null>>>>> = {
  color: Object.fromEntries(
    ['color', 'palette', 'hex', 'rgb', 'token', 'semantic', 'destructive', 'muted', 'foreground'].map(term => [term, null]),
  ),
  landing: { testimonial: 'testimonials' },
  style: Object.fromEntries(['css', 'implementation', 'variable', 'checklist', 'tailwind'].map(term => [term, null])),
  ux: { ux: 'accessibility', usability: 'accessibility', wcag: 'accessibility' },
  icons: Object.fromEntries(['lucide', 'symbol', 'glyph', 'pictogram'].map(term => [term, null])),
  gsap: { gsap: 'animation', quickto: null, scrolltrigger: 'scroll', 'flip plugin': null, splittext: null },
  react: { nextjs: 'react', usecallback: 'memoization', useeffect: 'effects' },
  web: { aria: 'accessibility', outline: 'focus', semantic: null, autocomplete: 'input', preconnect: null },
}

/** Escape a literal for a pattern. @param text - the literal. @returns the escaped literal. */
function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Whether a phrase occurs in text as words rather than as a substring.
 *
 * The substring form is only used for a phrase with no word character at all, where
 * a boundary means nothing; every other phrase is matched at token boundaries, so
 * `spa` cannot be found inside `spatial`.
 *
 * @param text - the text to search, already lowered.
 * @param phrase - the phrase to look for.
 * @returns true when the phrase occurs on its own boundaries.
 */
export function containsPhrase(text: string, phrase: string): boolean {
  if (!/\w/u.test(phrase)) return text.includes(phrase)
  return new RegExp(`(?<!\\w)${escapeForPattern(phrase)}(?!\\w)`, 'u').test(text)
}

/** Auto-detection's outcome, including the domain that nearly won. */
export interface DetectedDomain {
  /** The domain whose vocabulary the query matches most specifically. */
  readonly domain: Domain
  /** The next-best domain, when it scored above zero; the reader's warning that routing was close. */
  readonly runnerUp: Domain | undefined
}

/**
 * Route a query to a domain.
 *
 * Weighting is by how many words a matched phrase has, because a longer phrase is a
 * more specific statement of intent: `dark mode` says more about the answer than
 * `design` does. Ties fall back to a fixed order rather than to iteration order, so
 * the same query routes the same way on every run — an auto-detected domain that
 * depended on hash order would make a recommendation irreproducible.
 *
 * @param query - the user's request.
 * @param productKeywords - the product table's labels, when they have been read.
 * @returns the winning domain and its runner-up.
 */
export function detectDomain(
  query: string,
  productKeywords: readonly string[] = PRODUCT_KEYWORD_SEED,
): DetectedDomain {
  const lowered = query.toLowerCase()
  const keywords = domainKeywords(productKeywords)
  const scores = new Map<Domain, number>()
  for (const domain of Object.keys(keywords) as Domain[]) {
    let total = 0
    for (const phrase of keywords[domain]) {
      if (!containsPhrase(lowered, phrase)) continue
      const specificity = Math.max(1, phrase.split(/\s+/u).length)
      // The product table's own labels are `product`'s vocabulary *and* every
      // industry word a query can use about any domain, so counting them double
      // would make `product` win every industry query outright.
      total += domain === 'product' ? specificity : 2 * specificity
    }
    scores.set(domain, total)
  }
  if (/(?<!\w)#[0-9a-f]{3,8}(?!\w)/u.test(lowered)) scores.set('color', (scores.get('color') ?? 0) + 2)
  const ranked = [...scores.entries()].sort((left, right) =>
    right[1] - left[1] || tiebreakRank(left[0]) - tiebreakRank(right[0]))
  // The default states what an empty vocabulary would mean rather than asserting the
  // map cannot be empty. It cannot, today: every domain above is a key of it.
  const best = ranked[0] ?? (['style', 0] as const)
  const runnerUp = ranked[1]
  return {
    // A query with no recognisable vocabulary at all falls to `style`, which is the
    // domain with the most general rows rather than the one with the fewest.
    domain: best[1] > 0 ? best[0] : 'style',
    runnerUp: runnerUp !== undefined && runnerUp[1] > 0 ? runnerUp[0] : undefined,
  }
}

/** Tie-break position per domain; a domain absent here sorts last. */
const DOMAIN_TIEBREAK_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  (['ux', 'product', 'style', 'color', 'typography', 'chart', 'landing', 'icons', 'gsap', 'react', 'web'] as const)
    .map((domain, position) => [domain, position]),
)

/**
 * A domain's tie-break position, with an unlisted domain sorting after every listed one.
 *
 * The fallback is a number rather than `undefined` because a comparator that returns
 * `NaN` is read as *equal*, which would leave two unlisted domains in whatever order
 * the map happened to hold — the state `detectDomain` exists to avoid.
 *
 * @param domain - the domain to place.
 * @returns its position, or 999 for a domain the order does not name.
 */
function tiebreakRank(domain: string): number {
  return DOMAIN_TIEBREAK_RANK[domain] ?? 999
}

/** What a domain rewrite decided. */
export interface RewrittenQuery {
  /** The query to search with, with replacement terms appended. */
  readonly searchQuery: string
  /** The rewrites that fired, as `term->replacement`, sorted. */
  readonly rewrites: readonly string[]
}

/**
 * Rewrite routing vocabulary out of a query before scoring it.
 *
 * Only terms the corpus has never seen are touched, and only when the domain table
 * names a replacement for them: a query about a *palette* should score against
 * palette rows rather than against the word "palette", while a query word the corpus
 * already carries is left alone because the corpus can rank it.
 *
 * @param query - the query as the user asked it.
 * @param domain - the domain it routed to, which owns the rewrite table.
 * @param vocabulary - the terms the domain's corpus contains.
 * @returns the query to run, and the rewrites applied.
 */
export function rewriteQueryForDomain(
  query: string,
  domain: Domain,
  vocabulary: ReadonlySet<string>,
): RewrittenQuery {
  const table = DOMAIN_QUERY_REWRITES[domain]
  if (table === undefined) return { searchQuery: query, rewrites: [] }
  const normalized = query.toLowerCase()
  const replacements = new Set<string>()
  const rewrites = new Set<string>()
  for (const [term, replacement] of Object.entries(table)) {
    if (!containsPhrase(normalized, term)) continue
    if ([...new Set(tokenizeForRouting(term))].some(token => vocabulary.has(token))) continue
    if (replacement === null) {
      // Dropped rather than replaced: the term is noise in this domain and the
      // caller's other words are the query. Nothing is recorded as a rewrite,
      // because nothing takes its place.
      continue
    }
    rewrites.add(`${term}->${replacement}`)
    replacements.add(replacement)
  }
  if (replacements.size === 0) return { searchQuery: query, rewrites: [] }
  const appended = [...replacements].sort().join(' ')
  return { searchQuery: `${query} ${appended}`, rewrites: [...rewrites].sort() }
}

/**
 * The tokenizer this module needs for routing, kept free of the index.
 *
 * It is the same boundary rule `bm25.ts` uses, and it is duplicated here on purpose:
 * importing the tokenizer would make the router's decision depend on the search
 * module, and routing is what decides *which* search module call is made.
 *
 * @param text - the text to split.
 * @returns the tokens, lowercased, with two-character and shorter words dropped.
 */
function tokenizeForRouting(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ')
    .split(/\s+/u)
    .filter(word => word !== '' && Array.from(word).length >= 2)
}
