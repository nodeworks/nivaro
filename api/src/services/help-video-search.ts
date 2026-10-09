import { db } from '../db/index.js'
import type { User } from '../types.js'
import { selectInChunks } from './db-batch.js'
import type { VideoEdits } from './help-video-edits.js'
import {
  type HelpVideoHit,
  rankHelpVideoHits,
  type SearchableVideo,
  searchTerms
} from './help-video-search-rank.js'
import { isAuthor, viewerMaySee } from './help-videos.js'
import { isAdminRole } from './user-scopes.js'

// Ask AI's search_help_videos (#1503): the videos THIS asker may watch, by
// the library's own rule — published only (never a draft, even for an
// author), and `viewerMaySee` with the asker's author flag (authors see every
// published video, everyone else by the video's role visibility). Chapters
// and captions come from the PUBLISHED version's edits only.

const ESC = (s: string) => s.replace(/[%_[]/g, (c) => `[${c}]`)

export async function searchHelpVideos(
  user: User,
  query: string,
  limit = 5
): Promise<{ results: HelpVideoHit[]; searched: number }> {
  const terms = searchTerms(query)
  if (!terms.length) return { results: [], searched: 0 }
  const author = await isAuthor(user, await isAdminRole(user.role ?? null))
  // A cheap first cut in SQL: any searched word in the title, description or
  // published edits (chapters and captions live in that JSON). The ranking
  // below decides what really matches.
  const rows = (await db('nivaro_help_videos as v')
    .join('nivaro_help_video_versions as p', 'p.id', 'v.published_version_id')
    .where('v.status', 'published')
    .where((w) => {
      for (const t of terms) {
        const like = `%${ESC(t)}%`
        w.orWhere('v.title', 'like', like)
          .orWhere('v.description', 'like', like)
          .orWhere('p.edits', 'like', like)
      }
    })
    .select(
      'v.id',
      'v.title',
      'v.description',
      'v.category',
      'v.status',
      'v.visibility',
      'v.published_version_id'
    )) as Array<Record<string, unknown>>
  const visible = rows.filter((v) =>
    viewerMaySee({ status: String(v.status), visibility: v.visibility }, user.role ?? null, author)
  )
  if (!visible.length) return { results: [], searched: 0 }
  const versions = await selectInChunks(
    visible.map((v) => String(v.published_version_id)),
    1000,
    (chunk) =>
      db('nivaro_help_video_versions').whereIn('id', chunk).select('id', 'edits') as Promise<
        Array<{ id: string; edits: string | null }>
      >
  )
  const editsBy = new Map(
    versions.map((r) => {
      let e: VideoEdits | null = null
      try {
        e = r.edits ? (JSON.parse(r.edits) as VideoEdits) : null
      } catch {
        e = null
      }
      return [String(r.id).toUpperCase(), e]
    })
  )
  const searchable: SearchableVideo[] = visible.map((v) => ({
    id: String(v.id),
    title: String(v.title ?? ''),
    description: (v.description as string | null) ?? null,
    category: (v.category as string | null) ?? null,
    edits: editsBy.get(String(v.published_version_id).toUpperCase()) ?? null
  }))
  return { results: rankHelpVideoHits(searchable, query, limit), searched: searchable.length }
}
