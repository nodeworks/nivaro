import type { Knex } from 'knex'
import { selectInChunks, whereInList } from '../db-batch.js'
import { parseDelivery } from '../notification-channels.js'
import { parseDeliveryReason } from '../notification-reason.js'
import {
  CHANNELS,
  CHAT_COLLECTION,
  type Channel,
  channelOutcome,
  channelStatusLabel,
  dimOf,
  type EvalCtx,
  isPrivateMail,
  MAIL_OUTCOME_LABELS,
  mailReason,
  mailReasonOf,
  type Registry,
  reasonLabel,
  type Source
} from './model.js'
import type { Labeler } from './summary.js'

export { CHAT_COLLECTION, isPrivateMail }

/**
 * The database-side helpers of delivery analytics: names for people / roles /
 * templates, the row enrichment a drill list shows, and the two leaves (one
 * notification, one email). Reads only.
 */

const up = (v: unknown) => String(v).toUpperCase()

export async function userNames(knex: Knex, ids: string[]): Promise<Map<string, string>> {
  const clean = [...new Set(ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i)).map(up))]
  const out = new Map<string, string>()
  if (clean.length === 0) return out
  const rows = (await selectInChunks(clean, 500, (chunk) =>
    whereInList(knex('nivaro_users'), 'id', chunk).select('id', 'first_name', 'last_name', 'email')
  )) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  for (const u of rows)
    out.set(
      up(u.id),
      `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unnamed person'
    )
  return out
}

export async function roleNames(knex: Knex, ids: string[]): Promise<Map<string, string>> {
  const clean = [...new Set(ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i)).map(up))]
  const out = new Map<string, string>()
  if (clean.length === 0) return out
  const rows = (await knex('nivaro_roles').whereIn('id', clean).select('id', 'name')) as Array<{
    id: string
    name: string | null
  }>
  for (const r of rows) out.set(up(r.id), r.name || 'Unnamed role')
  return out
}

export async function makeLabeler(knex: Knex): Promise<Labeler> {
  const { listMailTypes } = await import('../mail-types.js')
  const { NOTIFY_CATEGORY_LABELS } = await import('../notification-channels.js')
  const types = listMailTypes()
  return {
    users: (ids) => userNames(knex, ids),
    roles: (ids) => roleNames(knex, ids),
    // A template several mail types share ('notification') gets no label —
    // naming one would misattribute the rest (the mail board's rule).
    template: (key) => {
      const m = types.filter((t) => t.template === key)
      return m.length === 1 ? (m[0]?.label ?? null) : null
    },
    category: (key) => (NOTIFY_CATEGORY_LABELS as Record<string, string>)[key] ?? key
  }
}

export interface ChannelChip {
  channel: Channel
  status: string
  label: string
  outcome: string
}

export function channelChips(delivery: unknown): ChannelChip[] {
  const d = parseDelivery(delivery) as Record<string, { status?: string } | undefined> | null
  if (!d) return []
  const out: ChannelChip[] = []
  for (const c of CHANNELS) {
    const s = d[c]?.status
    if (!s || s === 'not_requested') continue
    out.push({
      channel: c,
      status: s,
      label: channelStatusLabel(c, s),
      outcome: channelOutcome(c, s)
    })
  }
  return out
}

/** Names and readable labels onto the raw rows of one drill page. */
export async function enrichRows(
  knex: Knex,
  source: Source,
  rows: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  if (source === 'n') {
    const names = await userNames(
      knex,
      rows
        .flatMap((r) => [r.recipient, r.sender])
        .filter((v): v is string => v != null)
        .map(String)
    )
    return rows.map((r) => ({
      id: Number(r.id),
      timestamp: r.timestamp,
      recipient: r.recipient == null ? null : up(r.recipient),
      recipient_name: r.recipient == null ? null : (names.get(up(r.recipient)) ?? 'Unknown person'),
      sender: r.sender == null ? null : up(r.sender),
      sender_name: r.sender == null ? null : (names.get(up(r.sender)) ?? 'Unknown person'),
      subject: r.subject,
      category: r.category,
      lane: r.lane,
      kind: r.kind,
      collection: r.collection,
      item: r.item,
      status: r.status,
      read_at: r.read_at,
      ttr_min: r.ttr_min == null ? null : Number(r.ttr_min),
      reason: r.reason,
      reason_label: reasonLabel(String(r.reason ?? '')),
      channels: channelChips(r.delivery)
    }))
  }
  if (source === 'm') {
    return rows.map((r) => {
      const key = (r.reason as string | undefined) ?? mailReasonOf(r)
      const reason = mailReason(key)
      return {
        id: Number(r.id),
        created_at: r.created_at,
        to: r.to,
        subject: r.subject,
        template: r.template,
        status: r.status,
        error: r.error,
        collection: r.collection,
        item: r.item,
        reason: key,
        reason_label: reason?.label ?? key,
        outcome: reason?.outcome ?? 'other',
        outcome_label: MAIL_OUTCOME_LABELS[reason?.outcome ?? 'other'],
        ...(r.resend_of !== undefined ? { resend_of: r.resend_of } : {})
      }
    })
  }
  const names = await userNames(
    knex,
    rows
      .map((r) => r.user)
      .filter((v): v is string => v != null)
      .map(String)
  )
  return rows.map((r) => ({
    id: Number(r.id),
    user: r.user == null ? null : up(r.user),
    user_name: r.user == null ? null : (names.get(up(r.user)) ?? 'Unknown person'),
    collection: r.collection,
    item: r.item,
    created_at: r.created_at
  }))
}

/** Notifications that can quote a private conversation: their text is not shown here. */
export function isPrivateNotification(row: {
  kind?: unknown
  category?: unknown
  collection?: unknown
}): boolean {
  const kind = String(row.kind ?? '')
  const category = String(row.category ?? '')
  const collection = String(row.collection ?? '')
  return (
    kind === 'chat' ||
    category === 'huddle' ||
    collection === CHAT_COLLECTION ||
    /^chat_/i.test(collection)
  )
}

export interface PersonRef {
  id: string
  name: string
  email: string | null
  status: string | null
  role: string | null
  account_kind: string | null
}

async function people(knex: Knex, ids: string[]): Promise<Map<string, PersonRef>> {
  const clean = [...new Set(ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i)).map(up))]
  const out = new Map<string, PersonRef>()
  if (clean.length === 0) return out
  const rows = (await knex('nivaro_users as u')
    .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
    .whereIn('u.id', clean)
    .select(
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.email',
      'u.status',
      'u.account_kind',
      'r.name as role_name'
    )) as Array<Record<string, string | null>>
  for (const u of rows)
    out.set(up(u.id), {
      id: up(u.id),
      name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unnamed person',
      email: u.email ?? null,
      status: u.status ?? null,
      role: u.role_name ?? null,
      account_kind: u.account_kind ?? null
    })
  return out
}

export interface ActionRef {
  kind: 'transition' | 'comment' | 'task'
  at: string
}

/** What the recipient did on the record within the acted window (the leaf's "acted" line). */
async function recipientActions(
  knex: Knex,
  n: { recipient: string; collection: string; item: string; timestamp: Date },
  hours: number
): Promise<ActionRef[]> {
  const end = new Date(n.timestamp.getTime() + hours * 3_600_000)
  const out: ActionRef[] = []
  const safe = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch {
      /* one missing table never hides the rest */
    }
  }
  await safe(async () => {
    const rows = (await knex('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
      .where({ 'i.collection': n.collection, 'i.item': n.item, 'h.user': n.recipient })
      .where('h.timestamp', '>=', n.timestamp)
      .where('h.timestamp', '<=', end)
      .whereRaw('NOT (h.from_state IS NULL AND h.[transition] IS NULL)')
      .orderBy('h.timestamp')
      .limit(5)
      .select('h.timestamp as at')) as Array<{ at: Date }>
    for (const r of rows) out.push({ kind: 'transition', at: new Date(r.at).toISOString() })
  })
  await safe(async () => {
    const rows = (await knex('nivaro_comments')
      .where({ collection: n.collection, item: n.item, user: n.recipient })
      .whereNull('deleted_at')
      .where('created_at', '>=', n.timestamp)
      .where('created_at', '<=', end)
      .orderBy('created_at')
      .limit(5)
      .select('created_at as at')) as Array<{ at: Date }>
    for (const r of rows) out.push({ kind: 'comment', at: new Date(r.at).toISOString() })
  })
  await safe(async () => {
    const rows = (await knex('nivaro_tasks')
      .where({ collection: n.collection, item: n.item, completed_by: n.recipient })
      .where('completed_at', '>=', n.timestamp)
      .where('completed_at', '<=', end)
      .orderBy('completed_at')
      .limit(5)
      .select('completed_at as at')) as Array<{ at: Date }>
    for (const r of rows) out.push({ kind: 'task', at: new Date(r.at).toISOString() })
  })
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

/** One notification, everything the page knows about it. Null = no such row. */
export async function notificationLeaf(
  knex: Knex,
  id: number,
  opts: { reg: Registry; ctx: EvalCtx }
) {
  const actedHours = opts.ctx.actedHours
  const row = (await knex('nivaro_notifications').where('id', id).first()) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  const ids = [row.recipient, row.sender].filter((v) => v != null).map(String)
  const who = await people(knex, ids)
  const delivery = parseDelivery(row.delivery)
  const reason = parseDeliveryReason(row.delivery_reason)
  // A Date keeps its milliseconds; String(date) would drop them.
  const ts = row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp))
  const isRecord =
    row.recipient != null &&
    typeof row.collection === 'string' &&
    row.collection !== '' &&
    row.item != null &&
    String(row.item) !== '' &&
    !/^(nivaro|directus)_/i.test(row.collection) &&
    !row.collection.startsWith('__')
  const actions = isRecord
    ? await recipientActions(
        knex,
        {
          recipient: String(row.recipient),
          collection: String(row.collection),
          item: String(row.item),
          timestamp: ts
        },
        actedHours
      )
    : []
  // The verdict the figures counted: the acted and read dimensions' own SQL
  // for this one row, as of the drill's asof (never a JS re-derivation).
  const acted = dimOf(opts.reg, 'n', 'acted').sql(opts.ctx)
  const read = dimOf(opts.reg, 'n', 'read').sql(opts.ctx)
  const verdictRows = (await knex.raw(
    `SELECT ${acted.sql} AS acted, ${read.sql} AS read_state FROM nivaro_notifications n WHERE n.id = ?`,
    [...acted.bindings, ...read.bindings, id] as never
  )) as unknown as Array<{ acted: string; read_state: string }>
  const verdict = verdictRows[0]?.acted ?? 'not_record'
  const readState = verdictRows[0]?.read_state ?? (row.status === 'inbox' ? 'unread' : 'read')
  const mailId = delivery?.email?.mail_log_id ?? delivery?.escalation?.email_log_id ?? null
  let mail: Record<string, unknown> | null = null
  if (mailId != null) {
    const m = (await knex('nivaro_mail_log')
      .where('id', mailId)
      .first('id', 'to', 'status', 'error', 'created_at', 'template')) as
      | Record<string, unknown>
      | undefined
    if (m) {
      const key = mailReasonOf(m)
      mail = {
        id: Number(m.id),
        to: m.to,
        status: m.status,
        created_at: m.created_at,
        template: m.template,
        reason: key,
        reason_label: mailReason(key)?.label ?? key,
        hint: mailReason(key)?.hint ?? null,
        error: m.error == null ? null : String(m.error).slice(0, 2000)
      }
    }
  }
  const hidden = isPrivateNotification(row)
  const channels = CHANNELS.map((c) => {
    const ch = (
      delivery as Record<
        string,
        { status?: string; reason?: string; at?: string } | undefined
      > | null
    )?.[c]
    const status = ch?.status ?? null
    return {
      channel: c,
      status,
      label: status ? channelStatusLabel(c, status) : 'Not recorded',
      outcome: status ? channelOutcome(c, status) : 'not_recorded',
      reason: ch?.reason ?? null,
      at: ch?.at ?? null
    }
  })
  return {
    id: Number(row.id),
    timestamp: row.timestamp,
    subject: row.subject ?? null,
    message: hidden ? null : (row.message ?? null),
    message_hidden: hidden,
    category: row.category ?? null,
    lane: row.lane ?? null,
    kind: row.kind ?? null,
    status: row.status ?? null,
    read_at: row.read_at ?? null,
    snoozed_until: row.snoozed_until ?? null,
    collection: row.collection ?? null,
    item: row.item == null ? null : String(row.item),
    recipient:
      row.recipient == null
        ? null
        : (who.get(up(row.recipient)) ?? {
            id: up(row.recipient),
            name: 'Unknown person',
            email: null,
            status: null,
            role: null,
            account_kind: null
          }),
    sender:
      row.sender == null
        ? null
        : (who.get(up(row.sender)) ?? {
            id: up(row.sender),
            name: 'Unknown person',
            email: null,
            status: null,
            role: null,
            account_kind: null
          }),
    reason: reason
      ? {
          kind: reason.path.kind,
          kind_label: reasonLabel(reason.path.kind),
          text: reason.path.text,
          label: reason.path.label,
          critical: reason.critical,
          role: reason.role?.name ?? null,
          rules: reason.rules
        }
      : null,
    channels,
    escalation: delivery?.escalation ?? null,
    mail,
    read_state: readState,
    asof: opts.ctx.asof.toISOString(),
    acted: {
      hours: actedHours,
      eligible: verdict !== 'not_record',
      verdict,
      actions,
      window_ends: new Date(ts.getTime() + actedHours * 3_600_000).toISOString()
    }
  }
}

/** One email-log row with its rendered body. Null = no such row. */
export async function mailLeaf(knex: Knex, id: number, opts: { reveal?: boolean } = {}) {
  const row = (await knex('nivaro_mail_log').where('id', id).first()) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  const key = mailReasonOf(row)
  const reason = mailReason(key)
  const addresses = [
    ...new Set(
      String(row.to ?? '')
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.includes('@'))
    )
  ].slice(0, 50)
  let recipients: Array<{ id: string; name: string; email: string }> = []
  if (addresses.length) {
    const users = (await knex('nivaro_users')
      .whereRaw(`LOWER(email) IN (${addresses.map(() => '?').join(', ')})`, addresses)
      .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, string | null>>
    recipients = users.map((u) => ({
      id: up(u.id),
      name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email),
      email: String(u.email)
    }))
  }
  const privateChat = isPrivateMail(row)
  const withheld = privateChat && !opts.reveal && row.body != null
  return {
    id: Number(row.id),
    created_at: row.created_at,
    to: row.to ?? null,
    subject: row.subject ?? null,
    template: row.template ?? null,
    status: row.status ?? null,
    error: row.error ?? null,
    // A body quoting a private chat opens only on the logged compliance view.
    body: withheld ? null : (row.body ?? null),
    body_withheld: withheld,
    private_chat: privateChat,
    collection: row.collection ?? null,
    item: row.item == null ? null : String(row.item),
    reason: key,
    reason_label: reason?.label ?? key,
    hint: reason?.hint ?? null,
    outcome: reason?.outcome ?? 'other',
    outcome_label: MAIL_OUTCOME_LABELS[reason?.outcome ?? 'other'],
    recipients,
    resend_of: row.resend_of ?? null,
    resent_by: row.resent_by ?? null
  }
}
