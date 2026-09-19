// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceInputButton } from '../src/client/voice-input.tsx'

const originalMediaDevices = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices')
const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder')
const originalLanguage = globalThis.document.documentElement.lang

afterEach(() => {
  cleanup()
  if (originalMediaDevices === undefined) delete (globalThis.navigator as { mediaDevices?: unknown }).mediaDevices
  else Object.defineProperty(globalThis.navigator, 'mediaDevices', originalMediaDevices)
  if (originalMediaRecorder === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder
  else Object.defineProperty(globalThis, 'MediaRecorder', originalMediaRecorder)
  globalThis.document.documentElement.lang = originalLanguage
})

describe('VoiceInputButton capture lifecycle', () => {
  it('uses English accessible labels when the current page language is English', async () => {
    globalThis.document.documentElement.lang = 'en'
    render(<VoiceInputButton isEnabled={async () => true} transcribe={undefined} />)
    expect(await screen.findByRole('button', { name: 'Voice input' })).toBeTruthy()
  })

  it('releases a late microphone stream when the user stops before permission resolves', async () => {
    const permission = Promise.withResolvers<MediaStream>()
    const getUserMedia = vi.fn(() => permission.promise)
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    const constructed: unknown[] = []
    class FakeMediaRecorder {
      constructor(_stream: MediaStream) { constructed.push(this) }
      start(): void {}
      stop(): void {}
    }
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder })
    const transcribe = vi.fn()
    render(<VoiceInputButton isEnabled={async () => true} transcribe={transcribe} />)

    const begin = await screen.findByRole('button', { name: '语音输入' })
    fireEvent.click(begin)
    expect(await screen.findByRole('button', { name: '结束语音输入' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '结束语音输入' }))
    await act(async () => { permission.resolve(stream); await Promise.resolve() })

    await waitFor(() => { expect(stop).toHaveBeenCalledOnce() })
    expect(constructed).toHaveLength(0)
    expect(transcribe).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '语音输入' })).toBeTruthy()
  })
})
