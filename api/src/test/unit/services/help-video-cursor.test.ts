import { describe, expect, it } from 'vitest'
import {
  assText,
  assTime,
  badgeWindows,
  buildCursorAss,
  normalizePointer,
  POINTER_LIMITS,
  pointerAt,
  SHORTCUT_BADGE_MS,
  shortcutLabel,
  smoothPointerPath,
  thinPointerPath
} from '../../../services/help-video-cursor.js'
import { normalizeEdits } from '../../../services/help-video-edits.js'
import { viewerMayPlaySource } from '../../../services/help-video-views.js'

// The recorded cursor (#1517): what is stored, where the pointer was, and
// the ASS file the render burns in.

const s = (t_ms: number, x: number, y: number) => ({ t_ms, x, y })

describe('normalizePointer', () => {
  it('keeps null for no capture and drops an empty path', () => {
    expect(normalizePointer(null)).toBeNull()
    expect(normalizePointer([])).toBeNull()
    expect(normalizePointer({ samples: [], shortcuts: [] })).toBeNull()
  })
  it('clamps, rounds, sorts, de-duplicates moments and checks keys', () => {
    const p = normalizePointer({
      samples: [s(200, 1.5, -1), s(100, 0.123456, 0.5), s(100, 0.9, 0.9), 'x', s(-5, 0, 0)],
      shortcuts: [
        { t_ms: 900, keys: 'Enter' },
        { t_ms: 300, keys: 'Meta+S' },
        { t_ms: 400, keys: 'ü' },
        { t_ms: 500, keys: 'a'.repeat(POINTER_LIMITS.keys + 1) },
        { t_ms: 600, keys: 'Ctrl+K' }
      ]
    })
    expect(p).toEqual({
      samples: [s(100, 0.1235, 0.5), s(200, 1, 0)],
      shortcuts: [
        { t_ms: 300, keys: 'Meta+S' },
        { t_ms: 600, keys: 'Ctrl+K' },
        { t_ms: 900, keys: 'Enter' }
      ]
    })
  })
  it('thins a long path evenly to the cap, keeping both ends', () => {
    const samples = Array.from({ length: POINTER_LIMITS.samples * 3 }, (_, i) => s(i, 0.5, 0))
    const p = normalizePointer({ samples, shortcuts: [] })
    expect(p?.samples).toHaveLength(POINTER_LIMITS.samples)
    expect(p?.samples[0]).toEqual(samples[0])
    expect(p?.samples[POINTER_LIMITS.samples - 1]).toEqual(samples[samples.length - 1])
    expect(thinPointerPath([s(0, 0, 0), s(1, 0, 0), s(2, 0, 0)], 2)).toEqual([
      s(0, 0, 0),
      s(2, 0, 0)
    ])
  })
})

describe('pointerAt / smoothPointerPath', () => {
  const path = [s(1000, 0.1, 0.1), s(1050, 0.2, 0.2), s(3000, 0.6, 0.2)]
  it('is unseen before the first sample and held after the last', () => {
    expect(pointerAt(path, 999)).toBeNull()
    expect(pointerAt(path, 9000)).toEqual({ x: 0.6, y: 0.2 })
  })
  it('blends between close samples and holds, then moves, across a gap', () => {
    expect(pointerAt(path, 1025)).toEqual({ x: 0.15000000000000002, y: 0.15000000000000002 })
    // The gap 1050 → 3000 is a hold until 2900, then a move.
    expect(pointerAt(path, 2000)).toEqual({ x: 0.2, y: 0.2 })
    expect(pointerAt(path, 2950)!.x).toBeCloseTo(0.4)
  })
  it('smooths with close neighbours only', () => {
    const sm = smoothPointerPath([s(0, 0, 0), s(50, 0.3, 0), s(100, 0.3, 0), s(5000, 0.9, 0)])
    expect(sm[1]).toEqual(s(50, 0.2, 0))
    expect(sm[2]).toEqual(s(100, 0.3, 0)) // its next neighbour is too far away
    expect(sm[3]).toEqual(s(5000, 0.9, 0))
  })
})

describe('badges', () => {
  it('labels keys with glyphs', () => {
    expect(shortcutLabel('Meta+S')).toBe('⌘S')
    expect(shortcutLabel('Ctrl+K')).toBe('Ctrl+K')
    expect(shortcutLabel('Shift+Tab')).toBe('⇧Tab')
    expect(shortcutLabel('Ctrl+Shift+ArrowDown')).toBe('Ctrl+⇧↓')
    expect(shortcutLabel('Enter')).toBe('↵ Enter')
  })
  it('each badge lasts SHORTCUT_BADGE_MS, or until the next one or the end', () => {
    expect(
      badgeWindows(
        [
          { t_ms: 1000, keys: 'Meta+S' },
          { t_ms: 1500, keys: 'Enter' },
          { t_ms: 9800, keys: 'Escape' }
        ],
        10_000
      )
    ).toEqual([
      { start_ms: 1000, end_ms: 1500, keys: 'Meta+S' },
      { start_ms: 1500, end_ms: 1500 + SHORTCUT_BADGE_MS, keys: 'Enter' },
      { start_ms: 9800, end_ms: 10_000, keys: 'Escape' }
    ])
  })
  it('assTime and assText', () => {
    expect(assTime(0)).toBe('0:00:00.00')
    expect(assTime(61_234)).toBe('0:01:01.23')
    expect(assTime(3_600_000 + 5)).toBe('1:00:00.01')
    expect(assText('a{\\b}c\nd')).toBe('abcd')
  })
})

