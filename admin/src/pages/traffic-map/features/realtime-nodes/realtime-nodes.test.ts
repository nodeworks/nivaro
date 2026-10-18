import { describe, expect, it } from 'vitest'
import {
  type AdapterLagData,
  bandwidthText,
  isStreamSource,
  lagBadge,
  lagText,
  perSecond
} from './store'

const lag = (over: Partial<AdapterLagData>): AdapterLagData => ({
  level: 'ok',
  warn_ms: 500,
  last_ms: 10,
  last_at: null,
  total: 5,
  minutes: [],
  recent_avg_ms: 10,
  recent_max_ms: 20,
  baseline_avg_ms: 10,
  growing: false,
  ...over
})

describe('traffic map realtime nodes', () => {
  it('writes lag with its unit', () => {
    expect(lagText(0.2)).toBe('0 ms')
    expect(lagText(340)).toBe('340 ms')
    expect(lagText(1250)).toBe('1.3 s')
    expect(lagText(null)).toBe('—')
  })

  it('badges the Sockets node only when lag is high or growing', () => {
    expect(lagBadge(null)).toBeNull()
    expect(lagBadge(lag({}))).toBeNull()
    expect(lagBadge(lag({ level: 'warn', recent_avg_ms: 700 }))).toEqual({
      text: 'lag 700 ms',
      tone: 'warn'
    })
    expect(lagBadge(lag({ level: 'warn', growing: true, recent_avg_ms: 300 }))?.text).toBe(
      'lag growing'
    )
    expect(lagBadge(lag({ level: 'error', recent_avg_ms: 3000 }))).toEqual({
      text: 'lag 3.0 s',
      tone: 'error'
    })
  })

  it('reads stream sources and bandwidth', () => {
    expect(isStreamSource('stream:graphql-sse')).toBe(true)
    expect(isStreamSource('socket:browsers')).toBe(false)
    expect(perSecond(300, 60)).toBe(5)
    expect(bandwidthText(0, 60)).toBe('—')
    expect(bandwidthText(60 * 2048, 60)).toBe('2.0 KB/s')
    expect(bandwidthText(60 * 5 * 1024 * 1024, 60)).toBe('5.0 MB/s')
  })
})
