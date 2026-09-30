/**
 * The settings surface's whole view of the free-model integration.
 *
 * These are the things a user can do — read the status, download the runtime,
 * turn the gateway on, turn it off, export the identity, replace it — and they
 * are written as one state machine rather than a pile of independent actions,
 * because the states are what carry the risk:
 *
 * - **Opening the switch starts the buyer first.** The gateway reports open only
 *   once the proxy has answered its model directory, so a model that appears in
 *   the picker is a model that can answer. The alternative ordering advertises a
 *   route during the buyer's multi-second discovery phase, and the user's first
 *   request is the thing that discovers it did not work.
 * - **Closing the switch closes the gate before the process.** A request in
 *   flight then fails with the gateway's own refusal instead of a connection
 *   error, and nothing can route into a buyer that is being torn down.
 * - **Installing creates the identity.** That is the user's own instruction —
 *   the download is the only step they take — and it is safe in this one
 *   direction because the key is generated only when the vault holds none.
 *   {@link readAntSeedIdentity} never writes, so a status read cannot replace a
 *   wallet; and a slot that holds something unreadable is refused rather than
 *   repaired, because the value that will not parse is still a value that may
 *   name a wallet.
 * - **Replacing the identity stops the runtime first, and validates the new key
 *   before it touches anything.** The old address is a wallet, so the one gesture
 *   here that can strand a deposit is also the one that must not fail halfway:
 *   an unusable key is refused while nothing has moved, and a running child —
 *   which holds the old key in its environment — is taken down with the switch
 *   before the vault is written.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/antseed-remotes
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { AntSeedGateway } from './antseed/gateway.ts'
import {
  ANTSEED_IDENTITY_REF,
  antSeedIdentityFromPrivateKeyHex,
  generateAntSeedIdentity,
  type AntSeedIdentity,
} from './antseed/identity.ts'
import { ANTSEED_STATUS_TIMEOUT_MS, readAntSeedCatalog, type AntSeedModelRow } from './antseed/provider.ts'
import type { AntSeedRuntimeStatus } from './antseed/buyer-runtime.ts'
import type { FreeCodeGoAntSeedStatus } from './types.ts'

/**
 * The runtime operations these remotes use.
 *
 * Narrower than the manager class, whose install root and injected bindings are
 * its own business here — these four transitions are the whole of what a
 * settings card can ask for.
 */
export interface AntSeedRuntimeHandle {
  /** Report the install and process state without changing either. */
  status(): AntSeedRuntimeStatus
  /** Fetch and install the pinned runtime package. */
  install(): Promise<AntSeedRuntimeStatus>
  /** Start the buyer for one identity. */
  start(identityHex: string): Promise<void>
  /** Stop the buyer. */
  stop(): Promise<void>
  /** Wait until the proxy answers its model directory. */
  waitUntilReady(signal?: AbortSignal): Promise<readonly AntSeedModelRow[]>
}

/**
 * The credential operations these remotes use.
 *
 * Narrower than the vault's own interface on purpose: this module reads and
 * writes exactly one slot, and saying so keeps a spec from having to stand in
 * for the whole vault to exercise an identity write.
 */
export interface AntSeedCredentialStore {
  /** Read the value stored at a reference, when one is stored. */
  resolve(ref: CredentialRef): Promise<{ readonly value?: string | undefined } | undefined>
  /** Store a value at a reference. */
  set(ref: CredentialRef, value: string): Promise<unknown>
}

/**
 * Narrow view of the plugin surface these remotes reach their services through.
 */
export interface AntSeedRemotesHost {
  /** The Host credential vault; absent before it mounts, which refuses the write. */
  readonly credentials: AntSeedCredentialStore | undefined
  /** The managed buyer runtime, built on first use so construction touches no disk. */
  readonly runtime: () => AntSeedRuntimeHandle
  /** Session-scoped gateway switch, owned by the plugin. */
  readonly gateway: AntSeedGateway
  /** Announce that the model routes changed, after any transition that changes them. */
  readonly refreshRoutes: () => void
}

