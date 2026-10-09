import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/items.js', () => ({ readOne: vi.fn() }))
vi.mock('../../../services/branch-instances.js', () => ({ findRecordInstance: vi.fn() }))

import { db } from '../../../db/index.js'
import { findRecordInstance } from '../../../services/branch-instances.js'
import {
  listVideos,
  rankForContext,
  registerPage,
  videosForContext
} from '../../../services/help-videos.js'
import { readOne } from '../../../services/items.js'

const rows = [
  { video_id: 'A', kind: 'collection', key: 'workflows', state_key: null },
  { video_id: 'B', kind: 'collection', key: 'workflows', state_key: 'started' },
  { video_id: 'C', kind: 'collection', key: 'workflows', state_key: 'completed' },
  { video_id: 'D', kind: 'page', key: 'budget-spend', state_key: null },
  { video_id: 'A', kind: 'page', key: 'budget-spend', state_key: null }
]

describe('rankForContext', () => {
  it('puts the state match first, then the collection, and drops other states', () => {
    expect(rankForContext(rows, { collection: 'workflows', state: 'started' })).toEqual(['B', 'A'])
  })
  it('without a known state shows only state-free collection videos', () => {
    expect(rankForContext(rows, { collection: 'workflows', state: null })).toEqual(['A'])
  })
  it('matches page keys and does not repeat a video', () => {
    expect(rankForContext(rows, { page: 'budget-spend' })).toEqual(['D', 'A'])
  })
  it('combines collection and page asks', () => {
    expect(
      rankForContext(rows, { collection: 'workflows', state: 'completed', page: 'budget-spend' })
    ).toEqual(['C', 'A', 'D'])
  })
})

// A thenable query builder: every chained call returns itself, awaiting yields
// the table's rows. Enough for the lookup's reads.
function chain(result: unknown[]) {
  const q: Record<string, unknown> = {}
  q.first = vi.fn(() => Promise.resolve(result[0]))
  q.update = vi.fn(() => Promise.resolve(1))
  q.insert = vi.fn(() => Promise.resolve([]))
  q.whereNotNull = vi.fn(() => q)
  q.orderBy = vi.fn(() => q)
  q.clone = vi.fn(() => q)
  for (const m of ['select', 'where', 'whereIn', 'orWhere']) {
    q[m] = vi.fn((arg?: unknown) => {
      if (typeof arg === 'function') (arg as (w: unknown) => void)(q)
      return q
    })
  }
  // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaitable
  q.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
  return q
}

describe('videosForContext', () => {
  const req = {
    user: { id: 'U1', role: null },
    isAdmin: false,
    workspaceId: null
  } as never
  const asked: string[] = []

  beforeEach(() => {
    asked.length = 0
    vi.mocked(readOne).mockReset()
    vi.mocked(findRecordInstance).mockReset()
    vi.mocked(db).mockReset()
    vi.mocked(db).mockImplementation(((table: string) => {
      asked.push(table)
      if (table === 'nivaro_help_video_contexts') return chain(rows)
      if (table === 'nivaro_workflow_states') return chain([{ key: 'started' }])
      return chain([])
    }) as never)
  })

  it('reads the record as the caller and never resolves state for one they cannot see', async () => {
    vi.mocked(readOne).mockResolvedValue(null as never)
    const out = await videosForContext(req, { collection: 'workflows', item: '5' })
    expect(readOne).toHaveBeenCalledWith(expect.anything(), 'workflows', '5', undefined, ['id'])
    expect(findRecordInstance).not.toHaveBeenCalled()
    expect(asked).not.toContain('nivaro_workflow_states')
    expect(out.state).toBeNull()
  })

  it('a record read that throws is treated as unreadable', async () => {
    vi.mocked(readOne).mockRejectedValue(new Error('forbidden'))
    const out = await videosForContext(req, { collection: 'workflows', item: '5' })
    expect(findRecordInstance).not.toHaveBeenCalled()
    expect(out.state).toBeNull()
  })

  it('looks the pipeline up by the record id when the caller named it by an alias', async () => {
    vi.mocked(readOne).mockResolvedValue({ id: 42 } as never)
    vi.mocked(findRecordInstance).mockResolvedValue({ current_state: 'S1' } as never)
    const out = await videosForContext(req, { collection: 'workflows', item: 'PO-0042' })
    expect(readOne).toHaveBeenCalledWith(expect.anything(), 'workflows', 'PO-0042', undefined, [
      'id'
    ])
    expect(findRecordInstance).toHaveBeenCalledWith('workflows', '42')
    expect(out.state).toBe('started')
  })

  it('resolves the pipeline state once the record is readable', async () => {
    vi.mocked(readOne).mockResolvedValue({ id: 5 } as never)
    vi.mocked(findRecordInstance).mockResolvedValue({ current_state: 'S1' } as never)
    const out = await videosForContext(req, { collection: 'workflows', item: '5' })
    expect(out.state).toBe('started')
  })
})

