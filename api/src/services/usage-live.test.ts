import { beforeEach, describe, expect, it, vi } from 'vitest'

const emitted: Array<{ room: string; event: string; payload: unknown }> = []
vi.mock('./io-holder.js', () => ({
  getIo: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => emitted.push({ room, event, payload })
    })
  })
}))

import { revokeSessions, sessionOwners } from '../auth/session.js'
import { sessionDetail } from '../routes/security.js'
import { noteSessionsChanged, sessionsChangedNotices } from './sessions-live.js'
import {
  _resetUsageCache,
  type LiveUsage,
  measureUsage,
  monthStartUtc,
  noteUsageChanged,
  readLiveUsage,
  writeMovesUsage
} from './usage-live.js'

const usage = (n: number): LiveUsage => ({
  records: { count: n, approx: true },
  storage: { bytes: 0, files: 0 },
  ai: { tokens: 0, calls: 0, since: '2026-11-01T00:00:00.000Z' },
  users: { count: 1 },
  at: new Date().toISOString()
})

describe('writeMovesUsage', () => {
  it('counts creates and deletes of business records, never updates', () => {
    expect(writeMovesUsage('workflows', 1, 'create')).toBe(true)
    expect(writeMovesUsage('workflows', 1, 'delete')).toBe(true)
    expect(writeMovesUsage('workflows', 1, 'update', ['title'])).toBe(false)
  })
  it('a bulk raw write may have added or removed rows', () => {
    expect(writeMovesUsage('workflows', '*', undefined)).toBe(true)
  })
  it('ignores system tables except files and people', () => {
    expect(writeMovesUsage('nivaro_activity', 1, 'create')).toBe(false)
    expect(writeMovesUsage('directus_files', 1, 'create')).toBe(false)
    expect(writeMovesUsage('nivaro_files', 1, 'create')).toBe(true)
    expect(writeMovesUsage('nivaro_users', 'u', 'delete')).toBe(true)
  })
  it('a person only moves the count when their status changes', () => {
    expect(writeMovesUsage('nivaro_users', 'u', 'update', ['last_access'])).toBe(false)
    expect(writeMovesUsage('nivaro_users', 'u', 'update', ['status'])).toBe(true)
    expect(writeMovesUsage('nivaro_files', 1, 'update', ['title'])).toBe(false)
    expect(writeMovesUsage('nivaro_files', 1, 'update', ['filesize'])).toBe(true)
  })
})

