import { describe, expect, it } from 'vitest'
import {
  assertSurfaceIdentity,
  missingIdentityHeaders,
  surfaceIdentityHeaders,
  type RequestIdentityTable,
  type SurfaceDeclaration,
} from '../src/request-identity.ts'
import { workBuddyIdentity } from '../src/workbuddy-intl.ts'
import { traeIdentity } from '../src/trae/identity.ts'
import { qoderIdentity } from '../src/qoder/identity.ts'
import { clineIdentity, clineClientHeaders, clineTokenHeaders } from '../src/cline-identity.ts'
import { buildTraeSoloHeaders } from '../src/trae/bridge.ts'
import type { TraeAccount } from '../src/trae/types.ts'

/**
 * The one behaviour every provider's identity table has to have: a request that
 * does not carry what its surface declared is refused, and the refusal names what
 * is missing.
 *
 * Why this is one table-driven spec rather than four copies
 * --------------------------------------------------------
 * Four adapters now declare their request surfaces (`src/request-identity.ts`),
 * and the value of the pattern is that it behaves the same way everywhere. A copy
 * of this test per provider would let one of them quietly stop guarding — which is
 * exactly the failure the guard exists to prevent, one level up. So the providers
 * are a list here, and every assertion below runs for each of them.
 *
 * The per-provider specs still cover the other half: that the requests these
 * builders actually produce satisfy their declarations, at the call sites that
 * produce them.
 */

/** One provider's table, and the real builder its surfaces go through, when callable. */
interface ProviderUnderTest {
  readonly name: string
  readonly table: RequestIdentityTable<string>
  readonly request?: (surface: string) => Record<string, string>
}

const account: TraeAccount = {
  id: '8123',
  realm: 'cn',
  uid: '8123',
  nickname: 'trae-user',
  machineId: 'a'.repeat(32),
  deviceId: 'b'.repeat(32),
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 0,
  createdAt: 0,
  lastChecked: 0,
}

const PROVIDERS: readonly ProviderUnderTest[] = [
  { name: 'WorkBuddy', table: workBuddyIdentity },
  { name: 'TRAE', table: traeIdentity, request: () => buildTraeSoloHeaders(account, true) },
  { name: 'Qoder', table: qoderIdentity },
  {
    name: 'Cline',
    table: clineIdentity,
    request: surface => surface === 'client'
      ? clineClientHeaders('task-1', { authorization: 'Bearer x' })
      : clineTokenHeaders(),
  },
]

/** Every surface of every provider, labelled so a case name reads as a surface. */
const SURFACES = PROVIDERS.flatMap(provider => Object.keys(provider.table.surfaces)
  .map(surface => ({ label: `${provider.name} ${surface}`, provider, surface })))

/**
 * The smallest request that satisfies one surface.
 *
 * The declared values, plus one placeholder per required entry, plus the caller's
 * own choices — which is how the either-or cases below state a spelling.
 * @param provider - the provider whose declaration is being satisfied.
 * @param surface - which surface.
 * @param chosen - names to use instead of the first spelling of each entry.
 * @returns the headers.
 */
function completeRequest(
  provider: ProviderUnderTest,
  surface: string,
  chosen: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const declaration = provider.table.surfaces[surface] as SurfaceDeclaration
  const filled: Record<string, string> = { ...declaration.headers }
  for (const entry of declaration.required) {
    const names: readonly string[] = typeof entry === 'string' ? [entry] : entry
    if (names.some(name => Object.keys(filled).some(present => present.toLowerCase() === name))) continue
    const pick = names.find(name => name in chosen) ?? names[0] ?? ''
    filled[pick] = chosen[pick] ?? 'placeholder'
  }
  return filled
}

