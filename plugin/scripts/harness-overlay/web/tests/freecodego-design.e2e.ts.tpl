// Web e2e scenario: the design page inside a real settings shell, driven by a
// real chromium against the real FreeCodeGo bundle.
//
// What a unit test cannot see, in the order the user meets it:
//
//  - the「设计」entry is a *navigation button the official shell renders* —
//    its label comes from this plugin's locale contribution through a slot
//    merge, its position from an `order` the shell sorts. Nothing in
//    `design-section.client.spec` exercises that merge: there the section is
//    mounted directly with props.
//  - the switches drive Remotes over the real HTTP/WebSocket uplink, the Host
//    writes through the settings service, and the write lands in the profile's
//    `cordis.patch.yml` on disk — persistence is not a mock here, it is a file.
//  - the sidebar icon layer decorates the nav button by its rendered label;
//    if the shell changed the wording, the glyph would silently not attach,
//    which is exactly the class of drift this file can catch.
//
// The scenario leaves voice/engineering out on purpose: one page per e2e file,
// the way `settings-appearance` and `freecodego-voice` each own one surface.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

const FREECODEGO_BUNDLE = fileURLToPath(new URL('../../../packages/freecodego/bundle-latest', import.meta.url))

/** Where the settings service persists volatile fields for a real profile. */
function profilePatchPath(scaffold: Parameters<typeof Object>[0] & { harnessHome: string }): string {
  // The scaffold boots the `scaffold` profile, not `web` (see `launchWebScaffold`).
  return `${scaffold.harnessHome}/profiles/scaffold/cordis.patch.yml`
}

/**
 * The persisted design slice from the profile patch, as the boot reads it back.
 *
 * The whole document is the slice: the patch is this profile's own file, the
 * plugin entry is the only one that declares design keys, and a YAML reader
 * here would only reimplement the parser the write already trusted.
 */
function persistedDesign(fragment: string, patchPath: string): { readonly raw: string } {
  const document = readFileSync(patchPath, 'utf8')
  expect(document, `${fragment} must appear in ${patchPath}`).toContain(fragment)
  return { raw: document }
}

let browser: Browser
let page: Page

/** Open the settings dialog at the design section. */
async function openDesign(): Promise<import('playwright').Locator> {
  const trigger = page.getByRole('button', { name: '设置', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.waitFor({ timeout: 10_000 })
  // The entry the shell renders from our locale contribution. Waiting here is
  // the assertion: a slot merge that dropped the section fails as a timeout,
  // with the ARIA snapshot in the failure artifact showing what did render.
  await dialog.getByRole('button', { name: '设计', exact: true }).waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: '设计', exact: true }).click()
  return dialog
}

it('shows the design entry, persists both switches across a reload, and keeps the row usable', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: FREECODEGO_BUNDLE, enabled: true }] },
  })
  onTestFailed(() => { void scaffold.close().catch(() => undefined) })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

  const dialog = await openDesign()

  // The page renders the feature row — the label comes from `features.ts`
  // through the real remote, not a fixture. Before anything is enabled the
  // tools block is absent by design: `tools` in the status is the *registered*
  // subset, listed only for an enabled row, so an empty list is the honest
  // answer and the page omits the block rather than promising nothing.
  await dialog.getByText('HyperFrames 设计', { exact: true }).waitFor({ timeout: 10_000 })

  // Two switches on the page: master + the one feature row.
  const switches = dialog.getByRole('checkbox')
  await expect.poll(() => switches.count(), { timeout: 10_000 }).toBe(2)
  expect(await dialog.getByText('freecodego_design_render', { exact: true }).count()).toBe(0)

  // Turn the feature row on. Enabling a feature is what turns the pack on (the
  // master follows), which is the flow a real user performs.
  await switches.nth(1).click()
  // The Host answers the write with the state it now holds, so both switch on
  // without a second click — and the tools block appears, naming what the
  // enabling actually registered in this real process.
  await expect.poll(() => switches.nth(0).isChecked(), { timeout: 10_000 }).toBe(true)
  await expect.poll(() => switches.nth(1).isChecked(), { timeout: 10_000 }).toBe(true)
  await dialog.getByText('freecodego_design_render', { exact: true }).waitFor({ timeout: 10_000 })
  await dialog.getByText('freecodego_design_preview', { exact: true }).waitFor({ timeout: 10_000 })

  // Persistence is on disk: the settings service wrote the volatile slice into
  // the profile patch. This is the exact file the next boot reads back.
  const patchPath = profilePatchPath(scaffold as never)
  const written = persistedDesign('freecodego', patchPath)
  expect(written.raw).toContain('designEnabled: true')
  expect(written.raw).toContain('designFeaturesEnabled:')
  expect(written.raw).toContain('- hyperframes')

  // Reload: the page must come back showing what was stored, read through the
  // same remote the first render used. No in-memory state carries over.
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  const reopened = await openDesign()
  const reopenedSwitches = reopened.getByRole('checkbox')
  await expect.poll(() => reopenedSwitches.count(), { timeout: 10_000 }).toBe(2)
  await expect.poll(() => reopenedSwitches.nth(0).isChecked(), { timeout: 10_000 }).toBe(true)
  await expect.poll(() => reopenedSwitches.nth(1).isChecked(), { timeout: 10_000 }).toBe(true)

  // And the row still explains itself: the tools list is what enabling adds,
  // re-registered by this boot's own reconcile rather than left over.
  await reopened.getByText('freecodego_design_render', { exact: true }).waitFor({ timeout: 10_000 })

  await browser.close()
  await scaffold.close()
}, 240_000)

it('decorates the design nav button with the plugin icon layer', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: FREECODEGO_BUNDLE, enabled: true }] },
  })
  onTestFailed(() => { void scaffold.close().catch(() => undefined) })
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

  const trigger = page.getByRole('button', { name: '设置', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.waitFor({ timeout: 10_000 })
  const designNav = dialog.getByRole('button', { name: '设计', exact: true })
  await designNav.waitFor({ timeout: 10_000 })
  // The semantic layer stamps `data-fcg-semantic-entry` and hides the shell's
  // default glyph. If the label matched but a later pass re-decorated, this
  // attribute would be absent — the failure mode is silent, so pin it.
  await expect
    .poll(() => designNav.getAttribute('data-fcg-semantic-entry'), { timeout: 10_000 })
    .toBe('design')

  await browser.close()
  await scaffold.close()
}, 240_000)
