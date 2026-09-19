/**
 * The request budget a money path spends.
 *
 * Why this file exists
 * --------------------
 * Every authenticated call used to share one 8s timeout. Creating an order makes
 * the backend wait on Alipay / WeChat / Stripe / Airwallex, so on a slow provider
 * the client aborted a request the server completed: no order id reached the
 * panel, the purchase button stayed disabled for the whole wait and then showed
 * "payment service unavailable", and repeated clicks left orphaned pending
 * orders. These cases pin the split budget — reads stay short, provider calls
 * get room — so a single re-merge of the two cannot come back silently.
 *
 * The budgets are overridden to milliseconds here: the contract is the ordering,
 * not the number.
 *
 * @module tests/payment-timeout
 */

import { describe, expect, it } from 'vitest'
import { FreeCodeGoApiClient, FREECODEGO_PROVIDER_TIMEOUT_MS, FREECODEGO_READ_TIMEOUT_MS } from '../src/index.ts'

const ORIGIN = 'https://freecodego.example'

/** A provider that never answers: the connection is held open until the budget
 * aborts it, exactly as a real fetch reacts to its signal. */
const stalledFetch: typeof globalThis.fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
  // `RequestInit.signal` is `AbortSignal | null`, and a request with no budget
  // passes neither. Both read as "there is nothing to abort on".
  const signal = init?.signal ?? undefined
  if (signal === undefined) return
  const fail = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))) }
  if (signal.aborted) { fail(); return }
  signal.addEventListener('abort', fail, { once: true })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

describe('the provider request budget', () => {
  it('is longer than the read budget by default', () => {
    // A read waits on the backend's own database; an order waits on a payment
    // provider. If these ever collapse back into one number, the bug returns.
    expect(FREECODEGO_PROVIDER_TIMEOUT_MS).toBeGreaterThan(FREECODEGO_READ_TIMEOUT_MS)
    expect(FREECODEGO_READ_TIMEOUT_MS).toBe(8_000)
  })

  it('refuses a nonsensical override instead of silently ignoring it', () => {
    expect(() => new FreeCodeGoApiClient({ baseUrl: ORIGIN, timeouts: { provider: 0 } })).toThrow(/positive number/u)
    expect(() => new FreeCodeGoApiClient({ baseUrl: ORIGIN, timeouts: { read: Number.NaN } })).toThrow(/positive number/u)
  })

  it('keeps an order request alive after the read budget has expired', async () => {
    const client = new FreeCodeGoApiClient({ baseUrl: ORIGIN, fetch: stalledFetch, timeouts: { read: 20, provider: 400 } })
    const order = client.createCheckout({ accessToken: 'host-only-token', planId: 0, paymentType: 'alipay', returnUrl: `${ORIGIN}/payment/result`, amount: 5 })
    const read = client.getPaymentOrders({ accessToken: 'host-only-token' })

    // The read gives up on its own budget...
    await expect(read).rejects.toThrow(/timeout|abort/iu)
    // ...while the same stalled connection is still held open for the order, well
    // past the read budget. This is the assertion that fails if the two budgets
    // are ever the same value again.
    const outcome = await Promise.race([order.then(() => 'settled', () => 'rejected'), delay(200).then(() => 'pending')])
    expect(outcome).toBe('pending')

    // It still ends: a budget is a ceiling, not an infinite wait.
    await expect(order).rejects.toThrow(/timeout|abort/iu)
  })

  it('gives verification the provider budget too', async () => {
    const client = new FreeCodeGoApiClient({ baseUrl: ORIGIN, fetch: stalledFetch, timeouts: { read: 20, provider: 400 } })
    const verify = client.verifyCheckoutOrder({ accessToken: 'host-only-token', outTradeNo: 'trade-1' })
    const outcome = await Promise.race([verify.then(() => 'settled', () => 'rejected'), delay(200).then(() => 'pending')])
    expect(outcome).toBe('pending')
    await expect(verify).rejects.toThrow(/timeout|abort/iu)
  })
})
