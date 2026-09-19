import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const bundleDirectory = resolve(import.meta.dirname, '../../bundle-latest')
const sourceDirectory = resolve(import.meta.dirname, '../src')
const clientEntry = resolve(import.meta.dirname, '../../harness-ui/src/client/index.ts')

describe('FreeCodeGo RC.1 composition', () => {
  it('uses RC.1 public seams, the official picker, and no archived runtime graph', async () => {
    const manifest = JSON.parse(await readFile(resolve(bundleDirectory, 'package.json'), 'utf8')) as {
      readonly name: string
      readonly dependencies: Readonly<Record<string, string>>
      readonly peerDependencies: Readonly<Record<string, string>>
      readonly freecodego?: { readonly harnessBaseline?: string }
      readonly dsh?: {
        readonly bootstrap?: { readonly export?: string }
        readonly client?: { readonly inject?: readonly string[] }
      }
    }
    const patch = await readFile(resolve(bundleDirectory, 'cordis.patch.yml'), 'utf8')

    expect(manifest.name).toBe('freecodego')
    expect(manifest.freecodego?.harnessBaseline).toBe('0.1.6-alpha.2')
    expect(manifest.dsh?.bootstrap?.export).toBe('bootstrapFreeCodeGoHarness')
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-conversation')
    expect(manifest.dependencies).toEqual({
      '@anthropic-ai/claude-agent-sdk': '0.3.246',
      'eventsource-parser': '^3.1.0',
      'js-yaml': '^4.2.0',
      tar: '7.5.2',
      zod: '^4.4.3',
    })
    expect(Object.keys(manifest.peerDependencies)).toContain('@deepseek-ai/cordis')
    expect(patch).toContain("name: 'freecodego'")
    expect(patch).not.toContain("name: '@deepseek-ai/dsh-freecodego-agent-engine-router'")
    expect(patch).toContain('freeCodeGoSessionEvents')
    expect(patch).toContain("name: 'freecodego/session-events'")
    expect(patch).toContain('powered by FreeCodeGo')
    expect(patch).not.toContain('{{model}}')
    expect(patch).not.toContain("name: '@freecodego/dsh-client-ui-model-selection'")
    expect(patch).not.toMatch(/dsh-agent-engine|dsh-client-runtime|registerFactory|v012/)
  })

  it('does not depend on unpublished Harness source subpaths', async () => {
    const files = ['agnes.ts', 'openai-compatible-adapter.ts', 'engineering.ts']
    const sources = await Promise.all(files.map(file => readFile(resolve(sourceDirectory, file), 'utf8')))
    expect(sources.join('\n')).not.toContain('@deepseek-ai/dsh-llm-deepseek/src/')
  })

  it('declares the conversation service used by Agent progress rendering', async () => {
    const source = await readFile(clientEntry, 'utf8')
    expect(source).toMatch(/export const inject = \[[^\]]*'uiConversation'/u)
  })
})
