import { describe, expect, it } from 'vitest'
import {
  FreeCodeGoAccountCoordinator,
  FreeCodeGoApiClient,
  FreeCodeGoMobileAuthClient,
  HarnessFreeCodeGoCredentialVault,
  isFreeRouteRow,
  isLockedRoute,
  isZeroPriceRoute,
} from '../src/index.ts'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { FreeCodeGoCredentialVault, FreeCodeGoMobileAuthClient as FreeCodeGoMobileAuthClientType, FreeCodeGoTokenPair } from '../src/index.ts'

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

function catalog() {
  return {
    updated_at: '2026-08-16T00:00:00Z',
    models: [{
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      provider: 'opencode',
      protocol: 'openai_responses',
      enabled: true,
      access: 'free',
      route_key: 'opaque-route',
      billing_mode: 'free',
    }],
  }
}

describe('FreeCodeGoApiClient', () => {
  it('adapts the existing v1 bootstrap envelope into the Harness catalog', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        expect(String(input)).toContain('/api/v1/freecodego/agent/bootstrap')
        return response({ data: { updated_at: '2026-08-19T00:00:00Z', models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', protocol: 'openai_responses', enabled: true, access: 'free', route_key: 'free-route' }] } })
      },
    })
    await expect(client.getCatalog({ accessToken: 'host-only-token' })).resolves.toMatchObject({ models: [{ id: 'deepseek-chat', choices: [{ routeKey: 'free-route', zeroPrice: true }] }] })
  })

  it('asks for order states explicitly instead of paging to them', async () => {
    // The order list is paginated newest-first, so an account whose newest rows are
    // expired attempts hides the order that actually paid — which is how the receipt
    // and invoice surfaces reported "no paid orders" for an account that has them.
    const seen: string[] = []
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        const url = new URL(String(input))
        expect(url.pathname).toBe('/api/v1/freecodego/payment/orders/my')
        seen.push(url.search)
        return response({ data: { items: [], total: 0 } })
      },
    })
    await client.getPaymentOrders({ accessToken: 'host-only-token', status: 'paid' })
    // No status means "the states the caller renders", and the caller-side default
    // stays unfiltered so the pending view keeps working.
    await client.getPaymentOrders({ accessToken: 'host-only-token' })
    expect(seen).toEqual(['?status=paid', ''])
  })

  it('maps the backend profile avatar_url into the Host-safe account shape', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/freecodego/auth/me')
        return response({ data: { id: 1, username: '001', email: '3527566745@qq.com', avatar_url: 'https://q1.qlogo.cn/g?b=qq&nk=3527566745&s=100', role: 'user', balance: 1, status: 'active' } })
      },
    })
    await expect(client.getCurrentUser({ accessToken: 'host-only-token' })).resolves.toMatchObject({ email: '3527566745@qq.com', avatarUrl: 'https://q1.qlogo.cn/g?b=qq&nk=3527566745&s=100' })
  })

  it('projects authenticated channel availability and latency without admin credentials', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/freecodego/agent/channel-health')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer host-only-token')
        return response({ data: { items: [{
          provider: 'openai', status: 'degraded', latency_ms: 8047, availability_7d: 99.96,
        }] } })
      },
    })

    await expect(client.getGatewayProviderHealth({ accessToken: 'host-only-token' })).resolves.toEqual([{
      provider: 'openai', status: 'degraded', latencyMs: 8047, availability7d: 99.96,
    }])
  })

  it('projects public gateway tariffs with group multipliers and per-request overrides', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/public/model-pricing/landing')
        return response({ data: {
          groups: [
            // Latin fixture names on purpose: the projection sorts rows by
            // (modelId, groupName), so a CJK name would make the expected order
            // depend on the runtime's collation. CJK group names are covered by
            // the `/models/options` cases, where nothing is sorted by name.
            { id: 1, name: 'group-a', platform: 'openai', rate_multiplier: '0.5', allowed_models: ['gpt-*'] },
            { id: 2, name: 'group-b', platform: 'openai', rate_multiplier: 1, allowed_models: ['gpt-image-*'] },
          ],
          catalog: [
            { model: 'gpt-5.6', provider: 'openai', input_price_per_million: 10, output_price_per_million: '30', cache_read_price_per_million: 1, cache_write_price_per_million: 4, enabled: true },
            { model: 'gpt-image-1', provider: 'openai', per_request_price: 0.25, enabled: true },
          ],
          group_billing_rules: { '2': [{ model: 'gpt-image-*', mode: 'per_request', per_request_price: 0.08, enabled: true }] },
        } })
      },
    })
    await expect(client.getPublicModelPricing('zh')).resolves.toEqual([
      { modelId: 'gpt-5.6', displayName: 'gpt-5.6', provider: 'openai', source: 'gateway', groupName: 'group-a', platform: 'openai', rateMultiplier: 0.5, billingMode: 'token', currency: 'USD', originalInputPricePerMillion: 10, originalOutputPricePerMillion: 30, originalCacheReadPricePerMillion: 1, originalCacheWritePricePerMillion: 4, inputPricePerMillion: 5, outputPricePerMillion: 15, cacheReadPricePerMillion: 0.5, cacheWritePricePerMillion: 2 },
      { modelId: 'gpt-image-1', displayName: 'gpt-image-1', provider: 'openai', source: 'gateway', groupName: 'group-a', platform: 'openai', rateMultiplier: 0.5, billingMode: 'token', currency: 'USD', originalPerRequestPrice: 0.25, perRequestPrice: 0.125 },
      { modelId: 'gpt-image-1', displayName: 'gpt-image-1', provider: 'openai', source: 'gateway', groupName: 'group-b', platform: 'openai', rateMultiplier: 1, billingMode: 'per-request', currency: 'USD', originalPerRequestPrice: 0.25, perRequestPrice: 0.08 },
    ])
  })

  it('keeps account-whitelisted models and their effective prices from model options', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/freecodego/models/options')
        return response({ data: { models: [{
          id: 'account-only-model', label: '账号白名单模型', provider: 'anthropic', protocol: 'anthropic', description: 'Only enabled for this account',
          options: [{
            group_id: 11, group_name: 'Claude 专线', route_key: 'model:anthropic:account-only-model', protocol: 'anthropic', enabled: true, rate_multiplier: 0.2,
            official_pricing: { billing_mode: 'token', currency: 'USD', input_price_per_million: 15, output_price_per_million: 75, cache_read_price_per_million: 1.5, cache_write_price_per_million: 18 },
            activity_pricing: { billing_mode: 'token', currency: 'USD', input_price_per_million: 3, output_price_per_million: 15, cache_read_price_per_million: 0.3, cache_write_price_per_million: 3.6 },
          }],
        }] } })
      },
    })
    await expect(client.getModelOptions({ accessToken: 'host-only-token' })).resolves.toEqual([{
      model: 'account-only-model', displayName: '账号白名单模型', provider: 'anthropic', protocol: 'anthropic', description: 'Only enabled for this account',
      // `zeroPrice` is part of the public contract, so it is always present —
      // never omitted just because it is false.
      options: [{ groupId: 11, routeKey: 'model:anthropic:account-only-model', groupName: 'Claude 专线', protocol: 'anthropic', enabled: true, zeroPrice: false, locked: false, rateMultiplier: 0.2, currency: 'USD', originalInputPricePerMillion: 15, originalOutputPricePerMillion: 75, originalCacheReadPricePerMillion: 1.5, originalCacheWritePricePerMillion: 18, inputPricePerMillion: 3, outputPricePerMillion: 15, cacheReadPricePerMillion: 0.3, cacheWritePricePerMillion: 3.6 }],
    }])
  })

  it('reads the account groups and the models from a single /models/options call', async () => {
    let calls = 0
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        calls += 1
        expect(new URL(String(input)).pathname).toBe('/api/v1/freecodego/models/options')
        return response({ data: {
          groups: [
            { id: 21, name: '后端分组·免费', platform: 'openai', protocol: 'openai_responses', enabled: true, model_count: 2, rate_multiplier: 0, activity_discount_percent: 100, activity_label: '限时免费', sort_order: 1 },
            // A locked group stays in the list so the caller can explain it, but
            // it must never report itself as usable.
            { id: 23, name: '后端分组·受限', enabled: true, access: 'locked', unlock_required: true, unlock_reason: 'invite_registration_required', rate_multiplier: 1, sort_order: 2 },
            // A group with no id or no name cannot head anything, so it is dropped.
            { name: '未命名', rate_multiplier: 1 },
            { id: 24 },
          ],
          models: [{
            id: 'glm-5.3', label: 'GLM 5.3', provider: 'openai', protocol: 'openai_responses',
            options: [{ group_id: 21, group_name: '后端分组·免费', route_key: 'group:21:glm-5.3', protocol: 'openai_responses', enabled: true, rate_multiplier: 0, official_pricing: {}, activity_pricing: {} }],
          }],
        } })
      },
    })

    const snapshot = await client.getModelOptionsSnapshot({ accessToken: 'host-only-token' })
    expect(snapshot.groups).toEqual([
      { id: 21, name: '后端分组·免费', platform: 'openai', protocol: 'openai_responses', enabled: true, modelCount: 2, rateMultiplier: 0, activityDiscountPercent: 100, activityLabel: '限时免费', sortOrder: 1 },
      { id: 23, name: '后端分组·受限', enabled: false, access: 'locked', unlockRequired: true, unlockReason: 'invite_registration_required', rateMultiplier: 1, sortOrder: 2 },
    ])
    expect(snapshot.models.map(entry => entry.model)).toEqual(['glm-5.3'])
    // `getModelOptions` is the same read now, so the group list costs no second
    // request against an endpoint the backend derives per account.
    expect(calls).toBe(1)
  })

  it('carries image billing through the group tiers and the choice mode', async () => {
    // The backend publishes three modes. `image` used to be read as `token`,
    // which is how gpt-image-2 reached the price table as four token columns the
    // backend never charges it by.
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/freecodego/models/options')
        return response({ data: {
          groups: [{
            id: 2, name: 'OpenAi', enabled: true, rate_multiplier: 0.5, sort_order: 1,
            allow_image_generation: true, image_rate_independent: true, image_rate_multiplier: 2,
            image_price_1k: 0.03, image_price_2k: 0.06, image_price_4k: 0,
          }],
          models: [{
            id: 'gpt-image-2', label: 'gpt-image-2', provider: 'openai',
            options: [{
              group_id: 2, group_name: 'OpenAi', route_key: 'group:2:gpt-image-2', enabled: true, rate_multiplier: 0.5,
              official_pricing: { billing_mode: 'image', currency: 'USD', image_output_price_per_million: 54000 },
              activity_pricing: { billing_mode: 'image', currency: 'USD', image_output_price_per_million: 27000 },
            }],
          }],
        } })
      },
    })

    const snapshot = await client.getModelOptionsSnapshot({ accessToken: 'host-only-token' })
    // `image_price_4k: 0` survives as the free tier it is; a negative or absent
    // field is the one that means "not configured".
    expect(snapshot.groups).toEqual([{
      id: 2, name: 'OpenAi', enabled: true, rateMultiplier: 0.5, sortOrder: 1,
      allowImageGeneration: true, imageRateIndependent: true, imageRateMultiplier: 2,
      imagePrice1K: 0.03, imagePrice2K: 0.06, imagePrice4K: 0,
    }])
    expect(snapshot.models[0]?.options[0]).toEqual(expect.objectContaining({
      billingMode: 'image',
      originalImageOutputPricePerMillion: 54000,
      imageOutputPricePerMillion: 27000,
    }))
  })

  it('reads the image billing mode and its image-output price from the public lookup', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/public/model-pricing/lookup')
        return response({ data: { items: [
          { model: 'gpt-image-2', found: true, billing_mode: 'image', currency: 'USD', image_output_price_per_million: 54000 },
          { model: 'gpt-5.6', found: true, billing_mode: 'token', currency: 'USD', input_price_per_million: 5 },
        ] } })
      },
    })
    await expect(client.getPublicModelPricingLookup(['gpt-image-2', 'gpt-5.6'])).resolves.toEqual([
      { model: 'gpt-image-2', found: true, billingMode: 'image', currency: 'USD', imageOutputPricePerMillion: 54000 },
      { model: 'gpt-5.6', found: true, billingMode: 'token', currency: 'USD', inputPricePerMillion: 5 },
    ])
  })

  it('reads a payload with no groups at all as an empty group list', async () => {
    // A deployment that predates `groups[]` must still resolve models; the
    // group list is additive, never a reason to fail the catalog refresh.
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => response({ data: { models: [{
        id: 'gpt-5.6',
        options: [{ group_id: 1, route_key: 'group:1:gpt-5.6', enabled: true, rate_multiplier: 1, official_pricing: {}, activity_pricing: {} }],
      }] } }),
    })
    const snapshot = await client.getModelOptionsSnapshot({ accessToken: 'host-only-token' })
    expect(snapshot.groups).toEqual([])
    expect(snapshot.models.map(entry => entry.model)).toEqual(['gpt-5.6'])
  })

  it('marks a route free from its zero rate multiplier, not from an access string', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/freecodego/models/options')
        return response({ data: { models: [{
          id: 'glm-5.3', label: 'GLM 5.3', provider: 'openai', protocol: 'openai_responses',
          options: [
            // This is what the backend actually sends for a free group: access is
            // `available`, and the multiplier is the only free signal.
            { group_id: 21, group_name: '后端分组·免费', route_key: 'group:21:glm-5.3', protocol: 'openai_responses', enabled: true, access: 'available', rate_multiplier: 0, activity_discount_percent: 100, official_pricing: {}, activity_pricing: {} },
            { group_id: 22, group_name: '付费池', route_key: 'group:22:glm-5.3', protocol: 'openai_responses', enabled: true, access: 'available', rate_multiplier: 0.4, official_pricing: {}, activity_pricing: {} },
            // A locked group is still reported: the caller decides, not this client.
            { group_id: 23, group_name: '后端分组·受限', route_key: 'group:23:glm-5.3', protocol: 'openai_responses', enabled: true, access: 'locked', unlock_required: true, unlock_reason: 'invite_registration_required', rate_multiplier: 1, official_pricing: {}, activity_pricing: {} },
            // Legacy spelling from an older deployment must still resolve.
            { group_id: 24, group_name: '旧版免费', route_key: 'group:24:glm-5.3', protocol: 'openai_responses', enabled: true, access: 'free', official_pricing: {}, activity_pricing: {} },
          ],
        }] } })
      },
    })

    const [model] = await client.getModelOptions({ accessToken: 'host-only-token' })
    // `locked` is part of the public contract and is always present, exactly
    // like `zeroPrice`: the backend's `access: 'locked'` and its
    // `unlock_required` are one lock signal, not two.
    expect(model!.options.map(option => ({ routeKey: option.routeKey, zeroPrice: option.zeroPrice, rateMultiplier: option.rateMultiplier, locked: option.locked }))).toEqual([
      { routeKey: 'group:21:glm-5.3', zeroPrice: true, rateMultiplier: 0, locked: false },
      { routeKey: 'group:22:glm-5.3', zeroPrice: false, rateMultiplier: 0.4, locked: false },
      { routeKey: 'group:23:glm-5.3', zeroPrice: false, rateMultiplier: 1, locked: true },
      { routeKey: 'group:24:glm-5.3', zeroPrice: true, rateMultiplier: 0, locked: false },
    ])
    expect(model!.options[2]).toMatchObject({ unlockRequired: true, unlockReason: 'invite_registration_required', access: 'locked' })
  })

  it('derives a locked route from either backend lock spelling', () => {
    expect(isLockedRoute({ access: 'locked' })).toBe(true)
    expect(isLockedRoute({ unlockRequired: true })).toBe(true)
    expect(isLockedRoute({ access: 'locked', unlockRequired: true })).toBe(true)
    expect(isLockedRoute({ access: 'AVAILABLE' })).toBe(false)
    expect(isLockedRoute({})).toBe(false)
  })

  it('keeps one free-route rule for raw rows and normalized routes', () => {
    expect(isFreeRouteRow({ rate_multiplier: 0 })).toBe(true)
    expect(isFreeRouteRow({ rate_multiplier: '0' })).toBe(true)
    expect(isFreeRouteRow({ access: 'free' })).toBe(true)
    expect(isFreeRouteRow({}, { billing_mode: 'free' })).toBe(true)
    expect(isFreeRouteRow({ rate_multiplier: 1 }, { billing_mode: 'token' })).toBe(false)
    expect(isFreeRouteRow({ access: 'available', rate_multiplier: 0.4 })).toBe(false)
    expect(isZeroPriceRoute({ zeroPrice: true, rateMultiplier: 3 })).toBe(true)
    expect(isZeroPriceRoute({ rateMultiplier: 0 })).toBe(true)
    expect(isZeroPriceRoute({ zeroPrice: false, rateMultiplier: 0.5 })).toBe(false)
    expect(isZeroPriceRoute({})).toBe(false)
  })

  it('carries the bootstrap projection’s lock fields into the catalog choice', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => response({ data: {
        updated_at: '2026-08-19T00:00:00Z',
        models: [{
          id: 'claude-x', label: 'Claude X', provider: 'anthropic', protocol: 'anthropic', enabled: false,
          route_key: 'model:anthropic:claude-x', group_id: 23, group_name: '后端分组·受限',
          access: 'locked', unlock_required: true, unlock_reason: 'invite_registration_required', unlock_expires_at: '2026-10-01T00:00:00Z',
        }],
      } }),
    })
    const catalog = await client.getCatalog({ accessToken: 'host-only-token' })
    expect(catalog.models[0]?.choices[0]).toMatchObject({
      routeKey: 'model:anthropic:claude-x',
      groupId: 23,
      groupName: '后端分组·受限',
      locked: true,
      unlockRequired: true,
      unlockReason: 'invite_registration_required',
      unlockExpiresAt: '2026-10-01T00:00:00Z',
      zeroPrice: false,
    })
  })

  it('lists and revokes device sessions through the account routes', async () => {
    const requests: string[] = []
    const bodies: string[] = []
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input, init) => {
        const url = new URL(String(input))
        requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
        if (init?.body !== undefined) bodies.push(String(init.body))
        if (url.pathname.endsWith('/revoke')) return response({ data: { message: 'Device session revoked.' } })
        if (url.pathname.endsWith('/revoke-all-sessions')) return response({ data: { message: 'All sessions have been revoked.', revoked_count: 2 } })
        return response({ data: {
          current_device_id: 'device-2',
          sessions: [
            { device_id: 'device-1', device_name: 'Laptop', os: 'windows', arch: 'amd64', client_version: '0.1.3', local_gateway_id: 'gw-1', last_seen_at: '2026-09-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z', current: false, revoked: false },
            { device_id: 'device-2', last_seen_at: '2026-09-12T00:00:00Z', created_at: '2026-09-01T00:00:00Z', current: true, revoked: true, revoked_at: '2026-09-12T01:00:00Z' },
          ],
        } })
      },
    })

    await expect(client.getDeviceSessions({ accessToken: 'host-only-token', deviceId: 'device-2' })).resolves.toEqual({
      currentDeviceId: 'device-2',
      sessions: [
        { deviceId: 'device-1', deviceName: 'Laptop', os: 'windows', arch: 'amd64', clientVersion: '0.1.3', localGatewayId: 'gw-1', lastSeenAt: '2026-09-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z', current: false, revoked: false },
        { deviceId: 'device-2', lastSeenAt: '2026-09-12T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', revokedAt: '2026-09-12T01:00:00Z', current: true, revoked: true },
      ],
    })
    await expect(client.revokeDeviceSession({ accessToken: 'host-only-token', deviceId: 'device-1' })).resolves.toBe('Device session revoked.')
    await expect(client.revokeAllSessions({ accessToken: 'host-only-token' })).resolves.toBe(2)
    expect(requests).toEqual([
      'GET /api/v1/freecodego/auth/device-sessions?device_id=device-2',
      'POST /api/v1/freecodego/auth/device-sessions/revoke',
      'POST /api/v1/freecodego/auth/revoke-all-sessions',
    ])
    expect(bodies).toEqual(['{"device_id":"device-1"}'])
  })

  it('rejects a device-session revoke without a device id before reaching the network', async () => {
    let calls = 0
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => { calls += 1; return response({ data: {} }) },
    })
    await expect(client.revokeDeviceSession({ accessToken: 'host-only-token', deviceId: '  ' })).rejects.toThrow('device id is required')
    expect(calls).toBe(0)
  })

  it('orders through the client-scoped payment route and never reads the compat channel projection', async () => {
    const requests: string[] = []
    let checkoutBody: Record<string, unknown> | undefined
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname
        requests.push(path)
        checkoutBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return response({ data: { order_id: 42, amount: 12.5, pay_amount: 12.8, currency: 'CNY', status: 'pending', payment_type: 'alipay', out_trade_no: 'out-42', pay_url: 'https://pay.example/order/42', qr_code: 'data:image/png;base64,qr', client_secret: 'seti_secret' } })
      },
    })

    await expect(client.createCheckout({ accessToken: 'host-only-token', planId: 3, paymentType: 'alipay', returnUrl: 'https://harness.example/settings' })).resolves.toEqual({ orderId: '42', amount: 12.5, currency: 'CNY', state: 'pending', checkoutUrl: 'https://pay.example/order/42', qrCode: 'data:image/png;base64,qr', clientSecret: 'seti_secret', outTradeNo: 'out-42', payAmount: 12.8, paymentType: 'alipay' })
    // Payment channels come from `checkout-info` only; the narrower compat
    // `/payment/channels` projection is not part of this client's surface.
    expect(requests).toEqual(['/api/v1/freecodego/payment/orders'])
    expect(checkoutBody).toMatchObject({ payment_source: 'hosted_redirect', is_mobile: false, order_type: 'subscription', plan_id: 3 })
  })

  it('keeps an order that carries no currency, without inventing one', async () => {
    // Alipay and WeChat echo no settlement currency, so their created orders have
    // no `currency` at all. Rejecting the response over the missing label threw
    // away an order the backend had already created: the panel never got the id,
    // so the user saw a dead button and was left with an uncancellable pending
    // order. The order must parse — with the currency *absent*, not defaulted to
    // a `USD` the provider never charged.
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => response({ data: { order_id: 43, amount: 5, pay_amount: 35.72, status: 'pending', payment_type: 'alipay', pay_url: 'https://pay.example/order/43' } }),
    })
    const order = await client.createCheckout({ accessToken: 'host-only-token', planId: 0, amount: 5, paymentType: 'alipay', returnUrl: 'https://freecodego.com/rootadmin/payment/result' })
    expect(order).toStrictEqual({ orderId: '43', amount: 5, state: 'pending', paymentType: 'alipay', payAmount: 35.72, checkoutUrl: 'https://pay.example/order/43' })
    expect(order.currency).toBeUndefined()
    // A blank string is the same absence, not a currency named "".
    const blank = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => response({ data: { order_id: 44, amount: 5, currency: '   ', status: 'pending' } }),
    })
    await expect(blank.createCheckout({ accessToken: 'host-only-token', planId: 0, amount: 5, paymentType: 'alipay', returnUrl: 'https://freecodego.com/rootadmin/payment/result' })).resolves.toMatchObject({ orderId: '44' })
  })

  it('does not fall back to the shared checkout route', async () => {
    const requests: string[] = []
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        const path = new URL(String(input)).pathname
        requests.push(path)
        if (path === '/api/v1/freecodego/payment/orders') return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
        return response({ data: { order_id: 44, amount: 5, pay_amount: 5, status: 'pending', qr_code: 'weixin://qr' } })
      },
    })
    await expect(client.createCheckout({ accessToken: 'host-only-token', planId: 0, paymentType: 'wxpay', returnUrl: 'https://freecodego.com/rootadmin/payment/result', amount: 5 })).rejects.toThrow('HTTP 404')
    expect(requests).toEqual(['/api/v1/freecodego/payment/orders'])
  })

  it('keeps the whole order lifecycle on one client-scoped surface', async () => {
    // Creation, verification, reading, cancellation and receipts are one
    // sequence against one backend surface. Splitting creation onto the shared
    // `/payment/orders` route put that call behind the backend-mode user guard
    // (which a request without the desktop installation secret cannot pass) while
    // the rest of the lifecycle stayed open — so an order could be readable but
    // not creatable in the same deployment.
    const requests: string[] = []
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input, init) => {
        requests.push(`${init?.method ?? 'GET'} ${new URL(input instanceof Request ? input.url : String(input)).pathname}`)
        return response({ data: { order_id: 45, amount: 5, status: 'pending', out_trade_no: 'out-45' } })
      },
    })
    const request = { accessToken: 'host-only-token' }
    await client.createCheckout({ ...request, planId: 0, paymentType: 'wxpay', returnUrl: 'https://freecodego.com/result', amount: 5 })
    await client.getCheckoutOrder({ ...request, orderId: '45' })
    await client.verifyCheckoutOrder({ ...request, outTradeNo: 'out-45' })
    await client.cancelCheckoutOrder({ ...request, orderId: '45' })
    expect(requests).toEqual([
      'POST /api/v1/freecodego/payment/orders',
      'GET /api/v1/freecodego/payment/orders/45',
      'POST /api/v1/freecodego/payment/orders/verify',
      'POST /api/v1/freecodego/payment/orders/45/cancel',
    ])
  })

  it('carries the backend’s two receipt flags, and leaves them unset when it sends none', async () => {
    // Which documents exist is the backend's answer, so the projection has to keep
    // the flags: dropping one turns into "no Stripe receipt" for every order. The
    // other direction matters as much — the create-order response carries no flags
    // for an order nobody has paid, and a defaulted `false` there would be this
    // client making a claim about a document instead of reading one.
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname
        return response({ data: path.endsWith('/verify')
          ? { order_id: 45, amount: 5, status: 'PAID', out_trade_no: 'out-45', receipt_available: true, stripe_receipt_available: true }
          : { order_id: 45, amount: 5, status: 'paid' } })
      },
    })
    const request = { accessToken: 'host-only-token' }
    const read = await client.getCheckoutOrder({ ...request, orderId: '45' })
    expect('receiptAvailable' in read).toBe(false)
    expect('stripeReceiptAvailable' in read).toBe(false)
    const verified = await client.verifyCheckoutOrder({ ...request, outTradeNo: 'out-45' })
    expect(verified.receiptAvailable).toBe(true)
    expect(verified.stripeReceiptAvailable).toBe(true)
  })

  it('reads the shared checkout-info projection used by the FreeCodeGo web payment page', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/payment/checkout-info')
        return response({ data: {
          plans: [{ id: 7, name: 'Starter', description: '30 days', price: 10, currency: 'USD', validity_days: 30, for_sale: true }],
          methods: { wxpay: { currency: 'CNY', balance_recharge_multiplier: 0.14, fee_rate: 0, fixed_fee: 0, single_min: 1, single_max: 100, available: true } },
        } })
      },
    })
    await expect(client.getPaymentCheckoutInfo({ accessToken: 'host-only-token' })).resolves.toEqual({
      plans: [{ id: 7, name: 'Starter', description: '30 days', price: 10, currency: 'USD', validityDays: 30, forSale: true }],
      channels: [{ paymentType: 'wxpay', currency: 'CNY', balanceRechargeMultiplier: 0.14, feeRate: 0, fixedFee: 0, singleMin: 1, singleMax: 100 }],
    })
  })

  it('defaults legacy balance-credit plans without currency to USD', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => response({ data: {
        plans: [{ id: 1, name: 'Five dollars', price: 5 }],
        methods: { stripe: { currency: 'USD', balance_recharge_multiplier: 1, available: true } },
      } }),
    })
    await expect(client.getPaymentCheckoutInfo({ accessToken: 'host-only-token' })).resolves.toMatchObject({ plans: [{ id: 1, currency: 'USD' }] })
  })

  it('uses the existing receipt-email route without exposing a receipt or credential', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/freecodego/payment/orders/42/receipt/email')
        expect(init?.method).toBe('POST')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer host-only-token')
        return response({ data: { email: 'account@example.test', message: 'Receipt email was accepted for delivery.' } })
      },
    })
    await expect(client.emailCheckoutReceipt({ accessToken: 'host-only-token', orderId: '42' })).resolves.toEqual({ email: 'account@example.test', message: 'Receipt email was accepted for delivery.' })
  })

  it("saves Stripe's own receipt as the bytes Stripe issued", async () => {
    // The last byte is deliberately not valid UTF-8: Stripe's receipt is a PDF,
    // and a body read as text would arrive with that byte replaced. Round-tripping
    // it is what proves the document travels as bytes rather than as a string.
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff])
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/freecodego/payment/orders/42/stripe-receipt')
        expect(init?.method ?? 'GET').toBe('GET')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer host-only-token')
        return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="stripe-receipt-pi_3UF.pdf"' } })
      },
    })

    const document = await client.downloadCheckoutStripeReceipt({ accessToken: 'host-only-token', orderId: '42' })
    expect(document.fileName).toBe('stripe-receipt-pi_3UF.pdf')
    expect(document.contentType).toBe('application/pdf')
    expect(document.encoding).toBe('base64')
    expect(Uint8Array.from(Buffer.from(document.content, 'base64'))).toEqual(pdf)
  })

  it('reports a Stripe receipt the backend refuses without inventing a file', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => new Response(JSON.stringify({ message: 'receipt is available after payment is completed' }), { status: 409, headers: { 'content-type': 'application/json' } }),
    })
    await expect(client.downloadCheckoutStripeReceipt({ accessToken: 'host-only-token', orderId: '42' })).rejects.toThrow('receipt is available after payment is completed')
  })

  it('cancels an existing payment order through the payment route', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe('/api/v1/freecodego/payment/orders/42/cancel')
        expect(init?.method).toBe('POST')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer host-only-token')
        return response({ data: { message: 'Order cancelled.' } })
      },
    })
    await expect(client.cancelCheckoutOrder({ accessToken: 'host-only-token', orderId: '42' })).resolves.toBeUndefined()
  })

  it('projects a redacted catalog without retaining the request token', async () => {
    let authorization = ''
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        return response(catalog())
      },
    })

    const result = await client.getCatalog({ accessToken: 'host-only-token' })

    expect(authorization).toBe('Bearer host-only-token')
    expect(result.models[0]?.choices[0]).toMatchObject({ routeKey: 'opaque-route', zeroPrice: true })
    expect(JSON.stringify(result)).not.toContain('host-only-token')
  })

  it('rejects a catalog that contains a secret-bearing field', async () => {
    const client = new FreeCodeGoApiClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => response({ ...catalog(), auth_token: 'leaked' }),
    })

    await expect(client.getCatalog({ accessToken: 'host-only-token' })).rejects.toThrow('forbidden field')
  })

  it('requires HTTPS outside explicitly enabled localhost development', () => {
    expect(() => new FreeCodeGoApiClient({ baseUrl: 'http://freecodego.example' })).toThrow('must use HTTPS')
    expect(() => new FreeCodeGoApiClient({ baseUrl: 'http://127.0.0.1:8787', allowInsecureLocalhost: true })).not.toThrow()
  })
})

