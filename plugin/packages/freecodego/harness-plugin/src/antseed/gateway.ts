/**
 * The private-key gateway switch.
 *
 * Why this switch is not persisted
 * -------------------------------
 * Every other switch in this plugin is a stored setting. This one is
 * deliberately not, and that is the whole feature: turning it on starts a
 * process that opens outbound peer-to-peer connections and, on a paid route,
 * signs authorizations against the user's wallet. It stays closed until the
 * user opens it, and a Harness restart closes it again.
 *
 * The state lives in one field and this module owns no storage handle, so
 * "not persisted" is a property of the code rather than of a missing write
 * somewhere else. The spec asserts a fresh instance is off, which is exactly
 * the restart behaviour.
 *
 * The switch owns no process. Enabling it while the buyer runtime is stopped
 * reports `running: false` and the caller starts the runtime; disabling it is
 * paired with `runtime.stop()` by the caller, because this module must stay
 * testable without spawning anything.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/antseed/gateway
 */

/** State of the private-key gateway switch. */
export interface AntSeedGatewayStatus {
  /** Whether requests may be routed to the local buyer. */
  readonly enabled: boolean
  /**
   * Why the gateway is closed, when it is closed. Absent while it is open, so
   * a surface renders the switch and this line from one value.
   */
  readonly closedReason?: string
}

/** The reason reported while the user has not opened the gateway. */
const CLOSED_BY_USER = 'KEY_GATEWAY_CLOSED'

/** Session-scoped gate in front of the local buyer route. */
export class AntSeedGateway {
  /**
   * Never read from or written to storage. Kept private so the only way to
   * change it is the two named transitions below, which is what makes the
   * restart semantics assertable.
   */
  private open = false

  /**
   * Open the gateway for this session.
   * @returns the state after the transition.
   */
  enable(): AntSeedGatewayStatus {
    this.open = true
    return this.status()
  }

  /**
   * Close the gateway for this session.
   * @returns the state after the transition.
   */
  disable(): AntSeedGatewayStatus {
    this.open = false
    return this.status()
  }

  /**
   * Report the current state.
   * @returns whether the gateway is open, and the reason it is closed when it is.
   */
  status(): AntSeedGatewayStatus {
    return this.open ? { enabled: true } : { enabled: false, closedReason: CLOSED_BY_USER }
  }

  /**
   * Refuse a request unless the user has opened the gateway.
   *
   * Called at the model-routing seam rather than trusted from the model picker:
   * a picker that hides the rows is presentation, and the route has to be
   * unavailable even when a stored session asks for it by name.
   */
  assertOpen(): void {
    if (!this.open) throw new Error('KEY_GATEWAY_CLOSED: turn on the private-key gateway in Settings before using its models')
  }
}
