import { db } from '../db/index.js'
import { channels, parseRoom } from './chat.js'
import { botUserId } from './chat-bot.js'

/**
 * Chat analytics (#955) — how much the team uses chat and how quickly people
 * answer each other. Counts and timings only: no message text leaves this
 * module, and DM rooms are never named (their totals are aggregated).
 */

export interface ChatAnalyticsRow {
  id: number
  room: string
  sender: string | null
  date_created: Date | string
  has_attachments: boolean
}

export interface ChatAnalytics {
  window: { days: number; from: string; to: string; time_zone: string; truncated: boolean }
  totals: {
    messages: number
    senders: number
    active_rooms: number
    attachments: number
    reactions: number
  }
  by_kind: Array<{
    kind: 'dm' | 'group' | 'channel' | 'general' | 'record'
    messages: number
    rooms: number
  }>
  per_day: Array<{ day: string; messages: number; senders: number }>
  by_hour: number[]
  busiest_channels: Array<{ room: string; label: string; messages: number; senders: number }>
  busiest_records: Array<{ room: string; label: string; messages: number; senders: number }>
  dm_response: {
    samples: number
    median_minutes: number | null
    p90_minutes: number | null
    within_hour_pct: number | null
  }
}

/** A reply more than this long after the message it answers is a new
 *  conversation, not a response time. */
const RESPONSE_CAP_MS = 7 * 24 * 3600_000

const OOO_MARKER = '(automatic out-of-office reply)'

function dayKey(d: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d)
}

function hourOf(d: Date, tz: string): number {
  const h = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(d)
  )
  return h === 24 ? 0 : h
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

type Kind = ChatAnalytics['by_kind'][number]['kind']

/**
 * The pure part: every figure computed from the rows alone. `kindOf` and
 * `labelOf` come from the caller so the calculation needs no database.
 */
