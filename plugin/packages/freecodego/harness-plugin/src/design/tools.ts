/**
 * The design tools.
 *
 * Split by what they need rather than by what they are: two answer a question
 * about a composition *file* — `keyframes` and `lint` — and work with the render
 * engine off, on a machine with no browser at all; `preview` serves one on
 * loopback without driving anything; and `snapshot` / `render` need a browser and
 * a render. The catalogue search is the one that needs the least of all: it reads
 * no composition and no workspace path, because its corpus is the CSVs inside
 * this package. Keeping the first two free of the engine is what makes the capability
 * list on the design page honest — a page that lists everything as available
 * while the engine needs a browser would only be right on machines that have one,
 * and a machine with no browser still gets the two tools that answer from text.
 *
 * Reading goes through the `fs` service rather than `node:fs`. The service is the
 * plugin's sandboxed read seam — it resolves a path into a backend-owned target
 * and the backend decides what that target is — so a tool that takes a
 * model-supplied path must not go around it. When the service is absent the
 * tools refuse and say so; falling back to direct reads would be a path from a
 * model's argument to an arbitrary file on the machine, arriving as a
 * convenience.
 *
 * Results come back through the `attachments` service for the same shape of
 * reason: a rendered frame is bytes, and bytes in a JSON tool result become
 * base64 in the transcript — hundreds of thousands of tokens for one still. The
 * store is where an image is meant to live, and the harness knows how to show
 * one.
 *
 * @module design/tools
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

import { JSON_TOOL_OUTPUT, toolDefinition as rawTool, type ToolDefinitionShape } from '../tool-definition.ts'
import { CRAFT_TOOL_NAME, craftToolDefinition } from '../craft/tool.ts'
import { IMPECCABLE_DETECT_TOOL_NAME, impeccableDetectToolDefinition } from '../impeccable/tool.ts'
import { REACTBITS_TOOL_NAME, reactbitsToolDefinition } from '../reactbits/tool.ts'
import { UIUX_SEARCH_TOOL_NAME, uiuxSearchToolDefinition } from '../uiux/tool.ts'
import { defaultDesignBrowserProbes, resolveDesignBrowser } from './browser.ts'
import { captureDesignSnapshot, renderDesignVideo } from './capture.ts'
import { loadCompositionAssets, type CompositionAssetReader } from './composition-assets.ts'
import { catalogKeyframes } from './keyframes.ts'
import { DEFAULT_COMPOSITION_MAX_BYTES, lintComposition } from './lint.ts'
import { DesignPreviewHost } from './preview-host.ts'
import { catalogTimeline } from './timeline.ts'

/** The subset of the plugin's `fs` service these tools use. */
export interface DesignFileService {
  resolve(path: string): Promise<unknown>
  readText(target: unknown): Promise<string>
  readBytes(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
}

/** Largest single asset this renderer will serve. */
const ASSET_MAX_BYTES = 64 * 1024 * 1024

/**
 * The handle a registration returns, and this module's own teardown handles.
 *
 * `dispose` may be synchronous or promise-returning. The registry calls it
 * without awaiting — its own teardown has nowhere to put the wait — so a promise
 * here costs nothing there, while a caller that *can* await it gets the real
 * completion instead of a race. Written as a union rather than as `() => void`
 * because a promise-returning function offered where a `void` return is expected
 * is a defect the linter names, and rightly: the caller in that shape has no way
 * to know whether the work finished.
 */
type ToolRegistration = (() => void) | { dispose?: () => void | Promise<void> }

/** The tools service, typed structurally so this module stays independent of it. */
type ToolService = { register(tool: ToolDefinitionShape): ToolRegistration }

/** A call's execution context, as far as a design tool needs it. */
interface DesignToolExec {
  readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } }
}

/** What the tool registry is built from. */
export interface DesignToolDeps {
  readonly ctx: Context
  /** Prefix that puts a tool into the deferred set. Spelled here so a name cannot
   *  be added to the catalogue without landing in the set the set is built from. */
  readonly toolPrefix: string
}

