import { beforeEach, describe, expect, it, vi } from 'vitest'

// rt8 #21 — MCP settings writes are a compare-and-swap: two renames at the same moment both land.

const row = vi.hoisted(() => ({ value: null as string | null, updates: 0 }))

vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))
vi.mock('../../../db/index.js', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5))
  const builder = () => {
    let want: { null: boolean; value?: string } | null = null
    const b = {
      where(col: string, v?: unknown) {
        if (col === 'mcp_settings') want = { null: false, value: String(v) }
        return b
      },
      whereNull(col: string) {
        if (col === 'mcp_settings') want = { null: true }
        return b
      },
      async first() {
        // Both writers read before either writes.
        const snapshot = row.value
        await tick()
        return { mcp_settings: snapshot }
      },
      async update(patch: { mcp_settings: string }) {
        await tick()
        row.updates++
        const matches = !want ? true : want.null ? row.value == null : row.value === want.value
        if (!matches) return 0
        row.value = patch.mcp_settings
        return 1
      }
    }
    return b
  }
  return { db: vi.fn(() => builder()) }
})

const { writeMcpSettings } = await import('../../../services/mcp-calls.js')

beforeEach(() => {
  row.value = null
  row.updates = 0
})

describe('writeMcpSettings compare-and-swap', () => {
  it('keeps both of two simultaneous renames of different connections', async () => {
    await Promise.all([
      writeMcpSettings({ connection_names: { k7: 'Ops bot' } }),
      writeMcpSettings({ connection_names: { k8: 'Build bot' } })
    ])
    expect(JSON.parse(row.value ?? '{}').connection_names).toEqual({
      k7: 'Ops bot',
      k8: 'Build bot'
    })
    // One of them lost the first swap and tried again.
    expect(row.updates).toBe(3)
  })

  it('keeps other settings a rename did not touch', async () => {
    row.value = JSON.stringify({ rate_limit_per_minute: 30, connection_names: { k1: 'Old' } })
    await Promise.all([
      writeMcpSettings({ connection_names: { k2: 'New' } }),
      writeMcpSettings({ rate_limit_per_minute: 45 })
    ])
    const saved = JSON.parse(row.value ?? '{}')
    expect(saved.rate_limit_per_minute).toBe(45)
    expect(saved.connection_names).toEqual({ k1: 'Old', k2: 'New' })
  })
})
