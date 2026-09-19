// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installFreeCodeGoSidebarIcons } from '../src/client/sidebar-icons.ts'

afterEach(() => {
  document.head.querySelector('[data-fcg-sidebar-icon-style]')?.remove()
  document.body.replaceChildren()
})

describe('FreeCodeGo sidebar icons', () => {
  it('adds matching pixel icons to settings navigation entries', () => {
    document.body.innerHTML = '<button type="button">通用设置</button><button type="button">模型</button><button type="button">插件</button><button type="button">Agent 预设</button>'
    const dispose = installFreeCodeGoSidebarIcons()

    expect(document.querySelector('[data-fcg-icon="settings"] svg')).toBeTruthy()
    expect(document.querySelector('[data-fcg-icon="models"] svg')).toBeTruthy()
    expect(document.querySelector('[data-fcg-icon="plugin"] svg')).toBeTruthy()
    expect(document.querySelector('[data-fcg-icon="agentPreset"] svg')).toBeTruthy()

    dispose()
  })
})
