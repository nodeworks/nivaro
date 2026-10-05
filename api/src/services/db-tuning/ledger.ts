import { createHash, randomUUID } from 'node:crypto'
import { db } from '../../db/index.js'
import {
  type ApplySpec,
  type Candidate,
  isErrorRefusal,
  OPEN_STATUSES,
  type ProofResult,
  type ProposalRow,
  type TuningKind,
  type TuningStatus
} from './types.js'

const T = 'nivaro_tuning_proposals'
export const QUIET_DAYS = 90
/** A proof rejection stands this long before the same change is proved again. */
export const QUIET_REJECTED_DAYS = 7
const IN_FLIGHT_STATUSES: readonly TuningStatus[] = ['applying', 'watching', 'applied']
const EVIDENCE_CAP = 32 * 1024

export function fingerprintOf(c: Pick<Candidate, 'kind' | 'target' | 'change_key'>): string {
  return createHash('sha1')
    .update(`${c.kind}|${c.target}|${c.change_key}`)
    .digest('hex')
    .slice(0, 40)
}

function j<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw === 'object') return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return fallback
  }
}
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as Date).toISOString())

export function parseRow(raw: Record<string, unknown>): ProposalRow {
  return {
    id: String(raw.id),
    kind: raw.kind as TuningKind,
    target: String(raw.target),
    fingerprint: String(raw.fingerprint),
    status: raw.status as TuningStatus,
    title: String(raw.title ?? ''),
    evidence: j<Record<string, unknown>>(raw.evidence, {}),
    proof: j<ProofResult | null>(raw.proof, null),
    estimate_ms_per_day: Number(raw.estimate_ms_per_day ?? 0),
    risk: (raw.risk as ProposalRow['risk']) ?? 'reversible',
    replicated: Boolean(raw.replicated),
    dialect_note: (raw.dialect_note as string | null) ?? null,
    apply: j<ApplySpec>(raw.apply, { type: 'sql', statements: [] }),
    undo: j<ApplySpec>(raw.undo, { type: 'sql', statements: [] }),
    applied_at: iso(raw.applied_at),
    applied_by: (raw.applied_by as string | null) ?? null,
    watch_until: iso(raw.watch_until),
    watch_baseline: j<ProposalRow['watch_baseline']>(raw.watch_baseline, null),
    rolled_back_at: iso(raw.rolled_back_at),
    rollback_reason: (raw.rollback_reason as string | null) ?? null,
    dismissed_at: iso(raw.dismissed_at),
    dismissed_by: (raw.dismissed_by as string | null) ?? null,
    dismiss_note: (raw.dismiss_note as string | null) ?? null,
    first_seen: iso(raw.first_seen) ?? new Date(0).toISOString(),
    last_seen: iso(raw.last_seen) ?? new Date(0).toISOString(),
    run_id: raw.run_id == null ? null : Number(raw.run_id)
  }
}

/**
 * Pure: what the nightly run does with a candidate given what the ledger already holds. An open
 * row is updated — unless it is a proof rejection younger than 7 days (`at` = its last_seen, the
 * last time it was proved: touchSeen leaves rejected rows alone), which stays quiet so the same
 * failing change does not take a proof slot every night.
 */
export function upsertDecision(
  found: {
    open: { status: TuningStatus; at?: Date | null } | null
    recent: { status: TuningStatus; at: Date } | null
  },
  now: Date
): 'insert' | 'update' | 'quiet' {
  const days = (at: Date) => (now.getTime() - at.getTime()) / 86_400_000
  if (found.open) {
    const { status, at } = found.open
    if (status === 'rejected_by_proof' && at && days(at) < QUIET_REJECTED_DAYS) return 'quiet'
    return OPEN_STATUSES.includes(status) ? 'update' : 'quiet'
  }
  if (
    found.recent &&
    (found.recent.status === 'dismissed' || found.recent.status === 'rolled_back')
  ) {
    if (days(found.recent.at) < QUIET_DAYS) return 'quiet'
  }
  return 'insert'
}

const cap = (o: unknown): string => {
  const s = JSON.stringify(o ?? {})
  return s.length > EVIDENCE_CAP
    ? JSON.stringify({ truncated: true, head: s.slice(0, EVIDENCE_CAP) })
    : s
}

type RecentRow = {
  status: TuningStatus
  dismissed_at: Date | null
  rolled_back_at: Date | null
}

/** The newest dismissed / rolled-back row for a fingerprint, with when it was closed. */
async function findRecentTwin(
  fingerprint: string
): Promise<{ status: TuningStatus; at: Date } | null> {
  const recent = (await db(T)
    .where({ fingerprint })
    .whereIn('status', ['dismissed', 'rolled_back'])
    .orderBy('last_seen', 'desc')
    .first('status', 'dismissed_at', 'rolled_back_at')) as RecentRow | undefined
  if (!recent) return null
  return {
    status: recent.status,
    at: new Date(recent.dismissed_at ?? recent.rolled_back_at ?? 0)
  }
}

export async function isQuiet(fingerprint: string): Promise<boolean> {
  const recent = await findRecentTwin(fingerprint)
  if (!recent) return false
  return upsertDecision({ open: null, recent }, new Date()) === 'quiet'
}

type OpenRow = { id: string; status: TuningStatus; last_seen?: Date | string | null }

const openOf = (row: OpenRow | null) =>
  row ? { status: row.status, at: row.last_seen ? new Date(row.last_seen) : null } : null