export function computeChatAnalytics(
  rows: ChatAnalyticsRow[],
  opts: {
    days: number
    from: Date
    to: Date
    timeZone: string
    truncated: boolean
    reactions: number
    kindOf: (room: string) => Kind
    labelOf: (room: string) => string
    /** Senders left out of the response-time figure (bot, auto replies). */
    excludeFromResponse: (row: ChatAnalyticsRow) => boolean
  }
): ChatAnalytics {
  const tz = opts.timeZone
  const senders = new Set<string>()
  const rooms = new Map<string, { messages: number; senders: Set<string> }>()
  const perDay = new Map<string, { messages: number; senders: Set<string> }>()
  const byHour = new Array<number>(24).fill(0)
  let attachments = 0

  for (const r of rows) {
    const at = new Date(r.date_created)
    const s = r.sender ? String(r.sender).toUpperCase() : null
    if (s) senders.add(s)
    const room = rooms.get(r.room) ?? { messages: 0, senders: new Set<string>() }
    room.messages++
    if (s) room.senders.add(s)
    rooms.set(r.room, room)
    const k = dayKey(at, tz)
    const day = perDay.get(k) ?? { messages: 0, senders: new Set<string>() }
    day.messages++
    if (s) day.senders.add(s)
    perDay.set(k, day)
    byHour[hourOf(at, tz)]++
    if (r.has_attachments) attachments++
  }

  // Every day in the window, including quiet ones, so a chart has no gaps.
  const days: ChatAnalytics['per_day'] = []
  const cursor = new Date(opts.from)
  const lastKey = dayKey(opts.to, tz)
  for (let i = 0; i < opts.days + 2; i++) {
    const k = dayKey(cursor, tz)
    if (!days.some((d) => d.day === k)) {
      const v = perDay.get(k)
      days.push({ day: k, messages: v?.messages ?? 0, senders: v?.senders.size ?? 0 })
    }
    if (k === lastKey) break
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  const kinds = new Map<Kind, { messages: number; rooms: number }>()
  for (const [room, v] of rooms) {
    const kind = opts.kindOf(room)
    const agg = kinds.get(kind) ?? { messages: 0, rooms: 0 }
    agg.messages += v.messages
    agg.rooms++
    kinds.set(kind, agg)
  }
  const order: Kind[] = ['general', 'channel', 'group', 'dm', 'record']
  const byKind = order
    .filter((k) => kinds.has(k))
    .map((k) => ({ kind: k, ...(kinds.get(k) as { messages: number; rooms: number }) }))

  const ranked = (kind: Kind[]) =>
    [...rooms.entries()]
      .filter(([room]) => kind.includes(opts.kindOf(room)))
      .sort((a, b) => b[1].messages - a[1].messages)
      .slice(0, 10)
      .map(([room, v]) => ({
        room,
        label: opts.labelOf(room),
        messages: v.messages,
        senders: v.senders.size
      }))

  // First-response time in 1:1 DMs: from the first message of one person's
  // run to the other person's next message.
  const gaps: number[] = []
  const dmRows = rows
    .filter((r) => opts.kindOf(r.room) === 'dm' && r.sender && !opts.excludeFromResponse(r))
    .sort((a, b) => (a.room === b.room ? a.id - b.id : a.room < b.room ? -1 : 1))
  let pending: { room: string; sender: string; at: number } | null = null
  for (const r of dmRows) {
    const sender = String(r.sender).toUpperCase()
    const at = new Date(r.date_created).getTime()
    if (!pending || pending.room !== r.room) {
      pending = { room: r.room, sender, at }
      continue
    }
    if (pending.sender === sender) continue
    const gap = at - pending.at
    if (gap >= 0 && gap <= RESPONSE_CAP_MS) gaps.push(gap)
    pending = { room: r.room, sender, at }
  }
  gaps.sort((a, b) => a - b)
  const toMin = (ms: number | null) => (ms == null ? null : Math.round((ms / 60_000) * 10) / 10)

  return {
    window: {
      days: opts.days,
      from: opts.from.toISOString(),
      to: opts.to.toISOString(),
      time_zone: tz,
      truncated: opts.truncated
    },
    totals: {
      messages: rows.length,
      senders: senders.size,
      active_rooms: rooms.size,
      attachments,
      reactions: opts.reactions
    },
    by_kind: byKind,
    per_day: days,
    by_hour: byHour,
    busiest_channels: ranked(['general', 'channel']),
    busiest_records: ranked(['record']),
    dm_response: {
      samples: gaps.length,
      median_minutes: toMin(percentile(gaps, 0.5)),
      p90_minutes: toMin(percentile(gaps, 0.9)),
      within_hour_pct: gaps.length
        ? Math.round((gaps.filter((g) => g <= 3600_000).length / gaps.length) * 100)
        : null
    }
  }
}

const ROW_CAP = 50_000

export async function loadChatAnalytics(days: number, timeZone: string): Promise<ChatAnalytics> {
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 3600_000)
  const raw = (await db('chat_messages')
    .where('date_created', '>=', from)
    .whereNull('deleted_at')
    .orderBy('id', 'desc')
    .limit(ROW_CAP + 1)
    .select('id', 'room', 'sender', 'date_created', 'attachments', 'message')) as Array<
    Record<string, unknown>
  >
  const truncated = raw.length > ROW_CAP
  const slice = raw.slice(0, ROW_CAP)
  // Only the auto-reply flag is read from the text; the text itself is dropped here.
  const autoReply = new Set(
    slice.filter((r) => String(r.message ?? '').includes(OOO_MARKER)).map((r) => Number(r.id))
  )
  const rows: ChatAnalyticsRow[] = slice.map((r) => ({
    id: Number(r.id),
    room: String(r.room),
    sender: r.sender ? String(r.sender) : null,
    date_created: r.date_created as Date,
    has_attachments: (() => {
      if (!r.attachments) return false
      try {
        const a = JSON.parse(String(r.attachments))
        return Array.isArray(a) && a.length > 0
      } catch {
        return false
      }
    })()
  }))

  const reactions = rows.length
    ? Number(
        (
          (await db('nivaro_chat_reactions')
            .whereIn(
              'message_id',
              db('chat_messages').where('date_created', '>=', from).select('id')
            )
            .count({ n: '*' })
            .first()) as { n?: number | string } | undefined
        )?.n ?? 0
      )
    : 0

  const chans = await channels()
  const bot = (await botUserId().catch(() => null))?.toUpperCase() ?? null
  const kindOf = (room: string): Kind => {
    const p = parseRoom(room)
    if (p.kind === 'global') return 'general'
    if (p.kind === 'dm') return 'dm'
    if (p.kind === 'channel') return chans.get(p.channelKey ?? '')?.is_direct ? 'group' : 'channel'
    return 'record'
  }
  const labelOf = (room: string): string => {
    const p = parseRoom(room)
    if (p.kind === 'global') return 'General'
    if (p.kind === 'channel') return chans.get(p.channelKey ?? '')?.name ?? room
    // Record rooms are named by the record token they discuss.
    const colon = room.indexOf(':')
    return colon > 0 ? room.slice(colon + 1).toUpperCase() : room
  }

  return computeChatAnalytics(rows, {
    days,
    from,
    to,
    timeZone,
    truncated,
    reactions,
    kindOf,
    labelOf,
    excludeFromResponse: (r) =>
      (!!bot && String(r.sender).toUpperCase() === bot) || autoReply.has(r.id)
  })
}