describe('FreeCodeGoMobileAuthClient', () => {
  it('fails loudly when authentication returns a non-JSON response', async () => {
    const client = new FreeCodeGoMobileAuthClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => new Response('<html>gateway failure</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    })
    await expect(client.login({ email: 'account@example.com', password: 'password' })).rejects.toThrow('authentication response was not valid JSON (HTTP 502)')
  })

  it('projects a pending MFA login without returning credentials', async () => {
    const client = new FreeCodeGoMobileAuthClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => response({ data: { requires_2fa: true, temp_token: 'temporary', user_email_masked: 'a***@example.com' } }),
    })

    await expect(client.login({ email: 'account@example.com', password: 'password' })).resolves.toEqual({
      kind: 'mfa-required',
      tempToken: 'temporary',
      emailMasked: 'a***@example.com',
    })
  })

  it('returns a rotated token pair only to the host caller', async () => {
    let requestBody = ''
    const client = new FreeCodeGoMobileAuthClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (_input, init) => {
        requestBody = String(init?.body)
        return response({ data: { access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600, token_type: 'Bearer' } })
      },
    })

    await expect(client.refresh('old-refresh', 'device-1')).resolves.toEqual({
      accessToken: 'next-access',
      refreshToken: 'next-refresh',
      expiresIn: 3600,
      tokenType: 'Bearer',
    })
    expect(requestBody).toContain('old-refresh')
  })

  it('preserves an avatar URL from the authenticated login profile', async () => {
    const client = new FreeCodeGoMobileAuthClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => response({ data: {
        access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer',
        user: { id: 1, username: '001', email: '3527566745@qq.com', avatar_url: 'https://q1.qlogo.cn/g?b=qq&nk=3527566745&s=100', role: 'user', balance: 0, status: 'active' },
      } }),
    })
    await expect(client.login({ email: '3527566745@qq.com', password: 'password' })).resolves.toMatchObject({
      kind: 'authenticated', user: { email: '3527566745@qq.com', avatarUrl: 'https://q1.qlogo.cn/g?b=qq&nk=3527566745&s=100' },
    })
  })

  it('accepts an account the gateway created without a username', async () => {
    // The registration channel's own signup writes an address and a password and
    // nothing else, while its response type spells `username` as always present.
    // Reading the field as required therefore refused a registration that had
    // already succeeded: the account existed, the card showed a raw English error
    // instead of signing in, and every later attempt on that address was answered
    // with `EMAIL_EXISTS`. The identity this card renders is the address anyway,
    // so both an empty and an absent username fall back to it.
    const login = async (user: Record<string, unknown>): Promise<unknown> => {
      const client = new FreeCodeGoMobileAuthClient({
        baseUrl: 'https://freecodego.example',
        fetch: async () => response({ data: {
          access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer',
          user: { id: 7, role: 'user', balance: 0, status: 'active', email: '3527566745@qq.com', ...user },
        } }),
      })
      return await client.login({ email: '3527566745@qq.com', password: 'password' })
    }

    await expect(login({ username: '' })).resolves.toMatchObject({
      kind: 'authenticated', user: { username: '3527566745', email: '3527566745@qq.com' },
    })
    await expect(login({})).resolves.toMatchObject({
      kind: 'authenticated', user: { username: '3527566745', email: '3527566745@qq.com' },
    })
    // The counterfactual, so the tolerance is scoped to the one field the gateway
    // may omit: a payload missing something the identity genuinely needs is still
    // refused, rather than quietly becoming an account with a blank address.
    const client = new FreeCodeGoMobileAuthClient({
      baseUrl: 'https://freecodego.example',
      fetch: async () => response({ data: {
        access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer',
        user: { id: 7, username: '3527566745', email: '', role: 'user', balance: 0, status: 'active' },
      } }),
    })
    await expect(client.login({ email: '3527566745@qq.com', password: 'password' })).rejects.toThrow('user.email')
  })

  it('requests the reset code in the form a desktop flow can use', async () => {
    // Without `method: 'code'` the gateway mails a browser link built from its own
    // frontend URL, which a webview has nowhere to land. This pins the one field
    // that decides which of the two messages the user receives.
    const seen: { url: string; body: unknown }[] = []
    const client = new FreeCodeGoMobileAuthClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input, init) => {
        seen.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return response({ data: { message: 'If your email is registered, you will receive a password reset code shortly.' } })
      },
    })

    await expect(client.requestPasswordResetCode('3527566745@qq.com')).resolves.toBeUndefined()
    expect(seen).toEqual([{
      url: 'https://freecodego.example/api/v1/freecodego/mobile/auth/forgot-password',
      body: { email: '3527566745@qq.com', method: 'code' },
    }])
  })

  it('resets a password with the mailed code and issues no session', async () => {
    const seen: { url: string; body: unknown }[] = []
    const client = new FreeCodeGoMobileAuthClient({
      baseUrl: 'https://freecodego.example',
      fetch: async (input, init) => {
        seen.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return response({ data: { message: 'Your password has been reset successfully.' } })
      },
    })

    await expect(client.resetPassword({ email: '3527566745@qq.com', verifyCode: '123456', newPassword: 'new-secret' })).resolves.toBeUndefined()
    expect(seen).toEqual([{
      url: 'https://freecodego.example/api/v1/freecodego/mobile/auth/reset-password',
      body: { email: '3527566745@qq.com', verify_code: '123456', new_password: 'new-secret' },
    }])
  })

  it('gives a rotation its own, wider bound than every other auth call', async () => {
    // The failure this pins: a rotation governed by the same short bound as the
    // small login/register calls is aborted by the *client* while the gateway is
    // still working, and the abort is indistinguishable from a transport failure
    // at the coordinator above — which retries it with a refresh token the server
    // may already have consumed. So the bound is per-route, and this test is the
    // only way to observe it without waiting eight real seconds.
    const slowFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal
      await new Promise<void>((resolve, reject) => {
        // A faithful stand-in for `fetch`: the timer loses the race to the abort.
        const timer = setTimeout(resolve, 30)
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
      return response({ data: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, countdown: 60 } })
    }
    const client = new FreeCodeGoMobileAuthClient({
      baseUrl: 'https://freecodego.example',
      fetch: slowFetch as typeof globalThis.fetch,
      requestTimeoutMs: 5,
      refreshTimeoutMs: 200,
    })

    await expect(client.refresh('stored-refresh')).resolves.toMatchObject({ refreshToken: 'refresh' })
    // The counterfactual, on the same client: the generic bound is still in force
    // for everything else, so this latency is a failure where a rotation is not.
    await expect(client.sendVerifyCode('user@example.com')).rejects.toThrow()
  })
})

