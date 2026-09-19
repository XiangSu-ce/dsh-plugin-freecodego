/** Community package commands must not inherit or report host credentials. */

import { afterEach, describe, expect, it } from 'vitest'
import { runCommand } from '../src/community-catalog-utils.ts'

const SECRET_ENV = 'FREECODEGO_COMMUNITY_COMMAND_TEST_SECRET'

afterEach(() => { delete process.env[SECRET_ENV] })

describe('community package command isolation', () => {
  it('does not inherit an ambient credential-shaped environment variable', async () => {
    process.env[SECRET_ENV] = `ghp_${'A'.repeat(36)}`
    const result = await runCommand(
      process.execPath,
      ['-e', `process.stderr.write(process.env.${SECRET_ENV} ?? 'missing')`],
      process.cwd(),
    )

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('missing')
  })

  it('masks a credential-shaped stderr emitted by a failed command', async () => {
    const leaked = `ghp_${'A'.repeat(36)}`
    const result = await runCommand(
      process.execPath,
      ['-e', `process.stderr.write(${JSON.stringify(`command failed with ${leaked}`)}); process.exitCode = 1`],
      process.cwd(),
    )

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('command failed with')
    expect(result.stderr).not.toContain(leaked)
  })
})
