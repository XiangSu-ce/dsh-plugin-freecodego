import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { childProcessEnvironment } from './engineering-graphify.ts'
import { readJsonFile } from './community-storage.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import { asRecord as record } from './untrusted-json.ts'
import type { CommunityCatalogPlugin } from './types.ts'

const COMMUNITY_ASSET_HOSTS = new Set(['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com', 'github.com'])
function marketplaceUrl(value: unknown): string | undefined { if (typeof value !== 'string' || value.trim() === '') return undefined; try { const url = new URL(value.trim()); if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined; url.username = ''; url.password = ''; return url.toString() } catch { return undefined } }
/**
 * Accept an asset URL only when it points at an allow-listed GitHub host.
 * @param value - the candidate URL.
 * @returns the normalized URL, or `undefined` when it is not allowed.
 */
export function communityCatalogAssetUrl(value: unknown): string | undefined { const normalized = marketplaceUrl(value); if (normalized === undefined) return undefined; try { return COMMUNITY_ASSET_HOSTS.has(new URL(normalized).hostname.toLowerCase()) ? normalized : undefined } catch { return undefined } }
/**
 * Accept an asset URL only when it is a raw.githubusercontent.com URL.
 * @param value - the candidate URL.
 * @returns the normalized URL, or `undefined` when it is not a verified raw URL.
 */
export function verifiedGithubAssetUrl(value: unknown): string | undefined { const normalized = marketplaceUrl(value); if (normalized === undefined) return undefined; try { return new URL(normalized).hostname.toLowerCase() === 'raw.githubusercontent.com' ? normalized : undefined } catch { return undefined } }
/**
 * Parse a marketplace catalog document, dropping malformed rows.
 * @param value - the parsed JSON document.
 * @returns the catalog, or `undefined` when it carries no valid rows.
 */
export function parseCommunityCatalog(value: unknown): { readonly updated?: string; readonly plugins: readonly CommunityCatalogPlugin[] } | undefined {
  const root = record(value)
  const plugins = Array.isArray(root.plugins) ? root.plugins.flatMap((item) => {
    const row = record(item); if (typeof row.name !== 'string' || typeof row.owner !== 'string' || typeof row.url !== 'string') return []
    const url = marketplaceUrl(row.url); if (url === undefined) return []
    const description = record(row.description)
    const iconUrl = [row.iconUrl, row.icon_url, row.icon, row.logoUrl, row.logo_url, row.logo, row.imageUrl, row.image_url, row.image].map(marketplaceUrl).find((candidate): candidate is string => candidate !== undefined)
    return [{ name: row.name, owner: row.owner, url, category: Array.isArray(row.category) ? row.category.filter(value => typeof value === 'string') : typeof row.category === 'string' ? row.category : 'other', ...(iconUrl === undefined ? {} : { iconUrl }), ...(Array.isArray(row.screenshots) ? { screenshots: row.screenshots.map(communityCatalogAssetUrl).filter((value): value is string => value !== undefined).slice(0, 8) } : {}), ...(typeof description.zh === 'string' || typeof description.en === 'string' ? { description: { ...(typeof description.zh === 'string' ? { zh: description.zh } : {}), ...(typeof description.en === 'string' ? { en: description.en } : {}) } } : {}), ...(typeof row.npm === 'string' ? { npm: row.npm } : {}), ...(typeof row.stars === 'number' && Number.isFinite(row.stars) ? { stars: row.stars } : {}), ...(typeof row.downloads === 'number' && Number.isFinite(row.downloads) ? { downloads: row.downloads } : {}), ...(typeof row.added === 'string' ? { added: row.added } : {}) } satisfies CommunityCatalogPlugin]
  }) : []
  if (plugins.length === 0) return undefined
  return { ...(typeof root.updated === 'string' ? { updated: root.updated } : {}), plugins }
}
/**
 * A GitHub repository, optionally pinned to a ref and directory.
 */
export interface GithubCommunityRepository { readonly owner: string; readonly repository: string; readonly ref?: string; readonly directory?: string }
/**
 * Parse a GitHub URL into its repository, ref, and directory.
 * @param value - the URL to parse.
 * @returns the parsed repository, or `undefined` when the URL is not a GitHub repo.
 */
