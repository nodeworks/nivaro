import { beforeEach, describe, expect, it, vi } from 'vitest'

// createVideo / rerecordVideo take the finalized upload (finalized -> used)
// BEFORE inserting. If the insert fails nothing references the recording, so
// the upload goes back to finalized-unused: its author sees it again and the
// purge can collect it.

const st = vi.hoisted(() => ({
  failVideoInsert: false,
  failVersionInsert: false,
  deletedVideos: 0
}))

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['where', 'select', 'orderBy', 'max', 'whereIn']) q[m] = () => q
    q.first = async () => ({ v: 0 })
    q.insert = async () => {
      if (table === 'nivaro_help_videos' && st.failVideoInsert) throw new Error('db down')
      if (table === 'nivaro_help_video_versions' && st.failVersionInsert) throw new Error('db down')
      return []
    }
    q.update = async () => 1
    q.delete = async () => {
      if (table === 'nivaro_help_videos') st.deletedVideos++
      return 1
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    q.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return q
  }
  return { db }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
vi.mock('../../../services/help-video-uploads.js', () => ({
  takeFinalizedUpload: vi.fn(async () => ({
    file_id: 'file-1',
    duration_ms: 5000,
    width: 1,
    height: 1,
    has_audio: true,
    clicks: null,
    levels: null
  })),
  releaseFinalizedUpload: vi.fn(async () => undefined)
}))

import { releaseFinalizedUpload } from '../../../services/help-video-uploads.js'
import { createVideo, rerecordVideo } from '../../../services/help-videos.js'

const UPLOAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const user = { id: 'U1' } as never

beforeEach(() => {
  st.failVideoInsert = false
  st.failVersionInsert = false
  st.deletedVideos = 0
  vi.mocked(releaseFinalizedUpload).mockClear()
})

describe('a failed create gives the recording back', () => {
  it('createVideo: the video insert failing releases the upload', async () => {
    st.failVideoInsert = true
    await expect(createVideo(user, { upload_id: UPLOAD })).rejects.toThrow('db down')
    expect(releaseFinalizedUpload).toHaveBeenCalledWith(UPLOAD)
  })

  it('createVideo: the version insert failing releases the upload and drops the empty video', async () => {
    st.failVersionInsert = true
    await expect(createVideo(user, { upload_id: UPLOAD })).rejects.toThrow('db down')
    expect(releaseFinalizedUpload).toHaveBeenCalledWith(UPLOAD)
    expect(st.deletedVideos).toBe(1)
  })

  it('rerecordVideo: the version insert failing releases the upload', async () => {
    st.failVersionInsert = true
    await expect(rerecordVideo({ id: 'V1' } as never, user, UPLOAD)).rejects.toThrow('db down')
    expect(releaseFinalizedUpload).toHaveBeenCalledWith(UPLOAD)
  })

  it('a successful create keeps the upload used', async () => {
    await createVideo(user, { upload_id: UPLOAD })
    expect(releaseFinalizedUpload).not.toHaveBeenCalled()
  })
})
