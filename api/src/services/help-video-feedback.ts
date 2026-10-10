import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { authorRoleIds, isUuid, type VideoRow, viewerMaySee } from './help-videos.js'
import { getApp } from './io-holder.js'

// "Was this helpful?" and questions at a moment (#1505). One vote per person
// per video (changeable); a question captures the edited time it was asked
// at, lands in the author's inbox and stays on the video as a thread the
// author answers from the editor's Stats tab. Question and answer text is
// what people wrote: data, never instructions — it is stored and shown as is.

export const QUESTION_MAX = 1000
export const ANSWER_MAX = 2000
/** Where the "other authors" fallback stops (the video's creator is gone). */
const AUTHOR_NOTIFY_CAP = 50

function fail(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}
const low = (v: unknown) => String(v ?? '').toLowerCase()
const up = (v: unknown) => String(v ?? '').toUpperCase()

export interface QuestionDto {
  id: string
  video_id: string
  version_id: string | null
  /** Where it was asked, in the finished video (edited time). */
  at_ms: number
  text: string
  /** Asked by this person. */
  mine: boolean
  /** Authors only: who asked. */
  asked_by_name?: string | null
  answer: string | null
  answered_at: string | null
  answered_by_name: string | null
  created_at: string
}

export interface RatingSummary {
  up: number
  down: number
  /** up / (up + down), 3 places; 0 with no votes. */
  helpful_rate: number
}

/** `true` / `false` (also 'true' / 'false', 1 / 0); anything else is refused. */
export function parseHelpful(raw: unknown): boolean {
  if (raw === true || raw === 1 || raw === 'true' || raw === '1') return true
  if (raw === false || raw === 0 || raw === 'false' || raw === '0') return false
  throw fail(400, 'HELP_VIDEO_RATING_INVALID', 'helpful must be true or false')
}

/** Trims, drops control characters (newlines stay) and refuses an empty or
 *  over-long text. */
export function cleanText(raw: unknown, max: number, what: string): string {
  const s = typeof raw === 'string' ? raw : ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters except \n and \t
  const text = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if (!text) throw fail(400, 'HELP_VIDEO_QUESTION_INVALID', `Write ${what} first`)
  if (text.length > max) {
    throw fail(
      400,
      'HELP_VIDEO_QUESTION_INVALID',
      `${what[0].toUpperCase()}${what.slice(1)} can be at most ${max} characters`
    )
  }
  return text
}

/** A moment inside the video: a whole number of milliseconds from 0 to the
 *  video's length (an unknown length allows anything up to 31 minutes). */
export function clampAtMs(raw: unknown, durationMs: unknown): number {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n) || n < 0) return 0
  const d = Number(durationMs)
  const max = Number.isFinite(d) && d > 0 ? d : 31 * 60_000
  return Math.min(n, max)
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** What the author's inbox says. The question is quoted as data. */
export function questionNotice(
  title: string,
  text: string,
  atMs: number
): { subject: string; message: string; why: string } {
  const t = (title || 'Untitled video').slice(0, 200)
  return {
    subject: `Question about ${t} at ${fmt(atMs)}`.slice(0, 250),
    message: `Someone asked at ${fmt(atMs)}:\n\n${text}\n\nAnswer it from the video's Stats tab; the answer can also become a chapter or caption at that moment.`,
    why: 'You are an author of this video.'
  }
}

/** What the person who asked hears back. */
export function answerNotice(
  title: string,
  atMs: number,
  answer: string
): { subject: string; message: string; why: string } {
  const t = (title || 'Untitled video').slice(0, 200)
  return {
    subject: `Your question about ${t} was answered`.slice(0, 250),
    message: `About ${fmt(atMs)}:\n\n${answer}`,
    why: 'You asked a question on this video.'
  }
}

