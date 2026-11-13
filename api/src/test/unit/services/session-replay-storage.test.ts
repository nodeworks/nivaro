import { gunzipSync, gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Storage tiering (#1411): recordings move to the storage driver as one
 * object, come back for a day when opened, and their objects go when they are
 * purged — against an in-memory table fake and a fake object store.
 */

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }))

vi.mock('../../../db/index.js', () => {
  type Pred = (r: Row) => boolean
  const val = (v: unknown) => (v instanceof Date ? v.getTime() : v)
  const cmp = (col: string, op: string, v: unknown): Pred => {
    return (r) => {
      const a = val(r[col])
      const b = val(v)
      if (a == null) return false
      if (op === '<') return (a as number) < (b as number)
      if (op === '>') return (a as number) > (b as number)
      if (op === '>=') return (a as number) >= (b as number)
      return a === b
    }
  }
  function group(fn: (q: unknown) => void): Pred {
    const ors: Pred[] = []
    const q: Record<string, (...a: unknown[]) => unknown> = {}
    q.whereNull = (c) => {
      ors.push((r) => r[c as string] == null)
      return q
    }
    q.whereNotNull = (c) => {
      ors.push((r) => r[c as string] != null)
      return q
    }
    q.orWhere = (c, op, v) => {
      ors.push(cmp(c as string, op as string, v))
      return q
    }
    q.where = q.orWhere
    fn(q)
    return (r) => ors.some((p) => p(r))
  }
  const db = vi.fn((table: string) => {
    h.tables[table] ??= []
    const preds: Pred[] = []
    let order: [string, string] | null = null
    let lim = Infinity
    const rows = () => {
      let out = h.tables[table].filter((r) => preds.every((p) => p(r)))
      if (order) {
        const [c, dir] = order
        out = [...out].sort(
          (a, b) => ((val(a[c]) as number) - (val(b[c]) as number)) * (dir === 'desc' ? -1 : 1)
        )
      }
      return out.slice(0, lim)
    }
    const pick = (r: Row, cols: string[]) =>
      cols.length ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r }
    const b: Record<string, (...a: unknown[]) => unknown> = {}
    b.where = (c, op, v) => {
      if (typeof c === 'function') preds.push(group(c as (q: unknown) => void))
      else if (typeof c === 'object') {
        for (const [k, x] of Object.entries(c as Row)) preds.push((r) => val(r[k]) === val(x))
      } else preds.push(cmp(c as string, op as string, v))
      return b
    }
    b.whereNull = (c) => {
      preds.push((r) => r[c as string] == null)
      return b
    }
    b.whereNotNull = (c) => {
      preds.push((r) => r[c as string] != null)
      return b
    }
    // whereNotIn(col, db('nivaro_replay_clips').select('recording')) — the only
    // subquery the service uses; an array is taken as is.
    b.whereNotIn = (c, list) => {
      const out = Array.isArray(list)
        ? (list as unknown[])
        : (h.tables.nivaro_replay_clips ?? []).map((x) => x.recording)
      preds.push((r) => !out.some((x) => val(x) === val(r[c as string])))
      return b
    }
    b.orderBy = (c, dir) => {
      order = [c as string, (dir as string) ?? 'asc']
      return b
    }
    b.limit = (n) => {
      lim = n as number
      return b
    }
    b.first = async (...cols) => {
      const r = rows()[0]
      return r ? pick(r, cols as string[]) : undefined
    }
    b.select = async (...cols) => rows().map((r) => pick(r, cols as string[]))
    b.pluck = async (c) => rows().map((r) => r[c as string])
    b.update = async (set) => {
      const hit = rows()
      for (const r of hit) Object.assign(r, set as Row)
      return hit.length
    }
    b.insert = async (x) => {
      for (const r of Array.isArray(x) ? x : [x]) h.tables[table].push({ ...(r as Row) })
      return [1]
    }
    b.del = async () => {
      const hit = new Set(rows())
      h.tables[table] = h.tables[table].filter((r) => !hit.has(r))
      return hit.size
    }
    return b
  })
  return { db }
})
vi.mock('../../../services/storage-drivers.js', () => ({
  getActiveStorageDriver: async () => {
    throw new Error('tests use the fake store')
  },
  readStoredObject: async () => {
    throw new Error('tests use the fake store')
  },
  deleteStoredObject: async () => {}
}))

