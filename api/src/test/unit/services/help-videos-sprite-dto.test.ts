import { describe, expect, it, vi } from 'vitest'

// #1560: the draft DTO carries the server's peaks and the sprite sheet behind
// a ticketed URL; a version DTO without recorder data carries neither.

vi.mock('../../../config.js', () => ({ config: { SESSION_SECRET: 'x'.repeat(40) } }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))

import { emptyEdits, hashEdits } from '../../../services/help-video-edits.js'
import { draftMedia, serializeVersion, spriteDto } from '../../../services/help-videos.js'

const VIDEO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FILE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const edits = emptyEdits(10_000)
const row = {
  id: 'V1',
  video_id: VIDEO,
  version: 1,
  source_file: 'F',
  source_duration_ms: 10_000,
  width: 1920,
  height: 1080,
  clicks: null,
  levels: null,
  peaks: '[0.1,0.9,0.4]',
  sprite_file: FILE,
  sprite: JSON.stringify({
    file_id: FILE,
    tile_w: 160,
    tile_h: 90,
    cols: 10,
    count: 11,
    interval_ms: 1000
  }),
  edits: JSON.stringify(edits),
  edits_hash: hashEdits(edits),
  render_status: 'none',
  render_progress: null,
  rendered_hash: null,
  rendered_file: null,
  render_error: null,
  note: null,
  created_at: new Date('2026-10-10T00:00:00Z')
}

describe('serializeVersion with the extras', () => {
  it('gives authors the peaks and a ticketed sprite URL', () => {
    const media = draftMedia(VIDEO, 'U1', null)
    const v = serializeVersion(row as never, { withRecorderData: true, media })
    expect(v.peaks).toEqual([0.1, 0.9, 0.4])
    expect(v.sprite).toEqual({
      url: `/api/help-videos/${VIDEO}/sprite?st=${media.ticket}&v=v1`,
      tile_w: 160,
      tile_h: 90,
      cols: 10,
      count: 11,
      interval_ms: 1000
    })
    expect(media.ticket.split('.')[2]).toBe('d')
  })
  it('has no sprite URL without a ticket, and nothing without recorder data', () => {
    const v = serializeVersion(row as never, { withRecorderData: true })
    expect(v.peaks).toEqual([0.1, 0.9, 0.4])
    expect(v.sprite).toBeNull()
    const pub = serializeVersion(row as never, { withRecorderData: false })
    expect(pub.peaks).toBeUndefined()
    expect(pub.sprite).toBeUndefined()
  })
  it('reads an older version (no columns, or a sheet whose file is gone) as none', () => {
    expect(
      spriteDto(
        { id: 'v', sprite: undefined, sprite_file: undefined },
        { videoId: VIDEO, ticket: 't' }
      )
    ).toBeNull()
    expect(
      spriteDto({ id: 'v', sprite: row.sprite, sprite_file: null }, { videoId: VIDEO, ticket: 't' })
    ).toBeNull()
    const v = serializeVersion({ ...row, peaks: null, sprite: null, sprite_file: null } as never, {
      withRecorderData: true,
      media: { videoId: VIDEO, ticket: 't' }
    })
    expect(v.peaks).toBeNull()
    expect(v.sprite).toBeNull()
  })
})