function userName(u: { first_name?: unknown; last_name?: unknown } | null | undefined) {
  if (!u) return null
  return `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || null
}

async function namesFor(ids: unknown[]): Promise<Map<string, string | null>> {
  const want = [...new Set(ids.filter(isUuid).map(up))]
  const out = new Map<string, string | null>()
  if (!want.length) return out
  const rows = await db('nivaro_users').whereIn('id', want).select('id', 'first_name', 'last_name')
  for (const r of rows as Array<{ id: unknown; first_name: unknown; last_name: unknown }>) {
    out.set(up(r.id), userName(r))
  }
  return out
}

function serializeQuestion(
  r: Record<string, unknown>,
  ctx: { userId: string; author: boolean },
  names: Map<string, string | null>
): QuestionDto {
  const dto: QuestionDto = {
    id: low(r.id),
    video_id: low(r.video_id),
    version_id: r.version_id ? low(r.version_id) : null,
    at_ms: Number(r.at_ms ?? 0),
    text: String(r.text ?? ''),
    mine: up(r.user) === up(ctx.userId),
    answer: r.answer == null ? null : String(r.answer),
    answered_at: r.answered_at ? new Date(r.answered_at as string).toISOString() : null,
    answered_by_name: r.answered_by ? (names.get(up(r.answered_by)) ?? null) : null,
    created_at: new Date(r.created_at as string).toISOString()
  }
  if (ctx.author) dto.asked_by_name = names.get(up(r.user)) ?? null
  return dto
}

/** This person's vote on the video, or null. */
export async function myRating(video: VideoRow, userId: string): Promise<boolean | null> {
  const row = await db('nivaro_help_video_ratings')
    .where({ video_id: video.id, user: userId })
    .first('helpful')
  if (!row) return null
  return row.helpful === true || row.helpful === 1
}

/** One vote per person per video; voting again changes it. */
export async function setRating(
  user: User,
  video: VideoRow,
  rawHelpful: unknown
): Promise<{ helpful: boolean }> {
  const helpful = parseHelpful(rawHelpful)
  const now = new Date()
  const where = { video_id: video.id, user: user.id }
  const updated = await db('nivaro_help_video_ratings')
    .where(where)
    .update({ helpful, version_id: video.published_version_id ?? null, updated_at: now })
  if (!Number(updated)) {
    try {
      await db('nivaro_help_video_ratings').insert({
        ...where,
        version_id: video.published_version_id ?? null,
        helpful,
        created_at: now,
        updated_at: now
      })
    } catch (err) {
      // Two votes at once: the second insert hits the unique key; make it an update.
      const n = (err as { number?: unknown })?.number
      if (n !== 2627 && n !== 2601) throw err
      await db('nivaro_help_video_ratings').where(where).update({ helpful, updated_at: now })
    }
  }
  return { helpful }
}

export function summarizeRatings(rows: Array<{ helpful: unknown }>): RatingSummary {
  let upVotes = 0
  let down = 0
  for (const r of rows) {
    if (r.helpful === true || r.helpful === 1) upVotes++
    else down++
  }
  const total = upVotes + down
  return {
    up: upVotes,
    down,
    helpful_rate: total ? Math.round((upVotes / total) * 1000) / 1000 : 0
  }
}

export async function ratingSummary(video: VideoRow): Promise<RatingSummary> {
  const rows = await db('nivaro_help_video_ratings').where({ video_id: video.id }).select('helpful')
  return summarizeRatings(rows)
}

/** Authors see every question; everyone else sees only their own. */
export async function listQuestions(
  video: VideoRow,
  ctx: { userId: string; author: boolean }
): Promise<QuestionDto[]> {
  const q = db('nivaro_help_video_questions').where({ video_id: video.id })
  if (!ctx.author) q.where({ user: ctx.userId })
  const rows = (await q.orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]
  const names = await namesFor(rows.flatMap((r) => [r.user, r.answered_by]))
  return rows.map((r) => serializeQuestion(r, ctx, names))
}

export async function askQuestion(
  user: User,
  video: VideoRow,
  input: { at_ms?: unknown; text?: unknown }
): Promise<QuestionDto> {
  const text = cleanText(input.text, QUESTION_MAX, 'your question')
  const at_ms = clampAtMs(input.at_ms, video.duration_ms)
  const now = new Date()
  const row = {
    id: randomUUID(),
    video_id: video.id,
    version_id: video.published_version_id ?? null,
    user: user.id,
    at_ms,
    text,
    answer: null,
    answered_by: null,
    answered_at: null,
    created_at: now
  }
  await db('nivaro_help_video_questions').insert(row)
  void notifyAuthorsOfQuestionSafely(video, text, at_ms, user.id)
  return serializeQuestion(row, { userId: user.id, author: false }, new Map())
}

export async function answerQuestion(
  user: User,
  video: VideoRow,
  questionId: string,
  input: { answer?: unknown }
): Promise<QuestionDto> {
  if (!isUuid(questionId)) throw fail(404, 'HELP_VIDEO_QUESTION_NOT_FOUND', 'Question not found')
  const answer = cleanText(input.answer, ANSWER_MAX, 'an answer')
  const row = (await db('nivaro_help_video_questions')
    .where({ id: questionId, video_id: video.id })
    .first()) as Record<string, unknown> | undefined
  if (!row) throw fail(404, 'HELP_VIDEO_QUESTION_NOT_FOUND', 'Question not found')
  const now = new Date()
  await db('nivaro_help_video_questions')
    .where({ id: questionId, video_id: video.id })
    .update({ answer, answered_by: user.id, answered_at: now })
  await logActivity({
    action: 'help-video-question-answered',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: low(video.id),
    comment: `at ${fmt(Number(row.at_ms ?? 0))}`
  })
  void notifyAskerSafely(video, row, answer)
  const fresh: Record<string, unknown> = { ...row, answer, answered_by: user.id, answered_at: now }
  const names = await namesFor([row.user, user.id])
  return serializeQuestion(fresh, { userId: user.id, author: true }, names)
}

async function activeUser(id: unknown): Promise<{ id: string; role: string | null } | null> {
  if (!isUuid(id)) return null
  const u = await db('nivaro_users')
    .where({ id, status: 'active' })
    .where((w) => w.where('is_redacted', 0).orWhereNull('is_redacted'))
    .first('id', 'role')
  return u ? { id: String(u.id), role: u.role ? String(u.role) : null } : null
}

/** Who hears about a new question: the video's creator while that person is
 *  active; otherwise the other authors (people in the author roles and
 *  administrator roles), at most AUTHOR_NOTIFY_CAP of them. The asker never
 *  hears their own question. */
export async function questionRecipients(
  video: Record<string, unknown>,
  askerId: string
): Promise<string[]> {
  const creator = await activeUser(video.created_by)
  if (creator && up(creator.id) !== up(askerId)) return [creator.id]
  const adminRoles = (await db('nivaro_roles')
    .where({ admin_access: true })
    .select('id')) as Array<{
    id: unknown
  }>
  const roles = [...new Set([...(await authorRoleIds()), ...adminRoles.map((r) => up(r.id))])]
  if (!roles.length) return []
  const found = (await db('nivaro_users')
    .whereIn('role', roles)
    .where({ status: 'active' })
    .where((w) => w.where('is_redacted', 0).orWhereNull('is_redacted'))
    .whereNull('account_kind')
    .orderBy('id')
    .limit(AUTHOR_NOTIFY_CAP)
    .select('id')) as Array<{ id: unknown }>
  return found.map((u) => String(u.id)).filter((id) => up(id) !== up(askerId))
}

export async function notifyAuthorsOfQuestion(
  video: VideoRow,
  text: string,
  atMs: number,
  askerId: string
): Promise<number> {
  const app = getApp()
  if (!app) return 0
  const to = await questionRecipients(video, askerId)
  if (!to.length) return 0
  const { notifyUser } = await import('./notification-channels.js')
  const title = String(video.title ?? '')
  const notice = questionNotice(title, text, atMs)
  const id = low(video.id)
  let delivered = 0
  for (const userId of to) {
    try {
      await notifyUser(app, userId, {
        subject: notice.subject,
        message: notice.message,
        category: 'system',
        why: notice.why,
        always_inbox: true,
        // Opens the editor on this video (same-origin path).
        target: { kind: 'external', url: `/help-videos?edit=${id}` },
        source: { kind: 'help-video', label: (title || 'Untitled video').slice(0, 250), id }
      })
      delivered++
    } catch (err) {
      app.log?.warn?.({ err, videoId: id }, 'help video question notify failed')
    }
  }
  return delivered
}

async function notifyAuthorsOfQuestionSafely(
  video: VideoRow,
  text: string,
  atMs: number,
  askerId: string
): Promise<void> {
  try {
    await notifyAuthorsOfQuestion(video, text, atMs, askerId)
  } catch (err) {
    const app: any = getApp()
    app?.log?.warn?.({ err, videoId: low(video.id) }, 'help video question notify failed')
  }
}

async function notifyAskerSafely(
  video: VideoRow,
  question: Record<string, unknown>,
  answer: string
): Promise<void> {
  try {
    const app = getApp()
    if (!app) return
    const asker = await activeUser(question.user)
    if (!asker) return
    // The answer names the video and repeats the author's words: it goes only
    // to someone who may still watch the video today (visibility may have
    // narrowed, or their role changed, since they asked).
    if (!viewerMaySee(video, asker.role, false)) return
    const { notifyUser } = await import('./notification-channels.js')
    const title = String(video.title ?? '')
    const id = low(video.id)
    const notice = answerNotice(title, Number(question.at_ms ?? 0), answer)
    await notifyUser(app, asker.id, {
      subject: notice.subject,
      message: notice.message,
      category: 'system',
      why: notice.why,
      always_inbox: true,
      target: {
        kind: 'external',
        url: `/help-videos?watch=${id}&t=${Math.floor(Number(question.at_ms ?? 0) / 1000)}`
      },
      source: { kind: 'help-video', label: (title || 'Untitled video').slice(0, 250), id }
    })
  } catch (err) {
    const app: any = getApp()
    app?.log?.warn?.({ err, videoId: low(video.id) }, 'help video answer notify failed')
  }
}