/**
 * What the identity slot holds, as the three states a reader has to tell apart.
 *
 * Two states would do for a status read — `none` and `unreadable` both mean
 * "there is no identity to use" — and they are opposites for the one decision
 * that matters here: an empty slot is where a generated key belongs, while a
 * slot holding something that will not parse is a value that may name a wallet,
 * and writing over it would be replacing a key nobody asked to replace.
 */
type StoredIdentityState =
  | { readonly kind: 'identity'; readonly identity: AntSeedIdentity }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable' }

/**
 * Read the identity slot as the state it is in.
 *
 * Never writes, and never guesses: a value that is there and does not parse is
 * reported as such rather than as absent, so the callers that must not overwrite
 * it can refuse instead.
 * @param host - the Host surface holding the vault.
 * @returns the state the slot is in.
 */
async function readStoredIdentity(host: AntSeedRemotesHost): Promise<StoredIdentityState> {
  const stored = await host.credentials?.resolve(ANTSEED_IDENTITY_REF)
  const value = stored?.value?.trim() ?? ''
  if (value === '') return { kind: 'none' }
  try {
    return { kind: 'identity', identity: antSeedIdentityFromPrivateKeyHex(value) }
  } catch {
    return { kind: 'unreadable' }
  }
}

/**
 * Read the stored identity without creating one.
 *
 * A stored value that does not parse is reported as absent rather than replaced:
 * the vault holds something that names a wallet, and a resolver that overwrote
 * it would destroy the balance behind it. The read is therefore lossy on
 * purpose, and the callers that must not act on the lossy answer — the ones that
 * would otherwise create a key — go through
 * {@link ensureAntSeedIdentity}, which refuses instead.
 * @param host - the Host surface holding the vault.
 * @returns the stored identity, or `undefined` when there is none to read.
 */
export async function readAntSeedIdentity(host: AntSeedRemotesHost): Promise<AntSeedIdentity | undefined> {
  const state = await readStoredIdentity(host)
  return state.kind === 'identity' ? state.identity : undefined
}

/**
 * Read the stored identity, creating and storing one only when the vault is empty.
 *
 * Called from {@link antSeedInstall} and {@link antSeedSetGateway}: the two
 * places the user asked for an identity to exist. A key is generated once and
 * never rotated, because the address it names is the wallet the user's deposits
 * are tied to — so there are two ways this function does nothing but read: an
 * identity that parses is handed straight back, and a slot that holds something
 * that does not parse is **refused** rather than repaired. Generating a key
 * there would swap the wallet out from under the user and report it as a fresh
 * identity; replacing one is a deliberate gesture of its own
 * ({@link antSeedSetIdentity} and {@link antSeedGenerateIdentity}), and this is
 * not it.
 * @param host - the Host surface holding the vault.
 * @returns the identity, whether it already existed or was just created.
 * @throws when the vault holds a value that cannot be read, or is not mounted at all — since a generated key that cannot be stored is a lost key.
 */
export async function ensureAntSeedIdentity(host: AntSeedRemotesHost): Promise<AntSeedIdentity> {
  const state = await readStoredIdentity(host)
  if (state.kind === 'identity') return state.identity
  if (state.kind === 'unreadable') {
    throw new Error(
      'KEY_GATEWAY_IDENTITY_UNREADABLE: the stored private key cannot be read, so the gateway cannot sign with it. '
      + 'Replace it with the key this address belongs to, or generate a new one; a new key is never written over a stored value on its own.',
    )
  }
  const credentials = host.credentials
  if (credentials === undefined) throw new Error('the credentials service is not mounted, so an identity cannot be stored')
  const created = generateAntSeedIdentity()
  await credentials.set(ANTSEED_IDENTITY_REF, created.privateKeyHex)
  return created
}

/**
 * Hand the stored private key back for an explicit export gesture.
 *
 * Deliberately not part of {@link antSeedStatus}: the key is the wallet the
 * user's deposits are tied to, so it is read only when a user clicks export and
 * never rides along with the status every settings render asks for. The caller
 * is expected to put it behind a deliberate reveal, not on the card face.
 * @param host - the Host surface holding the vault.
 * @returns the stored private key, hex encoded, without the `0x` prefix.
 * @throws when no identity is stored, since an export of nothing would look like a wiped wallet.
 */
