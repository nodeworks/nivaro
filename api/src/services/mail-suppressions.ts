import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { getApp } from './io-holder.js'
import { normalizeError } from './mail-stats.js'

/**
 * Bounce handling (#1299). A HARD bounce — the relay refused the address
 * itself, not the message or the connection — marks the address in
 * `nivaro_mail_suppressions`; every sender then drops it with a 'dropped'
 * mail-log row until an admin clears the mark. Soft/transient refusals (4xx,
 * greylisting, a dead relay) are never suppressed: the next attempt may land.
 *
 * The module owns the whole decision so mail.ts stays a thin caller:
 * classify → record → tell people once → filter on the next send.
 */

const TABLE = 'nivaro_mail_suppressions'
const CACHE_TTL_MS = 60_000
const REASON_MAX = 500

export type BounceKind = 'hard' | 'soft' | 'unknown'

export interface BounceClassification {
  kind: BounceKind
  /** The addresses the refusal names (nodemailer's `rejected`, else the ones
   *  spelled in the response text, else the single recipient). */
  addresses: string[]
  /** The normalised error text stored as the suppression reason. */
  reason: string
  /** The raw SMTP status when the error carried one. */
  code: number | null
}

/** Phrases a relay uses for "this mailbox does not exist" — the hard class,
 *  whatever the numeric status in front of them. */
const HARD_PHRASES = [
  /user unknown/i,
  /unknown user/i,
  /mailbox unavailable/i,
  /mailbox not found/i,
  /no such user/i,
  /no such recipient/i,
  /does not exist/i,
  /doesn'?t exist/i,
  /recipient address rejected/i,
  /address rejected/i,
  /invalid recipient/i,
  /unrouteable address/i,
  /not a valid mailbox/i,
  /account (?:is )?disabled/i,
  /\b5\.1\.[0-9]\b/,
  /\b5\.4\.1\b/
]

/** Codes the spec names as hard when they open the response. */
const HARD_CODES = new Set([550, 551, 553, 554])

interface MailerError {
  responseCode?: unknown
  response?: unknown
  rejected?: unknown
  command?: unknown
  code?: unknown
  message?: unknown
}

const ADDRESS_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

