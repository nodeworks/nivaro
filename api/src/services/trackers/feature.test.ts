import type { FastifyReply, FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { id: number; instance_key: string; data: string | null }
const state = vi.hoisted(() => ({ rows: [] as any[], nextId: 1, activity: [] as any[] }))

vi.mock('../../db/index.js', () => {
  const db: any = (name: string) => {
    if (name !== 'nivaro_settings_overrides') throw new Error(`unexpected table ${name}`)
    let where: Record<string, unknown> = {}
    const b: any = {
      where: (w: Record<string, unknown>) => {
        where = w
        return b
      },
      first: async () =>
        state.rows.find((r: Row) => Object.entries(where).every(([k, v]) => (r as any)[k] === v)),
      update: async (patch: Record<string, unknown>) => {
        for (const r of state.rows) if ((r as any).id === where.id) Object.assign(r, patch)
        return 1
      },
      insert: (row: Record<string, unknown>) => {
        const full = { id: state.nextId++, ...row }
        state.rows.push(full)
        return { returning: async () => [{ id: full.id }] }
      }
    }
    return b
  }
  return { db }
})
vi.mock('../activity.js', () => ({
  logActivity: async (o: unknown) => {
    state.activity.push(o)
    return 1
  }
}))
vi.mock('../settings-overrides.js', () => ({ bustInstanceOverridesCache: () => {} }))

import {
  bustTrackersFeatureCache,
  requireFeatureOn,
  setTrackersEnabled,
  trackersEnabled,
  trackersFeature
} from './feature.js'

const KEYS = ['ISSUE_TRACKERS', 'CLOUD_META_DB_URL', 'NIVARO_INSTANCE']
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.NIVARO_INSTANCE = 'test'
  state.rows = []
  state.nextId = 1
  state.activity = []
  bustTrackersFeatureCache()
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  bustTrackersFeatureCache()
})

const store = (enabled: boolean) =>
  state.rows.push({
    id: state.nextId++,
    instance_key: 'test',
    data: JSON.stringify({ other: 1, issue_trackers: { enabled } })
  })

describe('trackers feature switch', () => {
  it('default is off', async () => {
    expect(await trackersFeature()).toEqual({ enabled: false, source: 'default' })
  })

  it('env ISSUE_TRACKERS=on wins over stored off', async () => {
    store(false)
    process.env.ISSUE_TRACKERS = 'on'
    expect(await trackersFeature()).toEqual({ enabled: true, source: 'env' })
  })

  it('an unrecognised env value is ignored', async () => {
    store(true)
    process.env.ISSUE_TRACKERS = 'maybe'
    expect(await trackersFeature()).toEqual({ enabled: true, source: 'setting' })
  })

  it('stored on enables', async () => {
    store(true)
    expect(await trackersEnabled()).toBe(true)
  })

  it('cloud mode is always off', async () => {
    store(true)
    process.env.ISSUE_TRACKERS = 'on'
    process.env.CLOUD_META_DB_URL = 'x'
    expect(await trackersFeature()).toEqual({ enabled: false, source: 'cloud' })
  })

  it('setTrackersEnabled refuses when env decides', async () => {
    process.env.ISSUE_TRACKERS = 'off'
    await expect(setTrackersEnabled(true, 'u1')).rejects.toMatchObject({ code: 'FEATURE_LOCKED' })
    expect(state.rows).toHaveLength(0)
  })

  it('setTrackersEnabled merges into the row, busts the cache and logs', async () => {
    store(false)
    expect(await trackersEnabled()).toBe(false)
    expect(await setTrackersEnabled(true, 'u1')).toEqual({ enabled: true, source: 'setting' })
    expect(JSON.parse(state.rows[0].data)).toEqual({ other: 1, issue_trackers: { enabled: true } })
    expect(await trackersEnabled()).toBe(true)
    expect(state.activity[0]).toMatchObject({
      action: 'update',
      collection: 'nivaro_settings_overrides',
      item: '1',
      comment: 'GitLab sync turned on',
      user: 'u1'
    })
  })

  it('setTrackersEnabled inserts a row when none exists', async () => {
    await setTrackersEnabled(false, 'u1')
    expect(state.rows).toHaveLength(1)
    expect(state.activity[0].comment).toBe('GitLab sync turned off')
  })
})

describe('routes answer FEATURE_OFF when off', () => {
  const run = async (url: string) => {
    const send = vi.fn()
    const reply = { code: vi.fn(() => ({ send })) } as unknown as FastifyReply
    const out = await requireFeatureOn({ url } as FastifyRequest, reply)
    return { out, send, reply }
  }

  it('blocks other routes with 404', async () => {
    const r = await run('/api/trackers/outbox?x=1')
    expect(r.reply.code).toHaveBeenCalledWith(404)
    expect(r.send).toHaveBeenCalledWith({
      error: 'GitLab sync is turned off',
      code: 'FEATURE_OFF'
    })
  })

  it('lets /feature through', async () => {
    const r = await run('/api/trackers/feature')
    expect(r.reply.code).not.toHaveBeenCalled()
  })

  it('lets other routes through when on', async () => {
    store(true)
    const r = await run('/api/trackers/outbox')
    expect(r.reply.code).not.toHaveBeenCalled()
  })
})