export async function antSeedRevealIdentity(
  host: AntSeedRemotesHost,
): Promise<{ readonly privateKeyHex: string; readonly peerId: string }> {
  const identity = await readAntSeedIdentity(host)
  if (identity === undefined) throw new Error('KEY_GATEWAY_IDENTITY_MISSING: no identity is stored, so there is nothing to export')
  return { privateKeyHex: identity.privateKeyHex, peerId: identity.peerId }
}

/**
 * Store a key the user supplies in place of the stored one.
 *
 * Replacing an identity is destructive in a way no other gesture here is: the
 * address the old key named is the wallet a deposit was bound to, so the old one
 * is not reachable through this runtime once the new one is stored. That is why
 * the key is validated first — a mistyped paste must not disturb a runtime that
 * is working — and why the card asks for the gesture to be confirmed rather than
 * performing it on the first click.
 * @param host - the Host surface holding the runtime, switch, and vault.
 * @param privateKeyHex - the key to store, 32 bytes written as 64 hexadecimal characters, with an optional `0x` prefix.
 * @returns the status after the replacement, carrying the new peer id.
 * @throws when the value is not a usable private key, or the vault is not mounted.
 */
export async function antSeedSetIdentity(host: AntSeedRemotesHost, privateKeyHex: string): Promise<FreeCodeGoAntSeedStatus> {
  return await replaceAntSeedIdentity(host, () => antSeedIdentityFromPrivateKeyHex(privateKeyHex))
}

/**
 * Store a freshly generated key in place of the stored one.
 *
 * The same destructive gesture as {@link antSeedSetIdentity}, for a user with no
 * key to paste. It exists because the alternative is not "they do it themselves"
 * but "they cannot": a browser cannot derive a secp256k1 key, and a key typed in
 * from a dice-roll is a key that is wrong more often than it is useful.
 * @param host - the Host surface holding the runtime, switch, and vault.
 * @returns the status after the replacement, carrying the new peer id.
 * @throws when the vault is not mounted.
 */
export async function antSeedGenerateIdentity(host: AntSeedRemotesHost): Promise<FreeCodeGoAntSeedStatus> {
  return await replaceAntSeedIdentity(host, generateAntSeedIdentity)
}

/**
 * Store a different identity, stopping whatever is still using the old one.
 *
 * One implementation for both replacement gestures, because everything that
 * makes the gesture safe is shared and would otherwise be written twice: the
 * identity is built — and so validated — before anything is touched, the switch
 * is closed with the process it belongs to, and only the vault is written to.
 * The routes are re-announced because the identity is what the runtime signs
 * with from its next start, and a status read afterwards is what tells the
 * caller the new peer id rather than the old one.
 * @param host - the Host surface holding the runtime, switch, and vault.
 * @param create - produces the identity to store; throws to refuse the gesture.
 * @returns the status after the replacement.
 * @throws when the vault is not mounted, or `create` refuses the value.
 */
async function replaceAntSeedIdentity(host: AntSeedRemotesHost, create: () => AntSeedIdentity): Promise<FreeCodeGoAntSeedStatus> {
  const identity = create()
  const credentials = host.credentials
  if (credentials === undefined) throw new Error('the credentials service is not mounted, so an identity cannot be stored')
  const runtime = host.runtime()
  if (runtime.status().running) {
    // The child was handed the old key in its environment, so it is stopped
    // rather than left signing as a key the vault no longer holds. The switch
    // goes with it, the same ordering `antSeedInstall` uses and for the same
    // reason: the process that made the switch meaningful is being taken away.
    host.gateway.disable()
    await runtime.stop()
  }
  await credentials.set(ANTSEED_IDENTITY_REF, identity.privateKeyHex)
  host.refreshRoutes()
  return antSeedStatus(host)
}

