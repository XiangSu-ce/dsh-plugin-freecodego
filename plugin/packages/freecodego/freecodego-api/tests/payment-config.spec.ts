/**
 * The desktop checkout configuration reader.
 *
 * Why this file exists
 * --------------------
 * Two facts the in-panel card form depends on live in this one response: the
 * **publishable** Stripe key (without it there is no in-app card form, only the
 * backend's own checkout page) and the account's real per-order limits (the
 * `checkout-info` channel rows can report `single_min`/`single_max` as `0`, which
 * reads as "no amount is allowed" beside a working buy button).
 *
 * The other half of the file is the boundary itself: this reader goes through the
 * same secret-rejecting path as every other authenticated read, so a deployment
 * that ever put a secret key in this projection fails loudly rather than handing
 * it to a browser.
 *
 * @module tests/payment-config
 */

import { describe, expect, it } from 'vitest'
import { FreeCodeGoApiClient } from '../src/index.ts'

const ORIGIN = 'https://freecodego.example'

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

function client(payload: unknown): { client: FreeCodeGoApiClient; paths: string[] } {
  const paths: string[] = []
  return {
    paths,
    client: new FreeCodeGoApiClient({
      baseUrl: ORIGIN,
      fetch: async (input) => { paths.push(new URL(String(input)).pathname); return response(payload) },
    }),
  }
}

describe('the desktop payment config', () => {
  it('reads the limits and the publishable key from the desktop projection', async () => {
    const { client: api, paths } = client({
      data: {
        payment_enabled: true,
        min_amount: 1,
        max_amount: 50000,
        daily_limit: 100000,
        order_timeout_minutes: 10,
        max_pending_orders: 3,
        enabled_payment_types: ['alipay', 'stripe', 'wxpay'],
        balance_disabled: false,
        balance_recharge_multiplier: 0.14,
        recharge_fee_rate: 5,
        help_text: '联系客服',
        stripe_publishable_key: 'pk_live_123',
      },
    })
    await expect(api.getDesktopPaymentConfig({ accessToken: 'host-only-token' })).resolves.toStrictEqual({
      paymentEnabled: true,
      minAmount: 1,
      maxAmount: 50000,
      dailyLimit: 100000,
      orderTimeoutMinutes: 10,
      maxPendingOrders: 3,
      enabledPaymentTypes: ['alipay', 'stripe', 'wxpay'],
      balanceDisabled: false,
      balanceRechargeMultiplier: 0.14,
      rechargeFeeRate: 5,
      helpText: '联系客服',
      stripePublishableKey: 'pk_live_123',
    })
    expect(paths).toStrictEqual(['/api/v1/freecodego/payment/config'])
  })

  it('says nothing rather than zero when a field is absent', async () => {
    // An absent limit and a limit of `0` are different facts, and only one of
    // them means "no amount is allowed". Every optional field must stay absent.
    const { client: api } = client({ data: { payment_enabled: true, enabled_payment_types: [] } })
    const config = await api.getDesktopPaymentConfig({ accessToken: 'host-only-token' })
    expect(config).toStrictEqual({ paymentEnabled: true, enabledPaymentTypes: [] })
    expect('stripePublishableKey' in config).toBe(false)
    expect('minAmount' in config).toBe(false)
  })

  it('treats a missing master switch as enabled, not as off', async () => {
    // "Missing" is not "off": guessing off would empty a payment section that
    // works, so only an explicit `false` closes it.
    const { client: api } = client({ data: {} })
    await expect(api.getDesktopPaymentConfig({ accessToken: 'host-only-token' })).resolves.toMatchObject({ paymentEnabled: true })
    const { client: disabled } = client({ data: { payment_enabled: false } })
    await expect(disabled.getDesktopPaymentConfig({ accessToken: 'host-only-token' })).resolves.toMatchObject({ paymentEnabled: false })
  })

  it('drops junk in the enabled-types list instead of trusting it', async () => {
    const { client: api } = client({ data: { payment_enabled: true, enabled_payment_types: ['alipay', 7, '', '  ', null, 'wxpay'] } })
    await expect(api.getDesktopPaymentConfig({ accessToken: 'host-only-token' })).resolves.toMatchObject({ enabledPaymentTypes: ['alipay', 'wxpay'] })
  })

  it('refuses a response that carries a secret, even here', async () => {
    // The publishable key is public by design; a *secret* key in the same
    // projection is a deployment mistake that must never reach a browser.
    const { client: api } = client({ data: { payment_enabled: true, stripe_secret_key: 'sk_live_123' } })
    await expect(api.getDesktopPaymentConfig({ accessToken: 'host-only-token' })).rejects.toThrow(/secret/i)
  })
})
