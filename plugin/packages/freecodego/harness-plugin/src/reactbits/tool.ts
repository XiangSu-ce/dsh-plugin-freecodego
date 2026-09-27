/**
 * The model-facing React Bits tool.
 *
 * One tool with three actions, because the capability is one gesture in three
 * steps: `search` reads the registry's index to answer *which* component, `get`
 * reads one variant to hand over its source, and `apply` writes that source into
 * the caller's project. Splitting them into separate tools would make each step
 * reachable without the one before it, and a caller of `get` who has not searched
 * is guessing at a name the registry spells in a way the docs do not — the docs
 * page says `count-up` and the registry says `CountUp-TS-TW`.
 *
 * What each action does to the world
 * ----------------------------------
 * `search` and `get` read the network and nothing else: no disk, no install, and
 * no copy of any component kept anywhere, which is the licence boundary described
 * in `registry.ts` — using a component is permitted, redistributing it (into this
 * package's assets, into a cache on disk, or as a re-spelled port) is not. Every
 * result carries the licence's two sentences, so the boundary travels with the code
 * into whatever conversation happens next.
 *
 * `apply` is the one action that writes, and it writes only where the caller
 * explicitly said: a destination directory inside the session working directory,
 * plus `confirm: true`. Both are required because this is the only step that cannot
 * be taken back by re-running it — an existing file's previous content is gone once
 * replaced — so the call has to say what it means. It writes the files upstream
 * publishes, with the two mechanical alterations `apply.ts` documents and no others,
 * leaves an existing file alone unless the caller asks for `if_exists: "replace"`,
 * and installs nothing: the packages are reported as exact ranges for the project's
 * own package manager.
 *
 * @module reactbits/tool
 */

import { isRecord } from '../untrusted-json.ts'
import { JSON_TOOL_OUTPUT, toolDefinition, type ToolDefinitionShape } from '../tool-definition.ts'
import {
  directoryRefusal,
  destinationPath,
  planReactBitsWrites,
  plannedNamesAreSafe,
  writeAsName,
  type ReactBitsConflictPolicy,
  type ReactBitsDirectivePolicy,
} from './apply.ts'
import { inspectVariant, type ReactBitsInspection } from './inspect.ts'
import {
  ReactBitsCatalogue,
  REACTBITS_ORIGIN,
  parseVariantName,
  resolveComponent,
  searchCatalogue,
  slugifyTitle,
  type ReactBitsIndexEntry,
  type ReactBitsItem,
  type ReactBitsSource,
} from './registry.ts'

/** Registered tool name; prefixed so Harness deferral and Plan Mode classify it. */
export const REACTBITS_TOOL_NAME = 'freecodego_reactbits'

/** Longest keyword this tool searches for. */
const QUERY_MAX_CHARS = 200

/** Longest component name or slug this tool resolves. */
const COMPONENT_MAX_CHARS = 120

/** Longest destination directory this tool accepts. */
const DIRECTORY_MAX_CHARS = 300

/** Most hits a search returns, and the ceiling a caller can ask for. */
const DEFAULT_LIMIT = 8
const LIMIT_CEILING = 20

/** Most props a `get` call may ask about, and the length of each. */
const PROPS_MAX = 24
const PROP_MAX_CHARS = 80

/** Largest single file returned, so one unusual registry item cannot flood the transcript. */
const FILE_MAX_CHARS = 400_000

/** The two sentences of upstream's licence that govern what a caller may do. */
const LICENSE = {
  name: 'MIT + Commons Clause',
  url: 'https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md',
  permits: '在自己的应用里使用与修改这些组件，包括商业项目。',
  forbids: '把组件本身再分发——单独分发、随包分发，或作为改写后的移植版分发。',
  note: '所以组件只落在你的项目里：本包不内置、不缓存、不再分发任何组件源码，也不会把它写进自己的 assets/。',
} as const

/** Arguments the model may pass. */
interface ReactBitsArgs {
  readonly action?: unknown
  readonly query?: unknown
  readonly component?: unknown
  readonly language?: unknown
  readonly style?: unknown
  readonly dependency_free?: unknown
  readonly limit?: unknown
  readonly props?: unknown
  readonly target?: unknown
  readonly directory?: unknown
  readonly confirm?: unknown
  readonly if_exists?: unknown
  readonly client_directive?: unknown
  readonly reduced_motion?: unknown
}

/** A call's execution context, as far as this tool needs it. */
interface ReactBitsToolExec {
  readonly signal?: AbortSignal
  readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } }
}

