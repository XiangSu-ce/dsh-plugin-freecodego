// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installNativeModelMenuBadges } from '../src/client/native-model-menu-badges.ts'

afterEach(() => { document.head.innerHTML = ''; document.body.innerHTML = '' })

describe('native model menu badges', () => {
  it('decorates native model rows without replacing their controls', async () => {
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="freecodego"><div id="freecodego">FreeCodeGo</div><button type="button" role="menuitemradio" title="GLM-5.3 Flash"><span class="optionCopy">GLM-5.3 Flash</span></button><button type="button" role="menuitemradio" title="Kimi K3"><span class="optionCopy">Kimi K3</span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [{ id: 'freecodego', name: 'FreeCodeGo', models: [
        { id: 'glm-flash', name: 'GLM-5.3 Flash', description: 'FreeCodeGo · ×0 · health:operational|uptime:100|success:100|traffic:60|latency:18|window:7d|probe:gateway' },
        { id: 'kimi-k3', name: 'Kimi K3', description: 'FreeCodeGo · ×1.5 · health:degraded|uptime:0|success:0|traffic:60|latency:1200|probe:gateway' },
      ] }] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const rows = document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')
    // Pricing and health are not rendered in the picker: a "free" tag beside a
    // row the user is already choosing says nothing actionable, and the rolling
    // probe values are stale by the time a selection is made. A multiplier is
    // kept because it does convey cost.
    // FREE and the route multiplier are owned by the official picker row;
    // this decorator no longer duplicates them.
    expect(rows[0]?.textContent).not.toContain('FREE')
    expect(rows[0]?.textContent).not.toContain('×0')
    expect(rows[0]?.textContent).not.toContain('正常')
    expect(rows[0]?.textContent).not.toContain('18ms')
    expect(rows[1]?.textContent).not.toContain('×1.5')
    expect(rows[1]?.textContent).not.toContain('异常')
    expect(rows[1]?.textContent).not.toContain('1200ms')
    expect(rows[0]?.getAttribute('role')).toBe('menuitemradio')
    expect(rows[0]?.querySelector('[data-fcg-model-menu-badges]')).toBeNull()
    dispose()
  })

  it('keeps training-data classification while exposing an unknown directory probe', async () => {
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="mystery"><div id="mystery">Mystery Provider</div><button type="button" role="menuitemradio" title="Auto"><span class="optionCopy">Auto</span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [{ id: 'logfare', name: 'Mystery Provider', models: [
        { id: 'auto', name: 'Auto', description: 'Mystery Provider · ×0 · tag:training · health:unknown|uptime:12.5|success:0|traffic:1|latency:7|window:1h' },
      ] }] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const row = document.querySelector<HTMLButtonElement>('button[role="menuitemradio"]')
    // Neither the training-data tag nor the health probe is surfaced any more.
    expect(row?.textContent).not.toContain('训练数据')
    expect(row?.textContent).not.toContain('待测')
    expect(row?.textContent).not.toContain('免费')
    dispose()
  })

  it('leaves a free route\u2019s row free of a badge the picker already shows', async () => {
    document.body.innerHTML = '<div data-composer-card><button type="button" aria-haspopup="menu"><span>GLM 5.3 Flash</span></button></div><div role="menu"><section role="group" aria-labelledby="vyce"><div id="vyce">VyceAI</div><button type="button" role="menuitemradio" title="GLM 5.3 Flash"><span class="optionCopy"><span class="modelName">GLM 5.3 Flash</span></span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ current: { provider: 'vyce', model: 'vyce/glm-5.3-flash' }, groups: [{ id: 'vyce', name: 'VyceAI', models: [{ id: 'vyce/glm-5.3-flash', name: 'GLM 5.3 Flash', description: 'VyceAI · ×0 · 免费模型' }] }] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    // A free tag says nothing the user can act on, so the row carries no badge
    // lane at all rather than a duplicate of the picker's own FREE label.
    expect(document.querySelector('[data-fcg-model-menu-badges="true"]')).toBeNull()
    dispose()
  })

  it('hides Logfare Claude rows and strips the provider prefix from visible labels', async () => {
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="mystery"><div id="mystery">Mystery Provider</div><button type="button" role="menuitemradio" title="logfare/claude-opus-4-6"><span class="optionCopy">logfare/claude-opus-4-6</span></button><button type="button" role="menuitemradio" title="logfare/auto"><span class="optionCopy">logfare/auto</span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [{ id: 'logfare', name: 'Mystery Provider', models: [
        { id: 'claude-opus-4-6', name: 'logfare/claude-opus-4-6', description: 'Mystery Provider · ×0' },
        { id: 'logfare/auto', name: 'Auto', description: 'Mystery Provider · ×0' },
      ] }] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const rows = document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')
    expect(rows[0]?.dataset.fcgModelHidden).toBe('true')
    expect(rows[0]?.getAttribute('title')).toBe('logfare/claude-opus-4-6')
    expect(rows[1]?.dataset.fcgModelHidden).toBeUndefined()
    expect(rows[1]?.textContent).toContain('Auto')
    expect(rows[1]?.textContent).not.toContain('logfare/')
    expect(rows[1]?.getAttribute('title')).toBe('logfare/auto')
    dispose()
  })

  it('collapses provider rows by default and toggles them from their headings', async () => {
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="active"><div id="active">Active</div><button type="button" role="menuitemradio" aria-checked="true" title="A"><span class="optionCopy">A</span></button></section><section role="group" aria-labelledby="other"><div id="other">Other</div><button type="button" role="menuitemradio" title="B"><span class="optionCopy">B</span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [
        { id: 'active', name: 'Active', models: [{ id: 'a', name: 'A', description: 'Active · ×0' }] },
        { id: 'other', name: 'Other', models: [{ id: 'b', name: 'B', description: 'Other · ×0' }] },
      ] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const other = document.getElementById('other')!
    expect(other.getAttribute('aria-expanded')).toBe('false')
    expect(other.closest('section')?.getAttribute('data-fcg-provider-collapsed')).toBe('true')
    expect(other.querySelector('[data-fcg-provider-count]')).toBeNull()
    expect(other.querySelector('[data-fcg-provider-chevron]')?.getAttribute('data-open')).toBe('false')
    other.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(other.getAttribute('aria-expanded')).toBe('true')
    expect(other.closest('section')?.getAttribute('data-fcg-provider-collapsed')).toBe('false')
    expect(other.querySelector('[data-fcg-provider-chevron]')?.getAttribute('data-open')).toBe('true')
    dispose()
  })

  it('disables a credential-gated native row and gives the user the required setup', async () => {
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="sensenova"><div id="sensenova">SenseNova</div><button type="button" role="menuitemradio" title="SenseNova 6.8 Flash Lite"><span class="optionCopy">SenseNova 6.8 Flash Lite</span></button></section></div>'
    const availability = new Map([['sensenova\u0000sensenova-6.8-flash-lite', { available: false, reason: 'SENSENOVA_API_KEY_REQUIRED' }]])
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      availability: () => availability,
      snapshot: () => ({ groups: [{ id: 'sensenova', name: 'SenseNova', models: [
        { id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash Lite', description: 'SenseNova · ×0 · health:operational|uptime:100|success:100|traffic:0|latency:na' },
      ] }] }),
    })

    await new Promise(resolve => requestAnimationFrame(resolve))
    const row = document.querySelector<HTMLButtonElement>('button[role="menuitemradio"]')
    expect(row?.disabled).toBe(true)
    expect(row?.getAttribute('aria-disabled')).toBe('true')
    expect(row?.getAttribute('title')).toBe('请先在设置中填写 SenseNova API Key')
    expect(row?.textContent).toContain('需配置')

    availability.set('sensenova\u0000sensenova-6.8-flash-lite', { available: true, reason: '' })
    document.dispatchEvent(new Event('fcg:model-availability-updated'))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(row?.disabled).toBe(false)
    expect(row?.getAttribute('title')).toBe('SenseNova 6.8 Flash Lite')
    dispose()
  })

  it('names the NVIDIA key on its own missing-credential row, like SenseNova', async () => {
    // NVIDIA shares SenseNova's listing path: with no key configured the host
    // advertises its static free roster as unavailable with `NVIDIA_API_KEY_REQUIRED`
    // (`managed-catalogs.ts`), so the row is a hard gate whose tooltip is the only
    // place that can say which key to add. Before this case existed the wording fell
    // to the generic "unavailable", while the sibling provider named its own key.
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="nvidia"><div id="nvidia">NVIDIA</div><button type="button" role="menuitemradio" title="Kimi K3"><span class="optionCopy">Kimi K3</span></button></section></div>'
    const availability = new Map([['nvidia\u0000moonshotai/kimi-k3', { available: false, reason: 'NVIDIA_API_KEY_REQUIRED' }]])
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      availability: () => availability,
      snapshot: () => ({ groups: [{ id: 'nvidia', name: 'NVIDIA', models: [
        { id: 'moonshotai/kimi-k3', name: 'Kimi K3', description: 'NVIDIA · ×0 · free' },
      ] }] }),
    })

    await new Promise(resolve => requestAnimationFrame(resolve))
    const row = document.querySelector<HTMLButtonElement>('button[role="menuitemradio"]')
    expect(row?.disabled).toBe(true)
    expect(row?.getAttribute('title')).toBe('请先在设置中填写 NVIDIA API Key')
    expect(row?.textContent).toContain('需配置')
    dispose()
  })

  it('marks a refused credential as rejected, not as needing setup', async () => {
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="sensenova"><div id="sensenova">SenseNova</div><button type="button" role="menuitemradio" title="SenseNova 6.8 Flash Lite"><span class="optionCopy">SenseNova 6.8 Flash Lite</span></button></section></div>'
    const availability = new Map([
      ['sensenova\u0000sensenova-6.8-flash-lite', { available: false, reason: 'SENSENOVA_API_KEY_REJECTED' }],
      ['nvidia\u0000moonshotai/kimi-k3', { available: false, reason: 'NVIDIA_API_KEY_REJECTED' }],
    ])
    const groups = [
      { id: 'sensenova', name: 'SenseNova', models: [{ id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash Lite', description: 'SenseNova · ×0 · health:operational' }] },
      { id: 'nvidia', name: 'NVIDIA', models: [{ id: 'moonshotai/kimi-k3', name: 'Kimi K3', description: 'NVIDIA · ×0 · free' }] },
    ]
    // Each install is disposed in a `finally`: a leaked decorator keeps
    // listening for availability updates and rewrites the rows of the next test.
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      availability: () => availability,
      snapshot: () => ({ groups }),
    })
    try {
      await new Promise(resolve => requestAnimationFrame(resolve))
      const rows = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')]
      for (const row of rows) {
        // The key is configured and the provider refused it, so the row stays a
        // hard gate while the wording points at replacing the key.
        expect(row.disabled).toBe(true)
        expect(row.textContent).toContain('凭据被拒')
        expect(row.textContent).not.toContain('需配置')
        expect(row.getAttribute('title')).toContain('更换')
      }
    } finally {
      dispose()
    }

    const english = installNativeModelMenuBadges({
      language: () => 'en',
      availability: () => availability,
      snapshot: () => ({ groups }),
    })
    try {
      await new Promise(resolve => requestAnimationFrame(resolve))
      const first = document.querySelector<HTMLButtonElement>('button[role="menuitemradio"]')
      expect(first?.textContent).toContain('KEY REJECTED')
      expect(first?.getAttribute('title')).toContain('rejected this API key')
    } finally {
      english()
    }
  })

  it('points a training-data hold at the consent switch, not at the key field', async () => {
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="logfare"><div id="logfare">Logfare</div><button type="button" role="menuitemradio" title="Logfare Auto"><span class="optionCopy">Logfare Auto</span></button></section></div>'
    const availability = new Map([['logfare\u0000logfare-auto', { available: false, reason: 'LOGFARE_PREMIUM_OPT_IN_REQUIRED' }]])
    const snapshot = () => ({ groups: [{ id: 'logfare', name: 'Logfare', models: [
      { id: 'logfare-auto', name: 'Logfare Auto', description: 'logfare · ×0 · tag:training' },
    ] }] })
    // The row is a hard gate: the user has to change a setting before this route
    // works, and the picker disables the row, so the producer's own thrown error
    // (which names the consent switch) can never be reached. The tooltip is the
    // only place that can say what to do, and the generic "unavailable" wording
    // sends them looking for a key that is already configured.
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      availability: () => availability,
      snapshot,
    })
    try {
      await new Promise(resolve => requestAnimationFrame(resolve))
      const row = document.querySelector<HTMLButtonElement>('button[role="menuitemradio"]')
      expect(row?.disabled).toBe(true)
      expect(row?.getAttribute('title')).toContain('训练数据授权')
      expect(row?.getAttribute('title')).not.toBe('此模型当前不可用')
    } finally {
      dispose()
    }

    const english = installNativeModelMenuBadges({
      language: () => 'en',
      availability: () => availability,
      snapshot,
    })
    try {
      await new Promise(resolve => requestAnimationFrame(resolve))
      const row = document.querySelector<HTMLButtonElement>('button[role="menuitemradio"]')
      expect(row?.getAttribute('title')).toContain('training-data consent')
    } finally {
      english()
    }
  })

  it('marks a Cline route that spent its free budget as limited, not as needing setup', async () => {
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="cline"><div id="cline">Cline</div><button type="button" role="menuitemradio" title="DeepSeek V4 Flash"><span class="optionCopy">DeepSeek V4 Flash</span></button></section></div>'
    const availability = new Map([['cline\u0000deepseek/deepseek-v4-flash', { available: false, reason: 'CLINE_MODEL_RATE_LIMITED' }]])
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      availability: () => availability,
      snapshot: () => ({ groups: [{ id: 'cline', name: 'Cline', models: [
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Cline · 免费模型' },
      ] }] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const row = document.querySelector<HTMLButtonElement>('button[role="menuitemradio"]')
    // Free budgets reset on the upstream's schedule while this snapshot is taken
    // when the catalog loads, so a spent budget advises instead of gating: the
    // badge and tooltip explain the state, and the row stays selectable.
    expect(row?.disabled).toBe(false)
    expect(row?.getAttribute('aria-disabled')).toBeNull()
    expect(row?.textContent).toContain('限流')
    expect(row?.textContent).not.toContain('需配置')
    expect(row?.getAttribute('title')).toContain('额度按模型计算')

    // A missing credential is still a hard gate: that one cannot fix itself.
    availability.set('cline\u0000deepseek/deepseek-v4-flash', { available: false, reason: 'CLINE_LOGIN_REQUIRED' })
    document.dispatchEvent(new Event('fcg:model-availability-updated'))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(row?.disabled).toBe(true)
    expect(row?.getAttribute('aria-disabled')).toBe('true')
    availability.set('cline\u0000deepseek/deepseek-v4-flash', { available: true, reason: '' })
    document.dispatchEvent(new Event('fcg:model-availability-updated'))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(row?.disabled).toBe(false)
    dispose()
  })

  it('disables the row of a locked backend group and keeps its siblings usable', async () => {
    // The dialog lists one row per backend group, so a group the account cannot
    // bill through must be explained on its own row — while the same model stays
    // selectable in the groups the account is entitled to.
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="freecodego"><div id="freecodego">FreeCodeGo</div><button type="button" role="menuitemradio" title="GPT 5.6 · 后端分组甲"><span class="optionCopy">GPT 5.6 · 后端分组甲</span></button><button type="button" role="menuitemradio" title="GPT 5.6 · 后端分组·受限"><span class="optionCopy">GPT 5.6 · 后端分组·受限</span></button></section></div>'
    const availability = new Map([
      ['freecodego\u0000gpt-5.6@group:1', { available: true }],
      ['freecodego\u0000gpt-5.6@group:2', { available: false, reason: 'FREECODEGO_GROUP_LOCKED' }],
    ])
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      availability: () => availability,
      snapshot: () => ({ groups: [{ id: 'freecodego', name: 'FreeCodeGo', models: [
        { id: 'gpt-5.6@group:1', name: 'GPT 5.6 · 后端分组甲', description: '后端分组甲 · ×0' },
        { id: 'gpt-5.6@group:2', name: 'GPT 5.6 · 后端分组·受限', description: '后端分组·受限 · ×1' },
      ] }] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const rows = document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')
    expect(rows[0]?.disabled).toBe(false)
    expect(rows[1]?.disabled).toBe(true)
    expect(rows[1]?.getAttribute('title')).toBe('该分组需解锁后才能使用')
    // Not the generic "需配置": a locked group is not a missing credential, and
    // sending the user to Settings would leave nothing there to fix.
    expect(rows[1]?.textContent).toContain('需解锁')
    expect(rows[1]?.textContent).not.toContain('需配置')
    dispose()
  })

  it('marks a route whose provider health is degraded as temporarily unavailable, not as needing setup', async () => {
    // Both codes are health readings, not absent configuration: logfare reports
    // zero uptime for the current 1h window, OpenCode reports `degraded`. The
    // provider is configured and its other models stay usable, so "setup
    // required" would send the user to a settings page with nothing to change.
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="logfare"><div id="logfare">logfare</div><button type="button" role="menuitemradio" title="logfare/glm-5.3"><span class="optionCopy">logfare/glm-5.3</span></button></section><section role="group" aria-labelledby="opencode"><div id="opencode">OpenCode</div><button type="button" role="menuitemradio" title="Kimi K2.6"><span class="optionCopy">Kimi K2.6</span></button></section></div>'
    const availability = new Map([
      ['logfare\u0000glm-5.3', { available: false, reason: 'MODEL_PROVIDER_DEGRADED' }],
      ['opencode\u0000kimi-k2.6', { available: false, reason: 'OPENCODE_MODEL_UNAVAILABLE' }],
    ])
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      availability: () => availability,
      snapshot: () => ({ groups: [
        { id: 'logfare', name: 'logfare', models: [
          { id: 'glm-5.3', name: 'logfare/glm-5.3', description: 'logfare · ×0 · health:degraded|uptime:0|success:0|traffic:60|latency:1200|window:1h' },
        ] },
        { id: 'opencode', name: 'OpenCode', models: [
          { id: 'kimi-k2.6', name: 'Kimi K2.6', description: 'OpenCode · ×0 · health:degraded|uptime:19.4|success:0|traffic:0|latency:na' },
        ] },
      ] }),
    })

    await new Promise(resolve => requestAnimationFrame(resolve))
    const rows = document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')
    // The host's own intent: a zero-uptime report for the current window makes
    // the route non-selectable, so the row is a real gate and greys out.
    expect(rows[0]?.disabled).toBe(true)
    expect(rows[0]?.getAttribute('aria-disabled')).toBe('true')
    expect(rows[0]?.dataset.fcgModelUnavailable).toBe('true')
    expect(rows[0]?.textContent).toContain('暂不可选')
    expect(rows[0]?.textContent).not.toContain('需配置')
    expect(rows[0]?.getAttribute('title')).toBe('该模型当前服务异常，请稍后重试或选择其他模型')
    expect(rows[1]?.textContent).toContain('暂不可选')
    expect(rows[1]?.textContent).not.toContain('需配置')

    availability.set('logfare\u0000glm-5.3', { available: true, reason: '' })
    document.dispatchEvent(new Event('fcg:model-availability-updated'))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(rows[0]?.disabled).toBe(false)
    expect(rows[0]?.getAttribute('title')).toBe('logfare/glm-5.3')
    dispose()
  })

  it('does nothing when a native row cannot be mapped uniquely', async () => {
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="freecodego"><div id="freecodego">FreeCodeGo</div><button type="button" role="menuitemradio" title="Duplicate"><span class="optionCopy">Duplicate</span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'en',
      snapshot: () => ({ groups: [
        { id: 'one', name: 'One', models: [{ id: 'one', name: 'Duplicate', description: 'One · ×0' }] },
        { id: 'two', name: 'Two', models: [{ id: 'two', name: 'Duplicate', description: 'Two · ×0' }] },
      ] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(document.querySelector('[data-fcg-model-menu-badges]')).toBeNull()
    dispose()
  })

  it('binds one collapse toggle per resolvable provider', async () => {
    // A section resolves to its provider by the heading id suffix first, so two
    // distinct providers each get their own toggle. Both groups are collapsed,
    // and clicking a heading expands only that one.
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="m-freecodego"><div id="m-freecodego">FreeCodeGo</div><button type="button" role="menuitemradio" title="gpt 5.6 terra"><span class="optionCopy">gpt 5.6 terra</span></button></section><section role="group" aria-labelledby="m-agnes"><div id="m-agnes">Agnes AI</div><button type="button" role="menuitemradio" title="agnes-model"><span class="optionCopy">agnes-model</span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [
        { id: 'freecodego', name: 'FreeCodeGo', models: [{ id: 'gpt-5.6-terra', name: 'gpt 5.6 terra', description: 'FreeCodeGo · ×0.04' }] },
        { id: 'agnes', name: 'Agnes AI', models: [{ id: 'agnes-model', name: 'agnes-model', description: 'Agnes AI · ×0' }] },
      ] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const headings = document.querySelectorAll<HTMLElement>('[data-fcg-provider-toggle]')
    expect([...headings].map(heading => heading.dataset.fcgProviderToggle)).toEqual(['freecodego', 'agnes'])
    for (const heading of headings) {
      expect(heading.getAttribute('role')).toBe('button')
      expect(heading.getAttribute('aria-expanded')).toBe('false')
    }
    document.getElementById('m-freecodego')!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(document.getElementById('m-freecodego')!.getAttribute('aria-expanded')).toBe('true')
    // The other provider's group is untouched by that click.
    expect(document.getElementById('m-agnes')!.getAttribute('aria-expanded')).toBe('false')
    dispose()
  })

  it('moves a gateway row\u2019s billing group onto its own line under the model name', async () => {
    // The gateway serves one row per (model, group) and composes the label as
    // `<model> · <group>`. On one line the group was the ellipsized tail, so the
    // row never said which group it bills through. Splitting is scoped to the
    // gateway provider: every other provider keeps its label verbatim.
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="m-freecodego"><div id="m-freecodego">FreeCodeGo</div><button type="button" role="menuitemradio" title="claude sonnet 5 · Claude-AWS"><span class="optionCopy"><span class="modelName">claude sonnet 5 · Claude-AWS</span></span></button></section><section role="group" aria-labelledby="m-sensenova"><div id="m-sensenova">SenseNova</div><button type="button" role="menuitemradio" title="hy3 · Pro"><span class="optionCopy"><span class="modelName">hy3 · Pro</span></span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [
        { id: 'freecodego', name: 'FreeCodeGo', models: [{ id: 'claude-sonnet-5', name: 'claude sonnet 5 · Claude-AWS', description: 'Claude-AWS · ×0.1' }] },
        { id: 'sensenova', name: 'SenseNova', models: [{ id: 'sensenova/hy3', name: 'hy3 · Pro', description: 'SenseNova · ×0' }] },
      ] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const gatewayRow = document.querySelector<HTMLElement>('button[title="claude sonnet 5 · Claude-AWS"]')!
    const gatewayName = gatewayRow.querySelector<HTMLElement>('[data-fcg-model-visible-label], [class*=modelName]')!
    const gatewayGroup = gatewayRow.querySelector<HTMLElement>('[data-fcg-model-group]')
    expect(gatewayName.textContent).toBe('claude sonnet 5')
    expect(gatewayGroup?.textContent).toBe('Claude-AWS')
    // The tooltip keeps the full identity, so hover still names the group.
    expect(gatewayRow.title).toBe('claude sonnet 5 · Claude-AWS')
    // Another provider's label is untouched end to end.
    const otherRow = document.querySelector<HTMLElement>('button[title="hy3 · Pro"]')!
    expect(otherRow.querySelector('[data-fcg-model-group]')).toBeNull()
    expect(otherRow.querySelector<HTMLElement>('[class*=modelName]')!.textContent).toBe('hy3 · Pro')
    dispose()
  })

  it('gives each configured provider its own accent and greys a provider whose whole roster is unconfigured', async () => {
    // Providers used to render in the same primary ink as their model rows, so
    // the heading carried no signal. A configured provider gets its own hue;
    // a provider with no usable route greys out while staying expandable.
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="m-vyce"><div id="m-vyce">VyceAI</div><button type="button" role="menuitemradio" title="vyce/deepseek-v4.1"><span class="optionCopy">vyce/deepseek-v4.1</span></button></section><section role="group" aria-labelledby="m-sensenova"><div id="m-sensenova">SenseNova</div><button type="button" role="menuitemradio" title="sensenova/hy3"><span class="optionCopy">sensenova/hy3</span></button></section></div>'
    const availability = new Map([
      ['vyce\u0000vyce/deepseek-v4.1', { available: true }],
      ['sensenova\u0000sensenova/hy3', { available: false, reason: 'SENSENOVA_API_KEY_REQUIRED' }],
    ])
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      availability: () => availability,
      snapshot: () => ({ groups: [
        { id: 'vyce', name: 'VyceAI', models: [{ id: 'vyce/deepseek-v4.1', name: 'vyce/deepseek-v4.1', description: 'VyceAI · $0.15/$0.6' }] },
        { id: 'sensenova', name: 'SenseNova', models: [{ id: 'sensenova/hy3', name: 'sensenova/hy3', description: 'SenseNova · ×0 · 免费模型' }] },
      ] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const vyce = document.getElementById('m-vyce') as HTMLElement
    const sensenova = document.getElementById('m-sensenova') as HTMLElement
    // Configured: the provider's own accent, not the tertiary grey.
    expect(vyce.dataset.fcgProviderUnavailable).toBe('false')
    expect(vyce.style.getPropertyValue('--fcg-provider-accent')).toBe('#7c3aed')
    expect(vyce.querySelector('[data-fcg-provider-dot]')).toBeTruthy()
    // Unconfigured: grey heading, still a live collapse toggle.
    expect(sensenova.dataset.fcgProviderUnavailable).toBe('true')
    expect(sensenova.style.getPropertyValue('--fcg-provider-accent')).toContain('tertiary')
    expect(sensenova.dataset.fcgProviderToggle).toBe('sensenova')
    expect(sensenova.getAttribute('aria-expanded')).toBe('false')
    sensenova.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(sensenova.getAttribute('aria-expanded')).toBe('true')
    dispose()
  })

  it('binds no toggle when a duplicated display name is the only way to resolve a section', async () => {
    // Fallback resolution is by display name, and a duplicate name is genuinely
    // ambiguous. The guard has to skip those sections rather than assert one of
    // them: binding the toggle to the wrong provider would collapse the group
    // the user did not touch. The heading ids here are deliberately unresolvable
    // so the name lookup is the only path left.
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="m-one"><div id="m-one">FreeCodeGo</div><button type="button" role="menuitemradio" title="first-model"><span class="optionCopy">first-model</span></button></section><section role="group" aria-labelledby="m-two"><div id="m-two">FreeCodeGo</div><button type="button" role="menuitemradio" title="second-model"><span class="optionCopy">second-model</span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [
        { id: 'alpha', name: 'FreeCodeGo', models: [{ id: 'first-model', name: 'first-model', description: 'FreeCodeGo · ×1' }] },
        { id: 'beta', name: 'FreeCodeGo', models: [{ id: 'second-model', name: 'second-model', description: 'FreeCodeGo · ×1' }] },
      ] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(document.querySelectorAll('[data-fcg-provider-toggle]')).toHaveLength(0)
    // Both rows survive: skipping the decoration must not hide a model.
    expect(document.querySelectorAll('button[role="menuitemradio"]').length).toBe(2)
    dispose()
  })

  it('pins the menu at its collapsed width so expanding a provider does not widen it', async () => {
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="active"><div id="active">Active</div><button type="button" role="menuitemradio" title="A very long model name that would widen the menu"><span class="optionCopy">A very long model name</span></button></section></div>'
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({ width: 264 } as DOMRect)
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [{ id: 'active', name: 'Active', models: [
        { id: 'a', name: 'A very long model name', description: 'Active · ×0' },
      ] }] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(menu.style.width).toBe('264px')
    expect(menu.dataset.fcgWidthPinned).toBe('true')

    document.getElementById('active')!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(document.getElementById('active')!.getAttribute('aria-expanded')).toBe('true')
    expect(menu.style.width).toBe('264px')
    dispose()
  })

  it('leaves menus without provider toggles unmeasured and unpinned', async () => {
    document.body.innerHTML = '<div role="menu"><button type="button" role="menuitem" title="Plain action">Plain action</button></div>'
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    const measure = vi.spyOn(menu, 'getBoundingClientRect')
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(measure).not.toHaveBeenCalled()
    expect(menu.style.width).toBe('')
    expect(menu.dataset.fcgWidthPinned).toBeUndefined()
    dispose()
  })

  it('sinks user-configured providers below every built-in and keeps the gateway first', async () => {
    // The picker renders groups in adapter registration order, so a custom
    // provider registered before the built-ins used to sit above FreeCodeGo.
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="m-kira"><div id="m-kira">基拉</div><button type="button" role="menuitemradio" title="kira-model"><span class="optionCopy">kira-model</span></button></section><section role="group" aria-labelledby="m-freecodego"><div id="m-freecodego">FreeCodeGo</div><button type="button" role="menuitemradio" title="gateway-model"><span class="optionCopy">gateway-model</span></button></section><section role="group" aria-labelledby="m-sensenova"><div id="m-sensenova">SenseNova</div><button type="button" role="menuitemradio" title="sensenova-model"><span class="optionCopy">sensenova-model</span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [
        { id: 'kira', name: '基拉', models: [{ id: 'kira-model', name: 'kira-model', description: '基拉 · ×0' }] },
        { id: 'freecodego', name: 'FreeCodeGo', models: [{ id: 'gateway-model', name: 'gateway-model', description: 'FreeCodeGo · ×0.04' }] },
        { id: 'sensenova', name: 'SenseNova', models: [{ id: 'sensenova-model', name: 'sensenova-model', description: 'SenseNova · ×0 · 免费模型' }] },
      ] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const order = [...document.querySelectorAll('[role="menu"] > section[role="group"]')]
      .map(section => section.getAttribute('aria-labelledby'))
    expect(order).toEqual(['m-freecodego', 'm-sensenova', 'm-kira'])
    dispose()
  })

  it('strips the native FREE lane from user-configured provider rows', async () => {
    // A custom provider's billing is unknown to the plugin, so neither FREE
    // nor a multiplier may be asserted for its rows. The picker derives those
    // labels from the description; the decorator clears the lane it renders.
    document.body.innerHTML = '<div role="menu"><section role="group" aria-labelledby="m-kira"><div id="m-kira">基拉</div><button type="button" role="menuitemradio" title="glm-5.3-free"><span class="optionCopy">glm-5.3-free</span><span class="optionMeta"><span class="modelRate modelFree">FREE</span></span></button></section></div>'
    const dispose = installNativeModelMenuBadges({
      language: () => 'zh',
      snapshot: () => ({ groups: [
        { id: 'kira', name: '基拉', models: [{ id: 'glm-5.3-free', name: 'glm-5.3-free', description: '基拉 · ×0' }] },
      ] }),
    })
    await new Promise(resolve => requestAnimationFrame(resolve))
    const row = document.querySelector<HTMLButtonElement>('button[role="menuitemradio"]')!
    expect(row.querySelector('[class*="optionMeta"]')?.childElementCount).toBe(0)
    expect(row.textContent).not.toContain('FREE')
    dispose()
  })

})
