/**
 * The plan list the desktop sells.
 *
 * The administrator's `subscription_plans` table is the catalogue, so the panel
 * has to read it — but a Harness purchase is a balance top-up (`plan_id=0` plus
 * an explicit amount), not a subscription grant. A subscription row sold
 * through that flow would take money and grant nothing, so the discriminator is
 * permanence and anything else falls back to the built-in ladder.
 *
 * @module tests/payment-plans
 */

import { describe, expect, it } from 'vitest'
import { paymentPlans } from '../src/payment-remotes.ts'

/** The narrow host view the remote reads: one checkout call and one token. */
const host = (plans: readonly unknown[]): never => ({
  api: { getPaymentCheckoutInfo: async () => ({ plans, channels: [] }) },
  account: {
    snapshot: () => ({ status: 'authenticated' }),
    withAccessToken: async (fn: (token: string) => Promise<unknown>) => fn('token'),
  },
  restoreAccount: async () => {},
}) as never

const credit = (id: number | string, name: string, price: number, validityUnit: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id, name, price, currency: 'USD', validityUnit, ...extra })

describe('saleable plans', () => {
  it('takes the backend table when it declares permanent credit', async () => {
    // A price edit, a rename, or a delisting in the admin table has to reach the
    // desktop without a plugin release; that is the whole point of the wiring.
    const plans = await paymentPlans(host([
      credit(7, 'US$30 Developer Credit', 30, 'forEver'),
      credit(8, 'US$80 Developer Credit', 80, 'permanent', { originalPrice: 100, features: ['Never expires'] }),
    ]))
    expect(plans.map(plan => plan.name)).toEqual(['US$30 Developer Credit', 'US$80 Developer Credit'])
    expect(plans[1]?.originalPrice).toBe(100)
    expect(plans[1]?.features).toEqual(['Never expires'])
    // The built-in ladder is replaced, not merged: a stale US$5 row must not
    // survive beside the administrator's real prices.
    expect(plans.some(plan => plan.name === 'US$5 Developer Credit')).toBe(false)
  })

  it('keeps the ladder when the table only holds subscriptions', async () => {
    // The regression this locks: offering a term plan through an amount-based
    // top-up would charge the user for a subscription the flow cannot grant.
    const plans = await paymentPlans(host([
      credit(1, 'US$11 Monthly Subscription', 11, 'day', { validityDays: 30 }),
      credit(2, 'US$99 Annual Subscription', 99, 'month', { validityDays: 12 }),
    ]))
    expect(plans).toHaveLength(6)
    expect(plans[0]?.name).toBe('US$5 Developer Credit')
    expect(plans.some(plan => plan.name.includes('Subscription'))).toBe(false)
  })

  it('keeps the ladder when the table is empty or a plan declares no unit', async () => {
    // No unit means the row says nothing about permanence, which is not a
    // licence to assume it. A fresh deployment and a half-filled row both have
    // to leave the payment section usable.
    const empty = await paymentPlans(host([]))
    expect(empty).toHaveLength(6)
    const undeclared = await paymentPlans(host([{ id: 3, name: 'Mystery', price: 10, currency: 'USD' }]))
    expect(undeclared[0]?.name).toBe('US$5 Developer Credit')
  })

  it('offers only the permanent rows out of a mixed table', async () => {
    const plans = await paymentPlans(host([
      credit(1, 'US$11 Monthly Subscription', 11, 'day', { validityDays: 30 }),
      credit(9, 'US$50 Developer Credit', 50, 'forever'),
    ]))
    expect(plans.map(plan => plan.name)).toEqual(['US$50 Developer Credit'])
  })
})
