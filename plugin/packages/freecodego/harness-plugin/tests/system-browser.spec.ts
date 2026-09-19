/**
 * Opening a URL in the system browser is fire-and-forget, but it is not free of
 * failure. On a headless Linux host (a container, CI, a server install) there is
 * no `xdg-open`, and Node reports a missing binary as an asynchronous `'error'`
 * event rather than a throw from `spawn`. Two things follow, and both are what
 * these tests pin:
 *
 * 1. An emitter with no `'error'` listener rethrows the error — inside the Host
 *    process. A `.catch(() => false)` at the call site cannot intercept that,
 *    because it is not a rejection.
 * 2. The returned promise said `true` regardless, so the caller never rendered
 *    the manual link it keeps as the fallback for exactly this case.
 *
 * Every other `spawn` in this plugin (the community CLI, the capability probe,
 * both `taskkill` trees) attaches an error handler; this one has to as well.
 */

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeChild extends EventEmitter {
  readonly unref: () => void
  readonly kill: () => boolean
}

const harness = vi.hoisted(() => ({
  spawns: [] as { readonly command: string; readonly args: readonly string[] }[],
  child: undefined as undefined | EventEmitter,
}))

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), { unref: () => undefined, kill: () => true }) as FakeChild
    harness.spawns.push({ command, args })
    harness.child = child
    return child
  },
}))

const { openUrlInSystemBrowser } = await import('../src/system-browser.ts')

describe('openUrlInSystemBrowser', () => {
  beforeEach(() => { harness.spawns.length = 0; harness.child = undefined })

  it('reports failure when the platform opener is missing, instead of throwing inside the Host', async () => {
    const opened = openUrlInSystemBrowser('https://example.test/sign-in')
    expect(harness.child, 'the opener was not spawned at all').toBeDefined()
    harness.child!.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }))
    await expect(opened).resolves.toBe(false)
  })

  it('reports success once the platform opener really started', async () => {
    const opened = openUrlInSystemBrowser('https://example.test/sign-in')
    harness.child!.emit('spawn')
    await expect(opened).resolves.toBe(true)
    expect(harness.spawns).toHaveLength(1)
  })

  it('never hands a non-http(s) URL to the platform opener', async () => {
    await expect(openUrlInSystemBrowser('file:///etc/passwd')).resolves.toBe(false)
    await expect(openUrlInSystemBrowser('javascript:alert(1)')).resolves.toBe(false)
    expect(harness.spawns).toHaveLength(0)
  })
})
