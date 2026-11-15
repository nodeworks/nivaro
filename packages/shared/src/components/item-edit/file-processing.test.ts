import { describe, expect, it } from 'vitest'
import {
  chipThumbUrl,
  PROCESSING_POLL_FOR_MS,
  PROCESSING_POLL_MS,
  pollDelay,
  processingIds
} from './file-processing'

describe('file processing status (rt3 #17)', () => {
  it('only files still processing show "Processing…"', () => {
    const ids = processingIds({
      'AAA-1': { status: 'processing' },
      'bbb-2': { status: 'ready' },
      'ccc-3': { status: 'failed' }
    })
    expect([...ids]).toEqual(['aaa-1'])
  })

  it('processing → ready: the page stops asking once nothing processes', () => {
    const start = 1_000_000
    expect(pollDelay(1, start, start + 2000)).toBe(PROCESSING_POLL_MS)
    expect(pollDelay(0, start, start + 2000)).toBe(false)
  })

  it('a file stuck processing is asked about for a while, not forever', () => {
    const start = 1_000_000
    expect(pollDelay(1, start, start + PROCESSING_POLL_FOR_MS + 1)).toBe(false)
  })

  it('the chip shows the prepared thumbnail, never for a local preview', () => {
    expect(chipThumbUrl('/api/files/abc')).toBe(
      '/api/files/abc/transform?w=160&h=160&fit=cover&format=webp&q=80'
    )
    expect(chipThumbUrl('blob:http://x/1')).toBe('blob:http://x/1')
    expect(chipThumbUrl('/api/files/abc?st=1')).toBe('/api/files/abc?st=1')
  })
})
