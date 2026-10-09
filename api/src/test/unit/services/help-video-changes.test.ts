import { describe, expect, it } from 'vitest'
import {
  cleanVersionNote,
  firstChange,
  jumpTarget,
  readEdits,
  viewerNote
} from '../../../services/help-video-changes.js'
import { normalizeEdits, type VideoEdits } from '../../../services/help-video-edits.js'

const SRC = 60_000
const base = (extra: Record<string, unknown> = {}): VideoEdits =>
  normalizeEdits(
    {
      segments: [
        { start_ms: 0, end_ms: 20_000, speed: 1 },
        { start_ms: 30_000, end_ms: 60_000, speed: 1 }
      ],
      chapters: [
        { id: 'c1', at_ms: 0, title: 'Start' },
        { id: 'c2', at_ms: 35_000, title: 'Saving' }
      ],
      captions: [{ id: 'k1', start_ms: 1000, end_ms: 3000, text: 'Hello' }],
      ...extra
    },
    SRC
  )

describe('firstChange (#1497)', () => {
  it('a different recording changes the whole video', () => {
    expect(firstChange(base(), base(), false)).toEqual({ at_ms: 0, whole: true })
  })

  it('identical edits change nothing', () => {
    expect(firstChange(base(), base(), true)).toBeNull()
  })

  it('a crop or the narration cleanup changing covers the whole video', () => {
    expect(firstChange(base(), base({ crop: { x: 0, y: 0, w: 0.5, h: 1 } }), true)).toEqual({
      at_ms: 0,
      whole: false
    })
    expect(firstChange(base(), base({ audio: { improve: true } }), true)).toEqual({
      at_ms: 0,
      whole: false
    })
  })

  it('a new step badge style counts from the first step on screen', () => {
    const step = {
      id: 's1',
      type: 'step',
      start_ms: 40_000,
      end_ms: 42_000,
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      text: 'Save',
      tone: 'accent'
    }
    const before = base({ annotations: [step] })
    const after = base({ annotations: [step], step_style: { shape: 'square', size: 'large' } })
    expect(firstChange(before, after, true)).toEqual({ at_ms: 30_000, whole: false })
  })

  it('a new caption look counts from the first caption', () => {
    expect(firstChange(base(), base({ caption_style: { size: 'xl' } }), true)).toEqual({
      at_ms: 1000,
      whole: false
    })
  })

  it('only the poster moving is not a visible change', () => {
    expect(firstChange(base(), base({ poster_ms: 40_000 }), true)).toBeNull()
  })

  it('a caption edited in the second piece maps to edited time', () => {
    const before = base({
      captions: [
        { id: 'k1', start_ms: 1000, end_ms: 3000, text: 'Hello' },
        { id: 'k2', start_ms: 40_000, end_ms: 42_000, text: 'Save' }
      ]
    })
    const after = base({
      captions: [
        { id: 'k1', start_ms: 1000, end_ms: 3000, text: 'Hello' },
        { id: 'k2', start_ms: 40_000, end_ms: 42_000, text: 'Save it' }
      ]
    })
    // 20 s of the first piece + 10 s into the second
    expect(firstChange(before, after, true)).toEqual({ at_ms: 30_000, whole: false })
  })

  it('a removed annotation counts at its start', () => {
    const before = base({
      annotations: [
        {
          id: 'a1',
          type: 'arrow',
          start_ms: 50_000,
          end_ms: 52_000,
          rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
          to: { x: 0.5, y: 0.5 },
          text: '',
          tone: 'accent'
        }
      ]
    })
    expect(firstChange(before, base(), true)).toEqual({ at_ms: 40_000, whole: false })
  })

  it('a piece trimmed shorter changes where the shorter one ends', () => {
    const after = base({
      segments: [
        { start_ms: 0, end_ms: 15_000, speed: 1 },
        { start_ms: 30_000, end_ms: 60_000, speed: 1 }
      ]
    })
    expect(firstChange(base(), after, true)).toEqual({ at_ms: 15_000, whole: false })
  })

  it('a later piece cut out changes where it began', () => {
    const after = base({ segments: [{ start_ms: 0, end_ms: 20_000, speed: 1 }] })
    expect(firstChange(base(), after, true)).toEqual({ at_ms: 20_000, whole: false })
  })

  it('an item that now sits in a cut moves to the next kept moment', () => {
    const after = base({
      captions: [
        { id: 'k1', start_ms: 1000, end_ms: 3000, text: 'Hello' },
        { id: 'k9', start_ms: 25_000, end_ms: 27_000, text: 'Hidden' }
      ]
    })
    expect(firstChange(base(), after, true)).toEqual({ at_ms: 20_000, whole: false })
  })

  it('an intro added is a change at 0; an outro at its start', () => {
    expect(
      firstChange(
        base(),
        base({ intro: { enabled: true, duration_ms: 3000, show_chapters: false } }),
        true
      )
    ).toEqual({ at_ms: 0, whole: false })
    expect(
      firstChange(base(), base({ outro: { enabled: true, duration_ms: 3000, text: '' } }), true)
    ).toEqual({ at_ms: 50_000, whole: false })
  })

  it('takes the earliest of several changes', () => {
    const after = base({
      captions: [{ id: 'k1', start_ms: 1000, end_ms: 3000, text: 'Hi' }],
      outro: { enabled: true, duration_ms: 3000, text: '' }
    })
    expect(firstChange(base(), after, true)).toEqual({ at_ms: 1000, whole: false })
  })
})

describe('jumpTarget', () => {
  it('jumps to the chapter the change falls in', () => {
    expect(jumpTarget(base(), 30_000)).toEqual({
      jump_ms: 25_000,
      chapter: { id: 'c2', title: 'Saving' }
    })
  })
  it('without a chapter before it, starts two seconds early', () => {
    const e = base({ chapters: [] })
    expect(jumpTarget(e, 30_000)).toEqual({ jump_ms: 28_000, chapter: null })
    expect(jumpTarget(e, 500)).toEqual({ jump_ms: 0, chapter: null })
  })
})

describe('notes', () => {
  it('system notes are not shown to viewers', () => {
    expect(viewerNote('Restored from version 3')).toBeNull()
    expect(viewerNote('  ')).toBeNull()
    expect(viewerNote('New step for approvals')).toBe('New step for approvals')
  })
  it('an author note is trimmed and capped', () => {
    expect(cleanVersionNote('  x  ')).toBe('x')
    expect(cleanVersionNote('')).toBeNull()
    expect(cleanVersionNote(42)).toBeNull()
    expect(cleanVersionNote('a'.repeat(600))?.length).toBe(500)
  })
  it('unreadable edits read as null', () => {
    expect(readEdits('{nope', SRC)).toBeNull()
    expect(readEdits(null, SRC)).toBeNull()
    expect(readEdits(JSON.stringify(base()), SRC)?.segments.length).toBe(2)
  })
})
