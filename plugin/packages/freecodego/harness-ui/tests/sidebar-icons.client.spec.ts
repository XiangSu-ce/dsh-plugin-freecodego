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

  // Regression: "FreeCodeGo 网关账单" is the gateway tab of the token-usage
  // panel, and it matched the `freecodego` entry by prefix. Decorating it grew
  // the segmented control by a 27px glyph and a 10px gap, which is the header
  // the panel below no longer lined up with.
  it('leaves segmented-control tabs inside a tablist undecorated', () => {
    document.body.innerHTML = '<div role="tablist"><button type="button" role="tab">FreeCodeGo 网关账单</button><button type="button" role="tab">本地 Harness 用量</button></div>'
    const dispose = installFreeCodeGoSidebarIcons()

    expect(document.querySelector('[data-fcg-semantic-entry]')).toBe(null)
    expect(document.querySelector('[data-fcg-icon]')).toBe(null)

    dispose()
  })

  // The skip is structural, not a narrowing of the label list: a navigation
  // entry whose label carries a badge suffix is still decorated.
  it('still decorates a navigation entry whose label carries a suffix', () => {
    document.body.innerHTML = '<button type="button">FreeCodeGo 3</button>'
    const dispose = installFreeCodeGoSidebarIcons()

    expect(document.querySelector('[data-fcg-icon="freecodego"] svg')).toBeTruthy()

    dispose()
  })
})