import {
  coldKeyFor,
  deleteColdObject,
  ensureRecordingHot,
  HOT_CACHE_MS,
  moveRecordingCold,
  packReplayChunks,
  purgeColdObjects,
  replayObjectLines,
  resetReplayStorageState,
  runReplayTiering,
  setReplayObjectStore,
  validateColdAfterDays
} from '../../../services/session-replay-storage.js'

const objects = new Map<string, Buffer>()
let failPut = false
const store = {
  put: vi.fn(async (key: string, body: Buffer) => {
    if (failPut) throw new Error('S3 PUT failed: 503')
    objects.set(key, body)
  }),
  get: vi.fn(async (key: string) => {
    const b = objects.get(key)
    if (!b) throw new Error('404')
    return b
  }),
  delete: vi.fn(async (key: string) => {
    objects.delete(key)
  })
}

const NOW = new Date('2026-10-10T12:00:00Z')
const DAY = 86_400_000
const gz = (json: string) => `gz:${gzipSync(Buffer.from(json)).toString('base64')}`
/** A stored object's chunks: inflate, then read it line by line. */
const unpack = (body: Buffer) =>
  [...replayObjectLines(gunzipSync(body))].map((l) => ({
    seq: l.seq,
    json: l.json.toString('utf8')
  }))

function recording(id: string, ageDays: number, over: Row = {}): Row {
  const started = new Date(NOW.getTime() - ageDays * DAY)
  return {
    id,
    started_at: started,
    ended_at: started,
    last_event_at: started,
    byte_size: 100,
    cold: false,
    cold_key: null,
    cold_bytes: null,
    rehydrated_at: null,
    rehydrate_started_at: null,
    ...over
  }
}

function chunk(recordingId: string, seq: number, events: unknown[], plain = false): Row {
  const json = JSON.stringify(events)
  return { recording: recordingId, seq, events: plain ? json : gz(json), created_at: NOW }
}

const events = (id: string) =>
  (h.tables.nivaro_session_events ?? []).filter((r) => r.recording === id)
const rec = (id: string) => h.tables.nivaro_session_recordings.find((r) => r.id === id)!

beforeEach(() => {
  objects.clear()
  failPut = false
  vi.clearAllMocks()
  resetReplayStorageState()
  setReplayObjectStore(store)
  h.tables = {
    nivaro_settings: [{ id: 1, replay_cold_after_days: null }],
    nivaro_session_recordings: [],
    nivaro_session_events: []
  }
})

describe('object format', () => {
  it('round-trips gzip-stored and plain chunks with their seqs', () => {
    const body = packReplayChunks('R1', [
      { seq: 0, events: gz('[{"type":4,"data":{"href":"x\\ny"}}]') },
      { seq: 3, events: '[{"type":3,"timestamp":5}]' }
    ])
    expect(unpack(body)).toEqual([
      { seq: 0, json: '[{"type":4,"data":{"href":"x\\ny"}}]' },
      { seq: 3, json: '[{"type":3,"timestamp":5}]' }
    ])
    expect(() => unpack(gzipSync(Buffer.from('nope\n')))).toThrow()
  })

  it('reads the object line by line as bytes: every chunk, its seq, its text untouched', () => {
    const first = '[{"type":4,"data":{"href":"x\\ny","t":"naïve — 日本語 — 😀\\ttab"}}]'
    const body = packReplayChunks('R1', [
      { seq: 0, events: gz(first) },
      { seq: -1, events: gz('[{"type":2}]') },
      { seq: 12, events: '[{"type":3,"timestamp":5}]' }
    ])
    const lines = [...replayObjectLines(gunzipSync(body))]
    for (const l of lines) expect(Buffer.isBuffer(l.json)).toBe(true)
    expect(lines.map((l) => ({ seq: l.seq, json: l.json.toString('utf8') }))).toEqual([
      { seq: 0, json: first },
      { seq: -1, json: '[{"type":2}]' },
      { seq: 12, json: '[{"type":3,"timestamp":5}]' }
    ])
  })

  it('refuses an object without its header at once, and skips lines that are not chunks', () => {
    // At once: a reload checks the object before it deletes any row.
    expect(() => replayObjectLines(Buffer.from('nope\n0\t[1]\n'))).toThrow(
      'Not a session replay object'
    )
    expect(() => replayObjectLines(Buffer.from(''))).toThrow('Not a session replay object')
    const raw = Buffer.from(
      [
        '#nivaro-replay v1 R1',
        '0\t[1]',
        '',
        'no tab here',
        'x\t[2]',
        '\t[3]',
        '1.5\t[4]',
        '7\t[5]'
      ].join('\n')
    )
    expect([...replayObjectLines(raw)].map((l) => [l.seq, l.json.toString()])).toEqual([
      [0, '[1]'],
      [7, '[5]']
    ])
  })

  it('keys objects by start month', () => {
    expect(coldKeyFor('R1', new Date('2026-03-04T00:00:00Z'))).toBe(
      'session-replays/2026/03/R1.ndjson.gz'
    )
  })

  it('validates the setting', () => {
    expect(validateColdAfterDays('')).toEqual({ value: null })
    expect(validateColdAfterDays('7')).toEqual({ value: 7 })
    expect(validateColdAfterDays(0)).toHaveProperty('error')
    expect(validateColdAfterDays(2.5)).toHaveProperty('error')
  })
})

