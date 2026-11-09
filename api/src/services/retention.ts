import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { logActivity } from './activity.js'
import { deleteDefaultsForUser } from './field-defaults.js'
import { noteUsersDeactivated } from './inactive-people-notice.js'
import { isMachineAccount } from './machine-accounts.js'

export const DEFAULT_REDACT_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'external_id',
  'job_title',
  'avatar'
]

/**
 * A directory verdict older than this is not trusted to say someone left:
 * directory sync runs nightly, so a week covers a few failed nights without
 * letting a months-old "missing" drive a redaction.
 */
export const DIRECTORY_FRESH_DAYS = 7

/** How many candidates (with reasons) a run answers with; the count is always whole. */
export const CANDIDATE_LIST_MAX = 500

function parseJson<T>(val: unknown): T {
  if (!val) return [] as unknown as T
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T
    } catch {
      return [] as unknown as T
    }
  }
  return val as T
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

export interface RetentionPolicy {
  id: number
  name: string
  inactivity_threshold_months: number
  action: 'redact' | 'delete' | 'suspend_only'
  redact_fields: unknown
  redact_value_template: string | null
  exclusion_emails: unknown
  exclusion_roles: unknown
  is_active: boolean | number
  dry_run_mode: boolean | number
  /** Migration 524: only people directory sync marks as gone (missing / disabled). */
  require_directory_gone?: boolean | number | null
}

/** The nivaro_users columns retention judges by. */
export interface RetentionUserRow {
  id: string
  email: string | null
  first_name?: string | null
  last_name?: string | null
  role?: string | null
  status?: string | null
  account_kind?: string | null
  last_access?: Date | string | null
  directory_status?: string | null
  directory_checked_at?: Date | string | null
}

export interface RetentionCandidate {
  id: string
  email: string | null
  name: string
  status: string | null
  last_access: string | null
  directory_status: string | null
  /** Why this person is in scope, one line per signal. */
  reasons: string[]
}

/** How many people each gate kept out — the dry run's "why not" side. */
export interface RetentionSkips {
  machine: number
  excluded: number
  signed_in: number
  directory_present: number
}

const noSkips = (): RetentionSkips => ({
  machine: 0,
  excluded: 0,
  signed_in: 0,
  directory_present: 0
})

export interface RetentionRunResult {
  affectedCount: number
  affectedIds: string[]
  errors: string[]
  /**
   * Every person this run actually redacted / suspended / deleted (live runs
   * only; empty on a dry run, a refusal, and for people whose write failed).
   * The one place a finished redaction batch is visible — a caller that tells
   * admins about deactivated accounts reads it from runRetentionPolicy.
   */
  redactedIds: string[]
  /** Up to CANDIDATE_LIST_MAX people in scope, each with why. */
  candidates: RetentionCandidate[]
  skipped: RetentionSkips
  cutoff: string
  /** True when nothing was written (asked for a dry run, or the policy is in dry-run mode). */
  dryRun: boolean
  /** Set when the policy refused to run at all — nothing was judged or written. */
  refused?: string
}

export function retentionCutoff(months: number, now = new Date()): Date {
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - Number(months || 0))
  return cutoff
}

const iso = (v: Date | string | null | undefined): string | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
const day = (v: string | null) => (v ? v.slice(0, 10) : null)

/**
 * The pure judgement: given the people not redacted and not under a legal
 * hold, who is in scope and why. Every gate must hold — a person is a
 * candidate only when none of them keeps them out.
 *
 * Inactivity is judged by SIGN-IN (nivaro_users.last_access, backfilled from
 * the legacy portal on EFP), not by the activity log: after the backfill an
 * activity-log check removed nobody and cost a pass over millions of rows.
 */
