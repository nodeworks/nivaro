import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// verifyFiles must judge a file the way a download serves it: own storage, then the source
// environment (FILES_FALLBACK_DIR, then FILES_FALLBACK_URL). Staging after a refresh read
// "File missing" on files that downloaded fine from production (2026-11-18).
const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; filename_disk: string | null; missing_at: Date | null }>,
  local: new Set<string>(),
  dir: new Set<string>(),
  url: new Map<string, boolean | null>(),
  updates: [] as Array<{ id: unknown; patch: Record<string, unknown> }>
}))

vi.mock('../../../db/index.js', () => ({
  db: (_table: string) => {
    let id: unknown
    const chain = {
      whereIn: () => chain,
      select: async () => h.rows,
      where: (_c: string, v: unknown) => {
        id = v
        return chain
      },
      update: async (patch: Record<string, unknown>) => {
        h.updates.push({ id, patch })
        return 1
      }
    }
    return chain
  }
}))
vi.mock('../../../services/storage/index.js', () => ({
  getStorage: () => ({ exists: async (k: string) => h.local.has(k) })
}))
vi.mock('../../../services/storage/fallback.js', () => ({
  existingFallback: async (k: string) => (h.dir.has(k) ? { path: `/src/${k}`, size: 1 } : null)
}))
vi.mock('../../../services/storage/fallback-url.js', () => ({
  fallbackUrlHas: async (k: string) => (h.url.has(k) ? h.url.get(k) : false)
}))

import { verifyFiles } from '../../../services/file-integrity.js'

const row = (id: string, key: string, missing_at: Date | null = null) => ({
  id,
  filename_disk: key,
  missing_at
})

beforeEach(() => {
  h.rows = []
  h.local.clear()
  h.dir.clear()
  h.url.clear()
  h.updates = []
})
afterEach(() => {
  delete process.env.FILE_VERIFY_PERSIST
})

describe('verifyFiles with a source environment', () => {
  it('a file only the source environment holds (over HTTP) is not missing', async () => {
    h.rows = [row('a', 'a.pdf', new Date())]
    h.url.set('a.pdf', true)
    expect(await verifyFiles(['a'])).toEqual([{ id: 'a', missing: false }])
    // the old "missing" stamp is cleared
    expect(h.updates[0].patch.missing_at).toBeNull()
  })

  it('a file in the source folder is not missing', async () => {
    h.rows = [row('b', 'b.pdf')]
    h.dir.add('b.pdf')
    expect(await verifyFiles(['b'])).toEqual([{ id: 'b', missing: false }])
  })

  it('missing here AND at the source (404) is missing', async () => {
    h.rows = [row('c', 'c.pdf')]
    h.url.set('c.pdf', false)
    expect(await verifyFiles(['c'])).toEqual([{ id: 'c', missing: true }])
    expect(h.updates[0].patch.missing_at).toBeInstanceOf(Date)
  })

  it('a source that does not answer never makes a file missing, and nothing is stamped', async () => {
    h.rows = [row('d', 'd.pdf')]
    h.url.set('d.pdf', null)
    expect(await verifyFiles(['d'])).toEqual([{ id: 'd', missing: false }])
    expect(h.updates).toHaveLength(0)
  })

  it('a file this instance holds never asks the source', async () => {
    h.rows = [row('e', 'e.pdf')]
    h.local.add('e.pdf')
    h.url.set('e.pdf', false)
    expect(await verifyFiles(['e'])).toEqual([{ id: 'e', missing: false }])
  })
})
