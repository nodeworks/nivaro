import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emits } = vi.hoisted(() => ({
  emits: [] as Array<{ room: string; event: string; payload: any }>
}))

vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => emits.push({ room, event, payload })
    })
  })
}))

import { openBulkRowProgress } from '../../../services/live-progress.js'

describe('bulk row progress', () => {
  beforeEach(() => {
    emits.length = 0
  })

  it('is silent without a valid progress id or a user', () => {
    const rp = openBulkRowProgress(undefined, 'u1', () => ({ ok: 0, failed: 0 }))
    rp.next(1)
    rp.end()
    const bad = openBulkRowProgress('x', 'u1', () => ({ ok: 0, failed: 0 }))
    bad.next(1)
    bad.end()
    const nouser = openBulkRowProgress('abcdefghij', null, () => ({ ok: 0, failed: 0 }))
    nouser.next(1)
    nouser.end()
    expect(emits).toHaveLength(0)
  })

  it('reports each row done / failed / skipped to the caller only, then finishes', () => {
    let ok = 0
    let failed = 0
    let skipped = 0
    let reason: string | null = null
    const rp = openBulkRowProgress('progress-1234', 'user-1', () => ({
      ok,
      failed,
      skipped,
      reason
    }))
    rp.next('a')
    ok++
    rp.next('b')
    failed++
    reason = 'Not allowed'
    rp.next('c')
    skipped++
    rp.end()
    expect(emits.every((e) => e.room === 'user:user-1' && e.event === 'bulk:rows')).toBe(true)
    const rows = emits.flatMap((e) => e.payload.rows)
    expect(rows).toEqual([
      { id: 'a', status: 'done' },
      { id: 'b', status: 'failed', reason: 'Not allowed' },
      { id: 'c', status: 'skipped' }
    ])
    expect(emits.at(-1)?.payload.finished).toBe(true)
    expect(emits.every((e) => e.payload.progress === 'progress-1234')).toBe(true)
  })

  it('batches rows instead of one event per row', () => {
    let ok = 0
    const rp = openBulkRowProgress('progress-batch', 'u', () => ({ ok, failed: 0 }))
    for (let i = 0; i < 100; i++) {
      rp.next(i)
      ok++
    }
    rp.end()
    expect(emits.length).toBeLessThan(40)
    expect(emits.flatMap((e) => e.payload.rows)).toHaveLength(100)
  })
})
