import { describe, expect, it } from 'vitest'
import {
  antSeedIdentityFromPrivateKeyHex,
  ANTSEED_IDENTITY_ENV,
  generateAntSeedIdentity,
  isAntSeedPrivateKeyHex,
  keccak256,
} from '../src/antseed/identity.ts'

/** `i % 251` repeated, so every lane and every byte position differs. */
function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) bytes[index] = index % 251
  return bytes
}

/**
 * Digests produced by `ethers`' `keccak256` (an independent implementation, not
 * this module's), captured for the lengths that exercise every absorb path: the
 * empty message, a sub-block message, both sides of the 136-byte rate boundary,
 * and a two-block message. A padding mistake shows up as a whole-digest
 * difference, so one vector per boundary is enough.
 */
const KECCAK_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [0, 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
  [1, 'bc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a'],
  [135, 'cbdfd9dee5faad3818d6b06f95a219fd290b0e1706f6a82e5a595b9ce9faca62'],
  [136, '7ce759f1ab7f9ce437719970c26b0a66ff11fe3e38e17df89cf5d29c7d7f807e'],
  [137, 'ac73d4fae68b8453f764007c1a20ce95994187861f0c3227a3a8e99a73a3b1db'],
  [272, '8e2476e65823b24d96ebe239f2c1534cdf763e689e2410c3b1cb0c74e6177bfc'],
]

/** Private key to expected EVM address, both from `ethers`. */
const ADDRESS_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['0'.repeat(63) + '1', '7e5f4552091a69125d5dfcb7b8c2659029395bdf'],
  ['0'.repeat(63) + '2', '2b5ad5c4795c026514f8317c7a215e218dccd6cf'],
  ['0'.repeat(62) + 'ff', '5044a80bd3eff58302e638018534bbda8896c48a'],
  ['abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', '639d6caadb5617d324c1ad0becb16262fc58ce5f'],
]

describe('AntSeed identity', () => {
  describe('keccak256', () => {
    it.each(KECCAK_VECTORS)('matches the independent digest for %i bytes', (length, expected) => {
      expect(Buffer.from(keccak256(pattern(length))).toString('hex')).toBe(expected)
    })

    it('is Keccak, not SHA3-256', () => {
      // The two digests agree on nothing; asserting the difference is what stops
      // a future edit from "simplifying" this into node:crypto's sha3-256, which
      // Node does ship and which would produce a syntactically valid address for
      // a key nobody controls the peer id of.
      const sha3 = Buffer.from(new Uint8Array(0)).toString('hex')
      expect(sha3).toBe('')
      expect(Buffer.from(keccak256(new Uint8Array(0))).toString('hex')).not.toBe('a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a')
    })
  })

  describe('antSeedIdentityFromPrivateKeyHex', () => {
    it.each(ADDRESS_VECTORS)('derives the peer id for key %s', (key, address) => {
      expect(antSeedIdentityFromPrivateKeyHex(key).peerId).toBe(address)
    })

    it('normalizes the 0x prefix and upper case to one stored spelling', () => {
      const identity = antSeedIdentityFromPrivateKeyHex(`0x${'AB'.repeat(32)}`)
      expect(identity.privateKeyHex).toBe('ab'.repeat(32))
      expect(identity.privateKeyHex).toHaveLength(64)
    })

    it('refuses a key that is not 32 bytes of hex', () => {
      expect(() => antSeedIdentityFromPrivateKeyHex('abc')).toThrow('The private key must be 32 bytes (64 hexadecimal characters)')
    })

    it('refuses a key outside the curve order', () => {
      // Zero is a syntactically perfect key that cannot sign anything: the
      // refusal has to come from the curve, not from the shape check.
      expect(isAntSeedPrivateKeyHex('0'.repeat(64))).toBe(true)
      expect(() => antSeedIdentityFromPrivateKeyHex('0'.repeat(64))).toThrow('outside the secp256k1 range')
      expect(() => antSeedIdentityFromPrivateKeyHex('f'.repeat(64))).toThrow('outside the secp256k1 range')
    })

    it('never repeats the key in its refusal', () => {
      const key = 'f'.repeat(64)
      try {
        antSeedIdentityFromPrivateKeyHex(key)
        expect.unreachable('an out-of-range key must be refused')
      } catch (error) {
        expect((error as Error).message).not.toContain(key)
      }
    })
  })

  describe('isAntSeedPrivateKeyHex', () => {
    it('accepts both spellings and rejects everything else', () => {
      expect(isAntSeedPrivateKeyHex('a'.repeat(64))).toBe(true)
      expect(isAntSeedPrivateKeyHex(`0x${'a'.repeat(64)}`)).toBe(true)
      expect(isAntSeedPrivateKeyHex(`  ${'a'.repeat(64)}  `)).toBe(true)
      expect(isAntSeedPrivateKeyHex('a'.repeat(63))).toBe(false)
      expect(isAntSeedPrivateKeyHex('a'.repeat(65))).toBe(false)
      expect(isAntSeedPrivateKeyHex(`0x${'a'.repeat(63)}`)).toBe(false)
      expect(isAntSeedPrivateKeyHex(`0X${'a'.repeat(64)}`)).toBe(false)
      expect(isAntSeedPrivateKeyHex('g'.repeat(64))).toBe(false)
      expect(isAntSeedPrivateKeyHex('')).toBe(false)
    })
  })

  describe('generateAntSeedIdentity', () => {
    it('generates a usable identity from the platform entropy source', () => {
      const identity = generateAntSeedIdentity()
      expect(isAntSeedPrivateKeyHex(identity.privateKeyHex)).toBe(true)
      expect(identity.peerId).toMatch(/^[0-9a-f]{40}$/u)
      // The generator is the identity's own reader: feeding the key back has to
      // name the same peer, or the address it displayed was never the address.
      expect(antSeedIdentityFromPrivateKeyHex(identity.privateKeyHex).peerId).toBe(identity.peerId)
    })

    it('derives the peer id of the bytes its injected source returned', () => {
      const injected = Buffer.alloc(32, 0)
      injected[31] = 1
      const identity = generateAntSeedIdentity(() => injected)
      expect(identity.privateKeyHex).toBe('0'.repeat(63) + '1')
      expect(identity.peerId).toBe(ADDRESS_VECTORS[0]![1])
    })

    it('refuses a source that does not return 32 bytes', () => {
      expect(() => generateAntSeedIdentity(() => new Uint8Array(31))).toThrow('must return 32 bytes')
    })
  })

  it('names the environment variable AntSeed reads', () => {
    // The spawn path and this constant have to agree, and the mismatch is
    // silent: the buyer would generate its own key in its data directory.
    expect(ANTSEED_IDENTITY_ENV).toBe('ANTSEED_IDENTITY_HEX')
  })
})
