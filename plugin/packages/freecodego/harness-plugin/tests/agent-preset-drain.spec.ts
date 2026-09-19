import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { FreeCodeGoHarnessPlugin } from '../src/index.ts'
import { provideHostService, provideHostServiceAs, type AgentEnginesFace } from './support/host-services.ts'
import { AUGMENTCODE_AGENT_PRESET_ID, FREECODEGO_AGENT_PRESET_ID } from '../src/agent-preset-install.ts'

function AgentEngineRegistry(ctx: Context): void {
  provideHostServiceAs<AgentEnginesFace>(ctx, 'agentEngines', { setAvailability: () => undefined })
  provideHostService(ctx, 'agents', { list: () => [], get: () => undefined })
}

/**
 * The boot-time preset sync is fire-and-forget, so nothing about the plugin's
 * own return value says whether it has finished. It still belongs to the
 * plugin's lifetime: the roster directory it writes lives under the active
 * home, and an unload that does not wait for it can leave the write to land in
 * whatever home is current when the I/O finally runs — or, for a caller tearing
 * a temporary home down, land in the middle of that removal.
 *
 * Asserted at the moment of unload, not after a delay: "it eventually appears"
 * is exactly the property the plugin did not have before, and the delay would
 * hide the difference this test exists to pin.
 */
describe('FreeCodeGo boot-time preset write', () => {
  it('is drained before the plugin finishes unloading', async () => {
    const home = await mkdtemp(join(tmpdir(), 'freecodego-preset-drain-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const ctx = new Context()
    await ctx.plugin(AgentEngineRegistry)
    try {
      new FreeCodeGoHarnessPlugin(ctx, {})
      await ctx.fiber.dispose()
      for (const presetId of [FREECODEGO_AGENT_PRESET_ID, AUGMENTCODE_AGENT_PRESET_ID]) {
        for (const file of ['agent.cordis.yml', 'preset.yml']) {
          await expect(readFile(join(home, '.agent-presets', presetId, file), 'utf8'))
            .resolves.toContain('freecodego-agent-preset')
        }
      }
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})