/**
 * The host seam `apply` needs, typed structurally.
 *
 * Only the `fs` service, and only the three members a write uses. Typed here rather
 * than imported so this module stays independent of the fs package's runtime graph,
 * the same way every other tool in this plugin reaches the seam — and so a host that
 * exposes a read-only service fails with a sentence rather than a missing method.
 */
export interface ReactBitsHost {
  get(name: string): unknown
}

/**
 * The subset of the host's `fs` service this tool reads and writes through.
 *
 * `writeText` is optional because a read-only installation is a real installation:
 * the action then refuses and says which half is missing, rather than throwing.
 */
export interface ReactBitsFileService {
  resolve(path: string): Promise<unknown>
  readText(target: unknown): Promise<string>
  writeText?(target: unknown, content: string, intent?: unknown, signal?: AbortSignal): Promise<unknown>
}

/** A refusal states what prevented the action from running, in the tool's own words. */
interface ReactBitsRefusal {
  readonly kind: 'refused'
  readonly action: string
  readonly reason: string
  readonly message: string
  /** Present when the refusal is about a name, so the caller can pick one instead of retrying blind. */
  readonly available?: readonly string[]
  /** Present when the refusal is about a destination, so the caller can see what it nearly wrote. */
  readonly wouldWrite?: readonly string[]
}

/** One file handed back to the caller. */
interface ReactBitsDeliveredFile {
  readonly path: string
  /** The file's name as it should be written, since `path` carries upstream's directory. */
  readonly writeAs: string
  readonly role: 'component' | 'style' | 'other'
  /** `false` when the file was too large to return and only its metadata came back. */
  readonly delivered: boolean
  readonly bytes: number
  readonly content?: string
  readonly truncated?: boolean
}

/** One catalogue hit as the tool reports it. */
interface ReactBitsCatalogueResult {
  readonly kind: 'catalogue'
  readonly action: 'search'
  readonly query: string
  readonly catalogue: { readonly url: string; readonly fetchedAt: string; readonly components: number; readonly entries: number }
  readonly matched: number
  readonly hits: readonly {
    readonly component: string
    readonly slug: string
    readonly description: string
    readonly variants: readonly string[]
    readonly dependencies: readonly string[]
    readonly files: readonly string[]
  }[]
  readonly notes: readonly string[]
}

/** One fetched variant as the tool reports it. */
interface ReactBitsComponentResult {
  readonly kind: 'component'
  readonly action: 'get'
  readonly component: string
  readonly slug: string
  readonly variant: { readonly name: string; readonly language: string; readonly style: string; readonly alternatives: readonly string[] }
  readonly source: ReactBitsSource
  readonly dependencies: readonly string[]
  readonly registryDependencies: readonly string[]
  readonly files: readonly ReactBitsDeliveredFile[]
  readonly inspection: ReactBitsInspection
  /** Present when the caller asked about props, so a component that lacks one says so. */
  readonly propChecks?: readonly { readonly prop: string; readonly present: boolean; readonly evidence?: string }[]
  readonly license: typeof LICENSE
  readonly next: string
  readonly notes: readonly string[]
}

/** One file `apply` wrote, and what it changed on the way. */
interface ReactBitsWrittenFile {
  readonly path: string
  readonly bytes: number
  /** The operation the file service reported: `create`, `update`, or `written`. */
  readonly operation: string
  readonly transformations: readonly { readonly id: string; readonly reason: string }[]
}

/** What `apply` wrote, skipped and could not write. */
interface ReactBitsAppliedResult {
  readonly kind: 'applied'
  readonly action: 'apply'
  readonly component: string
  readonly slug: string
  readonly variant: { readonly name: string; readonly language: string; readonly style: string }
  readonly source: ReactBitsSource
  /** The destination the caller named, and where it was resolved to. */
  readonly directory: string
  readonly resolvedDirectory: string
  readonly dependencies: readonly string[]
  readonly written: readonly ReactBitsWrittenFile[]
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
  readonly failed: readonly { readonly path: string; readonly reason: string }[]
  readonly followUps: readonly { readonly id: string; readonly message: string }[]
  readonly license: typeof LICENSE
  readonly next: string
  readonly notes: readonly string[]
}

/** The response union, so a caller can branch on `kind` rather than on fields. */
type ReactBitsResponse = ReactBitsCatalogueResult | ReactBitsComponentResult | ReactBitsAppliedResult | ReactBitsRefusal

/** A refusal in the sentence-shaped form the rest of this pack uses. */
function refused(
  action: string,
  reason: string,
  message: string,
  extra: { readonly available?: readonly string[]; readonly wouldWrite?: readonly string[] } = {},
): ReactBitsRefusal {
  return {
    kind: 'refused',
    action,
    reason,
    message,
    ...extra.available === undefined ? {} : { available: extra.available },
    ...extra.wouldWrite === undefined ? {} : { wouldWrite: extra.wouldWrite },
  }
}

