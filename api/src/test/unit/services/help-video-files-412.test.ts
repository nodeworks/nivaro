import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1560 / #1562: once migration 412 ran, the files guard also hides thumbnail
// sheets (sprite_file on versions and uploads) and clips (the clips table).
// The sibling help-video-files.test.ts covers a database behind 412.

const SPRITE = '11111111-1111-4111-8111-111111111111'
const UPLOAD_SPRITE = '22222222-2222-4222-8222-222222222222'
const CLIP = '33333333-3333-4333-8333-333333333333'
const PLAIN = '44444444-4444-4444-8444-444444444444'

const fx = vi.hoisted(() => ({
  queries: [] as Array<{ table: string; sql: string; bindings: unknown[] }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  migrated: true
}))

vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => fx.migrated }))
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
        return Promise.resolve(fx.tables[table] ?? []).then(res, rej)
      }
      return b
    },
    { raw: k.raw.bind(k), ref: k.ref.bind(k) }
  )
  return { db }
})

import {
  helpVideoFileColumnsReady,
  helpVideoFileIds,
  isHelpVideoFile,
  whereNotHelpVideoFile
} from '../../../services/help-video-files.js'

beforeEach(async () => {
  fx.queries = []
  fx.tables = {
    nivaro_help_video_versions: [{ sprite_file: SPRITE.toUpperCase() }],
    nivaro_help_videos: [],
    nivaro_help_video_uploads: [{ sprite_file: UPLOAD_SPRITE.toUpperCase() }],
    nivaro_help_video_clips: [{ file_id: CLIP.toUpperCase() }]
  }
  await helpVideoFileColumnsReady()
})

describe('with migration 412', () => {
  it('finds sprite sheets and clip files, through every table', async () => {
    const found = await helpVideoFileIds([SPRITE, UPLOAD_SPRITE, CLIP, PLAIN])
    expect([...found].sort()).toEqual(
      [SPRITE, UPLOAD_SPRITE, CLIP].map((x) => x.toUpperCase()).sort()
    )
    expect(await isHelpVideoFile(CLIP)).toBe(true)
    expect([...new Set(fx.queries.map((q) => q.table))].sort()).toEqual([
      'nivaro_help_video_clips',
      'nivaro_help_video_uploads',
      'nivaro_help_video_versions',
      'nivaro_help_videos'
    ])
    const versions = fx.queries.find((q) => q.table === 'nivaro_help_video_versions')
    expect(versions?.sql).toContain('[sprite_file] in (')
  })
  it('adds a fourth NOT EXISTS, against the clips table, to a files query', async () => {
    const { db } = await import('../../../db/index.js')
    const q = db('nivaro_files').select('id')
    whereNotHelpVideoFile(q, 'nivaro_files.id')
    const sql = q.toSQL().sql
    expect(sql.match(/not exists/g)).toHaveLength(4)
    expect(sql).toContain('[nivaro_help_video_clips].[file_id] = [nivaro_files].[id]')
    expect(sql).toContain('[nivaro_help_video_versions].[sprite_file] = [nivaro_files].[id]')
    expect(sql).toContain('[nivaro_help_video_uploads].[sprite_file] = [nivaro_files].[id]')
  })
})
