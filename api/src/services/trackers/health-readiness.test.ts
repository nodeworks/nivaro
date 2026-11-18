import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  enabled: true,
  tables: true,
  connections: [] as Array<Record<string, unknown>>,
  dead: 0,
  links: 0,
  throwOn: '' as string
}))

vi.mock('./feature.js', () => ({ trackersEnabled: async () => h.enabled }))
vi.mock('../../db/index.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    const chain = () => b
    b.where = chain
    b.whereIn = chain
    b.orderBy = chain
    b.select = async () => {
      if (h.throwOn === table) throw new Error('boom')
      return h.connections
    }
    b.count = () => ({
      first: async () => {
        if (h.throwOn === table) throw new Error('boom')
        return { n: table === 'nivaro_tracker_outbox' ? h.dead : h.links }
      }
    })
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
const conn = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'GitLab',
  status: 'ok',
  last_error: null,
  last_webhook_at: hoursAgo(1),
  ...over
})

beforeEach(() => {
  h.enabled = true
  h.tables = true
  h.connections = [conn()]
  h.dead = 0
  h.links = 0
  h.throwOn = ''
})

describe('judgeTrackerHealth', () => {
  it('passes with no connection', () => {
    expect(judgeTrackerHealth({ connections: [], dead: 0, links: 0 }, NOW).status).toBe('pass')
  })
  it('warns on dead outbox rows', () => {
    const r = judgeTrackerHealth({ connections: [conn()], dead: 3, links: 0 }, NOW)
    expect(r.status).toBe('warn')
    expect(r.blockers?.join(' ')).toContain('3')
  })
  it('warns on a broken connection and names the error', () => {
    const r = judgeTrackerHealth(
      { connections: [conn({ status: 'broken', last_error: 'HTTP 401' })], dead: 0, links: 0 },
      NOW
    )
    expect(r.status).toBe('warn')
    expect(r.blockers?.join(' ')).toContain('HTTP 401')
  })
  it('warns when links exist and no webhook arrived in 24 h', () => {
    const r = judgeTrackerHealth(
      { connections: [conn({ last_webhook_at: hoursAgo(30) })], dead: 0, links: 4 },
      NOW
    )
    expect(r.status).toBe('warn')
    expect(r.blockers?.join(' ')).toContain('webhook')
  })
  it('warns when links exist and no webhook ever arrived', () => {
    const r = judgeTrackerHealth(
      { connections: [conn({ last_webhook_at: null })], dead: 0, links: 1 },
      NOW
    )
    expect(r.status).toBe('warn')
  })
  it('does not need a webhook when nothing is linked', () => {
    const r = judgeTrackerHealth(
      { connections: [conn({ last_webhook_at: null })], dead: 0, links: 0 },
      NOW
    )
    expect(r.status).toBe('pass')
  })
})

describe('trackerHealthReadiness', () => {
  it('warns on dead outbox', async () => {
    h.dead = 2
    const r = await trackerHealthReadiness(NOW)
    expect(r.status).toBe('warn')
  })
  it('skips when the feature is off', async () => {
    h.enabled = false
    h.dead = 9
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
    h.links = 5
    expect((await trackerHealthReadiness(NOW)).status).toBe('pass')
  })
})
