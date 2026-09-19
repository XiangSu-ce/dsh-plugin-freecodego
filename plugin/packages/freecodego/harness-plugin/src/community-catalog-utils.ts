import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertExternalEngineeringAssetSafe } from './engineering.ts'
import { childProcessEnvironment } from './engineering-graphify.ts'
import { readJsonFile } from './community-storage.ts'
import { redactCredentialShapes } from './secret-scan.ts'
import type { CommunityCatalogPlugin } from './types.ts'

const COMMUNITY_ASSET_HOSTS = new Set(['raw.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com', 'github.com'])
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function marketplaceUrl(value: unknown): string | undefined { if (typeof value !== 'string' || value.trim() === '') return undefined; try { const url = new URL(value.trim()); if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined; url.username = ''; url.password = ''; return url.toString() } catch { return undefined } }
export function communityCatalogAssetUrl(value: unknown): string | undefined { const normalized = marketplaceUrl(value); if (normalized === undefined) return undefined; try { return COMMUNITY_ASSET_HOSTS.has(new URL(normalized).hostname.toLowerCase()) ? normalized : undefined } catch { return undefined } }
export function verifiedGithubAssetUrl(value: unknown): string | undefined { const normalized = marketplaceUrl(value); if (normalized === undefined) return undefined; try { return new URL(normalized).hostname.toLowerCase() === 'raw.githubusercontent.com' ? normalized : undefined } catch { return undefined } }
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
export interface GithubCommunityRepository { readonly owner: string; readonly repository: string; readonly ref?: string; readonly directory?: string }
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

/** `null` means the repository was checked but provides no icon; `undefined` is retryable. */
export async function resolveCommunityRepositoryIcon(sourceUrl: string): Promise<string | null | undefined> {
  const repository = githubCommunityRepository(sourceUrl)
  if (repository === undefined) return null
  const result = await resolveCommunityRepositoryDirectoryIcon(repository)
  if (result !== null || repository.directory === undefined) return result
  // Catalog entries often point at a package nested in a monorepo. The listing
  // convention falls back to its repository README, so visual discovery does too.
  return resolveCommunityRepositoryDirectoryIcon({ owner: repository.owner, repository: repository.repository, ...(repository.ref === undefined ? {} : { ref: repository.ref }) })
}

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

/** The filesystem steps a promotion takes, injected so its failure paths are testable. */
export interface SkillPromotionIo {
  readonly mkdir: (path: string) => Promise<void>
  readonly copy: (from: string, to: string) => Promise<void>
  readonly move: (from: string, to: string) => Promise<void>
  readonly remove: (path: string) => Promise<void>
  readonly exists: (path: string) => Promise<boolean>
}

/** The real filesystem, as a promotion uses it. */
export const NODE_SKILL_PROMOTION_IO: SkillPromotionIo = {
  mkdir: async (path) => { await fs.mkdir(path, { recursive: true }) },
  copy: async (from, to) => { await fs.cp(from, to, { recursive: true }) },
  move: async (from, to) => { await fs.rename(from, to) },
  remove: async (path) => { await fs.rm(path, { recursive: true, force: true }) },
  exists: async (path) => fs.stat(path).then(() => true, () => false),
}

/**
 * The two transient paths a promotion uses, both beside the destination.
 *
 * Beside it rather than in the system temp directory because a rename across
 * filesystems is a copy, and a copy is the step that cannot be undone. Named
 * after the destination rather than with a random token because the names are
 * how a promotion that was killed between its two renames is recognized and
 * finished by the next one — and because two installs of the same Skill should
 * collide loudly instead of interleaving silently.
 */
export function skillPromotionPaths(destination: string): { readonly staged: string; readonly backup: string } {
  const parent = path.dirname(destination)
  const name = path.basename(destination)
  return {
    staged: path.join(parent, `.freecodego-skill-staging-${name}`),
    backup: path.join(parent, `.freecodego-skill-backup-${name}`),
  }
}

/**
 * Install a prepared payload directory at its destination, recoverably.
 *
 * The three rules, borrowed from `skills/installer.ts` because they apply to any
 * Skill an agent reads at discovery time:
 *
 * 1. **Nothing appears at the destination until the payload is complete.** The
 *    copy lands in a staging directory, so a copy that fails halfway is a
 *    directory nobody reads rather than a Skill whose `SKILL.md` promises files
 *    that are not there — which no later session can tell from an intentionally
 *    small Skill.
 * 2. **A replaced Skill is recoverable.** The installed version is renamed
 *    aside first and renamed back if the promotion fails, so an upgrade that
 *    fails leaves the working version working.
 * 3. **An interrupted promotion is finished, not stacked.** The names are
 *    derived from the destination, so a promotion killed between its two renames
 *    is found by the next one: the version under the backup name is put back if
 *    the destination is gone, and cleared if it is not. Either way no copy of a
 *    Skill is left lying beside the real one — the Skill service lists every
 *    directory under a root, so a leftover is not invisible to it.
 * @param source - the directory to install, already screened.
 * @param destination - where the Skill belongs.
 * @param io - the filesystem steps, injectable so the failure paths can be driven.
 */
