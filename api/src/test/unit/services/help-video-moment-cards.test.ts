import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))

import {
  formatMomentDuration,
  momentCard,
  momentEmailHtml,
  momentLine,
  momentPath,
  parseMomentMs
} from '../../../services/help-video-moments.js'
import { normalizeVersion } from '../../../services/help-video-releases.js'

// Video moments carried by broadcasts and release notes (#1528).

const ID = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'

describe('momentPath / parseMomentMs', () => {
  it('is the moment link every host recognises, in whole seconds, lower-case id', () => {
    expect(momentPath(ID, null)).toBe(`/help-videos?watch=${ID.toLowerCase()}`)
    expect(momentPath(ID, 65_900)).toBe(`/help-videos?watch=${ID.toLowerCase()}&t=65`)
    expect(momentPath(ID, 0)).toBe(`/help-videos?watch=${ID.toLowerCase()}`)
  })
  it('reads a start time as whole milliseconds, bounded, else null', () => {
    expect(parseMomentMs(1500.4)).toBe(1500)
    expect(parseMomentMs('2000')).toBe(2000)
    expect(parseMomentMs(0)).toBeNull()
    expect(parseMomentMs(-5)).toBeNull()
    expect(parseMomentMs('x')).toBeNull()
    expect(parseMomentMs(10 ** 12)).toBe(24 * 3_600_000)
  })
})

describe('momentCard', () => {
  it('keeps the start inside the video and names an untitled video', () => {
    const c = momentCard({ id: ID, title: '', duration_ms: 30_000 }, 90_000)
    expect(c).toEqual({
      id: ID.toLowerCase(),
      title: 'Untitled video',
      duration_ms: 30_000,
      start_ms: 29_000,
      path: `/help-videos?watch=${ID.toLowerCase()}&t=29`
    })
  })
  it('an unknown length keeps the start as given', () => {
    expect(momentCard({ id: ID, title: 'T', duration_ms: null }, 5000).start_ms).toBe(5000)
    expect(momentCard({ id: ID, title: 'T' }, null).start_ms).toBe(0)
  })
})

describe('momentLine / momentEmailHtml', () => {
  const card = momentCard({ id: ID, title: 'Raise a <PO>', duration_ms: 125_000 }, 65_000)
  it('the plain line says the title, length, start and link', () => {
    expect(momentLine(card, 'https://app.example')).toBe(
      `Watch the video from 1:05: Raise a <PO> (2:05) https://app.example/help-videos?watch=${ID.toLowerCase()}&t=65`
    )
    const fromStart = momentCard({ id: ID, title: 'Hi', duration_ms: null }, null)
    expect(momentLine(fromStart, '')).toBe(
      `Watch the video: Hi /help-videos?watch=${ID.toLowerCase()}`
    )
  })
  it('the email card escapes the title and links to the moment', () => {
    const html = momentEmailHtml(card, 'https://app.example')
    expect(html).toContain('Raise a &lt;PO&gt;')
    expect(html).toContain('Video · 2:05 · Starts at 1:05')
    // The ampersand in the query is HTML-escaped, as it must be inside an attribute.
    expect(html).toContain(
      `href="https://app.example/help-videos?watch=${ID.toLowerCase()}&amp;t=65"`
    )
    expect(html).not.toContain('<img')
  })
  it('formats durations', () => {
    expect(formatMomentDuration(65_000)).toBe('1:05')
    expect(formatMomentDuration(3_600_000)).toBe('1:00:00')
    expect(formatMomentDuration(null)).toBeNull()
  })
})

describe('normalizeVersion', () => {
  it('accepts a release tag with or without v and refuses anything else', () => {
    expect(normalizeVersion('v0.2.33')).toBe('0.2.33')
    expect(normalizeVersion('0.2.33-rc.1')).toBe('0.2.33-rc.1')
    for (const bad of ['', 'latest', '0.2', '../x', 'v0.2.33/evil', 'x'.repeat(50)]) {
      expect(() => normalizeVersion(bad)).toThrow()
    }
  })
})
