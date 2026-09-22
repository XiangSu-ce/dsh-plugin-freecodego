import { NativeRootAgentSession } from '@deepseek-ai/dsh-freecodego-root-agent'
import type { NativeAgentSession, NativeRootAgentCreateOptions } from '@deepseek-ai/dsh-freecodego-root-agent'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Codex runtime worker configuration. The artifact path is supplied by a verified manifest. */
export interface CodexWorkerLaunchOptions {
  readonly executable: string
  readonly args?: readonly string[]
  readonly environment?: Readonly<Record<string, string>>
  /** Plugin-owned writable state directory, never the user's global .codex directory. */
  readonly stateDirectory: string
}

/**
 * Launch options for the Codex root runtime, including the package-resolved worker entry.
 */
export interface CodexRootRuntimeOptions extends CodexWorkerLaunchOptions {
  /** Package-resolved worker entry, never a path from user settings. */
  readonly workerPath: string
  /** Returns the current Agent-scoped Harness capability inventory each turn. */
  readonly capabilitiesForTurn?: () => unknown
}

/** Open one real Codex root session through the plugin-owned worker sidecar. 
 * @param runtime - worker launch options and the per-turn capability source.
 * @param options - the Host's root-agent create options, minus the engine it fixes here.
 * @returns the opened native agent session, configured for each turn when a capability source was given.
 */
export async function openCodexRootRuntime(
  runtime: CodexRootRuntimeOptions,
  options: Omit<NativeRootAgentCreateOptions, 'engine'>,
): Promise<NativeAgentSession> {
  // Codex refuses a missing CODEX_HOME on a clean profile.
  await mkdir(runtime.stateDirectory, { recursive: true })
  const session = await NativeRootAgentSession.open({
    command: process.execPath,
    args: [runtime.workerPath],
    env: {
      FREECODEGO_CODEX_APP_SERVER: runtime.executable,
      FREECODEGO_CODEX_HOME: runtime.stateDirectory,
      // Copy an existing local Codex login/config into the plugin-owned home
      // on first use. The app-server cannot authenticate from an empty home.
      FREECODEGO_CODEX_SYNC_GLOBAL_AUTH: '1',
      CODEX_GLOBAL_HOME: process.env.FREECODEGO_CODEX_GLOBAL_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex'),
      ...(runtime.args === undefined ? {} : { FREECODEGO_CODEX_APP_SERVER_ARGS: runtime.args.join('\u001f') }),
      PATH: process.env.PATH ?? '',
      ...runtime.environment,
    },
  }, { ...options, engine: 'codex' })
  if (runtime.capabilitiesForTurn === undefined) return session
  // A transient capabilitiesForTurn/session.configure failure must not abort the
  // turn: the previously installed configuration remains in effect, so proceed
  // with the prompt and only rethrow after repeated consecutive failures.
  let configureFailures = 0
  return {
    identity: session.identity,
    prompt: async (content, route, signal) => {
      try {
        await session.configure(await runtime.capabilitiesForTurn!())
        configureFailures = 0
      } catch (error) {
        configureFailures += 1
        // Surface the swallow: the turn proceeds on the previously installed
        // configuration, but the user sees a diagnostic event instead of a
        // silently stale capability set.
        session.emitDiagnostic(`Codex capability refresh failed (${configureFailures}/2); continuing with the previous configuration: ${error instanceof Error ? error.message : String(error)}`)
        if (configureFailures >= 2) {
          configureFailures = 0
          throw error
        }
      }
      await session.prompt(content, route, signal)
    },
    cancel: reason => session.cancel(reason),
    respond: (method, requestId, response) => session.respond(method, requestId, response),
    dispose: () => session.dispose(),
  }
}