export async function promoteSkillDirectory(source: string, destination: string, io: SkillPromotionIo = NODE_SKILL_PROMOTION_IO): Promise<void> {
  const { staged, backup } = skillPromotionPaths(destination)
  await io.mkdir(path.dirname(destination))
  if (await io.exists(backup)) {
    if (await io.exists(destination)) await io.remove(backup)
    else await io.move(backup, destination)
  }
  // A staging directory left by an interrupted attempt holds an unknown mixture;
  // copying over it would keep every file this payload does not have.
  await io.remove(staged)
  try {
    await io.copy(source, staged)
  } catch (error) {
    await io.remove(staged)
    throw new Error(`the Skill payload could not be staged, so the installed version was left untouched: ${detail(error)}`)
  }
  let moved = false
  try {
    // A rename is the existence probe as well as the move, so there is no window
    // between "is it there" and "move it" for another install to slip into.
    await io.move(destination, backup)
    moved = true
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      await io.remove(staged)
      throw new Error(`the Skill installed at ${destination} could not be moved aside, so the payload was not promoted: ${detail(error)}`)
    }
  }
  try {
    await io.move(staged, destination)
  } catch (error) {
    if (moved) await io.move(backup, destination).catch(() => undefined)
    await io.remove(staged)
    throw new Error(`the Skill could not be promoted${moved ? '; the previously installed version was restored' : ''}: ${detail(error)}`)
  }
  if (moved) await io.remove(backup)
}

function detail(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function errorCode(error: unknown): string | undefined { return (error as { readonly code?: string } | undefined)?.code }

export async function importGithubSkill(input: { readonly source: string; readonly skillName: string; readonly destination: string }): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'freecodego-skill-marketplace-'))
  try {
    const repository = `https://github.com/${input.source}.git`
    const clone = await runCommand('git', ['clone', '--depth', '1', '--filter=blob:none', repository, temporary], process.cwd())
    if (clone.code !== 0) throw new Error(clone.stderr.trim() || 'git could not clone the Skill repository')
    const found = await findSkillDirectory(temporary, input.skillName)
    // "Not there" and "not looked for" are different answers, and the search's own
    // budget is why: past it, a repository that holds the Skill is indistinguishable
    // from one that does not, so the refusal has to describe the search instead of
    // telling the user their repository is missing something it may well have.
    if (found === 'exhausted') {
      throw new Error(`the Skill repository holds more entries than the Skill search walks (${String(SKILL_SEARCH_ENTRY_LIMIT)}), so a SKILL.md named "${input.skillName}" could not be looked for; install it from a repository that keeps the Skill nearer its root`)
    }
    if (found === 'not-found') throw new Error(`repository does not contain a SKILL.md named "${input.skillName}"`)
    const source = found.directory
    // Before the body is read: a link in the payload would otherwise decide both
    // which file this scan inspects and which file the installed Skill names.
    await assertSkillPayloadHasNoLinks(source)
    const skill = await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')
    assertExternalEngineeringAssetSafe(`skill:${input.source}/${input.skillName}`, skill, true)
    await promoteSkillDirectory(source, input.destination)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
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

export function runCommand(command: string, args: readonly string[], cwd: string): Promise<{ readonly code: number; readonly stderr: string }> {
  // Args are always passed as an array (git clone paths may contain spaces),
  // so no shell quoting layer is needed or safe here.
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: childProcessEnvironment() })
    let stderr = ''
    let timedOut = false
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    // A full stdout pipe would block the child forever; stdout is discarded
    // on purpose and the timer bounds a child that never exits (otherwise it
    // would hold the community install mutex until Host restart).
    const timer = setTimeout(() => { timedOut = true; child.kill() }, COMMUNITY_COMMAND_TIMEOUT_MS)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      const detail = redactCredentialShapes(timedOut ? `${stderr}\ncommunity command timed out after ${COMMUNITY_COMMAND_TIMEOUT_MS / 1_000}s`.trim() : stderr.trim())
      resolve({ code: timedOut ? 1 : code ?? 1, stderr: detail })
    })
  })
}

export function commandAvailable(command: string): Promise<boolean> {
  // On Windows the executor (runPnpm) only accepts the corepack-bundled pnpm;
  // probing PATH would report ready while every install then fails.
  if (command === 'pnpm' && process.platform === 'win32') return Promise.resolve(existsSync(pnpmCorepackPath()))
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
    const timer = setTimeout(() => { child.kill(); resolve(false) }, 15_000)
    child.once('error', () => { clearTimeout(timer); resolve(false) })
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
}

function pnpmCorepackPath(): string { return path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js') }

export function runPnpm(cwd: string, args: readonly string[]): Promise<{ readonly code: number; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const corepackPnpm = pnpmCorepackPath()
    const command = process.platform === 'win32' ? process.execPath : 'pnpm'
    const commandArgs = process.platform === 'win32' ? [corepackPnpm, ...args] : args
    if (process.platform === 'win32' && !existsSync(corepackPnpm)) {
      reject(new Error(`pnpm CLI is unavailable at ${corepackPnpm}`))
      return
    }
    const child = spawn(command, commandArgs, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: childProcessEnvironment() })
    let stderr = ''
    let timedOut = false
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    // Same mutex concern as runCommand: bound a child that never exits.
    const timer = setTimeout(() => { timedOut = true; child.kill() }, COMMUNITY_COMMAND_TIMEOUT_MS)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      const detail = redactCredentialShapes(timedOut ? `${stderr}\npnpm command timed out after ${COMMUNITY_COMMAND_TIMEOUT_MS / 1_000}s`.trim() : stderr.trim())
      resolve({ code: timedOut ? 1 : code ?? 1, stderr: detail })
    })
  })
}

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
