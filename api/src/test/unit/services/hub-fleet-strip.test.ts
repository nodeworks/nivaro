import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { FLEET_STRIP_MAX, readFleetStrip } from '../../../services/hub/fleet-strip.js'

const row = (id: number, app: number, key: string) => ({
  id,
  key,
  base_url: `https://${key}.example.com`,
  hub_token: null,
  placement_id: null,
  app_id: app,
  app_key: `app${app}`,
  app_name: `App ${app}`
})

describe('fleet strip (one read for every dot)', () => {
  it('answers every environment with its status; a failed read is unknown', async () => {
    const read = vi.fn(async (t: { id: number }) => {
      if (t.id === 2) throw new Error('boom')
      return {
        state: t.id === 3 ? ('unreachable' as const) : ('ok' as const),
        version: '0.3.215',
        preflight: 'ok',
        checked_at: '2026-11-24T00:00:00.000Z',
        source: 'public' as const
      }
    })
    const out = await readFleetStrip('u1', true, {
      rows: async () => [row(1, 1, 'production'), row(2, 1, 'staging'), row(3, 2, 'dev')],
      read
    })
    expect(read).toHaveBeenCalledTimes(3)
    expect(out.truncated).toBe(false)
    expect(out.entries.map((e) => [e.env_id, e.app_key, e.env_key, e.state])).toEqual([
      [1, 'app1', 'production', 'ok'],
      [2, 'app1', 'staging', 'unknown'],
      [3, 'app2', 'dev', 'unreachable']
    ])
  })

  it('passes the caller through (owners see their apps) and caps the strip', async () => {
    const rows = vi.fn(async () =>
      Array.from({ length: FLEET_STRIP_MAX + 1 }, (_, i) => row(i + 1, 1, `e${i}`))
    )
    const out = await readFleetStrip('owner-1', false, {
      rows,
      read: async () => ({
        state: 'ok',
        version: null,
        preflight: null,
        checked_at: 'x',
        source: 'public'
      })
    })
    expect(rows).toHaveBeenCalledWith('owner-1', false)
    expect(out.entries).toHaveLength(FLEET_STRIP_MAX)
    expect(out.truncated).toBe(true)
  })
})
