/**
 * React Bits, read from upstream rather than carried here.
 *
 * Why this module fetches instead of vendoring
 * --------------------------------------------
 * Every other design capability in this package ships its knowledge as assets:
 * the catalogue is 34 CSVs inside the package, the HyperFrames pack is a mounted
 * Skill directory, and the Impeccable detector names the rules it can decide
 * itself. React Bits is the one that cannot work that way, and the reason is its
 * licence rather than its shape. `LICENSE.md` is MIT **plus the Commons Clause**:
 *
 * > You may use this Software, including for any commercial purpose, so long as
 * > you do not sell, sublicense, or redistribute the components themselves —
 * > whether alone, in a bundle, or as a ported version.
 *
 * Using a component inside an application is exactly what the licence permits,
 * and that is what a user of this plugin is doing. **Redistributing the
 * components is what it forbids**, and a copy inside this package's assets would
 * be a redistribution — which is why nothing here is written to disk, nothing is
 * copied into `assets/`, and no port of any component exists in this repository.
 * The upstream registry is the source, the user's own project is the destination,
 * and this module is the transport.
 *
 * What upstream publishes (verified against the live registry)
 * -----------------------------------------------------------
 *  - `GET https://reactbits.dev/r/registry.json` — a shadcn registry index: one
 *    entry per component *and variant* (`CountUp-TS-TW`) with its title,
 *    description, exact dependency ranges and file paths, and no source. This is
 *    the catalogue: 200+ components across four variants each.
 *  - `GET https://reactbits.dev/r/<Component>-<LANG>-<STYLE>` — a shadcn
 *    `registry-item.json` carrying the files *with their contents*.
 *
 * The two documents are read defensively. Upstream's schema is shadcn's, which is
 * a public standard rather than something this package can iterate on, so a
 * document that does not have the shape this module understands is reported as
 * such instead of being summarized into silence — the same rule the Impeccable
 * engine reader follows.
 *
 * Caching
 * -------
 * The index is held in memory for a short window so that a search followed by a
 * fetch does not download it twice. It is **never written to disk**, for the
 * licence reason above: a stored copy is a redistribution, and a cache with a
 * path is a bundle with a different name.
 *
 * @module reactbits/registry
 */

import { isRecord } from '../untrusted-json.ts'

/** Where the registry lives. One constant, so the tool and the card cannot disagree. */
export const REACTBITS_ORIGIN = 'https://reactbits.dev'

/** The catalogue index, one entry per component and variant. */
export const REACTBITS_INDEX_URL = `${REACTBITS_ORIGIN}/r/registry.json`

/**
 * The URL one variant's registry item lives at.
 *
 * @param name - the variant's index name, e.g. `CountUp-TS-TW`.
 * @returns the absolute URL the item document is served from.
 */
export function reactbitsItemUrl(name: string): string {
  return `${REACTBITS_ORIGIN}/r/${encodeURIComponent(name)}`
}

/** The two languages a variant may be written in. */
export const REACTBITS_LANGUAGES = ['js', 'ts'] as const

/** The two styling approaches a variant may use, spelled as a caller asks for them. */
export const REACTBITS_STYLES = ['css', 'tailwind'] as const

/**
 * The style token a variant name carries, mapped to the styling approach it means.
 *
 * The name grammar abbreviates Tailwind to `TW`, so the two vocabularies have to
 * be related somewhere: `tailwind` is what a caller asks for and `TW` is what the
 * registry spells, and a reader that compared them directly would find no Tailwind
 * variant at all — the one variant most callers want.
 */
const STYLE_TOKENS: Readonly<Record<string, ReactBitsStyle>> = { css: 'css', tw: 'tailwind' }

/** One language a variant may be written in. */
export type ReactBitsLanguage = (typeof REACTBITS_LANGUAGES)[number]

/** One styling approach a variant may use. */
export type ReactBitsStyle = (typeof REACTBITS_STYLES)[number]

/** How long an index fetched once is reused, in milliseconds. */
const INDEX_TTL_MS = 5 * 60 * 1000

/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 15_000

/** Largest document this module will parse, so a hostile response cannot fill memory. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/** One file inside a registry item. */
export interface ReactBitsFile {
  /** Path as upstream names it, e.g. `CountUp/CountUp.tsx`. */
  readonly path: string
  /** shadcn's file kind, e.g. `registry:component`. */
  readonly type: string
  /** The source, when the document carried it. */
  readonly content: string
}