describe('moving a recording to storage', () => {
  it('writes one object, marks the row cold and deletes the event rows', async () => {
    h.tables.nivaro_session_recordings.push(recording('R1', 5))
    h.tables.nivaro_session_events.push(
      chunk('R1', 0, [{ type: 4 }]),
      chunk('R1', 1, [{ type: 3 }], true)
    )
    const r = await moveRecordingCold('R1', NOW)
    expect(r.moved).toBe(true)
    const key = coldKeyFor('R1', rec('R1').started_at as Date)
    expect(objects.has(key)).toBe(true)
    expect(rec('R1')).toMatchObject({ cold: true, cold_key: key, cold_bytes: r.bytes })
    expect(events('R1')).toHaveLength(0)
  })

  it('leaves the recording hot when the upload fails', async () => {
    h.tables.nivaro_session_recordings.push(recording('R1', 5))
    h.tables.nivaro_session_events.push(chunk('R1', 0, [{ type: 4 }]))
    failPut = true
    await expect(moveRecordingCold('R1', NOW)).rejects.toThrow(/503/)
    expect(rec('R1').cold).toBe(false)
    expect(events('R1')).toHaveLength(1)
  })

  it('moves only recordings past the setting that are no longer receiving events', async () => {
    h.tables.nivaro_settings[0].replay_cold_after_days = 3
    h.tables.nivaro_session_recordings.push(
      recording('OLD', 4),
      recording('NEW', 1),
      recording('LIVE', 4, { ended_at: null, last_event_at: new Date(NOW.getTime() - 60_000) }),
      recording('DONE', 10, { cold: true, cold_key: 'k' })
    )
    for (const id of ['OLD', 'NEW', 'LIVE']) h.tables.nivaro_session_events.push(chunk(id, 0, [1]))
    const r = await runReplayTiering({ now: NOW })
    expect(r).toMatchObject({ moved: 1, evicted: 0, failed: 0 })
    expect(rec('OLD').cold).toBe(true)
    expect(rec('NEW').cold).toBe(false)
    expect(rec('LIVE').cold).toBe(false)
  })

  it('counts a failed move and carries on', async () => {
    h.tables.nivaro_session_recordings.push(recording('A', 5), recording('B', 6))
    h.tables.nivaro_session_events.push(chunk('A', 0, [1]), chunk('B', 0, [1]))
    store.put.mockRejectedValueOnce(new Error('timeout'))
    const r = await runReplayTiering({ now: NOW })
    expect(r).toMatchObject({ moved: 1, failed: 1 })
  })
})

