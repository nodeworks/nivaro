import { beforeEach, describe, expect, it, vi } from 'vitest'

// C1: which nivaro_files rows belong to a help video, and the SQL that keeps
// them out of the generic files listing. `db` is a real (connection-less)
// SQL Server query builder: every query's SQL is captured and answered from
// the fixture below instead of a database.

const SOURCE = '11111111-1111-4111-8111-111111111111'
const RENDER = '22222222-2222-4222-8222-222222222222'
const CAPTIONS = '66666666-6666-4666-8666-666666666666'
const POSTER = '33333333-3333-4333-8333-333333333333'
const VIDEO_POSTER = '77777777-7777-4777-8777-777777777777'
const UPLOAD = '88888888-8888-4888-8888-888888888888'
const PLAIN = '44444444-4444-4444-8444-444444444444'

const fx = vi.hoisted(() => ({
  queries: [] as Array<{ table: string; sql: string; bindings: unknown[] }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  answer: null as null | ((table: string, sql: string) => unknown)
}))

vi.mock('../../../db/index.js', async () => {
  const { default: knex } = await import('knex')
  const k = knex({ client: 'mssql' })
  const db = Object.assign(
    (table: string) => {
      const b = k(table)
      // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
      ;(b as { then: unknown }).then = (
        res: (v: unknown) => unknown,
        rej: (e: unknown) => unknown
      ) => {
        const { sql, bindings } = b.toSQL()
        fx.queries.push({ table, sql, bindings: [...bindings] })
        const out = fx.answer ? fx.answer(table, sql) : (fx.tables[table] ?? [])
        return Promise.resolve(out).then(res, rej)
      }
      return b
    },
    { raw: k.raw.bind(k), ref: k.ref.bind(k) }
  )
  return { db }
})
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))

import { helpVideoFileIds, isHelpVideoFile } from '../../../services/help-videos.js'

beforeEach(() => {
  fx.queries = []
  fx.answer = null
  fx.tables = {
    nivaro_help_video_versions: [
      {
        source_file: SOURCE.toUpperCase(),
        rendered_file: RENDER.toUpperCase(),
        captions_file: CAPTIONS.toUpperCase(),
        poster_file: POSTER.toUpperCase()
      }
    ],
    nivaro_help_videos: [{ poster_file: VIDEO_POSTER.toUpperCase() }],
    nivaro_help_video_uploads: [{ file_id: UPLOAD.toUpperCase() }]
  }
})

describe('helpVideoFileIds', () => {
  it('finds a file through every help-video column, whatever its case', async () => {
    const all = [SOURCE, RENDER, CAPTIONS, POSTER, VIDEO_POSTER, UPLOAD]
    const found = await helpVideoFileIds([...all, PLAIN])
    expect([...found].sort()).toEqual(all.map((x) => x.toUpperCase()).sort())
    expect(await isHelpVideoFile(SOURCE.toLowerCase())).toBe(true)
    expect(await isHelpVideoFile(PLAIN)).toBe(false)
  })

  it('asks every column of every table, with the ids bound', async () => {
    await helpVideoFileIds([SOURCE])
    const versions = fx.queries.find((q) => q.table === 'nivaro_help_video_versions')
    for (const c of ['source_file', 'rendered_file', 'captions_file', 'poster_file'])
      expect(versions?.sql).toContain(`[${c}] in (?)`)
    expect(fx.queries.map((q) => q.table).sort()).toEqual([
      'nivaro_help_video_uploads',
      'nivaro_help_video_versions',
      'nivaro_help_videos'
    ])
  })

  it('looks up only exact uuids (a longer string would be truncated by SQL Server)', async () => {
    expect((await helpVideoFileIds([`${SOURCE}xyz`, 'nope', null, 42])).size).toBe(0)
    expect(fx.queries).toHaveLength(0)
  })

  it('splits a long id list so no query passes the 2,100-parameter limit', async () => {
    const ids = Array.from(
      { length: 1000 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    )
    await helpVideoFileIds(ids)
    for (const q of fx.queries) expect(q.bindings.length).toBeLessThan(2100)
    expect(fx.queries.length).toBe(9) // 3 chunks x 3 tables
  })
})

describe('fails closed', () => {
  it('counts anything that is not an exact uuid as a help-video file', async () => {
    for (const bad of [`${PLAIN}xyz`, `{${PLAIN}}`, `${PLAIN} `, '', null, undefined, 42]) {
      expect(await isHelpVideoFile(bad), String(bad)).toBe(true)
    }
    expect(fx.queries).toHaveLength(0)
  })
  it('a failed lookup throws rather than answering "not a help-video file"', async () => {
    fx.answer = () => Promise.reject(new Error('db down'))
    await expect(isHelpVideoFile(PLAIN)).rejects.toThrow('db down')
  })
})

describe('whereNotHelpVideoFile on other readers', () => {
  it('adds the three NOT EXISTS checks against the column it is given', async () => {
    const { db } = await import('../../../db/index.js')
    const { whereNotHelpVideoFile, isFilesCollection } = await import(
      '../../../services/help-video-files.js'
    )
    const q = db('directus_files').select('id')
    whereNotHelpVideoFile(q, 'directus_files.id')
    const sql = q.toSQL().sql
    expect(sql.match(/not exists/g)).toHaveLength(3)
    expect(sql).toContain('[nivaro_help_video_uploads].[file_id] = [directus_files].[id]')
    expect(isFilesCollection('nivaro_files')).toBe(true)
    expect(isFilesCollection('directus_files')).toBe(true)
    expect(isFilesCollection('workflows_files')).toBe(false)
  })
})

describe('listFiles', () => {
  it('excludes help-video files from both the page and the total', async () => {
    fx.answer = (_t, sql) => (sql.includes('count(') ? [{ count: 0 }] : [])
    const { listFiles } = await import('../../../services/files.js')
    await listFiles({ search: 'rec', limit: 10 })
    const files = fx.queries.filter((q) => q.table.startsWith('nivaro_files'))
    expect(files).toHaveLength(2)
    for (const q of files) {
      const col = q.sql.includes('[f].') ? '[f].[id]' : '[nivaro_files].[id]'
      for (const c of ['source_file', 'rendered_file', 'captions_file', 'poster_file'])
        expect(q.sql).toContain(`[nivaro_help_video_versions].[${c}] = ${col}`)
      expect(q.sql).toContain(`[nivaro_help_videos].[poster_file] = ${col}`)
      expect(q.sql).toContain(`[nivaro_help_video_uploads].[file_id] = ${col}`)
      expect(q.sql.match(/not exists/g)).toHaveLength(3)
    }
  })
})
