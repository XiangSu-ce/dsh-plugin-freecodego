/**
 * The `tools/post-execute` seam plus the registered `headroom_retrieve` tool.
 *
 * Shared by the two gates that read a delivered compression, so each can ask its
 * own question of the same shipped path: `headroom-retrievability.spec.ts` asks
 * whether an adopted lossy rendering names a hash that returns the original, and
 * `headroom-ccr-writes.spec.ts` asks whether every reference resolves and every
 * write is named. A second copy of this harness would be a second reading of what
 * "delivered" means — the drift this plugin's compression tests exist to catch.
 *
 * The tool is captured rather than stubbed: the point of both gates is that the
 * hash printed into the model's context is one the *shipped* tool can resolve.
 *
 * @module
 */

import type { CcrStore } from '../../src/headroom/ccr.ts'
import type { SpillArchive } from '../../src/headroom/ccr-spill.ts'
import { FreeCodeGoHeadroomRuntime, type HeadroomSettings } from '../../src/headroom/runtime.ts'
import type { SpillWriter } from '../../src/result-spill.ts'

/** Both fixtures sets are past this gate; a fixture below it never compresses. */
export const HEADROOM_SEAM_SETTINGS: HeadroomSettings = { headroomEnabled: true, headroomThresholdChars: 1_200 }

/**
 * Every CCR reference in a rendering, in either spelling.
 *
 * `hash=` is the runtime's suffix marker; `<<ccr:HASH…>>` is the crusher's inline
 * one, written both as an opaque cell (`HASH,KIND,SIZE`) and as the dropped-rows
 * sentinel (`HASH N_rows_offloaded`). All three carry the same 24 hex characters,
 * which is why one pattern reads them.
 */
const REFERENCE = /hash=([a-f0-9]{24})|<<ccr:([a-f0-9]{24})/gu

/** The distinct hashes a rendering names. */
export function referencesIn(text: string): readonly string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(REFERENCE)) found.add(match[1] ?? match[2]!)
  return [...found]
}

export interface HeadroomSeam {
  readonly status: () => ReturnType<FreeCodeGoHeadroomRuntime['status']>
  readonly run: (text: string, overrides?: HeadroomSeamCall) => Promise<string>
  readonly retrieve: (hash: string) => Promise<unknown>
}

/**
 * The parts of one call this seam lets a case vary.
 *
 * Both exist for the boundary with the Harness's own pruner, which is decided by
 * *which tool* produced the bytes and by whether the call failed: the runtime's
 * safety gate protects read tools and short failed output, while the pruner is
 * size-only. A seam that could only speak `bash` and could not mark a failure
 * could not express either half.
 */
export interface HeadroomSeamCall {
  /** The Harness tool name, in the vocabulary the pipeline matches on. */
  readonly toolName?: string
  /** Whether the tool reported failure, which protects small error output. */
  readonly isError?: boolean
}

/**
 * What a case needs from the composition around the seam.
 *
 * `spillStore` is the mounted Harness backend the archive writes through; absent,
 * the seam is the composition every other gate uses — a deployment with no spill
 * backend at all.
 */
export interface HeadroomSeamOptions {
  readonly spillStore?: SpillWriter
  /** Read an artifact back from its locator; the default treats the locator as a path. */
  readonly readArtifact?: (locator: string) => Promise<string>
  /** Build the store the runtime parks in, to bound its capacity or lifetime. */
  readonly store?: (archive: SpillArchive) => CcrStore
  /** The owning session the seam reports, so a write has one to be archived under. */
  readonly sessionId?: string
}

export function headroomSeam(settings: HeadroomSettings = HEADROOM_SEAM_SETTINGS, options: HeadroomSeamOptions = {}): HeadroomSeam {
  const listeners = new Map<string, (exec: never, result: never, next: () => Promise<unknown>) => Promise<unknown>>()
  let tool: { execute: (args: { hash: string }) => Promise<unknown> } | undefined
  const ctx = {
    effect: (callback: () => unknown) => { callback() },
    on: (event: string, handler: unknown) => { listeners.set(event, handler as never); return () => undefined },
    get: (name: string) => name === 'tools'
      ? { register: (registered: never) => { tool = registered as never; return () => undefined } }
      : name === 'spillStore' ? options.spillStore : undefined,
  }
  const runtime = new FreeCodeGoHeadroomRuntime(ctx as never, { get: () => settings }, {
    ...(options.readArtifact === undefined ? {} : { readArtifact: options.readArtifact }),
    ...(options.store === undefined ? {} : { store: options.store }),
  })
  runtime.start()
  return {
    status: () => runtime.status(),
    run: async (text, overrides = {}) => {
      const listener = listeners.get('tools/post-execute')
      if (listener === undefined) throw new Error('runtime did not attach the post-execute seam')
      const result = await listener(
        {
          name: overrides.toolName ?? 'bash',
          callId: 'call-headroom-seam',
          arguments: overrides.toolName === undefined ? { command: 'cat fixture' } : { path: 'fixture' },
          // The owner the archive groups an artifact under. Nothing else in the
          // runtime reads it, so the rest of the seam is unchanged.
          agent: { session: { header: { id: options.sessionId ?? 'session-headroom-seam' } } },
        } as never,
        { ...(overrides.isError === true ? { isError: true } : {}), content: [{ type: 'text', text }] } as never,
        async () => ({ kind: 'next' }),
      ) as { readonly content?: readonly { readonly text: string }[] } | undefined
      return result?.content?.[0]?.text ?? text
    },
    retrieve: async (hash) => {
      if (tool === undefined) throw new Error('headroom_retrieve was never registered')
      return await tool.execute({ hash })
    },
  }
}