export function githubCommunityRepository(value: string): GithubCommunityRepository | undefined {
  try { const url = new URL(value); if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return undefined; const parts = url.pathname.split('/').filter(Boolean); if (parts.length < 2) return undefined; const owner = parts[0]!; const repository = parts[1]!.replace(/\.git$/i, ''); if (parts[2]?.toLowerCase() !== 'tree' || parts[3] === undefined) return { owner, repository }; const directory = parts.slice(4).join('/'); return { owner, repository, ref: parts[3], ...(directory === '' ? {} : { directory }) } } catch { return undefined }
}
/**
 * Rank one candidate icon by preference; lower is better.
 *
 * `favicon` is tested before `icon` because the substring check is literal:
 * `value.includes('icon')` is true for `favicon.png`, so the previous order
 * scored a favicon as a first-class icon and ranked it *above* a logo. A
 * favicon is the lowest-quality option, not the highest.
 * @param name - the candidate icon file name.
 * @returns the sort key; lower ranks higher.
 */
export function communityIconScore(name: string): number {
  const value = name.toLowerCase()
  const kind = value.includes('favicon') ? 2 : value.includes('icon') ? 0 : value.includes('logo') ? 1 : 3
  const extension = value.endsWith('.svg') ? 0 : value.endsWith('.png') ? 1 : 2
  return kind * 10 + extension
}

const COMMUNITY_CATALOG_TIMEOUT_MS = 20_000
const COMMUNITY_CATALOG_MAX_BYTES = 4_000_000
const COMMUNITY_ICON_TIMEOUT_MS = 8_000
const COMMUNITY_README_MAX_BYTES = 96_000
const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i
interface CommunityCatalogCache {
  readonly version: 1
  readonly savedAt: number
  readonly catalog: {
    readonly updated?: string
    readonly plugins: readonly CommunityCatalogPlugin[]
  }
}
interface CommunityIconCache {
  readonly version: 2
  readonly entries: Readonly<Record<string, { readonly expiresAt: number; readonly iconUrl: string | null }>>
}

/**
 * Fetch and parse a marketplace catalog document.
 * @param url - the catalog URL.
 * @returns the catalog document.
 */
export async function fetchCommunityCatalog(url: string): Promise<{ readonly updated?: string; readonly plugins: readonly CommunityCatalogPlugin[] }> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'FreeCodeGo-Harness' },
    signal: AbortSignal.timeout(COMMUNITY_CATALOG_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`目录源返回 HTTP ${response.status}`)
  // The cap is enforced while streaming, so an oversized body is aborted
  // before it is ever fully buffered in memory.
  const body = await readBodyWithCap(response, COMMUNITY_CATALOG_MAX_BYTES)
  const catalog = parseCommunityCatalog(JSON.parse(body) as unknown)
  if (catalog === undefined) throw new Error('目录数据无效')
  return catalog
}

/**
 * Read the persisted catalog cache.
 * @param file - the cache file path.
 * @returns the cached catalog, or `undefined` when none is stored.
 */
export async function readCommunityCatalogCache(file: string): Promise<CommunityCatalogCache | undefined> {
  const value = record(await readJsonFile(file))
  if (value.version !== 1 || typeof value.savedAt !== 'number') return undefined
  const catalog = parseCommunityCatalog(value.catalog)
  return catalog === undefined ? undefined : { version: 1, savedAt: value.savedAt, catalog }
}

/**
 * Buffer a response body up to `maxBytes` while streaming, so a server that
 * lies about (or omits) Content-Length cannot balloon memory before the cap
 * is checked. Mirrors native-runtime-host's downloadToFile byte accounting.
 * @param response - the streaming response to read.
 * @param maxBytes - the byte cap the body may not exceed.
 * @returns the decoded body text.
 */