export function normalizeAddress(a: string): string {
  return String(a ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase()
}

function textOf(err: unknown): string {
  if (!err) return ''
  const e = err as MailerError
  const parts = [e.response, e.message].filter((v) => typeof v === 'string' && v.trim())
  return parts.join(' ')
}

function statusCodeOf(err: unknown): number | null {
  const e = err as MailerError
  const direct = Number(e?.responseCode)
  if (Number.isFinite(direct) && direct >= 100 && direct <= 599) return direct
  const m = textOf(err).match(/(?:^|\s)([245]\d{2})(?:[\s-]|$)/)
  if (m) return Number(m[1])
  return null
}

/**
 * Pure. Decides whether an SMTP failure means the ADDRESS is dead.
 *
 * hard   — 5xx on RCPT TO / DATA with a rejected address, a 550/551/553/554
 *          head, or a known hard-bounce phrase in the response text.
 * soft   — any 4xx (greylisting, quota, "try again later").
 * unknown — no SMTP status at all: connection refused, timeout, auth.
 *
 * `addresses` is what the suppression will be recorded against: the
 * `rejected` list when the transport reports one, else every address the
 * response text spells, else the one recipient when there was exactly one
 * (a refusal with no address named and several recipients blames nobody).
 */
export function classifyBounce(err: unknown, recipients: string[] = []): BounceClassification {
  const e = (err ?? {}) as MailerError
  const text = textOf(err)
  const code = statusCodeOf(err)
  const command = typeof e.command === 'string' ? e.command.toUpperCase() : ''
  const rejected = Array.isArray(e.rejected)
    ? e.rejected.map((r) => normalizeAddress(String(r))).filter((a) => a.includes('@'))
    : []
  const reason = normalizeError(text || null).slice(0, REASON_MAX)

  const named = [...new Set((text.match(ADDRESS_RE) ?? []).map(normalizeAddress))]
  const single = recipients.length === 1 ? [normalizeAddress(recipients[0])] : []
  const addresses = rejected.length ? rejected : named.length ? named : single

  if (code != null && code >= 400 && code < 500) {
    return { kind: 'soft', addresses, reason, code }
  }
  const envelopeStage = command.startsWith('RCPT') || command.startsWith('DATA')
  const phrase = HARD_PHRASES.some((re) => re.test(text))
  const hardCode = code != null && HARD_CODES.has(code)
  if (code != null && code >= 500 && code < 600) {
    if ((envelopeStage && rejected.length > 0) || hardCode || phrase) {
      return { kind: 'hard', addresses, reason, code }
    }
    // A 5xx on the connection or the sender address is the relay's complaint
    // about us, not about the recipient.
    return { kind: 'unknown', addresses, reason, code }
  }
  if (phrase) return { kind: 'hard', addresses, reason, code }
  return { kind: 'unknown', addresses, reason, code }
}

// ---------------------------------------------------------------------------
// Storage + cache

export interface SuppressionRow {
  id: number
  address: string
  reason: string | null
  first_seen: Date | string
  last_seen: Date | string
  count: number
  notified_at: Date | string | null
}

let cache: { at: number; rows: Map<string, SuppressionRow> } | null = null
let inFlight: Promise<Map<string, SuppressionRow>> | null = null

export function bustSuppressionCache(): void {
  cache = null
  inFlight = null
}

async function loadAll(): Promise<Map<string, SuppressionRow>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const rows = (await db(TABLE).select('*')) as SuppressionRow[]
      const map = new Map<string, SuppressionRow>()
      for (const r of rows) map.set(normalizeAddress(r.address), r)
      cache = { at: Date.now(), rows: map }
      return map
    } catch {
      // A missing table (a database behind migration 392) or a read error
      // must never stop mail — nothing is suppressed until the read works.
      return new Map()
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** The suppressed subset of `addresses`, lower-cased. One read per 60 s. */
export async function suppressedSet(addresses: string[]): Promise<Set<string>> {
  if (addresses.length === 0) return new Set()
  const all = await loadAll()
  const out = new Set<string>()
  for (const a of addresses) {
    const n = normalizeAddress(a)
    if (all.has(n)) out.add(n)
  }
  return out
}

export interface SuppressionFilter {
  kept: string[]
  dropped: Array<{ address: string; reason: string }>
}

/** Pure. Splits recipients by a suppression map (address → reason). */
export function partitionSuppressed(
  recipients: string[],
  suppressed: Map<string, string | null>
): SuppressionFilter {
  const kept: string[] = []
  const dropped: SuppressionFilter['dropped'] = []
  for (const r of recipients) {
    const n = normalizeAddress(r)
    if (suppressed.has(n)) {
      dropped.push({ address: r, reason: suppressed.get(n) || 'address bounced' })
    } else kept.push(r)
  }
  return { kept, dropped }
}

/**
 * Drop suppressed recipients from a send. Takes an optional lookup so the
 * split can be exercised without a database.
 */
export async function filterSuppressed(
  recipients: string[],
  lookup: (addresses: string[]) => Promise<Map<string, string | null>> = defaultLookup
): Promise<SuppressionFilter> {
  if (recipients.length === 0) return { kept: [], dropped: [] }
  const map = await lookup(recipients)
  if (map.size === 0) return { kept: recipients, dropped: [] }
  return partitionSuppressed(recipients, map)
}

async function defaultLookup(addresses: string[]): Promise<Map<string, string | null>> {
  const all = await loadAll()
  const map = new Map<string, string | null>()
  for (const a of addresses) {
    const n = normalizeAddress(a)
    const row = all.get(n)
    if (row) map.set(n, row.reason)
  }
  return map
}

/** Upsert one address: count+1, last_seen now, the newest reason kept. Returns
 *  the row and whether it was CREATED this call (the once-only notify key). */
export async function recordBounce(
  address: string,
  reason: string
): Promise<{ row: SuppressionRow; created: boolean } | null> {
  const n = normalizeAddress(address)
  if (!n.includes('@')) return null
  const why = String(reason ?? '').slice(0, REASON_MAX) || null
  const now = new Date()
  try {
    const existing = (await db(TABLE).where({ address: n }).first()) as SuppressionRow | undefined
    if (existing) {
      await db(TABLE)
        .where({ id: existing.id })
        .update({ count: Number(existing.count ?? 0) + 1, last_seen: now, reason: why })
      bustSuppressionCache()
      const row = (await db(TABLE).where({ id: existing.id }).first()) as SuppressionRow
      return { row, created: false }
    }
    await db(TABLE).insert({
      address: n,
      reason: why,
      first_seen: now,
      last_seen: now,
      count: 1,
      notified_at: null
    })
    bustSuppressionCache()
    const row = (await db(TABLE).where({ address: n }).first()) as SuppressionRow | undefined
    if (!row) return null
    return { row, created: true }
  } catch (err) {
    console.warn(
      '[mail-suppressions] could not record a bounce:',
      err instanceof Error ? err.message : err
    )
    return null
  }
}

export async function clearSuppression(
  idOrAddress: number | string,
  _byUserId?: string | null
): Promise<SuppressionRow | null> {
  const q =
    typeof idOrAddress === 'number' || /^\d+$/.test(String(idOrAddress))
      ? db(TABLE).where({ id: Number(idOrAddress) })
      : db(TABLE).where({ address: normalizeAddress(String(idOrAddress)) })
  const row = (await q.clone().first()) as SuppressionRow | undefined
  if (!row) return null
  await db(TABLE).where({ id: row.id }).del()
  bustSuppressionCache()
  return row
}

export async function suppressionFor(address: string): Promise<SuppressionRow | null> {
  const all = await loadAll()
  return all.get(normalizeAddress(address)) ?? null
}

export async function countSuppressions(): Promise<number> {
  try {
    const r = (await db(TABLE).count({ c: '*' }).first()) as { c?: number | string } | undefined
    return Number(r?.c ?? 0)
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Telling people — once per address

/**
 * On the FIRST suppression of an address: every active admin, and the
 * person's manager when the address belongs to a nivaro_users row. Stamped
 * on `notified_at` so a repeat bounce never pages anyone again.
 */
async function notifyFirstSuppression(row: SuppressionRow): Promise<void> {
  if (row.notified_at) return
  const app = getApp()
  if (!app) return
  let notifyUser: typeof import('./notification-channels.js').notifyUser
  try {
    ;({ notifyUser } = await import('./notification-channels.js'))
  } catch {
    return
  }
  const admins = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .whereNot('u.status', 'suspended')
    .where('u.is_redacted', false)
    .where('r.admin_access', true)
    .select('u.id')
    .catch(() => [])) as Array<{ id: string }>
  const owner = (await db('nivaro_users')
    .whereRaw('LOWER(email) = ?', [row.address])
    .select('id', 'first_name', 'last_name', 'manager_id')
    .first()
    .catch(() => null)) as {
    id: string
    first_name: string | null
    last_name: string | null
    manager_id: string | null
  } | null
  const ownerName = owner
    ? [owner.first_name, owner.last_name].filter(Boolean).join(' ') || row.address
    : null
  const reason = row.reason ? ` — ${row.reason}` : ''
  const base = adminBaseUrl()
  const target = base ? { kind: 'external' as const, url: `${base}/mail-log?tab=suppressed` } : null
  const recipients = new Map<string, 'admin' | 'manager'>()
  for (const a of admins) recipients.set(String(a.id).toUpperCase(), 'admin')
  if (owner?.manager_id) {
    const m = String(owner.manager_id).toUpperCase()
    if (!recipients.has(m)) recipients.set(m, 'manager')
  }
  for (const [id, role] of recipients) {
    try {
      await notifyUser(app, id, {
        subject: `Email to ${row.address} is bouncing`,
        message:
          role === 'manager'
            ? `${ownerName}'s address ${row.address} was refused by the mail relay${reason}. Nothing more will be sent there until an administrator clears it.`
            : `${ownerName ? `${ownerName} (${row.address})` : row.address} was refused by the mail relay${reason}. Mail to that address is paused; clear it under Mail Log → Suppressed addresses once it is fixed.`,
        category: 'system',
        target,
        source: { kind: 'mail-suppression', label: 'Bounce handling', id: row.id },
        why:
          role === 'manager'
            ? 'you are their manager and the address stopped receiving mail.'
            : 'administrators are told once when an address starts bouncing.'
      })
    } catch (err) {
      console.warn('[mail-suppressions] notify failed:', err instanceof Error ? err.message : err)
    }
  }
  await db(TABLE)
    .where({ id: row.id })
    .update({ notified_at: new Date() })
    .catch(() => undefined)
  bustSuppressionCache()
}

/**
 * The failure-path entry point for mail.ts: classify the transport error and,
 * when it is a hard bounce, record every named address and tell people about
 * the new ones. Never throws — the send's own error is what the caller rethrows.
 */
export async function recordBouncesFromError(
  err: unknown,
  recipients: string[]
): Promise<BounceClassification> {
  const verdict = classifyBounce(err, recipients)
  if (verdict.kind !== 'hard' || verdict.addresses.length === 0) return verdict
  for (const address of verdict.addresses) {
    const res = await recordBounce(address, verdict.reason)
    if (res?.created) {
      await notifyFirstSuppression(res.row).catch((e: unknown) =>
        console.warn('[mail-suppressions] notify failed:', e instanceof Error ? e.message : e)
      )
    }
  }
  return verdict
}