describe('buildCursorAss', () => {
  const out = { width: 1280, height: 720 }
  const events = (ass: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
  it('draws a halo and a pointer per stretch: a hold, a move, a hold to the end', () => {
    // Two samples 200 ms apart (too far to be smoothed together): the pointer
    // holds, moves over the last two sample gaps, then stays to the end.
    const ass = buildCursorAss({
      pointer: { samples: [s(1000, 0.25, 0.5), s(1200, 0.5, 0.5)], shortcuts: [] },
      edits: normalizeEdits({}, 4000),
      out,
      durationMs: 4000,
      shortcuts: true
    })
    expect(ass).toContain('PlayResX: 1280')
    expect(ass).toContain('Style: Halo,')
    expect(ass).toContain('Style: Pointer,')
    const ev = events(ass)
    expect(ev).toHaveLength(6)
    expect(ev[1]).toContain('0:00:01.00,0:00:01.10,Pointer')
    expect(ev[1]).toContain('\\pos(320,360)')
    expect(ev[3]).toContain('0:00:01.10,0:00:01.20,Pointer')
    expect(ev[3]).toContain('\\move(320,360,640,360)')
    expect(ev[2]).toContain('Halo')
    expect(ev[2]).toContain('\\move(306,346,626,346)') // the halo's top-left: radius 14 off
    expect(ev[5]).toContain('0:00:01.20,0:00:04.00,Pointer')
    expect(ev[5]).toContain('\\pos(640,360)')
    expect(ev[5]).toContain('\\p1}m 0 0 l 0 20 l 5 15')
  })
  it('places the cursor through the crop and zoom, in short pieces inside a zoom', () => {
    const edits = normalizeEdits(
      {
        zooms: [
          { start_ms: 2000, end_ms: 3000, rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, ease_ms: 0 }
        ]
      },
      4000
    )
    const ass = buildCursorAss({
      pointer: { samples: [s(0, 0.75, 0.75)], shortcuts: [] },
      edits,
      out,
      durationMs: 4000,
      shortcuts: false
    })
    const ev = events(ass).filter((l) => l.includes('Pointer'))
    // Before the zoom: one hold at (960,540). Inside it the picture is 2x
    // from (0.5,0.5), so the pointer at (0.75,0.75) sits at (640,360).
    expect(ev[0]).toContain('0:00:00.00,0:00:02.00,Pointer')
    expect(ev[0]).toContain('\\pos(960,540)')
    const inside = ev.filter((l) => l.includes('\\pos(640,360)'))
    expect(inside.length).toBe(10) // 1 s in 100 ms pieces
    expect(ev).toHaveLength(12)
    expect(ev[ev.length - 1]).toContain('0:00:03.00,0:00:04.00')
    expect(ev[ev.length - 1]).toContain('\\pos(960,540)')
  })
  it('leaves out a stretch outside the visible picture', () => {
    const edits = normalizeEdits({ crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }, 4000)
    const ass = buildCursorAss({
      pointer: { samples: [s(0, 0.1, 0.1)], shortcuts: [] },
      edits,
      out,
      durationMs: 4000,
      shortcuts: false
    })
    expect(events(ass)).toHaveLength(0)
  })
  it('adds a badge per shortcut when asked, bottom left, text made safe', () => {
    const with_ = (shortcuts: boolean) =>
      buildCursorAss({
        pointer: { samples: [], shortcuts: [{ t_ms: 500, keys: 'Meta+S' }] },
        edits: normalizeEdits({}, 4000),
        out,
        durationMs: 4000,
        shortcuts
      })
    expect(events(with_(false))).toHaveLength(0)
    const ev = events(with_(true))
    expect(ev).toHaveLength(1)
    expect(ev[0]).toBe('Dialogue: 2,0:00:00.50,0:00:01.70,Badge,,0,0,0,,{\\an1\\pos(38.4,684)}⌘S')
  })
})

describe('viewers wait for the render when the cursor is on', () => {
  it('refuses the original recording with a cursor', () => {
    expect(viewerMayPlaySource(JSON.stringify({ cursor: { show: true } }), 10_000)).toBe(false)
    expect(viewerMayPlaySource(JSON.stringify({ cursor: { show: false } }), 10_000)).toBe(true)
  })
  it('stores only the on switches', () => {
    expect(normalizeEdits({ cursor: { show: true, shortcuts: false } }, 1000).cursor).toEqual({
      show: true
    })
    expect(normalizeEdits({ cursor: { show: true, shortcuts: true } }, 1000).cursor).toEqual({
      show: true,
      shortcuts: true
    })
    expect(normalizeEdits({ cursor: { shortcuts: true } }, 1000).cursor).toBeUndefined()
  })
})
