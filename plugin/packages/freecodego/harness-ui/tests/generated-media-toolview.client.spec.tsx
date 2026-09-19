// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GeneratedMediaToolView } from '../src/client/generated-media-toolview.tsx'

describe('GeneratedMediaToolView', () => {
  it('renders a generated attachment returned by the image tool', async () => {
    const attachment = { attachmentId: 'att-generated', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
    render(<GeneratedMediaToolView
      toolName="agnes_generate_image"
      block={{ kind: 'settled', content: [{ type: 'text', text: '{"model":"gpt-image-2"}' }, { type: 'image', attachment }] }}
      loadImage={vi.fn().mockResolvedValue('blob:http://localhost/generated')}
    />)
    await waitFor(() => { expect(screen.getByRole('img', { name: '图片生成 1' }).getAttribute('src')).toBe('blob:http://localhost/generated') })
  })

  it('renders a playable URL returned by the video tool', () => {
    render(<GeneratedMediaToolView
      toolName="freecodego_generate_video"
      block={{ kind: 'settled', content: [{ type: 'text', text: '{"model":"veo-3","status":"completed","url":"https://cdn.example/video.mp4"}' }] }}
      loadImage={vi.fn()}
    />)
    expect(document.querySelector('video')?.getAttribute('src')).toBe('https://cdn.example/video.mp4')
  })
})
