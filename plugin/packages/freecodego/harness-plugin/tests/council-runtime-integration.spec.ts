/** Council dispatch must use scoped services without relying on fiber injection. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { FreeCodeGoNativeAgent } from '@deepseek-ai/dsh-freecodego-root-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'

import { FreeCodeGoEngineCouncil } from '../src/engine-council.ts'
import { JSON_TOOL_OUTPUT } from '../src/tool-definition.ts'

it('creates a council child, enforces its read-only schema, and retains its report', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'freecodego-council-runtime-'))
  const ctx = new Context()
  const council = new FreeCodeGoEngineCouncil(
    { get: () => ({ engineeringEnabled: true, engineeringCouncilMaxRounds: 1, engineeringCouncilQuorum: 1 }) },
    () => ({ engine: 'deepseek', provider: 'freecodego', model: 'audit-model' }),
  )
  const agents: FreeCodeGoNativeAgent[] = []
  let child: FreeCodeGoNativeAgent | undefined
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime, {})
    for (const name of ['read', 'write']) ctx.get('tools')!.register({
      name, description: `${name} fixture`, parameters: { type: 'object', properties: {} },
      output: JSON_TOOL_OUTPUT, execute: async () => ({ ok: true }),
    })
    const parentSession = ctx.get('sessions')!.create(SessionId('council-runtime-parent'), { meta: { cwd: workspace } })
    const parent = new FreeCodeGoNativeAgent(ctx, parentSession.id, {}, parentSession)
    agents.push(parent)
    const create = vi.spyOn(ctx.get('agents')!, 'create').mockImplementation(async (request) => {
      const session = ctx.get('sessions')!.create(request.sessionId, { meta: request.meta! })
      const participant = new FreeCodeGoNativeAgent(ctx, session.id, {}, session)
      child = participant
      agents.push(participant)
      await request.setup?.(participant.ctx, participant)
      vi.spyOn(participant, 'followup').mockImplementation(() => undefined)
      session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
        source: { provider: 'freecodego', model: 'audit-model' },
        content: [{ type: 'text', text: 'Verdict: approve\nNo findings.' }],
      }) }, { surfaceOp: 'append' })
      return { agent: participant, dispose: async () => undefined }
    })
    const report = await council.run(parent, { objective: 'Review an interface', plan: 'Read the public API.', engines: ['deepseek'], maxRounds: 1 })
    expect(report, JSON.stringify(report)).toMatchObject({ state: 'completed', riskGate: 'clear', participants: [{ engine: 'deepseek', state: 'completed' }] })
    expect(create).toHaveBeenCalledOnce()
    expect(child).toBeDefined()
    expect(ctx.get('tools')!.schemas(child!).map(tool => tool.name)).toEqual(['read'])
    expect(council.reports(parent)).toHaveLength(1)
  } finally {
    vi.restoreAllMocks()
    council.dispose()
    for (const agent of agents) await agent.scope.dispose()
    await ctx.fiber.dispose()
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