export async function readBodyWithCap(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response body exceeds the ${maxBytes} byte limit`)
  if (response.body === null) return ''
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let received = 0
  let body = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      received += next.value.byteLength
      if (received > maxBytes) throw new Error(`response body exceeds the ${maxBytes} byte limit`)
      body += decoder.decode(next.value, { stream: true })
    }
  } finally {
    // Cancel (not just release) so an over-limit body does not leave the
    // connection and its buffered bytes parked until garbage collection.
    await reader.cancel().catch(() => undefined)
  }
  return body + decoder.decode()
}

/**
 * Read a package manifest for its declared icon URL.
 * @param manifestUrl - the verified manifest URL.
 * @returns the icon URL, `null` for a definitive absence, or `undefined` when retryable.
 */
export async function communityManifestIcon(manifestUrl: string): Promise<string | null | undefined> {
  let response: Response
  try {
    response = await fetch(manifestUrl, {
      headers: { accept: 'application/json', 'user-agent': 'FreeCodeGo-Harness' },
      signal: AbortSignal.timeout(COMMUNITY_ICON_TIMEOUT_MS),
    })
  } catch { return undefined }
  if (!response.ok) return response.status === 404 ? null : undefined
  let manifest: Record<string, unknown>
  try { manifest = record(await response.json()) } catch { return undefined }
  const dsh = record(manifest.dsh)
  for (const candidate of [manifest.icon, manifest.logo, manifest.favicon, dsh.icon, dsh.logo]) {
    if (typeof candidate !== 'string' || !/\.(svg|png|webp|jpe?g|ico)(?:[?#].*)?$/i.test(candidate)) continue
    try {
      const iconUrl = verifiedGithubAssetUrl(new URL(candidate, manifestUrl).toString())
      if (iconUrl !== undefined) return iconUrl
    } catch { /* Try the next declared artwork path. */ }
  }
  return null
}

/**
 * Read a README for its first allow-listed image.
 * @param readmeUrl - the verified README URL.
 * @returns the image URL, `null` for a definitive absence, or `undefined` when retryable.
 */
export async function communityReadmeImage(readmeUrl: string): Promise<string | null | undefined> {
  let response: Response
  try {
    response = await fetch(readmeUrl, {
      headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1', 'user-agent': 'FreeCodeGo-Harness' },
      signal: AbortSignal.timeout(COMMUNITY_ICON_TIMEOUT_MS),
    })
  } catch { return undefined }
  if (!response.ok) return response.status === 404 ? null : undefined
  let markdown: string
  // A body past the cap proves the README cannot yield artwork (negative
  // result); any other read failure stays retryable (`undefined`).
  try { markdown = await readBodyWithCap(response, COMMUNITY_README_MAX_BYTES) } catch (error) {
    return error instanceof Error && /byte limit/.test(error.message) ? null : undefined
  }
  const candidates = [
    ...Array.from(markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)[^)]*\)/g), match => match[1]),
    ...Array.from(markdown.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi), match => match[1]),
  ]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    try {
      const iconUrl = communityCatalogAssetUrl(new URL(candidate, readmeUrl).toString())
      if (iconUrl !== undefined) return iconUrl
    } catch { /* Ignore malformed README image links. */ }
  }
  return null
}

/**
 * Discover an icon from one repository directory via the GitHub contents API.
 * @param repository - the repository, ref, and directory to read.
 * @returns the icon URL, `null` for a definitive absence, or `undefined` when retryable.
 */
export async function resolveCommunityRepositoryDirectoryIcon(repository: GithubCommunityRepository): Promise<string | null | undefined> {
  const directory = repository.directory?.split('/').map(encodeURIComponent).join('/')
  const endpoint = new URL(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/contents${directory === undefined ? '' : `/${directory}`}`)
  if (repository.ref !== undefined) endpoint.searchParams.set('ref', repository.ref)
  let response: Response
  try {
    response = await fetch(endpoint, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'FreeCodeGo-Harness' },
      signal: AbortSignal.timeout(COMMUNITY_ICON_TIMEOUT_MS),
    })
  } catch { return undefined }
  if (!response.ok) return response.status === 404 ? null : undefined
  let payload: unknown
  try { payload = await response.json() } catch { return undefined }
  const entries = Array.isArray(payload) ? payload.map(record) : []
  const candidates = entries.flatMap((entry) => {
    const name = typeof entry.name === 'string' ? entry.name : ''
    if (entry.type !== 'file' || !/(?:^|[-_.])(icon|logo|favicon|brand)(?:[-_.]|$).*\.(svg|png|webp|jpe?g|ico)$/i.test(name)) return []
    const iconUrl = verifiedGithubAssetUrl(entry.download_url)
    return iconUrl === undefined ? [] : [{ name, iconUrl }]
  }).sort((left, right) => communityIconScore(left.name) - communityIconScore(right.name))
  if (candidates[0] !== undefined) return candidates[0].iconUrl
  const manifestUrl = verifiedGithubAssetUrl(entries.find(entry => entry.type === 'file' && entry.name === 'package.json')?.download_url)
  if (manifestUrl !== undefined) {
    const manifestIcon = await communityManifestIcon(manifestUrl)
    if (manifestIcon !== null) return manifestIcon
  }
  const readmeUrl = verifiedGithubAssetUrl(entries.find(entry => entry.type === 'file' && /^readme(?:\.[a-z0-9_-]+)?\.md$/i.test(String(entry.name)))?.download_url)
  return readmeUrl === undefined ? null : communityReadmeImage(readmeUrl)
}

