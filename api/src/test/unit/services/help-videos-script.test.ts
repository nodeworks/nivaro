import { beforeEach, describe, expect, it, vi } from 'vitest'

// Script mode (#1491): a scripted recording's first draft has a chapter per
// marked step and keeps the script on the version; a plain recording keeps
// exactly the edits it always had.

const st = vi.hoisted(() => ({
  versions: [] as Array<Record<string, unknown>>,
  upload: {} as Record<string, unknown>
}))

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['where', 'select', 'orderBy', 'max', 'whereIn']) q[m] = () => q
    q.first = async () => ({ v: 0, m: 0 })
    q.insert = async (row: Record<string, unknown>) => {
      if (table === 'nivaro_help_video_versions') st.versions.push(row)
      return []
    }
    q.update = async () => 1
    q.delete = async () => 1
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    q.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return q
  }
  return { db }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
vi.mock('../../../services/help-video-house-style.js', () => ({
  currentHouseStyle: async () => ({ style: {} }),
  applyHouseStyleToNew: (e: unknown) => e
}))
vi.mock('../../../services/help-video-uploads.js', () => ({
  takeFinalizedUpload: vi.fn(async () => ({
    file_id: 'file-1',
    duration_ms: 20_000,
    width: 1280,
    height: 800,
    has_audio: true,
    clicks: null,
    levels: null,
    script: null,
    marks: null,
    ...st.upload
  })),
  releaseFinalizedUpload: vi.fn(async () => undefined)
}))

import { emptyEdits, hashEdits } from '../../../services/help-video-edits.js'
import { createVideo, rerecordVideo } from '../../../services/help-videos.js'

const UPLOAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const user = { id: 'U1' } as never
const inserted = () => st.versions[0]
const editsOf = (row: Record<string, unknown>) => JSON.parse(String(row.edits))

beforeEach(() => {
  st.versions = []
  st.upload = {}
})

describe('a scripted recording becomes a draft with chapters', () => {
  it('createVideo: one chapter per marked step, the first at 0, and the script kept', async () => {
    st.upload = {
      script: ['Open the record', 'Press Approve', 'Check the result'],
      marks: [
        { t_ms: 4000, step: 1 },
        { t_ms: 9000, step: 2 }
      ]
    }
    await createVideo(user, { upload_id: UPLOAD })
    const row = inserted()
    expect(editsOf(row).chapters).toEqual([
      { id: 'script-1', at_ms: 0, title: 'Open the record' },
      { id: 'script-2', at_ms: 4000, title: 'Press Approve' },
      { id: 'script-3', at_ms: 9000, title: 'Check the result' }
    ])
    expect(JSON.parse(String(row.script))).toEqual([
      'Open the record',
      'Press Approve',
      'Check the result'
    ])
    expect(row.edits_hash).toBe(hashEdits(editsOf(row)))
  })

  it('rerecordVideo: the new draft gets the chapters and the script too', async () => {
    st.upload = { script: ['One', 'Two'], marks: [{ t_ms: 2500, step: 1 }] }
    const dto = await rerecordVideo({ id: 'V1' } as never, user, UPLOAD).catch(() => null)
    // The stub db has no row to read back; the insert is what matters.
    expect(dto).toBeNull()
    const row = inserted()
    expect(editsOf(row).chapters).toEqual([
      { id: 'script-1', at_ms: 0, title: 'One' },
      { id: 'script-2', at_ms: 2500, title: 'Two' }
    ])
    expect(JSON.parse(String(row.script))).toEqual(['One', 'Two'])
    expect(row.note).toBe('Re-recorded')
  })

  it('a recording without a script keeps byte-identical edits and no script', async () => {
    await createVideo(user, { upload_id: UPLOAD })
    const row = inserted()
    expect(row.edits).toBe(JSON.stringify(emptyEdits(20_000)))
    expect(row.edits_hash).toBe(hashEdits(emptyEdits(20_000)))
    expect(row.script).toBeNull()
  })

  it('a script whose Next was never pressed still opens with its first chapter', async () => {
    st.upload = { script: ['Only step'], marks: [] }
    await createVideo(user, { upload_id: UPLOAD })
    expect(editsOf(inserted()).chapters).toEqual([{ id: 'script-1', at_ms: 0, title: 'Only step' }])
  })
})
