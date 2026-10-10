import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// #1367 — one day of one person. Admins only, the day is the viewer's day,
// every read is logged like an admin chat-log read, and a lane whose table is
// missing drops out instead of failing the whole day.

const state = vi.hoisted(() => ({ admin: true }))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: unknown }) => {
    if (!state.admin) {
      const err = Object.assign(new Error('Forbidden'), { statusCode: 403 })
      throw err
    }
    req.user = { id: 'ADMIN-1', role: 'admin' }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import {
  bucketByMinute,
  type DayWindow,
  dayWindow,
  journeyRoutes
} from '../../../routes/journeys.js'
import { logActivity } from '../../../services/activity.js'

let failing: string[] = []
let rows: Record<string, unknown[]> = {}
const wheres: Record<string, unknown[][]> = {}

function installDb() {
  vi.mocked(db).mockImplementation(((table: string) => {
    const settle = () =>
      failing.includes(table)
        ? Promise.reject(new Error(`Invalid object name '${table}'`))
        : Promise.resolve(rows[table] ?? [])
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              settle().then(res, rej)
          }
          if (prop === 'catch') return (fn: (e: unknown) => unknown) => settle().catch(fn)
          return (...args: unknown[]) => {
            if (prop === 'where' && typeof args[0] !== 'function') {
              wheres[table] ??= []
              wheres[table].push(args)
            }
            for (const a of args) if (typeof a === 'function') a.call(proxy, proxy)
            return proxy
          }
        }
      }
    )
    return proxy
  }) as never)
}

async function get(url: string) {
  const app = Fastify({ logger: false })
  await app.register(journeyRoutes, { prefix: '/journeys' })
  await app.ready()
  return app.inject({ method: 'GET', url })
}

afterEach(() => {
  failing = []
  rows = {}
  for (const k of Object.keys(wheres)) delete wheres[k]
  state.admin = true
  vi.clearAllMocks()
})

describe('dayWindow', () => {
  it('starts the day at the viewer’s midnight', () => {
    // UTC+2 viewer (getTimezoneOffset −120): their 10 Oct begins 9 Oct 22:00Z.
    const w = dayWindow('2026-10-10', '-120') as DayWindow
    expect(w.start.toISOString()).toBe('2026-10-09T22:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-10-10T22:00:00.000Z')
    // UTC−5:30 has a half-hour start.
    const w2 = dayWindow('2026-10-10', 330) as DayWindow
    expect(w2.start.toISOString()).toBe('2026-10-10T05:30:00.000Z')
  })

  it('clamps an offset past ±14 hours and refuses one that is not whole minutes', () => {
    expect((dayWindow('2026-10-10', '9999') as DayWindow).tzOffset).toBe(840)
    expect((dayWindow('2026-10-10', '-9999') as DayWindow).tzOffset).toBe(-840)
    expect(dayWindow('2026-10-10', 'abc')).toEqual({
      error: 'tz_offset must be a whole number of minutes'
    })
    expect(dayWindow('2026-10-10', '1.5')).toHaveProperty('error')
  })

  it('refuses a malformed or impossible date', () => {
    expect(dayWindow('2026-10-1', '0')).toEqual({ error: 'date must be YYYY-MM-DD' })
    expect(dayWindow('2026-02-31', '0')).toEqual({ error: 'date must be a real calendar day' })
  })

  it('defaults to today in the viewer’s zone', () => {
    // 23:30Z on 9 Oct is already 10 Oct for a UTC+2 viewer.
    const w = dayWindow(undefined, '-120', new Date('2026-10-09T23:30:00Z')) as DayWindow
    expect(w.date).toBe('2026-10-10')
  })
})

describe('bucketByMinute', () => {
  it('counts requests and errors per minute from the day’s start', () => {
    const start = new Date('2026-10-10T00:00:00Z')
    expect(
      bucketByMinute(
        [
          { created_at: '2026-10-10T08:00:05Z', status: 200 },
          { created_at: '2026-10-10T08:00:59Z', status: 500 },
          { created_at: '2026-10-10T08:01:00Z', status: 404 },
          { created_at: new Date('2026-10-10T00:00:00Z'), status: 200 }
        ],
        start
      )
    ).toEqual([
      { m: 0, n: 1, errors: 0 },
      { m: 480, n: 2, errors: 1 },
      { m: 481, n: 1, errors: 1 }
    ])
  })
})

