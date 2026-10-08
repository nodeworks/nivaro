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
  saveDraftEdits,
  serializeVersion,
  serializeVideo,
  sessionTag,
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

// A tiny stand-in for the knex builder: db(table).where({...}).whereIn(col, sub)
// .first()/select()/update(). Reads hand back copies (a row read at request
// start does not change under the caller); an awaited builder yields its rows;
// a builder passed to whereIn acts as a subquery over its selected column.
type Rows = Record<string, Array<Record<string, unknown>>>
type Fake = {
  where(f: Record<string, unknown>): Fake
  whereIn(col: string, sub: unknown[] | Fake): Fake
  select(...cols: string[]): Fake
  first(...cols: string[]): Promise<Record<string, unknown> | undefined>
  update(patch: Record<string, unknown>): Promise<number>
  values(): unknown[]
  then<T>(res: (rows: Array<Record<string, unknown>>) => T, rej?: (e: unknown) => T): Promise<T>
}
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()
function fakeDb(tables: Rows, seen: string[]) {
  return (table: string): Fake => {
    const tests: Array<(r: Record<string, unknown>) => boolean> = []
    let filter: Record<string, unknown> = {}
    let cols: string[] = []
    const live = () => (tables[table] ?? []).filter((r) => tests.every((t) => t(r)))
    const b: Fake = {
      where(f) {
        filter = { ...filter, ...f }
        seen.push(`${table}:${JSON.stringify(filter)}`)
        tests.push((r) => Object.entries(f).every(([k, v]) => same(r[k], v)))
        return b
      },
      whereIn(col, sub) {
        tests.push((r) => {
          const vals = Array.isArray(sub) ? sub : sub.values()
          return vals.some((v) => v != null && same(v, r[col]))
        })
        return b
      },
      select(...c) {
        cols = c
        return b
      },
      values: () => live().map((r) => r[cols[0]]),
      first: async () => {
        const r = live()[0]
        return r ? { ...r } : undefined
      },
      update: async (patch) => {
        const rs = live()
        for (const r of rs) Object.assign(r, patch)
        return rs.length
      },
      // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable; the fake must be too
      then: (res, rej) => Promise.resolve(live().map((r) => ({ ...r }))).then(res, rej)
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
    // Media-ticket signatures are random-looking text; leave them out of the
    // "never mentions the draft id" check.
    expect(JSON.stringify(dto).replace(/\?st=[^"]*/g, '')).not.toContain('d1')
    expect(dto.stream_url).toMatch(/^\/api\/help-videos\/aaaa\/stream\?st=\d+\.U1\.p\./)
    expect('draft_stream_url' in dto).toBe(false)
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
    expect(dto.draft_stream_url).toMatch(/\/stream\?st=\d+\.U1\.d\.[^&]+&source=1$/)
    expect(dto.draft_captions_url).toMatch(/\/captions\.vtt\?st=\d+\.U1\.d\./)
  })

  it('marks the published version unplayable for a viewer while a blurred video waits for its render', async () => {
    const blurred = {
      v: 1,
      segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
      blurs: [{ id: 'b', start_ms: 0, end_ms: 2000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }]
    }
    const stale = {
      ...tables,
      nivaro_help_video_versions: [
        {
          ...versionRow,
          id: 'P1',
          video_id: 'AAAA',
          edits: JSON.stringify(blurred),
          edits_hash: 'new',
          rendered_hash: 'old'
        }
      ]
    }
    vi.mocked(db).mockImplementation(fakeDb(stale, []) as never)
    const viewer = await serializeVideo(video, { author: false, userId: 'U1', role: 'R1' })
    expect(viewer.published?.playable).toBe(false)
    const author = await serializeVideo(video, { author: true, userId: 'U1', role: 'R1' })
    expect(author.published?.playable).toBe(true)
    vi.mocked(db).mockImplementation(fakeDb(tables, []) as never)
    const current = await serializeVideo(video, { author: false, userId: 'U1', role: 'R1' })
    expect(current.published?.playable).toBe(true)
  })

  it('binds a session tag — never the raw session id — into media tickets', async () => {
    const SID = 'sessionIdABCDEFGH_123'
    const set = vi.fn(async () => 'OK')
    const req = {
      authMethod: 'session',
      session: { sessionId: SID },
      server: { redis: { set } }
    } as never
    const tag = sessionTag(req)
    expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(tag).not.toBe(SID)
    expect(set).toHaveBeenCalledWith(`hv:sidtag:${tag}`, SID, 'EX', 7 * 3600)
    // a second ticket in the same hour does not write again
    sessionTag(req)
    expect(set).toHaveBeenCalledTimes(1)
    vi.mocked(db).mockImplementation(fakeDb(tables, []) as never)
    const dto = await serializeVideo(video, {
      author: false,
      userId: 'U1',
      role: 'R1',
      sidTag: tag
    })
    expect(dto.stream_url).toContain(`.U1.p.${tag}.`)
    expect(dto.stream_url).not.toContain(SID)
    expect(JSON.stringify(dto)).not.toContain(SID)
  })

  it('binds no session for token, API-key and masquerade requests', () => {
    const set = vi.fn(async () => 'OK')
    for (const authMethod of ['token', 'api_key', 'masquerade']) {
      const req = {
        authMethod,
        session: { sessionId: 'sessionIdABCDEFGH_123' },
        server: { redis: { set } }
      }
      expect(sessionTag(req as never)).toBeNull()
    }
    expect(set).not.toHaveBeenCalled()
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

describe('saveDraftEdits', () => {
  const uuid = '0b6c5a7e-1d2f-4a3b-8c9d-0e1f2a3b4c5d'
  const user = { id: 'U1' } as never
  const base = emptyEdits(10_000)
  const h0 = hashEdits(base)
  const withPoster = (ms: number) => ({ ...base, poster_ms: ms })
  function setup(videoDraft: string | null) {
    const tables: Rows = {
      nivaro_help_videos: [
        { id: uuid, draft_version_id: videoDraft, published_version_id: videoDraft ? null : 'D1' }
      ],
      nivaro_help_video_versions: [
        { ...versionRow, id: 'D1', video_id: uuid, edits: JSON.stringify(base), edits_hash: h0 }
      ]
    }
    vi.mocked(db).mockImplementation(fakeDb(tables, []) as never)
    // What the route read at request start: the draft is D1.
    const video = { id: uuid, draft_version_id: 'D1', published_version_id: null } as never
    return { tables, video }
  }

  it('saves when the base hash is current', async () => {
    const { tables, video } = setup('D1')
    const dto = await saveDraftEdits(video, user, withPoster(500), h0)
    expect(dto.edits.poster_ms).toBe(500)
    expect(tables.nivaro_help_video_versions[0].edits_hash).toBe(dto.edits_hash)
  })

  it('refuses the second of two saves made from the same base hash', async () => {
    const { tables, video } = setup('D1')
    const results = await Promise.allSettled([
      saveDraftEdits(video, user, withPoster(500), h0),
      saveDraftEdits(video, user, withPoster(800), h0)
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(refused).toHaveLength(1)
    const winner = (ok[0] as PromiseFulfilledResult<{ edits_hash: string }>).value
    expect(refused[0].reason).toMatchObject({
      statusCode: 409,
      code: 'HELP_VIDEO_EDITS_CONFLICT',
      current_hash: winner.edits_hash
    })
    expect(tables.nivaro_help_video_versions[0].edits_hash).toBe(winner.edits_hash)
  })

  it('never rewrites a version that was published after the save read it', async () => {
    // The video row now says D1 is published and there is no draft.
    const { tables, video } = setup(null)
    await expect(saveDraftEdits(video, user, withPoster(500), h0)).rejects.toMatchObject({
      statusCode: 409,
      code: 'HELP_VIDEO_EDITS_CONFLICT',
      current_hash: null
    })
    expect(tables.nivaro_help_video_versions[0].edits_hash).toBe(h0)
    expect(tables.nivaro_help_video_versions[0].edits).toBe(JSON.stringify(base))
  })
})
