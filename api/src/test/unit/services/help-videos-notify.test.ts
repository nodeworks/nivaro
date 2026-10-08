import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: vi.fn() }))

import { db } from '../../../db/index.js'
import {
  notifyRequiredViewers,
  notifyRequiredViewersSafely,
  publishVideo,
  requiredNotice
} from '../../../services/help-videos.js'
import { getApp } from '../../../services/io-holder.js'
import { notifyUser } from '../../../services/notification-channels.js'

const R1 = '11111111-1111-1111-1111-111111111111'
const R2 = '22222222-2222-2222-2222-222222222222'
const R3 = '33333333-3333-3333-3333-333333333333'
const VIDEO = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const warn = vi.fn()
let usersQuery: any

function fakeDb(visibility: unknown, users: Array<{ id: string }>) {
  vi.mocked(db).mockImplementation(((table: string) => {
    if (table === 'nivaro_help_videos') {
      return { where: () => ({ first: async () => ({ visibility }) }) }
    }
    const q: any = {}
    q.whereIn = vi.fn(() => q)
    q.where = vi.fn(() => q)
    q.whereNull = vi.fn(() => q)
    q.orderBy = vi.fn(() => q)
    q.limit = vi.fn(() => q)
    q.select = vi.fn(async () => users)
    usersQuery = q
    return q
  }) as never)
}

describe('requiredNotice', () => {
  it('names the video and says why', () =>
    expect(requiredNotice('Approving a request')).toEqual({
      subject: 'Please watch: Approving a request',
      message:
        'A short video your role is asked to watch. It is on your dashboard under Required videos.',
      why: 'This video is required for your role.'
    }))
})

describe('notifyRequiredViewers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getApp).mockReturnValue({ log: { warn } })
    vi.mocked(notifyUser).mockResolvedValue(undefined as never)
  })

  it('notifies everyone in the required roles when the video is for everyone', async () => {
    fakeDb(JSON.stringify({ mode: 'everyone', role_ids: [] }), [{ id: 'u1' }, { id: 'u2' }])
    expect(await notifyRequiredViewers(VIDEO, 'T', [R1, R2])).toBe(2)
    expect(usersQuery.whereIn).toHaveBeenCalledWith('role', [R1, R2])
    expect(notifyUser).toHaveBeenCalledTimes(2)
  })

  it('a limited-visibility video notifies only the intersection', async () => {
    fakeDb(JSON.stringify({ mode: 'roles', role_ids: [R2.toLowerCase(), R3] }), [{ id: 'u1' }])
    await notifyRequiredViewers(VIDEO, 'T', [R1, R2])
    expect(usersQuery.whereIn).toHaveBeenCalledWith('role', [R2])
  })

  it('ignores a role id that is not a uuid', async () => {
    fakeDb(null, [{ id: 'u1' }])
    await notifyRequiredViewers(VIDEO, 'T', ['not-a-uuid', `${R1}/../x`, R1])
    expect(usersQuery.whereIn).toHaveBeenCalledWith('role', [R1])
  })

  it('sends nothing when the intersection is empty', async () => {
    fakeDb(JSON.stringify({ mode: 'roles', role_ids: [R3] }), [{ id: 'u1' }])
    expect(await notifyRequiredViewers(VIDEO, 'T', [R1, R2])).toBe(0)
    expect(notifyUser).not.toHaveBeenCalled()
    expect(db).not.toHaveBeenCalledWith('nivaro_users')
  })

  it('sends nothing when only non-uuid ids are given', async () => {
    fakeDb(null, [{ id: 'u1' }])
    expect(await notifyRequiredViewers(VIDEO, 'T', ['nope'])).toBe(0)
    expect(notifyUser).not.toHaveBeenCalled()
  })

  it('caps at 2,000 people and warns about the truncation', async () => {
    fakeDb(
      null,
      Array.from({ length: 2001 }, (_, i) => ({ id: `u${i}` }))
    )
    expect(await notifyRequiredViewers(VIDEO, 'T', [R1])).toBe(2000)
    expect(notifyUser).toHaveBeenCalledTimes(2000)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('counts per-user failures, logs one summary, and returns the delivered count', async () => {
    fakeDb(null, [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }])
    const boom = new Error('boom')
    vi.mocked(notifyUser)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(boom)
      .mockRejectedValueOnce(new Error('second'))
    expect(await notifyRequiredViewers(VIDEO, 'T', [R1])).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({ err: boom, failed: 2 })
  })

  it('bounds the label and uses a fallback title', async () => {
    fakeDb(null, [{ id: 'u1' }])
    await notifyRequiredViewers(VIDEO, '', [R1])
    expect(vi.mocked(notifyUser).mock.calls[0][2]).toMatchObject({
      source: { label: 'Untitled video' }
    })
    await notifyRequiredViewers(VIDEO, 'x'.repeat(400), [R1])
    const last = vi.mocked(notifyUser).mock.calls.at(-1)?.[2] as { source: { label: string } }
    expect(last.source.label).toHaveLength(250)
  })
})

describe('notifyRequiredViewersSafely', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getApp).mockReturnValue({ log: { warn } })
  })

  it('logs an outer failure instead of throwing', async () => {
    const boom = new Error('db down')
    vi.mocked(db).mockImplementation((() => {
      throw boom
    }) as never)
    expect(await notifyRequiredViewersSafely(VIDEO, 'T', [R1])).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      { err: boom, videoId: VIDEO },
      'help video required notify failed'
    )
  })
})

describe('publishVideo notifies', () => {
  const user = { id: 'U1' } as never
  const flush = () => new Promise((r) => setTimeout(r, 0))

  function publishDb() {
    vi.mocked(db).mockImplementation(((table: string) => {
      const q: any = {}
      q.where = vi.fn(() => q)
      q.whereIn = vi.fn(() => q)
      q.whereNull = vi.fn(() => q)
      q.orderBy = vi.fn(() => q)
      q.limit = vi.fn(() => q)
      q.update = vi.fn(async () => 1)
      q.count = vi.fn(() => q)
      q.first = vi.fn(async () => {
        if (table === 'nivaro_help_video_versions') return { id: 'V2', version: 2, edits: null }
        if (table === 'nivaro_help_video_contexts') return { n: 1 }
        return { visibility: null }
      })
      q.select = vi.fn(async () => {
        if (table === 'nivaro_help_video_requirements') return [{ role_id: R1 }]
        return [{ id: 'u1' }]
      })
      return q
    }) as never)
  }

  const video = (published: string | null) =>
    ({
      id: VIDEO,
      title: 'Hello',
      published_version_id: published,
      draft_version_id: 'V2'
    }) as never

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getApp).mockReturnValue({ log: { warn } })
    vi.mocked(notifyUser).mockResolvedValue(undefined as never)
    publishDb()
  })

  it('on a first publish', async () => {
    await publishVideo(video(null), user, {})
    await flush()
    expect(notifyUser).toHaveBeenCalledTimes(1)
  })

  it('on ask-everyone-to-watch-again', async () => {
    await publishVideo(video('V1'), user, { watch_again: true })
    await flush()
    expect(notifyUser).toHaveBeenCalledTimes(1)
  })

  it('not on a plain republish', async () => {
    await publishVideo(video('V1'), user, {})
    await flush()
    expect(notifyUser).not.toHaveBeenCalled()
  })
})
