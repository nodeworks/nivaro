import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))

import { db } from '../../../db/index.js'
import { emptyEdits, hashEdits } from '../../../services/help-video-edits.js'
import {
  loadVideoForUser,
  parseVisibility,
  publishChecklist,
  requiredForRole,
  restoreVersion,
  serializeVersion,
  serializeVideo,
  type VideoRow,
  validateContexts,
  viewerMaySee
} from '../../../services/help-videos.js'

describe('requiredForRole', () => {
  it('is required only for a role that has a requirement row', () => {
    expect(requiredForRole(['R1', 'r2'], 'r1')).toBe(true)
    expect(requiredForRole(['R1', 'r2'], 'R2')).toBe(true)
    expect(requiredForRole(['R1'], 'R3')).toBe(false)
  })
  it('is never required for a person with no role or a video with no requirements', () => {
    expect(requiredForRole(['R1'], null)).toBe(false)
    expect(requiredForRole([], 'R1')).toBe(false)
  })
})

describe('parseVisibility', () => {
  it('defaults to everyone', () =>
    expect(parseVisibility(null)).toEqual({ mode: 'everyone', role_ids: [] }))
  it('reads a JSON string and upper-cases role ids', () =>
    expect(parseVisibility('{"mode":"roles","role_ids":["ab-c"]}')).toEqual({
      mode: 'roles',
      role_ids: ['AB-C']
    }))
  it('falls back to everyone when roles mode has no roles', () =>
    expect(parseVisibility({ mode: 'roles', role_ids: [] })).toEqual({
      mode: 'everyone',
      role_ids: []
    }))
})

describe('viewerMaySee', () => {
  const published = { status: 'published', visibility: { mode: 'roles', role_ids: ['R1'] } }
  it('lets authors see anything', () =>
    expect(viewerMaySee({ status: 'draft', visibility: null }, null, true)).toBe(true))
  it('hides drafts from viewers', () =>
    expect(viewerMaySee({ status: 'draft', visibility: null }, 'R1', false)).toBe(false))
  it('hides archived videos from viewers', () =>
    expect(viewerMaySee({ status: 'archived', visibility: null }, 'R1', false)).toBe(false))
  it('matches role ids case-insensitively', () =>
    expect(viewerMaySee(published, 'r1', false)).toBe(true))
  it('hides a role-limited video from other roles', () =>
    expect(viewerMaySee(published, 'R2', false)).toBe(false))
  it('shows an everyone video to a user with no role', () =>
    expect(viewerMaySee({ status: 'published', visibility: null }, null, false)).toBe(true))
})

describe('validateContexts', () => {
  it('accepts collections with optional states and page keys', () => {
    expect(
      validateContexts([
        { kind: 'collection', key: 'workflows', state_key: 'waiting_on_manager_approval' },
        { kind: 'page', key: 'budget-spend', state_key: 'ignored' }
      ])
    ).toEqual([
      { kind: 'collection', key: 'workflows', state_key: 'waiting_on_manager_approval' },
      { kind: 'page', key: 'budget-spend', state_key: null }
    ])
  })
  it('removes duplicates', () =>
    expect(
      validateContexts([
        { kind: 'page', key: 'a' },
        { kind: 'page', key: 'a' }
      ])
    ).toHaveLength(1))
  it('refuses unknown kinds and unsafe keys', () => {
    expect(() => validateContexts([{ kind: 'url', key: '/x' }])).toThrow()
    expect(() => validateContexts([{ kind: 'page', key: 'a b;drop' }])).toThrow()
  })
  it('refuses more than 50 contexts', () =>
    expect(() =>
      validateContexts(Array.from({ length: 51 }, (_, i) => ({ kind: 'page', key: `p${i}` })))
    ).toThrow())
})

describe('publishChecklist', () => {
  it('names what is missing', () =>
    expect(publishChecklist({ title: ' ' }, 0)).toEqual(['title', 'where']))
  it('is empty when ready', () =>
    expect(publishChecklist({ title: 'Approve a request' }, 1)).toEqual([]))
})

const edits = emptyEdits(10_000)
const versionRow = {
  id: 'V1',
  video_id: 'X',
  version: 2,
  source_file: 'F',
  source_duration_ms: 10_000,
  width: 1920,
  height: 1080,
  clicks: '[{"t_ms":1,"x":0.1,"y":0.2}]',
  levels: '[1,2]',
  edits: JSON.stringify(edits),
  edits_hash: hashEdits(edits),
  render_status: 'ready',
  render_progress: 100,
  rendered_hash: hashEdits(edits),
  rendered_file: 'R',
  captions_file: null,
  poster_file: null,
  render_error: null,
  note: null,
  created_at: new Date('2026-10-08T00:00:00Z')
}

