import { describe, expect, it } from 'vitest'
import {
  INBOUND_SLACK_MS,
  inboundWindow,
  PUSH_AFTER_MS
} from '../../../services/event-path/windows.js'
import { HISTORY_WINDOW_MS } from '../../../services/submission-detail.js'

describe('inboundWindow', () => {
  it('spans latency plus slack before the response and slack after', () => {
    const end = Date.parse('2026-09-24T10:00:02.000Z')
    const w = inboundWindow(new Date(end), 1500)
    expect(w.from.getTime()).toBe(end - 1500 - INBOUND_SLACK_MS)
    expect(w.to.getTime()).toBe(end + INBOUND_SLACK_MS)
  })
  it('clamps negative latency', () => {
    const at = new Date('2026-09-24T10:00:00.000Z')
    expect(inboundWindow(at, -50).from.getTime()).toBe(at.getTime() - INBOUND_SLACK_MS)
  })
  it('push window is the submission drill window', () => {
    expect(PUSH_AFTER_MS).toBe(HISTORY_WINDOW_MS)
  })
})
