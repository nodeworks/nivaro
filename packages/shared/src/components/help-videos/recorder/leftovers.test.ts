import { describe, expect, it } from 'vitest'
import { findLeftovers, LIVE_ELSEWHERE_MS, planResume } from './leftovers'
import { MemoryPartStore } from './partQueue'

const blob = (size: number) => new Blob(['x'.repeat(size)])
const NOW = Date.parse('2026-10-08T18:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const open = (id: string, next: number, bytes: number, touchedAgo = 10 * 60_000) => ({
  id,
  next_part: next,
  bytes_received: bytes,
  created_at: ago(20 * 60_000),
  updated_at: ago(touchedAgo)
})

describe('planResume', () => {
  it('re-sends from the part the server expects', () => {
    const parts = [0, 1, 2, 3].map((n) => ({ n, blob: blob(1) }))
    expect(planResume(parts, 2)).toEqual({ resend: parts.slice(2), gap: false })
  })
  it('re-sends nothing when the parts in between were lost', () => {
    expect(planResume([{ n: 5, blob: blob(1) }], 3)).toEqual({ resend: [], gap: true })
  })
})

describe('findLeftovers', () => {
  it('lists an interrupted upload with what the server and the browser hold', async () => {
    const store = new MemoryPartStore()
    await store.put('a', 2, blob(10))
    await store.put('a', 3, blob(5))
    expect(await findLeftovers([open('a', 2, 100)], store, NOW)).toEqual([
      { id: 'a', kind: 'interrupted', created_at: ago(20 * 60_000), bytes: 115, gap: false }
    ])
  })
  it('flags a gap between the server and the parts kept', async () => {
    const store = new MemoryPartStore()
    await store.put('a', 4, blob(10))
    const [row] = await findLeftovers([open('a', 2, 100)], store, NOW)
    expect(row).toMatchObject({ kind: 'interrupted', gap: true, bytes: 100 })
  })
  it('skips an upload still being recorded in another tab', async () => {
    const store = new MemoryPartStore()
    await store.put('live', 0, blob(1))
    const rows = await findLeftovers([open('live', 0, 0, LIVE_ELSEWHERE_MS - 1000)], store, NOW)
    expect(rows).toEqual([])
  })
  it('lists parts the server no longer holds open as unsaveable', async () => {
    const store = new MemoryPartStore()
    await store.put('gone', 0, blob(7))
    await store.put('gone', 1, blob(3))
    expect(await findLeftovers([], store, NOW)).toEqual([
      { id: 'gone', kind: 'unsaveable', created_at: null, bytes: 10, gap: false }
    ])
  })
  it('lists a finished upload never saved as a video as finished, not as unsaveable', async () => {
    const store = new MemoryPartStore()
    await store.put('done', 0, blob(7)) // parts a closed tab never cleared
    const finished = { ...open('done', 3, 300), status: 'finalized', duration_ms: 65_000 }
    expect(await findLeftovers([finished], store, NOW)).toEqual([
      {
        id: 'done',
        kind: 'finished',
        created_at: ago(20 * 60_000),
        bytes: 300,
        gap: false,
        duration_ms: 65_000
      }
    ])
  })
  it('skips a finished upload another tab is saving right now', async () => {
    const fresh = { ...open('done', 3, 300, 5_000), status: 'finalized', duration_ms: 1 }
    expect(await findLeftovers([fresh], new MemoryPartStore(), NOW)).toEqual([])
  })
})
