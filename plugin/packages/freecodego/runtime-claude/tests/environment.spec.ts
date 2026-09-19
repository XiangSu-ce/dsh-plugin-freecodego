import { describe, expect, it } from 'vitest'
import { buildClaudeSdkEnvironment } from '../src/environment.ts'
import { claudeRuntimeEnvironment } from '../src/index.ts'

describe('Claude Agent SDK environment', () => {
  it('replaces the user home before launching the isolated worker', () => {
    const stateDirectory = 'C:/freecodego-runtime'
    const environment = claudeRuntimeEnvironment(stateDirectory, {
      HOME: 'C:/Users/Administrator',
      USERPROFILE: 'C:/Users/Administrator',
      FREECODEGO_CLAUDE_BASE_URL: 'https://gateway.example',
    })

    expect(environment).toMatchObject({
      FREECODEGO_CLAUDE_HOME: stateDirectory,
      HOME: stateDirectory,
      USERPROFILE: stateDirectory,
      FREECODEGO_CLAUDE_BASE_URL: 'https://gateway.example',
    })
  })

  it('maps the FreeCodeGo managed gateway to the official SDK variables', () => {
    const environment = buildClaudeSdkEnvironment({
      PATH: 'test-path',
      FREECODEGO_CLAUDE_BASE_URL: 'https://gateway.example/v1/',
      FREECODEGO_CLAUDE_API_KEY: 'plugin-local-key',
      ANTHROPIC_API_KEY: 'ambient-key-must-not-win',
      DEPLOYMENT_SECRET: 'must-not-reach-the-tool-process',
    }, 'C:/runtime-state', 'agnes-3.0-flash')

    expect(environment).toMatchObject({
      PATH: 'test-path',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_API_KEY: 'plugin-local-key',
      ANTHROPIC_MODEL: 'agnes-3.0-flash',
      CLAUDE_CONFIG_DIR: 'C:/runtime-state',
      CLAUDE_CODE_SIMPLE: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    })
    expect(environment).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(environment).not.toHaveProperty('DEPLOYMENT_SECRET')
    expect(environment).not.toHaveProperty('FREECODEGO_CLAUDE_AUTH_TOKEN')
  })

  it('preserves an explicitly configured Anthropic-compatible third-party API key', () => {
    const environment = buildClaudeSdkEnvironment({
      ANTHROPIC_BASE_URL: 'https://third-party.example/api/',
      ANTHROPIC_API_KEY: 'third-party-key',
    }, '/tmp/claude')

    expect(environment).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://third-party.example/api',
      ANTHROPIC_API_KEY: 'third-party-key',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
    })
  })

  it('rejects an uncredentialed or insecure non-local endpoint', () => {
    expect(() => buildClaudeSdkEnvironment({ ANTHROPIC_BASE_URL: 'https://third-party.example' }, '/tmp/claude'))
      .toThrow('missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY')
    expect(() => buildClaudeSdkEnvironment({ ANTHROPIC_BASE_URL: 'http://third-party.example', ANTHROPIC_API_KEY: 'key' }, '/tmp/claude'))
      .toThrow('must use HTTPS')
  })
})
