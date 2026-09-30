import { describe, expect, it } from 'vitest'
import { parsePreviewHtml } from '../../../services/chat-link-preview.js'
import { parseTimeRefs, zonedToInstant } from '../../../services/chat-time-refs.js'

// Tue Sep 29 2026, 10:00 in New York (EDT, UTC-4).
const NOW = new Date('2026-09-29T14:00:00Z')

describe('parseTimeRefs', () => {
  it('reads a lone time as today in the sender zone', () => {
    const r = parseTimeRefs('call at 3pm?', 'America/New_York', NOW)
    expect(r).toEqual([{ text: '3pm', at: '2026-09-29T19:00:00.000Z' }])
  })
  it('reads tomorrow + a time', () => {
    const r = parseTimeRefs('tomorrow 9:30am works', 'America/Denver', NOW)
    expect(r[0].text).toBe('tomorrow 9:30am')
    expect(r[0].at).toBe('2026-09-30T15:30:00.000Z')
  })
  it('reads a weekday and a month-day', () => {
    const [fri] = parseTimeRefs('Friday at noon', 'America/New_York', NOW)
    expect(fri.at).toBe('2026-10-02T16:00:00.000Z')
    const [oct] = parseTimeRefs('Oct 5 14:00', 'America/New_York', NOW)
    expect(oct.at).toBe('2026-10-05T18:00:00.000Z')
  })
  it('ignores bare numbers and bare days', () => {
    expect(parseTimeRefs('we shipped 3 units Friday', 'America/New_York', NOW)).toEqual([])
    expect(parseTimeRefs('version 2', 'America/New_York', NOW)).toEqual([])
  })
  it('crosses DST correctly', () => {
    // Nov 2 2026 is after the US fall-back (Nov 1): EST, UTC-5.
    const at = zonedToInstant({ y: 2026, m: 11, d: 2 }, 9, 0, 'America/New_York')
    expect(at.toISOString()).toBe('2026-11-02T14:00:00.000Z')
  })
})

describe('parsePreviewHtml', () => {
  it('prefers og tags and falls back to the title and host', () => {
    const p = parsePreviewHtml(
      'https://www.example.com/a',
      '<head><title>Plain &amp; simple</title><meta name="description" content="A page"></head>'
    )
    expect(p).toMatchObject({
      title: 'Plain & simple',
      description: 'A page',
      site: 'example.com',
      ok: true
    })
    const og = parsePreviewHtml(
      'https://x.test',
      '<meta property="og:title" content="OG"><meta content="Site" property="og:site_name">'
    )
    expect(og.title).toBe('OG')
    expect(og.site).toBe('Site')
  })
})