/** Longest path this tool accepts; a composition path is never near it. */
const PATH_MAX_CHARS = 1_024

/** The shared `path` parameter both tools take. */
const PATH_PROPERTY = {
  type: 'string',
  minLength: 1,
  maxLength: PATH_MAX_CHARS,
  description: 'Composition file, relative to the session working directory.',
}

/** The `fs` service, or a refusal that says why the tool cannot work. */
function fileService(deps: DesignToolDeps): DesignFileService {
  const service = deps.ctx.get('fs') as DesignFileService | undefined
  if (service === undefined) {
    throw new Error('This installation provides no file service, so the design tools cannot read a composition.')
  }
  return service
}

/**
 * The absolute path a composition argument means.
 *
 * Resolved against the calling agent's working directory, the same way every
 * other path the model writes is — a design tool resolving against the plugin's
 * own `process.cwd()` would read a different file than the model meant the
 * moment a session opened a workspace.
 */
function resolveCompositionPath(path: string, exec: DesignToolExec): string {
  const cwd = exec.agent?.session?.header?.cwd
  const absolute = path.startsWith('/') || /^[a-z]:[\\/]/iu.test(path)
  return cwd === undefined || absolute ? path : `${cwd.replace(/[\\/]+$/u, '')}/${path}`
}

/**
 * Read one already-resolved composition path.
 *
 * Separate from {@link readComposition} because a tool that only needs the path
 * — stopping a preview, say — must not be made to depend on the file still being
 * readable. A composition a user deleted between starting a preview and stopping
 * it still has a server to close, and refusing to close it because the source is
 * gone would leave that server with no way out.
 *
 * @param deps - for the `fs` service.
 * @param full - the absolute path to read.
 * @returns the file's text.
 */
