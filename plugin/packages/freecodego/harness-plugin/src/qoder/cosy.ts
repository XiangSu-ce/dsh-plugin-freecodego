/**
 * The `cosy` signed-request protocol Qoder speaks.
 *
 * Every API call carries a per-account session payload (an AES-encrypted
 * identity blob plus an RSA-wrapped session key) signed with an MD5 digest over
 * the request line, and a derived device fingerprint. This module ports the
 * protocol verbatim from the reference gateway so a session built here produces
 * byte-identical signatures.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/qoder/cosy
 */

import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, randomUUID, constants } from 'node:crypto'
import { asRecord, asString } from '../untrusted-json.ts'
import type { QoderIdentity, QoderSession } from './types.ts'

/** Protocol version advertised in the session payload. */
export const COSY_VERSION = '1.0.10'
/** Application code in the legacy signature. */
const COSY_APP_CODE = 'cosy'
/** `base64("war, war never changes")`, the constant legacy secret. */
const COSY_SECRET_B64 = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=='

/** Qoder's shuffled base64 alphabet. */
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
/** The standard base64 alphabet the shuffling is defined against. */
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Custom padding character. */
const CUSTOM_PAD = '$'

/** RSA public key Qoder wraps the session key with. */
const SERVER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

const toStd = new Int8Array(128).fill(-1)
const toCustom = new Int8Array(128).fill(-1)
for (let index = 0; index < 64; index++) {
  toStd[CUSTOM_ALPHABET.charCodeAt(index)] = STD_ALPHABET.charCodeAt(index)
  toCustom[STD_ALPHABET.charCodeAt(index)] = CUSTOM_ALPHABET.charCodeAt(index)
}
toStd[CUSTOM_PAD.charCodeAt(0)] = '='.charCodeAt(0)
toCustom['='.charCodeAt(0)] = CUSTOM_PAD.charCodeAt(0)

/** Lowercase MD5 hex of a UTF-8 string. */
export function md5Hex(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex')
}

/** Lowercase SHA-512 base64url of a UTF-8 string. */
function sha512Base64Url(value: string): string {
  return createHash('sha512').update(value, 'utf8').digest('base64url')
}

/** Encode bytes with Qoder's shuffled base64. */
export function cosyEncode(plaintext: Buffer): string {
  const std = plaintext.toString('base64')
  const length = std.length
  const rotate = Math.floor(length / 3)
  const rearranged = std.slice(length - rotate) + std.slice(rotate, length - rotate) + std.slice(0, rotate)
  let out = ''
  for (let index = 0; index < length; index++) {
    const mapped = toCustom[rearranged.charCodeAt(index)] ?? -1
    if (mapped < 0) throw new Error('cosy encode: character outside the alphabet')
    out += String.fromCharCode(mapped)
  }
  return out
}

/** Decode Qoder's shuffled base64. */
export function cosyDecode(encoded: string): Buffer {
  const length = encoded.length
  const mapped = Buffer.alloc(length)
  for (let index = 0; index < length; index++) {
    const value = toStd[encoded.charCodeAt(index)] ?? -1
    if (value < 0) throw new Error('cosy decode: character outside the alphabet')
    mapped[index] = value
  }
  const rotate = Math.floor(length / 3)
  const std = mapped.subarray(length - rotate).toString('ascii')
    + mapped.subarray(rotate, length - rotate).toString('ascii')
    + mapped.subarray(0, rotate).toString('ascii')
  return Buffer.from(std, 'base64')
}

/** The RFC-1123 UTC date the legacy signature is computed over. */
export function cosyCurrentDate(): string {
  return new Date().toUTCString()
}

/** The legacy request signature (used only by the PAT job-token exchange). */
export function cosySignLegacy(date: string): string {
  return md5Hex(`${COSY_APP_CODE}&${COSY_SECRET_B64}&${date}`)
}

/** The per-request signature over the payload, session key, date, body, and path. */
export function cosySignRequest(payloadB64: string, cosyKey: string, cosyDate: string, body: string, pathSig: string): string {
  return md5Hex(`${payloadB64}\n${cosyKey}\n${cosyDate}\n${body}\n${pathSig}`)
}

/** Build the base64 session payload carried in the Bearer token and `cosy-key`. */
export function cosyBuildPayload(info: string): string {
  return Buffer.from(JSON.stringify({
    cosyVersion: COSY_VERSION,
    ideVersion: '',
    info,
    requestId: randomUUID(),
    version: 'v1',
  }), 'utf8').toString('base64')
}

