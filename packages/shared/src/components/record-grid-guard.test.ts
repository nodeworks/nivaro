import { describe, expect, it, vi } from 'vitest'
import { conflictTip, saveStatus } from './RecordGridEditor'
import { conflictsOf, GridRowGuard, gridRowPatch, takeTheirs } from './record-grid-guard'

// Realtime gaps R1 (2026-11-17): the record-grid editor showed "Beth is editing"
// but its save overwrote her values and stored a total summed from stale months.

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

function fakeClient(latest: Record<string, number>, patchError?: (cmd: Cmd) => unknown) {
  const calls: Cmd[] = []
  const request = vi.fn(async (cmd: Cmd) => {
    calls.push(cmd)
    if (cmd._method === 'GET' && cmd._path === '/revisions/latest') {
      const data: Record<string, number> = {}
      for (const id of String(cmd._params?.items ?? '').split(','))
        if (id in latest) data[id] = latest[id]
      return { data }
    }
    if (cmd._method === 'PATCH') {
      const err = patchError?.(cmd)
      if (err) throw err
      return { data: {} }
    }
    return { data: null }
  })
  return { client: { request } as never, calls }
}

const midair = (latest: number, field: string, current: unknown) =>
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

const MONTHS = ['january', 'february', 'march']

describe('gridRowPatch', () => {
  it('sends only changed cells and leaves the total to the server', () => {
    const body = gridRowPatch(
      { january: '5', february: '20' },
      { id: 1, january: 1, february: 20, march: 3, total: 24 },
      (f) => MONTHS.includes(f),
      { field: 'total', of: MONTHS }
    )
    expect(body).toEqual({ january: 5, _sum_into: { field: 'total', of: MONTHS } })
  })

  it('nothing changed (typed then reverted) = nothing to write', () => {
    expect(gridRowPatch({ january: '1.0' }, { january: 1 }, () => true)).toBeNull()
  })

  it('an emptied cell writes null; unwritable fields are ignored', () => {
    expect(
      gridRowPatch({ january: '', total: '9' }, { january: 4 }, (f) => f === 'january')
    ).toEqual({
      january: null
    })
  })
})

describe('conflicts', () => {
  it('Take theirs drops only the conflicting cells from the draft', () => {
    const met = conflictsOf('rec-1', [{ field: 'february', current_value: 20 }])
    expect(met).toEqual({ 'rec-1': { february: 20 } })
    expect(
      takeTheirs({ 'rec-1': { january: '5', february: '9' }, 'rec-2': { march: '1' } }, met)
    ).toEqual({ 'rec-1': { january: '5' }, 'rec-2': { march: '1' } })
    expect(takeTheirs({ 'rec-1': { february: '9' } }, met)).toEqual({})
  })

  it('says what happened', () => {
    expect(saveStatus(2, 0, 0, {})).toBe('Saved — 2 updated, 0 created')
    expect(saveStatus(1, 0, 0, { 'rec-1': { february: 20 } })).toMatch(
      /1 row was changed by someone else/
    )
    expect(conflictTip(1234.5)).toMatch(/Someone else saved 1,234.5 here/)
  })
})

describe('GridRowGuard', () => {
  it('writes against the base pinned at the first edit, not a later live read', async () => {
    const latest: Record<string, number> = { '7': 100 }
    const { client, calls } = fakeClient(latest)
    const guard = new GridRowGuard(client, 'fc_grid_a')
    guard.noteRows([{ id: 7, january: 1 }])
    guard.pin('7') // Rob starts typing while the row is at revision 100
    // Beth saves (revision 101); the live refetch re-reads the row and its base moves on.
    latest['7'] = 101
    guard.noteRows([{ id: 7, january: 1, february: 20 }])
    const r = await guard.write('7', { january: 5 })
    expect(r.ok).toBe(true)
    const p = calls.find((c) => c._method === 'PATCH')
    expect(p?._body).toEqual({ january: 5, _base_revision: 100 })
  })

  it('a 409 names the conflicting cells and re-pins to the newer revision', async () => {
    let n = 0
    const { client, calls } = fakeClient({ '7': 100 }, () =>
      n++ === 0 ? midair(105, 'february', 20) : null
    )
    const guard = new GridRowGuard(client, 'fc_grid_b')
    guard.noteRows([{ id: 7 }])
    guard.pin('7')
    const r = await guard.write('7', { february: 9 })
    expect(r).toEqual({ ok: false, conflicts: [{ field: 'february', current_value: 20 }] })
    // "Save again to keep yours": now a choice made against 105.
    const again = await guard.write('7', { february: 9 })
    expect(again.ok).toBe(true)
    const patches = calls.filter((c) => c._method === 'PATCH')
    expect((patches[1]._body as Record<string, unknown>)._base_revision).toBe(105)
  })
})
