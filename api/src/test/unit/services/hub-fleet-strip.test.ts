import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  FLEET_STRIP_MAX,
  readFleetStrip,
  resetFleetStripCache
} from '../../../services/hub/fleet-strip.js'
import { hubStatusKey } from '../../../services/hub/status.js'

const row = (id: number, app: number, key: string) => ({
  id,
  key,
  app_id: app,
  app_key: `app${app}`,
  app_name: `App ${app}`
})

const status = (state: string) =>
  JSON.stringify({ state, version: '0.3.215', preflight: 'ok', checked_at: 'x', source: 'public' })

beforeEach(() => resetFleetStripCache())

describe('fleet strip (one cached read for every dot, never a live probe)', () => {
  it('answers each environment from the status cache; a miss or a bad entry is unknown', async () => {
    const cache = new Map([
      [hubStatusKey(1), status('ok')],
      [hubStatusKey(3), status('unreachable')],
      [hubStatusKey(4), 'not json']
    ])
    const redis = { get: vi.fn(async (k: string) => cache.get(k) ?? null) }
    const out = await readFleetStrip('u1', true, {
      rows: async () => [
        row(1, 1, 'production'),
        row(2, 1, 'staging'),
        row(3, 2, 'dev'),
        row(4, 2, 'qa')
      ],
      redis
    })
    expect(redis.get).toHaveBeenCalledTimes(4)
    expect(out.truncated).toBe(false)
    expect(out.entries.map((e) => [e.env_id, e.app_key, e.env_key, e.state])).toEqual([
      [1, 'app1', 'production', 'ok'],
      [2, 'app1', 'staging', 'unknown'],
      [3, 'app2', 'dev', 'unreachable'],
      [4, 'app2', 'qa', 'unknown']
    ])
  })

  it('without a cache every dot is unknown (it never calls an app)', async () => {
    const out = await readFleetStrip('u1', true, { rows: async () => [row(1, 1, 'prod')] })
    expect(out.entries[0].state).toBe('unknown')
  })

  it('keeps an answer 30 s per caller view and shares a read in flight', async () => {
    let t = 1000
    const rows = vi.fn(async () => [row(1, 1, 'prod')])
    const deps = { rows, now: () => t, redis: { get: async () => null } }
    const [a, b] = await Promise.all([
      readFleetStrip('u1', true, deps),
      readFleetStrip('u2', true, deps)
    ])
    expect(a).toBe(b)
    expect(rows).toHaveBeenCalledTimes(1)
    // An owner has their own view.
    await readFleetStrip('owner-1', false, deps)
    expect(rows).toHaveBeenCalledTimes(2)
    expect(rows).toHaveBeenLastCalledWith('owner-1', false)
    t += 31_000
    await readFleetStrip('u1', true, deps)
    expect(rows).toHaveBeenCalledTimes(3)
  })

  it('caps the strip', async () => {
    const out = await readFleetStrip('u1', true, {
      rows: async () =>
        Array.from({ length: FLEET_STRIP_MAX + 1 }, (_, i) => row(i + 1, 1, `e${i}`))
    })
    expect(out.entries).toHaveLength(FLEET_STRIP_MAX)
    expect(out.truncated).toBe(true)
  })
})
