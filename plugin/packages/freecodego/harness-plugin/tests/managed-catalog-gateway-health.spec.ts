/**
 * The gateway channel monitor is a user-visible card, and one backend answering
 * 404 for `/channel-health` used to switch the probe off for the rest of the
 * process. That verdict is a fact about *one* backend: the app rebuilds these
 * clients whenever the persisted endpoint changes, and it calls
 * `invalidateGatewayHealth()` on logout precisely so "a fresh login re-probes".
 * Neither path used to undo the verdict, so pointing the app at a local backend
 * without that route — and then switching back — left the cards empty until the
 * app restarted.
 *
 * A temporary failure is not that verdict either: only a 404 says "this backend
 * has no such route", and everything else has to stay retryable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FreeCodeGoManagedCatalogs } from '../src/managed-catalogs.ts'

const CADENCE_MS = 30 * 60_000
const UNSUPPORTED_MS = 6 * 60 * 60_000

let endpoint = { current: 'https://cloud.freecodego.example' }
let answer: 'ok' | '404' | '500' = 'ok'
let authenticated = true
let probes: string[] = []
let events: string[] = []
let base = 0

const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 20)) }
const at = (offsetMs: number): void => { vi.setSystemTime(base + offsetMs) }

beforeEach(() => {
  endpoint = { current: 'https://cloud.freecodego.example' }
  answer = 'ok'
  authenticated = true
  probes = []
  events = []
  base = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(base)
})

afterEach(() => { vi.useRealTimers() })

function catalogs(): FreeCodeGoManagedCatalogs {
  return new FreeCodeGoManagedCatalogs({
    ctx: { emit: (name: string) => events.push(name), get: () => undefined },
    gatewayBaseUrl: () => endpoint.current,
    api: () => ({
      getGatewayProviderHealth: async () => {
        probes.push(endpoint.current)
        if (answer === '404') throw new Error('FreeCodeGo request /api/v1/freecodego/agent/channel-health failed with HTTP 404')
        if (answer === '500') throw new Error('FreeCodeGo request /api/v1/freecodego/agent/channel-health failed with HTTP 500')
        return []
      },
    }),
    account: () => ({
      snapshot: () => ({ status: authenticated ? 'authenticated' : 'signed-out' }),
      withAccessToken: async (use: (token: string) => Promise<unknown>) => use('token'),
    }),
  } as unknown as ConstructorParameters<typeof FreeCodeGoManagedCatalogs>[0])
}

describe('gateway channel health probing', () => {
  it('probes once per cadence and announces the answer', async () => {
    const instance = catalogs()
    instance.refreshGatewayHealthInBackground()
    await settle()

    expect(probes).toEqual(['https://cloud.freecodego.example'])
    expect(events).toEqual(['llm/adapters-updated'])

    instance.refreshGatewayHealthInBackground()
    await settle()
    expect(probes.length).toBe(1)

    at(CADENCE_MS + 60_000)
    instance.refreshGatewayHealthInBackground()
    await settle()
    expect(probes.length).toBe(2)
  })

  it('records a missing route as a fact about that endpoint', async () => {
    const instance = catalogs()
    answer = '404'
    instance.refreshGatewayHealthInBackground()
    await settle()
    expect(probes.length).toBe(1)

    // Nothing changed about this backend, so it is not asked again.
    at(CADENCE_MS + 60_000)
    instance.refreshGatewayHealthInBackground()
    await settle()
    expect(probes.length).toBe(1)
    expect(events).toEqual([])
  })

  it('does not let one endpoint silence another', async () => {
    const instance = catalogs()
    answer = '404'
    instance.refreshGatewayHealthInBackground()
    await settle()
    expect(probes).toEqual(['https://cloud.freecodego.example'])

    // The app repoints the gateway at a backend that does implement the route.
    endpoint.current = 'http://127.0.0.1:8787'
    answer = 'ok'
    at(CADENCE_MS + 60_000)
    instance.refreshGatewayHealthInBackground()
    await settle()

    expect(probes).toEqual(['https://cloud.freecodego.example', 'http://127.0.0.1:8787'])
    expect(events).toEqual(['llm/adapters-updated'])

    // Switching back does not re-ask straight away: that backend's verdict is
    // still fresh, and a verdict is remembered per endpoint rather than being
    // forgotten whenever some other endpoint answers.
    endpoint.current = 'https://cloud.freecodego.example'
    at(2 * CADENCE_MS + 120_000)
    instance.refreshGatewayHealthInBackground()
    await settle()
    expect(probes.length).toBe(2)
  })

  it('lets a missing-route verdict expire', async () => {
    const instance = catalogs()
    answer = '404'
    instance.refreshGatewayHealthInBackground()
    await settle()

    // A route that does not exist will not appear within the hour either, but a
    // 404 can also be a proxy or a deploy in flight — so the verdict is not
    // allowed to outlive the session on the strength of one response.
    at(UNSUPPORTED_MS + 60_000)
    answer = 'ok'
    instance.refreshGatewayHealthInBackground()
    await settle()

    expect(probes.length).toBe(2)
    expect(events).toEqual(['llm/adapters-updated'])
  })

  it('re-probes the same backend after a fresh login', async () => {
    const instance = catalogs()
    answer = '404'
    instance.refreshGatewayHealthInBackground()
    await settle()

    // What logout does: drop the monitors so the next session re-probes.
    instance.invalidateGatewayHealth()
    at(CADENCE_MS + 60_000)
    answer = 'ok'
    instance.refreshGatewayHealthInBackground()
    await settle()

    expect(probes.length).toBe(2)
    expect(events).toEqual(['llm/adapters-updated'])
  })

  it('treats a temporary failure as temporary', async () => {
    const instance = catalogs()
    answer = '500'
    instance.refreshGatewayHealthInBackground()
    await settle()
    expect(probes.length).toBe(1)

    // A 500 says nothing about whether the route exists, so the next cadence
    // asks again instead of concluding that this backend cannot answer.
    at(CADENCE_MS + 60_000)
    answer = 'ok'
    instance.refreshGatewayHealthInBackground()
    await settle()
    expect(probes.length).toBe(2)
  })

  it('never probes while signed out', async () => {
    const instance = catalogs()
    authenticated = false
    instance.refreshGatewayHealthInBackground()
    await settle()
    expect(probes).toEqual([])
  })
})