describe('serializeVersion', () => {
  it('reports a current render and lower-cases the id', () => {
    const v = serializeVersion(versionRow as never, { withRecorderData: false })
    expect(v.id).toBe('v1')
    expect(v.rendered_current).toBe(true)
    expect(v.clicks).toBeUndefined()
  })
  it('includes recorder data only for authors working on a draft', () => {
    const v = serializeVersion(versionRow as never, { withRecorderData: true })
    expect(v.clicks).toEqual([{ t_ms: 1, x: 0.1, y: 0.2 }])
    expect(v.levels).toEqual([1, 2])
  })
  it('marks a render stale when the edits moved on', () => {
    const v = serializeVersion({ ...versionRow, rendered_hash: 'old' } as never, {
      withRecorderData: false
    })
    expect(v.rendered_current).toBe(false)
  })
})

// A tiny stand-in for the knex builder: db(table).where({...}).first()/select().
type Rows = Record<string, Array<Record<string, unknown>>>
function fakeDb(tables: Rows, seen: string[]) {
  return (table: string) => {
    let filter: Record<string, unknown> = {}
    const rows = () =>
      (tables[table] ?? []).filter((r) =>
        Object.entries(filter).every(
          ([k, v]) => String(r[k]).toLowerCase() === String(v).toLowerCase()
        )
      )
    const b = {
      where(f: Record<string, unknown>) {
        filter = { ...filter, ...f }
        seen.push(`${table}:${JSON.stringify(filter)}`)
        return b
      },
      select: async () => rows(),
      first: async () => rows()[0]
    }
    return b
  }
}

describe('serializeVideo', () => {
  const video = {
    id: 'AAAA',
    title: 'Approve a request',
    description: null,
    category: null,
    status: 'published',
    visibility: JSON.stringify({ mode: 'everyone', role_ids: [] }),
    published_version_id: 'P1',
    draft_version_id: 'D1',
    duration_ms: 10_000,
    poster_file: null,
    created_by: 'U9',
    required_since: null,
    updated_at: new Date('2026-10-08T00:00:00Z')
  } as unknown as VideoRow
  const tables: Rows = {
    nivaro_help_video_versions: [
      { ...versionRow, id: 'P1', video_id: 'AAAA', version: 1 },
      { ...versionRow, id: 'D1', video_id: 'AAAA', version: 2, note: 'secret draft' }
    ],
    nivaro_help_video_contexts: [{ video_id: 'AAAA', kind: 'page', key: 'p', state_key: null }],
    nivaro_help_video_requirements: [{ video_id: 'AAAA', role_id: 'R1' }],
    nivaro_help_video_views: [],
    nivaro_users: [{ id: 'U9', first_name: 'Ada', last_name: 'L' }]
  }

  it('never gives a viewer the draft, not even as a key', async () => {
    const seen: string[] = []
    vi.mocked(db).mockImplementation(fakeDb(tables, seen) as never)
    const dto = await serializeVideo(video, { author: false, userId: 'U1', role: 'R1' })
    expect('draft' in dto).toBe(false)
    expect('visibility' in dto).toBe(false)
    expect('required_role_ids' in dto).toBe(false)
    expect('created_by_name' in dto).toBe(false)
    expect(dto.published?.id).toBe('p1')
    expect(JSON.stringify(dto)).not.toContain('d1')
    expect(JSON.stringify(dto)).not.toContain('secret draft')
    // The draft version row is never even read for a viewer.
    expect(seen.some((s) => s.includes('"D1"'))).toBe(false)
  })

  it('is required only for the viewer whose role has a requirement', async () => {
    vi.mocked(db).mockImplementation(fakeDb(tables, []) as never)
    expect(
      (await serializeVideo(video, { author: false, userId: 'U1', role: 'r1' })).required
    ).toBe(true)
    expect(
      (await serializeVideo(video, { author: false, userId: 'U1', role: 'R2' })).required
    ).toBe(false)
  })

  it('gives authors the draft and the required roles', async () => {
    vi.mocked(db).mockImplementation(fakeDb(tables, []) as never)
    const dto = await serializeVideo(video, { author: true, userId: 'U1', role: 'R2' })
    expect(dto.draft?.id).toBe('d1')
    expect(dto.draft?.clicks).toEqual([{ t_ms: 1, x: 0.1, y: 0.2 }])
    expect(dto.required_role_ids).toEqual(['R1'])
    expect(dto.required).toBe(false)
    expect(dto.created_by_name).toBe('Ada L')
  })
})

describe('ids that are not exact uuids', () => {
  const uuid = '0b6c5a7e-1d2f-4a3b-8c9d-0e1f2a3b4c5d'
  const req = { user: { id: 'U1', role: null }, isAdmin: true } as never

  it('404 before touching the database', async () => {
    vi.mocked(db).mockClear()
    for (const bad of [`${uuid}/../x`, `${uuid}x`, 'abc', '']) {
      await expect(loadVideoForUser(req, bad)).rejects.toMatchObject({
        statusCode: 404,
        code: 'HELP_VIDEO_NOT_FOUND'
      })
    }
    await expect(
      restoreVersion({ id: uuid } as VideoRow, { id: 'U1' } as never, `${uuid}zz`)
    ).rejects.toMatchObject({ statusCode: 404, code: 'HELP_VIDEO_VERSION_NOT_FOUND' })
    expect(vi.mocked(db)).not.toHaveBeenCalled()
  })
})
