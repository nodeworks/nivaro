import { beforeEach, describe, expect, it, vi } from 'vitest'

// An in-memory nivaro_workspaces for the default-workspace lookup.
const rows: Array<{ id: string; name: string; slug: string; created_at?: string }> = []
const inserts: unknown[] = []
vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    if (table !== 'nivaro_workspaces') throw new Error(`unexpected table ${table}`)
    let where: Record<string, unknown> | null = null
    const q = {
      where(w: Record<string, unknown>) {
        where = w
        return q
      },
      orderBy: () => q,
      select: () => q,
      first: async () =>
        rows.find((r) => !where || Object.entries(where).every(([k, v]) => (r as any)[k] === v)),
      insert: async (row: { id: string; name: string; slug: string }) => {
        inserts.push(row)
        if (rows.some((r) => r.id === row.id)) throw new Error('duplicate key')
        rows.push(row)
      }
    }
    return q
  }
  return { db }
})

const { DEFAULT_WORKSPACE, clearDefaultWorkspaceCache, fetchDefaultWorkspaceId } = await import(
  '../../../middleware/workspace.js'
)

beforeEach(() => {
  rows.length = 0
  inserts.length = 0
  clearDefaultWorkspaceCache()
})

describe('fetchDefaultWorkspaceId', () => {
  it('a fresh install (no workspace at all) gets the default workspace row, once', async () => {
    // The same id the lookup fell back to before the row existed.
    expect(await fetchDefaultWorkspaceId()).toBe('00000000-0000-0000-0000-000000000001')
    expect(rows).toEqual([{ id: DEFAULT_WORKSPACE, name: 'Default', slug: 'default' }])
    clearDefaultWorkspaceCache()
    expect(await fetchDefaultWorkspaceId()).toBe(DEFAULT_WORKSPACE)
    expect(inserts).toHaveLength(1)
  })

  it('cloud mode never creates it: the constant comes back as before, nothing is inserted', async () => {
    const before = process.env.CLOUD_META_DB_URL
    process.env.CLOUD_META_DB_URL = 'postgres://meta.example/cloud'
    try {
      expect(await fetchDefaultWorkspaceId()).toBe(DEFAULT_WORKSPACE)
      expect(inserts).toHaveLength(0)
      expect(rows).toHaveLength(0)
    } finally {
      if (before === undefined) delete process.env.CLOUD_META_DB_URL
      else process.env.CLOUD_META_DB_URL = before
    }
  })

  it('a provisioned tenant keeps its own oldest workspace; nothing is inserted', async () => {
    rows.push({ id: 'tenant-ws', name: 'Acme', slug: 'acme' })
    expect(await fetchDefaultWorkspaceId()).toBe('tenant-ws')
    expect(inserts).toHaveLength(0)
  })

  it('the seeded default row wins when present', async () => {
    rows.push({ id: 'other', name: 'Other', slug: 'other' })
    rows.push({ id: DEFAULT_WORKSPACE, name: 'Default', slug: 'default' })
    expect(await fetchDefaultWorkspaceId()).toBe(DEFAULT_WORKSPACE)
    expect(inserts).toHaveLength(0)
  })
})
