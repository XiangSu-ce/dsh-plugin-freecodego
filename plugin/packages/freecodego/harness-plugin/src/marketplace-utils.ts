import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { readBodyWithCap } from './community-catalog-utils.ts'
import { stringArray } from './community-storage.ts'
import { asRecord as record } from './untrusted-json.ts'
import type { FreeCodeGoCapabilityMarketplaceItem, FreeCodeGoCapabilityMarketplaceRequest, FreeCodeGoCapabilitySettings, FreeCodeGoMcpServer } from './types.ts'

const MARKETPLACE_PAGE_SIZE = 24
const MARKETPLACE_MAX_OFFSET = 10_000

/** Clamp a marketplace request's paging fields and trim its free-text filters.
 * @param input - the untrusted request to normalize.
 * @returns the request with every field filled and bounded.
 */
export function normalizeMarketplaceRequest(input: FreeCodeGoCapabilityMarketplaceRequest): Required<FreeCodeGoCapabilityMarketplaceRequest> {
  if (input === null || typeof input !== 'object') throw new Error('marketplace request is required')
  if (input.kind !== 'mcp' && input.kind !== 'skill') throw new Error('marketplace kind must be mcp or skill')
  const clean = (value: string | undefined, maximum: number): string => (value ?? '').trim().slice(0, maximum)
  const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(MARKETPLACE_PAGE_SIZE, input.limit!)) : MARKETPLACE_PAGE_SIZE
  const offset = Number.isSafeInteger(input.offset) ? Math.max(0, Math.min(MARKETPLACE_MAX_OFFSET, input.offset!)) : 0
  return { kind: input.kind, query: clean(input.query, 120), category: clean(input.category, 64), limit, offset }
}

/** Fetch a community-directory URL and parse its JSON body, with a timeout and a size cap.
 * @param url - the directory endpoint to fetch.
 * @returns the parsed response body.
 */
export async function fetchMarketplaceJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'FreeCodeGo-Harness' }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`community directory returned HTTP ${response.status}`)
  const body = await readBodyWithCap(response, 4_000_000)
  return JSON.parse(body) as unknown
}

/** Read a trimmed, length-capped string from untrusted marketplace JSON.
 * @param value - the value to read.
 * @param fallback - the value to return when it is not a string.
 * @returns the trimmed text, or the fallback.
 */
export function marketplaceText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim().slice(0, 4_000) : fallback
}

/** Read a non-negative integer from untrusted marketplace JSON, defaulting to zero.
 * @param value - the value to read.
 * @returns the whole number, or zero.
 */
export function marketplaceNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** Read an http(s) URL from untrusted marketplace JSON, stripping any embedded credentials.
 * @param value - the value to read.
 * @returns the sanitized URL, or `undefined` when it is not one.
 */
export function marketplaceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    url.username = ''
    url.password = ''
    return url.toString()
  } catch { return undefined }
}

/** A stable, collision-free MCP server name for a marketplace slug, within the 32-character budget.
 * @param slug - the marketplace slug to name.
 * @returns the generated server name.
 */
export function marketplaceMcpName(slug: string): string {
  // Truncation alone can collide distinct long slugs, and sanitization merges
  // distinct spellings (`a.b` vs `a-b`), so the digest must come from the RAW
  // slug: every distinct slug keeps a distinct, stable server name within the
  // 32-char MCP-server-name budget.
  const base = `mcpso-${slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')}`
  const digest = createHash('sha256').update(slug.toLowerCase()).digest('hex').slice(0, 8)
  const withDigest = `${base.slice(0, 32 - digest.length - 1)}-${digest}`
  return withDigest.length <= 32 ? withDigest : `${withDigest.slice(0, 32 - 9)}-${digest}`
}

/** Project one mcp.so record into a marketplace card, or none when it is unusable.
 * @param value - the untrusted directory row.
 * @param settings - the current settings, used to mark an already-installed server.
 * @returns the item, or an empty list when the row fails validation.
 */
export function marketplaceMcpSummary(value: unknown, settings: FreeCodeGoCapabilitySettings): FreeCodeGoCapabilityMarketplaceItem[] {
  const item = record(value)
  const slug = marketplaceText(item.slug).toLowerCase()
  const title = marketplaceText(item.name)
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(slug) || title === '') return []
  const author = marketplaceText(item.authorName)
  const category = marketplaceText(item.categoryName, 'Community')
  const iconUrl = marketplaceUrl(item.iconUrl)
  const sourceUrl = `https://mcp.so/servers/${encodeURIComponent(slug)}`
  return [{
    id: `mcp:${slug}`,
    kind: 'mcp',
    title,
    description: marketplaceText(item.tagline, 'MCP server'),
    category,
    sourceUrl,
    ...(iconUrl === undefined ? {} : { iconUrl }),
    ...(author === '' ? {} : { author }),
    popularity: marketplaceNumber(item.stars),
    installed: settings.mcpServers.some(server => server.serverName === marketplaceMcpName(slug)),
    installable: true,
  }]
}

/** Project one skills.sh record into a marketplace card, or none when it is unusable.
 * @param value - the untrusted directory row.
 * @param root - the skill root that decides where a legacy install left the Skill.
 * @param installedNames - the names this root's lockfile records, when the caller has read it.
 * @returns the item, or an empty list when the row fails validation.
 */
