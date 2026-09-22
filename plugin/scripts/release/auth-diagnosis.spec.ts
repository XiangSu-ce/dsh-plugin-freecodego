/** Cover the credential-refusal diagnosis: what a failed publish can and cannot know. */

import { describe, expect, it } from 'vitest'
import { registryAuthHint } from './auth-diagnosis.ts'

/** Output of a publish the registry refused without authenticating. */
const REFUSED = [
  'npm notice name: freecodego',
  'npm error code ENEEDAUTH',
  'npm error need auth This command requires you to be logged in to https://registry.npmjs.org/',
].join('\n')

/** The OIDC environment a publishing job with `id-token: write` runs with. */
const OIDC_ENVIRONMENT: NodeJS.ProcessEnv = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/abc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'masked',
  GITHUB_REPOSITORY: 'XiangSu-ce/dsh-plugin-freecodego',
  GITHUB_WORKFLOW_REF: 'XiangSu-ce/dsh-plugin-freecodego/.github/workflows/release-freecodego.yml@refs/tags/freecodego-v0.1.6-alpha.2.3',
}

/** A manifest whose repository is the one this workflow runs in. */
const MATCHING_MANIFEST = {
  repository: { type: 'git', url: 'git+https://github.com/XiangSu-ce/dsh-plugin-freecodego.git' },
}

describe('registryAuthHint', () => {
  it('says nothing about a failure that is not about credentials', () => {
    const output = 'npm error code E409\nnpm error Failed to save packument'

    expect(registryAuthHint({ output, environment: OIDC_ENVIRONMENT })).toBeUndefined()
  })

  it('blames the job permission when no OIDC token reached npm', () => {
    const hint = registryAuthHint({ output: REFUSED, environment: { GITHUB_REPOSITORY: 'a/b' } })

    expect(hint).toContain('ACTIONS_ID_TOKEN_REQUEST_URL')
    expect(hint).toContain('permissions: id-token: write')
    expect(hint).not.toContain('Trusted publishing')
  })

  it('names the trusted publisher fields when the exchange itself was refused', () => {
    const hint = registryAuthHint({ output: REFUSED, environment: OIDC_ENVIRONMENT })

    expect(hint).toContain('XiangSu-ce')
    expect(hint).toContain('dsh-plugin-freecodego')
    expect(hint).toContain('release-freecodego.yml')
    // The ref belongs to the run, not to the trusted publisher.
    expect(hint).not.toContain('refs/tags')
    // A connection created after 2026-09-03 allows staged publishing only.
    expect(hint).toContain('npm publish')
  })

  it('says so when the packed manifest names the repository the workflow runs in', () => {
    const hint = registryAuthHint({ output: REFUSED, environment: OIDC_ENVIRONMENT, manifest: MATCHING_MANIFEST })

    expect(hint).toContain('repository.url')
    expect(hint).toContain('not the cause')
  })

  it('flags a packed manifest that still names the upstream repository', () => {
    const manifest = { repository: { url: 'git+https://github.com/deepseek-ai/deepseek-harness.git' } }

    const hint = registryAuthHint({ output: REFUSED, environment: OIDC_ENVIRONMENT, manifest })

    expect(hint).toContain('deepseek-ai/deepseek-harness')
    expect(hint).toContain('fork')
  })

  it('reads a repository written as a plain string, and one with a narrowing fragment', () => {
    const asString = registryAuthHint({
      output: REFUSED,
      environment: OIDC_ENVIRONMENT,
      manifest: { repository: 'git+https://github.com/XiangSu-ce/dsh-plugin-freecodego.git#readme' },
    })

    expect(asString).toContain('not the cause')
  })

  it('reports the absent permission even when the manifest is unreadable', () => {
    const hint = registryAuthHint({ output: REFUSED, environment: {}, manifest: undefined })

    expect(hint).toContain('permissions: id-token: write')
    expect(hint).not.toContain('repository.url')
  })
})