/**
 * `null` means the repository was checked but provides no icon; `undefined` is retryable.
 * @param sourceUrl - the catalog entry's repository URL.
 * @returns the icon URL, `null` for a definitive absence, or `undefined` when retryable.
 */
export async function resolveCommunityRepositoryIcon(sourceUrl: string): Promise<string | null | undefined> {
  const repository = githubCommunityRepository(sourceUrl)
  if (repository === undefined) return null
  const result = await resolveCommunityRepositoryDirectoryIcon(repository)
  if (result !== null || repository.directory === undefined) return result
  // Catalog entries often point at a package nested in a monorepo. The listing
  // convention falls back to its repository README, so visual discovery does too.
  return resolveCommunityRepositoryDirectoryIcon({ owner: repository.owner, repository: repository.repository, ...(repository.ref === undefined ? {} : { ref: repository.ref }) })
}

/**
 * Read the persisted icon cache.
 * @param file - the cache file path.
 * @returns the icon cache, empty when none is stored.
 */
export async function readCommunityIconCache(file: string): Promise<CommunityIconCache> {
  const value = record(await readJsonFile(file))
  if (value.version !== 2) return { version: 2, entries: {} }
  const entries: Record<string, { readonly expiresAt: number; readonly iconUrl: string | null }> = {}
  for (const [key, rawEntry] of Object.entries(record(value.entries))) {
    const entry = record(rawEntry)
    if (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) continue
    if (entry.iconUrl === null) {
      entries[key] = { expiresAt: entry.expiresAt, iconUrl: null }
      continue
    }
    const iconUrl = communityCatalogAssetUrl(entry.iconUrl)
    if (iconUrl !== undefined) entries[key] = { expiresAt: entry.expiresAt, iconUrl }
  }
  return { version: 2, entries }
}

/** Entries one Skill payload may hold before the link screen refuses it outright. */
const SKILL_PAYLOAD_ENTRY_LIMIT = 20_000

/**
 * Refuse a Skill payload that carries a symbolic link.
 *
 * `fs.cp` reproduces a link as a link, so a repository can install an ordinary
 * name — `notes.md` — whose content is read from anywhere on the machine: a
 * planted link is the one shape whose path says nothing about what it opens.
 * The companion reader re-resolves containment and the read tool has its own
 * real-path tier, but a shell command is judged by the name it was given, so the
 * link must not be there to name. Refused rather than dereferenced: copying the
 * target's bytes into the Skill directory would make the leak local and
 * permanent, which is worse than the link being absent.
 *
 * Every entry the copy would create is screened, at every depth, because the
 * copy has no depth bound of its own. A payload too large to screen is refused
 * for the same reason it is refused nowhere else: an install that was not checked
 * is not an install this module is willing to make.
 * @param root - the cloned Skill directory about to be copied.
 * @param prefix - the path already descended into, for the message.
 * @param seen - the entry count, carried through the recursion.
 */
export async function assertSkillPayloadHasNoLinks(root: string, prefix = '', seen = { count: 0 }): Promise<void> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true })
  for (const entry of entries) {
    seen.count += 1
    if (seen.count > SKILL_PAYLOAD_ENTRY_LIMIT) {
      throw new Error(`the Skill payload holds more than ${String(SKILL_PAYLOAD_ENTRY_LIMIT)} entries, which is past what the link screen walks; refusing to install what it did not check`)
    }
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new Error(`the Skill payload carries a symbolic link at "${relative}"; a link opens a file outside the Skill directory while reading as an ordinary companion file`)
    }
    if (entry.isDirectory()) await assertSkillPayloadHasNoLinks(root, relative, seen)
  }
}