/** One catalogue entry: a component in one of its four variants. */
export interface ReactBitsIndexEntry {
  /** The variant's own name, e.g. `CountUp-TS-TW`. */
  readonly name: string
  /** The component's name, shared by its other three variants, e.g. `CountUp`. */
  readonly title: string
  readonly description: string
  /** Exact ranges upstream requires, e.g. `motion@^12.23.12`. */
  readonly dependencies: readonly string[]
  /** Other registry items this one pulls in. */
  readonly registryDependencies: readonly string[]
  /** The files this variant writes, without their contents. */
  readonly files: readonly { readonly path: string; readonly type: string }[]
}

/** A fetched variant, with its source. */
export interface ReactBitsItem extends ReactBitsIndexEntry {
  /** The files, contents included. */
  readonly files: readonly ReactBitsFile[]
}

/** The registration entry a variant name decomposes into. */
export interface ReactBitsVariant {
  readonly component: string
  readonly language: ReactBitsLanguage
  readonly style: ReactBitsStyle
  /** The index spelling, e.g. `CountUp-TS-TW`. */
  readonly name: string
}

/** How a document read failed, or that it was read. */
export interface ReactBitsDocument<T> {
  readonly value?: T
  /** Set when the document could not be read at all. */
  readonly failure?: string
  /** Set when the document was read but is not the shape this module understands. */
  readonly unexpectedShape?: string
  /** The URL it came from, so a refusal can name its source. */
  readonly url: string
}

/** The fetch this module uses, injectable so no test needs the network. */
export type ReactBitsFetcher = (url: string) => Promise<string>

/**
 * The default fetch: JSON over HTTPS, with a deadline and a document ceiling.
 *
 * The ceiling is a memory bound rather than a policy: the caller is upstream's
 * own registry, and a single document that cannot be parsed is reported as an
 * unrecognized shape rather than allowed to fill the process.
 *
 * @param url - the document to read.
 * @returns the response body as text.
 * @throws when the response is not a success, or the body is over the ceiling.
 */
export const fetchRegistryDocument: ReactBitsFetcher = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} ${response.statusText}`.trim())
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error(`document is larger than ${String(MAX_DOCUMENT_BYTES)} bytes`)
  }
  return body
}

/** A string field, or `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** A list of strings, empty when the field is absent. */
function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * One index entry, or `undefined` when the row is not one.
 *
 * A row without a name or a title is skipped rather than guessed at: every later
 * step — search, variant decomposition, the URL a fetch is built from — is
 * derived from those two fields, so a row missing either is not an entry with a
 * gap but a row this reader does not understand.
 */
function indexEntry(row: unknown): ReactBitsIndexEntry | undefined {
  if (!isRecord(row)) return undefined
  const name = text(row.name)
  const title = text(row.title)
  if (name === undefined || title === undefined) return undefined
  return {
    name,
    title,
    description: text(row.description) ?? '',
    dependencies: strings(row.dependencies),
    registryDependencies: strings(row.registryDependencies),
    files: Array.isArray(row.files)
      ? row.files.flatMap((file) => {
        if (!isRecord(file)) return []
        const path = text(file.path)
        return path === undefined ? [] : [{ path, type: text(file.type) ?? 'registry:component' }]
      })
      : [],
  }
}

/**
 * Read the catalogue index.
 *
 * @param url - the document to read; defaults to upstream's index.
 * @param run - the fetch, injectable for tests.
 * @returns the entries, or why the document could not be used.
 */
export async function readRegistryIndex(
  url: string = REACTBITS_INDEX_URL,
  run: ReactBitsFetcher = fetchRegistryDocument,
): Promise<ReactBitsDocument<readonly ReactBitsIndexEntry[]>> {
  const raw = await run(url).then(body => ({ body }), (error: unknown) => ({ error }))
  if ('error' in raw) {
    return { url, failure: raw.error instanceof Error ? raw.error.message : String(raw.error) }
  }
  let document: unknown
  try {
    document = JSON.parse(raw.body)
  } catch {
    return { url, unexpectedShape: 'the response was not JSON' }
  }
  if (!isRecord(document) || !Array.isArray(document.items)) {
    return { url, unexpectedShape: 'the document has no `items` array' }
  }
  const entries = document.items.flatMap((row) => {
    const entry = indexEntry(row)
    return entry === undefined ? [] : [entry]
  })
  if (entries.length === 0) return { url, unexpectedShape: 'the `items` array held no entry with a name and a title' }
  return { url, value: entries }
}

