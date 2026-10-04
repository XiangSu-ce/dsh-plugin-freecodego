/**
 * Registering a *set* of tools, and letting one go.
 *
 * Why this is a module rather than a loop written where it is needed
 * -----------------------------------------------------------------
 * Every tool registry in this plugin registers several definitions at once, and
 * the interesting case is the one that does not happen on a good day: the
 * registry refuses one of them. A batch spelled as `definitions.map(tool =>
 * tools.register(tool))` fails in two ways at once when that happens — the throw
 * aborts the batch, so every definition *after* the refusal is never even
 * attempted, and the handles of the definitions that *did* register are lost with
 * the thrown stack frame, so the effect that was going to dispose them is never
 * registered and those tools outlive the plugin that owns them.
 *
 * The right shape is the one the single-tool call sites already use: register one
 * at a time, keep every handle, and let a refusal be the one thing it is — one
 * tool missing, named in a log — rather than the batch's death. This module is
 * that shape, written once.
 *
 * @module @deepseek-ai/dsh-freecodego-harness-plugin/tool-registration
 */

import type { ToolDefinitionShape } from './tool-definition.ts'

/**
 * The handle a registration returns, and this module's own teardown handles.
 *
 * `dispose` may be synchronous or promise-returning. A caller may call it without
 * awaiting — a teardown has nowhere to put the wait — so a promise here costs
 * nothing there, while a caller that *can* await it gets the real completion
 * instead of a race. Written as a union rather than as `() => void` because a
 * promise-returning function offered where a `void` return is expected is a
 * defect the linter names, and rightly: the caller in that shape has no way to
 * know whether the work finished.
 */
export type ToolRegistration = (() => void) | { dispose?: () => void | Promise<void> }

/**
 * Run one registration's teardown without letting its promise escape.
 *
 * `dispose` may be synchronous or promise-returning, so the return value is a
 * union and the promise has to be narrowed out before it can be claimed. Claiming
 * it is the point: a teardown that returns a promise and is called for its side
 * effect leaves an unhandled rejection behind when it fails — which would make
 * *standing the pack down* the path that takes the host process with it. Nothing
 * is reported because there is nowhere to report it: the caller has already said
 * the set is not wanted.
 *
 * Shared rather than written twice: the design registry disposes what it mounted,
 * and {@link registerToolDefinitions} uses it the same way. Two spellings of "how
 * a tool goes away" is how one of them ends up not doing it.
 */
export function disposeToolRegistration(registration: ToolRegistration): void {
  if (typeof registration === 'function') {
    registration()
    return
  }
  void Promise.resolve(registration.dispose?.()).catch(() => undefined)
}

/** The registry seam these helpers read; structural so a caller stays independent of it. */
export interface ToolRegistry {
  register(tool: ToolDefinitionShape): ToolRegistration
}

/**
 * An incremental registrar for callers that build definitions as they go.
 *
 * {@link registerToolDefinitions} wants the definitions up front, which is the
 * right shape when they can be collected — but one registry here (`engineering.ts`)
 * interleaves ~30 definitions with setup that has to run between them, so the
 * definitions cannot be hoisted into one array without splitting the method.
 * This is the same containment in that shape: register one at a time, keep every
 * handle, and let `dispose` release them together. A refusal is reported and
 * skipped, and the sites after it still register.
 */
export interface ToolRegistrar {
  /** Register one definition; a refusal is reported through `onFailure` and skipped. */
  register(tool: ToolDefinitionShape): void
  /** Release every registration that succeeded, once. */
  dispose(): void
}

/**
 * Build an {@link ToolRegistrar} over one registry.
 * @param tools - the registry to register into.
 * @param onFailure - called with each refused definition's name and the error.
 * @returns the registrar; call `dispose` to release what it registered.
 */
export function createToolRegistrar(
  tools: ToolRegistry,
  onFailure: (name: string, error: unknown) => void,
): ToolRegistrar {
  const cleanups: (() => void)[] = []
  return {
    register(tool) {
      try {
        const registration = tools.register(tool)
        cleanups.push(() => { disposeToolRegistration(registration) })
      } catch (error) {
        onFailure(tool.name, error)
      }
    },
    dispose() {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
}

/**
 * Register each definition, one at a time, and return the teardown for the whole set.
 *
 * A definition the registry refuses is reported through `onFailure` and skipped;
 * the definitions after it are still attempted and every definition that did
 * register is still disposed by the returned cleanup. That is the difference from
 * the batch form: there, one refusal dropped every later tool *and* leaked the
 * earlier ones, because the map aborted before any handle was kept.
 *
 * @param tools - the registry to register into.
 * @param definitions - the tool definitions, in registration order.
 * @param onFailure - called with the refused definition's name and the error; the
 *   caller logs it, because only the caller knows what the missing tool costs.
 * @returns a teardown that disposes every registration that succeeded.
 */
export function registerToolDefinitions(
  tools: ToolRegistry,
  definitions: readonly ToolDefinitionShape[],
  onFailure: (name: string, error: unknown) => void,
): () => void {
  const registrar = createToolRegistrar(tools, onFailure)
  for (const definition of definitions) registrar.register(definition)
  return () => registrar.dispose()
}