const pub = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Video ${id}`,
  status: 'published',
  visibility: JSON.stringify({ mode: 'everyone', role_ids: [] }),
  category: null,
  updated_at: new Date('2026-10-08T00:00:00Z'),
  ...extra
})
const rolesOnly = (...ids: string[]) => JSON.stringify({ mode: 'roles', role_ids: ids })

describe('videosForContext visibility', () => {
  const req = { user: { id: 'U1', role: 'R1' }, isAdmin: false, workspaceId: null } as never
  it('drops draft, archived and role-invisible videos', async () => {
    const ctxRows = ['A', 'B', 'C', 'D'].map((v) => ({
      video_id: v,
      kind: 'page',
      key: 'p',
      state_key: null
    }))
    const videos = [
      pub('A'),
      pub('B', { status: 'draft' }),
      pub('C', { status: 'archived' }),
      pub('D', { visibility: rolesOnly('R9') })
    ]
    vi.mocked(db).mockReset()
    vi.mocked(db).mockImplementation(((t: string) => {
      if (t === 'nivaro_help_video_contexts') return chain(ctxRows)
      if (t === 'nivaro_help_videos') return chain(videos)
      return chain([])
    }) as never)
    const out = await videosForContext(req, { page: 'p' })
    expect(out.data.map((d) => d.title)).toEqual(['Video A'])
  })

  it('serializes with the caller’s real author flag (playable for authors, not viewers)', async () => {
    // A blurred published version whose render is stale: a viewer would get
    // "still being prepared", an author plays the original.
    const version = {
      id: 'P1',
      video_id: 'A',
      version: 1,
      source_file: 'F',
      source_duration_ms: 10_000,
      edits: JSON.stringify({
        v: 1,
        segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
        blurs: [{ id: 'b', start_ms: 0, end_ms: 2000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }]
      }),
      edits_hash: 'new',
      rendered_file: 'R',
      rendered_hash: 'old',
      render_status: 'ready',
      created_at: new Date('2026-10-08T00:00:00Z')
    }
    vi.mocked(db).mockReset()
    vi.mocked(db).mockImplementation(((t: string) => {
      if (t === 'nivaro_help_video_contexts')
        return chain([{ video_id: 'A', kind: 'page', key: 'p', state_key: null }])
      if (t === 'nivaro_help_videos') return chain([pub('A', { published_version_id: 'P1' })])
      if (t === 'nivaro_help_video_versions') return chain([version])
      return chain([])
    }) as never)
    const viewer = await videosForContext(req, { page: 'p' })
    expect(viewer.data[0].published?.playable).toBe(false)
    const asAuthor = { user: { id: 'U1', role: 'R1' }, isAdmin: true, workspaceId: null } as never
    const author = await videosForContext(asAuthor, { page: 'p' })
    expect(author.can_author).toBe(true)
    expect(author.data[0].published?.playable).toBe(true)
  })
})

describe('listVideos', () => {
  const nonAuthor = { user: { id: 'U1', role: 'R1' }, isAdmin: false } as never
  const calls: Array<{ method: string; args: unknown[] }> = []
  function setup(videos: Record<string, unknown>[], cats: Record<string, unknown>[] = []) {
    calls.length = 0
    let n = 0
    vi.mocked(db).mockReset()
    vi.mocked(db).mockImplementation(((t: string) => {
      if (t !== 'nivaro_help_videos') return chain([])
      n += 1
      const q = chain(n === 1 ? videos : cats)
      q.orderBy = vi.fn((...a: unknown[]) => {
        calls.push({ method: 'orderBy', args: a })
        return q
      })
      const orig = q.where as (...a: unknown[]) => unknown
      q.where = vi.fn((...a: unknown[]) => {
        calls.push({ method: 'where', args: a })
        return orig(...a)
      })
      return q
    }) as never)
  }

  it('forces published for non-authors even when asked for drafts', async () => {
    setup([pub('A')])
    await listVideos(nonAuthor, { status: 'draft' })
    expect(calls[0].args[0]).toEqual({ status: 'published' })
  })

  it('lets an admin ask for drafts', async () => {
    setup([])
    await listVideos({ user: { id: 'U1', role: null }, isAdmin: true } as never, {
      status: 'draft'
    })
    expect(calls[0].args[0]).toEqual({ status: 'draft' })
  })

  it('drops videos the viewer may not see and counts only the visible', async () => {
    setup([
      pub('A'),
      pub('B', { visibility: rolesOnly('R9') }),
      pub('C', { visibility: rolesOnly('r1') })
    ])
    const out = await listVideos(nonAuthor, {})
    expect(out.total).toBe(2)
    expect(out.data.map((d) => d.title)).toEqual(['Video A', 'Video C'])
  })

  it('builds categories only from videos the viewer may see', async () => {
    setup(
      [],
      [
        pub('A', { category: 'Basics' }),
        pub('B', { category: 'Finance secrets', visibility: rolesOnly('R9') })
      ]
    )
    const out = await listVideos(nonAuthor, {})
    expect(out.categories).toEqual(['Basics'])
  })

  it('orders by title then id, so equal titles page stably', async () => {
    setup([pub('A')])
    await listVideos(nonAuthor, { page: 2, limit: 1 })
    const order = calls.find((c) => c.method === 'orderBy')
    expect(order?.args[0]).toEqual([
      { column: 'title', order: 'asc' },
      { column: 'id', order: 'asc' }
    ])
  })

  it('escapes %, _ and [ in the search term', async () => {
    setup([])
    await listVideos(nonAuthor, { search: '50%_[x' })
    const like = calls.find((c) => c.args[1] === 'like')
    expect(like?.args[2]).toBe('%50[%][_][[]x%')
  })
})

describe('registerPage', () => {
  it('rejects invalid keys with 400 before touching the db', async () => {
    vi.mocked(db).mockReset()
    await expect(registerPage('bad key!', 'x', null)).rejects.toMatchObject({ statusCode: 400 })
    expect(db).not.toHaveBeenCalled()
  })

  it('writes once per key inside the throttle window', async () => {
    vi.mocked(db).mockReset()
    vi.mocked(db).mockImplementation((() => chain([])) as never)
    await registerPage('throttle-key', 'T', 'admin')
    await registerPage('throttle-key', 'T2', 'admin')
    expect(db).toHaveBeenCalledTimes(1)
  })
})
