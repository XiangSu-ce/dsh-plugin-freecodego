/**
 * The idle deadline, re-exported from the package that now owns it.
 *
 * The implementation moved to `@deepseek-ai/dsh-freecodego-native-runtime-protocol`
 * because the in-process Claude SDK session needs the same decision and cannot
 * reach this package: `runtime-claude` is a dependency *of* the plugin, so an
 * import in that direction would be a cycle. The narrative — why the deadline is
 * idle rather than absolute, why a timeout is not a cancellation, and why the
 * upstream is released without being awaited — travels with it.
 *
 * These two names stay exported from here so this package's provider bridge and
 * `provider-error-classify.ts` keep deciding on the *same* class, which is what
 * makes the `instanceof` between them meaningful.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/stream-deadline
 */

export { StreamIdleTimeoutError, withIdleDeadline } from '@deepseek-ai/dsh-freecodego-native-runtime-protocol'
