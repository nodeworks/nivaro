import { describe, expect, it } from 'vitest'
import { EDIT_LIMITS } from '../edits'
import type { Caption, VideoEdits } from '../types'
import { applyGeneratedCaptions, captionJobLabel } from './captionsDraft'

const cap = (id: string, start: number, end: number, text: string): Caption => ({
  id,
  start_ms: start,
  end_ms: end,
  text
})
const edits: VideoEdits = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 20_000, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: [cap('mine', 4000, 6000, 'My own line')]
}
const generated = [
  cap('g1', 0, 2000, 'Hello there'),
  cap('g2', 5000, 7000, 'Overlaps mine'),
  cap('g3', 9000, 11_000, 'Later')
]

describe('applyGeneratedCaptions', () => {
  it('replace keeps only the generated lines, with fresh ids, sorted', () => {
    const r = applyGeneratedCaptions(edits, [generated[2], generated[0]], 'replace', 20_000)
    expect(r.added).toBe(2)
    expect(r.skipped).toBe(0)
    expect(r.edits.captions.map((c) => c.text)).toEqual(['Hello there', 'Later'])
    expect(r.edits.captions.every((c) => !['g1', 'g3', 'mine'].includes(c.id))).toBe(true)
    expect(r.edits.segments).toBe(edits.segments)
  })
  it('merge keeps the author’s captions and skips lines that overlap them', () => {
    const r = applyGeneratedCaptions(edits, generated, 'merge', 20_000)
    expect(r.added).toBe(2)
    expect(r.skipped).toBe(1)
    expect(r.edits.captions.map((c) => c.text)).toEqual(['Hello there', 'My own line', 'Later'])
    expect(r.edits.captions[1].id).toBe('mine')
  })
  it('drops empty or too-short lines and clamps to the recording', () => {
    const r = applyGeneratedCaptions(
      edits,
      [cap('a', 0, 100, 'short'), cap('b', 1000, 2000, '   '), cap('c', 19_000, 25_000, 'end')],
      'replace',
      20_000
    )
    expect(r.edits.captions).toEqual([
      expect.objectContaining({ start_ms: 19_000, end_ms: 20_000, text: 'end' })
    ])
    expect(r.skipped).toBe(2)
  })
  it('caps the list at the limit and counts what did not fit', () => {
    const many = Array.from({ length: EDIT_LIMITS.captions + 5 }, (_, i) =>
      cap(`g${i}`, i * 1000, i * 1000 + 500, `L${i}`)
    )
    const r = applyGeneratedCaptions({ ...edits, captions: [] }, many, 'replace', 10_000_000)
    expect(r.edits.captions).toHaveLength(EDIT_LIMITS.captions)
    expect(r.added).toBe(EDIT_LIMITS.captions)
    expect(r.skipped).toBe(5)
  })
})

describe('captionJobLabel', () => {
  it('reads the job state in plain words', () => {
    expect(captionJobLabel({ status: 'queued' })).toMatch(/Waiting/)
    expect(captionJobLabel({ status: 'running', phase: 'extracting' })).toMatch(/sound/)
    expect(captionJobLabel({ status: 'running' })).toBe('Transcribing…')
    expect(captionJobLabel({ status: 'failed', error: 'boom' })).toBe('boom')
    expect(captionJobLabel({ status: 'done', captions: [generated[0]] })).toBe(
      '1 caption line ready to review'
    )
    expect(captionJobLabel({ status: 'done', captions: [] })).toMatch(/Nothing was heard/)
  })
})