describe('opening a cold recording', () => {
  async function coldRecording() {
    h.tables.nivaro_session_recordings.push(recording('R1', 5))
    h.tables.nivaro_session_events.push(
      chunk('R1', 0, [{ type: 4, n: 0 }]),
      chunk('R1', 1, [{ type: 3, n: 1 }])
    )
    await moveRecordingCold('R1', NOW)
  }

  it('answers hot for a recording that never moved', async () => {
    h.tables.nivaro_session_recordings.push(recording('R1', 1))
    expect(await ensureRecordingHot('R1', { now: NOW })).toEqual({ state: 'hot' })
    expect(await ensureRecordingHot('nope', { now: NOW })).toEqual({ state: 'missing' })
  })

  it('answers loading, puts the chunks back, then answers hot for a day', async () => {
    await coldRecording()
    expect(await ensureRecordingHot('R1', { now: NOW })).toEqual({ state: 'loading' })
    // a second poll joins the same reload instead of starting another
    expect(await ensureRecordingHot('R1', { now: NOW })).toEqual({ state: 'loading' })
    await vi.waitFor(() => expect(rec('R1').rehydrated_at).toBeTruthy())
    expect(store.get).toHaveBeenCalledTimes(1)
    const back = events('R1').sort((a, b) => (a.seq as number) - (b.seq as number))
    expect(back.map((r) => r.seq)).toEqual([0, 1])
    expect(String(back[0].events).startsWith('gz:')).toBe(true)
    const later = new Date((rec('R1').rehydrated_at as Date).getTime() + 60_000)
    expect(await ensureRecordingHot('R1', { now: later })).toEqual({ state: 'hot' })
  })

  // A recording from before gzip storage can hold a chunk that was cut short. While it was
  // plain text every reader skipped it. Moved to storage it rides along as a line, and a
  // reload stores every line as a gzip chunk, which the events answer joins as stored,
  // without parsing: that one chunk would make the whole recording unreadable.
  it('leaves out a chunk that is not a JSON array, so the rest still plays', async () => {
    h.tables.nivaro_session_recordings.push(recording('R1', 5))
    h.tables.nivaro_session_events.push(
      chunk('R1', 0, [{ type: 4, n: 0 }], true),
      { recording: 'R1', seq: 1, events: '[{"type":3,', created_at: NOW },
      { recording: 'R1', seq: 2, events: '{"not":"an array"}', created_at: NOW },
      chunk('R1', 3, [{ type: 3, n: 3 }], true)
    )
    await moveRecordingCold('R1', NOW)
    expect(await ensureRecordingHot('R1', { now: NOW })).toEqual({ state: 'loading' })
    await vi.waitFor(() => expect(rec('R1').rehydrated_at).toBeTruthy())
    const back = events('R1').sort((a, b) => (a.seq as number) - (b.seq as number))
    expect(back.map((r) => r.seq)).toEqual([0, 3])
    for (const r of back) {
      const text = gunzipSync(Buffer.from(String(r.events).slice(3), 'base64')).toString('utf8')
      expect(Array.isArray(JSON.parse(text))).toBe(true)
    }
  })

  it('puts back chunks that read as exactly the events that were moved', async () => {
    const first = [
      { type: 4, data: { href: 'https://app.test/a\nb', title: 'naïve — 日本語 — 😀' } }
    ]
    const second = [{ type: 3, timestamp: 5, data: { text: 'tab\there "quoted" \\ \u2028' } }]
    h.tables.nivaro_session_recordings.push(recording('R1', 5))
    h.tables.nivaro_session_events.push(
      chunk('R1', 0, first),
      chunk('R1', 1, second, true),
      chunk('R1', -1, [{ type: 2 }])
    )
    await moveRecordingCold('R1', NOW)
    expect(await ensureRecordingHot('R1', { wait: true, now: NOW })).toEqual({ state: 'hot' })
    const back = events('R1').sort((a, b) => (a.seq as number) - (b.seq as number))
    const decode = (stored: unknown) =>
      JSON.parse(gunzipSync(Buffer.from(String(stored).slice(3), 'base64')).toString('utf8'))
    expect(back.map((r) => r.seq)).toEqual([-1, 0, 1])
    for (const r of back) expect(String(r.events).startsWith('gz:')).toBe(true)
    expect(decode(back[0].events)).toEqual([{ type: 2 }])
    expect(decode(back[1].events)).toEqual(first)
    expect(decode(back[2].events)).toEqual(second)
  })

  it('reloads many chunks in batches, all of them, in order', async () => {
    h.tables.nivaro_session_recordings.push(recording('R1', 5))
    for (let seq = 0; seq < 60; seq++) {
      h.tables.nivaro_session_events.push(chunk('R1', seq, [{ type: 3, n: seq }]))
    }
    await moveRecordingCold('R1', NOW)
    expect(await ensureRecordingHot('R1', { wait: true, now: NOW })).toEqual({ state: 'hot' })
    expect(events('R1').map((r) => r.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i))
  })

  it('lets other work run while it reloads: nothing is inflated or packed on the event loop', async () => {
    h.tables.nivaro_session_recordings.push(recording('R1', 5))
    for (let seq = 0; seq < 40; seq++) {
      h.tables.nivaro_session_events.push(chunk('R1', seq, [{ type: 3, n: seq }]))
    }
    await moveRecordingCold('R1', NOW)
    // Something already waiting on the event loop gets its turn before the reload is done.
    let otherWorkRanAt: number | null = null
    setImmediate(() => {
      otherWorkRanAt = events('R1').length
    })
    expect(await ensureRecordingHot('R1', { wait: true, now: NOW })).toEqual({ state: 'hot' })
    expect(events('R1')).toHaveLength(40)
    expect(otherWorkRanAt).not.toBeNull()
    expect(otherWorkRanAt).toBeLessThan(40)
  })

  it('touches no row when the stored object is not a replay object', async () => {
    await coldRecording()
    const key = rec('R1').cold_key as string
    objects.set(key, gzipSync(Buffer.from('something else entirely\n0\t[1]\n')))
    // A leftover row from an earlier reload must survive a reload that cannot be read.
    h.tables.nivaro_session_events.push(chunk('R1', 9, [{ type: 3 }]))
    expect(await ensureRecordingHot('R1', { wait: true, now: NOW })).toMatchObject({
      state: 'failed'
    })
    expect(events('R1').map((r) => r.seq)).toEqual([9])
  })

  it('waits for the reload when asked (the Playwright export)', async () => {
    await coldRecording()
    expect(await ensureRecordingHot('R1', { wait: true, now: NOW })).toEqual({ state: 'hot' })
    expect(events('R1')).toHaveLength(2)
  })

  it('leaves a reload another replica claimed to that replica', async () => {
    await coldRecording()
    rec('R1').rehydrate_started_at = new Date(NOW.getTime() - 10_000)
    expect(await ensureRecordingHot('R1', { now: NOW })).toEqual({ state: 'loading' })
    expect(store.get).not.toHaveBeenCalled()
  })

  it('reports a reload that failed', async () => {
    await coldRecording()
    objects.clear()
    expect(await ensureRecordingHot('R1', { wait: true, now: NOW })).toMatchObject({
      state: 'failed'
    })
    expect(rec('R1').rehydrate_started_at).toBeNull()
  })

  it('drops the hot cache a day after the reload; the object stays', async () => {
    await coldRecording()
    await ensureRecordingHot('R1', { wait: true, now: NOW })
    const r = await runReplayTiering({
      now: new Date((rec('R1').rehydrated_at as Date).getTime() + HOT_CACHE_MS + 1000)
    })
    expect(r.evicted).toBe(1)
    expect(events('R1')).toHaveLength(0)
    expect(rec('R1').rehydrated_at).toBeNull()
    expect(objects.size).toBe(1)
  })
})

