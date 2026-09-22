/**
 * The device number the credit endpoints accept.
 *
 * What `9074` actually means
 * -------------------------
 * The claim answers `9074` with the message "当前参与用户太多，请稍后再试" — "too
 * many users participating, try again later" — which reads like a capacity gate and
 * is not one. Measured against a real account on a machine with the official client
 * installed, every shape of the request is refused the same way *except* the one
 * that presents the number the client itself registered: same headers, same body,
 * same URL, same access token, and the claim goes through with `code: 0`. It is a
 * refusal of the **device**, and the message is upstream's own red herring. (The
 * references each half-remember this: one reports that a GUID or UUID device id
 * triggers `9074` and resolves the number from the client's storage file, another
 * rotates the number on `9074` until one is accepted, and a third notes that
 * synthetic device ids are answered oddly. The measurement above is what makes the
 * order below a decision rather than a guess.)
 *
 * Two device identities, and they are not interchangeable
 * -------------------------------------------------------
 * `telemetry.devDeviceId` is a UUID; the Aha number is decimal digits — 16 of them
 * for the China client, and the value the client stores under the key
 * `iCubeAuthInfo://icube-dc:<digits>`. This connector signs in with its own hashed
 * machine identity and the conversation path accepts it, so that identity is left
 * alone; the credit path presents the client's number instead, because that is what
 * its risk control is keyed on.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/trae/device
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The storage key the client keeps its Aha device number in. */
const AHA_KEY_PREFIX = 'iCubeAuthInfo://icube-dc:'

/**
 * The client install directories, in the order they are searched.
 *
 * The SOLO product first, then the classic client, matching the reference desktop
 * tool: an account signed into both should present the one the SOLO channel was
 * authorized under.
 */
const CLIENT_DIRECTORIES = ['TRAE SOLO CN', 'Trae CN', 'TRAE SOLO'] as const

/** How many decimal digits an Aha device number has. */
const AHA_DEVICE_ID_DIGITS = 16

/** The place values the digits after the first one are drawn from. */
const AHA_TAIL_PLACES = 10n ** BigInt(AHA_DEVICE_ID_DIGITS - 1)

/** Where the client's per-user data lives on this machine. */
function clientRoot(): string {
  return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
}

/**
 * The Aha device number the official client registered on this machine.
 *
 * Read-only and fully optional: a machine without the client, or with a storage
 * file this process may not read, simply has no number to offer, and the credit
 * path falls back to a derived one. Nothing here is stored or transmitted anywhere
 * except as the `x-device-id` of a request to the same service the client talks to.
 * @param root - the user-data directory to search; the real one unless a test says otherwise.
 * @returns the number, or `undefined` when this machine has none to offer.
 */
export function traeClientAhaDeviceId(root: string = clientRoot()): string | undefined {
  for (const directory of CLIENT_DIRECTORIES) {
    const file = join(root, directory, 'User', 'globalStorage', 'storage.json')
    if (!existsSync(file)) continue
    let document: unknown
    try {
      document = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // An unreadable or unparsable file is not this feature's problem to fix.
      continue
    }
    if (typeof document !== 'object' || document === null) continue
    for (const key of Object.keys(document)) {
      if (!key.startsWith(AHA_KEY_PREFIX)) continue
      const id = key.slice(AHA_KEY_PREFIX.length)
      // Digits only: the international client stores a longer number under the same
      // key, and the China credit endpoints are the only ones this is for.
      if (id.length >= 8 && /^\d+$/u.test(id)) return id
    }
  }
  return undefined
}

/**
 * A device number derived from one account, optionally rotated.
 *
 * The fallback, for a machine that cannot offer the client's own number. The result
 * is always a 16-digit decimal with a non-zero leading digit — the shape the client
 * uses — and it is derived rather than drawn so a retry of the same day presents the
 * same device, which is what lets a rotation be a deliberate act instead of noise.
 * @param seed - the per-account value it is derived from.
 * @param rotation - which number in this seed's sequence to return.
 * @returns the 16-digit device number.
 */
export function traeAhaDeviceId(seed: string, rotation = 0): string {
  const digest = createHash('sha256').update(`${seed}#${String(rotation)}`).digest('hex')
  // The leading digit is drawn separately rather than by dividing a 16-digit range:
  // it keeps every draw inside the range the platform's integer APIs reach, which is
  // exactly how the reference client builds one.
  const head = (Number.parseInt(digest.slice(0, 2), 16) % 9) + 1
  const tail = (BigInt(`0x${digest.slice(2, AHA_DEVICE_ID_DIGITS + 1)}`) % AHA_TAIL_PLACES)
    .toString()
    .padStart(AHA_DEVICE_ID_DIGITS - 1, '0')
  return `${String(head)}${tail}`
}

/**
 * The device numbers one account's claim attempts present, in order.
 *
 * The client's own number first, because it is the one that was measured to be
 * accepted; then the account's derived number, then its rotations, because a device
 * the campaign has not seen is what the rotating reference recovers with.
 * @param seed - the account's stored device identity, the seed for the fallbacks.
 * @param count - how many attempts the caller is prepared to make.
 * @param clientDeviceId - the client's own number, when this machine has one.
 * @returns one number per attempt, deduplicated so no attempt repeats another.
 */
export function traeCheckinDeviceNumbers(
  seed: string,
  count: number,
  clientDeviceId: string | undefined,
): readonly string[] {
  const numbers: string[] = []
  if (clientDeviceId !== undefined) numbers.push(clientDeviceId)
  for (let rotation = 0; numbers.length < count; rotation += 1) {
    const candidate = traeAhaDeviceId(seed, rotation)
    if (!numbers.includes(candidate)) numbers.push(candidate)
  }
  return numbers
}
