/**
 * The image/video generation switch.
 *
 * What these pins hold is that the switch is a *registration* and not a runtime
 * check: with it off the tools are absent from the registry, so they cannot appear in
 * a request's tool list at all, and with it on they are back. The distinction matters
 * because a guard inside `execute` would look identical from the tool's own errors
 * while leaving every schema in every request — which is the cost the switch exists to
 * remove.
 *
 * The audio pair is pinned from the other side: it has to survive the toggle, because
 * the one thing this switch deliberately does not govern is the tool that writes a
 * file into the active workspace and the one that reads a file out of it.
 */

import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { provideHostService, provideHostServiceAs, settingsSink, type AgentEnginesFace } from './support/host-services.ts'

/**
 * The Host services this plugin's construction reads.
 *
 * `agentEngines` and `agents` are what the constructor wires the Agent-progress
 * runtime against; `tools` and `settings` are provided per test, because those two are
 * the subject.
 */
function HostServices(ctx: Context): void {
  provideHostServiceAs<AgentEnginesFace>(ctx, 'agentEngines', { setAvailability: () => undefined })
  provideHostService(ctx, 'agents', { list: () => [], get: () => undefined })
}

/**
 * The four names the switch governs.
 *
 * Declared here rather than imported on purpose: a status that reported a different set
 * from the one this list names is exactly the drift these pins exist to catch, and an
 * expected value taken from the implementation could not catch it.
 */
const GATED: readonly string[] = [
  'freecodego_generate_image',
  'freecodego_generate_video',
  'agnes_generate_image',
  'agnes_generate_video',
]

/** What {@link mount} hands back: the plugin, the record it writes, and the live registry. */
interface Mounted {
  readonly plugin: FreeCodeGoHarnessPlugin
  readonly ctx: Context
  readonly stored: Record<string, unknown>
  readonly live: Map<string, ToolDefinition>
}

/**
 * Mount the plugin over a tool registry whose disposers really remove entries.
 *
 * A registry rather than a list of definitions, because "mounted" is a property of the
 * registry: a disposer that recorded nothing would let a switch that unmounts nothing
 * pass.
 * @returns the plugin, its context, the settings record it writes, and the live registry.
 */
async function mount(): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(HostServices)
  const live = new Map<string, ToolDefinition>()
  provideHostService(ctx, 'tools', {
    register: (definition) => {
      live.set(definition.name, definition)
      return () => { live.delete(definition.name) }
    },
    guard: () => () => undefined,
    schemas: () => [],
  })
  const stored: Record<string, unknown> = {}
  const settings = settingsSink(ctx, stored)
  const plugin = new FreeCodeGoHarnessPlugin(ctx, settings.config)
  // The write goes through the entry id a Loader would have assigned to the fiber this
  // plugin was created in, which is what `attach` supplies.
  settings.attach(plugin)
  return { plugin, ctx, stored, live }
}

describe('image/video generation switch', () => {
  it('mounts the image and video tools by default and removes exactly them when switched off', async () => {
    const { plugin, ctx, stored, live } = await mount()
    try {
      // On by default, and with no Agnes client configured in this fixture the legacy
      // aliases are governed but not mounted — which is the two-axis report the status
      // exists for, rather than one number that hides the difference.
      expect(plugin.mediaGenerationStatus()).toEqual({
        enabled: true,
        gated: GATED,
        registered: ['freecodego_generate_image', 'freecodego_generate_video'],
      })

      const off = await plugin.mediaGenerationSetEnabled(false)
      expect(off).toEqual({ enabled: false, gated: GATED, registered: [] })
      // The setting is what a restart re-mounts from, so it has to have been written.
      expect(stored.mediaGenerationEnabled).toBe(false)
      expect(live.has('freecodego_generate_image')).toBe(false)
      expect(live.has('freecodego_generate_video')).toBe(false)

      const on = await plugin.mediaGenerationSetEnabled(true)
      expect(on).toEqual({
        enabled: true,
        gated: GATED,
        registered: ['freecodego_generate_image', 'freecodego_generate_video'],
      })
      expect(live.has('freecodego_generate_image')).toBe(true)
      expect(live.has('freecodego_generate_video')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the audio and transcription tools mounted through the toggle', async () => {
    const { plugin, ctx, live } = await mount()
    try {
      await plugin.mediaGenerationSetEnabled(false)
      // Outside the switch on purpose: one writes a file into the workspace and the
      // other reads one out of it, so neither is what "stop making pictures and clips"
      // asks to lose.
      expect(live.has('freecodego_generate_audio')).toBe(true)
      expect(live.has('freecodego_transcribe_audio')).toBe(true)
      // And the switch does not claim them: a status that listed them would have the
      // panel describe audio generation as switched off while it keeps working.
      expect(plugin.mediaGenerationStatus().gated).not.toContain('freecodego_generate_audio')
      expect(plugin.mediaGenerationStatus().gated).not.toContain('freecodego_transcribe_audio')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
