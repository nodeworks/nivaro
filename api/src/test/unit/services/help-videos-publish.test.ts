import { beforeEach, describe, expect, it, vi } from 'vitest'

// I2: opening the editor makes a draft, so a draft alone is no change.
// Publishing one identical to the published version (same recording, same
// edits) is refused; with "ask everyone to watch again" on a video someone
// must watch, the requirement is re-armed with no new version and no render.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: vi.fn() }))

import { db } from '../../../db/index.js'
import { queueRender } from '../../../services/help-video-render.js'
import { publishVideo, sameContent, serializeVideo } from '../../../services/help-videos.js'
import { getApp } from '../../../services/io-holder.js'
import { notifyUser } from '../../../services/notification-channels.js'

const VIDEO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SRC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ROLE = '11111111-1111-4111-8111-111111111111'
const user = { id: 'U1' } as never
const flush = () => new Promise((r) => setTimeout(r, 0))

type Row = Record<string, unknown>
let versions: Record<string, Row>
let requirements: Row[]
let updates: Array<{ table: string; patch: Row }>

function version(id: string, extra: Row = {}): Row {
  return {
    id,
    video_id: VIDEO,
    version: Number(id.slice(1)),
    source_file: SRC,
    edits: JSON.stringify({ segments: [] }),
    edits_hash: 'h1',
    source_duration_ms: 10_000,
    render_status: 'ready',
    created_at: new Date(),
    ...extra
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getApp).mockReturnValue({ log: { warn: vi.fn() } } as never)
  vi.mocked(notifyUser).mockResolvedValue(undefined as never)
  versions = { P1: version('P1'), D2: version('D2') }
  requirements = []
  updates = []
  vi.mocked(db).mockImplementation(((table: string) => {
    let where: Row = {}
    const q: Record<string, unknown> = {}
    for (const m of ['whereIn', 'whereNull', 'orderBy', 'limit', 'count']) q[m] = vi.fn(() => q)
    q.where = vi.fn((w: Row) => {
      where = { ...where, ...w }
      return q
    })
    q.update = vi.fn(async (patch: Row) => {
      updates.push({ table, patch })
      return 1
    })
    q.first = vi.fn(async () => {
      if (table === 'nivaro_help_video_versions') return versions[String(where.id)]
      if (table === 'nivaro_help_video_contexts') return { n: 1 }
      if (table === 'nivaro_help_video_requirements') return { n: requirements.length }
      if (table === 'nivaro_help_video_views') return undefined
      return { visibility: null }
    })
    q.select = vi.fn(async () => {
      if (table === 'nivaro_help_video_requirements') return requirements
      if (table === 'nivaro_help_video_contexts') return []
      return [{ id: 'u1' }]
    })
    return q
  }) as never)
})

const live = (draft = 'D2') =>
  ({
    id: VIDEO,
    title: 'Approve a PO',
    status: 'published',
    visibility: null,
    published_version_id: 'P1',
    draft_version_id: draft,
    updated_at: new Date()
  }) as never

describe('publishing a draft identical to the published version', () => {
  it('is refused with 409 HELP_VIDEO_NOTHING_TO_PUBLISH and changes nothing', async () => {
    await expect(publishVideo(live(), user, {})).rejects.toMatchObject({
      statusCode: 409,
      code: 'HELP_VIDEO_NOTHING_TO_PUBLISH',
      message: 'No changes since the last publish'
    })
    expect(updates).toEqual([])
    expect(queueRender).not.toHaveBeenCalled()
  })

  it('"watch again" without anyone required is refused too', async () => {
    await expect(publishVideo(live(), user, { watch_again: true })).rejects.toMatchObject({
      statusCode: 409,
      code: 'HELP_VIDEO_NOTHING_TO_PUBLISH'
    })
    expect(queueRender).not.toHaveBeenCalled()
  })

  it('"watch again" on a required video re-arms it: no new version, no render', async () => {
    requirements = [{ role_id: ROLE }]
    expect(await publishVideo(live(), user, { watch_again: true })).toBe('P1')
    await flush()
    expect(queueRender).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
    expect(updates[0].table).toBe('nivaro_help_videos')
    expect(updates[0].patch.required_since).toBeInstanceOf(Date)
    expect(updates[0].patch).not.toHaveProperty('published_version_id')
    expect(notifyUser).toHaveBeenCalledTimes(1)
  })

  it('publishes as before when the edits differ', async () => {
    versions.D2 = version('D2', { edits_hash: 'h2' })
    expect(await publishVideo(live(), user, {})).toBe('D2')
    expect(queueRender).toHaveBeenCalledWith('D2')
    expect(updates[0].patch).toMatchObject({ published_version_id: 'D2', draft_version_id: null })
  })

  it('publishes as before when the recording differs (re-record with the same edits)', async () => {
    versions.D2 = version('D2', { source_file: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
    expect(await publishVideo(live(), user, {})).toBe('D2')
    expect(queueRender).toHaveBeenCalledWith('D2')
  })

  it('an archived video with an identical draft can still be published again', async () => {
    const archived = { ...(live() as object), status: 'archived' } as never
    expect(await publishVideo(archived, user, {})).toBe('D2')
  })
})

describe('sameContent / draft_matches_published', () => {
  it('compares recording (any case) and edits hash', () => {
    const a = { edits_hash: 'h', source_file: SRC }
    expect(sameContent(a, { edits_hash: 'h', source_file: SRC.toUpperCase() })).toBe(true)
    expect(sameContent(a, { edits_hash: 'x', source_file: SRC })).toBe(false)
    expect(sameContent(a, undefined)).toBe(false)
  })

  it('the author DTO says whether the draft matches what is published', async () => {
    const ctx = { author: true, userId: 'U1', role: null }
    expect((await serializeVideo(live(), ctx)).draft_matches_published).toBe(true)
    versions.D2 = version('D2', { edits_hash: 'h2' })
    expect((await serializeVideo(live(), ctx)).draft_matches_published).toBe(false)
    expect((await serializeVideo(live(null as never), ctx)).draft_matches_published).toBe(false)
    expect(
      (await serializeVideo(live(), { ...ctx, author: false })).draft_matches_published
    ).toBeUndefined()
  })
})
