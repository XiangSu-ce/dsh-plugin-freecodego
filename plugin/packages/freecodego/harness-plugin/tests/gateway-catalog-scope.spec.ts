/**
 * The gateway model directory must contain gateway routes only, and of those
 * only the ones a conversation can run on.
 *
 * The managed catalog is a merged cache: gateway rows sit beside rows owned by
 * logfare, Agnes, OpenCode, and others. `listFreeCodeGoModels` publishes
 * whatever survives `mergeCatalogModels`, so anything it fails to exclude is
 * offered under the FreeCodeGo group with a FreeCodeGo route — a promise the
 * gateway cannot keep.
 *
 * Agnes was missing from the exclusion list. Its routes are image and video
 * generators, so picking one from the FreeCodeGo group started a chat request
 * against a route that only accepts a generation prompt. The gateway's own
 * image routes (`gpt-image-2`) have the same problem without another provider
 * to blame: nothing lets them serve a turn, so the picker that chooses a turn's
 * model must not offer them.
 */

import { describe, expect, it } from 'vitest'
import { mergeCatalogModels } from '../src/model-catalog.ts'
import { isTextConversationRoute } from '../src/managed-catalog-utils.ts'

const row = (id: string, provider: string): never => ({ id, provider, displayName: id, protocol: 'openai_responses', availability: 'available', compatibleEngines: [], choices: [] }) as never
const ids = (models: readonly unknown[]): readonly string[] => models.map(entry => (entry as { readonly id: string }).id)

describe('gateway catalog scope', () => {
  it('never offers an Agnes route under the gateway provider', () => {
    const kept = mergeCatalogModels([
      row('gpt-5.6-terra', 'freecodego-cloud'),
      row('agnes/agnes-image-2.5-flash', 'agnes'),
      row('agnes/agnes-video-2.5-flash', 'agnes'),
    ])
    expect(ids(kept)).toEqual(['gpt-5.6-terra'])
  })

  it('excludes every provider that owns a separate adapter', () => {
    // Each of these has a dedicated picker group and its own adapter; a row
    // here would be offered as `freecodego/<id>` and fail at request time.
    for (const provider of ['opencode', 'openrouter', 'agnes', 'logfare', 'sensenova', 'bai']) {
      const kept = mergeCatalogModels([row('gateway-model', 'freecodego-cloud'), row('some-model', provider)])
      expect(ids(kept), provider).toEqual(['gateway-model'])
    }
  })

  it('excludes a direct-provider wire id even when the owner is unset', () => {
    // A stale snapshot can carry the prefixed id without the owning provider,
    // so the id prefix has to be a second line of defence.
    const kept = mergeCatalogModels([
      row('gpt-5.6-terra', 'freecodego-cloud'),
      row('agnes/agnes-image-2.5-flash', 'freecodego-cloud'),
      row('opencode/big-pickle', 'freecodego-cloud'),
      row('bai:qwen3.8-flash', 'freecodego-cloud'),
    ])
    expect(ids(kept)).toEqual(['gpt-5.6-terra'])
  })

  it('offers a conversation only the gateway routes that can serve one', () => {
    const route = (id: string, protocol = 'openai_responses') => ({ id, displayName: id, protocol, provider: 'openai' })
    expect(isTextConversationRoute(route('gpt-5.6-sol'))).toBe(true)
    // The gateway labels an image route as a generic responses protocol, so the
    // name is the only signal there is — and it is enough.
    expect(isTextConversationRoute(route('gpt-image-2'))).toBe(false)
    expect(isTextConversationRoute(route('gpt-image-2.5-flare'))).toBe(false)
    expect(isTextConversationRoute(route('flux.2-klein-4b'))).toBe(false)
    expect(isTextConversationRoute(route('some-route', 'image_generation'))).toBe(false)
    expect(isTextConversationRoute(route('agnes-video-2.5-flash'))).toBe(false)
  })

  it('honors an explicit category override in both directions', () => {
    // The picker and the settings page's text tab must list the same routes: an
    // override that moves a route between categories is the user saying which
    // one it belongs to, and only the settings page used to honour it.
    const image = { id: 'gpt-image-2', displayName: 'gpt-image-2', protocol: 'openai_responses', provider: 'openai' }
    const text = { id: 'gpt-5.6-sol', displayName: 'gpt-5.6-sol', protocol: 'openai_responses', provider: 'openai' }
    expect(isTextConversationRoute(image, { 'openai\u0000gpt-image-2': 'text' })).toBe(true)
    expect(isTextConversationRoute(text, { 'openai\u0000gpt-5.6-sol': 'image' })).toBe(false)
    // Keyed by the provider the catalog row carries, so another provider's
    // override for the same id is not this row's.
    expect(isTextConversationRoute(image, { 'freecodego\u0000gpt-image-2': 'text' })).toBe(false)
  })

  it('keeps the gateway routes themselves', () => {
    // The exclusion must not swallow the rows the group exists to show.
    const kept = mergeCatalogModels([
      row('gpt-5.6-terra', 'freecodego-cloud'),
      row('claude-opus-5', 'freecodego'),
      row('gpt-image-2', 'freecodego'),
    ])
    expect(ids(kept)).toHaveLength(3)
  })
})