/** Entries one Skill search may visit before it stops looking. */
export const SKILL_SEARCH_ENTRY_LIMIT = 4_000

/**
 * What a bounded Skill search found.
 *
 * The three answers are told apart because two of them used to be one: a walk that
 * ran out of budget returned `undefined`, exactly like a repository that genuinely
 * has no `SKILL.md` of that name, and the caller reported the second as fact.
 */
export type SkillDirectorySearch =
  | { readonly directory: string }
  /** Every entry the search was allowed to visit was visited; none was the Skill. */
  | 'not-found'
  /** The search stopped at its entry budget, so it cannot claim the Skill is absent. */
  | 'exhausted'

/**
 * The directory holding a `SKILL.md` named `expectedName`, breadth-first from
 * `root`, at most `entryLimit` entries visited and five levels deep.
 *
 * `entryLimit` is a parameter so the budget's own answer is testable without
 * building a repository large enough to reach the real one.
 * @param root - the cloned repository directory.
 * @param expectedName - the Skill name, matched against the frontmatter or the directory.
 * @param entryLimit - how many entries one search may visit.
 * @returns the skill Directory Search.
 */
export async function findSkillDirectory(root: string, expectedName: string, entryLimit = SKILL_SEARCH_ENTRY_LIMIT): Promise<SkillDirectorySearch> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0) {
    // Checked before popping, so a drained queue is `not-found` while a queue with
    // work left behind it is `exhausted`.
    if (visited >= entryLimit) return 'exhausted'
    const current = queue.shift()!
    const entries = await fs.readdir(current.path, { withFileTypes: true })
    for (const entry of entries) {
      visited += 1
      const location = path.join(current.path, entry.name)
      if (entry.isFile() && entry.name === 'SKILL.md') {
        const content = await fs.readFile(location, 'utf8')
        const name = /^---\s*[\s\S]*?^name:\s*([^\r\n]+)[\s\S]*?^---/m.exec(content)?.[1]?.trim()
        if (name === expectedName || path.basename(current.path).toLowerCase() === expectedName.toLowerCase()) return { directory: current.path }
      } else if (entry.isDirectory() && current.depth < 5 && entry.name !== '.git' && entry.name !== 'node_modules') {
        queue.push({ path: location, depth: current.depth + 1 })
      }
    }
  }
  return 'not-found'
}

/** Community CLI timeout: a hung child must not hold the install mutex forever. */
const COMMUNITY_COMMAND_TIMEOUT_MS = 10 * 60_000

/** Bytes of a captured stdout one community command may produce before the rest is dropped. */
export const COMMUNITY_COMMAND_STDOUT_LIMIT = 64 * 1024

/**
 * Run one community CLI command, bounded by a timeout.
 *
 * `captureStdout` exists for the one command whose *answer* is stdout —
 * `git rev-parse HEAD`, which is how a Skill install pins the commit it received
 * rather than the ref it asked for. It stays off by default: a pipe nobody drains
 * blocks a chatty child forever, which is the reason stdout was discarded here in
 * the first place, and starting a drain for every clone would pay that cost for
 * callers that never read the result.
 * @param command - the executable to spawn.
 * @param args - the arguments, passed as an array.
 * @param cwd - the working directory.
 * @param options - `captureStdout` collects stdout, bounded by {@link COMMUNITY_COMMAND_STDOUT_LIMIT}.
 * @returns the exit code, redacted stderr, and stdout when it was captured.
 */