describe('GET /journeys/day/:id', () => {
  it('refuses a non-administrator and logs nothing', async () => {
    installDb()
    state.admin = false
    const res = await get('/journeys/day/U-1?date=2026-10-10&tz_offset=0')
    expect(res.statusCode).toBe(403)
    expect(logActivity).not.toHaveBeenCalled()
    expect(db).not.toHaveBeenCalled()
  })

  it('answers 400 for a bad date and reads nothing', async () => {
    installDb()
    const res = await get('/journeys/day/U-1?date=10%2F10%2F2026')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/YYYY-MM-DD/)
    expect(db).not.toHaveBeenCalled()
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('returns every lane for the viewer’s day and logs the read once', async () => {
    installDb()
    rows = {
      nivaro_session_recordings: [
        {
          id: 'R1',
          app: 'admin',
          started_at: new Date('2026-10-10T07:00:00Z'),
          ended_at: new Date('2026-10-10T08:30:00Z'),
          last_event_at: new Date('2026-10-10T08:30:00Z')
        }
      ],
      nivaro_admin_journeys: [
        {
          session_id: 'S1',
          path: '/collections/orders',
          entered_at: new Date('2026-10-10T07:01:00Z'),
          duration_seconds: null
        },
        {
          session_id: 'S1',
          path: '/collections/orders/7',
          entered_at: new Date('2026-10-10T07:04:00Z'),
          duration_seconds: 90
        }
      ],
      nivaro_api_logs: [
        { created_at: new Date('2026-10-10T07:02:10Z'), status: 200 },
        { created_at: new Date('2026-10-10T07:02:40Z'), status: 503 }
      ],
      'nivaro_workflow_history as h': [
        {
          id: 9,
          timestamp: new Date('2026-10-10T07:05:00Z'),
          collection: 'orders',
          item: '7',
          from_label: 'Draft',
          to_label: 'Submitted',
          transition_label: 'Submit'
        }
      ],
      nivaro_tasks: [
        {
          id: 4,
          title: 'Call the supplier',
          collection: 'orders',
          item: '7',
          created_at: new Date('2026-10-10T07:06:00Z'),
          completed_at: new Date('2026-10-10T07:20:00Z')
        }
      ]
    }
    const res = await get('/journeys/day/U-1?date=2026-10-10&tz_offset=-120')
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.day_start).toBe('2026-10-09T22:00:00.000Z')
    expect(d.recordings).toEqual([
      {
        id: 'R1',
        app: 'admin',
        start: '2026-10-10T07:00:00.000Z',
        end: '2026-10-10T08:30:00.000Z',
        live: false
      }
    ])
    // The first step had no duration: it lasted until the next step.
    expect(d.pages.map((p: { end: string }) => p.end)).toEqual([
      '2026-10-10T07:04:00.000Z',
      '2026-10-10T07:05:30.000Z'
    ])
    expect(d.requests).toEqual([{ minute: '2026-10-10T07:02:00.000Z', count: 2, errors: 1 }])
    expect(d.transitions[0]).toMatchObject({
      collection: 'orders',
      item: '7',
      from: 'Draft',
      to: 'Submitted',
      label: 'Submit'
    })
    expect(d.tasks.map((t: { kind: string }) => t.kind)).toEqual(['created', 'completed'])
    expect(d.capped).toEqual([])

    // The window handed to the database is the viewer's day, not the server's.
    expect(wheres.nivaro_admin_journeys).toContainEqual([
      'entered_at',
      '>=',
      new Date('2026-10-09T22:00:00Z')
    ])

    expect(logActivity).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logActivity).mock.calls[0][0]).toMatchObject({
      action: 'person-day-read',
      user: 'ADMIN-1',
      collection: 'nivaro_users',
      item: 'U-1',
      comment: 'Opened the day of 2026-10-10 (UTC+02:00) on the People page'
    })
  })

  it('drops only the lane whose table is missing', async () => {
    installDb()
    failing = ['nivaro_session_recordings', 'nivaro_tasks']
    rows = {
      nivaro_api_logs: [{ created_at: new Date('2026-10-10T07:02:10Z'), status: 200 }]
    }
    const res = await get('/journeys/day/U-1?date=2026-10-10&tz_offset=0')
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.recordings).toBeNull()
    expect(d.tasks).toBeNull()
    expect(d.pages).toEqual([])
    expect(d.transitions).toEqual([])
    expect(d.requests).toHaveLength(1)
    expect(logActivity).toHaveBeenCalledTimes(1)
  })
})
