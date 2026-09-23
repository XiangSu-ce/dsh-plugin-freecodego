import { describe, expect, it, vi } from 'vitest'
import { TRAE_CALLBACK_PATH } from '../src/trae/endpoints.ts'
import { startTraeCallbackListener } from '../src/trae/callback-server.ts'

/** One attempt's listener, plus what it captured. */
async function listener(): Promise<{ readonly port: number; readonly received: string[]; readonly close: () => Promise<void> }> {
  const received: string[] = []
  const started = await startTraeCallbackListener(url => { received.push(url) })
  return { port: started.port, received, close: () => started.close() }
}

describe('TRAE sign-in callback listener', () => {
  it('captures the redirect on its own path and answers the browser', async () => {
    const subject = await listener()
    try {
      const response = await fetch(`http://127.0.0.1:${subject.port}${TRAE_CALLBACK_PATH}?isRedirect=true&refreshToken=rt-1`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('TRAE')
      await vi.waitFor(() => { expect(subject.received).toEqual([`http://127.0.0.1${TRAE_CALLBACK_PATH}?isRedirect=true&refreshToken=rt-1`]) })
    } finally {
      await subject.close()
    }
  })

  it('refuses a path that merely begins with the callback path', async () => {
    // The check is what decides whether a request is this attempt's redirect, and
    // `/authorize-evil` is not that path. A prefix test accepts it — and the URL it
    // hands the exchange is the attacker's own, which is the whole risk here: the
    // reply is treated as an authorization the user granted.
    const subject = await listener()
    try {
      const response = await fetch(`http://127.0.0.1:${subject.port}${TRAE_CALLBACK_PATH}-evil?refreshToken=rt-evil`)
      expect(response.status).toBe(404)
      await Promise.resolve()
      expect(subject.received).toEqual([])
    } finally {
      await subject.close()
    }
  })

  it('refuses an unrelated path without answering it as the redirect', async () => {
    const subject = await listener()
    try {
      const response = await fetch(`http://127.0.0.1:${subject.port}/favicon.ico`)
      expect(response.status).toBe(404)
      expect(subject.received).toEqual([])
    } finally {
      await subject.close()
    }
  })

  it('takes the port from the OS and stops answering once closed', async () => {
    const subject = await listener()
    expect(subject.port).toBeGreaterThan(0)
    await subject.close()
    // Closing twice is not an error: every terminal path of an attempt closes the
    // listener, and a completion that already closed it must not throw.
    await subject.close()
    await expect(fetch(`http://127.0.0.1:${subject.port}${TRAE_CALLBACK_PATH}?refreshToken=rt-late`)).rejects.toThrow()
  })
})