/** Compose the `Bearer COSY.<payload>.<signature>` authorization value. */
export function cosyComposeBearer(payloadB64: string, signature: string): string {
  return `Bearer COSY.${payloadB64}.${signature}`
}

/** Derive the path that participates in the signature (leading `/algo` stripped). */
export function cosyPathSig(rawUrl: string): string {
  const path = new URL(rawUrl).pathname
  return path.startsWith('/algo') ? path.slice('/algo'.length) : path
}

function rsaEncrypt(plaintext: Buffer): Buffer {
  return publicEncrypt({ key: createPublicKey(SERVER_PUBLIC_KEY_PEM), padding: constants.RSA_PKCS1_PADDING }, plaintext)
}

function aesEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, key)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** The JSON identity blob the session payload encrypts. */
function authPayload(identity: QoderIdentity): Buffer {
  return Buffer.from(JSON.stringify({
    name: identity.name,
    aid: identity.aid,
    uid: identity.uid,
    yx_uid: '',
    organization_id: identity.organizationId ?? '',
    organization_name: identity.organizationName ?? '',
    user_type: identity.userType,
    security_oauth_token: identity.securityOauthToken,
    refresh_token: identity.refreshToken ?? '',
  }), 'utf8')
}

/**
 * Build one account's cosy session, minting a fresh RSA-wrapped key and
 * AES-encrypted identity blob. `tempKey` is the first 16 hex characters of 16
 * random bytes, exactly as the reference derives it.
 * @param identity - the account's cosy identity.
 * @param machineId - derived device id.
 * @param machineToken - derived device token.
 * @param machineType - derived device type.
 * @param region - the region the session addresses.
 * @returns the live session.
 */
export function createQoderSession(
  identity: QoderIdentity,
  machineId: string,
  machineToken: string,
  machineType: string,
  region: 'global' | 'cn',
): QoderSession {
  const tempKey = Buffer.from(randomBytes(16).toString('hex').slice(0, 16), 'utf8')
  const cosyKey = rsaEncrypt(tempKey).toString('base64')
  const info = aesEncrypt(authPayload(identity), tempKey).toString('base64')
  return { identity, tempKey, cosyKey, info, machineId, machineToken, machineType, region }
}

/** The device-fingerprint seed: the account uid, or the credential when unknown. */
export function fingerprintSeed(uid: string, credential: string): string {
  return uid === '' ? `cred:${credential}` : uid
}

/** Stable 32-hex `cosy-machineid`. */
export function deriveMachineId(seed: string): string {
  return md5Hex(`machine:${seed}`)
}

/** Stable 18-character machine type. */
export function deriveMachineType(seed: string): string {
  return md5Hex(`machinetype:${seed}`).slice(0, 18)
}

/** Stable 43-character machine token. */
export function deriveMachineToken(seed: string): string {
  return sha512Base64Url(`machinetoken:${seed}`).slice(0, 43)
}

/**
 * Build the full signed header set for one request.
 * @param session - the account session.
 * @param pathSig - the signature path (see {@link cosyPathSig}).
 * @param body - the encoded request body, or the empty string for a GET.
 * @param accept - the `accept` header value.
 * @param extra - additional headers merged last.
 * @returns the header map.
 */
export function buildCosyHeaders(
  session: QoderSession,
  pathSig: string,
  body: string,
  accept: string,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  const payloadB64 = cosyBuildPayload(session.info)
  const date = `${Math.floor(Date.now() / 1000)}`
  const signature = cosySignRequest(payloadB64, session.cosyKey, date, body, pathSig)
  return {
    'cosy-data-policy': 'agree',
    'content-type': 'application/json',
    'cosy-machinetype': session.machineType,
    'cosy-clienttype': '5',
    'cosy-date': date,
    'cosy-user': session.identity.uid,
    'cosy-key': session.cosyKey,
    'cache-control': 'no-cache',
    accept,
    authorization: cosyComposeBearer(payloadB64, signature),
    'cosy-version': COSY_VERSION,
    'cosy-machineid': session.machineId,
    'cosy-machinetoken': session.machineToken,
    'login-version': 'v2',
    'user-agent': 'Go-http-client/2.0',
    'cosy-scene': 'assistant',
    'cosy-business-product': 'ide',
    'cosy-business-type': 'agent',
    ...extra,
  }
}

/** Read the first string of the given keys off an untrusted record. */
export function firstString(value: unknown, keys: readonly string[]): string {
  const row = asRecord(value)
  for (const key of keys) {
    const found = asString(row[key])
    if (found !== undefined && found !== '') return found
  }
  return ''
}
