import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: vi.fn() }))

import { transcriptText } from '../../../services/help-video-download.js'
import { normalizeEdits } from '../../../services/help-video-edits.js'
import { parseMomentLink } from '../../../services/help-video-moments.js'
import { requiredNotice } from '../../../services/help-videos.js'

const ID = 'AAAAAAAA-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

describe('parseMomentLink (#1501)', () => {
  it('reads watch, t and c from any app path', () => {
    expect(parseMomentLink(`/help/videos?watch=${ID}&t=42&c=c3`)).toEqual({
      id: ID.toLowerCase(),
      t: 42,
      c: 'c3'
    })
    expect(parseMomentLink(`https://example.test/help-videos?watch=${ID}`)).toEqual({
      id: ID.toLowerCase(),
      t: null,
      c: null
    })
  })
  it('is null without a video id, and ignores a bad t or c', () => {
    expect(parseMomentLink('/help-videos?watch=nope')).toBeNull()
    expect(parseMomentLink('/collections/workflows/1')).toBeNull()
    expect(parseMomentLink(`/help-videos?watch=${ID}&t=-4&c=<x>`)).toEqual({
      id: ID.toLowerCase(),
      t: null,
      c: null
    })
  })
})

describe('transcriptText (#1529)', () => {
  const edits = normalizeEdits(
    {
      segments: [
        { start_ms: 0, end_ms: 10_000, speed: 1 },
        { start_ms: 20_000, end_ms: 80_000, speed: 1 }
      ],
      chapters: [
        { id: 'c1', at_ms: 0, title: 'Opening the form' },
        { id: 'c2', at_ms: 30_000, title: 'Saving' }
      ],
      captions: [
        { id: 'a', start_ms: 1000, end_ms: 3000, text: 'Open the record.' },
        { id: 'b', start_ms: 12_000, end_ms: 14_000, text: 'Cut away.' },
        { id: 'c', start_ms: 31_000, end_ms: 33_000, text: 'Press\nSave.' }
      ]
    },
    80_000
  )
  const version = {
    source_file: 'f',
    rendered_file: null,
    rendered_hash: null,
    edits_hash: 'h',
    edits: JSON.stringify(edits),
    source_duration_ms: 80_000
  }
  it('lists captions in edited time under chapter headings', () => {
    expect(transcriptText(version, 'Approving', 'edited')).toBe(
      [
        'Approving',
        'Transcript · 1:10',
        '',
        'Opening the form (0:00)',
        '',
        '[0:01] Open the record.',
        '',
        'Saving (0:20)',
        '',
        '[0:21] Press Save.',
        ''
      ].join('\n')
    )
  })
  it('is null with no captions', () => {
    expect(
      transcriptText(
        { ...version, edits: JSON.stringify({ ...edits, captions: [] }) },
        'x',
        'edited'
      )
    ).toBeNull()
  })
})

describe('requiredNotice for watching again (#1497)', () => {
  it('carries the version note', () => {
    expect(requiredNotice('Approving', { again: true, note: 'New approval step' })).toEqual({
      subject: 'Please watch again: Approving',
      message: 'What changed: New approval step\n\nIt is on your dashboard under Required videos.',
      why: 'This video is required for your role.'
    })
  })
  it('without a note still says why', () => {
    expect(requiredNotice('Approving', { again: true }).message).toMatch(/watch it again/)
  })
})
