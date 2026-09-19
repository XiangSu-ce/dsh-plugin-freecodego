/** Plugin-owned semantic icon layer for FreeCodeGo settings entries. */

type IconName = 'freecodego' | 'settings' | 'models' | 'plugin' | 'agentPreset' | 'mcp' | 'skills' | 'advisor' | 'engineering' | 'tokenUsage'

/**
 * The settings entries this layer decorates, keyed by the label the official
 * shell renders.
 *
 * The shell puts no id, route or key on its navigation buttons, so the rendered
 * label is the only signal available. Each entry lists every translation the
 * pinned shell ships; a label the shell adds later leaves that entry without a
 * semantic icon rather than mismatching a different one. Matching is exact, or a
 * prefix ending on a word boundary — never a bare `startsWith`, which would let
 * a longer label capture a shorter entry's icon. A decorated entry is stamped
 * with `data-fcg-semantic-entry`, so no later pass decorates it twice.
 */
const targets: readonly { readonly name: IconName; readonly labels: readonly string[] }[] = [
  { name: 'freecodego', labels: ['FreeCodeGo'] },
  { name: 'settings', labels: ['通用设置', 'General settings', 'General Settings'] },
  { name: 'models', labels: ['模型', 'Models'] },
  { name: 'plugin', labels: ['插件', 'Plugins'] },
  { name: 'agentPreset', labels: ['Agent 预设', 'Agent presets', 'Agent Presets'] },
  { name: 'mcp', labels: ['MCP'] },
  { name: 'skills', labels: ['Skills'] },
  { name: 'advisor', labels: ['Advisor'] },
  { name: 'engineering', labels: ['工程增强', 'Engineering'] },
  { name: 'tokenUsage', labels: ['Token 消耗', 'Token usage'] },
]

const glyphs: Record<IconName, string> = {
  freecodego: '<path fill="#438de7" d="M2 15h4v-5h4V7h12v3h4V4h3v8h-3v5h-4v4h-7v3h-6v-3H6v-3H2z"/><path fill="#82d5ff" d="M7 17h14v3h-5v2h-5v-2H7z"/><rect fill="#fff" x="17" y="10" width="4" height="2"/><rect fill="#17232b" x="19" y="10" width="1" height="1"/>',
  settings: '<path fill="#4d99f5" d="M12 2h8v4h5v5h5v10h-5v5h-5v4h-8v-4H7v-5H2V11h5V6h5z"/><path fill="#9cdbff" d="M14 8h4v3h4v4h3v4h-3v4h-4v3h-4v-3h-4v-4H7v-4h3v-4h4z"/><rect fill="#24334b" x="14" y="14" width="4" height="4"/><rect fill="#fff3a6" x="15" y="15" width="2" height="2"/>',
  models: '<path fill="#7255bd" d="M5 6h22v6H5zM3 14h26v6H3zM5 22h22v6H5z"/><path fill="#b69dff" d="M8 8h16v2H8zM6 16h20v2H6zM8 24h16v2H8z"/><rect fill="#ffcc61" x="26" y="3" width="4" height="4"/><rect fill="#6ee0d6" x="27" y="26" width="4" height="4"/>',
  plugin: '<path fill="#ef6e45" d="M8 2h11v6h5v5h6v11h-6v6H13v-6H8v-5H2V8h6z"/><path fill="#ffbe5c" d="M11 6h5v5h5v5h5v5h-5v5h-5v-5h-5v-5H6v-5h5z"/><rect fill="#fff0bd" x="13" y="9" width="3" height="3"/><rect fill="#fff0bd" x="21" y="17" width="3" height="3"/><rect fill="#24334b" x="14" y="10" width="1" height="1"/><rect fill="#24334b" x="22" y="18" width="1" height="1"/>',
  agentPreset: '<rect fill="#2e9787" x="3" y="13" width="8" height="8"/><rect fill="#5bd5bd" x="5" y="15" width="4" height="4"/><rect fill="#3d7fd6" x="21" y="3" width="8" height="8"/><rect fill="#9ed6ff" x="23" y="5" width="4" height="4"/><rect fill="#e46c61" x="21" y="21" width="8" height="8"/><rect fill="#ffc06b" x="23" y="23" width="4" height="4"/><path fill="none" stroke="#34455b" stroke-width="3" d="M11 17h7m0-8v5m0 6v5"/><rect fill="#fff2a4" x="15" y="14" width="6" height="6"/><rect fill="#34455b" x="17" y="16" width="2" height="2"/>',
  mcp: '<path fill="#ef8b32" d="M2 14h8v10H2z"/><path fill="#ffd16a" d="M4 17h4v3H4z"/><path fill="none" stroke="#fff4d6" stroke-width="2" d="M10 19h7m0-8v8m0-8h7m-7 8h7"/><rect fill="#53a7ff" x="24" y="8" width="7" height="7"/><rect fill="#25d5c2" x="24" y="22" width="7" height="7"/>',
  skills: '<path fill="#8463df" d="M3 11h12v16H3z"/><path fill="#b89cff" d="M15 11h14v16H15z"/><path fill="none" stroke="#f0e8ff" stroke-width="2" d="M15 13v14M6 16h6m-6 5h6m12-5h3m-3 5h3"/><path fill="#ffc855" d="M23 2h3v5h5v3h-5v5h-3v-5h-5V7h5z"/>',
  advisor: '<path fill="#78dcbf" d="M2 7h28v18H17l-5 5v-5H2z"/><path fill="none" stroke="#c8ffeb" stroke-width="2" d="M2 7h28v18H17l-5 5v-5H2z"/><path fill="#1c957d" d="M7 14h18v5H7z"/><rect fill="#fff" x="12" y="15" width="8" height="2"/><rect fill="#17232b" x="15" y="15" width="2" height="2"/><rect fill="#ffc855" x="4" y="3" width="4" height="4"/>',
  engineering: '<path fill="#ff805e" d="M4 4h9v6l-3 3 8 8-5 5-8-8-3 3H0v-9l4-4-3-3z"/><path fill="none" stroke="#ffd2c7" stroke-width="2" d="M4 4h9v6l-3 3 8 8-5 5-8-8-3 3H0v-9l4-4-3-3z"/><rect fill="#4d99f5" x="22" y="4" width="8" height="8"/><rect fill="#4d99f5" x="22" y="22" width="8" height="8"/><path fill="none" stroke="#b9e1ff" stroke-width="2" d="M18 8h4m-4 18h4"/>',
  tokenUsage: '<rect fill="#3d7fd6" x="3" y="18" width="5" height="11"/><rect fill="#5cc8b1" x="11" y="11" width="5" height="18"/><rect fill="#ef9b4a" x="19" y="4" width="5" height="25"/><path fill="none" stroke="#24334b" stroke-width="2" d="M2 30h24"/><rect fill="#fff3a6" x="26" y="7" width="4" height="4"/><path fill="none" stroke="#24334b" stroke-width="2" d="M28 11v14"/>',
}

