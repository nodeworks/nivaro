import { createHash, randomUUID } from 'node:crypto'
import { db } from '../../db/index.js'
import {
  type ApplySpec,
  type Candidate,
  OPEN_STATUSES,
  type ProofResult,
  type ProposalRow,
  type TuningKind,
  type TuningStatus
} from './types.js'

const T = 'nivaro_tuning_proposals'
export const QUIET_DAYS = 90
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

/** Pure: what the nightly run does with a candidate given what the ledger already holds. */
export function upsertDecision(
  found: {
    open: { status: TuningStatus } | null
    recent: { status: TuningStatus; at: Date } | null
  },
  now: Date
): 'insert' | 'update' | 'quiet' {
  if (found.open) return OPEN_STATUSES.includes(found.open.status) ? 'update' : 'quiet'
  if (
    found.recent &&
    (found.recent.status === 'dismissed' || found.recent.status === 'rolled_back')
  ) {
    const age = (now.getTime() - found.recent.at.getTime()) / 86_400_000
    if (age < QUIET_DAYS) return 'quiet'
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

export async function isQuiet(fingerprint: string): Promise<boolean> {
  const recent = (await db(T)
    .where({ fingerprint })
    .whereIn('status', ['dismissed', 'rolled_back'])
    .orderBy('last_seen', 'desc')
    .first('status', 'dismissed_at', 'rolled_back_at')) as RecentRow | undefined
  if (!recent) return false
  const at = recent.dismissed_at ?? recent.rolled_back_at ?? new Date(0)
  return (
    upsertDecision(
      { open: null, recent: { status: recent.status, at: new Date(at) } },
      new Date()
    ) === 'quiet'
  )
}

export async function upsertProposal(
  c: Candidate,
  proof: ProofResult,
  runId: number | null
): Promise<{ id: string; action: 'inserted' | 'updated' | 'quiet' }> {
  const fingerprint = fingerprintOf(c)
  const now = new Date()
  const open = (await db(T)
    .where({ fingerprint })
    .whereIn('status', [
      'proposed',
      'stale',
      'rejected_by_proof',
      'applying',
      'watching',
      'applied'
    ])
    .first('id', 'status')) as { id: string; status: TuningStatus } | undefined
  const recent = open
    ? null
    : ((await db(T)
        .where({ fingerprint })
        .whereIn('status', ['dismissed', 'rolled_back'])
        .orderBy('last_seen', 'desc')
        .first('status', 'dismissed_at', 'rolled_back_at')) as RecentRow | undefined)
  const decision = upsertDecision(
    {
      open: open ? { status: open.status } : null,
      recent: recent
        ? { status: recent.status, at: new Date(recent.dismissed_at ?? recent.rolled_back_at ?? 0) }
        : null
    },
    now
  )
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
  if (decision === 'quiet') return { id: open?.id ?? '', action: 'quiet' }
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

/** A proposed row whose evidence has not been seen for `days` closes as dismissed. */
export async function closeUnseen(days = 14): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000)
  return db(T)
    .where('status', 'proposed')
    .where('last_seen', '<', cutoff)
    .update({ status: 'dismissed', dismissed_at: new Date(), dismiss_note: 'evidence gone' })
}