/**
 * Report the integration's state.
 *
 * The model list is read only while the gateway is open: a closed gateway has no
 * listener behind it, and probing the port anyway would turn a switch the user
 * turned off into a stream of failed connections. The list is empty in that
 * case, which is also what the card shows.
 *
 * The rows that survive the read are the free ones; the rest are reported as a
 * count instead. The network advertises paid models under the same directory,
 * and two facts are worth telling apart on a page whose whole promise is "free":
 * a node that has found nothing yet, and a node looking at a network where
 * nothing is free.
 * @param host - the Host surface holding the runtime and switch.
 * @returns the browser-safe status.
 */
export async function antSeedStatus(host: AntSeedRemotesHost): Promise<FreeCodeGoAntSeedStatus> {
  const runtime = host.runtime()
  const runtimeState = runtime.status()
  const gatewayEnabled = host.gateway.status().enabled
  const identityState = await readStoredIdentity(host)
  const identity = identityState.kind === 'identity' ? identityState.identity : undefined
  const catalog = gatewayEnabled && runtimeState.running
    ? await readAntSeedCatalog({ port: runtimeState.port, timeoutMs: ANTSEED_STATUS_TIMEOUT_MS })
    : { models: [], paid: 0 }
  return {
    installed: runtimeState.installed,
    running: runtimeState.running,
    gatewayEnabled,
    hasIdentity: identity !== undefined,
    ...(identityState.kind === 'unreadable' ? { identityUnreadable: true } : {}),
    ...(identity === undefined ? {} : { peerId: identity.peerId }),
    port: runtimeState.port,
    version: runtimeState.version,
    models: catalog.models.map(row => ({ id: row.id, name: row.name, kind: row.kind })),
    paidModels: catalog.paid,
    ...(runtimeState.reason === undefined ? {} : { reason: runtimeState.reason }),
  }
}

/**
 * Download the runtime and create the identity, in that order.
 *
 * The identity is written only after a completed install: a key created for a
 * runtime that failed to download is a wallet the user was told about by a
 * button that did not work.
 * @param host - the Host surface holding the runtime.
 * @returns the status once the install finished.
 */
export async function antSeedInstall(host: AntSeedRemotesHost): Promise<FreeCodeGoAntSeedStatus> {
  const runtime = host.runtime()
  // Installing again replaces the tree a live buyer is running out of, and on
  // Windows npm cannot overwrite files a running process holds open. The switch
  // is closed first, so the download always happens against a quiet directory —
  // and the status the caller gets back says the gateway is shut, because the
  // buyer that made it meaningful is the thing being replaced.
  if (runtime.status().running) {
    host.gateway.disable()
    await runtime.stop()
  }
  await runtime.install()
  await ensureAntSeedIdentity(host)
  host.refreshRoutes()
  return antSeedStatus(host)
}

/**
 * Open or close the gateway for this session.
 *
 * Opening starts the buyer and waits for its model directory before the switch
 * reports open; closing takes the switch down first and then the process.
 * @param host - the Host surface holding the runtime and switch.
 * @param enabled - `true` to open, `false` to close.
 * @returns the status after the transition.
 */
export async function antSeedSetGateway(host: AntSeedRemotesHost, enabled: boolean): Promise<FreeCodeGoAntSeedStatus> {
  const runtime = host.runtime()
  if (!enabled) {
    host.gateway.disable()
    await runtime.stop()
    host.refreshRoutes()
    return antSeedStatus(host)
  }

  const state = runtime.status()
  if (!state.installed) throw new Error('KEY_GATEWAY_RUNTIME_NOT_INSTALLED: download the runtime before turning its gateway on')
  const identity = await ensureAntSeedIdentity(host)
  await runtime.start(identity.privateKeyHex)
  try {
    await runtime.waitUntilReady()
  } catch (error) {
    // A buyer that never answered must not be left running behind a switch that
    // reports closed: the user would have a process holding a port and no way to
    // see it. Tear it down here, so the failed transition is a complete one.
    await runtime.stop()
    throw error
  }
  host.gateway.enable()
  host.refreshRoutes()
  return antSeedStatus(host)
}
