import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import {
  fetchLatestRevisions,
  incrementGuarded,
  LATEST_BATCH,
  lineLabelOf,
  noteLineReads,
  RowBaseBook,
  rowBaseBookFor,
  withRowBaseRevision,
  writeLineGuarded
} from './line-midair'

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

const midair = (latest: number, field = 'qty', current: unknown = 7) =>
  Object.assign(new Error('409'), {
    response: {
      status: 409,
      data: {
        code: 'MIDAIR_COLLISION',
        conflicts: [{ field, current_value: current }],
        latest_revision: latest
      }
    }
  })

/** A fake client: `/revisions/latest` answers from `latest`, item reads from
 *  `rows`, PATCHes are recorded (and may throw). */
function fakeClient(opts: {
  latest?: Record<string, number | null>
  rows?: Record<string, Record<string, unknown>>
  patchError?: (cmd: Cmd, n: number) => unknown
  batchMissing?: boolean
}) {
  const calls: Cmd[] = []
  let patches = 0
  const request = vi.fn(async (cmd: Cmd) => {
    calls.push(cmd)
    if (cmd._method === 'GET' && cmd._path === '/revisions/latest') {
      if (opts.batchMissing) throw Object.assign(new Error('nf'), { status: 404 })
      const ids = String(cmd._params?.items ?? '').split(',')
      const data: Record<string, number | null> = {}
      for (const id of ids) if (opts.latest && id in opts.latest) data[id] = opts.latest[id]
      return { data }
    }
    if (cmd._method === 'GET' && cmd._path === '/revisions') {
      const id = String(cmd._params?.item)
      return { data: { latest: opts.latest?.[id] ?? null } }
    }
    if (cmd._method === 'GET' && cmd._path.startsWith('/items/')) {
      const id = cmd._path.split('/').pop() as string
      return { data: opts.rows?.[id] ?? null }
    }
    if (cmd._method === 'PATCH') {
      const err = opts.patchError?.(cmd, patches++)
      if (err) throw err
      return { data: {} }
    }
    return { data: null }
  })
  return { client: { request } as never, calls }
}

describe('withRowBaseRevision', () => {
  it('adds a positive base, leaves the body alone otherwise', () => {
    expect(withRowBaseRevision({ a: 1 }, 5)).toEqual({ a: 1, _base_revision: 5 })
    const body = { a: 1 }
    expect(withRowBaseRevision(body, 0)).toBe(body)
    expect(withRowBaseRevision(body, null)).toBe(body)
  })
})

describe('fetchLatestRevisions', () => {
  it('reads every id in ONE batched request; unreadable ids are absent', async () => {
    const { client, calls } = fakeClient({ latest: { '1': 10, '2': null } })
    const m = await fetchLatestRevisions(client, 'lines', ['1', '2', '3', 'pending:0', 'new'])
    expect(calls).toHaveLength(1)
    expect(calls[0]._params).toEqual({ collection: 'lines', items: '1,2,3' })
    expect(m.get('1')).toBe(10)
    expect(m.has('2')).toBe(true)
    expect(m.get('2')).toBeNull()
    expect(m.has('3')).toBe(false)
  })

  it('splits past the route cap', async () => {
    const ids = Array.from({ length: LATEST_BATCH + 3 }, (_, i) => String(i + 1))
    const { client, calls } = fakeClient({ latest: {} })
    await fetchLatestRevisions(client, 'lines', ids)
    expect(calls).toHaveLength(2)
  })

  it('falls back to one latest_only read per id on an API without the route', async () => {
    const { client, calls } = fakeClient({ latest: { '1': 4, '2': 9 }, batchMissing: true })
    const m = await fetchLatestRevisions(client, 'lines', ['1', '2'])
    expect(m.get('1')).toBe(4)
    expect(m.get('2')).toBe(9)
    expect(calls.filter((c) => c._path === '/revisions')).toHaveLength(2)
  })
})