describe('readLiveUsage', () => {
  beforeEach(() => {
    _resetUsageCache()
    emitted.length = 0
  })

  it('serves the cached answer until a write marks it stale', async () => {
    let n = 0
    const measure = vi.fn(async () => usage(++n))
    expect((await readLiveUsage(measure)).records.count).toBe(1)
    expect((await readLiveUsage(measure)).records.count).toBe(1)
    expect(measure).toHaveBeenCalledTimes(1)
    noteUsageChanged()
    expect((await readLiveUsage(measure)).records.count).toBe(2)
    expect(measure).toHaveBeenCalledTimes(2)
  })

  it('reads single-flight', async () => {
    let release: (v: LiveUsage) => void = () => {}
    const measure = vi.fn(() => new Promise<LiveUsage>((r) => (release = r)))
    const a = readLiveUsage(measure)
    const b = readLiveUsage(measure)
    release(usage(7))
    expect((await a).records.count).toBe(7)
    expect((await b).records.count).toBe(7)
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('a write during a read keeps the next read fresh', async () => {
    let release: (v: LiveUsage) => void = () => {}
    const measure = vi.fn(() => new Promise<LiveUsage>((r) => (release = r)))
    const a = readLiveUsage(measure)
    noteUsageChanged()
    release(usage(1))
    await a
    const fresh = vi.fn(async () => usage(2))
    expect((await readLiveUsage(fresh)).records.count).toBe(2)
  })
})

describe('measureUsage', () => {
  it('sums the figures and survives a database that refuses every read', async () => {
    const broken = Object.assign(
      () => {
        throw new Error('no db')
      },
      {
        raw: async () => Promise.reject(new Error('no db')),
        client: { config: { client: 'mssql' } }
      }
    )
    const u = await measureUsage(broken as never, new Date('2026-11-15T12:00:00Z'))
    expect(u.records.count).toBeNull()
    expect(u.storage).toEqual({ bytes: 0, files: 0 })
    expect(u.ai.since).toBe('2026-11-01T00:00:00.000Z')
  })
  it('month start is UTC', () => {
    expect(monthStartUtc(new Date('2026-12-01T03:00:00Z')).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z'
    )
  })
})

describe('sessions live notices', () => {
  beforeEach(() => {
    emitted.length = 0
  })
  it('names people only, deduplicated and upper-cased', () => {
    expect(sessionsChangedNotices(['ab-1', 'AB-1', null, 'cd'])).toEqual([
      { user_id: 'AB-1' },
      { user_id: 'CD' }
    ])
    expect(sessionsChangedNotices([])).toEqual([])
    expect(sessionsChangedNotices(Array.from({ length: 60 }, (_, i) => `u${i}`))).toEqual([
      { all: true }
    ])
  })
  it('emits to the admin-gated sessions topic room after a settle', async () => {
    vi.useFakeTimers()
    try {
      noteSessionsChanged(['u1'])
      expect(emitted).toHaveLength(0)
      vi.advanceTimersByTime(600)
      expect(emitted).toHaveLength(1)
      expect(emitted[0].room).toBe('ops:sessions')
      expect(emitted[0].event).toBe('ops:changed')
      const p = emitted[0].payload as Record<string, unknown>
      expect(p.topic).toBe('sessions')
      expect(p.user_id).toBe('U1')
      expect(Object.keys(p).sort()).toEqual(['at', 'topic', 'user_id'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('a revoke learns whose sessions it ended from the blobs it read', () => {
    expect(sessionOwners([JSON.stringify({ userId: 'u1' }), null, '{bad', '{}'])).toEqual(['u1'])
    expect(sessionOwners(null)).toEqual([])
  })
  it('revoking a session tells the admins watching that person — by id only', async () => {
    const kv = new Map([['sess:s1', JSON.stringify({ userId: 'u9', signInIp: '10.0.0.1' })]])
    const redis = {
      mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
      multi() {
        const m = { del: () => m, setex: () => m, exec: async () => [] }
        return m
      }
    }
    await revokeSessions(redis as never, ['s1'])
    await new Promise((r) => setTimeout(r, 700))
    const p = emitted.find((e) => e.room === 'ops:sessions')?.payload as Record<string, unknown>
    expect(p?.user_id).toBe('U9')
    expect(JSON.stringify(p)).not.toContain('s1')
    expect(JSON.stringify(p)).not.toContain('10.0.0.1')
  })
  it('a revoke whose owner read fails still revokes', async () => {
    let exec = 0
    const redis = {
      mget: async () => {
        throw new Error('down')
      },
      multi() {
        const m = {
          del: () => m,
          setex: () => m,
          exec: async () => {
            exec++
            return []
          }
        }
        return m
      }
    }
    await revokeSessions(redis as never, ['s1'])
    expect(exec).toBe(1)
  })
})

describe('sessionDetail', () => {
  it('describes the browser, address and sign-in time — nothing else', () => {
    const d = sessionDetail({
      userId: 'u',
      authAt: Date.UTC(2026, 10, 14, 15, 42),
      signInIp: '10.0.0.4',
      signInAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      returnTo: 'https://x'
    })
    expect(d).toEqual({
      device: 'Chrome on macOS',
      ip: '10.0.0.4',
      signed_in_at: '2026-11-14T15:42:00.000Z'
    })
    expect(sessionDetail(null)).toEqual({ device: null, ip: null, signed_in_at: null })
  })
})
