import { describe, expect, it } from 'vitest'
import { AntSeedGateway } from '../src/antseed/gateway.ts'

describe('AntSeed gateway', () => {
  it('starts closed, which is what a Host restart does', () => {
    // The switch is not persisted, so "closed" is not a default this test
    // happens to observe — it is the state after every restart, and the reason
    // the feature is switched on deliberately rather than remembered.
    const gateway = new AntSeedGateway()
    expect(gateway.status()).toEqual({ enabled: false, closedReason: 'KEY_GATEWAY_CLOSED' })
    expect(() => { gateway.assertOpen() }).toThrow('turn on the private-key gateway')
  })

  it('does not carry an earlier session\'s state into a new instance', () => {
    const first = new AntSeedGateway()
    first.enable()
    expect(first.status().enabled).toBe(true)
    expect(new AntSeedGateway().status().enabled).toBe(false)
  })

  it('reports no reason once it is open', () => {
    const gateway = new AntSeedGateway()
    // Absent rather than an empty string: a surface renders the switch and this
    // line from one value, and "" would print an empty notice.
    expect(gateway.enable()).toEqual({ enabled: true })
    expect('closedReason' in gateway.enable()).toBe(false)
  })

  it('lets a route through only while it is open', () => {
    const gateway = new AntSeedGateway()
    expect(() => { gateway.assertOpen() }).toThrow()
    gateway.enable()
    expect(() => { gateway.assertOpen() }).not.toThrow()
  })

  it('closes again from the open state', () => {
    const gateway = new AntSeedGateway()
    gateway.enable()
    expect(gateway.disable()).toEqual({ enabled: false, closedReason: 'KEY_GATEWAY_CLOSED' })
    expect(() => { gateway.assertOpen() }).toThrow('KEY_GATEWAY_CLOSED')
  })

  it('stays closed across repeated closes and opens once across repeated opens', () => {
    const gateway = new AntSeedGateway()
    expect(gateway.disable().enabled).toBe(false)
    expect(gateway.enable().enabled).toBe(true)
    expect(gateway.enable().enabled).toBe(true)
  })
})