async function readSource(deps: DesignToolDeps, full: string): Promise<string> {
  const service = fileService(deps)
  try {
    return await service.readText(await service.resolve(full))
  } catch (error) {
    throw new Error(`Could not read the composition at "${full}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Read a composition named by the model.
 *
 * @returns the source and the path it was read from, which the assets and the
 *          report both need.
 */
async function readComposition(
  deps: DesignToolDeps,
  path: string,
  exec: DesignToolExec,
): Promise<{ readonly full: string; readonly source: string }> {
  const full = resolveCompositionPath(path, exec)
  return { full, source: await readSource(deps, full) }
}

/** A reader that pulls one asset out of the composition's own directory. */
function assetReader(deps: DesignToolDeps, compositionPath: string): CompositionAssetReader {
  const service = fileService(deps)
  const directory = dirname(compositionPath).replace(/[\\/]+$/u, '')
  return async (relative) => {
    try {
      const target = await service.resolve(`${directory}/${relative}`)
      // Bytes, not text: a PNG read as text is a corrupted PNG, and the render
      // would show a broken image rather than report anything.
      return await service.readBytes(target, undefined, ASSET_MAX_BYTES)
    } catch {
      return undefined
    }
  }
}

/**
 * The browser a render will use, or a refusal naming the reason it has none.
 *
 * Resolved on every call rather than cached: a user can install a browser while
 * the session is open, and a cached "there is none" would outlive the condition
 * it was measured under.
 *
 * No path is passed, because this plugin has no setting that names a browser
 * binary — the answer is the machine's own browser (Edge first), which is the
 * point of not shipping one. `resolveDesignBrowser` keeps its parameter for a
 * caller that has an override; until the design page grows a field for one,
 * there is no such caller and inventing a value here would be a lie about what
 * this renderer is allowed to launch.
 */
function designBrowser(): { readonly executable: string } {
  const resolved = resolveDesignBrowser(undefined, defaultDesignBrowserProbes())
  if (resolved.kind === 'missing') throw new Error(`The design renderer cannot run: ${resolved.detail}`)
  return { executable: resolved.executable }
}

/**
 * Run something that needs a throwaway browser profile.
 *
 * The profile is created outside the project on purpose: it holds a browser's
 * cache and cookies, and a render must not write either into a user's workspace.
 * Removal is in a `finally` — a render that threw would otherwise leave a
 * hundred megabytes behind, and the leak would grow with each failure.
 *
 * The removal itself is best-effort, and that is a correctness requirement
 * rather than leniency. The driver kills a browser it could not ask to close, and
 * a killed process on Windows does not immediately let go of its profile: the
 * removal would fail with `EBUSY`/`EPERM` — inside a `finally`, which means an
 * error *about the cleanup* would replace the render's own result or its real
 * error. A directory left in the system temp directory is the operating system's
 * to reap; a render that succeeded and reports `EBUSY` instead is not.
 */
async function withProfile<T>(run: (profileDirectory: string) => Promise<T>): Promise<T> {
  const profile = mkdtempSync(join(tmpdir(), 'freecodego-design-render-'))
  try {
    return await run(join(profile, 'profile'))
  } finally {
    try {
      // Retried because the browser is usually gone within the delay, and quiet
      // on the failure it cannot retry past.
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch { /* a profile the browser has not let go of yet */ }
  }
}

/** The attachments service, or a refusal. */
function attachmentStore(deps: DesignToolDeps): AttachmentStore {
  const store = deps.ctx.get('attachments') as AttachmentStore | undefined
  if (store === undefined) {
    throw new Error('This installation provides no attachment store, so a rendered image cannot be returned.')
  }
  return store
}

/**
 * Register one tool and keep its handle.
 *
 * @returns whether the tool was registered. The caller reports the names it
 *          registered, and a report that counts a tool the service refused is the
 *          page claiming a capability this build does not have.
 */
function register(
  deps: DesignToolDeps,
  registrations: ToolRegistration[],
  tool: ToolDefinitionShape,
): boolean {
  const tools = deps.ctx.get('tools') as ToolService | undefined
  if (tools === undefined) return false
  registrations.push(tools.register(tool))
  return true
}

/**
 * Register every design tool whose name is listed as provided.
 *
 * Driven by a name list rather than by feature flags so the caller's statement
 * and the registered surface cannot drift: a feature that lists a tool it has no
 * implementation for gets no tool, and the caller can report the difference.
 *
 * @param deps - the services and the tool-prefix rule.
 * @param names - the tool names to register; unknown names are skipped.
 * @returns the registrations, to dispose when the pack is switched off, and the
 *          names that were actually registered.
 */
export function registerDesignTools(deps: DesignToolDeps, names: readonly string[]): {
  readonly registrations: readonly ToolRegistration[]
  readonly registered: readonly string[]
} {
  const registrations: ToolRegistration[] = []
  const registered: string[] = []
  const want = new Set(names)
  const previewName = `${deps.toolPrefix}design_preview`
  const previewHost = new DesignPreviewHost()

  // A preview server outlives the call that started it — that is what a preview
  // is — so its teardown has to ride the same handle the registry disposes when
  // the pack stands down. Without it, switching the feature off would leave a
  // loopback listener with no owner left to close it.
  //
  // The handle returns the promise rather than swallowing it: the registry's own
  // teardown ignores the return value, so this costs nothing there, and a caller
  // that *does* await it (a test closing the port before asserting it is closed)
  // gets the real completion instead of a race.
  if (want.has(previewName)) registrations.push({ dispose: () => previewHost.dispose() })

  /**
   * Every tool this module implements, with its definition built on demand.
   *
   * A table rather than one `if` per tool so the report and the registrations are
   * produced by the same loop — the shape that lets a new tool reach the
   * registered set without a second place to update.
   */
  const definitions: readonly { readonly name: string; readonly define: () => ToolDefinitionShape }[] = [
    {
      // The catalogue search, first because it is the cheapest tool here — no
      // file service, no browser, no attachment store: it answers from the CSVs
      // inside this package, which is why the row that offers it works on a
      // machine with none of those. It is still registered through this
      // table rather than by its own module, because "the switch on the design
      // page owns the tool" is the property the page claims, and a second
      // registration path is how that claim would quietly stop being true.
      name: UIUX_SEARCH_TOOL_NAME,
      define: uiuxSearchToolDefinition,
    },
    {
      // Craft, beside the catalogue for the same reason it is cheap: package
      // assets, no file service, no browser. It reads no composition and no
      // workspace — the eleven rulebooks and their forward-reference register are
      // the whole corpus — so it works on a machine with no browser and no render
      // engine, exactly as `uiux_search` does.
      name: CRAFT_TOOL_NAME,
      define: craftToolDefinition,
    },
    {
      name: `${deps.toolPrefix}design_keyframes`,
      define: () => rawTool({
        name: `${deps.toolPrefix}design_keyframes`,
        description: 'Catalog what a composition animates without rendering it: GSAP tweens and timelines, CSS @keyframes blocks, the targets involved, the transform properties that move something in space, and timeline positions written as literals. Read-only, and available with the render engine off.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: PATH_PROPERTY },
        },
        output: JSON_TOOL_OUTPUT,
        isConcurrencySafe: () => true,
        execute: async (args: { readonly path: string }, exec: DesignToolExec) => {
          const source = (await readComposition(deps, args.path, exec)).source
          return { path: args.path, ...catalogKeyframes(source) }
        },
        presentCall: () => ({ card: 'generic', title: 'Catalog composition animation' }),
      }),
    },
    {
      // React Bits, the only tool here whose knowledge is not in this package. It
      // reads upstream's registry over the network instead, because the
      // components' licence permits using them and forbids redistributing them —
      // see `reactbits/registry.ts`. It takes the context only for its `apply`
      // action, which writes through the `fs` service; the two read actions work
      // with no context at all, and a context without a file service gets a
      // refusal that says which half is missing.
      name: REACTBITS_TOOL_NAME,
      define: () => reactbitsToolDefinition(deps.ctx),
    },
    {
      // The Impeccable detector. It sits beside the two composition scanners — it
      // reads the same kind of thing they do, source text through the `fs` service
      // — and ahead of the render tools, because it needs no browser.
      // Upstream's own engine is used when the machine already has one; that is a
      // property of the machine rather than of this registration, which is why the
      // row does not split in two over it.
      name: IMPECCABLE_DETECT_TOOL_NAME,
      define: () => impeccableDetectToolDefinition(deps.ctx),
    },
    {
      name: `${deps.toolPrefix}design_lint`,
      define: () => rawTool({
        name: `${deps.toolPrefix}design_lint`,
        description: 'Lint a composition file without rendering it: composition root and dimension declarations, unbalanced <style> tags, markup that would render as text, inline script syntax, asset paths that leave the project, and code that makes a render non-deterministic. Findings carry their own rule ids, so a Skill\u2019s wording about a rule still applies.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: PATH_PROPERTY,
            verbose: { type: 'boolean', description: 'Include info-level findings, which are hidden by default.' },
            maxBytes: { type: 'integer', minimum: 1_024, maximum: 64 * 1_024 * 1_024, description: 'Size ceiling for the composition file.' },
          },
        },
        output: JSON_TOOL_OUTPUT,
        isConcurrencySafe: () => true,
        execute: async (args: { readonly path: string; readonly verbose?: boolean; readonly maxBytes?: number }, exec: DesignToolExec) => {
          const source = (await readComposition(deps, args.path, exec)).source
          const report = lintComposition(source, { maxBytes: args.maxBytes ?? DEFAULT_COMPOSITION_MAX_BYTES })
          const findings = report.findings.filter(finding => args.verbose === true || finding.severity !== 'info')
          return {
            path: args.path,
            bytes: Buffer.byteLength(source, 'utf8'),
            ...report,
            findings,
            // The counts describe the file; the list is what this call returned.
            // Naming the difference is what keeps `infoCount: 2` beside an empty
            // list from reading as a defect in the report rather than as the
            // default view of one.
            ...findings.length === report.findings.length
              ? {}
              : { hiddenInfoFindings: report.findings.length - findings.length },
          }
        },
        presentCall: () => ({ card: 'generic', title: 'Lint composition' }),
      }),
    },
    {
      name: previewName,
      define: () => rawTool({
        name: previewName,
        description: 'Serve a composition on loopback and return the URL to open, together with what the composition contains: its compositions, their tracks, and every clip with the timing it declares. No browser is driven and no frame is rendered, so this is the cheap way to look at a running composition or to answer a question about its timeline. The files served are the ones read at this moment, so run it again after an edit. Pass stop to release the port.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: PATH_PROPERTY,
            stop: { type: 'boolean', description: 'Close the preview for this composition instead of starting one. Defaults to false.' },
          },
        },
        output: JSON_TOOL_OUTPUT,
        execute: async (args: { readonly path: string; readonly stop?: boolean }, exec: DesignToolExec) => {
          // Addressed by the resolved path, not by what the model typed: two
          // spellings of one file are one composition, and keying on the argument
          // would start two servers for it.
          const full = resolveCompositionPath(args.path, exec)
          if (args.stop === true) {
            // The resolved path is reported back so a `stopped: false` is
            // diagnosable: a preview is keyed by that path, so a caller whose
            // session working directory moved between calls gets told which key
            // it looked for instead of wondering whether a server exists at all.
            return { path: args.path, resolvedPath: full, serving: false, stopped: await previewHost.stop(full) }
          }

          const composition = { full, source: await readSource(deps, full) }
          const loaded = await loadCompositionAssets(composition.source, assetReader(deps, composition.full))
          const session = await previewHost.start({
            key: composition.full,
            html: composition.source,
            assets: loaded.assets,
          })

          return {
            path: args.path,
            resolvedPath: full,
            serving: true,
            url: session.url,
            // The read half of what upstream's `timeline` verb answered, from the
            // same source text the render would use — so the two cannot describe
            // different projects.
            ...catalogTimeline(composition.source),
            assetsServed: loaded.assets.size,
            assetsMissing: loaded.missing,
            snapshotOfFiles: true,
          }
        },
        presentCall: () => ({ card: 'generic', title: 'Serve composition preview' }),
      }),
    },
    {
      name: `${deps.toolPrefix}design_snapshot`,
      define: () => rawTool({
        name: `${deps.toolPrefix}design_snapshot`,
        description: 'Render one frame of a composition as a PNG image and show it. Seeks the registered paused timeline to the given time and photographs the settled frame, so the same time gives the same image. Reports the self-check it ran before rendering, so a frame that came out wrong says why.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: {
            path: PATH_PROPERTY,
            atSeconds: { type: 'number', minimum: 0, maximum: 3_600, description: 'Time to seek to, in seconds. Defaults to 0.' },
            width: { type: 'integer', minimum: 16, maximum: 4_096, description: 'Frame width in pixels. Defaults to 1280.' },
            height: { type: 'integer', minimum: 16, maximum: 4_096, description: 'Frame height in pixels. Defaults to 720.' },
          },
        },
        output: JSON_TOOL_OUTPUT,
        execute: async (
          args: { readonly path: string; readonly atSeconds?: number; readonly width?: number; readonly height?: number },
          exec: DesignToolExec,
        ) => {
          const [composition, browser] = [await readComposition(deps, args.path, exec), designBrowser()]
          const loaded = await loadCompositionAssets(composition.source, assetReader(deps, composition.full))
          const width = args.width ?? 1_280
          const height = args.height ?? 720
          const atSeconds = args.atSeconds ?? 0

          const rendered = await withProfile(profileDirectory => captureDesignSnapshot({
            html: composition.source,
            assets: loaded.assets,
            executable: browser.executable,
            profileDirectory,
            width,
            height,
            atSeconds,
          }))

          const stored = await attachmentStore(deps).saveImage({
            data: rendered.png,
            mediaType: 'image/png',
            name: `${basename(composition.full)}.png`,
          })

          return {
            path: args.path,
            atSeconds,
            width: rendered.width,
            height: rendered.height,
            timelinesSeeked: rendered.timelinesSeeked,
            assetsServed: loaded.assets.size,
            // Named, not counted: a composition whose background image 404s
            // renders a blank frame, and the reason should not have to be
            // deduced from the picture.
            assetsMissing: loaded.missing,
            rendererChecks: rendered.preflight,
            image: {
              attachmentId: stored.attachmentId,
              mediaType: stored.mediaType,
              bytes: stored.bytes,
              width: stored.width,
              height: stored.height,
            },
          }
        },
        presentCall: () => ({ card: 'generic', title: 'Render composition frame' }),
      }),
    },
    {
      name: `${deps.toolPrefix}design_render`,
      define: () => rawTool({
        name: `${deps.toolPrefix}design_render`,
        description: 'Render a composition to an MP4 video. Each frame is seeked, settled and photographed separately and then encoded offline, so the same composition and frame count always produce the same frames \u2014 it is not a real-time screen recording. Encoding happens in the browser (WebCodecs) and the file is written by this plugin, so nothing is downloaded. Costs roughly a second per frame: prefer a snapshot to find layout problems.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'fps', 'frameCount'],
          properties: {
            path: PATH_PROPERTY,
            fps: { type: 'integer', minimum: 1, maximum: 120, description: 'Frames per second of the result, and the rate frames are seeked at.' },
            frameCount: { type: 'integer', minimum: 1, maximum: 7_200, description: 'Number of frames, counted from time zero. At 30 fps, 300 frames is ten seconds.' },
            width: { type: 'integer', minimum: 16, maximum: 4_096, description: 'Frame width in pixels. Defaults to 1280.' },
            height: { type: 'integer', minimum: 16, maximum: 4_096, description: 'Frame height in pixels. Defaults to 720.' },
            bitrate: { type: 'integer', minimum: 100_000, maximum: 80_000_000, description: 'Target video bitrate in bits per second. Defaults to 4 Mbps.' },
          },
        },
        output: JSON_TOOL_OUTPUT,
        execute: async (
          args: {
            readonly path: string
            readonly fps: number
            readonly frameCount: number
            readonly width?: number
            readonly height?: number
            readonly bitrate?: number
          },
          exec: DesignToolExec,
        ) => {
          const [composition, browser] = [await readComposition(deps, args.path, exec), designBrowser()]
          const loaded = await loadCompositionAssets(composition.source, assetReader(deps, composition.full))

          const rendered = await withProfile(profileDirectory => renderDesignVideo({
            html: composition.source,
            assets: loaded.assets,
            executable: browser.executable,
            profileDirectory,
            width: args.width ?? 1_280,
            height: args.height ?? 720,
            fps: args.fps,
            frameCount: args.frameCount,
            ...(args.bitrate === undefined ? {} : { bitrate: args.bitrate }),
          }))

          const store = attachmentStore(deps)
          const stored = await (async () => {
            try {
              return await store.saveFile({ data: rendered.bytes, name: `${basename(composition.full)}.mp4` })
            } catch (error) {
              throw new Error(
                'The composition rendered, but this installation\u2019s attachment store cannot keep a verbatim file, '
                + `so the video has nowhere to go: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          })()

          return {
            path: args.path,
            container: rendered.container,
            codec: rendered.codec,
            frames: rendered.frames,
            fps: rendered.fps,
            width: rendered.width,
            height: rendered.height,
            seconds: rendered.frames / rendered.fps,
            // Measured, not estimated: a caller deciding whether to render a
            // longer sequence needs a number from this machine.
            perFrameMs: Math.round(rendered.perFrameMs),
            elapsedMs: rendered.elapsedMs,
            carriedDecoderConfig: rendered.carriedDecoderConfig,
            assetsServed: loaded.assets.size,
            assetsMissing: loaded.missing,
            rendererChecks: rendered.preflight,
            file: { attachmentId: stored.attachmentId, name: stored.name, bytes: stored.bytes },
          }
        },
        presentCall: () => ({ card: 'generic', title: 'Render composition video' }),
      }),
    },
  ]

  for (const definition of definitions) {
    if (!want.has(definition.name)) continue
    if (!register(deps, registrations, definition.define())) continue
    registered.push(definition.name)
  }

  return { registrations, registered }
}