export function marketplaceSkillSummary(value: unknown, root: string, installedNames?: ReadonlySet<string>): FreeCodeGoCapabilityMarketplaceItem[] {
  const item = record(value)
  const identity = marketplaceText(item.id)
  const parts = identity.split('/').filter(Boolean)
  const skillName = marketplaceText(item.skillId, parts.at(-1) ?? '')
  const source = marketplaceText(item.source, parts.slice(0, -1).join('/'))
  const title = marketplaceText(item.name, skillName)
  if (parts.length < 3 || skillName === '' || title === '' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) return []
  const destination = path.join(root, marketplacePathSegment(identity), 'SKILL.md')
  return [{
    id: `skill:${identity}`,
    kind: 'skill',
    title,
    description: source,
    category: 'Community',
    sourceUrl: `https://skills.sh/${parts.map(encodeURIComponent).join('/')}`,
    author: source,
    popularity: marketplaceNumber(item.installs),
    // Recorded first, directory second: the lockfile is the checkable claim, and
    // the path test is what an install from before the lockfile existed left
    // behind — a flattened identity directory nothing new writes to.
    installed: installedNames?.has(skillName) === true || existsSkill(destination),
    installable: true,
  }]
}

/** Whether a marketplace skill is already installed at the given SKILL.md path.
 * @param file - the SKILL.md path to test.
 * @returns true when the file exists.
 */
export function existsSkill(file: string): boolean {
  return existsSync(file)
}

/** Reduce a marketplace identity to one traversal-safe path segment.
 * @param value - the raw identity to sanitize.
 * @returns the safe segment, or a hashed fallback when sanitizing leaves a traversal shape.
 */
export function marketplacePathSegment(value: string): string {
  // Collapse traversal/dotfile shapes: a segment that is only dots, or that
  // begins with `..`, must not escape the marketplace skill directory.
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160)
  if (sanitized === '' || sanitized === '.' || sanitized === '..' || sanitized.startsWith('..')) return marketplacePathSegmentFallback(value)
  return sanitized
}

/** Deterministic fallback for slugs that sanitize to a traversal shape. */
function marketplacePathSegmentFallback(value: string): string {
  return `skill-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

/** Strip a marketplace id's `kind:` prefix and validate the remainder.
 * @param value - the prefixed marketplace id.
 * @param kind - the expected id kind.
 * @returns the bare id.
 */
export function parseMarketplaceId(value: string, kind: 'mcp' | 'skill'): string {
  const prefix = `${kind}:`
  if (!value.startsWith(prefix)) throw new Error(`invalid ${kind} marketplace id`)
  const id = value.slice(prefix.length).trim()
  if (id === '' || id.length > 384) throw new Error(`invalid ${kind} marketplace id`)
  return id
}

/** Parse a JSON string from untrusted marketplace data, passing non-strings through.
 * @param value - the value to parse.
 * @returns the parsed value, the original non-string, or `undefined` when parsing fails.
 */
export function parseMarketplaceJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

/** Build an installable MCP server definition from a marketplace detail record.
 * @param slug - the marketplace slug the server is named from.
 * @param detail - the untrusted detail payload to read the connection from.
 * @returns the server definition, or `undefined` when no usable transport is found.
 */
export function marketplaceMcpDefinition(slug: string, detail: Record<string, unknown>): Omit<FreeCodeGoMcpServer, 'id'> | undefined {
  const description = marketplaceText(detail.description ?? detail.content)
  const parsed = record(parseMarketplaceJson(detail.config))
  const listed = record(parsed.mcpServers ?? parsed.mcp_servers)
  const documented = [...description.matchAll(/```json\s*([\s\S]*?)```/gi)]
    .map(match => record(parseMarketplaceJson(match[1])))
    .map(value => record(value.mcpServers ?? value.mcp_servers))
    .find(value => Object.keys(value).length > 0)
  const candidate = Object.values(Object.keys(listed).length > 0 ? listed : documented ?? parsed)[0]
  const config = record(candidate)
  const rawUrl = config.url ?? config.serverUrl ?? config.endpoint
  const url = marketplaceUrl(rawUrl)
  if (url !== undefined) {
    // Marketplace HTTP headers commonly contain a token placeholder. Preserve
    // only their names with empty values so the install gate requires a user
    // to enter credentials rather than writing an unusable connection.
    const headers = Object.fromEntries(Object.keys(record(config.headers ?? config.httpHeaders ?? config.http_headers)).map(key => [key, '']))
    return { enabled: true, transport: 'streamable-http', serverName: marketplaceMcpName(slug), command: '', args: [], env: {}, cwd: '', url, headers }
  }
  const command = Array.isArray(config.command)
    ? config.command.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
    : typeof config.command === 'string' && config.command.trim() !== '' ? [config.command.trim(), ...stringArray(config.args)] : []
  if (command.length === 0) return undefined
  const env = Object.fromEntries(Object.keys(record(config.environment ?? config.env)).map(key => [key, '']))
  return { enabled: true, transport: 'stdio', serverName: marketplaceMcpName(slug), command: command[0]!, args: command.slice(1), env, cwd: typeof config.cwd === 'string' ? config.cwd : '', url: '', headers: {} }
}

/** Whether a definition still needs credentials before it can be installed.
 * @param definition - the definition to inspect.
 * @returns true when any env var or header is left blank.
 */
export function mcpDefinitionRequiresConfiguration(definition: Omit<FreeCodeGoMcpServer, 'id'>): boolean {
  return [...Object.values(definition.env), ...Object.values(definition.headers)].some(value => value.trim() === '')
}
