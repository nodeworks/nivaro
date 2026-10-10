import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({
  db: Object.assign(vi.fn(), { transaction: vi.fn(), raw: vi.fn() })
}))

import { db } from '../../../db/index.js'
import { runHeatFold } from '../../../services/session-replay-heat.js'

type Calls = Array<[string, unknown[]]>

function chain(rows: unknown[], first?: unknown) {
  const calls: Calls = []
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          const p = Promise.resolve(rows)
          return p.then.bind(p)
        }
        if (prop === 'first')
          return (...a: unknown[]) => {
            calls.push(['first', a])
            return Promise.resolve(first)
          }
        return (...a: unknown[]) => {
          calls.push([prop, a])
          return proxy
        }
      }
    }
  )
  return { proxy, calls }
}

const T0 = Date.parse('2026-10-01T12:00:00.000Z')
const gz = (v: unknown) => `gz:${gzipSync(Buffer.from(JSON.stringify(v))).toString('base64')}`

afterEach(() => vi.clearAllMocks())

describe('runHeatFold', () => {
  it('folds settled recordings, merges into the table, points frames and stamps the high-water mark', async () => {
    const events = [
      { type: 4, timestamp: T0, data: { href: 'https://a/queues', width: 1000, height: 1000 } },
      {
        type: 2,
        timestamp: T0 + 1,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                id: 2,
                tagName: 'button',
                attributes: { 'data-testid': 'go' },
                childNodes: []
              }
            ]
          }
        }
      },
      { type: 3, timestamp: T0 + 100, data: { source: 2, type: 2, id: 2, x: 500, y: 10 } }
    ]
    const tables = {
      nivaro_session_recordings: chain([{ id: 'rec-1', app: null, byte_size: 10 }]),
      nivaro_session_events: chain([{ events: gz(events) }]),
      nivaro_replay_heat: chain([
        // already in the table from an earlier run: the same cell, 2 clicks
        {
          app: 'admin',
          route: '/queues',
          day: '2026-10-01',
          kind: 'click',
          selector: '[data-testid="go"]',
          x_bucket: 25,
          y_bucket: 0,
          depth_bucket: null,
          viewport: 'sm',
          count: 2
        }
      ]),
      nivaro_replay_heat_frames: chain([], undefined)
    }
    const fn = ((t: keyof typeof tables) => tables[t].proxy) as never
    vi.mocked(db).mockImplementation(fn)
    vi.mocked(db.transaction).mockImplementation((async (cb: (trx: unknown) => unknown) =>
      cb(fn)) as never)

    const now = new Date('2026-10-02T02:05:00.000Z')
    const summary = await runHeatFold({ now })
    expect(summary).toMatch(/^1 recording\(s\) folded \(1 clicks/)

    // Candidates: unfolded, not error clips, settled — oldest first.
    const rc = tables.nivaro_session_recordings.calls
    expect(rc).toContainEqual(['whereNull', ['heat_folded_at']])
    expect(rc).toContainEqual(['orderBy', ['started_at', 'asc']])
    expect(rc).toContainEqual(['update', [{ heat_folded_at: now }]])

    // Merge: the (app, route, day) group is rewritten with summed counts, no person in it.
    const hc = tables.nivaro_replay_heat.calls
    const inserts = hc.filter(([m]) => m === 'insert').flatMap(([, a]) => a[0] as unknown[])
    const click = inserts.find((r) => (r as { kind: string }).kind === 'click') as Record<
      string,
      unknown
    >
    expect(click).toMatchObject({ selector: '[data-testid="go"]', count: 3, x_bucket: 25 })
    for (const r of inserts) expect(r).not.toHaveProperty('user')
    expect(inserts.find((r) => (r as { kind: string }).kind === 'scroll')).toMatchObject({
      depth_bucket: 4,
      count: 1
    })

    // Frame pointer for the route.
    const fc = tables.nivaro_replay_heat_frames.calls
    expect(fc).toContainEqual([
      'insert',
      [
        {
          app: 'admin',
          route: '/queues',
          recording_id: 'rec-1',
          at_ms: T0 + 100,
          width: 1000,
          height: 1000,
          updated_at: now
        }
      ]
    ])
  })

  it('takes at most the byte budget, but always at least one recording', async () => {
    const tables = {
      nivaro_session_recordings: chain([
        { id: 'a', app: null, byte_size: 900 },
        { id: 'b', app: null, byte_size: 900 }
      ]),
      nivaro_session_events: chain([]),
      nivaro_replay_heat: chain([]),
      nivaro_replay_heat_frames: chain([], undefined)
    }
    const fn = ((t: keyof typeof tables) => tables[t].proxy) as never
    vi.mocked(db).mockImplementation(fn)
    const summary = await runHeatFold({ maxBytes: 500 })
    expect(summary).toMatch(/^1 recording\(s\) folded.*1 left for the next run/)
    expect(tables.nivaro_session_recordings.calls).toContainEqual(['whereIn', ['id', ['a']]])
  })
})