describe('every provider refuses a request that is missing a declared header', () => {
  it.each(SURFACES)('$label names what is missing', ({ provider, surface }) => {
    // An empty request: the guard has to throw, and the message has to say which
    // surface it belongs to and what it is missing — the two facts a reader of a
    // failed request needs.
    const message = (() => {
      try {
        assertSurfaceIdentity(provider.table, surface, {})
        return undefined
      } catch (error) {
        return (error as Error).message
      }
    })()
    expect(message, `${provider.name} ${surface} accepted an empty request`).toBeDefined()
    const prefix = `${provider.table.code}_IDENTITY_INCOMPLETE: the ${surface} request is missing `
    expect(message?.startsWith(prefix), message).toBe(true)
    // And it lists at least one entry after the prefix, never just the sentence.
    expect((message ?? '').slice(prefix.length).trim(), message).not.toBe('')
  })

  it.each(SURFACES)('$label accepts a request built from its own declaration', ({ provider, surface }) => {
    const filled = completeRequest(provider, surface)
    expect(missingIdentityHeaders(provider.table, surface, filled)).toEqual([])
    expect(() => assertSurfaceIdentity(provider.table, surface, filled)).not.toThrow()
  })

  it.each(SURFACES)('$label declares its names in the case the wire uses', ({ provider, surface }) => {
    // The guard matches header names case-insensitively because HTTP does; the
    // declarations themselves are lower-case so that a reader comparing them to a
    // packet capture is not left wondering which spelling is the contract.
    const declaration = provider.table.surfaces[surface] as SurfaceDeclaration
    for (const name of Object.keys(declaration.headers)) {
      expect(name, `${provider.name} ${surface}`).toBe(name.toLowerCase())
    }
  })

  it.each(PROVIDERS.filter(provider => provider.request !== undefined))(
    '$name: the request its own builder produces satisfies its declaration',
    (provider) => {
      // The other direction, through the real builder rather than through a map this
      // spec assembled: a declaration the builder cannot satisfy fails here, at the
      // builder, rather than at an upstream that answers with a different problem.
      for (const surface of Object.keys(provider.table.surfaces)) {
        expect(() => provider.request?.(surface)).not.toThrow()
      }
    },
  )

  it('gives each provider its own failure code', () => {
    const codes = PROVIDERS.map(provider => provider.table.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toMatch(/^[A-Z][A-Z0-9]*$/u)
  })

  it('merges the supplied values over the declared ones, additions last', () => {
    const merged = surfaceIdentityHeaders(traeIdentity, 'solo', { 'content-type': 'application/json; charset=utf-8' })
    expect(merged['content-type']).toBe('application/json; charset=utf-8')
    expect(merged['x-app-id']).toBe((traeIdentity.surfaces.solo as SurfaceDeclaration).headers['x-app-id'])
  })

  it('accepts either spelling of an either-or entry, and only one of them', () => {
    // The list form exists for the `X-No-*` answers: an account without a uid
    // declares that it has none rather than omitting the field, and both spellings
    // satisfy the requirement while a request carrying neither does not.
    const workbuddy = PROVIDERS[0] as ProviderUnderTest
    const byNo = completeRequest(workbuddy, 'credits', { 'x-no-user-id': '1' })
    expect(byNo['x-no-user-id']).toBe('1')
    expect(() => assertSurfaceIdentity(workbuddy.table, 'credits', byNo)).not.toThrow()

    const neither = { ...byNo }
    delete neither['x-no-user-id']
    expect(() => assertSurfaceIdentity(workbuddy.table, 'credits', neither))
      .toThrow(/WORKBUDDY_IDENTITY_INCOMPLETE: the credits request is missing x-user-id \| x-no-user-id/)
  })

  it('refuses a request whose builder lost a declared header', () => {
    // The real TRAE builder's own output, with one identity header stripped after
    // the fact: this is the failure a builder that dropped a field would produce,
    // named down to the field it lost.
    const built = buildTraeSoloHeaders(account, true)
    expect(built['x-app-id']).toBeTruthy()
    const { 'x-app-id': _dropped, ...incomplete } = built
    expect(() => assertSurfaceIdentity(traeIdentity, 'solo', incomplete))
      .toThrow(/TRAE_IDENTITY_INCOMPLETE: the solo request is missing x-app-id/)
  })
})
