/**
 * The picker heads its model list with the account's groups, so group rows have
 * to survive both projections between the backend and the UI:
 * `managedCatalogGroups` (API shape → catalog shape) and the on-disk managed
 * catalog cache. A field dropped by either one is a field the picker cannot
 * show — the same failure mode the choice-level group fields already had.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { managedCatalogGroups } from '../src/model-catalog.ts'
import { readManagedCatalogCache } from '../src/managed-catalog-utils.ts'

describe('managedCatalogGroups', () => {
  it('carries the name, order and account rate a heading and a row need', () => {
    const [group] = managedCatalogGroups([{
      id: 21, name: '后端分组·免费', platform: 'openai', protocol: 'openai_responses', enabled: true,
      modelCount: 2, rateMultiplier: 0, activityDiscountPercent: 100, activityLabel: '限时免费',
      description: '限时活动', sortOrder: 1, default: true,
    }])
    expect(group).toEqual({
      id: 21, name: '后端分组·免费', enabled: true, default: true, description: '限时活动', platform: 'openai',
      protocol: 'openai_responses', rateMultiplier: 0, activityLabel: '限时免费', sortOrder: 1,
    })
  })

  it('keeps a locked group visible so the caller can explain it', () => {
    const [group] = managedCatalogGroups([{
      id: 23, name: '后端分组·受限', enabled: false, access: 'locked', unlockRequired: true,
      unlockReason: 'invite_registration_required', rateMultiplier: 1, sortOrder: 2,
    }])
    expect(group).toMatchObject({ id: 23, name: '后端分组·受限', enabled: false, rateMultiplier: 1 })
    expect(group!.unlockReason).toBe('invite_registration_required')
  })

  it('omits an absent rate instead of inventing a free one', () => {
    // A missing rate must not read as `0`: the picker prints a zero as free.
    const [group] = managedCatalogGroups([{ id: 9, name: '未定价', enabled: true }])
    expect(Object.hasOwn(group!, 'rateMultiplier')).toBe(false)
  })

  it('preserves the order it was given rather than sorting', () => {
    // The UI sorts against `sortOrder`; a projection that reordered here would
    // make the backend's own order unrepresentable.
    const groups = managedCatalogGroups([
      { id: 2, name: 'B', enabled: true, sortOrder: 2 },
      { id: 1, name: 'A', enabled: true, sortOrder: 1 },
    ])
    expect(groups.map(group => group.name)).toEqual(['B', 'A'])
  })
})

describe('managed catalog cache groups', () => {
  const writeCache = async (catalog: Record<string, unknown>): Promise<{ file: string; dir: string }> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fcg-catalog-'))
    const file = path.join(dir, 'managed-model-catalog.json')
    await writeFile(file, JSON.stringify({ version: 1, savedAt: 1, catalog }))
    return { file, dir }
  }

  it('round-trips the group rows so a restart keeps the real headings', async () => {
    const { file, dir } = await writeCache({
      catalogRevision: 'rev-1',
      groups: [
        { id: 21, name: '后端分组·免费', enabled: true, rateMultiplier: 0, sortOrder: 1 },
        { id: 23, name: '后端分组·受限', enabled: false, unlockReason: 'invite_registration_required', rateMultiplier: 1, sortOrder: 2 },
        // No id, so it cannot head anything and is dropped rather than rendered
        // as an unnamed bucket.
        { name: 'no id', enabled: true },
      ],
      models: [],
    })
    try {
      const cache = await readManagedCatalogCache(file)
      expect(cache?.catalog.groups).toEqual([
        { id: 21, name: '后端分组·免费', enabled: true, rateMultiplier: 0, sortOrder: 1 },
        { id: 23, name: '后端分组·受限', enabled: false, unlockReason: 'invite_registration_required', rateMultiplier: 1, sortOrder: 2 },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('omits the group list when the cache predates it', async () => {
    const { file, dir } = await writeCache({ catalogRevision: 'rev-1', models: [] })
    try {
      const cache = await readManagedCatalogCache(file)
      expect(cache?.catalog.models).toEqual([])
      expect(cache?.catalog.groups).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
