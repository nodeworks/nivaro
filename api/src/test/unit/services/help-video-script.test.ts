import { describe, expect, it } from 'vitest'
import { emptyEdits, hashEdits } from '../../../services/help-video-edits.js'
import {
  chaptersFromScript,
  normalizeMarks,
  normalizeScript,
  SCRIPT_LIMITS,
  withScriptChapters
} from '../../../services/help-video-script.js'

// Script mode (#1491): the steps written before recording, the marks "Next"
// made while recording, and the chapters they become on the new draft.

describe('normalizeScript', () => {
  it('keeps trimmed non-empty lines, collapses whitespace', () => {
    expect(normalizeScript(['  Open the  menu ', '', '   ', 'Pick\tApprove'])).toEqual([
      'Open the menu',
      'Pick Approve'
    ])
  })
  it('is null without a script', () => {
    expect(normalizeScript(undefined)).toBeNull()
    expect(normalizeScript(null)).toBeNull()
    expect(normalizeScript('Open the menu')).toBeNull()
    expect(normalizeScript([])).toBeNull()
    expect(normalizeScript(['', 42, null])).toBeNull()
  })
  it('cuts steps to 200 characters and the script to 60 steps', () => {
    const long = 'x'.repeat(500)
    expect(normalizeScript([long])?.[0]).toHaveLength(SCRIPT_LIMITS.stepChars)
    const many = Array.from({ length: 80 }, (_, i) => `Step ${i + 1}`)
    const out = normalizeScript(many) as string[]
    expect(out).toHaveLength(SCRIPT_LIMITS.steps)
    expect(out[59]).toBe('Step 60')
  })
})

describe('normalizeMarks', () => {
  it('keeps whole, in-range marks sorted by time', () => {
    expect(
      normalizeMarks([
        { t_ms: 5000.4, step: 2 },
        { t_ms: 1200, step: 1 },
        { t_ms: -1, step: 3 },
        { t_ms: 'soon', step: 1 },
        { t_ms: 100, step: 1.5 },
        { t_ms: 100, step: 99 },
        { t_ms: 40 * 60_000, step: 4 },
        'x',
        null
      ])
    ).toEqual([
      { t_ms: 1200, step: 1 },
      { t_ms: 5000, step: 2 }
    ])
  })
  it('is null without marks and [] for an empty list', () => {
    expect(normalizeMarks(undefined)).toBeNull()
    expect(normalizeMarks({})).toBeNull()
    expect(normalizeMarks([])).toEqual([])
  })
  it('caps the list', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ t_ms: i, step: i % 60 }))
    expect(normalizeMarks(many)).toHaveLength(SCRIPT_LIMITS.marks)
  })
})

describe('chaptersFromScript', () => {
  const script = ['Open the record', 'Press Approve', 'Check the result']
  it('starts the first step at 0 and the rest where they were marked', () => {
    expect(
      chaptersFromScript(
        script,
        [
          { t_ms: 4000, step: 1 },
          { t_ms: 9000, step: 2 }
        ],
        20000
      )
    ).toEqual([
      { id: 'script-1', at_ms: 0, title: 'Open the record' },
      { id: 'script-2', at_ms: 4000, title: 'Press Approve' },
      { id: 'script-3', at_ms: 9000, title: 'Check the result' }
    ])
  })
  it('makes one chapter per step: the first mark wins, unmarked steps make none', () => {
    const out = chaptersFromScript(
      script,
      [
        { t_ms: 3000, step: 1 },
        { t_ms: 7000, step: 1 },
        { t_ms: 100, step: 0 },
        { t_ms: 500, step: 7 }
      ],
      20000
    )
    expect(out.map((c) => [c.at_ms, c.title])).toEqual([
      [0, 'Open the record'],
      [3000, 'Press Approve']
    ])
  })
  it('clamps marks to the recording and cuts titles to the chapter limit', () => {
    const out = chaptersFromScript(['a'.repeat(200), 'b'], [{ t_ms: 50_000, step: 1 }], 20000)
    expect(out[0].title).toHaveLength(120)
    expect(out[1].at_ms).toBe(20000)
  })
  it('is empty without a script, and a script alone gives the first chapter', () => {
    expect(chaptersFromScript(null, [{ t_ms: 1, step: 1 }], 1000)).toEqual([])
    expect(chaptersFromScript([], null, 1000)).toEqual([])
    expect(chaptersFromScript(['Only step'], null, 1000)).toEqual([
      { id: 'script-1', at_ms: 0, title: 'Only step' }
    ])
  })
})

describe('withScriptChapters', () => {
  it('leaves the edits (and their hash) untouched without a script', () => {
    const edits = emptyEdits(5000)
    expect(withScriptChapters(edits, null, null, 5000)).toBe(edits)
    expect(hashEdits(withScriptChapters(edits, null, [], 5000))).toBe(hashEdits(edits))
  })
  it('puts the chapters on a scripted recording', () => {
    const out = withScriptChapters(
      emptyEdits(5000),
      ['One', 'Two'],
      [{ t_ms: 2000, step: 1 }],
      5000
    )
    expect(out.chapters).toEqual([
      { id: 'script-1', at_ms: 0, title: 'One' },
      { id: 'script-2', at_ms: 2000, title: 'Two' }
    ])
    expect(out.segments).toEqual(emptyEdits(5000).segments)
  })
})
