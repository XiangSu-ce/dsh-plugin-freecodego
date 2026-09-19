/**
 * Media-default selection is the difference between a working generation and a
 * provider error, because the catalog it reads is a live window onto third-party
 * directories where rows appear and retire without notice.
 *
 * The regression these cases pin: a retired id was left in the settings document
 * forever (the old code only migrated, never replaced), and a first-time pick
 * took whichever row the directory returned first.
 */

import { describe, expect, it } from 'vitest'
import { decideMediaDefault, rankMediaDefaults, type MediaDefaultCandidate } from '../src/client/media-default-preference.ts'

const model = (id: string, provider: string, displayName = id): MediaDefaultCandidate => ({ id, provider, displayName })

describe('media default ranking', () => {
  it('prefers a managed provider over a community gateway', () => {
    const ranked = rankMediaDefaults([
      model('x', 'opencode'),
      model('agnes-image-2.5-flash', 'agnes'),
      model('gpt-image-2', 'logfare'),
    ])
    // The plugin can reason about and meter its own routes; a community gateway
    // is a fallback, not a first choice.
    expect(ranked.map(entry => entry.provider)).toEqual(['agnes', 'logfare', 'opencode'])
  })

  it('sorts an unknown provider last, never first', () => {
    // A brand-new third-party entry must not silently become everyone's default.
    const ranked = rankMediaDefaults([model('new', 'brand-new-provider'), model('known', 'agnes')])
    expect(ranked[0]?.provider).toBe('agnes')
  })

  it('is stable for equal-ranked candidates', () => {
    const a = rankMediaDefaults([model('b', 'agnes', 'Beta'), model('a', 'agnes', 'Alpha')])
    const b = rankMediaDefaults([model('a', 'agnes', 'Alpha'), model('b', 'agnes', 'Beta')])
    // Same order regardless of input order, so a reload does not flip the choice.
    expect(a.map(entry => entry.id)).toEqual(b.map(entry => entry.id))
  })
})

describe('media default decision', () => {
  it('keeps a stored default that is still available', () => {
    expect(decideMediaDefault('agnes-image-2.5-flash', [model('agnes-image-2.5-flash', 'agnes')])).toEqual({ action: 'keep' })
  })

  it('migrates a stored id that survived a provider-prefix change', () => {
    // `gpt-image-2` → `logfare/gpt-image-2` is the same route renamed, not a
    // new one, so the user's choice is preserved rather than reset.
    expect(decideMediaDefault('gpt-image-2', [model('logfare/gpt-image-2', 'logfare')])).toEqual({ action: 'migrate', next: 'logfare/gpt-image-2' })
  })

  it('replaces a retired default instead of leaving it in place', () => {
    // The regression: `logfare/gpt-image-2` was withdrawn from the directory and
    // the old code left it stored, so every generation failed against a route
    // that no longer existed.
    const decision = decideMediaDefault('logfare/gpt-image-2', [model('agnes-image-2.5-flash', 'agnes'), model('sdxl-lightning', 'freecodego')])
    expect(decision).toEqual({ action: 'replace', next: 'agnes-image-2.5-flash' })
  })

  it('does not migrate when the suffix match is ambiguous', () => {
    // Two providers exposing the same trailing id are not the same route, so
    // guessing one would silently switch the user to a different backend.
    const decision = decideMediaDefault('gpt-image-2', [model('a/gpt-image-2', 'agnes'), model('b/gpt-image-2', 'logfare')])
    expect(decision.action).toBe('replace')
  })

  it('adopts the preferred model when nothing is stored', () => {
    expect(decideMediaDefault('', [model('sdxl-lightning', 'freecodego'), model('agnes-image-2.5-flash', 'agnes')]))
      .toEqual({ action: 'replace', next: 'agnes-image-2.5-flash' })
  })

  it('trims a padded stored value before comparing', () => {
    expect(decideMediaDefault('  agnes-image-2.5-flash  ', [model('agnes-image-2.5-flash', 'agnes')])).toEqual({ action: 'keep' })
  })

  it('leaves the setting unset when the category has nothing available', () => {
    // Persisting a model that does not exist would be worse than an empty
    // setting: the UI can explain an empty one.
    expect(decideMediaDefault('retired-model', [])).toEqual({ action: 'unset' })
    expect(decideMediaDefault('', [])).toEqual({ action: 'unset' })
  })
})