/** A reason string for a read that failed, before or after the document was fetched. */
function readFailureReason(failure: string | undefined, unexpectedShape: string | undefined): string {
  if (failure !== undefined) return 'catalogue-unavailable'
  if (unexpectedShape !== undefined) return 'unexpected-document'
  return 'unreadable-catalogue'
}

/** The registry's role for a file, as `get` reports it. */
function roleOf(path: string): 'component' | 'style' | 'other' {
  if (/\.css$/u.test(path)) return 'style'
  if (/\.[jt]sx?$/u.test(path) || /\.vue$/u.test(path)) return 'component'
  return 'other'
}

/** Whether a component source mentions a prop in a usage or a declaration position. */
function propAppears(source: string, prop: string): string | undefined {
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`(?:\\b${escaped}\\s*[?=:]|:\\s*${escaped}\\b|['"]${escaped}['"]|<${escaped}\\b)`, 'u')
  const match = pattern.exec(source)
  if (match === null) return undefined
  const line = source.slice(0, match.index).split('\n').length
  return `第 ${String(line)} 行：${match[0].trim().slice(0, 80)}`
}

/** Run a catalogue search. */
async function runSearch(catalogue: ReactBitsCatalogue, args: ReactBitsArgs): Promise<ReactBitsResponse> {
  if (typeof args.query !== 'string' || args.query.trim() === '') {
    return refused('search', 'empty-query', 'Provide a non-empty keyword, e.g. a component name, an effect, or a dependency such as "gsap".')
  }
  const query = args.query.trim()
  if (query.length > QUERY_MAX_CHARS) {
    return refused('search', 'query-too-long', `The keyword exceeds ${String(QUERY_MAX_CHARS)} characters.`)
  }
  const limit = args.limit === undefined ? DEFAULT_LIMIT : args.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LIMIT_CEILING) {
    return refused('search', 'invalid-limit', `limit must be an integer from 1 to ${String(LIMIT_CEILING)}.`)
  }
  if (args.dependency_free !== undefined && typeof args.dependency_free !== 'boolean') {
    return refused('search', 'invalid-dependency-free', 'dependency_free must be a boolean.')
  }

  const read = await catalogue.index()
  if (read.value === undefined || read.source === undefined) {
    return refused('search', readFailureReason(read.failure, read.unexpectedShape),
      `The React Bits registry could not be read from ${read.url}: ${read.failure ?? read.unexpectedShape ?? 'unknown reason'}. This action needs the network; if this machine has none, fetch the component in a browser and add it by hand.`)
  }
  const report = searchCatalogue(read.value, query, {
    limit,
    ...args.dependency_free === true ? { dependencyFree: true } : {},
  })
  const notes: string[] = []
  if (report.hits.length === 0) {
    notes.push(`The catalogue holds ${String(read.value.length)} entries and none matched "${query}". Try a component name or a dependency name.`)
  } else {
    notes.push('These are index rows: names, descriptions, dependencies and file paths, no source. Call this tool again with action "get" for one component\'s source, or action "apply" to write it into the project.')
  }
  if (args.dependency_free === true) notes.push('Only components whose variants declare no package beyond React itself were kept.')

  return {
    kind: 'catalogue',
    action: 'search',
    query,
    catalogue: {
      url: read.source.url,
      fetchedAt: read.source.fetchedAt,
      components: new Set(read.value.map(entry => entry.title)).size,
      entries: read.value.length,
    },
    matched: report.matched,
    hits: report.hits.map(hit => ({
      component: hit.title,
      slug: slugifyTitle(hit.title),
      description: hit.description,
      variants: hit.variants,
      dependencies: hit.dependencies,
      files: hit.files,
    })),
    notes,
  }
}

/**
 * Resolve a caller's component name to that component's variants.
 *
 * Resolved to exactly one component or refused, never beyond that: the query may
 * be a registry variant, a component name, or a docs slug, and all three name one
 * component once the four variant rows are folded together. A query that folds to
 * several components is refused with the titles, because picking between
 * `BlurText` and `DropText` for "text" is a guess about what the caller wants.
 */
