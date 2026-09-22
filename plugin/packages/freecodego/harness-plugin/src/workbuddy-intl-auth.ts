/**
 * WorkBuddy International (workbuddy.ai) desktop authorization import.
 *
 * The WorkBuddy desktop app records its sign-in in a local auth file; the
 * official ecosystem plugins read that file instead of driving a password
 * form. This module mirrors that flow for the FreeCodeGo Harness: the Settings
 * card asks the Host to open the platform's sign-in page, the user signs in
 * once in the desktop app (or any writer of that file), and the card imports
 * the resulting credential — normalized to the same account shape the email
 * login produced.
 *
 * Windows, macOS, and Linux (including WSL reading a Windows profile) probe
 * the same platform paths the desktop app is known to write. Import never
 * writes the desktop file; refreshed tokens go to the plugin-owned vault.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/workbuddy-intl-auth
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, join } from 'node:path'

/** A credential imported from the desktop app's own auth file. */
export interface WorkBuddyDesktopCredential {
  accessToken: string
  refreshToken: string
  /** Epoch ms; `0` means the file carried no readable expiry. */
  expiresAtMs: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  /** Which platform path the credential was read from. */
  sourcePath: string
}

/** One missing-credential diagnosis, worded for the settings card. */
export interface WorkBuddyImportFailure {
  readonly ok: false
  readonly reason: 'not-signed-in' | 'unreadable'
  readonly message: string
  /** Every path probed, so a user can check the file exists. */
  readonly probed: readonly string[]
}

/** One successful import. */
export interface WorkBuddyImportSuccess {
  readonly ok: true
  readonly credential: WorkBuddyDesktopCredential
  readonly probed: readonly string[]
}

/** The outcome of importing a desktop WorkBuddy credential. */
export type WorkBuddyImportResult = WorkBuddyImportSuccess | WorkBuddyImportFailure

/** Shared `CodeBuddyExtension` auth directory relative path (international app). */
const DESKTOP_AUTH_RELATIVE = ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info'] as const

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (path === undefined || path === '') return undefined
  if (path.startsWith('/')) return path
  const drive = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drive === null) return undefined
  return join('/mnt', drive[1]!.toLowerCase(), ...drive[2]!.split(/[\\/]+/u))
}

/** Windows profile candidates visible from WSL, probed before native Linux. */
function wslDesktopCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE']) ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA']) ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA']) ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...DESKTOP_AUTH_RELATIVE),
    join(roamingAppData, ...DESKTOP_AUTH_RELATIVE),
  ]
}

/**
 * Platform candidates for the WorkBuddy International desktop auth file, in
 * probe order. Windows probes both AppData roots (current builds write under
 * Local, older ones under Roaming); WSL reads the same Windows locations.
 * @returns the candidate paths, in probe order.
 */
export function workbuddyDesktopAuthCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...DESKTOP_AUTH_RELATIVE)]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', ...DESKTOP_AUTH_RELATIVE),
      join(home, 'AppData', 'Roaming', ...DESKTOP_AUTH_RELATIVE),
    ]
  }
  if (process.platform === 'linux') {
    const native = join(home, '.config', ...DESKTOP_AUTH_RELATIVE)
    return isWsl() ? [...wslDesktopCandidates(home), native] : [native]
  }
  return []
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

/**
 * Parse a WorkBuddy auth document in either observed shape: the nested
 * `{"auth":{...},"account":{...}}` form and the flat panel form. Returns
 * `undefined` when the document carries no access token.
 * @param text - the auth document's raw JSON text.
 * @returns the parsed credential, or `undefined` when no access token is present.
 */
export function parseWorkBuddyDesktopAuth(text: string): Omit<WorkBuddyDesktopCredential, 'sourcePath'> | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = optionalString(auth['accessToken'])
  if (accessToken === '') return undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  return {
    accessToken,
    refreshToken: optionalString(auth['refreshToken']),
    expiresAtMs: expiryToMs(auth['expiresAt']),
    domain: optionalString(auth['domain']),
    uid: optionalString(identity['uid']),
    ...(enterpriseId === '' ? {} : { enterpriseId }),
    ...(nickname === '' ? {} : { nickname }),
  }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Import the desktop app's credential.
 *
 * Only an absent file falls through to the next candidate; a file that is
 * present but unreadable or unparsable is authoritative for its slot, so a
 * half-written or locked newer file never silently loses to an older one.
 * The two failures are reported apart because they need different fixes: an
 * unparsable file means signing in again, an unreadable one means the file's
 * permissions.
 * @returns the work Buddy Import Result.
 */
export async function importWorkBuddyDesktopCredential(): Promise<WorkBuddyImportResult> {
  const candidates = workbuddyDesktopAuthCandidates()
  const probed: string[] = []
  for (const candidate of candidates) {
    probed.push(candidate)
    let text: string
    try {
      const info = await stat(candidate)
      if (!info.isFile()) continue
      text = await readFile(candidate, 'utf8')
    } catch (error: unknown) {
      // An absent file falls through to the next candidate. Anything else means
      // a file is present at this slot but cannot be read — a permission, a
      // sharing violation on Windows, a path that is not a regular file — and
      // that is authoritative for the slot for the same reason a present but
      // unparsable file is. Falling through would let an older candidate win and
      // silently import the credential the user is trying to replace, while
      // reporting nothing about the file that actually holds the newer one.
      if (!isENOENT(error)) {
        return {
          ok: false,
          reason: 'unreadable',
          message: 'WorkBuddy 桌面端凭证文件存在但无法读取，请检查该文件的权限后重试，或在 WorkBuddy 桌面应用中重新登录一次。',
          probed,
        }
      }
      continue
    }
    const parsed = parseWorkBuddyDesktopAuth(text)
    if (parsed === undefined) {
      return {
        ok: false,
        reason: 'unreadable',
        message: 'WorkBuddy 桌面端凭证文件存在但无法解析，请先在 WorkBuddy 桌面应用中重新登录一次。',
        probed,
      }
    }
    return { ok: true, credential: { ...parsed, sourcePath: candidate }, probed }
  }
  return {
    ok: false,
    reason: 'not-signed-in',
    message: '未找到 WorkBuddy 桌面端登录凭证。请先登录 WorkBuddy 桌面应用（workbuddy.ai 国际版），再点击「导入桌面端登录」。',
    probed,
  }
}