function semanticIcon(name: IconName): HTMLSpanElement {
  const wrapper = document.createElement('span')
  wrapper.className = 'fcg-semantic-sidebar-icon'
  wrapper.dataset.fcgIcon = name
  wrapper.setAttribute('aria-hidden', 'true')
  wrapper.innerHTML = `<svg viewBox="0 0 32 32" focusable="false">${glyphs[name]}</svg>`
  return wrapper
}

function applyIcons(): void {
  for (const target of targets) {
    for (const button of document.querySelectorAll<HTMLButtonElement>('button')) {
      const label = button.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
      if (!target.labels.some(value => label === value || label.startsWith(`${value} `))) continue
      if (button.querySelector(`[data-fcg-icon="${target.name}"]`) !== null) continue
      const defaultIcon = button.querySelector<SVGElement>('svg')
      defaultIcon?.classList.add('fcg-default-sidebar-icon')
      button.prepend(semanticIcon(target.name))
      button.dataset.fcgSemanticEntry = target.name
    }
  }
}

/** Mount icons outside the official shell while preserving its navigation and focus behavior. */
export function installFreeCodeGoSidebarIcons(): () => void {
  if (document.head.querySelector('[data-fcg-sidebar-icon-style]') === null) {
    const style = document.createElement('style')
    style.dataset.fcgSidebarIconStyle = 'true'
    style.textContent = `
      [data-fcg-semantic-entry] .fcg-default-sidebar-icon { display: none !important; }
      [data-fcg-semantic-entry] .fcg-semantic-sidebar-icon { display: inline-grid; place-items: center; width: 27px; height: 27px; flex: 0 0 27px; margin-right: 2px; filter: drop-shadow(1px 2px 1px rgba(16,33,43,.22)); }
      [data-fcg-semantic-entry] .fcg-semantic-sidebar-icon svg { width: 27px; height: 27px; image-rendering: pixelated; }
      [data-fcg-semantic-entry] { gap: 10px !important; }
      [data-fcg-semantic-entry="freecodego"] { --fcg-icon-tint: #e5f7f2; }
    `
    document.head.append(style)
  }
  applyIcons()
  // A settings pane mounts as a burst of childList mutations, and every pass
  // walks every button in the document. Coalesce a burst into one pass, and
  // cancel a frame still queued at unmount so a detached document is never
  // decorated.
  let frame: number | undefined
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = window.requestAnimationFrame(() => { frame = undefined; applyIcons() })
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
  }
}
