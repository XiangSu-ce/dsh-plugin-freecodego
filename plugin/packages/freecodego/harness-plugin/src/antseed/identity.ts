/**
 * Private-key gateway identity, generated without any upstream package.
 *
 * Why this module exists
 * ----------------------
 * An identity here is a plain secp256k1 private key: 32 bytes, which is 64
 * hexadecimal characters once written out — one fact in two spellings, and the
 * one a user pastes is the hex. The upstream generator (`packages/node/src/p2p/identity.ts` in
 * the upstream repository) is `randomBytes(32)` written to a file, so nothing
 * about producing one requires their code, their CLI, or their npm packages.
 * This plugin generates the key itself and keeps it in the Host credential
 * vault instead of the plaintext key file the CLI would otherwise create.
 *
 * Two derived facts
 * -----------------
 * `peerId` is the lowercase EVM address with no `0x` prefix — on this network
 * the peer id *is* the wallet address, which is why the same value both addresses
 * the node on the DHT and receives USDC. Deriving it is the only part that
 * needs cryptography beyond Node's built-in elliptic curve: the address is
 * `keccak256(uncompressedPublicKey[1..])[12..]`.
 *
 * Node ships secp256k1 through OpenSSL (`createECDH`) but not Keccak-256: its
 * hash table carries `sha3-*` and `shake*` only, and SHA3-256 is *not* a
 * substitute — the two differ in their domain-separation padding (`0x06` for
 * SHA3, `0x01` for Keccak), so the digests never agree. The implementation
 * below is therefore carried here, pinned by the two vectors its spec test
 * asserts (the empty-string digest and the private-key-1 address).
 *
 * A deliberately absent feature
 * -----------------------------
 * Nothing here writes, reads, or deletes a key file. Persistence is the
 * caller's decision and belongs to the credential vault; a module that both
 * generated and stored keys would be one refactor away from silently replacing
 * an existing identity, and that identity is the wallet holding the user's
 * deposits.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/antseed/identity
 */

import { createECDH, randomBytes } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * Environment variable the upstream node reads the identity from.
 *
 * Passing the key this way keeps it off the process command line, which is
 * world-readable on every platform (`ps aux`, `Get-CimInstance Win32_Process`),
 * and out of the plaintext file the CLI would write.
 */
export const ANTSEED_IDENTITY_ENV = 'ANTSEED_IDENTITY_HEX'

/**
 * Credential slot holding this plugin's generated private key.
 *
 * A `privateKey`-quiet name on purpose: the vault is the only place the value
 * is stored, and diagnostics refer to it by this reference rather than by
 * value.
 */
export const ANTSEED_IDENTITY_REF: CredentialRef = credentialRef('ANTSEED_IDENTITY')

/** One gateway identity: the signing key and the peer id derived from it. */
export interface AntSeedIdentity {
  /** The 32-byte secp256k1 private key as 64 lowercase hex characters, no `0x`. */
  readonly privateKeyHex: string
  /** The EVM address derived from the key, lowercase and unprefixed. */
  readonly peerId: string
}

/** Rotation offsets for the rho step, indexed `[x][y]`. */
const ROTATION: readonly (readonly number[])[] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
]

/** Round constants for the iota step, one per permutation round. */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

const MASK64 = (1n << 64n) - 1n
/** Keccak-256 rate in bytes (`1600 - 2 * 256` bits); the capacity stays implicit. */
const KECCAK_RATE = 136

function rotateLeft(value: bigint, bits: number): bigint {
  if (bits === 0) return value
  const shift = BigInt(bits)
  return ((value << shift) | (value >> (64n - shift))) & MASK64
}

/**
 * Ethereum's Keccak-256, the original padding rather than SHA3's.
 *
 * Absorb, permute, squeeze — with the multi-rate padding `0x01 … 0x80` that
 * distinguishes this digest from `sha3-256` for every input.
 * @param bytes - the message to hash.
 * @returns the 32-byte digest.
 */
