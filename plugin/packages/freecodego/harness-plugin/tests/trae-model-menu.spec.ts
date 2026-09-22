/**
 * What the model menu shows for one TRAE account: the configurations a user may
 * choose, and the thinking levels the chosen one can act on.
 *
 * The directory that answers this is SOLO's own wiring table, and it carries the
 * client's internal rows next to the models; these cases pin the boundary the
 * picker sees rather than the parser's output, because that is where a wrong
 * filter turns into a menu full of ids nobody can pick.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { TraeAdapter, TraeClient, TRAE_STORE_REF } from '../src/trae-intl.ts'

/** One stored account, healthy, with plenty of life left on its access token. */
const STORE = JSON.stringify({
  activeAccountId: 'cn-1',
  accounts: [{
    id: 'cn-1',
    realm: 'cn',
    uid: 'u-cn',
    nickname: 'cn-user',
    machineId: 'a'.repeat(32),
    deviceId: 'b'.repeat(32),
    accessToken: 'access-cn',
    refreshToken: 'refresh-cn',
    expiresAt: 4_000_000_000,
    createdAt: 1,
    lastChecked: 1,
  }],
})

/** The vault the connector reads that account from. */
const VAULT = {
  resolve: vi.fn(async (ref: unknown) => ref === TRAE_STORE_REF ? { value: STORE, source: 'test' } : undefined),
  describe: vi.fn(async () => ({ configured: true, writable: true })),
  set: vi.fn(async () => undefined),
  unset: vi.fn(async () => undefined),
} as unknown as CredentialProvider

/** Serve one configuration table for every directory read. */
function serveTable(rows: readonly Record<string, unknown>[]): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ config_info_list: rows }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

/** A configuration row as the upstream serves it. */
function configRow(
  id: string,
  displayName: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    config_name: id,
    is_invisible_to_user: false,
    display_config: { display_name: displayName, model_capability: 'reasoning_model' },
    ...overrides,
  }
}

/** The adapter over a fresh pool. */
function adapter(): TraeAdapter {
  return new TraeAdapter(new TraeClient(VAULT, async () => undefined))
}

afterEach(() => { vi.restoreAllMocks() })

describe('Trae model menu', () => {
  it('offers the models and hides the wiring the same table carries', async () => {
    serveTable([
      configRow('glm-5.3', 'GLM-5.3'),
      configRow('browser_use_subagent', 'browser_use_subagent', { is_invisible_to_user: true }),
      configRow('custom_model_gemini', 'Gemini-3.1-Pro-Preview', { custom_models: ['gemini//gemini-3-flash'] }),
      configRow('custom_model_1M', '', { custom_models: ['x//y'] }),
      configRow('custom_model_placeholder', ''),
      // No capability: the table's non-model entries look like this.
      { config_name: 'summary', is_invisible_to_user: false, display_config: { display_name: 'summary' } },
    ])
    const rows = await adapter().listModels('trae')
    expect(rows.map(row => row.id)).toEqual(['glm-5.3'])
    expect(rows[0]).toMatchObject({ name: 'GLM-5.3', availability: 'available' })
  })

  it('resolves the thinking levels the model\'s family was measured on', async () => {
    serveTable([configRow('glm-5.3', 'GLM-5.3'), configRow('kimi-k3', 'Kimi-K3'), configRow('Doubao-Seed-Evolving', 'Seed-Evolving')])
    const menu = adapter()
    const glm = await menu.resolveModel('trae', 'glm-5.3')
    expect(glm.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'high', 'max'])
    expect(glm.reasoning?.efforts.map(effort => effort.name)).toEqual(['Off', 'High', 'Max'])
    // `off` is the level that sends nothing, and it is where an untouched session is.
    expect(glm.reasoning?.defaultEffort).toBe('off')
    expect((await menu.resolveModel('trae', 'kimi-k3')).reasoning?.efforts.map(effort => effort.id))
      .toEqual(['off', 'low', 'high', 'max'])
    // Nothing this connector sends changes how this one thinks, so it gets no menu.
    expect((await menu.resolveModel('trae', 'Doubao-Seed-Evolving')).reasoning).toBeUndefined()
  })

  it('hides the model list behind sign-in', async () => {
    serveTable([configRow('glm-5.3', 'GLM-5.3')])
    const empty = new TraeAdapter(new TraeClient({
      resolve: vi.fn(async () => undefined),
      describe: vi.fn(async () => ({ configured: false, writable: true })),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    } as unknown as CredentialProvider, async () => undefined))
    const rows = await empty.listModels('trae')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ availability: 'unavailable', unavailableReason: 'TRAE_LOGIN_REQUIRED' })
  })
})