function resolveRequested(
  entries: readonly ReactBitsIndexEntry[],
  component: string,
): { readonly component: string; readonly variants: readonly ReactBitsIndexEntry[]; readonly partial: boolean }
  | { readonly refusal: ReactBitsRefusal } {
  const resolution = resolveComponent(entries, component)
  const titles = [...new Set(resolution.candidates.map(candidate => candidate.title))].sort()
  if (titles.length === 1) {
    const title = titles[0] as string
    return { component: title, variants: entries.filter(candidate => candidate.title === title), partial: !resolution.exact }
  }
  if (titles.length > 1) {
    return {
      refusal: refused('get', 'ambiguous-component',
        `"${component}" matches ${String(titles.length)} components. Name one of them exactly.`, { available: titles.slice(0, 20) }),
    }
  }
  return {
    refusal: refused('get', 'unknown-component',
      `The React Bits registry publishes no component named "${component}" or containing it. Search first to see the names it does publish.`),
  }
}

/** The language and style a call asked for, checked. */
function requestedVariant(action: string, args: ReactBitsArgs): { readonly language: 'js' | 'ts'; readonly style: 'css' | 'tailwind' } | { readonly refusal: ReactBitsRefusal } {
  const language = args.language ?? 'ts'
  if (language !== 'js' && language !== 'ts') return { refusal: refused(action, 'invalid-language', 'language must be "js" or "ts".') }
  const style = args.style ?? 'tailwind'
  if (style !== 'css' && style !== 'tailwind') return { refusal: refused(action, 'invalid-style', 'style must be "css" or "tailwind".') }
  return { language, style }
}

/** One fetched variant, with everything both actions report about it. */
interface ResolvedVariant {
  readonly asked: string
  readonly title: string
  readonly partial: boolean
  readonly language: 'js' | 'ts'
  readonly style: 'css' | 'tailwind'
  readonly chosen: string
  readonly variantNames: readonly string[]
  readonly item: ReactBitsItem
  readonly source: ReactBitsSource
}

/**
 * Resolve the component, pick its variant, and fetch that variant.
 *
 * Shared by `get` and `apply` so the two cannot disagree about which variant a
 * call means — a name resolved one way for reading and another for writing is the
 * kind of difference nobody would notice until a file did not compile.
 */
async function resolveVariant(
  catalogue: ReactBitsCatalogue,
  args: ReactBitsArgs,
  action: string,
): Promise<{ readonly resolved: ResolvedVariant } | { readonly refusal: ReactBitsRefusal }> {
  if (typeof args.component !== 'string' || args.component.trim() === '') {
    return { refusal: refused(action, 'missing-component', 'Provide the component to fetch, as a name ("CountUp"), a registry variant ("CountUp-TS-TW"), or the docs slug ("count-up").') }
  }
  const component = args.component.trim()
  if (component.length > COMPONENT_MAX_CHARS) {
    return { refusal: refused(action, 'component-too-long', `The component name exceeds ${String(COMPONENT_MAX_CHARS)} characters.`) }
  }
  const variant = requestedVariant(action, args)
  if ('refusal' in variant) return variant

  const index = await catalogue.index()
  if (index.value === undefined) {
    return {
      refusal: refused(action, readFailureReason(index.failure, index.unexpectedShape),
        `The React Bits registry could not be read from ${index.url}: ${index.failure ?? index.unexpectedShape ?? 'unknown reason'}. This action needs the network; if this machine has none, fetch the component in a browser and add it by hand.`),
    }
  }
  const resolved = resolveRequested(index.value, component)
  if ('refusal' in resolved) return { refusal: { ...resolved.refusal, action } }
  const { component: title, variants } = resolved
  const variantNames = variants.map(candidate => candidate.name).sort()
  const chosen = variants
    .map(candidate => ({ candidate, parts: parseVariantName(candidate.name) }))
    .find(entry => entry.parts !== undefined && entry.parts.language === variant.language && entry.parts.style === variant.style)
  if (chosen === undefined) {
    return {
      refusal: refused(action, 'unknown-variant',
        `"${title}" publishes no ${variant.language.toUpperCase()}/${variant.style} variant. Fetch one of the variants it does publish.`,
        { available: variantNames }),
    }
  }

  const read = await catalogue.item(chosen.candidate.name)
  if (read.value === undefined || read.source === undefined) {
    return {
      refusal: refused(action, readFailureReason(read.failure, read.unexpectedShape),
        `The registry item for ${chosen.candidate.name} could not be read from ${read.url}: ${read.failure ?? read.unexpectedShape ?? 'unknown reason'}.`,
        { available: variantNames }),
    }
  }

  return {
    resolved: {
      asked: component,
      title,
      partial: resolved.partial,
      language: variant.language,
      style: variant.style,
      chosen: chosen.candidate.name,
      variantNames,
      item: read.value,
      source: read.source,
    },
  }
}

