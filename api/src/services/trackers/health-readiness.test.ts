import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  enabled: true,
  tables: true,
  connections: [] as Array<Record<string, unknown>>,
  dead: [] as Array<{ connection: number; n: number }>,
  links: [] as Array<{ connection: number; n: number }>,
  throwOn: '' as string,
  deadFilter: [] as number[]
}))

vi.mock('./feature.js', () => ({ trackersEnabled: async () => h.enabled }))
vi.mock('../../db/index.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    const chain = () => b
    b.where = chain
    b.groupBy = chain
    b.whereIn = (_c: string, ids: number[]) => {
      if (table === 'nivaro_tracker_outbox') h.deadFilter = ids
      return b
    }
    b.select = (..._cols: string[]) => b
    b.count = () => b
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaitable
    b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve()
        .then(() => {
          if (h.throwOn === table) throw new Error('boom')
          if (table === 'nivaro_tracker_connections') return h.connections
          const rows = table === 'nivaro_tracker_outbox' ? h.dead : h.links
          return table === 'nivaro_tracker_outbox'
            ? rows.filter((r) => h.deadFilter.includes(r.connection))
            : rows
        })
        .then(res, rej)
    return b
  }
  const db = Object.assign((table: string) => builder(table), {
    schema: { hasTable: async () => h.tables }
  })
  return { db }
})

import { judgeTrackerHealth, trackerHealthReadiness } from './health-readiness.js'

const NOW = Date.parse('2026-11-17T12:00:00Z')
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000)
const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'GitLab',
  status: 'ok',
  last_error: null,
  last_webhook_at: hoursAgo(1),
  ...over
})
const conn = (over: Record<string, unknown> = {}) => ({ ...row(), dead: 0, links: 0, ...over })

beforeEach(() => {
  h.enabled = true
  h.tables = true
  h.connections = [row()]
  h.dead = []
  h.links = []
  h.throwOn = ''
  h.deadFilter = []
})

describe('judgeTrackerHealth', () => {
  it('passes with no connection', () => {
    expect(judgeTrackerHealth({ connections: [] }, NOW).status).toBe('pass')
  })
  it('warns on dead outbox rows and names the connection', () => {
    const r = judgeTrackerHealth({ connections: [conn({ dead: 3 })] }, NOW)
    expect(r.status).toBe('warn')
    expect(r.blockers?.join(' ')).toContain('GitLab: 3 GitLab sends')
  })
  it('warns on a broken connection and names the error', () => {
    const r = judgeTrackerHealth(
      { connections: [conn({ status: 'broken', last_error: 'HTTP 401' })] },
      NOW
    )
    expect(r.status).toBe('warn')
    expect(r.blockers?.join(' ')).toContain('HTTP 401')
  })
  it('warns when links exist and no webhook arrived in 24 h', () => {
    const r = judgeTrackerHealth(
      { connections: [conn({ last_webhook_at: hoursAgo(30), links: 4 })] },
      NOW
    )
    expect(r.status).toBe('warn')
    expect(r.blockers?.join(' ')).toContain('webhook')
  })
  it('warns when links exist and no webhook ever arrived', () => {
    const r = judgeTrackerHealth({ connections: [conn({ last_webhook_at: null, links: 1 })] }, NOW)
    expect(r.status).toBe('warn')
  })
  it('does not need a webhook when nothing is linked', () => {
    const r = judgeTrackerHealth({ connections: [conn({ last_webhook_at: null })] }, NOW)
    expect(r.status).toBe('pass')
  })
  it('judges webhook silence per connection', () => {
    const r = judgeTrackerHealth(
      {
        connections: [
          conn({ id: 1, name: 'A', last_webhook_at: null, links: 2 }),
          conn({ id: 2, name: 'B', last_webhook_at: null, links: 0 })
        ]
      },
      NOW
    )
    expect(r.blockers).toHaveLength(1)
    expect(r.blockers?.[0]).toContain('A:')
  })
})

describe('trackerHealthReadiness', () => {
  it('warns on dead outbox', async () => {
    h.dead = [{ connection: 1, n: 2 }]
    const r = await trackerHealthReadiness(NOW)
    expect(r.status).toBe('warn')
  })
  it('ignores dead rows of inactive connections', async () => {
    h.dead = [{ connection: 9, n: 5 }]
    expect((await trackerHealthReadiness(NOW)).status).toBe('pass')
  })
  it('does not blame a connection with no links for another one’s links (two connections)', async () => {
    h.connections = [
      row({ id: 1, name: 'A', last_webhook_at: null }),
      row({ id: 2, name: 'B', last_webhook_at: null })
    ]
    h.links = [{ connection: 1, n: 3 }]
    const r = await trackerHealthReadiness(NOW)
    expect(r.status).toBe('warn')
    expect(r.blockers).toHaveLength(1)
    expect(r.blockers?.[0]).toContain('A:')
  })
  it('passes when the feature is off', async () => {
    h.enabled = false
    h.dead = [{ connection: 1, n: 9 }]
    expect((await trackerHealthReadiness(NOW)).status).toBe('pass')
  })
  it('skips without throwing when migration 532 is not applied', async () => {
    h.tables = false
    const r = await trackerHealthReadiness(NOW)
    expect(r.status).toBe('skip')
    expect(r.detail).toMatch(/migration|tables/i)
  })
  it('does not throw when a read fails', async () => {
    h.throwOn = 'nivaro_tracker_outbox'
    const r = await trackerHealthReadiness(NOW)
    expect(r.status).toBe('warn')
  })
  it('passes when everything is healthy', async () => {
    h.links = [{ connection: 1, n: 5 }]
    expect((await trackerHealthReadiness(NOW)).status).toBe('pass')
  })
})
