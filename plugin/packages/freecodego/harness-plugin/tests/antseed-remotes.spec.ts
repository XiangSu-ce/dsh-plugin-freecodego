import { describe, expect, it, vi } from 'vitest'
import {
  antSeedGenerateIdentity,
  antSeedInstall,
  antSeedRevealIdentity,
  antSeedSetGateway,
  antSeedSetIdentity,
  antSeedStatus,
  ensureAntSeedIdentity,
  readAntSeedIdentity,
  type AntSeedCredentialStore,
  type AntSeedRemotesHost,
  type AntSeedRuntimeHandle,
} from '../src/antseed-remotes.ts'
import { AntSeedGateway } from '../src/antseed/gateway.ts'
import { antSeedIdentityFromPrivateKeyHex } from '../src/antseed/identity.ts'

const STORED_KEY = '0'.repeat(63) + '1'
const STORED_PEER = '7e5f4552091a69125d5dfcb7b8c2659029395bdf'
/** A second usable private key, for the gestures that replace the first one. */
const IMPORTED_KEY = '0'.repeat(62) + '02'

/** The price shapes the network advertises, one per case this suite needs. */
const freeTokens = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
const paidTokens = { inputUsdPerMillion: 4.5, outputUsdPerMillion: 22.5 }
const zeroImage = { inputUsdPerMillion: 0, outputUsdPerMillion: 0, minImageUsdPerImage: 0, maxImageUsdPerImage: 0 }
const perPicture = { inputUsdPerMillion: 0, outputUsdPerMillion: 0, minImageUsdPerImage: 0.05, maxImageUsdPerImage: 0.05 }

/** One `/v1/models` entry offering the model at one price. */
function modelAt(id: string, price: Record<string, number>): Record<string, unknown> {
  return { id, peers: [price] }
}

/** A credential store holding at most one value, with the writes it saw. */
function vault(seed?: string): AntSeedCredentialStore & { readonly value: () => string | undefined; readonly writes: readonly string[] } {
  let held = seed
  const writes: string[] = []
  return {
    resolve: async () => (held === undefined ? undefined : { value: held }),
    set: async (_ref, value) => { held = value; writes.push(value) },
    value: () => held,
    writes,
  }
}

interface Harness {
  readonly host: AntSeedRemotesHost
  readonly gateway: AntSeedGateway
  /** The vault behind the host, so a test can assert exactly what was stored. */
  readonly credentials: AntSeedCredentialStore & { readonly value: () => string | undefined }
  readonly calls: string[]
  readonly refreshes: () => number
  readonly setInstalled: (value: boolean) => void
}

/** A runtime standing in for the real one, recording the order of calls. */
function harness(options: {
  readonly installed?: boolean
  readonly ready?: boolean
  readonly seed?: string
  readonly reason?: string
} = {}): Harness {
  const calls: string[] = []
  let installed = options.installed ?? true
  let refreshes = 0
  let running = false
  const runtime: AntSeedRuntimeHandle = {
    status: () => ({
      installed,
      running,
      port: 8390,
      version: '0.1.165',
      rootDirectory: '/tmp/key-gateway',
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    }),
    install: async () => { calls.push('install'); installed = true; return runtime.status() },
    start: async () => { calls.push('start'); running = true },
    stop: async () => { calls.push('stop'); running = false },
    waitUntilReady: async () => {
      calls.push('waitUntilReady')
      if (options.ready === false) throw new Error('buyer did not answer')
      return []
    },
  }
  const gateway = new AntSeedGateway()
  const credentials = vault(options.seed)
  // The model read is only reached while the gateway is open and the buyer runs,
  // and it is the one path this spec does not need to exercise.
  const host: AntSeedRemotesHost = {
    credentials,
    runtime: () => runtime,
    gateway,
    refreshRoutes: () => { refreshes += 1 },
  }
  return { host, gateway, credentials, calls, refreshes: () => refreshes, setInstalled: (value: boolean) => { installed = value } }
}