export function judgeRetentionCandidates(
  users: RetentionUserRow[],
  policy: Pick<
    RetentionPolicy,
    | 'exclusion_emails'
    | 'exclusion_roles'
    | 'require_directory_gone'
    | 'inactivity_threshold_months'
  >,
  cutoff: Date,
  now = new Date()
): { candidates: RetentionCandidate[]; skipped: RetentionSkips } {
  const emails = new Set(
    (parseJson<string[]>(policy.exclusion_emails) ?? [])
      .map((e) =>
        String(e ?? '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  )
  const roles = new Set(
    (parseJson<string[]>(policy.exclusion_roles) ?? []).map((r) => String(r ?? '').toLowerCase())
  )
  const directoryGate = truthy(policy.require_directory_gone)
  const freshAfter = now.getTime() - DIRECTORY_FRESH_DAYS * 86_400_000
  const cutoffDay = cutoff.toISOString().slice(0, 10)
  const skipped = noSkips()
  const candidates: RetentionCandidate[] = []

  for (const u of users) {
    // Machine identities are never retention candidates: an integration that
    // has been quiet for a quarter is idle, not departed, and redacting or
    // suspending it breaks the next call it makes.
    if (u.account_kind || isMachineAccount(u)) {
      skipped.machine++
      continue
    }
    const email = String(u.email ?? '')
      .trim()
      .toLowerCase()
    if ((email && emails.has(email)) || (u.role && roles.has(String(u.role).toLowerCase()))) {
      skipped.excluded++
      continue
    }
    const lastAccess = iso(u.last_access)
    if (lastAccess && new Date(lastAccess).getTime() >= cutoff.getTime()) {
      skipped.signed_in++
      continue
    }
    const reasons = [
      lastAccess
        ? `No sign-in since ${cutoffDay} (${policy.inactivity_threshold_months} months; last sign-in ${day(lastAccess)})`
        : 'Never signed in'
    ]
    if (directoryGate) {
      const status = String(u.directory_status ?? '')
      const checked = iso(u.directory_checked_at)
      const gone = status === 'missing' || status === 'disabled'
      if (!gone || !checked || new Date(checked).getTime() < freshAfter) {
        skipped.directory_present++
        continue
      }
      reasons.push(
        status === 'missing'
          ? `Not in the Microsoft directory (checked ${day(checked)})`
          : `Account disabled in the Microsoft directory (checked ${day(checked)})`
      )
    }
    candidates.push({
      id: String(u.id),
      email: u.email ?? null,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim(),
      status: u.status ?? null,
      last_access: lastAccess,
      directory_status: u.directory_status ?? null,
      reasons
    })
  }
  return { candidates, skipped }
}

/**
 * Why a policy that requires the directory's word must not run right now —
 * null when it may. Without a current directory verdict "left the company"
 * cannot be told apart from "never checked", so the policy stops rather than
 * fall back to sign-in alone.
 */
export async function directoryGateRefusal(now = new Date()): Promise<string | null> {
  if (!(await hasColumn('nivaro_users', 'directory_status'))) {
    return 'This policy only acts on people directory sync marks as gone, and this database has no directory status yet.'
  }
  const row = (await db('nivaro_settings')
    .first('directory_sync_enabled', 'directory_sync_last_run')
    .catch(() => undefined)) as
    | { directory_sync_enabled?: unknown; directory_sync_last_run?: Date | string | null }
    | undefined
  if (!truthy(row?.directory_sync_enabled)) {
    return 'Directory sync is off (Settings → Microsoft → Directory sync). This policy only acts on people the directory says have left, so it will not run until directory sync is on and has completed.'
  }
  const last = iso(row?.directory_sync_last_run ?? null)
  if (!last) {
    return 'Directory sync is on but has never completed a full check. This policy waits for its first nightly run.'
  }
  if (new Date(last).getTime() < now.getTime() - DIRECTORY_FRESH_DAYS * 86_400_000) {
    return `Directory sync last completed ${day(last)}, more than ${DIRECTORY_FRESH_DAYS} days ago. This policy will not judge who has left on a stale directory.`
  }
  return null
}

/**
 * Who a policy would touch, with why — two reads, none per person: the
 * directory gate (settings) and the people still un-redacted and not under
 * a legal hold (one statement over nivaro_users).
 */
export async function findRetentionCandidates(
  policy: RetentionPolicy,
  now = new Date()
): Promise<{
  cutoff: Date
  candidates: RetentionCandidate[]
  skipped: RetentionSkips
  refused?: string
}> {
  const cutoff = retentionCutoff(policy.inactivity_threshold_months, now)
  const policyGate = truthy(policy.require_directory_gone)
  if (policyGate) {
    const refused = await directoryGateRefusal(now)
    if (refused) return { cutoff, candidates: [], skipped: noSkips(), refused }
  }

  const dirCols = policyGate ? ['directory_status', 'directory_checked_at'] : []
  const users = (await db('nivaro_users')
    .select(
      'id',
      'email',
      'first_name',
      'last_name',
      'role',
      'status',
      'account_kind',
      'last_access',
      ...dirCols
    )
    .where((q) => q.where('is_redacted', false).orWhereNull('is_redacted'))
    // Users under an active legal hold are exempt from every retention action.
    .whereNotExists(
      db('nivaro_legal_holds')
        .whereRaw('nivaro_legal_holds.[user] = nivaro_users.id')
        .whereNull('released_at')
    )) as RetentionUserRow[]

  const { candidates, skipped } = judgeRetentionCandidates(users, policy, cutoff, now)
  return { cutoff, candidates, skipped }
}

export async function executeRetentionPolicy(
  policy: RetentionPolicy,
  triggeredBy: string | undefined,
  dryRun: boolean
): Promise<RetentionRunResult> {
  const errors: string[] = []
  const noWrites = dryRun || truthy(policy.dry_run_mode)
  const wantedFields: string[] = (() => {
    const f: string[] = parseJson(policy.redact_fields)
    return f.length > 0 ? f : DEFAULT_REDACT_FIELDS
  })()
  // Only columns this database has: EFP production has no nivaro_users.job_title, and naming
  // it failed every redaction of the first scheduled run (165 errors, 2026-11-09 4:45 AM ET).
  const redactFields: string[] = []
  for (const f of wantedFields) if (await hasColumn('nivaro_users', f)) redactFields.push(f)
  const template = policy.redact_value_template ?? 'Redacted_{{id}}'

  const found = await findRetentionCandidates(policy)
  const candidates = found.candidates
  const affectedIds = candidates.map((r) => r.id)
  const base = {
    candidates: candidates.slice(0, CANDIDATE_LIST_MAX),
    skipped: found.skipped,
    cutoff: found.cutoff.toISOString(),
    dryRun: noWrites
  }
  if (found.refused) {
    return {
      ...base,
      affectedCount: 0,
      affectedIds: [],
      redactedIds: [],
      errors: [found.refused],
      refused: found.refused
    }
  }

  if (noWrites) {
    return {
      ...base,
      affectedCount: affectedIds.length,
      affectedIds: affectedIds.slice(0, 50),
      redactedIds: [],
      errors
    }
  }

  const redactedIds: string[] = []
  const why = truthy(policy.require_directory_gone)
    ? `left the company per directory sync, no sign-in for ${policy.inactivity_threshold_months} months`
    : `no sign-in for ${policy.inactivity_threshold_months} months`

  await db.transaction(async (trx) => {
    for (const user of candidates) {
      try {
        if (policy.action === 'delete') {
          await deleteDefaultsForUser(user.id, trx)
          await trx('nivaro_users').where({ id: user.id }).delete()
          redactedIds.push(user.id)
          continue
        }

        const updates: Record<string, unknown> = {
          is_redacted: true,
          redacted_at: new Date(),
          status: 'suspended'
        }

        if (policy.action !== 'suspend_only') {
          for (const field of redactFields) {
            if (field === 'email' || field === 'external_id') {
              updates[field] = template.replace('{{id}}', user.id)
            } else {
              updates[field] = 'Redacted'
            }
          }
        }

        await trx('nivaro_users').where({ id: user.id }).update(updates)
        // One row PER USER, so "why is this account suspended" has an answer
        // (#512) — the policy-level row below cannot say who it touched.
        await trx('nivaro_activity').insert({
          action: 'user-retention-suspend',
          user: triggeredBy ?? null,
          collection: 'nivaro_users',
          item: String(user.id),
          timestamp: new Date(),
          comment: `${policy.action === 'suspend_only' ? 'Suspended' : 'Redacted and suspended'} by retention policy "${policy.name}" — ${why}`
        })
        redactedIds.push(user.id)
      } catch (err) {
        errors.push(`user ${user.id}: ${String(err)}`)
      }
    }
  })

  await db('nivaro_retention_policies').where({ id: policy.id }).update({
    last_run_at: new Date(),
    last_run_affected_count: affectedIds.length
  })

  await logActivity({
    action: 'user-retention-applied',
    user: triggeredBy,
    collection: 'nivaro_users',
    item: String(policy.id)
  } as Parameters<typeof logActivity>[0])

  return {
    ...base,
    affectedCount: affectedIds.length,
    affectedIds: affectedIds.slice(0, 50),
    redactedIds,
    errors
  }
}

/**
 * One run of a policy, from the Run / Dry run buttons or its own schedule:
 * executes it, then records the run (nivaro_retention_runs) and an activity
 * row — a refusal is recorded too, with its reason as the run's error.
 */
export async function runRetentionPolicy(
  policy: RetentionPolicy,
  opts: {
    triggeredBy?: string
    dryRun: boolean
    source: 'manual' | 'schedule'
    req?: FastifyRequest
  }
): Promise<RetentionRunResult> {
  const started = new Date()
  const result = await executeRetentionPolicy(policy, opts.triggeredBy, opts.dryRun)
  const mode = result.dryRun ? 'dry run' : 'live run'
  await logActivity({
    action: 'retention-run',
    user: opts.triggeredBy,
    collection: 'nivaro_retention_policies',
    item: String(policy.id),
    comment: result.refused
      ? `${mode} (${opts.source}) refused: ${result.refused}`.slice(0, 2000)
      : `${mode} (${opts.source}): ${result.affectedCount} affected`,
    req: opts.req
  })
  await db('nivaro_retention_runs').insert({
    policy_id: Number(policy.id),
    started_at: started,
    finished_at: new Date(),
    affected_count: result.affectedCount,
    dry_run: result.dryRun,
    errors: result.errors.length ? JSON.stringify(result.errors) : null,
    affected_ids: result.affectedIds.length ? JSON.stringify(result.affectedIds) : null,
    triggered_by: opts.triggeredBy ?? null
  })
  // ── Batch finished ────────────────────────────────────────────────────────
  // Every run (Run now and the policy's own schedule) ends here. On a live run
  // `result.redactedIds` names everyone written: admins get ONE coalesced
  // notice for the batch (services/inactive-people-notice.ts). Deleted
  // accounts are gone, so they have no work left to hand on.
  if (!result.dryRun && policy.action !== 'delete' && result.redactedIds.length > 0) {
    noteUsersDeactivated(result.redactedIds, {
      reason: 'retention',
      actor: opts.triggeredBy ?? null,
      verb: policy.action === 'suspend_only' ? 'suspended' : 'redacted'
    })
  }
  return result
}