describe('RowBaseBook (M1: base from the read, not the first edit)', () => {
  it('takes every new row of a read in one batch and keeps it while the row is unchanged', async () => {
    const latest: Record<string, number | null> = { '1': 10, '2': 20 }
    const fetcher = vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, latest[i] ?? null])))
    const book = new RowBaseBook(fetcher)
    book.noteRows([
      { id: 1, qty: 3 },
      { id: 2, qty: 5 }
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
    // Someone else saves line 1 after the read — the base stays the read's.
    latest['1'] = 11
    book.noteRows([
      { id: 1, qty: 3 },
      { id: 2, qty: 5 }
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await book.baseOf('1')).toBe(10)
    expect(book.settled('1')).toBe(10)
  })

  it('a read that shows a changed row takes a fresh base for that row only', async () => {
    const latest: Record<string, number | null> = { '1': 10, '2': 20 }
    const fetcher = vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, latest[i] ?? null])))
    const book = new RowBaseBook(fetcher)
    book.noteRows([
      { id: 1, qty: 3 },
      { id: 2, qty: 5 }
    ])
    latest['1'] = 11
    book.noteRows([
      { id: 1, qty: 4 },
      { id: 2, qty: 5 }
    ])
    expect(fetcher).toHaveBeenLastCalledWith(['1'])
    expect(await book.baseOf('1')).toBe(11)
    expect(await book.baseOf('2')).toBe(20)
  })

  it('an unknown base is fetched before the write, never skipped', async () => {
    const fetcher = vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, 42])))
    const book = new RowBaseBook(fetcher)
    expect(await book.baseOf('7')).toBe(42)
    expect(fetcher).toHaveBeenCalledWith(['7'])
  })

  it('a failed read-time fetch is retried at write time', async () => {
    let fail = true
    const fetcher = vi.fn(async (ids: string[]) => {
      if (fail) throw new Error('down')
      return new Map(ids.map((i) => [i, 8]))
    })
    const book = new RowBaseBook(fetcher)
    book.noteRows([{ id: 3, qty: 1 }])
    fail = false
    expect(await book.baseOf('3')).toBe(8)
  })

  it('forget drops the base (own write); set pins the 409 revision', async () => {
    const fetcher = vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, 5])))
    const book = new RowBaseBook(fetcher)
    book.noteRows([{ id: 1 }])
    await book.baseOf('1')
    book.set('1', 99)
    expect(await book.baseOf('1')).toBe(99)
    book.forget('1')
    expect(book.settled('1')).toBeUndefined()
  })
})

describe('writeLineGuarded (H4: every immediate line write carries its base)', () => {
  it('sends the read-time base with the body', async () => {
    const { client, calls } = fakeClient({ latest: { '5': 30 } })
    const book = new RowBaseBook((ids) => fetchLatestRevisions(client, 'lines', ids))
    book.noteRows([{ id: 5, qty: 1 }])
    const r = await writeLineGuarded(
      client,
      book,
      '/items/lines/5',
      '5',
      { qty: 2 },
      {
        key: 'lines.workflow',
        label: 'Line 1'
      }
    )
    expect(r.ok).toBe(true)
    const p = calls.find((c) => c._method === 'PATCH')
    expect(p?._body).toEqual({ qty: 2, _base_revision: 30 })
  })

  it('a 409 is a conflict for the chooser — nothing overwritten, book pinned to theirs', async () => {
    const { client, calls } = fakeClient({
      latest: { '5': 30 },
      patchError: () => midair(31, 'qty', 9)
    })
    const book = new RowBaseBook((ids) => fetchLatestRevisions(client, 'lines', ids))
    const r = await writeLineGuarded(
      client,
      book,
      '/items/lines/5',
      '5',
      { qty: 2 },
      {
        key: 'lines.workflow',
        label: 'Line 3'
      }
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.conflict).toMatchObject({
      rowId: '5',
      label: 'Line 3',
      latest: 31,
      mine: { qty: 2 },
      url: '/items/lines/5',
      conflicts: [{ field: 'qty', current_value: 9 }]
    })
    expect(calls.filter((c) => c._method === 'PATCH')).toHaveLength(1)
    expect(book.settled('5')).toBe(31)
  })

  it('other errors are thrown as before', async () => {
    const { client } = fakeClient({ latest: { '5': 1 }, patchError: () => new Error('boom') })
    const book = new RowBaseBook((ids) => fetchLatestRevisions(client, 'lines', ids))
    await expect(
      writeLineGuarded(client, book, '/items/lines/5', '5', { qty: 2 }, { key: 'k', label: 'L' })
    ).rejects.toThrow('boom')
  })
})

