/**
 * The checkout call's return-URL contract.
 *
 * Why this file exists
 * --------------------
 * The settings surface sends the console-mounted result page
 * (`https://freecodego.com/rootadmin/payment/result`) because the marketing site
 * answers the bare `/payment/result` with a catch-all 200 landing page. The Host
 * demanded the bare string, so the two disagreed and the stricter one won: every
 * purchase click failed *before* an order was created, which the panel showed as
 * a button that does nothing.
 *
 * The rule is now "same origin, canonical tail". These cases pin both halves:
 * the path the UI really sends is accepted, and a redirected origin or a
 * decorated path is still refused.
 *
 * @module tests/payment-checkout
 */

import { describe, expect, it } from 'vitest'
import { isCanonicalPaymentReturnUrl, paymentCheckout } from '../src/payment-remotes.ts'

const ORIGIN = 'https://freecodego.com'

/** A host that records what reached the api, so a refusal is provable. */
function host(): { calls: { returnUrl: string }[]; value: never } {
  const calls: { returnUrl: string }[] = []
  return {
    calls,
    value: {
      gatewayBaseUrl: () => ORIGIN,
      api: {
        createCheckout: async (request: { readonly returnUrl: string }) => {
          calls.push({ returnUrl: request.returnUrl })
          return { orderId: 'order-1', state: 'pending', amount: 10, currency: 'USD' }
        },
      },
      account: {
        snapshot: () => ({ status: 'authenticated' }),
        withAccessToken: async (fn: (token: string) => Promise<unknown>) => fn('token'),
      },
      restoreAccount: async () => {},
    } as never,
  }
}

describe('checkout return URL', () => {
  it('accepts the console-mounted result page the settings surface sends', async () => {
    // The exact URL the 购买 button sends. Rejecting this is what made the button
    // dead, so it is the case that must never regress.
    const fake = host()
    const order = await paymentCheckout(fake.value, 0, 'alipay', `${ORIGIN}/rootadmin/payment/result`, 10)
    expect(order.orderId).toBe('order-1')
    expect(fake.calls.map(call => call.returnUrl)).toStrictEqual([`${ORIGIN}/rootadmin/payment/result`])
  })

  it('still accepts the bare canonical path', () => {
    expect(isCanonicalPaymentReturnUrl(ORIGIN, `${ORIGIN}/payment/result`)).toBe(true)
    // A trailing slash on the configured origin must not create a second shape.
    expect(isCanonicalPaymentReturnUrl(`${ORIGIN}/`, `${ORIGIN}/payment/result`)).toBe(true)
  })

  it('accepts a one-segment mount for a private deployment', () => {
    expect(isCanonicalPaymentReturnUrl('https://gw.internal.example', 'https://gw.internal.example/console/payment/result')).toBe(true)
  })

  it('refuses another origin, a deeper path, or a decorated path', () => {
    // A caller that could redirect the post-payment page off-origin would be an
    // open redirect handed to whoever can reach this Remote.
    expect(isCanonicalPaymentReturnUrl(ORIGIN, 'https://evil.example/payment/result')).toBe(false)
    expect(isCanonicalPaymentReturnUrl(ORIGIN, 'https://freecodego.com.evil.example/payment/result')).toBe(false)
    expect(isCanonicalPaymentReturnUrl(ORIGIN, `${ORIGIN}/a/b/payment/result`)).toBe(false)
    expect(isCanonicalPaymentReturnUrl(ORIGIN, `${ORIGIN}/rootadmin/payment/result?next=https://evil.example`)).toBe(false)
    expect(isCanonicalPaymentReturnUrl(ORIGIN, `${ORIGIN}/rootadmin/../payment/result`)).toBe(false)
    expect(isCanonicalPaymentReturnUrl(ORIGIN, `${ORIGIN}/rootadmin/payment/other`)).toBe(false)
    expect(isCanonicalPaymentReturnUrl(ORIGIN, '')).toBe(false)
  })

  it('refuses before reaching the backend, so no order is created for a bad target', async () => {
    const fake = host()
    await expect(paymentCheckout(fake.value, 0, 'alipay', 'https://evil.example/payment/result', 10)).rejects.toThrow(/canonical payment result page/u)
    expect(fake.calls).toStrictEqual([])
  })
})
