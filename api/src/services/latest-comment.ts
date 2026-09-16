import { db } from '../db/index.js'
import { relatedNoteRegistry } from '../extensions/related-notes.js'

/**
 * The newest thing a PERSON wrote about a record — what the Notes thread
 * shows as a people comment: a `nivaro_comments` row on the record, or a row
 * of a child note table (a related collection named notes/comments carrying
 * a text column — the same convention the thread uses). Machine markers
 * (import stamps, sync tags an extension registered) never count.
 *
 * Used by the workflow / IR transition emails, which end with this so the
 * reader gets the latest human context without opening the record. Every
 * read is best-effort: a missing table or column yields null, never a throw.
 */
export interface LatestComment {
  text: string
  author_name: string | null
  author_email: string | null
  at: string | null
  source: 'comment' | 'note'
}

const MAX_CHARS = 600

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isHuman(text: string): boolean {
  const t = text.trim()
  if (t === '') return false
  if (/^import:/i.test(t)) return false
  return !relatedNoteRegistry.isMachineComment(t)
}

function clip(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS).trimEnd()}…` : text
}

type Candidate = LatestComment & { ts: number; userId: string | null }

export async function latestPeopleComment(
  collection: string,
  item: string | number
): Promise<LatestComment | null> {
  const candidates: Candidate[] = []

  // 1. nivaro_comments on the record itself.
  try {
    const rows = (await db('nivaro_comments as c')
      .leftJoin('nivaro_users as u', 'c.user', 'u.id')
      .where({ 'c.collection': collection, 'c.item': String(item) })
      .orderBy('c.created_at', 'desc')
      .limit(10)
      .select(
        'c.text',
        'c.created_at',
        'c.user',
        'u.first_name',
        'u.last_name',
        'u.email'
      )) as Array<Record<string, unknown>>
    for (const r of rows) {
      const text = stripHtmlToText(String(r.text ?? ''))
      if (!isHuman(text)) continue
      candidates.push({
        text: clip(text),
        author_name:
          [r.first_name, r.last_name].filter(Boolean).join(' ') || (r.email as string) || null,
        author_email: (r.email as string) ?? null,
        at: r.created_at ? new Date(r.created_at as string).toISOString() : null,
        source: 'comment',
        ts: r.created_at ? new Date(r.created_at as string).getTime() : 0,
        userId: (r.user as string) ?? null
      })
      break
    }
  } catch {
    /* best effort */
  }

  // 2. Child note tables (notes/comments collections hanging off the record).
  try {
    const rels = (await db('nivaro_relations')
      .where({ one_collection: collection })
      .whereNotNull('many_collection')
      .select('many_collection', 'many_field')) as Array<{
      many_collection: string
      many_field: string
    }>
    const noteRels = rels.filter(
      (r) => /(^|_)(notes?|comments?)$/i.test(r.many_collection) && !!r.many_field
    )
    for (const rel of noteRels) {
      try {
        const cols = (await db('information_schema.columns')
          .where({ table_name: rel.many_collection })
          .select('column_name')) as Array<{ column_name: string }>
        const names = new Set(cols.map((c) => String(c.column_name).toLowerCase()))
        const textCol = ['text', 'note', 'notes', 'comment', 'body', 'message'].find((c) =>
          names.has(c)
        )
        if (!textCol) continue
        const userCol = ['creator', 'user_created', 'created_by', 'user'].find((c) => names.has(c))
        const dateCol = ['created', 'date_created', 'created_at', 'timestamp'].find((c) =>
          names.has(c)
        )
        const rows = (await db(rel.many_collection)
          .where(rel.many_field, item)
          .orderBy(dateCol ?? 'id', 'desc')
          .limit(10)
          .select('*')) as Array<Record<string, unknown>>
        for (const r of rows) {
          const text = stripHtmlToText(String(r[textCol] ?? ''))
          if (!isHuman(text)) continue
          const rawAt = dateCol ? r[dateCol] : null
          const at = rawAt ? new Date(rawAt as string) : null
          candidates.push({
            text: clip(text),
            author_name: null,
            author_email: null,
            at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
            source: 'note',
            ts: at && !Number.isNaN(at.getTime()) ? at.getTime() : 0,
            userId: userCol ? ((r[userCol] as string) ?? null) : null
          })
          break
        }
      } catch {
        /* a missing column on one note table must not hide the others */
      }
    }
  } catch {
    /* best effort */
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.ts - a.ts)
  const best = candidates[0]
  if (!best.author_name && best.userId) {
    try {
      const u = (await db('nivaro_users')
        .where({ id: best.userId })
        .first('first_name', 'last_name', 'email')) as
        | { first_name: string | null; last_name: string | null; email: string | null }
        | undefined
      if (u) {
        best.author_name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
        best.author_email = u.email
      }
    } catch {
      /* unnamed author is still a comment worth showing */
    }
  }
  const { ts: _ts, userId: _u, ...out } = best
  return out
}