/**
 * Read one variant's registry item, contents included.
 *
 * @param name - the variant's index name, e.g. `CountUp-TS-TW`.
 * @param run - the fetch, injectable for tests.
 * @returns the item, or why the document could not be used.
 */
export async function readRegistryItem(
  name: string,
  run: ReactBitsFetcher = fetchRegistryDocument,
): Promise<ReactBitsDocument<ReactBitsItem>> {
  const url = reactbitsItemUrl(name)
  const raw = await run(url).then(body => ({ body }), (error: unknown) => ({ error }))
  if ('error' in raw) {
    return { url, failure: raw.error instanceof Error ? raw.error.message : String(raw.error) }
  }
  let document: unknown
  try {
    document = JSON.parse(raw.body)
  } catch {
    // Upstream's site answers an unknown path with its SPA shell, which parses as
    // neither JSON nor a registry item — so the two cases are told apart here
    // rather than reported as one broken document.
    return { url, unexpectedShape: 'the response was not JSON, which is how an unknown variant is answered' }
  }
  const entry = indexEntry(document)
  if (entry === undefined || !isRecord(document)) {
    return { url, unexpectedShape: 'the document names no component' }
  }
  const files = Array.isArray(document.files)
    ? document.files.flatMap((file) => {
      if (!isRecord(file)) return []
      const path = text(file.path)
      const content = text(file.content)
      if (path === undefined || content === undefined) return []
      return [{ path, type: text(file.type) ?? 'registry:component', content }]
    })
    : []
  if (files.length === 0) return { url, unexpectedShape: 'the document carried no file with contents' }
  return { url, value: { ...entry, files } }
}

/**
 * Decompose a variant name into its parts.
 *
 * The name is the registry's own grammar — `<Component>-<LANG>-<STYLE>` — and the
 * component half may itself contain dashes, which is why the last two segments
 * are read from the end rather than the first two from the start.
 *
 * @param name - an index name such as `CountUp-TS-TW`.
 * @returns the parts, or `undefined` when the name is not a variant.
 */
export function parseVariantName(name: string): ReactBitsVariant | undefined {
  const segments = name.split('-')
  if (segments.length < 3) return undefined
  const styleSegment = segments[segments.length - 1]?.toLowerCase()
  const languageSegment = segments[segments.length - 2]?.toLowerCase()
  const component = segments.slice(0, -2).join('-')
  if (component === '') return undefined
  const language = REACTBITS_LANGUAGES.find(candidate => candidate === languageSegment)
  const style = styleSegment === undefined ? undefined : STYLE_TOKENS[styleSegment]
  if (language === undefined || style === undefined) return undefined
  return { component, language, style, name }
}

/**
 * The index name for one component and variant, as upstream spells it.
 *
 * @param component - the component's own name, e.g. `CountUp`.
 * @param language - `js` or `ts`.
 * @param style - `css` or `tailwind`, which is written into the name as `CSS`/`TW`.
 * @returns the registry variant name, e.g. `CountUp-TS-TW`.
 */
export function variantName(component: string, language: ReactBitsLanguage, style: ReactBitsStyle): string {
  return `${component}-${language.toUpperCase()}-${style === 'tailwind' ? 'TW' : 'CSS'}`
}

/**
 * A component title as a URL slug.
 *
 * Upstream's own mapping is not mechanical — the docs list `ASCIIText` under
 * `ascii-text` — so the acronym run has to survive: inserting a dash only before
 * a capital that follows a lowercase letter or a digit would turn `ASCIIText`
 * into `asciitext`, and the first rule below handles the acronym-to-word boundary
 * that makes it `ascii-text`.
 *
 * @param title - the component name, e.g. `ASCIIText`.
 * @returns the slug, e.g. `ascii-text`.
 */
export function slugifyTitle(title: string): string {
  return title
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .toLowerCase()
}