/** Fetch one variant and hand its source back with the review. */
async function runGet(catalogue: ReactBitsCatalogue, args: ReactBitsArgs): Promise<ReactBitsResponse> {
  const props = args.props
  if (props !== undefined && (!Array.isArray(props) || props.some(prop => typeof prop !== 'string') || props.length > PROPS_MAX)) {
    return refused('get', 'invalid-props', `props must be an array of at most ${String(PROPS_MAX)} strings.`)
  }

  const outcome = await resolveVariant(catalogue, args, 'get')
  if ('refusal' in outcome) return outcome.refusal
  const { resolved } = outcome

  const notes: string[] = []
  if (resolved.partial) notes.push(`"${resolved.asked}" was matched to ${resolved.title} as the only component containing it; fetch by full name next time to skip the guesswork.`)
  const files: ReactBitsDeliveredFile[] = resolved.item.files.map((file) => {
    const bytes = Buffer.byteLength(file.content, 'utf8')
    if (bytes > FILE_MAX_CHARS) {
      notes.push(`${file.path} is ${String(bytes)} bytes and was left out of this result rather than truncated into a file that would not compile. Fetch that one file from upstream directly, or use action "apply" to write it without carrying it through the transcript.`)
      return { path: file.path, writeAs: writeAsName(file.path), role: roleOf(file.path), delivered: false, bytes }
    }
    return { path: file.path, writeAs: writeAsName(file.path), role: roleOf(file.path), delivered: true, bytes, content: file.content }
  })

  const source = files.filter(file => file.delivered && file.content !== undefined).map(file => file.content).join('\n')
  const inspection = inspectVariant({
    name: resolved.chosen,
    style: resolved.style,
    files: resolved.item.files.map(file => ({ path: file.path, content: file.content })),
    dependencies: resolved.item.dependencies,
    ...args.target === undefined || typeof args.target !== 'string' ? {} : { target: args.target },
  })

  const propChecks = props === undefined
    ? undefined
    : props.filter((prop): prop is string => typeof prop === 'string').map((prop) => {
      const evidence = propAppears(source, prop.slice(0, PROP_MAX_CHARS))
      return { prop, present: evidence !== undefined, ...evidence === undefined ? {} : { evidence } }
    })

  if (resolved.item.dependencies.length > 0) {
    notes.push(`Install these before the file will compile, with your project's own package manager: ${resolved.item.dependencies.join(', ')}.`)
  }
  if (resolved.item.registryDependencies.length > 0) {
    notes.push(`This item also pulls in ${resolved.item.registryDependencies.join(', ')} — fetch those with this tool too.`)
  }
  notes.push('The source is returned, not written: place each file with your own editing tools, or call this tool again with action "apply" and a destination directory to have these files written for you.')
  if (propChecks !== undefined && propChecks.some(check => !check.present)) {
    notes.push(`These props were not found in the source: ${propChecks.filter(check => !check.present).map(check => check.prop).join(', ')}. Upstream's props are per component; do not assume one exists.`)
  }

  return {
    kind: 'component',
    action: 'get',
    component: resolved.title,
    slug: slugifyTitle(resolved.title),
    variant: {
      name: resolved.chosen,
      language: resolved.language,
      style: resolved.style,
      alternatives: resolved.variantNames.filter(name => name !== resolved.chosen),
    },
    source: resolved.source,
    dependencies: resolved.item.dependencies,
    registryDependencies: resolved.item.registryDependencies,
    files,
    inspection,
    ...propChecks === undefined ? {} : { propChecks },
    license: LICENSE,
    next: 'Install the listed dependencies, apply the review findings, and keep the licence\'s two sentences in mind: use is fine, redistribution is not.',
    notes,
  }
}

/** The `fs` service, or `undefined` when this installation has none. */
function fileService(host: ReactBitsHost | undefined): ReactBitsFileService | undefined {
  const service = host?.get('fs') as ReactBitsFileService | undefined
  return service === undefined || typeof service.resolve !== 'function' || typeof service.readText !== 'function' ? undefined : service
}

/**
 * The host's own decision about the next write, when this composition has one.
 *
 * `fs/write-intent` is the host's single-slot guard for a write: a policy plugin
 * can answer `createIfAbsent` — which turns an overwrite into a refusal by the file
 * service itself — or hand back a version it wants matched. Consulting it is what
 * makes these writes subject to the same rules as every other write in the
 * session; a composition with no policy plugin answers `undefined`, which is the
 * unconditional write this tool has already decided to make.
 */
async function writeIntent(host: ReactBitsHost, target: unknown, exec: ReactBitsToolExec | undefined): Promise<unknown> {
  const waterfall = (host as { waterfall?: (event: string, ...args: readonly unknown[]) => Promise<unknown> }).waterfall
  if (typeof waterfall !== 'function') return undefined
  return await waterfall.call(host, 'fs/write-intent', target, exec, () => undefined)
}