describe('incrementGuarded (allocation add, never a blind read-modify-write)', () => {
  it('adds to the value as read, with the base read BEFORE it', async () => {
    const { client, calls } = fakeClient({ latest: { '9': 70 }, rows: { '9': { id: 9, qty: 4 } } })
    expect(await incrementGuarded(client, 'alloc', '9', 'qty', 3)).toBe(true)
    const order = calls.map((c) => `${c._method} ${c._path}`)
    expect(order).toEqual(['GET /revisions/latest', 'GET /items/alloc/9', 'PATCH /items/alloc/9'])
    expect(calls[2]._body).toEqual({ qty: 7, _base_revision: 70 })
  })

  it('a concurrent save is re-read and the add lands on the newer value (no lost units)', async () => {
    const rows: Record<string, Record<string, unknown>> = { '9': { id: 9, qty: 4 } }
    const latest: Record<string, number | null> = { '9': 70 }
    const { client, calls } = fakeClient({
      latest,
      rows,
      patchError: (_c, n) => {
        if (n === 0) {
          // Someone else added 5 between our read and our write.
          rows['9'] = { id: 9, qty: 9 }
          latest['9'] = 71
          return midair(71)
        }
        return null
      }
    })
    expect(await incrementGuarded(client, 'alloc', '9', 'qty', 3)).toBe(true)
    const patches = calls.filter((c) => c._method === 'PATCH')
    expect(patches[1]._body).toEqual({ qty: 12, _base_revision: 71 })
  })

  it('gives up (writes nothing more) when it keeps changing', async () => {
    const { client, calls } = fakeClient({
      latest: { '9': 70 },
      rows: { '9': { id: 9, qty: 4 } },
      patchError: () => midair(71)
    })
    expect(await incrementGuarded(client, 'alloc', '9', 'qty', 3, 2)).toBe(false)
    expect(calls.filter((c) => c._method === 'PATCH')).toHaveLength(2)
  })
})

describe('noteLineReads + rowBaseBookFor (M1 for every grid kind on the record form)', () => {
  it('one book per client + collection, shared by every caller', () => {
    const { client } = fakeClient({})
    expect(rowBaseBookFor(client, 'lines')).toBe(rowBaseBookFor(client, 'lines'))
    expect(rowBaseBookFor(client, 'lines')).not.toBe(rowBaseBookFor(client, 'other'))
  })

  it("a read of this record's lines notes their bases in one batch; other records are ignored", async () => {
    const { client, calls } = fakeClient({ latest: { '1': 10, '2': 20, '9': 90 } })
    const qc = new QueryClient()
    const stop = noteLineReads(qc, client, '100')
    qc.setQueryData(['o2m-rows', 'lines', 'workflow', '100', ''], [{ id: 1 }, { id: 2 }])
    qc.setQueryData(['o2m-rows', 'lines', 'workflow', '200', ''], [{ id: 9 }])
    await Promise.resolve()
    const batches = calls.filter((c) => c._path === '/revisions/latest')
    expect(batches).toHaveLength(1)
    expect(batches[0]._params?.items).toBe('1,2')
    expect(await rowBaseBookFor(client, 'lines').peek('2')).toBe(20)
    stop()
    qc.setQueryData(['o2m-rows', 'lines', 'workflow', '100', ''], [{ id: 1, q: 2 }])
    expect(calls.filter((c) => c._path === '/revisions/latest')).toHaveLength(1)
  })

  it('notes what is already cached when it starts', async () => {
    const { client } = fakeClient({ latest: { '4': 44 } })
    const qc = new QueryClient()
    qc.setQueryData(['o2m-rows', 'parts', 'po', '7'], [{ id: 4 }])
    const stop = noteLineReads(qc, client, '7')
    expect(await rowBaseBookFor(client, 'parts').peek('4')).toBe(44)
    stop()
  })
})

// army5 b09-N6: the collision dialog said "Line 1" for a forecast year.
describe('lineLabelOf', () => {
  it('a line number wins', () => {
    expect(lineLabelOf([{ id: 5, line_number: 3, year: 2027 }], '5')).toBe('Line 3')
  })
  it("a row without a line number uses the caller's label, then its year", () => {
    expect(lineLabelOf([{ id: 5, year: 2027 }], '5', null, () => '2027 forecast')).toBe(
      '2027 forecast'
    )
    expect(lineLabelOf([{ id: 5, year: 2027 }], '5')).toBe('Year 2027')
  })
  it('falls back to the position, then the id', () => {
    expect(lineLabelOf([{ id: 4 }, { id: 5 }], '5')).toBe('Line 2')
    expect(lineLabelOf([], '9')).toBe('Row 9')
  })
})