/**
 * Whether a catalogue entry mentions a query anywhere a caller would look.
 *
 * The two halves are separate on purpose: the slug is a title with its boundaries
 * spelled out (`ASCIIText` → `ascii-text`), so a slug match answers a name the
 * caller typed, while a prose match answers the subject they described — "counts up
 * when it enters the viewport" is how a caller who does not know the name arrives.
 *
 * @param entry - the index row.
 * @param slug - the query as a slug.
 * @param word - the query lowercased, for prose.
 * @returns whether this row is a candidate.
 */
function mentions(entry: ReactBitsIndexEntry, slug: string, word: string): boolean {
  return slugifyTitle(entry.title).includes(slug) || entry.description.toLowerCase().includes(word)
}

/** How a component query was understood, and what it resolved to. */
export interface ReactBitsResolution {
  readonly component: string
  readonly candidates: readonly ReactBitsIndexEntry[]
  /** Whether the query named exactly one component. */
  readonly exact: boolean
}

/**
 * Resolve a component query against the catalogue.
 *
 * A caller may name the variant (`CountUp-TS-TW`), the component (`CountUp`), or
 * the documentation slug (`count-up`) — all three appear in upstream's own
 * surfaces, and a tool that accepted only one of them would refuse the spelling
 * the user just read in the docs. The order is exact-name, then slug, then
 * case-insensitive title, and a substring match is offered as candidates rather
 * than picked from: choosing between `BlurText` and `DropText` for the query
 * `text` is a guess, and the caller can say which one it meant.
 *
 * @param entries - the catalogue.
 * @param query - what the caller named.
 * @returns the component it resolved to and the variants that carry it, with
 *          `exact` false when the answer is a candidate list.
 */
export function resolveComponent(entries: readonly ReactBitsIndexEntry[], query: string): ReactBitsResolution {
  const trimmed = query.trim()
  const byName = entries.find(entry => entry.name.toLowerCase() === trimmed.toLowerCase())
  const component = byName?.title
    ?? entries.find(entry => slugifyTitle(entry.title) === slugifyTitle(trimmed))?.title
    ?? entries.find(entry => entry.title.toLowerCase() === trimmed.toLowerCase())?.title
  if (component !== undefined) {
    return { component, candidates: entries.filter(entry => entry.title === component), exact: true }
  }
  const needle = slugifyTitle(trimmed)
  const word = trimmed.toLowerCase()
  const loose = entries.filter(entry => mentions(entry, needle, word))
  const titles = [...new Set(loose.map(entry => entry.title))]
  return { component: titles.length === 1 ? titles[0] as string : '', candidates: loose, exact: false }
}

/** One search hit, with its variants collapsed into one row. */
export interface ReactBitsSearchHit {
  readonly title: string
  readonly description: string
  /** Every variant upstream publishes for this component, in index order. */
  readonly variants: readonly string[]
  readonly files: readonly string[]
  /** The union of what its variants require, exact ranges included. */
  readonly dependencies: readonly string[]
  /** The registration names that share this hit's dependency set, for a caller that wants one command. */
  readonly requiresNothing: boolean
}

/** How a search was run and what it looked at. */
export interface ReactBitsSearchReport {
  readonly hits: readonly ReactBitsSearchHit[]
  /** How many components matched before the limit was applied. */
  readonly matched: number
  readonly inspected: number
}

/**
 * Search the catalogue by keyword, and fold each component's four variants into
 * one row.
 *
 * Folding rather than listing is what makes the answer usable: the index is
 * variant-first, so a raw filter for `text` returns four near-identical rows per
 * component and buries the description a caller is deciding on. The variants are
 * kept, because the caller's next question is which one to fetch.
 *
 * A variant's own name is matched **whole** rather than by substring, and that
 * asymmetry is deliberate. `get` and `apply` accept `CountUp-TS-TW` and `count-up`
 * alike, so a search that could not find the string they do accept would be a tool
 * refusing its own vocabulary — but a name searched by substring would answer
 * every `ts` variant for the keyword `ts`, which is the one query whose hits are
 * all four variants of everything. Whole-name matching finds the spelling a caller
 * copied out of the docs without turning the index into a list of itself.
 *
 * @param entries - the catalogue.
 * @param query - the keyword, matched against title, description, dependencies
 *                and a variant name in full.
 * @param options - the result limit and whether to keep only components that need
 *                  no package beyond React itself.
 * @returns the hits, how many matched, and how many entries were inspected.
 */