export function keccak256(bytes: Uint8Array): Uint8Array {
  const paddedLength = bytes.length + (KECCAK_RATE - (bytes.length % KECCAK_RATE))
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x01
  padded[paddedLength - 1] = (padded[paddedLength - 1] as number) | 0x80

  const state = new Array<bigint>(25).fill(0n)
  for (let offset = 0; offset < padded.length; offset += KECCAK_RATE) {
    for (let lane = 0; lane < KECCAK_RATE / 8; lane += 1) {
      let word = 0n
      for (let byte = 7; byte >= 0; byte -= 1) word = (word << 8n) | BigInt(padded[offset + lane * 8 + byte] as number)
      state[lane] = (state[lane] as bigint) ^ word
    }
    for (let round = 0; round < 24; round += 1) {
      const column = new Array<bigint>(5)
      for (let x = 0; x < 5; x += 1) {
        const a = state[x] as bigint
        const b = state[x + 5] as bigint
        const c = state[x + 10] as bigint
        const d = state[x + 15] as bigint
        const e = state[x + 20] as bigint
        column[x] = a ^ b ^ c ^ d ^ e
      }
      for (let x = 0; x < 5; x += 1) {
        const delta = (column[(x + 4) % 5] as bigint) ^ rotateLeft(column[(x + 1) % 5] as bigint, 1)
        for (let y = 0; y < 5; y += 1) state[x + 5 * y] = (state[x + 5 * y] as bigint) ^ delta
      }
      const shuffled = new Array<bigint>(25).fill(0n)
      for (let x = 0; x < 5; x += 1) {
        const rotations = ROTATION[x] as readonly number[]
        for (let y = 0; y < 5; y += 1) {
          const offset = rotations[y] as number
          shuffled[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLeft(state[x + 5 * y] as bigint, offset)
        }
      }
      for (let x = 0; x < 5; x += 1) {
        for (let y = 0; y < 5; y += 1) {
          const base = x + 5 * y
          const left = shuffled[((x + 1) % 5) + 5 * y] as bigint
          const right = shuffled[((x + 2) % 5) + 5 * y] as bigint
          state[base] = (shuffled[base] as bigint) ^ (~left & MASK64 & right)
        }
      }
      state[0] = (state[0] as bigint) ^ (ROUND_CONSTANTS[round] as bigint)
    }
  }

  const digest = new Uint8Array(32)
  for (let lane = 0; lane < 4; lane += 1) {
    for (let byte = 0; byte < 8; byte += 1) digest[lane * 8 + byte] = Number(((state[lane] as bigint) >> BigInt(8 * byte)) & 0xffn)
  }
  return digest
}

/**
 * Whether a value is a shape this module can sign with.
 *
 * Shape only: it does not prove the key is inside secp256k1's order, which
 * {@link antSeedIdentityFromPrivateKeyHex} is what actually decides.
 * @param value - the candidate to inspect.
 * @returns whether the value is a 32-byte key written in hex, optionally `0x`-prefixed.
 */
export function isAntSeedPrivateKeyHex(value: string): boolean {
  return /^(?:0x)?[0-9a-fA-F]{64}$/u.test(value.trim())
}

/**
 * Derive the identity a stored private key names.
 *
 * Accepts the `0x` prefix because the upstream readers accept it and users
 * paste keys in both spellings. A key outside secp256k1's order is refused
 * here rather than at the first signature: the curve's `setPrivateKey` rejects
 * it, and a rejected private key means the caller has a stored value that
 * cannot sign anything.
 * @param hex - the private key, 32 bytes written as 64 hex characters, with an optional `0x` prefix.
 * @returns the identity, with its derived peer id.
 */
export function antSeedIdentityFromPrivateKeyHex(hex: string): AntSeedIdentity {
  if (!isAntSeedPrivateKeyHex(hex)) throw new Error('The private key must be 32 bytes (64 hexadecimal characters)')
  const normalized = hex.trim().replace(/^0x/u, '').toLowerCase()
  const curve = createECDH('secp256k1')
  try {
    curve.setPrivateKey(Buffer.from(normalized, 'hex'))
  } catch (error) {
    // Covers zero and any value at or above the curve order. The message must
    // not carry the key, so only the fact of the refusal travels.
    throw new Error('The private key is outside the secp256k1 range', { cause: error })
  }
  // The uncompressed point, whose first byte is the `0x04` tag the address
  // excludes; the types name the format rather than taking the legacy boolean.
  const uncompressed = curve.getPublicKey(undefined, 'uncompressed')
  const address = keccak256(uncompressed.subarray(1)).subarray(12)
  return { privateKeyHex: normalized, peerId: Buffer.from(address).toString('hex') }
}

/**
 * Generate a new identity.
 *
 * `random` is injectable so a caller can drive generation from its own entropy
 * source, and so a test can pin one. The default is the platform CSPRNG.
 * @param random - byte source for the 32-byte key.
 * @returns the generated identity.
 */
export function generateAntSeedIdentity(random: (size: number) => Uint8Array = randomBytes): AntSeedIdentity {
  const key = random(32)
  if (key.length !== 32) throw new Error('The identity generator must return 32 bytes')
  return antSeedIdentityFromPrivateKeyHex(Buffer.from(key).toString('hex'))
}