describe('FreeCodeGo account coordination', () => {
  it('stores an origin-scoped token pair as one credential value', async () => {
    const values = new Map<string, string>()
    const provider = {
      resolve: async (ref: string) => values.has(ref) ? { value: values.get(ref)!, source: 'file' } : undefined,
      set: async (ref: string, value: string) => { values.set(ref, value) },
      unset: async (ref: string) => { values.delete(ref) },
    } as unknown as CredentialProvider
    const vault = new HarnessFreeCodeGoCredentialVault(provider, 'https://freecodego.example')

    await vault.save('https://freecodego.example', {
      accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer',
    })

    expect(values.size).toBe(1)
    expect([...values.keys()][0]).toMatch(/^FREECODEGO_SESSION_[A-F0-9]+$/)
    await expect(vault.load('https://freecodego.example')).resolves.toMatchObject({ refreshToken: 'refresh' })
    await vault.delete('https://freecodego.example')
    await expect(vault.load('https://freecodego.example')).resolves.toBeUndefined()
  })

  it('fails loudly when the persisted session credential is corrupt', async () => {
    const provider = {
      resolve: async () => ({ value: '{"accessToken":"only-access"}', source: 'file' }),
    } as unknown as CredentialProvider
    const vault = new HarnessFreeCodeGoCredentialVault(provider, 'https://freecodego.example')
    await expect(vault.load('https://freecodego.example')).rejects.toThrow('Stored FreeCodeGo session is incomplete')
  })

  it('stores a remembered password beside the session, not inside it', async () => {
    const values = new Map<string, string>()
    const provider = {
      resolve: async (ref: string) => values.has(ref) ? { value: values.get(ref)!, source: 'file' } : undefined,
      set: async (ref: string, value: string) => { values.set(ref, value) },
      unset: async (ref: string) => { values.delete(ref) },
    } as unknown as CredentialProvider
    const vault = new HarnessFreeCodeGoCredentialVault(provider, 'https://freecodego.example')
    const origin = 'https://freecodego.example'

    await vault.save(origin, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600, tokenType: 'Bearer' })
    await vault.savePassword(origin, 'hunter2')
    const refs = [...values.keys()].sort()
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatch(/^FREECODEGO_PASSWORD_[A-F0-9]+$/)
    expect(refs[1]).toMatch(/^FREECODEGO_SESSION_[A-F0-9]+$/)
    await expect(vault.loadPassword(origin)).resolves.toBe('hunter2')
    // The session is rotated and erased by paths the password must not follow:
    // nothing may lose a password the user asked to keep just because a token
    // expired, and a password must not stand in for a session.
    await vault.delete(origin)
    await expect(vault.loadPassword(origin)).resolves.toBe('hunter2')
    await expect(vault.load(origin)).resolves.toBeUndefined()
    await vault.deletePassword(origin)
    await expect(vault.loadPassword(origin)).resolves.toBeUndefined()
  })

  it('reads an empty remembered password as none at all', async () => {
    const provider = { resolve: async () => ({ value: '', source: 'file' }) } as unknown as CredentialProvider
    const vault = new HarnessFreeCodeGoCredentialVault(provider, 'https://freecodego.example')
    await expect(vault.loadPassword('https://freecodego.example')).resolves.toBeUndefined()
  })

  it('rotates and erases credentials through the account coordinator', async () => {
    let stored: { accessToken: string; refreshToken: string; expiresIn: number; tokenType: 'Bearer' } | undefined
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined },
    }
    const auth = {
      origin: 'https://freecodego.example',
      login: async () => ({
        kind: 'authenticated' as const,
        tokens: { accessToken: 'first', refreshToken: 'first-refresh', expiresIn: 3600, tokenType: 'Bearer' as const },
        user: { id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' },
      }),
      refresh: async () => ({ accessToken: 'second', refreshToken: 'second-refresh', expiresIn: 3600, tokenType: 'Bearer' as const }),
      logout: async () => {},
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)

    await coordinator.login({ email: 'user@example.com', password: 'password' })
    expect(coordinator.snapshot()).toMatchObject({ status: 'authenticated', user: { email: 'user@example.com' } })
    await coordinator.refresh()
    expect(stored).toMatchObject({ refreshToken: 'second-refresh' })
    await coordinator.logout()
    expect(stored).toBeUndefined()
    expect(coordinator.snapshot()).toEqual({ status: 'signed-out' })
  })

  it('commits the remembered-password intent only with a pair, and never into the snapshot', async () => {
    let password: string | undefined
    const writes: (string | undefined)[] = []
    const vault: FreeCodeGoCredentialVault = {
      load: async () => undefined,
      save: async () => {},
      delete: async () => {},
      loadPassword: async () => password,
      savePassword: async (_origin, value) => { password = value; writes.push(value) },
      deletePassword: async () => { password = undefined; writes.push(undefined) },
    }
    const auth = {
      origin: 'https://freecodego.example',
      login: async () => ({
        kind: 'authenticated' as const,
        tokens: { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' as const },
        user: { id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' },
      }),
      logout: async () => {},
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)

    await coordinator.login({ email: 'user@example.com', password: 'hunter2', rememberPassword: true })
    await expect(coordinator.rememberedPassword()).resolves.toBe('hunter2')
    // Browser-safe state is what every surface renders and what crosses the
    // remote boundary; a password must not be reachable from it.
    expect(JSON.stringify(coordinator.snapshot())).not.toContain('hunter2')

    // Silence is not an untick: a caller that never mentions a password leaves
    // the entry alone, which is what the registration form relies on.
    await coordinator.login({ email: 'user@example.com', password: 'second' })
    await expect(coordinator.rememberedPassword()).resolves.toBe('hunter2')

    // An explicit untick is how a user forgets it, and it is what the next
    // sign-in carries out.
    await coordinator.login({ email: 'user@example.com', password: 'third', rememberPassword: false })
    await expect(coordinator.rememberedPassword()).resolves.toBeUndefined()

    await coordinator.login({ email: 'user@example.com', password: 'fourth', rememberPassword: true })
    await coordinator.logout()
    await expect(coordinator.rememberedPassword()).resolves.toBeUndefined()
    expect(writes).toEqual(['hunter2', undefined, 'fourth', undefined])
  })

  it('keeps a password out of the vault when the login it was asked on never issued a pair', async () => {
    let password: string | undefined
    const vault: FreeCodeGoCredentialVault = {
      load: async () => undefined,
      save: async () => {},
      delete: async () => {},
      loadPassword: async () => password,
      savePassword: async (_origin, value) => { password = value },
      deletePassword: async () => { password = undefined },
    }
    const auth = {
      origin: 'https://freecodego.example',
      login: async () => { throw new Error('invalid credentials') },
      logout: async () => {},
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)

    // A rejected credential must not be the password this machine keeps — the
    // most likely thing a failed attempt typed is a typo.
    await expect(coordinator.login({ email: 'user@example.com', password: 'typo', rememberPassword: true })).rejects.toThrow('invalid credentials')
    await expect(coordinator.rememberedPassword()).resolves.toBeUndefined()
  })

  it('keeps an unremembered login out of the vault and clears a stored session', async () => {
    // A vault holds whole token pairs, so the fixture holds one too — the
    // previous session it stands in for was written by the same `save`.
    let stored: FreeCodeGoTokenPair | undefined = { accessToken: 'previous-access', refreshToken: 'previous-session', expiresIn: 3600, tokenType: 'Bearer' }
    const deletes: number[] = []
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { deletes.push(1); stored = undefined },
    }
    let refreshCount = 0
    const auth = {
      origin: 'https://freecodego.example',
      login: async () => ({
        kind: 'authenticated' as const,
        tokens: { accessToken: 'ephemeral', refreshToken: 'ephemeral-refresh', expiresIn: 3600, tokenType: 'Bearer' as const },
        user: { id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' },
      }),
      refresh: async () => { refreshCount++; return { accessToken: 'rotated', refreshToken: 'rotated-refresh', expiresIn: 3600, tokenType: 'Bearer' as const } },
      logout: async () => {},
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)

    // Unchecked "keep me signed in": the pair must live in memory only, and the
    // session a previous remembered login left on disk must be erased — or the
    // next launch would restore the account the user declined to keep.
    await coordinator.login({ email: 'user@example.com', password: 'password', remember: false })
    expect(coordinator.snapshot()).toMatchObject({ status: 'authenticated' })
    expect(stored).toBeUndefined()
    expect(deletes.length).toBe(1)
    // In-process operations still work: refresh rotates into memory, not disk.
    await coordinator.refresh()
    expect(refreshCount).toBe(1)
    expect(stored).toBeUndefined()
    expect(await coordinator.hasStoredSession()).toBe(true)
    // The memory pair is gone with the process; a restart sees no session.
    await coordinator.logout()
    expect(await coordinator.hasStoredSession()).toBe(false)
  })

  it('reports no stored session when the vault entry cannot be decoded', async () => {
    // Regression: an entry written by an older token-pair shape (or a truncated
    // file) made the decoder throw straight out of `hasStoredSession`, and that
    // gate is consulted unguarded by the model picker's availability row and by
    // the settings card's recovery branch — one bad file broke both surfaces
    // instead of asking for a login. `refresh()` still erases the entry.
    const vault: FreeCodeGoCredentialVault = {
      load: async () => { throw new Error('Stored FreeCodeGo session is incomplete') },
      save: async () => {},
      delete: async () => {},
    }
    const auth = {
      origin: 'https://freecodego.example',
      login: async () => ({ kind: 'authenticated' as const, tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600, tokenType: 'Bearer' as const }, user: { id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' } }),
      refresh: async () => { throw new Error('unreachable') },
      logout: async () => {},
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    await expect(coordinator.hasStoredSession()).resolves.toBe(false)
  })

  it('persists again after an unremembered login is replaced by a remembered one', async () => {
    let stored: FreeCodeGoTokenPair | undefined
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined },
    }
    const pairs = [
      { accessToken: 'a1', refreshToken: 'r1', expiresIn: 3600, tokenType: 'Bearer' as const },
      { accessToken: 'a2', refreshToken: 'r2', expiresIn: 3600, tokenType: 'Bearer' as const },
    ]
    let loginCount = 0
    const auth = {
      origin: 'https://freecodego.example',
      login: async () => ({ kind: 'authenticated' as const, tokens: pairs[loginCount++]!, user: { id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' } }),
      // Rotation echoes whatever the vault held in these tests; the shape is
      // all the coordinator reads.
      refresh: async (refreshToken: string) => ({ ...pairs[0]!, refreshToken }),
      logout: async () => {},
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)

    await coordinator.login({ email: 'user@example.com', password: 'password', remember: false })
    expect(stored).toBeUndefined()
    await coordinator.login({ email: 'user@example.com', password: 'password', remember: true })
    expect(stored).toMatchObject({ refreshToken: 'r2' })
    await coordinator.refresh()
    expect(stored).toMatchObject({ refreshToken: 'r2' })
  })

  it('does not abandon a durable session when an unremembered login fails', async () => {
    // `remember` describes the login it belongs to, and it used to be committed
    // to the coordinator *before* that login could fail. A wrong password on an
    // unremembered attempt therefore put the whole process into memory-only mode:
    // the next `refresh()` read the empty memory store instead of the vault and
    // reported the user signed out, `hasStoredSession()` answered false, and
    // `withAccessToken` refused every call with "authentication is required" —
    // while a perfectly good pair sat in the vault, now unreachable until the
    // next successful login.
    let stored: FreeCodeGoTokenPair | undefined = { accessToken: 'durable-access', refreshToken: 'durable-session', expiresIn: 3600, tokenType: 'Bearer' }
    let saved: FreeCodeGoTokenPair | undefined
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { saved = value; stored = value },
      delete: async () => { stored = undefined },
    }
    const auth = {
      origin: 'https://freecodego.example',
      login: async () => { throw new Error('invalid email or password') },
      refresh: async () => ({ accessToken: 'rotated', refreshToken: 'rotated-session', expiresIn: 3600, tokenType: 'Bearer' as const }),
      logout: async () => {},
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    coordinator.setAuthenticated({ id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' })

    await expect(coordinator.login({ email: 'user@example.com', password: 'wrong', remember: false })).rejects.toThrow('invalid email or password')

    // A failed attempt issued no pair, so it has no persistence intent to record:
    // the durable session is still the session, and rotation still writes to it.
    await expect(coordinator.hasStoredSession()).resolves.toBe(true)
    await coordinator.refresh()
    expect(coordinator.snapshot()).toMatchObject({ status: 'authenticated' })
    expect(saved).toMatchObject({ refreshToken: 'rotated-session' })
  })

  it('does not abandon a durable session while an MFA challenge is merely pending', async () => {
    // The same defect one step further out: an unremembered login that stops at
    // the second factor had already committed its mode, so a user who never
    // finished the challenge lost access to the session already on disk.
    let stored: FreeCodeGoTokenPair | undefined = { accessToken: 'durable-access', refreshToken: 'durable-session', expiresIn: 3600, tokenType: 'Bearer' }
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined },
    }
    const auth = {
      origin: 'https://freecodego.example',
      login: async () => ({ kind: 'mfa-required' as const, tempToken: 'temp-token', emailMasked: 'u***@example.com' }),
      refresh: async () => ({ accessToken: 'rotated', refreshToken: 'rotated-session', expiresIn: 3600, tokenType: 'Bearer' as const }),
      logout: async () => {},
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)

    await coordinator.login({ email: 'user@example.com', password: 'password', remember: false })
    expect(coordinator.snapshot()).toMatchObject({ status: 'mfa-required' })
    await expect(coordinator.hasStoredSession()).resolves.toBe(true)
  })

  it('keeps an MFA login memory-only when its first step declined to remember', async () => {
    // The other direction, and the reason the intent is carried across the two
    // steps rather than committed per call: a completed MFA login must honour the
    // "keep me signed in" choice made when the password was submitted.
    let stored: FreeCodeGoTokenPair | undefined = { accessToken: 'durable-access', refreshToken: 'durable-session', expiresIn: 3600, tokenType: 'Bearer' }
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined },
    }
    const auth = {
      origin: 'https://freecodego.example',
      login: async () => ({ kind: 'mfa-required' as const, tempToken: 'temp-token', emailMasked: 'u***@example.com' }),
      login2FA: async () => ({ kind: 'authenticated' as const, tokens: { accessToken: 'mfa-access', refreshToken: 'mfa-session', expiresIn: 3600, tokenType: 'Bearer' as const }, user: { id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' } }),
      refresh: async () => ({ accessToken: 'rotated', refreshToken: 'rotated-session', expiresIn: 3600, tokenType: 'Bearer' as const }),
      logout: async () => {},
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)

    await coordinator.login({ email: 'user@example.com', password: 'password', remember: false })
    await coordinator.completeMfa('123456')
    expect(coordinator.snapshot()).toMatchObject({ status: 'authenticated' })
    // Memory-only: the pair must not reach the vault, and the durable session an
    // earlier remembered login left there must be erased.
    expect(stored).toBeUndefined()
    await expect(coordinator.hasStoredSession()).resolves.toBe(true)
  })

  it('refreshes an expiring JWT once for concurrent authorized operations', async () => {
    const expired = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1 }), 'utf8').toString('base64url')}.signature`
    let stored: FreeCodeGoTokenPair = { accessToken: expired, refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' }
    let refreshCalls = 0
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined as never },
    }
    const auth = {
      origin: 'https://freecodego.example',
      refresh: async () => { refreshCalls += 1; return { accessToken: 'fresh', refreshToken: 'fresh-refresh', expiresIn: 3600, tokenType: 'Bearer' as const } },
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    await Promise.all([
      coordinator.withAccessToken(async token => token),
      coordinator.withAccessToken(async token => token),
    ])
    expect(refreshCalls).toBe(1)
    expect(stored.accessToken).toBe('fresh')
  })

  it('refreshes once when the backend rejects an otherwise unexpired token', async () => {
    let stored: FreeCodeGoTokenPair = { accessToken: 'old-token', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' }
    let refreshCalls = 0
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined as never },
    }
    const auth = {
      origin: 'https://freecodego.example',
      refresh: async () => { refreshCalls += 1; return { accessToken: 'fresh-token', refreshToken: 'fresh-refresh', expiresIn: 3600, tokenType: 'Bearer' as const } },
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    let attempts = 0
    await expect(coordinator.withAccessToken(async (token) => {
      attempts += 1
      if (token === 'old-token') throw Object.assign(new Error('invalid api key'), { status: 401 })
      return token
    })).resolves.toBe('fresh-token')
    expect(attempts).toBe(2)
    expect(refreshCalls).toBe(1)
  })

  it('does not replay a non-idempotent operation after a 401 when replay is disabled', async () => {
    let stored: FreeCodeGoTokenPair = { accessToken: 'old-token', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' }
    let refreshCalls = 0
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined as never },
    }
    const auth = {
      origin: 'https://freecodego.example',
      refresh: async () => { refreshCalls += 1; return { accessToken: 'fresh-token', refreshToken: 'fresh-refresh', expiresIn: 3600, tokenType: 'Bearer' as const } },
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    let attempts = 0
    await expect(coordinator.withAccessToken(async () => {
      attempts += 1
      throw Object.assign(new Error('invalid api key'), { status: 401 })
    }, undefined, { replayOnUnauthorized: false })).rejects.toMatchObject({ status: 401 })
    // A non-idempotent call must be sent exactly once and must not rotate the
    // session just to retry it.
    expect(attempts).toBe(1)
    expect(refreshCalls).toBe(0)
  })

  it('keeps a newer vault session when an older refresh token was reused elsewhere', async () => {
    let stored: FreeCodeGoTokenPair = { accessToken: 'old-token', refreshToken: 'old-refresh', expiresIn: 3600, tokenType: 'Bearer' }
    let refreshCalls = 0
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined as never },
    }
    const auth = {
      origin: 'https://freecodego.example',
      refresh: async () => {
        refreshCalls += 1
        stored = { accessToken: 'new-token', refreshToken: 'new-refresh', expiresIn: 3600, tokenType: 'Bearer' }
        throw new Error('refresh token has been reused')
      },
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    await expect(coordinator.refresh()).resolves.toBeUndefined()
    expect(refreshCalls).toBe(1)
    expect(stored.refreshToken).toBe('new-refresh')
    expect(coordinator.snapshot()).toEqual({ status: 'signed-out' })
  })

  it('erases a credential the gateway called invalidated when the status is unusable', async () => {
    // The wording table is `refresh-guard.ts`'s, and it covers the rejections whose
    // status a proxy dropped. A second wording check written at this catch site
    // decided the same case differently — this spelling is recognized by the guard
    // (`token invalidated`) but the copy here did not list it — so a credential the
    // server had pronounced dead stayed in the vault and the session kept reporting
    // itself authenticated, with every later call failing against it.
    let stored: FreeCodeGoTokenPair | undefined = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' }
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined },
    }
    const auth = {
      origin: 'https://freecodego.example',
      refresh: async () => { throw new Error('session token invalidated') },
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    coordinator.setAuthenticated({ id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' })

    await expect(coordinator.refresh()).rejects.toThrow('session token invalidated')
    expect(stored).toBeUndefined()
    expect(coordinator.snapshot()).toEqual({ status: 'reauth-required' })
  })

  it('keeps the session when the failure is one the classifier calls transient', async () => {
    // The other half of the same rule, and the reason it is not "erase when the
    // refresh fails": a malformed device id arrives as a 400, which is a
    // request-validation failure rather than proof that the credential is dead.
    // Erasing on one costs the user a manual sign-in for a bug this code caused.
    let stored: FreeCodeGoTokenPair | undefined = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' }
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined },
    }
    const auth = {
      origin: 'https://freecodego.example',
      refresh: async () => { throw Object.assign(new Error('device id is required'), { status: 400 }) },
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    coordinator.setAuthenticated({ id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' })

    await expect(coordinator.refresh()).rejects.toThrow('device id is required')
    expect(stored).toMatchObject({ refreshToken: 'refresh' })
    expect(coordinator.snapshot()).toMatchObject({ status: 'authenticated' })
  })

  it('retries a refused vault write once, so one failure still persists the rotation', async () => {
    let stored: FreeCodeGoTokenPair | undefined = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' }
    let saves = 0
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { saves += 1; if (saves === 1) throw new Error('EACCES: permission denied, open session.json'); stored = value },
      delete: async () => { stored = undefined },
    }
    const auth = {
      origin: 'https://freecodego.example',
      refresh: async () => ({ accessToken: 'rotated', refreshToken: 'rotated-refresh', expiresIn: 3600, tokenType: 'Bearer' as const }),
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    coordinator.setAuthenticated({ id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' })

    await expect(coordinator.refresh()).resolves.toBeUndefined()
    expect(saves).toBe(2)
    expect(stored).toMatchObject({ refreshToken: 'rotated-refresh' })
    expect(coordinator.snapshot()).toMatchObject({ status: 'authenticated' })
  })

  it('keeps the rotated pair in memory and reports the session as not durable when both writes fail', async () => {
    // The pair in hand is the only credential that still works — the server
    // consumed the one on disk at the moment the exchange succeeded — so a vault
    // that refuses it cannot be answered by erasing the vault, which would delete
    // the entry and keep nothing. The session stays live for this process, and the
    // snapshot has to say that it will not survive a restart.
    let stored: FreeCodeGoTokenPair | undefined = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' }
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async () => { throw new Error('EACCES: permission denied, open session.json') },
      delete: async () => { stored = undefined },
    }
    const auth = {
      origin: 'https://freecodego.example',
      refresh: async () => ({ accessToken: 'rotated', refreshToken: 'rotated-refresh', expiresIn: 3600, tokenType: 'Bearer' as const }),
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    coordinator.setAuthenticated({ id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' })

    await expect(coordinator.refresh()).resolves.toBeUndefined()
    expect(stored).toMatchObject({ refreshToken: 'refresh' })
    expect(coordinator.snapshot()).toMatchObject({ status: 'authenticated', persistence: 'failed' })
    // A call in this process uses the pair that works, not the spent one still on disk.
    const seen: string[] = []
    await coordinator.withAccessToken(async (accessToken) => { seen.push(accessToken) })
    expect(seen).toEqual(['rotated'])
  })

  it('neither retries nor erases a rotation this process stopped waiting for', async () => {
    // A bound this process set is not a verdict the gateway reached. The token a
    // retry would send may already be spent, and nothing said the credential is
    // dead, so the only safe answers are "do not retry" and "do not erase".
    let stored: FreeCodeGoTokenPair | undefined = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' }
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined },
    }
    let refreshCalls = 0
    const auth = {
      origin: 'https://freecodego.example',
      refresh: async () => {
        refreshCalls += 1
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      },
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    coordinator.setAuthenticated({ id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' })

    await expect(coordinator.refresh()).rejects.toThrow('aborted due to timeout')
    expect(refreshCalls).toBe(1)
    expect(stored).toMatchObject({ refreshToken: 'refresh' })
    expect(coordinator.snapshot()).toMatchObject({ status: 'authenticated' })
  })

  it('does not erase a credential whose only rejection arrived after its own transport retry', async () => {
    // The chain this closes: attempt 1 gets no answer at all (the request may
    // have landed), the guard retries by its own rule, and attempt 2 answers 401.
    // That 401 is a token this process has now sent twice, so it is as much a
    // consequence of the retry as a verdict — and erasing on it costs the user a
    // manual sign-in for a credential that may still be valid.
    let stored: FreeCodeGoTokenPair | undefined = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' }
    const vault: FreeCodeGoCredentialVault = {
      load: async () => stored,
      save: async (_origin, value) => { stored = value },
      delete: async () => { stored = undefined },
    }
    let refreshCalls = 0
    const auth = {
      origin: 'https://freecodego.example',
      refresh: async () => {
        refreshCalls += 1
        if (refreshCalls === 1) throw new Error('fetch failed')
        throw Object.assign(new Error('refresh token invalid'), { status: 401 })
      },
    } as unknown as FreeCodeGoMobileAuthClientType
    const coordinator = new FreeCodeGoAccountCoordinator(auth, vault)
    coordinator.setAuthenticated({ id: 1, username: 'user', email: 'user@example.com', role: 'user', balance: 0, status: 'active' })

    await expect(coordinator.refresh()).rejects.toThrow('refresh token invalid')
    expect(refreshCalls).toBe(2)
    expect(stored).toMatchObject({ refreshToken: 'refresh' })
    expect(coordinator.snapshot()).toMatchObject({ status: 'authenticated' })
  })
})