export function searchCatalogue(
  entries: readonly ReactBitsIndexEntry[],
  query: string,
  options: { readonly limit: number; readonly dependencyFree?: boolean },
): ReactBitsSearchReport {
  const words = query.toLowerCase().split(/\s+/u).filter(word => word !== '')
  const normalized = query.trim().toLowerCase()
  const scored = entries.filter((entry) => {
    if (options.dependencyFree === true && entry.dependencies.length > 0) return false
    // The spelling `get` and `apply` accept, so searching it finds it rather than
    // reporting that the catalogue holds nothing under a name it publishes.
    if (entry.name.toLowerCase() === normalized) return true
    const haystack = `${entry.title} ${entry.description} ${entry.dependencies.join(' ')}`.toLowerCase()
    return words.every(word => haystack.includes(word))
  })

  const grouped = new Map<string, ReactBitsIndexEntry[]>()
  for (const entry of scored) {
    const rows = grouped.get(entry.title)
    if (rows === undefined) grouped.set(entry.title, [entry])
    else rows.push(entry)
  }

  const hits = [...grouped].map(([title, rows]): ReactBitsSearchHit => {
    const first = rows[0] as ReactBitsIndexEntry
    return {
      title,
      description: first.description,
      variants: rows.map(row => row.name),
      files: [...new Set(rows.flatMap(row => row.files.map(file => file.path)))].sort(),
      // The union across variants, because a component's Tailwind build can carry a
      // package its CSS build does not (the reverse too), and a caller who reads
      // only one of them would install the wrong set.
      dependencies: [...new Set(rows.flatMap(row => row.dependencies))].sort(),
      requiresNothing: rows.every(row => row.dependencies.length === 0),
    }
  })
  // Dependency-free first, then alphabetical: a caller looking for a cheap effect
  // should not have to read a page of three.js wrappers to find one.
  hits.sort((left, right) => Number(right.requiresNothing) - Number(left.requiresNothing) || left.title.localeCompare(right.title))
  return { hits: hits.slice(0, options.limit), matched: hits.length, inspected: entries.length }
}

/** Where one document came from, so a result can say how old its answer is. */
export interface ReactBitsSource {
  readonly url: string
  /** ISO timestamp of the fetch that produced it. */
  readonly fetchedAt: string
}

/** A catalogue held in memory between calls. */
interface IndexCache {
  readonly entries: readonly ReactBitsIndexEntry[]
  readonly source: ReactBitsSource
}

/**
 * A catalogue reader that holds one index in memory for a short window.
 *
 * Created per tool registration rather than kept at module scope, so a disposed
 * pack leaves nothing behind and a test can hold its own reader without reaching
 * into a global. Nothing here touches the filesystem: see this module's header.
 */
export class ReactBitsCatalogue {
  private cache: IndexCache | undefined

  /** @param run - the fetch, injectable for tests. @param now - the clock, injectable for the TTL case. */
  constructor(
    private readonly run: ReactBitsFetcher = fetchRegistryDocument,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The catalogue, from cache when it is fresh.
   *
   * @returns the entries and where they came from, or why they are unavailable.
   */
  async index(): Promise<ReactBitsDocument<readonly ReactBitsIndexEntry[]> & { readonly source?: ReactBitsSource }> {
    const cached = this.cache
    if (cached !== undefined && this.now() - Date.parse(cached.source.fetchedAt) < INDEX_TTL_MS) {
      return { url: cached.source.url, value: cached.entries, source: cached.source }
    }
    const read = await readRegistryIndex(REACTBITS_INDEX_URL, this.run)
    if (read.value === undefined) return read
    const source: ReactBitsSource = { url: read.url, fetchedAt: new Date(this.now()).toISOString() }
    this.cache = { entries: read.value, source }
    return { ...read, source }
  }

  /**
   * One variant, fetched fresh every time.
   *
   * The item is the thing the caller copies, and a stale copy of a component is
   * worse than a second request.
   *
   * @param name - the variant's index name.
   * @returns the item with its source, or why it is unavailable.
   */
  async item(name: string): Promise<ReactBitsDocument<ReactBitsItem> & { readonly source?: ReactBitsSource }> {
    const read = await readRegistryItem(name, this.run)
    if (read.value === undefined) return read
    return { ...read, source: { url: read.url, fetchedAt: new Date(this.now()).toISOString() } }
  }

  /** Forget what is held in memory. */
  clear(): void {
    this.cache = undefined
  }
}
