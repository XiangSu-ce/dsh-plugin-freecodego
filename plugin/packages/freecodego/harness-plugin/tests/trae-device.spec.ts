/**
 * The device number the credit endpoints judge.
 *
 * Three properties are load-bearing rather than cosmetic. The *order* puts the number
 * the official client registered first, because that is the only one measured to be
 * accepted (every other shape of the same request is answered `9074`). The *shape* of
 * a fallback has to be a 16-digit decimal, which is what the client itself presents.
 * And the number has to be per account: two accounts presenting one device number is
 * the other measured way to earn `9074`, so a pool must not derive one shared number.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { traeAhaDeviceId, traeCheckinDeviceNumbers, traeClientAhaDeviceId } from '../src/trae/device.ts'

/** The device identity two stored accounts would carry, as the vault holds it. */
const FIRST = 'b'.repeat(32)
const SECOND = 'c'.repeat(32)

/** The Aha number the official China client registers for a machine. */
const CLIENT_AHA = '2363287550100217'

/**
 * A scratch user-data directory, optionally holding one client's storage file.
 * @param directories - each entry is a client directory name and the storage document
 *   to write, or `undefined` to leave that client's file absent.
 * @returns the root to hand the lookup.
 */
function scratchRoot(directories: Readonly<Record<string, unknown | undefined>>): string {
  const root = mkdtempSync(join(tmpdir(), 'trae-root-'))
  for (const [name, document] of Object.entries(directories)) {
    const directory = join(root, name, 'User', 'globalStorage')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'storage.json'), typeof document === 'string' ? document : JSON.stringify(document))
  }
  return root
}

describe('Trae Aha device number', () => {
  it('is a 16-digit number with a non-zero leading digit', () => {
    for (const seed of [FIRST, SECOND, '', 'x', '1'.repeat(32)]) {
      expect(traeAhaDeviceId(seed)).toMatch(/^[1-9]\d{15}$/u)
    }
  })

  it('is stable for one account, so a retry of the same day is the same device', () => {
    expect(traeAhaDeviceId(FIRST)).toBe(traeAhaDeviceId(FIRST))
  })

  it('gives each account its own number', () => {
    expect(traeAhaDeviceId(FIRST)).not.toBe(traeAhaDeviceId(SECOND))
  })

  it('rotates to a different number, because that is what 9074 asks for', () => {
    const sequence = [0, 1, 2, 3, 4].map(rotation => traeAhaDeviceId(FIRST, rotation))
    expect(new Set(sequence).size).toBe(sequence.length)
    expect(sequence.every(number => /^[1-9]\d{15}$/u.test(number))).toBe(true)
  })

  it('is not the hashed identity the conversation path signs with', () => {
    // The seed is hex, and a number returned in that alphabet would be the same
    // device id under another name — the exact thing the credit endpoints refuse.
    expect(traeAhaDeviceId(FIRST)).not.toBe(FIRST)
    expect(traeAhaDeviceId(FIRST)).not.toMatch(/[a-f]/iu)
  })
})

describe('Trae client device number', () => {
  it('reads the number the official client stores for this machine', () => {
    const root = scratchRoot({ 'Trae CN': { [`iCubeAuthInfo://icube-dc:${CLIENT_AHA}`]: 'secret', 'telemetry.machineId': 'a'.repeat(64) } })
    expect(traeClientAhaDeviceId(root)).toBe(CLIENT_AHA)
  })

  it('prefers the SOLO client when both are installed', () => {
    const root = scratchRoot({
      'TRAE SOLO CN': { 'iCubeAuthInfo://icube-dc:1111111111111111': 'a' },
      'Trae CN': { 'iCubeAuthInfo://icube-dc:2222222222222222': 'b' },
    })
    expect(traeClientAhaDeviceId(root)).toBe('1111111111111111')
  })

  it('offers nothing for a machine with no client, an unreadable file, or a non-numeric key', () => {
    // The lookup is a courtesy, not a dependency: a machine without the client has to
    // fall through to the derived number rather than fail the check-in.
    expect(traeClientAhaDeviceId(scratchRoot({}))).toBeUndefined()
    expect(traeClientAhaDeviceId(scratchRoot({ 'Trae CN': '{ not json' }))).toBeUndefined()
    expect(traeClientAhaDeviceId(scratchRoot({ 'Trae CN': { 'iCubeAuthInfo://usertag': 'x', 'iCubeAuthInfo://icube-dc:': 'y' } }))).toBeUndefined()
  })
})

describe('Trae check-in device ladder', () => {
  it('presents the client number first, then the account\'s own derived numbers', () => {
    // Order is the whole point: the client's number is the one measured to be
    // accepted, so nothing may be tried before it.
    const devices = traeCheckinDeviceNumbers(FIRST, 5, CLIENT_AHA)
    expect(devices[0]).toBe(CLIENT_AHA)
    expect(devices.slice(1)).toEqual([0, 1, 2, 3].map(rotation => traeAhaDeviceId(FIRST, rotation)))
    expect(new Set(devices).size).toBe(5)
  })

  it('covers the requested attempts with derived numbers when there is no client number', () => {
    const devices = traeCheckinDeviceNumbers(FIRST, 4, undefined)
    expect(devices).toHaveLength(4)
    expect(devices.every(number => /^[1-9]\d{15}$/u.test(number))).toBe(true)
    expect(devices).toEqual([0, 1, 2, 3].map(rotation => traeAhaDeviceId(FIRST, rotation)))
  })

  it('never repeats a number, even when the client filed one that matches a derived one', () => {
    const devices = traeCheckinDeviceNumbers(FIRST, 3, traeAhaDeviceId(FIRST, 0))
    expect(new Set(devices).size).toBe(3)
  })
})
