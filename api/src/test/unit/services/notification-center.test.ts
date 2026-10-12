import { describe, expect, it } from 'vitest'
import {
  emptyTotals,
  noiseSuggestions,
  sanitizePrefs
} from '../../../services/notification-center.js'

describe('noiseSuggestions', () => {
  it('suggests categories that are mostly unopened and enough volume', () => {
    const out = noiseSuggestions(
      [
        { category: 'watch', total: 100, unopened: 90 },
        { category: 'workflow', total: 10, unopened: 10 },
        { category: 'mentions', total: 100, unopened: 100 }
      ],
      null
    )
    expect(out.map((o) => o.category)).toEqual(['watch'])
  })
  it('skips categories already off', () => {
    const out = noiseSuggestions([{ category: 'watch', total: 100, unopened: 90 }], {
      matrix: { watch: { inapp: false } }
    })
    expect(out).toEqual([])
  })
})

describe('sanitizePrefs', () => {
  it('drops junk and keeps valid shapes', () => {
    const p = sanitizePrefs({ quiet_start: '25:00', quiet_end: '07:30', matrix: { nope: {} } })
    expect(p.quiet_start).toBeUndefined()
    expect(p.quiet_end).toBe('07:30')
  })
  it('totals start at zero', () => {
    expect(emptyTotals().notifications).toBe(0)
  })
})

describe('ack state', () => {
  it('uses bracketed underscores and judges the parsed detail', async () => {
    const { ACK_PENDING_LIKE, ACK_DONE_LIKE, ackPending } = await import(
      '../../../services/notification-channels.js'
    )
    expect(ACK_PENDING_LIKE).toContain('ack[_]required')
    expect(ACK_DONE_LIKE).toContain('ack[_]at')
    expect(ackPending(JSON.stringify({ ack_required: true }))).toBe(true)
    expect(ackPending(JSON.stringify({ ack_required: true, ack_at: '2026-01-01' }))).toBe(false)
    // text that merely contains the marker is not a pending ack
    expect(ackPending(JSON.stringify({ body: '"ack_required":true' }))).toBe(false)
    expect(ackPending(null)).toBe(false)
  })
})
