import { describe, expect, it } from 'vitest'

import { computeStanding, type QueueEntry } from '../../../services/import-queue-standing.js'

const group = (k: string) => (k.startsWith('po') ? 'po' : k)
const median = (k: string) => (k === 'po_lines' ? 120 : k === 'po_header' ? 60 : null)

describe('computeStanding', () => {
  it('ranks queued runs behind the running run of their group', () => {
    const now = Date.parse('2026-10-12T12:00:00Z')
    const entries: QueueEntry[] = [
      { id: 1, import_key: 'po_lines', status: 'running', started_at: new Date(now - 30_000) },
      { id: 2, import_key: 'po_header', status: 'queued', sort: 0 },
      { id: 3, import_key: 'po_lines', status: 'queued', sort: 0 },
      { id: 4, import_key: 'users', status: 'queued', sort: 0 }
    ]
    const s = computeStanding(entries, group, median, now)
    // 2 waits for the running run (120 - 30 = 90s left) + 10s tick
    expect(s.get(2)).toMatchObject({ position: 2, ahead: 1, eta_seconds: 100 })
    // 3 waits for the running run and for 2 (60s)
    expect(s.get(3)).toMatchObject({ position: 3, ahead: 2, eta_seconds: 160 })
    // another group is not blocked by them
    expect(s.get(4)).toMatchObject({ position: 1, ahead: 0, eta_seconds: 10 })
  })

  it('has no estimate when nothing ahead has history', () => {
    const entries: QueueEntry[] = [
      { id: 1, import_key: 'users', status: 'running', started_at: new Date() },
      { id: 2, import_key: 'users', status: 'queued' }
    ]
    const s = computeStanding(entries, group, () => null)
    expect(s.get(2)).toMatchObject({ position: 2, eta_seconds: null })
  })

  it('orders by sort then id', () => {
    const entries: QueueEntry[] = [
      { id: 5, import_key: 'users', status: 'queued', sort: 1 },
      { id: 6, import_key: 'users', status: 'queued', sort: 0 }
    ]
    const s = computeStanding(entries, group, () => 30)
    expect(s.get(6)?.position).toBe(1)
    expect(s.get(5)?.position).toBe(2)
  })
})