describe('purge', () => {
  it('deletes the objects of recordings the retention purge drops, and of a deleted one', async () => {
    h.tables.nivaro_session_recordings.push(
      recording('OLD', 30, { cold: true, cold_key: 'session-replays/a' }),
      recording('KEEP', 5, { cold: true, cold_key: 'session-replays/b' })
    )
    objects.set('session-replays/a', Buffer.from('a'))
    objects.set('session-replays/b', Buffer.from('b'))
    expect(await purgeColdObjects(new Date(NOW.getTime() - 7 * DAY))).toBe(1)
    expect([...objects.keys()]).toEqual(['session-replays/b'])
    await deleteColdObject('KEEP')
    expect(objects.size).toBe(0)
  })

  it('keeps the object of a recording the clip library holds (#1415)', async () => {
    h.tables.nivaro_session_recordings.push(
      recording('CLIP', 30, { cold: true, cold_key: 'session-replays/c' })
    )
    h.tables.nivaro_replay_clips = [{ id: 'K1', recording: 'CLIP' }]
    objects.set('session-replays/c', Buffer.from('c'))
    expect(await purgeColdObjects(new Date(NOW.getTime() - 7 * DAY))).toBe(0)
    expect([...objects.keys()]).toEqual(['session-replays/c'])
  })
})
