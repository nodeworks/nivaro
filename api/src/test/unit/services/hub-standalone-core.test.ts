import { describe, expect, it, vi } from 'vitest'

// A fresh install holds Nivaro's own idea board (`ideas`, migration 446): it is not app data, so a
// new standalone Hub still gets the Hub-only sidebar (2026-11-25: every fresh Hub showed the full one).
const state = vi.hoisted(() => ({ rows: [] as Array<{ collection: string }> }))
vi.mock('../../../db/index.js', () => ({
  db: () => ({ select: async () => state.rows })
}))

import { hasAppCollections } from '../../../services/hub/standalone.js'

describe('hasAppCollections', () => {
  it('system tables and the core idea board are not app data', async () => {
    state.rows = [
      { collection: 'nivaro_users' },
      { collection: 'directus_files' },
      { collection: 'ideas' }
    ]
    expect(await hasAppCollections()).toBe(false)
  })
  it('any other collection is', async () => {
    state.rows = [{ collection: 'ideas' }, { collection: 'workflows' }]
    expect(await hasAppCollections()).toBe(true)
  })
})
