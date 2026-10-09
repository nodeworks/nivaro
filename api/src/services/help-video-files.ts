import type { Knex } from 'knex'
import { db } from '../db/index.js'

// Kept free of other service imports so the files, items and GraphQL
// readers can use it without loading the help-video feature.

const up = (v: unknown) => String(v ?? '').toUpperCase()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

// Recordings (raw, unblurred, uncut), renders, captions and posters are
// ordinary nivaro_files rows. They are served ONLY through the ticketed media
// routes, which re-check role, status and visibility; /api/files answers 404
// for them exactly as for an unknown file, to admins too.

/** Every column that names a help-video file. */
const HELP_VIDEO_FILE_COLUMNS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['nivaro_help_video_versions', ['source_file', 'rendered_file', 'captions_file', 'poster_file']],
  ['nivaro_help_videos', ['poster_file']],
  ['nivaro_help_video_uploads', ['file_id']]
]
// 4 columns x 400 ids stays under SQL Server's 2,100-parameter limit.
const FILE_ID_CHUNK = 400

/** Which of these file ids belong to a help video (returned upper-case).
 *  Only exact uuids are looked up: SQL Server truncates a longer string
 *  compared to a uniqueidentifier, so callers pass the file ROW's own id. */
export async function helpVideoFileIds(ids: unknown[]): Promise<Set<string>> {
  const exact = [...new Set(ids.filter(isUuid).map(up))]
  const found = new Set<string>()
  for (let i = 0; i < exact.length; i += FILE_ID_CHUNK) {
    const chunk = exact.slice(i, i + FILE_ID_CHUNK)
    const want = new Set(chunk)
    const hits = await Promise.all(
      HELP_VIDEO_FILE_COLUMNS.map(([table, cols]) =>
        db(table)
          .where((w) => {
            for (const c of cols) w.orWhereIn(c, chunk)
          })
          .select(...cols)
      )
    )
    hits.forEach((rows, n) => {
      const cols = HELP_VIDEO_FILE_COLUMNS[n][1]
      for (const r of rows as Array<Record<string, unknown>>) {
        for (const c of cols) if (r[c] && want.has(up(r[c]))) found.add(up(r[c]))
      }
    })
  }
  return found
}

/** Fails closed: anything that is not an exact uuid counts as a help-video
 *  file. Callers pass a file ROW's own id, which always is one. */
export async function isHelpVideoFile(id: unknown): Promise<boolean> {
  if (!isUuid(id)) return true
  return (await helpVideoFileIds([id])).size > 0
}

/** The files table under any name a query could resolve to it: either name,
 *  any case, with brackets, quotes, whitespace or a schema prefix
 *  ('dbo.NIVARO_FILES'). Fails closed for every spelling SQL Server accepts. */
export function isFilesCollection(collection: unknown): boolean {
  const bare = String(collection ?? '')
    .replace(/[[\]"`\s]/g, '')
    .split('.')
    .pop()
  return /^(nivaro|directus)_files$/i.test(bare ?? '')
}

/** Adds "and this file is not a help-video file" to a nivaro_files query.
 *  `idColumn` is the file id column as the outer query names it. */
export function whereNotHelpVideoFile(qb: Knex.QueryBuilder, idColumn: string): Knex.QueryBuilder {
  for (const [table, cols] of HELP_VIDEO_FILE_COLUMNS) {
    qb.whereNotExists(function () {
      this.select(db.raw('1'))
        .from(table)
        .where((w) => {
          for (const c of cols) w.orWhere(`${table}.${c}`, db.ref(idColumn))
        })
    })
  }
  return qb
}