/** The open or in-flight row for a fingerprint, else its newest closed twin. */
async function ledgerLookup(
  fingerprint: string
): Promise<{ open: OpenRow | null; recent: { status: TuningStatus; at: Date } | null }> {
  const open = (await db(T)
    .where({ fingerprint })
    .whereIn('status', [...OPEN_STATUSES, ...IN_FLIGHT_STATUSES])
    .first('id', 'status', 'last_seen')) as OpenRow | undefined
  return { open: open ?? null, recent: open ? null : await findRecentTwin(fingerprint) }
}

/** What `upsertProposal` would do with this fingerprint — the run asks before spending a proof. */
export async function ledgerDecision(fingerprint: string): Promise<'insert' | 'update' | 'quiet'> {
  const { open, recent } = await ledgerLookup(fingerprint)
  return upsertDecision({ open: openOf(open), recent }, new Date())
}

/** One change per object: a candidate's kind and target, case-folded. */
export const targetKey = (c: Pick<Candidate, 'kind' | 'target'>): string =>
  `${c.kind}|${c.target.toLowerCase()}`

/**
 * `targetKey`s of every change in flight: applying, watching, or applied with its watch window
 * still open. A second change on one of these (another rewrite of a watched procedure) would be
 * what the watch measures and would make its rollback refuse, so the run leaves the target be.
 */
export async function inFlightTargets(now = new Date()): Promise<Set<string>> {
  const rows = (await db(T)
    .whereIn('status', [...IN_FLIGHT_STATUSES])
    .select('kind', 'target', 'status', 'watch_until')) as Array<{
    kind: TuningKind
    target: string
    status: TuningStatus
    watch_until: Date | string | null
  }>
  return new Set(
    rows
      .filter(
        (r) =>
          r.status !== 'applied' ||
          (r.watch_until != null && new Date(r.watch_until).getTime() > now.getTime())
      )
      .map(targetKey)
  )
}

export async function upsertProposal(
  c: Candidate,
  proof: ProofResult,
  runId: number | null
): Promise<{ id: string | null; action: 'inserted' | 'updated' | 'quiet' | 'kept' }> {
  const fingerprint = fingerprintOf(c)
  const now = new Date()
  const { open, recent } = await ledgerLookup(fingerprint)
  const decision = upsertDecision({ open: openOf(open), recent }, now)
  // a proof that errored judged nothing: a standing proposal stays as it was, only seen again
  if (decision === 'update' && open?.status === 'proposed' && isErrorRefusal(proof)) {
    await db(T).where({ id: open.id }).update({ last_seen: now, run_id: runId })
    return { id: open.id, action: 'kept' }
  }
  const status: TuningStatus = proof.passed ? 'proposed' : 'rejected_by_proof'
  const common = {
    title: c.title.slice(0, 300),
    evidence: cap(c.evidence),
    proof: JSON.stringify(proof),
    estimate_ms_per_day: Math.round(c.estimate_ms_per_day),
    risk: c.risk,
    replicated: c.replicated ? 1 : 0,
    dialect_note: c.dialect_note ?? null,
    apply: JSON.stringify(c.apply),
    undo: JSON.stringify(c.undo),
    last_seen: now,
    run_id: runId
  }
  if (decision === 'quiet') return { id: open?.id ?? null, action: 'quiet' }
  if (decision === 'update' && open) {
    await db(T)
      .where({ id: open.id })
      .update({ ...common, status })
    return { id: open.id, action: 'updated' }
  }
  const id = randomUUID()
  await db(T).insert({
    id,
    kind: c.kind,
    target: c.target.slice(0, 300),
    fingerprint,
    status,
    first_seen: now,
    ...common
  })
  return { id, action: 'inserted' }
}

export async function listProposals(f: {
  status?: TuningStatus[]
  kind?: TuningKind
}): Promise<ProposalRow[]> {
  let q = db(T).orderBy('estimate_ms_per_day', 'desc').orderBy('last_seen', 'desc')
  if (f.status?.length) q = q.whereIn('status', f.status)
  if (f.kind) q = q.where('kind', f.kind)
  const rows = (await q.select('*')) as Array<Record<string, unknown>>
  return rows.map(parseRow)
}

export async function getProposal(id: string): Promise<ProposalRow | null> {
  const row = (await db(T).where({ id }).first('*')) as Record<string, unknown> | undefined
  return row ? parseRow(row) : null
}

export async function updateProposal(
  id: string,
  patch: Partial<Record<keyof ProposalRow, unknown>>
): Promise<void> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch))
    out[k] = v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v
  await db(T).where({ id }).update(out)
}

const TOUCH_CHUNK = 500

/** Rows a sighting keeps alive. A rejection's last_seen stays the time it was proved. */
const TOUCHED_STATUSES: readonly TuningStatus[] = OPEN_STATUSES.filter(
  (s) => s !== 'rejected_by_proof'
)

/**
 * Tonight's observers saw these fingerprints: their open rows stay alive even when the proof
 * budget or the wall clock carried them over, so `closeUnseen` never reads them as gone.
 */
export async function touchSeen(fingerprints: string[]): Promise<number> {
  const fps = [...new Set(fingerprints)]
  const now = new Date()
  let n = 0
  for (let i = 0; i < fps.length; i += TOUCH_CHUNK)
    n += Number(
      await db(T)
        .whereIn('fingerprint', fps.slice(i, i + TOUCH_CHUNK))
        .whereIn('status', [...TOUCHED_STATUSES])
        .update({ last_seen: now })
    )
  return n
}

/** A proposed row whose evidence has not been seen for `days` closes as dismissed. */
export async function closeUnseen(days = 14): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000)
  return db(T)
    .where('status', 'proposed')
    .where('last_seen', '<', cutoff)
    .update({ status: 'dismissed', dismissed_at: new Date(), dismiss_note: 'evidence gone' })
}