/** The operation a write reported, or `written` for a service that reports none. */
function writeOperation(outcome: unknown): string {
  if (isRecord(outcome) && typeof outcome.operation === 'string') return outcome.operation
  return 'written'
}

/**
 * Write one fetched variant into the caller's project.
 *
 * The order of the checks is the order of the costs: the arguments are checked
 * before the network is touched, the destination and the file names are checked
 * before anything is written, and each file's own conflict is decided immediately
 * before its write. A failure on one file does not abandon the others — a component
 * whose stylesheet could not be written is reported as a component without a
 * stylesheet, not as a call that did nothing.
 */
async function runApply(
  host: ReactBitsHost | undefined,
  catalogue: ReactBitsCatalogue,
  args: ReactBitsArgs,
  exec: ReactBitsToolExec | undefined,
): Promise<ReactBitsResponse> {
  if (typeof args.directory !== 'string' || args.directory.trim() === '') {
    return refused('apply', 'missing-directory', 'Provide the destination directory, relative to the session working directory, e.g. "src/components/reactbits".')
  }
  const directory = args.directory.trim()
  if (directory.length > DIRECTORY_MAX_CHARS) {
    return refused('apply', 'directory-too-long', `The destination exceeds ${String(DIRECTORY_MAX_CHARS)} characters.`)
  }
  const cwd = exec?.agent?.session?.header?.cwd
  const badDirectory = directoryRefusal(directory, cwd)
  if (badDirectory !== undefined) return refused('apply', 'invalid-directory', badDirectory)
  if (cwd === undefined) {
    return refused('apply', 'unknown-workspace', 'This installation does not say which directory the session is in, so a destination relative to it cannot be resolved.')
  }
  if (args.if_exists !== undefined && args.if_exists !== 'skip' && args.if_exists !== 'replace') {
    return refused('apply', 'invalid-if-exists', 'if_exists must be "skip" (leave an existing file alone) or "replace" (overwrite it).')
  }
  const ifExists: ReactBitsConflictPolicy = args.if_exists === 'replace' ? 'replace' : 'skip'
  if (args.client_directive !== undefined && args.client_directive !== 'auto' && args.client_directive !== 'always' && args.client_directive !== 'never') {
    return refused('apply', 'invalid-client-directive', 'client_directive must be "auto" (add it where the framework needs it), "always", or "never".')
  }
  const directive: ReactBitsDirectivePolicy = args.client_directive === 'always' || args.client_directive === 'never' ? args.client_directive : 'auto'
  if (args.reduced_motion !== undefined && typeof args.reduced_motion !== 'boolean') {
    return refused('apply', 'invalid-reduced-motion', 'reduced_motion must be a boolean.')
  }

  const outcome = await resolveVariant(catalogue, args, 'apply')
  if ('refusal' in outcome) return outcome.refusal
  const { resolved } = outcome

  const serverRendered = args.target === undefined || typeof args.target !== 'string' || /next|remix|nuxt|sveltekit|astro|fresh|analog/iu.test(args.target)
  const plan = planReactBitsWrites({
    files: resolved.item.files.map(file => ({ path: file.path, content: file.content })),
    serverRendered,
    directive,
    ...args.reduced_motion === undefined ? {} : { reducedMotion: args.reduced_motion },
  })
  const destinations = plan.files.map(file => destinationPath(cwd, directory, file.writeAs))
  if (!plannedNamesAreSafe(plan.files)) {
    return refused('apply', 'unsafe-file-path',
      `The registry item for ${resolved.chosen} carries a file name this tool will not write: ${plan.files.map(file => file.writeAs).join(', ')}.`,
      { wouldWrite: destinations })
  }
  if (args.confirm !== true) {
    return refused('apply', 'confirmation-required',
      `This call would write ${String(plan.files.length)} file(s) into "${directory}": ${plan.files.map((file, index) => `${destinations[index] ?? file.writeAs} (${String(file.bytes)} bytes${file.transformations.length === 0 ? '' : `, altered: ${file.transformations.map(change => change.id).join(', ')}`})`).join('; ')}. Repeat the call with confirm: true to write them.`,
      { wouldWrite: destinations })
  }

  const service = fileService(host)
  if (service === undefined) {
    return refused('apply', 'no-file-service', 'This installation provides no file service, so the files cannot be written. Use action "get" and place them yourself.')
  }
  if (typeof service.writeText !== 'function') {
    return refused('apply', 'no-write-service', 'This installation\'s file service is read-only, so the files cannot be written. Use action "get" and place them yourself.')
  }

  const written: ReactBitsWrittenFile[] = []
  const skipped: { path: string; reason: string }[] = []
  const failed: { path: string; reason: string }[] = []
  for (const [index, file] of plan.files.entries()) {
    const destination = destinations[index] ?? file.writeAs
    try {
      // The conflict is decided by reading, not by asking the service whether the
      // file exists: the read is the thing this tool can do on every host, and a
      // successful read is exactly the condition `if_exists` is about.
      const existing = await service.readText(await service.resolve(destination)).then(() => true, () => false)
      if (existing && ifExists === 'skip') {
        skipped.push({ path: destination, reason: 'the file already exists and if_exists is "skip"' })
        continue
      }
      const target = await service.resolve(destination)
      const intent = await writeIntent(host as ReactBitsHost, target, exec)
      const result: unknown = await service.writeText(target, file.content, intent, exec?.signal)
      written.push({ path: destination, bytes: file.bytes, operation: writeOperation(result), transformations: file.transformations })
    } catch (error) {
      failed.push({ path: destination, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const notes: string[] = []
  if (resolved.partial) notes.push(`"${resolved.asked}" was matched to ${resolved.title} as the only component containing it.`)
  if (resolved.item.dependencies.length > 0) {
    notes.push(`Install these, with your project's own package manager, before the files will compile: ${resolved.item.dependencies.join(', ')}.`)
  }
  if (resolved.item.registryDependencies.length > 0) {
    notes.push(`This item also pulls in ${resolved.item.registryDependencies.join(', ')} — apply those with this tool as well.`)
  }
  if (skipped.length > 0) {
    notes.push('Pass if_exists: "replace" to overwrite the files that were left alone, after reading what is already there.')
  }
  if (failed.some(entry => /intent|observ|stale|version/iu.test(entry.reason))) {
    notes.push('A write was refused by this session\'s own write policy. That is the host\'s decision rather than this tool\'s, and it is not overridable from here.')
  }
  const alterations = written.flatMap(entry => entry.transformations.map(change => `${entry.path}: ${change.id}`))
  if (alterations.length > 0) {
    notes.push(`Altered from upstream: ${alterations.join(', ')}. Nothing else in the written files differs from what the registry publishes.`)
  }
  if (written.length === 0 && failed.length === 0) {
    notes.push('Nothing was written: every file was already there. Nothing was overwritten.')
  }

  return {
    kind: 'applied',
    action: 'apply',
    component: resolved.title,
    slug: slugifyTitle(resolved.title),
    variant: { name: resolved.chosen, language: resolved.language, style: resolved.style },
    source: resolved.source,
    directory,
    resolvedDirectory: destinationPath(cwd, directory, '').replace(/\/$/u, ''),
    dependencies: resolved.item.dependencies,
    written,
    skipped,
    failed,
    followUps: plan.followUps,
    license: LICENSE,
    next: 'Install the dependencies, run the project\'s own typecheck or build over the written files, and read the follow-ups below — they are the parts a mechanical write cannot decide.',
    notes,
  }
}

/** Validate the action and dispatch. */
async function runReactBits(
  host: ReactBitsHost | undefined,
  catalogue: ReactBitsCatalogue,
  input: unknown,
  exec: ReactBitsToolExec | undefined,
): Promise<ReactBitsResponse> {
  if (typeof input !== 'object' || input === null) {
    return refused('', 'invalid-arguments', 'Provide a JSON object with an action of "search", "get" or "apply".')
  }
  const args = input as ReactBitsArgs
  if (args.action !== 'search' && args.action !== 'get' && args.action !== 'apply') {
    return refused(typeof args.action === 'string' ? args.action.slice(0, 32) : '', 'invalid-action',
      'action must be "search" (keywords against the catalogue index), "get" (one component\'s source), or "apply" (write it into the project).')
  }
  if (args.action === 'search') return runSearch(catalogue, args)
  return args.action === 'get' ? runGet(catalogue, args) : runApply(host, catalogue, args, exec)
}

/**
 * The tool definition this package ships, built on demand.
 *
 * The definition rather than a registration, because the design pack registers
 * tools by name and reports the names that registered: `design/features.ts` lists
 * {@link REACTBITS_TOOL_NAME} as its row's tool, and `design/tools.ts` supplies
 * this builder under that same name. One name, one builder — a literal written at
 * each site is a row on the design page that can advertise a tool this build
 * never registered.
 *
 * @param ctx - the context `apply` writes through; the read actions need nothing
 *              from it, and a call to them works with none.
 * @param catalogue - the reader, injectable so a test never touches the network.
 * @returns the definition, named {@link REACTBITS_TOOL_NAME}.
 */
export function reactbitsToolDefinition(
  ctx?: ReactBitsHost,
  catalogue: ReactBitsCatalogue = new ReactBitsCatalogue(),
): ToolDefinitionShape {
  return toolDefinition({
    name: REACTBITS_TOOL_NAME,
    description: `Search, fetch and place animated React components from React Bits (${REACTBITS_ORIGIN}), which publishes 200+ components in four variants each, reading the live upstream registry over the network. "search" returns index rows — names, descriptions, exact dependency ranges, file paths — and never any source; "get" returns one variant's source files plus an integration review (missing \`'use client'\` directive, extra stylesheets, browser globals, absent \`prefers-reduced-motion\`, WebGL dependence, and which of this package's own design rules the code would trip); "apply" writes that variant into a directory you name, and requires confirm: true. Apply writes only the files upstream publishes, alters them in exactly two mechanical ways (a leading \`'use client'\` where the framework needs one, and a bounded-motion block appended to a sheet that animates without honouring the system setting), never overwrites an existing file unless if_exists is "replace", and reports every file it wrote, skipped or could not write. Nothing is ever installed — dependencies are returned as exact ranges for your own package manager — and no component is cached or kept by this package: the files land only in your project.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'get', 'apply'],
          description: '"search" to find components by keyword, "get" to fetch one component\'s source, "apply" to write it into the project.',
        },
        query: {
          type: 'string',
          maxLength: QUERY_MAX_CHARS,
          description: 'For "search": a component name, an effect ("blur"), or a dependency ("gsap"). Matched against names, descriptions and declared packages.',
        },
        component: {
          type: 'string',
          maxLength: COMPONENT_MAX_CHARS,
          description: 'For "get" and "apply": the component, as a name ("CountUp"), a registry variant ("CountUp-TS-TW"), or the docs slug ("count-up").',
        },
        directory: {
          type: 'string',
          maxLength: DIRECTORY_MAX_CHARS,
          description: 'For "apply": where to write the files, relative to the session working directory, e.g. "src/components/reactbits". Required — there is no default destination.',
        },
        confirm: {
          type: 'boolean',
          description: 'For "apply": must be true. Without it the call is refused and the refusal lists every path it would have written, so a destination can be checked before anything is.',
        },
        if_exists: {
          type: 'string',
          enum: ['skip', 'replace'],
          description: 'For "apply": what to do when a destination file is already there. Defaults to "skip", which leaves it alone and says so.',
        },
        client_directive: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: 'For "apply": when to add a leading `\'use client\'` to a component. Defaults to "auto" — added when the target framework renders on the server or the framework is unknown.',
        },
        reduced_motion: {
          type: 'boolean',
          description: 'For "apply": whether a stylesheet that animates may have a `prefers-reduced-motion` block appended. Defaults to true.',
        },
        language: {
          type: 'string',
          enum: ['js', 'ts'],
          description: 'For "get" and "apply": TypeScript or JavaScript. Defaults to "ts".',
        },
        style: {
          type: 'string',
          enum: ['css', 'tailwind'],
          description: 'For "get" and "apply": plain CSS or Tailwind classes. Defaults to "tailwind", which is what the shadcn route installs.',
        },
        props: {
          type: 'array',
          items: { type: 'string', maxLength: PROP_MAX_CHARS },
          maxItems: PROPS_MAX,
          description: 'For "get": prop names to check the source for. Each is reported as present or absent, so a component that has no such prop says so instead of silently ignoring it.',
        },
        target: {
          type: 'string',
          maxLength: COMPONENT_MAX_CHARS,
          description: 'For "get" and "apply": the framework the component is going into, e.g. "next", "vite", "remix". Decides the severity of the missing-directive finding and whether "apply" adds the directive.',
        },
        dependency_free: {
          type: 'boolean',
          description: 'For "search": keep only components whose variants need no package beyond React itself. Defaults to false.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: LIMIT_CEILING,
          description: `For "search": how many components to return. Defaults to ${String(DEFAULT_LIMIT)}.`,
        },
      },
    },
    output: JSON_TOOL_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args: ReactBitsArgs, exec: ReactBitsToolExec) => runReactBits(ctx, catalogue, args, exec),
    presentCall: (args: ReactBitsArgs) => ({
      card: 'generic',
      title: args.action === 'apply'
        ? `React Bits apply: ${typeof args.component === 'string' ? args.component.slice(0, 48) : ''} → ${typeof args.directory === 'string' ? args.directory.slice(0, 48) : ''}`
        : args.action === 'search'
          ? `React Bits search: ${typeof args.query === 'string' ? args.query.slice(0, 72) : ''}`
          : `React Bits component: ${typeof args.component === 'string' ? args.component.slice(0, 72) : ''}`,
    }),
  })
}