describe('AntSeed remotes', () => {
  describe('identity', () => {
    it('reads a stored key without writing anything', async () => {
      const { host } = harness({ seed: STORED_KEY })
      await expect(readAntSeedIdentity(host)).resolves.toEqual({ privateKeyHex: STORED_KEY, peerId: STORED_PEER })
    })

    it('reports a vault holding something unusable as absent rather than replacing it', async () => {
      // The vault holds a value that names a wallet. Overwriting it here would
      // destroy the deposits behind it, so the read reports nothing and the
      // user is the one who decides what to do about it.
      const credentials = vault('not-a-key')
      const { host } = harness()
      await expect(readAntSeedIdentity({ ...host, credentials })).resolves.toBeUndefined()
      expect(credentials.value()).toBe('not-a-key')
      expect(credentials.writes).toEqual([])
    })

    it('refuses to invent a key over a stored value it cannot read', async () => {
      // The slot holds something that may name a wallet. Generating a key there
      // would hand the user a different address and report it as a new identity,
      // so the state is refused instead: replacing an identity is a gesture of
      // its own, and this path is not it. Nothing is written on the way out.
      const credentials = vault('not-a-key')
      const { host } = harness()
      await expect(ensureAntSeedIdentity({ ...host, credentials })).rejects.toThrow('KEY_GATEWAY_IDENTITY_UNREADABLE')
      expect(credentials.value()).toBe('not-a-key')
      expect(credentials.writes).toEqual([])
    })

    it('refuses to open the gateway over a key it cannot read, and writes nothing', async () => {
      // The reachable path to that refusal: a card whose identity slot is
      // unreadable. Opening has to fail loudly rather than start a buyer that
      // would sign with a key the plugin never read.
      const credentials = vault('not-a-key')
      const { host, calls } = harness()
      await expect(antSeedSetGateway({ ...host, credentials }, true)).rejects.toThrow('KEY_GATEWAY_IDENTITY_UNREADABLE')
      expect(calls).toEqual([])
      expect(credentials.writes).toEqual([])
    })

    it('reports an unreadable slot as a state of its own, so the card can offer the repair', async () => {
      // `hasIdentity: false` alone would read as "no identity yet" — and the card
      // hides the replace gesture in that state, leaving a user with a value the
      // vault cannot parse no way to fix it from the page.
      const credentials = vault('not-a-key')
      const { host } = harness()
      const status = await antSeedStatus({ ...host, credentials })
      expect(status).toMatchObject({ hasIdentity: false, identityUnreadable: true })
      expect(status.peerId).toBeUndefined()
      // An empty slot is the ordinary "never created one" reading, and carries no flag.
      expect(await antSeedStatus(harness().host)).toMatchObject({ hasIdentity: false })
      expect((await antSeedStatus(harness().host)).identityUnreadable).toBeUndefined()
    })

    it('creates one key and keeps it afterwards', async () => {
      const { host } = harness()
      const created = await ensureAntSeedIdentity(host)
      expect(created.privateKeyHex).toMatch(/^[0-9a-f]{64}$/u)
      const again = await ensureAntSeedIdentity(host)
      // Generated once, never rotated: this address is the wallet.
      expect(again.privateKeyHex).toBe(created.privateKeyHex)
    })

    it('refuses to generate a key it cannot store', async () => {
      const { host } = harness()
      await expect(ensureAntSeedIdentity({ ...host, credentials: undefined }))
        .rejects.toThrow('the credentials service is not mounted')
    })
  })

  describe('export', () => {
    it('hands back the stored key only when asked', async () => {
      // The status is read on every settings render; the key is read on one
      // click. This asserts the two are different reads.
      const { host } = harness({ seed: STORED_KEY })
      const status = await antSeedStatus(host)
      expect(status.peerId).toBe(STORED_PEER)
      expect(Object.keys(status)).not.toContain('privateKeyHex')
      await expect(antSeedRevealIdentity(host)).resolves.toEqual({ privateKeyHex: STORED_KEY, peerId: STORED_PEER })
    })

    it('refuses to export an identity that does not exist', async () => {
      // An empty export would read as a wallet that was wiped rather than one
      // that was never created, so it is an error and not an empty string.
      const { host } = harness()
      await expect(antSeedRevealIdentity(host)).rejects.toThrow('KEY_GATEWAY_IDENTITY_MISSING')
    })
  })

  describe('replacement', () => {
    it('stores a key the user supplies, normalized, and reports the address it names', async () => {
      const { host, credentials, calls, refreshes } = harness({ seed: STORED_KEY })
      const status = await antSeedSetIdentity(host, `0x${IMPORTED_KEY}`)

      // The `0x` spelling is accepted and stored without it: the vault holds one
      // spelling of a key, so two readers cannot disagree about which it is.
      expect(credentials.value()).toBe(IMPORTED_KEY)
      expect(status.peerId).toBe(antSeedIdentityFromPrivateKeyHex(IMPORTED_KEY).peerId)
      expect(status.peerId).not.toBe(STORED_PEER)
      // Nothing was running, so nothing had to be stopped — and the routes are
      // re-announced for the identity the runtime will sign with next.
      expect(calls).toEqual([])
      expect(refreshes()).toBe(1)
    })

    it('refuses a key it cannot use without disturbing a runtime that is working', async () => {
      // Validation happens before anything is touched: the one gesture here that
      // can strand a deposit is the one that must not fail halfway, and a typo
      // must not cost the user a running runtime.
      const { host, gateway, credentials, calls } = harness({ seed: STORED_KEY })
      await antSeedSetGateway(host, true)
      const before = [...calls]

      await expect(antSeedSetIdentity(host, 'not-a-key')).rejects.toThrow('The private key must be 32 bytes (64 hexadecimal characters)')
      await expect(antSeedSetIdentity(host, 'f'.repeat(64))).rejects.toThrow('outside the secp256k1 range')

      expect(calls).toEqual(before)
      expect(gateway.status().enabled).toBe(true)
      expect(credentials.value()).toBe(STORED_KEY)
    })

    it('stops the runtime and closes the switch before the vault is written', async () => {
      // The child holds the old key in its environment, so a live process would
      // go on signing as an identity the vault no longer holds. Taking it down
      // is the same ordering install uses, and for the same reason.
      const { host, gateway, credentials, calls } = harness({ seed: STORED_KEY })
      await antSeedSetGateway(host, true)

      const status = await antSeedSetIdentity(host, IMPORTED_KEY)

      expect(calls.slice(-1)).toEqual(['stop'])
      expect(gateway.status().enabled).toBe(false)
      expect(status.gatewayEnabled).toBe(false)
      expect(status.running).toBe(false)
      expect(credentials.value()).toBe(IMPORTED_KEY)
    })

    it('generates a key for a user who has none to paste', async () => {
      // A browser cannot derive a secp256k1 key, so without this the only way to
      // replace an identity would be to acquire one somewhere else first.
      const { host, credentials } = harness({ seed: STORED_KEY })
      const status = await antSeedGenerateIdentity(host)
      const stored = credentials.value() ?? ''

      expect(stored).toMatch(/^[0-9a-f]{64}$/u)
      expect(stored).not.toBe(STORED_KEY)
      expect(status.peerId).toBe(antSeedIdentityFromPrivateKeyHex(stored).peerId)
      expect(status.hasIdentity).toBe(true)
    })

    it('refuses to replace an identity it cannot store', async () => {
      const { host } = harness({ seed: STORED_KEY })
      await expect(antSeedSetIdentity({ ...host, credentials: undefined }, IMPORTED_KEY))
        .rejects.toThrow('the credentials service is not mounted')
    })
  })

  describe('status', () => {
    it('reports the switch and identity without creating either', async () => {
      const { host } = harness({ installed: false })
      const status = await antSeedStatus(host)
      expect(status).toMatchObject({ installed: false, running: false, gatewayEnabled: false, hasIdentity: false, port: 8390 })
      expect(status.reason).toBeUndefined()
      expect(typeof host.credentials?.resolve).toBe('function')
    })

    it('carries the public address once a key is stored', async () => {
      const { host } = harness({ seed: STORED_KEY })
      expect((await antSeedStatus(host)).peerId).toBe(STORED_PEER)
    })

    it('lists the rows the buyer serves, and carries the reason it cannot run', async () => {
      // The two facts the card draws that only exist while the gateway is open:
      // the roster the proxy answers with, and the buyer's own reason when it has
      // one. Both are read here rather than assumed from the empty case above.
      const { host, gateway } = harness({ reason: 'KEY_GATEWAY_RUNTIME_INCOMPLETE' })
      // Typed as the URL string the directory read actually sends, so the stub
      // never has to stringify a `Request` built from something else.
      const read = vi.fn(async (input: string) => new Response(JSON.stringify(
        input.includes('images') ? { data: [modelAt('flux-2-pro', zeroImage)] } : { data: [modelAt('deepseek-v4-flash', freeTokens)] },
      ), { status: 200 }))
      vi.stubGlobal('fetch', read)
      try {
        await host.runtime().start('ab'.repeat(32))
        gateway.enable()
        const status = await antSeedStatus(host)
        expect(status.models).toEqual([
          { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', kind: 'text' },
          { id: 'flux-2-pro', name: 'flux-2-pro', kind: 'images' },
        ])
        expect(status.paidModels).toBe(0)
        expect(status.reason).toBe('KEY_GATEWAY_RUNTIME_INCOMPLETE')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('keeps the priced rows out of the roster and counts them instead', async () => {
      // The card's roster is a promise that a model costs nothing, so the rows
      // the network prices are not in it. Their count is, because it is what
      // separates "nothing found yet" from "nothing on this network is free".
      const { host, gateway } = harness()
      const read = vi.fn(async (input: string) => new Response(JSON.stringify(
        input.includes('images')
          ? { data: [modelAt('nano-banana-2', perPicture)] }
          : { data: [modelAt('glm-5.3-flash', freeTokens), modelAt('claude-opus-4.8', paidTokens)] },
      ), { status: 200 }))
      vi.stubGlobal('fetch', read)
      try {
        await host.runtime().start('ab'.repeat(32))
        gateway.enable()
        const status = await antSeedStatus(host)
        expect(status.models).toEqual([{ id: 'glm-5.3-flash', name: 'glm-5.3-flash', kind: 'text' }])
        expect(status.paidModels).toBe(2)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('leaves the model list empty while the gateway is closed', async () => {
      // A closed gateway has no listener behind it, so probing the port would
      // turn a switch the user turned off into a stream of failed connections.
      const { host } = harness()
      expect((await antSeedStatus(host)).models).toEqual([])
      expect((await antSeedStatus(host)).paidModels).toBe(0)
    })
  })

  describe('install', () => {
    it('downloads before it creates the identity', async () => {
      const { host, calls } = harness({ installed: false })
      const status = await antSeedInstall(host)
      expect(calls).toEqual(['install'])
      // A key created for a runtime that failed to download is a wallet the user
      // was told about by a button that did not work.
      expect(status.hasIdentity).toBe(true)
      expect(status.peerId).toMatch(/^[0-9a-f]{40}$/u)
    })

    it('closes the switch and stops the buyer before replacing its tree', async () => {
      // A live buyer is running out of the directory the next install overwrites,
      // which is what Windows refuses. The order is asserted rather than assumed.
      const { host, gateway, calls } = harness({ seed: STORED_KEY })
      await host.runtime().start('ab'.repeat(32))
      gateway.enable()

      const status = await antSeedInstall(host)

      expect(calls).toEqual(['start', 'stop', 'install'])
      expect(status.gatewayEnabled).toBe(false)
      expect(status.running).toBe(false)
    })

    it('announces the routes it changed', async () => {
      const { host, refreshes } = harness({ installed: false })
      await antSeedInstall(host)
      expect(refreshes()).toBe(1)
    })
  })

  describe('gateway switch', () => {
    it('starts the buyer and waits for the directory before reporting open', async () => {
      const { host, gateway, calls } = harness()
      const status = await antSeedSetGateway(host, true)
      // The order is the point: a route advertised before the buyer answers is a
      // route whose first request discovers it does not work.
      expect(calls).toEqual(['start', 'waitUntilReady'])
      expect(status.gatewayEnabled).toBe(true)
      expect(gateway.status().enabled).toBe(true)
    })

    it('refuses to open before the runtime is downloaded', async () => {
      const { host, calls } = harness({ installed: false })
      await expect(antSeedSetGateway(host, true)).rejects.toThrow('download the runtime')
      expect(calls).toEqual([])
    })

    it('leaves no buyer running when it never became ready', async () => {
      const { host, gateway, calls } = harness({ ready: false })
      await expect(antSeedSetGateway(host, true)).rejects.toThrow('buyer did not answer')
      // A process holding a port behind a switch that reports closed is invisible
      // state, so a failed transition has to be a complete one.
      expect(calls).toEqual(['start', 'waitUntilReady', 'stop'])
      expect(gateway.status().enabled).toBe(false)
    })

    it('closes the gate before it stops the process', async () => {
      const { host, gateway, calls } = harness()
      await antSeedSetGateway(host, true)
      calls.length = 0
      const status = await antSeedSetGateway(host, false)
      expect(calls).toEqual(['stop'])
      // A request in flight then fails with the gateway's own refusal instead of
      // a connection error, and nothing can route into a buyer being torn down.
      expect(status.gatewayEnabled).toBe(false)
      expect(gateway.status().enabled).toBe(false)
    })

    it('announces the routes on both transitions', async () => {
      const { host, refreshes } = harness()
      await antSeedSetGateway(host, true)
      await antSeedSetGateway(host, false)
      expect(refreshes()).toBe(2)
    })

    it('closes cleanly even when nothing was running', async () => {
      const { host } = harness()
      await expect(antSeedSetGateway(host, false)).resolves.toMatchObject({ gatewayEnabled: false })
    })
  })
})