export function runCommand(command: string, args: readonly string[], cwd: string, options: { readonly captureStdout?: boolean } = {}): Promise<{ readonly code: number; readonly stderr: string; readonly stdout?: string }> {
  // Args are always passed as an array (git clone paths may contain spaces),
  // so no shell quoting layer is needed or safe here.
  const capture = options.captureStdout === true
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'], env: childProcessEnvironment() })
    let stderr = ''
    let stdout = ''
    let timedOut = false
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    if (capture) {
      // Read continuously so the child never blocks on a full pipe, and keep the
      // first window of it: the commands this exists for answer in one short line.
      child.stdout?.on('data', (chunk) => {
        if (stdout.length < COMMUNITY_COMMAND_STDOUT_LIMIT) stdout += String(chunk).slice(0, COMMUNITY_COMMAND_STDOUT_LIMIT - stdout.length)
      })
    }
    // A full stdout pipe would block the child forever; stdout is discarded
    // on purpose and the timer bounds a child that never exits (otherwise it
    // would hold the community install mutex until Host restart).
    const timer = setTimeout(() => { timedOut = true; child.kill() }, COMMUNITY_COMMAND_TIMEOUT_MS)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      const detail = redactCredentialShapes(timedOut ? `${stderr}\ncommunity command timed out after ${COMMUNITY_COMMAND_TIMEOUT_MS / 1_000}s`.trim() : stderr.trim())
      resolve({ code: timedOut ? 1 : code ?? 1, stderr: detail, ...(capture ? { stdout } : {}) })
    })
  })
}

/**
 * Whether a community CLI command is available on this host.
 * @param command - the executable to probe.
 * @returns whether the command answered.
 */
export function commandAvailable(command: string): Promise<boolean> {
  // Installs run through `dsh plugin`, whose child finds `pnpm` on the PATH this
  // plugin hands it — a PATH that starts with the directory `node.exe` lives in,
  // which is where Node's own corepack shims (`pnpm`, `pnpm.cmd`) sit. On
  // Windows that shim is the pnpm an install will actually use, so the probe
  // answers about it rather than about whatever `PATH` happens to hold: a
  // user-writable pnpm reported ready while the shim was missing is the answer
  // that turns every install into a failure after the button was offered.
  if (command === 'pnpm' && process.platform === 'win32') return Promise.resolve(existsSync(pnpmCorepackPath()))
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
    const timer = setTimeout(() => { child.kill(); resolve(false) }, 15_000)
    child.once('error', () => { clearTimeout(timer); resolve(false) })
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
}

function pnpmCorepackPath(): string { return path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js') }

/**
 * Resolve the pnpm install target for a catalog entry.
 * @param entry - the catalog entry's npm name and URL.
 * @returns the pnpm target, or `undefined` when none can be derived.
 */
export function communityInstallTarget(entry: Pick<CommunityCatalogPlugin, 'npm' | 'url'>): string | undefined {
  if (typeof entry.npm === 'string' && NPM_PACKAGE_RE.test(entry.npm)) return entry.npm
  if (typeof entry.url !== 'string') return undefined
  try {
    const url = new URL(entry.url)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return undefined
    const owner = parts[0]
    const rawRepo = parts[1]
    if (owner === undefined || rawRepo === undefined) return undefined
    const repo = `${owner}/${rawRepo.replace(/\.git$/i, '')}`
    if (parts[2]?.toLowerCase() === 'tree' && parts[3] !== undefined) {
      // Preserve the pinned ref so pnpm resolves the same commit the catalog
      // published; a bare `github:owner/repo` target would float to HEAD.
      // A branch name can legitimately contain `/` (`feature/x`), so the
      // ref must be resolved against the subpath rather than split at the
      // first segment: `tree/feature/x` with the package at the repo root
      // previously installed `feature` at path `/x` with no error.
      const joined = parts.slice(3).join('/')
      if (!/^[A-Za-z0-9._/-]+$/.test(joined) || joined.split('/').some(part => part === '' || part === '.' || part === '..')) return undefined
      // pnpm only understands a single-segment ref; a slashed branch cannot be
      // expressed as a `github:` spec, so refuse it explicitly instead of
      // silently installing the wrong commit/path combination.
      if (parts.length >= 5) {
        const subpath = parts.slice(4).join('/')
        if (!/^[A-Za-z0-9_./-]+$/.test(subpath) || subpath.split('/').some(part => part === '' || part === '.' || part === '..')) return undefined
        return `github:${repo}#${parts[3]}&path:/${subpath}`
      }
      return `github:${repo}#${parts[3]}`
    }
    return `github:${repo}`
  } catch { return undefined }
}
